'use strict';
// Electron shell: starts the same HTTP server the headless entry point uses,
// then wraps the admin panel and the display page in windows. Everything the
// windows do goes through HTTP, so a browser source on another machine behaves
// identically to the built-in display window.
const { app, BrowserWindow, Menu, shell, clipboard, dialog, screen } = require('electron');

const { listen } = require('./src/server');
const config = require('./src/config');
const settings = require('./src/settings');
const { startNdiClient } = require('./src/ndi-client');
const pkg = require('./package.json');

// Point this at the server to run as a booth sender beside a hosted app:
//   TEXT_DISPLAY_SERVER=http://textdisplay.lan:4321
// With it set, no local server starts - this process renders the hosted
// display page and puts it on the network as NDI.
const REMOTE_SERVER = (process.env.TEXT_DISPLAY_SERVER || '').trim().replace(/\/+$/, '');

// Windows sizes windows in logical pixels, so on a machine running at 150%
// an offscreen window asked for 1280x720 rasterises to 1920x1080 and the NDI
// feed comes out at the wrong resolution. Broadcast output has to be exact,
// so this app opts out of display scaling entirely. The side effect is that
// the admin window renders at 100% rather than the desktop's scale.
app.commandLine.appendSwitch('force-device-scale-factor', '1');

let server = null;
let baseUrl = '';
let adminWindow = null;
let displayWindow = null;
let ndi = null;

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

// Disabling display scaling keeps the NDI feed pixel-exact, but it also makes
// every window render at 100%, which on a high-resolution screen leaves the
// admin UI far too small. Windows is asked what the desktop's own scaling is
// so the interface can be put back to the size it should have been.
//
// Electron reports physical pixels once scaling is forced off; a plain
// PowerShell process is DPI-unaware and reports the logical desktop, and the
// ratio between them is the scaling the user actually chose.
let uiScale = 1;

function detectUiScale() {
  if (process.platform !== 'win32') return 1;
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width',
    ], { encoding: 'utf8', timeout: 5000, windowsHide: true });

    const logical = Number(String(out).trim());
    const physical = screen.getPrimaryDisplay().size.width;
    if (!logical || !physical) return 1;

    // Windows offers scaling in quarter steps, so snap to one rather than
    // trusting a ratio that rounding has nudged off.
    const snapped = Math.round((physical / logical) * 4) / 4;
    return snapped >= 1 && snapped <= 3 ? snapped : 1;
  } catch {
    // Not worth failing to start over: 100% is merely small, not broken.
    return 1;
  }
}

function createAdminWindow() {
  const work = screen.getPrimaryDisplay().workAreaSize;
  adminWindow = new BrowserWindow({
    // Zooming the contents shows proportionally less of them, so the window
    // grows with the zoom to keep the same amount of panel on screen.
    width: Math.min(Math.round(1400 * uiScale), work.width),
    height: Math.min(Math.round(900 * uiScale), work.height),
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b1020',
    title: `${pkg.productName} - Admin`,
    autoHideMenuBar: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // Has to be reapplied per navigation, not just once at startup.
  adminWindow.webContents.on('did-finish-load', () => {
    adminWindow.webContents.setZoomFactor(uiScale);
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
  if (REMOTE_SERVER) {
    // Booth sender mode: the app is hosted elsewhere, this machine only puts
    // the display page on the video network.
    baseUrl = REMOTE_SERVER;
  } else {
    try {
      server = await listen(config.get().port);
    } catch (err) {
      dialog.showErrorBox('Text Display', `Could not start the server:\n\n${err.message}`);
      app.quit();
      return;
    }
    baseUrl = `http://localhost:${server.address().port}`;
  }

  uiScale = detectUiScale();
  console.log(`[ui] desktop scaling detected as ${Math.round(uiScale * 100)}%`);

  ndi = startNdiClient({
    serverUrl: baseUrl,
    displayUrl: `${baseUrl}/display`,
    log: (message) => console.log(`[ndi] ${message}`),
  });

  buildMenu();
  createAdminWindow();
  screen.on('display-added', buildMenu);
  screen.on('display-removed', buildMenu);
});

app.on('window-all-closed', () => {
  app.quit();
});

// Tearing the sender down properly removes the source from the network
// rather than leaving receivers staring at a dead feed.
app.on('before-quit', () => {
  if (ndi) ndi.stop();
  if (server) server.close();
});
