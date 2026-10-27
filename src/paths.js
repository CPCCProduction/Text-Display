'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Data lives beside the app during development, and in the user's roaming
// profile once installed, so an update never wipes the message history.
function dataDir() {
  if (process.env.TEXT_DISPLAY_DATA) return process.env.TEXT_DISPLAY_DATA;
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data');
  }
  const packaged = process.mainModule && /app\.asar/.test(process.mainModule.filename || '');
  if (packaged) {
    const base = process.env.APPDATA || path.join(os.homedir(), '.config');
    return path.join(base, 'TextDisplay');
  }
  return path.join(__dirname, '..', 'data');
}

const DATA_DIR = dataDir();
fs.mkdirSync(DATA_DIR, { recursive: true });

module.exports = {
  DATA_DIR,
  MESSAGES_FILE: path.join(DATA_DIR, 'messages.json'),
  SETTINGS_FILE: path.join(DATA_DIR, 'settings.json'),
  CONFIG_FILE: path.join(DATA_DIR, 'config.json'),
  // Which server this machine sends NDI for. Local to the machine, not part
  // of the shared settings: two booth PCs could point at the same server.
  SENDER_FILE: path.join(DATA_DIR, 'sender.json'),
  PUBLIC_DIR: path.join(__dirname, '..', 'public'),
};
