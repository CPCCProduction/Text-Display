'use strict';
// Electron shell: starts the same HTTP server the headless entry point uses,
// then wraps the admin panel and the display page in windows. Everything the
// windows do goes through HTTP, so a browser source on another machine behaves
// identically to the built-in display window.
const { app, BrowserWindow, Menu, shell, clipboard, dialog, screen, ipcMain } = require('electron');
const path = require('node:path');
const os = require('node:os');
const { existsSync: fsExists } = require('node:fs');

const { listen } = require('./src/server');
const config = require('./src/config');
const settings = require('./src/settings');
const { startNdiClient } = require('./src/ndi-client');
const { SENDER_FILE } = require('./src/paths');
const { readJson, writeJson } = require('./src/jsonfile');
const pkg = require('./package.json');

// A booth machine runs this beside a hosted app: no local server, just the
// hosted display page rendered offscreen and put on the network as NDI.
//
//   "Text Display.exe" --server=http://textdisplay.lan:4321  set it, and remember
//   "Text Display.exe"                                    use what was remembered
//   "Text Display.exe" --local                            forget it, host locally
//
// Remembering it matters: a booth PC is set up once and then just started
// from a shortcut, and an environment variable is an awkward thing to carry.
function resolveServer() {
  const args = process.argv.slice(1);
  const flag = args.find((a) => a.startsWith('--server='));
  const local = args.includes('--local');

  const clean = (value) => String(value || '').trim().replace(/\/+$/, '');

  if (local) {
    try {
      writeJson(SENDER_FILE, {});
    } catch { /* nothing remembered is the same as forgetting it */ }
    return '';
  }

  const given = clean(flag ? flag.slice('--server='.length) : process.env.TEXT_DISPLAY_SERVER);
  if (given) {
    try {
      writeJson(SENDER_FILE, { server: given });
    } catch { /* it still works this run, just not the next */ }
    return given;
  }

  try {
    return clean(readJson(SENDER_FILE, {}).server);
  } catch {
    return '';
  }
}

const REMOTE_SERVER = resolveServer();

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
let setupWindow = null;
let ndi = null;

