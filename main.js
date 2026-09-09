'use strict';
// Electron shell: starts the same HTTP server the headless entry point uses,
// then wraps the admin panel and the display page in windows. Everything the
// windows do goes through HTTP, so a browser source on another machine behaves
// identically to the built-in display window.
const { app, BrowserWindow, Menu, shell, clipboard, dialog, screen } = require('electron');

const { listen } = require('./src/server');
const config = require('./src/config');
const settings = require('./src/settings');
const pkg = require('./package.json');

let server = null;
let baseUrl = '';
let adminWindow = null;
let displayWindow = null;

// Only one instance may own the port; a second launch focuses the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (adminWindow) {
      if (adminWindow.isMinimized()) adminWindow.restore();
      adminWindow.focus();
    }
  });
}

function createAdminWindow() {
  adminWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b1020',
    title: `${pkg.productName} - Admin`,
    autoHideMenuBar: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  adminWindow.loadURL(`${baseUrl}/admin`);
  adminWindow.on('closed', () => {
    adminWindow = null;
  });
  return adminWindow;
}

function createDisplayWindow() {
  if (displayWindow && !displayWindow.isDestroyed()) {
    displayWindow.show();
    displayWindow.focus();
    return displayWindow;
  }

  const alpha = settings.get().background.mode === 'transparent';
  // Transparency has to be decided when the window is created, so the window
  // is torn down and rebuilt when the background mode changes.
  // The page fills whatever size this window ends up at, so these are just a
  // comfortable starting point before it gets sent to an output.
  displayWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    useContentSize: true,
    title: `${pkg.productName} - Display`,
    backgroundColor: alpha ? '#00000000' : '#000000',
    transparent: alpha,
    frame: !alpha,
    hasShadow: false,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  displayWindow.setMenuBarVisibility(false);
  displayWindow.loadURL(`${baseUrl}/display`);
  displayWindow.on('closed', () => {
    displayWindow = null;
  });
  return displayWindow;
}

function rebuildDisplayWindow() {
  if (displayWindow && !displayWindow.isDestroyed()) {
    const win = displayWindow;
    displayWindow = null;
    win.destroy();
  }
  createDisplayWindow();
}

// Drops the display window onto a chosen monitor at native size, which is the
// usual setup: admin on the operator's screen, display on the projector feed.
function moveDisplayToScreen(index) {
  const win = createDisplayWindow();
  const displays = screen.getAllDisplays();
  const target = displays[index] || displays[0];
  if (!target) return;
  win.setBounds(target.bounds);
  win.setFullScreen(true);
}

function buildMenu() {
  const cfg = config.get();
  const displays = screen.getAllDisplays();

  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Admin Panel',
          accelerator: 'CmdOrCtrl+1',
          click: () => (adminWindow ? adminWindow.focus() : createAdminWindow()),
        },
        {
          label: 'Open Display Window',
          accelerator: 'CmdOrCtrl+2',
          click: () => createDisplayWindow(),
        },
        {
          label: 'Reload Display Window',
          click: () => rebuildDisplayWindow(),
        },
        { type: 'separator' },
        {
          label: 'Send Display To',
          submenu: displays.map((d, i) => ({
            label: `Screen ${i + 1} (${d.size.width}x${d.size.height})${d.internal ? ' - built-in' : ''}`,
            click: () => moveDisplayToScreen(i),
          })),
        },
        {
          label: 'Toggle Display Fullscreen',
          accelerator: 'F11',
          click: () => {
            const win = createDisplayWindow();
            win.setFullScreen(!win.isFullScreen());
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'Connection',
      submenu: [
        {
          label: 'Copy Display URL',
          click: () => clipboard.writeText(`${baseUrl}/display`),
        },
        {
          label: 'Copy Submission Page URL',
          click: () => clipboard.writeText(`${baseUrl}/submit`),
        },
        {
          label: 'Show Connection Info',
          click: () => {
            const c = config.get();
            dialog.showMessageBox(adminWindow || undefined, {
              type: 'info',
              title: 'Connection Info',
              message: `${pkg.productName} v${pkg.version}`,
              detail: [
                ...server.urls().flatMap((url) => [
                  `Submit:   ${url}/submit`,
                  `Admin:    ${url}/admin`,
                  `Display:  ${url}/display`,
                  '',
                ]),
                `Admin host-only:  ${c.adminLocalhostOnly ? 'yes' : 'no'}`,
              ].join('\n'),
            });
          },
        },
        { type: 'separator' },
        {
          label: 'Open Display in Browser',
          click: () => shell.openExternal(`${baseUrl}/display`),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
  ];

  // Referenced so a future menu tweak keeps the port visible in one place.
  template[2].submenu[0].sublabel = `port ${cfg.port}`;

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  try {
    server = await listen(config.get().port);
  } catch (err) {
    dialog.showErrorBox('Text Display', `Could not start the server:\n\n${err.message}`);
    app.quit();
    return;
  }
  baseUrl = `http://localhost:${server.address().port}`;
  buildMenu();
  createAdminWindow();
  screen.on('display-added', buildMenu);
  screen.on('display-removed', buildMenu);
});

app.on('window-all-closed', () => {
  if (server) server.close();
  app.quit();
});
