'use strict';
// Bindings to the NDI runtime through koffi, a prebuilt FFI. Nothing here is
// compiled, so there is no build toolchain to install on the machine that
// sends the feed.
//
// The runtime itself is NOT shipped with this app: it belongs to Vizrt and is
// not ours to redistribute. It comes with NDI Tools, which a machine on a
// video network almost always already has.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const FOURCC_BGRA = 0x41524742;   // 'BGRA', little-endian
const FOURCC_BGRX = 0x58524742;   // 'BGRX' - same bytes, alpha ignored
const FORMAT_PROGRESSIVE = 1;

// The runtime is versioned, and the version is in the filename - libndi.4.dylib,
// libndi.so.6 and so on - so the directories are searched rather than a list of
// exact names guessed at. Guessing names is how this came to report "not found"
// on a Mac that had NDI installed.
const LIB_PATTERN = {
  win32: /^Processing\.NDI\.Lib\.x64\.dll$/i,
  darwin: /^libndi(\.\d+)*\.dylib$|^libndi\.dylib(\.\d+)*$/i,
  linux: /^libndi\.so(\.\d+)*$/i,
};

function libraryPattern() {
  return LIB_PATTERN[process.platform] || LIB_PATTERN.linux;
}

function libraryName() {
  if (process.platform === 'win32') return 'Processing.NDI.Lib.x64.dll';
  if (process.platform === 'darwin') return 'libndi.dylib';
  return 'libndi.so.6';
}

// Directories worth looking in, most specific first. The NDI installers set
// NDI_RUNTIME_DIR_V<n>, so an explicit install is found without searching.
function searchDirs() {
  const out = [];
  for (const v of ['V6', 'V5', 'V4', 'V3', 'V2']) {
    const dir = process.env[`NDI_RUNTIME_DIR_${v}`];
    if (dir) out.push(dir);
  }

  if (process.platform === 'win32') {
    const base = process.env['ProgramFiles'] || 'C:\\Program Files';
    for (const v of ['NDI 6 Tools', 'NDI 5 Tools', 'NDI 6 Runtime', 'NDI 5 Runtime']) {
      out.push(path.join(base, 'NDI', v, 'Runtime'));
    }
  } else if (process.platform === 'darwin') {
    out.push('/usr/local/lib');
    out.push('/opt/homebrew/lib');
    // Both of these are directories the NDI installers and the OBS NDI
    // plugin's own uninstall instructions name on macOS. The library can sit
    // a couple of levels down, so these are walked rather than listed.
    out.push('/Library/Application Support/NewTek/NDI');
    out.push('/Library/NDI SDK for Apple/lib');
    out.push('/Library/NDI');
  } else {
    out.push('/opt/ndi/lib', '/usr/local/lib', '/usr/lib', '/usr/lib/x86_64-linux-gnu');
  }
  return out;
}

// Shallow walk: the file is usually right there, occasionally one or two
// folders down (lib/macOS, for instance). Deeper than that is someone's
// bespoke layout, and TEXT_DISPLAY_NDI_LIB exists for those.
function scan(dir, pattern, depth, found) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) scan(full, pattern, depth - 1, found);
    } else if (pattern.test(entry.name)) {
      found.push(full);
    }
  }
}

function findLibrary() {
  // An explicit override wins outright, and is not second-guessed.
  const explicit = process.env.TEXT_DISPLAY_NDI_LIB;
  if (explicit) {
    try {
      if (fs.existsSync(explicit)) return explicit;
    } catch { /* fall through to searching */ }
  }

  const pattern = libraryPattern();
  for (const dir of searchDirs()) {
    const found = [];
    scan(dir, pattern, 2, found);
    if (!found.length) continue;
    // Prefer the highest version when a machine has several side by side.
    found.sort((a, b) => path.basename(b).localeCompare(path.basename(a), undefined, { numeric: true }));
    return found[0];
  }
  return null;
}

// Everything that was looked at, for an error message that tells the operator
// where to put the library rather than just that it is missing.
function searchedPaths() {
  return searchDirs();
}

