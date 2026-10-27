'use strict';
// The setup window is the only page that talks to the main process, and it
// gets a deliberately tiny surface: read the machine's settings, test a
// server, save, restart. No node, no filesystem, nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setup', {
  load: () => ipcRenderer.invoke('setup:load'),
  test: (url) => ipcRenderer.invoke('setup:test', url),
  save: (data) => ipcRenderer.invoke('setup:save', data),
  restart: () => ipcRenderer.invoke('setup:restart'),
  openAdmin: () => ipcRenderer.invoke('setup:openAdmin'),
  close: () => ipcRenderer.invoke('setup:close'),
});
