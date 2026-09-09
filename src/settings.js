'use strict';
const { SETTINGS_FILE } = require('./paths');
const { readJson, writeJson } = require('./jsonfile');

const FONT_STACKS = {
  'Inter': "'Inter', 'Segoe UI', system-ui, sans-serif",
  'Segoe UI': "'Segoe UI', system-ui, sans-serif",
  'Arial': "Arial, Helvetica, sans-serif",
  'Helvetica Neue': "'Helvetica Neue', Helvetica, Arial, sans-serif",
  'Roboto': "'Roboto', 'Segoe UI', sans-serif",
  'Montserrat': "'Montserrat', 'Segoe UI', sans-serif",
  'Oswald': "'Oswald', 'Arial Narrow', sans-serif",
  'Bebas Neue': "'Bebas Neue', Impact, sans-serif",
  'Georgia': "Georgia, 'Times New Roman', serif",
  'Times New Roman': "'Times New Roman', Times, serif",
  'Courier New': "'Courier New', Courier, monospace",
  'Consolas': "Consolas, 'Courier New', monospace",
};

const SCROLL_TYPES = [
  'static',        // no motion; one message at a time
  'crawl-up',      // continuous vertical credits roll, bottom to top
  'crawl-down',    // continuous vertical roll, top to bottom
  'ticker-left',   // continuous horizontal ticker, right to left
  'ticker-right',  // continuous horizontal ticker, left to right
  'fade',          // cross-fade one message to the next
  'slide-up',      // step one message at a time, sliding upward
];

const BACKGROUND_MODES = ['solid', 'transparent', 'chroma'];

// How the lines inside a message align. This is separate from where the text
// block sits in the frame (layout.horizontalAlign): a block can be centred in
// the frame while its own lines are justified.
const TEXT_ALIGNS = ['left', 'center', 'right', 'justify'];

const DEFAULTS = {
  background: {
    mode: 'solid',
    color: '#0b1020',
    opacity: 1,
    chromaColor: '#00ff00',
  },
  font: {
    family: 'Inter',
    size: 48,
    weight: 600,
    color: '#ffffff',
    lineHeight: 1.3,
    letterSpacing: 0,
    italic: false,
    uppercase: false,
    align: 'left',
    shadow: { enabled: true, blur: 12, opacity: 0.65, offsetX: 0, offsetY: 3, color: '#000000' },
  },
  // The display shows message text only. Who sent it stays in the admin
  // panel for the moderator and never goes to air.
  scroll: {
    type: 'crawl-up',
    speed: 60,           // px per second for crawl/ticker
    spacing: 90,         // px of gap between messages
    holdSeconds: 8,      // dwell time for static/fade/slide-up
    fadeSeconds: 0.8,    // cross-fade duration
    pauseOnEmpty: true,
  },
  gradients: {
    top:    { enabled: true,  size: 140, strength: 1 },
    bottom: { enabled: true,  size: 140, strength: 1 },
    left:   { enabled: false, size: 120, strength: 1 },
    right:  { enabled: false, size: 120, strength: 1 },
    color: '#000000',
    // In transparent/chroma mode the gradients fade the TEXT out instead of
    // painting solid bars over it, so the alpha edge stays clean.
    maskInAlphaModes: true,
  },
  // The display fills whatever window or output it is given, so there is no
  // authored canvas size here - only the insets and alignment within it.
  layout: {
    paddingX: 120,
    paddingY: 80,
    maxTextWidth: 1500,
    verticalAlign: 'center',   // top | center | bottom
    horizontalAlign: 'left',   // left | center | right
  },
};

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Deep-merge stored settings over the defaults so a settings.json written by
// an older version still boots, and any new key picks up its default.
function merge(defaults, stored) {
  if (!isObject(stored)) return structuredClone(defaults);
  const out = structuredClone(defaults);
  for (const [key, value] of Object.entries(stored)) {
    if (!(key in out)) continue;
    out[key] = isObject(out[key]) ? merge(out[key], value) : value;
  }
  return out;
}

const clamp = (n, lo, hi, fallback) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
};
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const HEX = /^#[0-9a-fA-F]{6}$/;
const color = (v, fallback) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : fallback);
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);

