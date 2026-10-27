'use strict';
// Keeps the NDI sender in step with whatever the server says. The server may
// be this same process, or a container on the other side of the building; the
// sender neither knows nor cares.
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const { NdiOutput } = require('./ndi-sender');

const RETRY_MS = 3000;
const HEARTBEAT_MS = 5000;

// A small SSE reader. Electron's main process has no EventSource, and the
// stream format is three lines of text, so this is less code than a
// dependency would be.
function openStream(url, { onEvent, onOpen, onClose }) {
  const target = new URL(url);
  const client = target.protocol === 'https:' ? https : http;

  const req = client.get(target, { headers: { Accept: 'text/event-stream' } }, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      onClose(new Error(`stream returned ${res.statusCode}`));
      return;
    }
    onOpen();

    let buffer = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buffer += chunk;
      let split;
      // Events are separated by a blank line; anything after the last one is
      // a partial event and stays in the buffer.
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);

        let name = 'message';
        const data = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) name = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trim());
          // ': ping' keep-alive comments fall through and are ignored.
        }
        if (!data.length) continue;
        try {
          onEvent(name, JSON.parse(data.join('\n')));
        } catch { /* a malformed frame should not kill the stream */ }
      }
    });
    res.on('end', () => onClose(null));
    res.on('error', (err) => onClose(err));
  });

  req.on('error', (err) => onClose(err));
  return req;
}

function startNdiClient({ serverUrl, displayUrl, log = () => {} }) {
  const base = serverUrl.replace(/\/+$/, '');
  const output = new NdiOutput({
    displayUrl: displayUrl || `${base}/display`,
    onStatus: (status) => postStatus(status),
  });

  let stream = null;
  let retry = null;
  let heartbeat = null;
  let stopped = false;
  let lastPosted = '';

  async function postStatus(status, force = false) {
    const body = JSON.stringify(status);
    // Status is mostly unchanging; only the frame counter moves. Posting only
    // on real change keeps a 30fps feed from chattering at the server.
    const fingerprint = JSON.stringify({ ...status, framesSent: 0, connections: 0 });
    if (!force && fingerprint === lastPosted) return;
    lastPosted = fingerprint;

    try {
      const res = await fetch(`${base}/api/ndi/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      // The reply carries the current settings, which is how a sender that
      // started before the server picks them up without waiting.
      if (res.ok) {
        const data = await res.json();
        if (data && data.config) output.apply(data.config);
      }
    } catch { /* the server will hear from the next heartbeat */ }
  }

  async function pullConfig() {
    try {
      const res = await fetch(`${base}/api/ndi`);
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.config) output.apply(data.config);
    } catch { /* retried on reconnect */ }
  }

  function connect() {
    if (stopped) return;
    clearTimeout(retry);

    stream = openStream(`${base}/api/stream`, {
      onOpen: () => {
        log(`NDI sender connected to ${base}`);
        pullConfig();
      },
      onEvent: (name, data) => {
        if (name === 'ndi' && data && data.config) output.apply(data.config);
      },
      onClose: () => {
        stream = null;
        if (stopped) return;
        retry = setTimeout(connect, RETRY_MS);
      },
    });
  }

  connect();
  heartbeat = setInterval(() => postStatus(output.status(), true), HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();

  return {
    output,
    status: () => output.status(),
    stop() {
      stopped = true;
      clearTimeout(retry);
      clearInterval(heartbeat);
      if (stream) stream.destroy();
      output.stop();
    },
  };
}

module.exports = { startNdiClient, openStream };
