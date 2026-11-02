'use strict';
// Renders the display page into an offscreen window and pushes the pixels out
// as an NDI source. Electron only: it needs a Chromium compositor to paint.
//
// The page it renders is the ordinary /display page on whatever server it is
// pointed at, so the feed is exactly what a browser source would show.
const { BrowserWindow } = require('electron');
const ndiLib = require('./ndi-lib');

const MIN_FPS = 1;
const MAX_FPS = 60;

// Chromium composites with premultiplied alpha; NDI's BGRA is straight alpha.
// Without undoing the multiply, every partly-covered pixel - antialiased text
// edges, soft shadows, a half-opaque bar - arrives too dark, and keying the
// feed leaves grey fringes around the letters.
function unpremultiply(buf) {
  for (let i = 0; i < buf.length; i += 4) {
    const a = buf[i + 3];
    // Fully opaque and fully clear pixels are already correct, and on a
    // lower-third most of the frame is one or the other.
    if (a === 0 || a === 255) continue;
    const scale = 255 / a;
    const b = (buf[i] * scale + 0.5) | 0;
    const g = (buf[i + 1] * scale + 0.5) | 0;
    const r = (buf[i + 2] * scale + 0.5) | 0;
    buf[i] = b > 255 ? 255 : b;
    buf[i + 1] = g > 255 ? 255 : g;
    buf[i + 2] = r > 255 ? 255 : r;
  }
}

class NdiOutput {
  constructor({ displayUrl, onStatus }) {
    this.displayUrl = displayUrl;
    this.onStatus = onStatus || (() => {});

    this.config = null;
    this.window = null;
    this.sender = null;
    this.pump = null;

    this.latest = null;        // most recent BGRA frame from Chromium
    this.framesCaptured = 0;
    this.framesSent = 0;
    this.lastError = null;
    // Crash recovery state; see recover().
    this.recovering = false;
    this.recoveries = 0;
    this.startedAt = null;

    const lib = ndiLib.load();
    this.lib = lib.ok ? lib : null;
    this.libError = lib.ok ? null : lib.error;
    this.libPath = lib.path || null;
    this.libVersion = lib.ok ? lib.version : null;
  }

  get available() {
    return Boolean(this.lib);
  }

  status() {
    // What is actually going out, which is not always what was asked for:
    // display scaling has caught this out before.
    const actual = this.latest ? `${this.latest.width}x${this.latest.height}` : null;
    const wanted = this.config ? `${this.config.width}x${this.config.height}` : null;
    const mismatch = actual && wanted && actual !== wanted
      ? `The feed is going out at ${actual}, not the ${wanted} requested.`
      : null;

    return {
      available: this.available,
      error: this.lastError || this.libError || mismatch || null,
      actualSize: actual,
      running: Boolean(this.sender && this.window),
      sourceName: this.sender ? this.sender.name : null,
      // The name a receiver actually sees: NDI prefixes the host itself.
      fullName: this.sender && this.lib ? `${this.lib.host} (${this.sender.name})` : null,
      connections: this.sender ? this.sender.connections() : 0,
      framesCaptured: this.framesCaptured,
      recoveries: this.recoveries,
      framesSent: this.framesSent,
      since: this.startedAt,
      library: this.libPath,
      libraryVersion: this.libVersion,
      displayUrl: this.displayUrl,
    };
  }

  report() {
    try {
      this.onStatus(this.status());
    } catch { /* reporting must never take the feed down */ }
  }

  // Works out what actually has to be rebuilt. Changing the frame rate should
  // not tear down the window and make the feed blink.
  apply(next) {
    const prev = this.config;
    this.config = normalize(next);

    if (!this.config.enabled) {
      this.stop();
      return;
    }
    if (!this.available) {
      this.lastError = this.libError;
      this.report();
      return;
    }

    const sizeChanged = !prev
      || prev.width !== this.config.width
      || prev.height !== this.config.height
      || prev.alpha !== this.config.alpha;
    const nameChanged = !prev || prev.name !== this.config.name;

    try {
      if (sizeChanged || !this.window) this.openWindow();
      if (sizeChanged || nameChanged || !this.sender) this.openSender();
      this.startPump();
      this.lastError = null;
      this.recoveries = 0;
    } catch (err) {
      this.lastError = err.message;
      this.stop(true);
    }
    this.report();
  }

