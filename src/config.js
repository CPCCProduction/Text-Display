'use strict';
const { CONFIG_FILE } = require('./paths');
const { readJson, writeJson } = require('./jsonfile');

// Messages are typed or pasted in by a person on this network, so there is no
// inbound webhook and nothing to authenticate from outside.
const DEFAULTS = {
  port: 4321,
  // Admin is host-only by default; the display page stays open so a browser
  // source on another machine can pull it.
  adminLocalhostOnly: true,
};

let cache = null;

// Only the keys above are kept, so settings left over from an earlier version
// do not linger in config.json.
function normalize(input) {
  const stored = input && typeof input === 'object' ? input : {};
  const next = { ...DEFAULTS };
  if (Number.isInteger(stored.port) && stored.port > 0 && stored.port < 65536) {
    next.port = stored.port;
  }
  if (typeof stored.adminLocalhostOnly === 'boolean') {
    next.adminLocalhostOnly = stored.adminLocalhostOnly;
  }
  return next;
}

function get() {
  if (!cache) cache = normalize(readJson(CONFIG_FILE, {}));
  return cache;
}

function update(patch) {
  const merged = { ...get() };
  if (patch && typeof patch === 'object') {
    if (patch.port !== undefined) merged.port = Number(patch.port);
    if (patch.adminLocalhostOnly !== undefined) {
      merged.adminLocalhostOnly = Boolean(patch.adminLocalhostOnly);
    }
  }
  cache = normalize(merged);
  writeJson(CONFIG_FILE, cache);
  return cache;
}

module.exports = { get, update, DEFAULTS };
