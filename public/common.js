'use strict';

// Shared behaviour for the admin-side pages. Whichever queue columns a page
// declares with data-cards="<state>" get rendered and wired up, so the same
// code drives the live board and the parked/archive page.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const TD = {
  state: null,
  settings: null,
  options: { fonts: [], scrollTypes: [], backgroundModes: [] },
  // Selection and open editors are per-browser, so two people moderating at
  // once never disturb each other's checkboxes or half-typed edits.
  selected: new Set(),
  editing: new Set(),
  hooks: new Set(),
  onState(fn) {
    TD.hooks.add(fn);
  },
};
window.TD = TD;

/* ---------- helpers ---------- */

let toastTimer = null;
function toast(message, isError = false) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
TD.toast = toast;

async function api(path, options = {}) {
  const res = await fetch('/api/' + path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
TD.api = api;

TD.get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

// Settings PATCHes are sparse: only the touched leaf travels, so two people
// editing different panels never clobber each other.
TD.nest = (path, value) => {
  const parts = path.split('.');
  const out = {};
  let node = out;
  parts.forEach((key, i) => {
    if (i === parts.length - 1) node[key] = value;
    else node = (node[key] = {});
  });
  return out;
};

TD.mergeDeep = function mergeDeep(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] = mergeDeep(target[key] || {}, value);
    } else {
      target[key] = value;
    }
  }
  return target;
};

function timeLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/* ---------- message cards ---------- */

// Labels say where the message goes, not what the state is called
// internally: "Send Live" puts it on the screen, "Take Down" removes it.
const ACTIONS = {
  review: [
    ['live', 'Send Live', 'ok'],
    ['parked', 'Park', 'warn'],
  ],
  parked: [
    ['live', 'Send Live', 'ok'],
    ['review', 'To Review', 'ghost'],
  ],
  live: [
    ['archive', 'Take Down', ''],
    ['parked', 'Park', 'warn'],
  ],
  archive: [
    ['live', 'Send Live', 'ok'],
    ['review', 'To Review', 'ghost'],
  ],
};

function button(label, kind, data) {
  const b = document.createElement('button');
  b.className = 'btn sm' + (kind ? ' ' + kind : '');
  b.textContent = label;
  for (const [key, value] of Object.entries(data)) b.dataset[key] = value;
  return b;
}

// A "simple" column drops the checkbox and the move buttons: the submission
// page only lets someone fix a typo or remove a message they pasted.
function card(m, stateName, simple = false) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.id = m.id;
  if (!simple && TD.selected.has(m.id)) el.classList.add('selected');

  const top = document.createElement('div');
  top.className = 'card-top';

  if (!simple) {
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = TD.selected.has(m.id);
    check.dataset.select = m.id;
    top.append(check);
  }

  if (m.sender) {
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = m.sender;
    top.append(who);
  }

  const when = document.createElement('span');
  when.textContent = timeLabel(m.receivedAt);
  top.append(when);

  if (m.edited) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = 'edited';
    top.append(tag);
  }
  el.append(top);

  if (TD.editing.has(m.id)) {
    const area = document.createElement('textarea');
    area.value = m.text;
    area.dataset.editor = m.id;
    el.append(area);

    const actions = document.createElement('div');
    actions.className = 'card-actions';
    actions.append(
      button('Save', 'primary', { save: m.id }),
      button('Cancel', 'ghost', { cancelEdit: m.id }),
    );
    if (m.edited) actions.append(button('Revert to original', 'ghost', { revert: m.id }));
    el.append(actions);
    return el;
  }

  const text = document.createElement('div');
  text.className = 'text';
  text.textContent = m.text;
  el.append(text);

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  if (!simple) {
    for (const [target, label, kind] of ACTIONS[stateName] || []) {
      actions.append(button(label, kind, { move: m.id, target }));
    }
  }
  actions.append(button('Edit', 'ghost', { edit: m.id }));
  actions.append(button('Delete', 'danger', { del: m.id }));
  el.append(actions);

  return el;
}

