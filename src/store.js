'use strict';
const crypto = require('node:crypto');
const { MESSAGES_FILE } = require('./paths');
const { readJson, writeJson } = require('./jsonfile');

// review  -> waiting for a moderator
// parked  -> held back; editable, can be pushed to review
// live    -> cleared for display; the display page shows exactly these
// archive -> has been displayed and retired
const STATES = ['review', 'parked', 'live', 'archive'];

const MAX_BODY = 2000;
const MAX_NAME = 120;

let messages = null;
const listeners = new Set();

function load() {
  if (messages) return messages;
  const raw = readJson(MESSAGES_FILE, []);
  messages = Array.isArray(raw) ? raw.filter((m) => m && STATES.includes(m.state)) : [];
  return messages;
}

function persist() {
  writeJson(MESSAGES_FILE, messages);
}

function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.error(`[store] listener failed: ${err.message}`);
    }
  }
}

function commit() {
  persist();
  emit();
}

const clean = (v, max) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);

// The display shows the edited text once someone has touched it; otherwise
// the message exactly as it arrived.
function displayText(m) {
  return m.editedBody != null ? m.editedBody : m.body;
}

function publicView(m) {
  return { ...m, text: displayText(m), edited: m.editedBody != null };
}

function all() {
  return load().map(publicView);
}

function byState(state) {
  return load()
    .filter((m) => m.state === state)
    .sort((a, b) => {
      if (state === 'live') return (a.liveAt || '').localeCompare(b.liveAt || '');
      if (state === 'archive') return (b.archivedAt || '').localeCompare(a.archivedAt || '');
      return (b.receivedAt || '').localeCompare(a.receivedAt || '');
    })
    .map(publicView);
}

function counts() {
  const out = { review: 0, parked: 0, live: 0, archive: 0 };
  for (const m of load()) out[m.state] += 1;
  return out;
}

function find(id) {
  return load().find((m) => m.id === id) || null;
}

function create({ sender, body, source = 'manual' }, at = null) {
  const text = clean(body, MAX_BODY);
  if (!text) {
    const err = new Error('Message body is empty');
    err.status = 400;
    throw err;
  }
  const now = at || new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    source: clean(source, 40) || 'manual',
    sender: clean(sender, MAX_NAME),
    body: text,
    editedBody: null,
    state: 'review',
    receivedAt: now,
    updatedAt: now,
    parkedAt: null,
    liveAt: null,
    archivedAt: null,
  };
}

function add(input) {
  const message = create(input);
  load().unshift(message);
  commit();
  return publicView(message);
}

// A pasted list becomes one write, and keeps the order it was pasted in.
// Every entry is stamped with the same instant on purpose: byState() sorts
// newest first, and giving each its own millisecond would scatter one paste
// across the queue in whatever order the clock happened to tick.
function addMany(entries, source = 'pasted') {
  const at = new Date().toISOString();
  const list = (Array.isArray(entries) ? entries : [])
    .map((entry) => (typeof entry === 'string' ? { body: entry } : entry))
    .filter((entry) => entry && String(entry.body ?? '').trim())
    .map((entry) => create({ ...entry, source }, at));

  if (!list.length) {
    const err = new Error('Nothing to submit');
    err.status = 400;
    throw err;
  }
  load().unshift(...list);
  commit();
  return list.map(publicView);
}

function requireMessage(id) {
  const m = find(id);
  if (!m) {
    const err = new Error('Message not found');
    err.status = 404;
    throw err;
  }
  return m;
}

function requireState(state) {
  if (!STATES.includes(state)) {
    const err = new Error(`Unknown state: ${state}`);
    err.status = 400;
    throw err;
  }
  return state;
}

function applyState(m, state) {
  const now = new Date().toISOString();
  m.state = state;
  m.updatedAt = now;
  if (state === 'parked') m.parkedAt = now;
  // liveAt orders the display queue, so re-clearing a message sends it to the
  // back of the queue rather than reviving its original position.
  if (state === 'live') m.liveAt = now;
  if (state === 'archive') m.archivedAt = now;
  return m;
}

function setState(id, state) {
  requireState(state);
  const m = applyState(requireMessage(id), state);
  commit();
  return publicView(m);
}

// One write for the whole selection: moving twenty messages used to persist
// twenty times, so a single blocked write left the batch half applied.
function setStateMany(ids, state) {
  requireState(state);
  const changed = (Array.isArray(ids) ? ids : [])
    .map((id) => find(id))
    .filter(Boolean)
    .map((m) => publicView(applyState(m, state)));
  if (changed.length) commit();
  return changed;
}

function edit(id, body) {
  const m = requireMessage(id);
  const text = clean(body, MAX_BODY);
  if (!text) {
    const err = new Error('Edited text cannot be empty');
    err.status = 400;
    throw err;
  }
  // Keep the original body untouched so an edit is always revertable.
  m.editedBody = text === m.body ? null : text;
  m.editedAt = m.editedBody ? new Date().toISOString() : null;
  m.updatedAt = new Date().toISOString();
  commit();
  return publicView(m);
}

function revert(id) {
  const m = requireMessage(id);
  m.editedBody = null;
  m.editedAt = null;
  m.updatedAt = new Date().toISOString();
  commit();
  return publicView(m);
}

function remove(id) {
  requireMessage(id);
  messages = load().filter((m) => m.id !== id);
  commit();
  return { id, deleted: true };
}

function clearState(state) {
  if (!STATES.includes(state)) {
    const err = new Error(`Unknown state: ${state}`);
    err.status = 400;
    throw err;
  }
  const before = load().length;
  messages = load().filter((m) => m.state !== state);
  commit();
  return { deleted: before - messages.length };
}

// Everything currently cleared for display, oldest-cleared first.
function liveQueue() {
  return byState('live');
}

module.exports = {
  STATES, onChange, all, byState, counts, find,
  add, addMany, setState, setStateMany, edit, revert, remove, clearState, liveQueue,
};