// Setting this machine's role from a window rather than a command line: a
// booth PC is configured once by whoever is standing in front of it.
function createSetupWindow() {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.show();
    setupWindow.focus();
    return setupWindow;
  }

  setupWindow = new BrowserWindow({
    width: Math.round(620 * uiScale),
    height: Math.round(680 * uiScale),
    resizable: true,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#0b1020',
    title: `${pkg.productName} - Setup`,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  setupWindow.webContents.on('did-finish-load', () => {
    setupWindow.webContents.setZoomFactor(uiScale);
  });
  setupWindow.loadFile(path.join(__dirname, 'public', 'setup.html'));
  setupWindow.on('closed', () => {
    setupWindow = null;
  });
  return setupWindow;
}

function registerSetupHandlers() {
  ipcMain.handle('setup:load', () => ({
    hostname: os.hostname(),
    server: REMOTE_SERVER,
    version: pkg.version,
    commit: require('./src/version').info.commit,
    ndi: ndi ? ndi.status() : null,
  }));

  ipcMain.handle('setup:test', async (_event, url) => {
    const target = String(url || '').trim().replace(/\/+$/, '');
    if (!target) return { ok: false, error: 'Enter a server address' };
    try {
      const res = await fetch(`${target}/api/state`, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) return { ok: false, error: `the server answered ${res.status}` };
      const data = await res.json();
      return {
        ok: true,
        version: (data.build && data.build.version) || data.version,
        commit: (data.build && data.build.commit) || null,
        live: (data.counts && data.counts.live) || 0,
      };
    } catch (err) {
      // A bad address, a stopped container and a blocked port all land here,
      // so pass the real message through rather than inventing one.
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('setup:save', (_event, data) => {
    const server = data && data.mode === 'sender'
      ? String(data.server || '').trim().replace(/\/+$/, '')
      : '';
    writeJson(SENDER_FILE, server ? { server } : {});
    return { ok: true };
  });

  ipcMain.handle('setup:restart', () => {
    // Drop any one-off flags so the restart uses what was just saved.
    const args = process.argv.slice(1)
      .filter((a) => !a.startsWith('--server=') && a !== '--local');
    app.relaunch({ args });
    app.exit(0);
  });

  ipcMain.handle('setup:openAdmin', () => {
    if (adminWindow && !adminWindow.isDestroyed()) adminWindow.focus();
    else createAdminWindow();
  });

  ipcMain.handle('setup:close', () => {
    if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
  });

  // Asked for by the admin page when it is running inside the app.
  ipcMain.handle('shell:info', () => {
    const status = ndi ? ndi.status() : null;
    return {
      hostname: os.hostname(),
      server: REMOTE_SERVER || null,
      role: REMOTE_SERVER ? 'sender' : 'host',
      ndiAvailable: Boolean(status && status.available),
      ndiError: status ? status.error : null,
    };
  });

  ipcMain.handle('shell:openSetup', () => {
    createSetupWindow();
  });
}

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
    // The title says which server it is driving, so a booth machine pointed
    // at the wrong one is obvious at a glance.
    title: REMOTE_SERVER
      ? `${pkg.productName} - NDI sender for ${REMOTE_SERVER}`
      : `${pkg.productName} - Admin`,
    autoHideMenuBar: false,
    webPreferences: {
      // Lets the admin page offer this machine's own settings when it is
      // running in the app rather than a browser.
      preload: path.join(__dirname, 'preload-admin.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Has to be reapplied per navigation, not just once at startup.
  adminWindow.webContents.on('did-finish-load', () => {
    adminWindow.webContents.setZoomFactor(uiScale);
  });

  // The page's own <title> would otherwise replace ours, losing the note
  // about which server this machine is driving.
  adminWindow.on('page-title-updated', (event, title) => {
    event.preventDefault();
    adminWindow.setTitle(REMOTE_SERVER ? `${title} - sending for ${REMOTE_SERVER}` : title);
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
        { type: 'separator' },
        {
          label: 'Setup - server address and role...',
          accelerator: 'CmdOrCtrl+,',
          click: () => createSetupWindow(),
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
            const detail = [];

            if (REMOTE_SERVER) {
              // Sender mode: there is no local server to list addresses for.
              detail.push(
                'This machine is an NDI sender.',
                '',
                `Server:   ${REMOTE_SERVER}`,
                `Submit:   ${REMOTE_SERVER}/submit`,
                `Admin:    ${REMOTE_SERVER}/admin`,
                `Display:  ${REMOTE_SERVER}/display`,
                '',
                'Start with --local to host the app on this machine instead.',
              );
            } else {
              const c = config.get();
              const urls = server ? server.urls() : [baseUrl];
              detail.push(
                'This machine is hosting the app.',
                '',
                ...urls.flatMap((url) => [
                  `Submit:   ${url}/submit`,
                  `Admin:    ${url}/admin`,
                  `Display:  ${url}/display`,
                  '',
                ]),
                `Admin host-only:  ${c.adminLocalhostOnly ? 'yes' : 'no'}`,
              );
            }

            const status = ndi ? ndi.status() : null;
            detail.push('', '--- NDI ---');
            if (!status) detail.push('Sender not started.');
            else if (!status.available) detail.push(`Unavailable: ${status.error || 'no NDI runtime'}`);
            else if (status.running) {
              detail.push(
                `On air as:  ${status.fullName}`,
                `Resolution: ${status.actualSize || 'starting'}`,
                `Receivers:  ${status.connections}`,
              );
            } else detail.push('Ready, not sending.');

            dialog.showMessageBox(adminWindow || undefined, {
              type: 'info',
              title: 'Connection Info',
              message: `${pkg.productName} v${pkg.version}`,
              detail: detail.join('\n'),
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

  registerSetupHandlers();
  buildMenu();
  createAdminWindow();

  // Opened on request, or on a first run: nothing configured and nothing
  // remembered means nobody has said what this machine is for yet.
  if (process.argv.slice(1).includes('--setup') || (!REMOTE_SERVER && !firstRunAnswered())) {
    createSetupWindow();
  }

  screen.on('display-added', buildMenu);
  screen.on('display-removed', buildMenu);
});

// A machine that has been through setup once has a sender.json, even if it
// records "host locally" as an empty object.
function firstRunAnswered() {
  try {
    return fsExists(SENDER_FILE);
  } catch {
    return true;
  }
}

app.on('window-all-closed', () => {
  app.quit();
});

// Tearing the sender down properly removes the source from the network
// rather than leaving receivers staring at a dead feed.
app.on('before-quit', () => {
  if (ndi) ndi.stop();
  if (server) server.close();
});