  openWindow() {
    this.closeWindow();
    const { width, height, alpha, fps } = this.config;

    this.window = new BrowserWindow({
      width,
      height,
      useContentSize: true,
      show: false,
      frame: false,
      transparent: alpha,
      backgroundColor: alpha ? '#00000000' : '#000000',
      webPreferences: {
        // useSharedTexture:false is the point here. With shared textures on,
        // 'paint' hands over a GPU texture handle and the NativeImage comes
        // through empty, so nothing ever reaches NDI. We want CPU bitmaps.
        offscreen: { useSharedTexture: false },
        nodeIntegration: false,
        contextIsolation: true,
        // The feed must keep painting even though the window is never shown.
        backgroundThrottling: false,
      },
    });

    this.window.webContents.setAudioMuted(true);
    this.window.webContents.setFrameRate(clamp(fps, MIN_FPS, MAX_FPS));

    this.window.webContents.on('paint', (_event, _dirty, image) => {
      if (!image) return;
      const size = image.getSize();
      if (!size.width || !size.height) return;

      // Converted here, once per painted frame, rather than on every send.
      // getBitmap() already returns a fresh buffer, so it can be converted in
      // place with no copy. Doing it per send meant a still page redid the
      // same two-million-pixel pass thirty times a second and allocated a
      // fresh eight-megabyte buffer each time, and that garbage alone was
      // enough to make the machine hitch.
      const data = image.getBitmap();
      if (alpha) unpremultiply(data);

      this.latest = { data, width: size.width, height: size.height, alpha };
      this.framesCaptured += 1;

      // Straight out as it was painted, so NDI frames and rendered frames
      // stay one to one.
      this.sendFrame();
    });

    this.window.webContents.on('did-fail-load', (_e, code, description) => {
      this.lastError = `Could not load ${this.displayUrl}: ${description} (${code})`;
      this.report();
    });

    // A graphics driver reset takes the renderer down with it, and an
    // offscreen window that has died stops painting silently: NDI keeps
    // sending the last frame it was given, so the feed freezes on a stale
    // image rather than going away. Rebuild instead of sitting there.
    this.window.webContents.on('render-process-gone', (_event, details) => {
      this.lastError = `The renderer stopped (${details.reason}); restarting the feed.`;
      this.report();
      this.recover();
    });

    this.window.on('unresponsive', () => {
      this.lastError = 'The renderer stopped responding; restarting the feed.';
      this.report();
      this.recover();
    });

    // ndi=1 keeps the page from drawing the disconnected badge over the feed.
    this.window.loadURL(`${this.displayUrl}?ndi=1`);
  }

  // Rebuilds the capture side after a crash, backing off so a machine whose
  // graphics driver is in trouble is not hammered into a restart loop.
  recover() {
    if (this.recovering || !this.config || !this.config.enabled) return;
    this.recovering = true;

    const attempt = (this.recoveries || 0) + 1;
    this.recoveries = attempt;
    const delay = Math.min(30000, 2000 * attempt);

    this.stopPump();
    this.latest = null;

    setTimeout(() => {
      this.recovering = false;
      if (!this.config || !this.config.enabled) return;
      try {
        this.openWindow();
        this.startPump();
        this.lastError = null;
      } catch (err) {
        this.lastError = `Could not restart the feed: ${err.message}`;
        // Another go, unless this has become hopeless.
        if (attempt < 10) this.recover();
      }
      this.report();
    }, delay).unref?.();
  }

  openSender() {
    this.closeSender();
    this.sender = new this.lib.Sender(this.config.name);
    this.framesSent = 0;
    this.framesCaptured = 0;
    this.startedAt = new Date().toISOString();
  }

  // NDI wants a steady cadence. Chromium only paints when something changes,
  // so a still page would otherwise stop the feed dead; the last frame is
  // resent instead.
  // One NDI frame per painted frame. Pacing sends on a timer of its own
  // instead meant the timer and the compositor drifted against each other,
  // so a frame was occasionally sent twice or skipped - which reads as a
  // stutter in otherwise smooth movement.
  sendFrame() {
    if (!this.sender || !this.latest || !this.config) return;
    const frame = this.latest;
    const fps = clamp(this.config.fps, MIN_FPS, MAX_FPS);

    try {
      this.sender.send({
        xres: frame.width,
        yres: frame.height,
        FourCC: frame.alpha ? this.lib.FOURCC_BGRA : this.lib.FOURCC_BGRX,
        frame_rate_N: Math.round(fps * 1000),
        frame_rate_D: 1000,
        picture_aspect_ratio: frame.width / frame.height,
        frame_format_type: this.lib.FORMAT_PROGRESSIVE,
        timecode: 0n,
        p_data: frame.data,
        line_stride_in_bytes: frame.width * 4,
        p_metadata: null,
        timestamp: 0n,
      });
      this.framesSent += 1;
      this.lastSentAt = Date.now();
    } catch (err) {
      this.lastError = `Send failed: ${err.message}`;
      this.stop(true);
      this.report();
    }
  }

  // Chromium only paints when something changes, so a still page would stop
  // the feed dead. This resends the last frame, but only once nothing has
  // gone out for a frame and a half - during movement every frame is sent by
  // sendFrame() and this never fires.
  startPump() {
    this.stopPump();
    const fps = clamp(this.config.fps, MIN_FPS, MAX_FPS);
    const idle = Math.max(8, Math.round(1500 / fps));

    this.pump = setInterval(() => {
      if (!this.sender || !this.latest) return;
      if (Date.now() - (this.lastSentAt || 0) < idle) return;
      this.sendFrame();
    }, idle);
    if (this.pump.unref) this.pump.unref();
  }

  stopPump() {
    if (this.pump) clearInterval(this.pump);
    this.pump = null;
  }

  closeWindow() {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.latest = null;
  }

  closeSender() {
    if (this.sender) this.sender.destroy();
    this.sender = null;
    this.startedAt = null;
  }

  stop(keepError = false) {
    this.stopPump();
    this.closeSender();
    this.closeWindow();
    if (!keepError) this.lastError = null;
    this.report();
  }
}

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

function normalize(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  return {
    enabled: Boolean(c.enabled),
    name: typeof c.name === 'string' && c.name.trim() ? c.name.trim().slice(0, 80) : 'Text Display',
    width: Math.round(clamp(c.width, 160, 3840)),
    height: Math.round(clamp(c.height, 90, 2160)),
    fps: Math.round(clamp(c.fps, MIN_FPS, MAX_FPS)),
    alpha: c.alpha !== false,
  };
}

module.exports = { NdiOutput, unpremultiply, MIN_FPS, MAX_FPS };