let cached = null;

// Returns { ok, error, path, version, Sender } and never throws: a machine
// without NDI should still run the app, just without a feed.
function load() {
  if (cached) return cached;

  const file = findLibrary();
  if (!file) {
    cached = {
      ok: false,
      error: 'The NDI runtime was not found. Install NDI Tools, or set '
        + 'TEXT_DISPLAY_NDI_LIB to the library. Looked in: '
        + searchedPaths().join(', '),
      searched: searchedPaths(),
    };
    return cached;
  }

  let koffi;
  try {
    koffi = require('koffi');
  } catch (err) {
    cached = { ok: false, error: `The koffi FFI module failed to load: ${err.message}` };
    return cached;
  }

  try {
    cached = build(koffi, file);
  } catch (err) {
    cached = { ok: false, error: `Could not bind the NDI runtime: ${err.message}`, path: file };
  }
  return cached;
}

function build(koffi, file) {
  const lib = koffi.load(file);

  const SendCreate = koffi.struct('NDIlib_send_create_t', {
    p_ndi_name: 'const char *',
    p_groups: 'const char *',
    clock_video: 'bool',
    clock_audio: 'bool',
  });

  // Field order and types mirror Processing.NDI.structs.h exactly; koffi
  // applies the platform's own alignment rules, so this lands on 72 bytes on
  // x64 the same way the C struct does.
  const VideoFrame = koffi.struct('NDIlib_video_frame_v2_t', {
    xres: 'int',
    yres: 'int',
    FourCC: 'int',
    frame_rate_N: 'int',
    frame_rate_D: 'int',
    picture_aspect_ratio: 'float',
    frame_format_type: 'int',
    timecode: 'int64',
    p_data: 'uint8_t *',
    line_stride_in_bytes: 'int',
    p_metadata: 'const char *',
    timestamp: 'int64',
  });

  const fns = {
    initialize: lib.func('bool NDIlib_initialize()'),
    destroy: lib.func('void NDIlib_destroy()'),
    version: lib.func('const char * NDIlib_version()'),
    sendCreate: lib.func('void * NDIlib_send_create(const NDIlib_send_create_t *p)'),
    sendVideo: lib.func('void NDIlib_send_send_video_v2(void *inst, const NDIlib_video_frame_v2_t *f)'),
    sendDestroy: lib.func('void NDIlib_send_destroy(void *inst)'),
    getNoConnections: lib.func('int NDIlib_send_get_no_connections(void *inst, uint32_t timeout_ms)'),
  };

  if (!fns.initialize()) {
    throw new Error('NDIlib_initialize() failed - the CPU may not meet the runtime requirements');
  }

  class Sender {
    constructor(name) {
      this.name = name;
      this.instance = fns.sendCreate({
        p_ndi_name: name,
        p_groups: null,
        clock_video: false,   // we pace frames ourselves; see the sender
        clock_audio: false,
      });
      if (!this.instance) throw new Error('NDIlib_send_create() returned null');
    }

    send(frame) {
      if (!this.instance) return;
      fns.sendVideo(this.instance, frame);
    }

    // How many receivers are watching, which is the honest way to tell the
    // operator whether anything is actually picking the feed up.
    connections() {
      if (!this.instance) return 0;
      try {
        return fns.getNoConnections(this.instance, 0);
      } catch {
        return 0;
      }
    }

    destroy() {
      if (!this.instance) return;
      try {
        fns.sendDestroy(this.instance);
      } finally {
        this.instance = null;
      }
    }
  }

  return {
    ok: true,
    path: file,
    version: String(fns.version() || '').trim(),
    host: os.hostname(),
    Sender,
    FOURCC_BGRA,
    FOURCC_BGRX,
    FORMAT_PROGRESSIVE,
  };
}

module.exports = { load, findLibrary, searchedPaths, FOURCC_BGRA, FOURCC_BGRX, FORMAT_PROGRESSIVE };
