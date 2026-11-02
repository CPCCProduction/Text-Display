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

// Where the runtime lives, in the order worth trying. The NDI installers set
// NDI_RUNTIME_DIR_V<n>, so an explicit install is found without guessing.
function candidatePaths() {
  const out = [];
  const explicit = process.env.TEXT_DISPLAY_NDI_LIB;
  if (explicit) out.push(explicit);

  for (const v of ['V6', 'V5', 'V4']) {
    const dir = process.env[`NDI_RUNTIME_DIR_${v}`];
    if (dir) out.push(path.join(dir, libraryName()));
  }

  if (process.platform === 'win32') {
    const base = process.env['ProgramFiles'] || 'C:\\Program Files';
    for (const v of ['NDI 6 Tools', 'NDI 5 Tools', 'NDI 6 Runtime', 'NDI 5 Runtime']) {
      out.push(path.join(base, 'NDI', v, 'Runtime', libraryName()));
    }
  } else if (process.platform === 'darwin') {
    // NDI Tools for Mac drops the runtime in /usr/local/lib; the SDK and the
    // Apple-silicon installers use their own folders. Homebrew's prefix on
    // Apple silicon is /opt/homebrew.
    out.push('/usr/local/lib/libndi.dylib');
    out.push('/usr/local/lib/libndi.4.dylib');
    out.push('/opt/homebrew/lib/libndi.dylib');
    out.push('/Library/NDI SDK for Apple/lib/macOS/libndi.dylib');
    out.push('/Library/Application Support/NewTek/NDI/libndi.dylib');
  } else {
    // Linux, including inside a container where the runtime is mounted in.
    for (const dir of ['/opt/ndi/lib', '/usr/local/lib', '/usr/lib', '/usr/lib/x86_64-linux-gnu']) {
      for (const name of ['libndi.so.6', 'libndi.so.5', 'libndi.so']) {
        out.push(path.join(dir, name));
      }
    }
  }
  return out;
}

function libraryName() {
  if (process.platform === 'win32') return 'Processing.NDI.Lib.x64.dll';
  if (process.platform === 'darwin') return 'libndi.dylib';
  return 'libndi.so.6';
}

function findLibrary() {
  for (const file of candidatePaths()) {
    try {
      if (fs.existsSync(file)) return file;
    } catch { /* unreadable path, try the next */ }
  }
  return null;
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
      error: 'The NDI runtime was not found. Install NDI Tools, or set TEXT_DISPLAY_NDI_LIB to the library.',
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

module.exports = { load, findLibrary, FOURCC_BGRA, FOURCC_BGRX, FORMAT_PROGRESSIVE };
