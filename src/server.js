'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { URL } = require('node:url');

const { PUBLIC_DIR } = require('./paths');
const store = require('./store');
const settings = require('./settings');
const config = require('./config');
const pkg = require('../package.json');
const version = require('./version');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const MAX_BODY_BYTES = 64 * 1024;

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8' });
}

function isLocal(req) {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Every request comes from this app's own pages, so the body is always JSON.
async function parseBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    const err = new Error('Request body must be JSON');
    err.status = 400;
    throw err;
  }
}

const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);

function pick(payload, names) {
  for (const name of names) {
    const value = payload[name];
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number') return String(value);
  }
  return '';
}

function localAddresses(port) {
  const urls = [`http://localhost:${port}`];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) urls.push(`http://${iface.address}:${port}`);
    }
  }
  return urls;
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'admin.html' : urlPath.replace(/^\/+/, '');
  const target = path.join(PUBLIC_DIR, rel);
  // Never let a crafted path escape public/.
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== PUBLIC_DIR) {
    return send(res, 403, 'Forbidden');
  }
  fs.readFile(target, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const mime = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    send(res, 200, data, { 'Content-Type': mime });
  });
}

function createServer() {
  // Every connected display and admin page holds one SSE stream.
  const clients = new Set();

  // What the audience can see right now, as reported by the display page.
  let onScreen = { ids: [], at: 0 };

  // Reported by whichever machine is running the NDI sender. The server never
  // produces a feed itself - it only holds the settings and relays them - so
  // the web app stays happy in a container with no GPU and no NDI runtime.
  let ndiStatus = { available: false, running: false, error: null, at: 0 };

  function snapshot() {
    return {
      version: pkg.version,
      build: version.info,
      settings: settings.get(),
      counts: store.counts(),
      live: store.liveQueue(),
      onScreen,
    };
  }

  function pushEvent(name, data) {
    const payload = (name ? `event: ${name}\n` : '') + `data: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try {
        res.write(payload);
      } catch {
        clients.delete(res);
      }
    }
  }

  function broadcast() {
    pushEvent(null, snapshot());
  }

  // On-screen updates arrive several times a second during a crawl, so they
  // go out as their own event: the admin panel moves its marker, and nobody
  // reloads the full state.
  function broadcastOnScreen() {
    pushEvent('onscreen', onScreen);
  }

  // The sender listens for this and reconfigures itself, so changing the feed
  // name or resolution in the admin panel takes effect without a restart.
  function broadcastNdi() {
    pushEvent('ndi', { config: config.get().ndi, status: ndiStatus });
  }

  const unsubscribe = store.onChange(broadcast);

  function openStream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    // A comment line every 20s keeps proxies and sleeping sockets from
    // dropping the stream mid-service.
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(ping);
      }
    }, 20000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
  }

  async function handleApi(req, res, url) {
    const route = url.pathname.replace(/^\/api\/?/, '');
    const method = req.method;

    if (route === 'stream' && method === 'GET') return openStream(req, res);

    // The display reports this, and the display is often on another machine,
    // so it sits outside the host-only gate below. It only ever reports which
    // messages are visible; it cannot change anything.
    if (route === 'onscreen' && method === 'POST') {
      const payload = await parseBody(req);
      const ids = Array.isArray(payload.ids)
        ? payload.ids.filter((id) => typeof id === 'string').slice(0, 200)
        : [];
      onScreen = { ids, at: Date.now() };
      broadcastOnScreen();
      return sendJson(res, 200, { ok: true });
    }

    // The NDI sender runs on another machine, so like the display it reports
    // in from outside the host-only gate. It reads its settings back in the
    // reply, which is how a sender that started before the server catches up.
    if (route === 'ndi/status' && method === 'POST') {
      const payload = await parseBody(req);
      ndiStatus = {
        available: Boolean(payload.available),
        running: Boolean(payload.running),
        error: typeof payload.error === 'string' ? payload.error.slice(0, 400) : null,
        sourceName: str(payload.sourceName, 120),
        fullName: str(payload.fullName, 160),
        connections: Number(payload.connections) || 0,
        framesCaptured: Number(payload.framesCaptured) || 0,
        recoveries: Number(payload.recoveries) || 0,
        framesSent: Number(payload.framesSent) || 0,
        since: str(payload.since, 40),
        library: str(payload.library, 400),
        libraryVersion: str(payload.libraryVersion, 120),
        actualSize: str(payload.actualSize, 20),
        displayUrl: str(payload.displayUrl, 300),
        at: Date.now(),
      };
      broadcastNdi();
      return sendJson(res, 200, { ok: true, config: config.get().ndi });
    }

    if (route === 'ndi' && method === 'GET') {
      return sendJson(res, 200, { config: config.get().ndi, status: ndiStatus });
    }

    // Everything past this point drives the admin panel.
    if (config.get().adminLocalhostOnly && !isLocal(req)) {
      return sendJson(res, 403, { error: 'Admin API is restricted to this computer' });
    }

    if (route === 'state' && method === 'GET') {
      return sendJson(res, 200, {
        ...snapshot(),
        review: store.byState('review'),
        parked: store.byState('parked'),
        archive: store.byState('archive'),
        config: { ...config.get(), urls: localAddresses(config.get().port) },
        ndiStatus,
        options: {
          fonts: Object.keys(settings.FONT_STACKS),
          scrollTypes: settings.SCROLL_TYPES,
          backgroundModes: settings.BACKGROUND_MODES,
          textAligns: settings.TEXT_ALIGNS,
          fpsChoices: config.FPS_CHOICES,
        },
      });
    }

    // One pasted block becomes many messages in a single write, so a long
    // list cannot end up half submitted.
    if (route === 'messages/paste' && method === 'POST') {
      const payload = await parseBody(req);
      const created = store.addMany(payload.texts, 'pasted');
      return sendJson(res, 201, { created: created.length, messages: created });
    }

    if (route === 'messages' && method === 'POST') {
      const payload = await parseBody(req);
      const body = pick(payload, ['text', 'body', 'message']);
      const sender = pick(payload, ['sender', 'name']);
      return sendJson(res, 201, store.add({ sender, body, source: 'manual' }));
    }

    const idMatch = route.match(/^messages\/([\w-]+)(?:\/(\w+))?$/);
    if (idMatch) {
      const [, id, action] = idMatch;
      if (method === 'DELETE') return sendJson(res, 200, store.remove(id));
      if (method === 'PATCH' || method === 'PUT') {
        const payload = await parseBody(req);
        if (action === 'state') return sendJson(res, 200, store.setState(id, payload.state));
        if (action === 'revert') return sendJson(res, 200, store.revert(id));
        return sendJson(res, 200, store.edit(id, pick(payload, ['text', 'body', 'message'])));
      }
    }

    if (route === 'messages/bulk' && method === 'POST') {
      const payload = await parseBody(req);
      return sendJson(res, 200, { changed: store.setStateMany(payload.ids, payload.state) });
    }

    if (route === 'messages/clear' && method === 'POST') {
      const payload = await parseBody(req);
      return sendJson(res, 200, store.clearState(payload.state));
    }

    if (route === 'settings') {
      if (method === 'GET') return sendJson(res, 200, settings.get());
      if (method === 'PATCH' || method === 'PUT') {
        const updated = settings.update(await parseBody(req));
        broadcast();
        return sendJson(res, 200, updated);
      }
      if (method === 'DELETE') {
        const reset = settings.reset();
        broadcast();
        return sendJson(res, 200, reset);
      }
    }

    if (route === 'ndi' && (method === 'PATCH' || method === 'PUT')) {
      const payload = await parseBody(req);
      const updated = config.updateNdi(payload);
      // Push straight to the sender rather than waiting for its next poll.
      broadcastNdi();
      return sendJson(res, 200, { config: updated, status: ndiStatus });
    }

    if (route === 'config' && (method === 'PATCH' || method === 'PUT')) {
      const payload = await parseBody(req);
      const updated = config.update({
        adminLocalhostOnly: payload.adminLocalhostOnly,
        port: Number(payload.port) || undefined,
      });
      return sendJson(res, 200, { ...updated, urls: localAddresses(updated.port) });
    }

    return sendJson(res, 404, { error: `No such endpoint: ${method} /api/${route}` });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'OPTIONS') {
      return send(res, 204, '', {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
    }

    if (url.pathname.startsWith('/api/')) {
      return handleApi(req, res, url).catch((err) => {
        const status = err.status || 500;
        if (status >= 500) console.error(`[api] ${err.stack || err.message}`);
        sendJson(res, status, { error: err.message });
      });
    }

    if (url.pathname === '/admin' || url.pathname === '/') return serveStatic(res, '/admin.html');
    // A second moderator works the parked and archived messages here while
    // the operator runs the live board.
    if (url.pathname === '/parked') return serveStatic(res, '/parked.html');
    // Where messages come in now: someone pastes them from a list.
    if (url.pathname === '/submit') return serveStatic(res, '/submit.html');
    if (url.pathname === '/display') return serveStatic(res, '/display.html');
    return serveStatic(res, url.pathname);
  });

  server.on('close', unsubscribe);
  server.broadcast = broadcast;
  server.urls = () => localAddresses(server.address()?.port || config.get().port);
  return server;
}

// Falls forward through a few ports so a busy 4321 doesn't block startup.
function listen(preferredPort, attempts = 10) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    let port = preferredPort || config.get().port;
    let tries = 0;
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && tries < attempts) {
        tries += 1;
        port += 1;
        server.listen(port, '0.0.0.0');
        return;
      }
      reject(err);
    });
    server.once('listening', () => {
      if (port !== config.get().port) config.update({ port });
      resolve(server);
    });
    server.listen(port, '0.0.0.0');
  });
}

module.exports = { createServer, listen, localAddresses };
