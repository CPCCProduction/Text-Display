'use strict';
const { CONFIG_FILE } = require('./paths');
const { readJson, writeJson } = require('./jsonfile');

// Messages are typed or pasted in by a person on this network, so there is no
// inbound webhook and nothing to authenticate from outside.
const DEFAULTS = {
  port: 4321,
  // Admin is host-only by default; the display page stays open so a browser
  // source on another machine can pull it. Behind Docker every request
  // arrives from the bridge rather than loopback, so the container image
  // turns this off through the environment instead of the config file.
  adminLocalhostOnly: true,
  // The NDI feed is produced by a sender process - on Windows, in the booth -
  // but it is configured here so the admin panel can drive it from anywhere.
  ndi: {
    enabled: false,
    name: 'Text Display',
    width: 1920,
    height: 1080,
    fps: 30,
    alpha: true,
  },
};

const FPS_CHOICES = [15, 24, 25, 30, 50, 60];

let cache = null;

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function int(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

// An env var wins over the stored file, so a container can be configured
// without a writable config and without baking choices into the image.
function envBool(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

// Only known keys survive, so settings left over from an earlier version do
// not linger in config.json.
function normalize(input) {
  const stored = input && typeof input === 'object' ? input : {};
  const storedNdi = stored.ndi && typeof stored.ndi === 'object' ? stored.ndi : {};
  const d = DEFAULTS;

  const adminEnv = envBool('TEXT_DISPLAY_ADMIN_LOCALHOST_ONLY');

  return {
    port: int(stored.port, 1, 65535, d.port),
    adminLocalhostOnly: adminEnv !== undefined
      ? adminEnv
      : bool(stored.adminLocalhostOnly, d.adminLocalhostOnly),
    ndi: {
      enabled: bool(storedNdi.enabled, d.ndi.enabled),
      name: typeof storedNdi.name === 'string' && storedNdi.name.trim()
        ? storedNdi.name.trim().slice(0, 80)
        : d.ndi.name,
      width: int(storedNdi.width, 160, 3840, d.ndi.width),
      height: int(storedNdi.height, 90, 2160, d.ndi.height),
      fps: int(storedNdi.fps, 1, 60, d.ndi.fps),
      alpha: bool(storedNdi.alpha, d.ndi.alpha),
    },
  };
}

function get() {
  if (!cache) cache = normalize(readJson(CONFIG_FILE, {}));
  return cache;
}

function update(patch) {
  const current = get();
  const p = patch && typeof patch === 'object' ? patch : {};
  const merged = {
    ...current,
    ...(p.port !== undefined ? { port: p.port } : {}),
    ...(p.adminLocalhostOnly !== undefined ? { adminLocalhostOnly: p.adminLocalhostOnly } : {}),
    ndi: { ...current.ndi, ...(p.ndi && typeof p.ndi === 'object' ? p.ndi : {}) },
  };
  cache = normalize(merged);
  writeJson(CONFIG_FILE, cache);
  return cache;
}

function updateNdi(patch) {
  return update({ ndi: patch }).ndi;
}

module.exports = { get, update, updateNdi, DEFAULTS, FPS_CHOICES };