function renderQueues() {
  for (const host of $$('[data-cards]')) {
    const name = host.dataset.cards;
    const simple = host.dataset.simple === '1';
    const list = TD.state[name] || [];
    host.textContent = '';
    for (const m of list) host.append(card(m, name, simple));
    const count = $('[data-count="' + name + '"]');
    if (count) count.textContent = list.length;
  }

  // Tab pills show what is waiting on the other pages, so nobody has to
  // switch tabs just to check. A pill names either a group or a single state.
  const counts = TD.state.counts || {};
  const GROUPS = {
    onair: ['review', 'live'],
    offair: ['parked', 'archive'],
  };
  for (const pill of $$('[data-tabcount]')) {
    const key = pill.dataset.tabcount;
    const states = GROUPS[key] || [key];
    pill.textContent = states.reduce((sum, s) => sum + (counts[s] || 0), 0);
  }

  // Cards were just rebuilt, so the marker has to be placed against the new
  // ones. markerKey is deliberately left alone: repositioning is not a
  // change of which messages are marked, and should not scroll the column
  // out from under whoever is reading it.
  renderOnScreen();
}
TD.renderQueues = renderQueues;

/* ---------- the on-screen marker ---------- */

// A display that has gone away stops sending its heartbeat, and a stale
// marker is worse than none: it would point at a message nobody can see.
const ONSCREEN_TTL = 30000;
let markerKey = '';

function renderOnScreen() {
  const host = $('[data-cards="live"]');
  if (!host || !TD.state) return;

  const report = TD.state.onScreen || { ids: [], at: 0 };
  const fresh = report.at && Date.now() - report.at < ONSCREEN_TTL;
  const cards = (fresh ? report.ids : [])
    .map((id) => host.querySelector('.card[data-id="' + id + '"]'))
    .filter(Boolean);

  let box = host.querySelector('.onscreen-box');
  if (!cards.length) {
    if (box) box.remove();
    markerKey = '';
    return;
  }

  if (!box) {
    box = document.createElement('div');
    box.className = 'onscreen-box';
    const tag = document.createElement('span');
    tag.textContent = 'On screen';
    box.append(tag);
    host.append(box);
  }

  const top = Math.min(...cards.map((c) => c.offsetTop));
  const bottom = Math.max(...cards.map((c) => c.offsetTop + c.offsetHeight));
  box.style.top = (top - 4) + 'px';
  box.style.height = (bottom - top + 8) + 'px';

  // Follow the marker only when the set of marked messages actually changes,
  // so it never fights someone scrolling the column by hand.
  const key = cards.map((c) => c.dataset.id).join(',');
  if (key !== markerKey) {
    markerKey = key;
    if (top < host.scrollTop || bottom > host.scrollTop + host.clientHeight) {
      host.scrollTo({ top: Math.max(0, top - 12), behavior: 'smooth' });
    }
  }
}
TD.renderOnScreen = renderOnScreen;

// The marker expires on its own, so re-check even when nothing arrives.
setInterval(renderOnScreen, 5000);

/* ---------- queue actions ---------- */

