'use strict';
const fs = require('node:fs');
const path = require('node:path');

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    // A corrupt file must not take the app down mid-service: keep a copy of
    // the bad data and carry on with defaults.
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch { /* nothing more we can do */ }
    console.error(`[store] could not parse ${path.basename(file)}: ${err.message}`);
    return fallback;
  }
}

// On Windows the rename below is denied while something else holds the target
// open even for a moment. OneDrive's sync filter, the search indexer and
// antivirus all do exactly that, and the data folder sits inside OneDrive on
// the machine this runs on, so a first attempt failing is routine.
const LOCK_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RETRY_DELAYS = [0, 10, 25, 50, 100, 200];

function sleepSync(ms) {
  if (!ms) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Write to a sibling temp file then rename, so a crash never leaves a
// half-written messages.json behind.
function writeJson(file, value) {
  const data = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, 'utf8');

  let lastErr = null;
  for (const delay of RETRY_DELAYS) {
    sleepSync(delay);
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      if (!LOCK_CODES.has(err.code)) break;
    }
  }

  // Still locked after backing off. Writing in place gives up the crash
  // safety of the rename, but losing a message move mid-service is worse
  // than the small window where the file is partially written.
  try {
    fs.writeFileSync(file, data, 'utf8');
    console.error(`[store] ${path.basename(file)}: rename blocked (${lastErr.code}), wrote in place`);
  } catch {
    throw lastErr;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch { /* the next write overwrites it anyway */ }
  }
}

module.exports = { readJson, writeJson };