// Everything reaching the display page has been range-checked here, so the
// renderer can trust every value it reads.
function sanitize(input) {
  const s = merge(DEFAULTS, input);
  const d = DEFAULTS;

  s.background.mode = oneOf(s.background.mode, BACKGROUND_MODES, d.background.mode);
  s.background.color = color(s.background.color, d.background.color);
  s.background.chromaColor = color(s.background.chromaColor, d.background.chromaColor);
  s.background.opacity = clamp(s.background.opacity, 0, 1, d.background.opacity);

  s.font.family = s.font.family in FONT_STACKS ? s.font.family : d.font.family;
  s.font.size = clamp(s.font.size, 12, 240, d.font.size);
  s.font.weight = clamp(s.font.weight, 100, 900, d.font.weight);
  s.font.color = color(s.font.color, d.font.color);
  s.font.lineHeight = clamp(s.font.lineHeight, 0.8, 3, d.font.lineHeight);
  s.font.letterSpacing = clamp(s.font.letterSpacing, -10, 40, d.font.letterSpacing);
  s.font.italic = bool(s.font.italic, d.font.italic);
  s.font.uppercase = bool(s.font.uppercase, d.font.uppercase);
  s.font.align = oneOf(s.font.align, TEXT_ALIGNS, d.font.align);
  s.font.shadow.enabled = bool(s.font.shadow.enabled, d.font.shadow.enabled);
  s.font.shadow.blur = clamp(s.font.shadow.blur, 0, 80, d.font.shadow.blur);
  s.font.shadow.opacity = clamp(s.font.shadow.opacity, 0, 1, d.font.shadow.opacity);
  s.font.shadow.offsetX = clamp(s.font.shadow.offsetX, -40, 40, d.font.shadow.offsetX);
  s.font.shadow.offsetY = clamp(s.font.shadow.offsetY, -40, 40, d.font.shadow.offsetY);
  s.font.shadow.color = color(s.font.shadow.color, d.font.shadow.color);

  s.scroll.type = oneOf(s.scroll.type, SCROLL_TYPES, d.scroll.type);
  s.scroll.speed = clamp(s.scroll.speed, 5, 600, d.scroll.speed);
  s.scroll.spacing = clamp(s.scroll.spacing, 0, 600, d.scroll.spacing);
  s.scroll.holdSeconds = clamp(s.scroll.holdSeconds, 1, 120, d.scroll.holdSeconds);
  s.scroll.fadeSeconds = clamp(s.scroll.fadeSeconds, 0, 5, d.scroll.fadeSeconds);
  s.scroll.pauseOnEmpty = bool(s.scroll.pauseOnEmpty, d.scroll.pauseOnEmpty);

  for (const edge of ['top', 'bottom', 'left', 'right']) {
    const g = s.gradients[edge];
    g.enabled = bool(g.enabled, d.gradients[edge].enabled);
    g.size = clamp(g.size, 0, 900, d.gradients[edge].size);
    g.strength = clamp(g.strength, 0, 1, d.gradients[edge].strength);
  }
  s.gradients.color = color(s.gradients.color, d.gradients.color);
  s.gradients.maskInAlphaModes = bool(s.gradients.maskInAlphaModes, d.gradients.maskInAlphaModes);

  s.layout.paddingX = clamp(s.layout.paddingX, 0, 800, d.layout.paddingX);
  s.layout.paddingY = clamp(s.layout.paddingY, 0, 800, d.layout.paddingY);
  s.layout.maxTextWidth = clamp(s.layout.maxTextWidth, 200, 7680, d.layout.maxTextWidth);
  s.layout.verticalAlign = oneOf(s.layout.verticalAlign, ['top', 'center', 'bottom'], d.layout.verticalAlign);
  s.layout.horizontalAlign = oneOf(s.layout.horizontalAlign, ['left', 'center', 'right'], d.layout.horizontalAlign);

  return s;
}

let cache = null;

function get() {
  if (!cache) cache = sanitize(readJson(SETTINGS_FILE, {}));
  return cache;
}

function update(patch) {
  cache = sanitize(merge(get(), patch));
  writeJson(SETTINGS_FILE, cache);
  return cache;
}

function reset() {
  cache = structuredClone(DEFAULTS);
  writeJson(SETTINGS_FILE, cache);
  return cache;
}

module.exports = {
  get, update, reset, sanitize,
  DEFAULTS, FONT_STACKS, SCROLL_TYPES, BACKGROUND_MODES, TEXT_ALIGNS,
};