function bindQueues() {
  const host = $('#queues');
  if (!host) return;

  host.addEventListener('click', async (event) => {
    const el = event.target.closest('button, input[data-select]');
    if (!el) return;
    const d = el.dataset;

    try {
      if (d.select) {
        if (el.checked) TD.selected.add(d.select);
        else TD.selected.delete(d.select);
        el.closest('.card').classList.toggle('selected', el.checked);
        return;
      }
      if (d.move) {
        await api('messages/' + d.move + '/state', {
          method: 'PATCH', body: JSON.stringify({ state: d.target }),
        });
        TD.selected.delete(d.move);
        return;
      }
      if (d.edit) { TD.editing.add(d.edit); renderQueues(); return; }
      if (d.cancelEdit) { TD.editing.delete(d.cancelEdit); renderQueues(); return; }
      if (d.save) {
        const area = $('[data-editor="' + d.save + '"]');
        await api('messages/' + d.save, {
          method: 'PATCH', body: JSON.stringify({ text: area.value }),
        });
        TD.editing.delete(d.save);
        return;
      }
      if (d.revert) {
        await api('messages/' + d.revert + '/revert', { method: 'PATCH' });
        TD.editing.delete(d.revert);
        return;
      }
      if (d.del) {
        if (!confirm('Delete this message for good?')) return;
        await api('messages/' + d.del, { method: 'DELETE' });
        TD.selected.delete(d.del);
        return;
      }
      if (d.bulk) {
        const column = el.closest('.col').dataset.state;
        const ids = (TD.state[column] || []).map((m) => m.id).filter((id) => TD.selected.has(id));
        if (!ids.length) return toast('Nothing selected in ' + column);
        await api('messages/bulk', {
          method: 'POST', body: JSON.stringify({ ids, state: d.bulk }),
        });
        for (const id of ids) TD.selected.delete(id);
        toast(ids.length + ' message(s) moved');
        return;
      }
      if (d.clear) {
        const label = d.clear === 'live' ? 'take every live message off the display'
          : 'permanently delete every archived message';
        if (!confirm('This will ' + label + '. Continue?')) return;
        if (d.clear === 'live') {
          const ids = (TD.state.live || []).map((m) => m.id);
          await api('messages/bulk', {
            method: 'POST', body: JSON.stringify({ ids, state: 'archive' }),
          });
          toast(ids.length + ' message(s) taken down');
        } else {
          const result = await api('messages/clear', {
            method: 'POST', body: JSON.stringify({ state: 'archive' }),
          });
          toast(result.deleted + ' message(s) deleted');
        }
        return;
      }
      if (d.selectAll) {
        const list = TD.state[d.selectAll] || [];
        const allOn = list.length > 0 && list.every((m) => TD.selected.has(m.id));
        for (const m of list) {
          if (allOn) TD.selected.delete(m.id);
          else TD.selected.add(m.id);
        }
        renderQueues();
      }
    } catch (err) {
      toast(err.message, true);
    }
  });
}

/* ---------- loading and live updates ---------- */

let loading = null;

async function load() {
  // One in-flight load at a time: a burst of incoming texts would otherwise
  // stack up requests and render them out of order.
  if (loading) return loading;
  loading = (async () => {
    try {
      TD.state = await api('state');
      TD.settings = TD.state.settings;
      TD.options = TD.state.options || TD.options;
      const version = $('#version');
      if (version) version.textContent = 'v' + TD.state.version;
      renderQueues();
      for (const fn of TD.hooks) {
        try {
          fn(TD.state);
        } catch (err) {
          console.error('state hook failed', err);
        }
      }
      document.body.classList.add('live');
      setStatus('connected');
    } catch (err) {
      document.body.classList.remove('live');
      setStatus(err.message);
    } finally {
      loading = null;
    }
  })();
  return loading;
}
TD.load = load;

function setStatus(text) {
  const el = $('#status');
  if (el) el.textContent = text;
}

let refreshTimer = null;
function scheduleLoad() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(load, 80);
}

// Both pages watch the same stream, so a change made by one person appears
// on the other person's screen without a refresh.
function connect() {
  const source = new EventSource('/api/stream');
  source.onmessage = () => scheduleLoad();

  // Its own event, so moving the marker never costs a full state reload.
  source.addEventListener('onscreen', (event) => {
    try {
      if (!TD.state) return;
      TD.state.onScreen = JSON.parse(event.data);
      renderOnScreen();
    } catch { /* the next report will carry the same information */ }
  });

  source.onopen = () => {
    document.body.classList.add('live');
    setStatus('connected');
  };
  source.onerror = () => {
    document.body.classList.remove('live');
    setStatus('reconnecting');
    source.close();
    setTimeout(connect, 2000);
  };
}

TD.start = function start() {
  bindQueues();
  const here = location.pathname.replace(/\/$/, '') || '/admin';
  for (const tab of $$('.tab')) {
    const target = new URL(tab.href, location.origin).pathname.replace(/\/$/, '');
    if (target === here) tab.setAttribute('aria-current', 'page');
  }
  load().then(connect);
};
