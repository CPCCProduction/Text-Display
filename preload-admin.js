'use strict';
// The admin page is served over HTTP and is usually opened in a browser,
// where none of this exists. When it is opened inside the desktop app it also
// gets this bridge, so it can offer the machine-local settings that only make
// sense there.
//
// The surface is deliberately almost nothing: report what this machine is,
// and open the setup window. The page cannot read files, run code, or change
// anything through it.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('textDisplayShell', {
  isApp: true,
  info: () => ipcRenderer.invoke('shell:info'),
  openSetup: () => ipcRenderer.invoke('shell:openSetup'),
});
