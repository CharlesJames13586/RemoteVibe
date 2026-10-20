/**
 * Mac Agent — Electron main process
 *
 * Responsibilities:
 *  - Create a small always-on-top window showing the current PIN
 *  - Check/request macOS Screen Recording + Accessibility permissions
 *  - Bridge the renderer (which does WebRTC + desktopCapturer) with the
 *    input-inject module (which needs Node/native access, so it must run
 *    in the main process, not the sandboxed renderer)
 */

const { app, BrowserWindow, ipcMain, systemPreferences, shell, desktopCapturer, screen, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { injectEvent } = require('./input-inject');
const deviceStore = require('./device-store');
const { VncBridge } = require('./vnc-bridge');

// macOS 13+ defaults desktopCapturer to the newer ScreenCaptureKit backend
// (--enable-features=ScreenCaptureKitPickerScreen,ScreenCaptureKitStreamPickerSonoma,
// visible in `ps`). It has a reproducible bug where a SECOND capture
// session started in the same renderer (e.g. after a viewer disconnects
// and reconnects, triggering a fresh getUserMedia() call) silently
// produces a black video track — connection/DataChannel succeed, but no
// real frames ever arrive. Disabling it falls back to the older, more
// battle-tested CGDisplayStream-based capture path, which doesn't have
// this bug. Must be called before app.whenReady().
app.commandLine.appendSwitch('disable-features', 'ScreenCaptureKitPickerScreen,ScreenCaptureKitStreamPickerSonoma');

// ─── Persistent config (survives packaging — stored in userData, not asar) ───
// In dev: falls back to SIGNAL_URL env var. In a packaged .app there are no
// env vars, so the user sets the URL once via the UI and it's written here.
function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
  } catch {
    return {};
  }
}

function saveConfig(patch) {
  const current = loadConfig();
  const next = { ...current, ...patch };
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify(next, null, 2));
  return next;
}

function getSignalUrl() {
  const cfg = loadConfig();
  return cfg.signalUrl || process.env.SIGNAL_URL || 'ws://localhost:8080';
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 360,
    height: 620,
    resizable: false,
    title: 'Remote Control Agent',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Required so the renderer can call navigator.mediaDevices.getUserMedia
      // with chromeMediaSource:'desktop' against a specific desktopCapturer source.
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Pipe renderer console.log output to the terminal stdout — makes it
  // possible to debug PIN/connection/datachannel state headlessly (no
  // screenshots or Accessibility-API UI scraping needed).
  mainWindow.webContents.on('console-message', (_event, _level, message) => {
    console.log(`[renderer] ${message}`);
  });
}

// ─── macOS permission checks ─────────────────────────────────────────────────

function checkPermissions() {
  const screen = systemPreferences.getMediaAccessStatus
    ? systemPreferences.getMediaAccessStatus('screen')
    : 'unknown';
  const accessibility = systemPreferences.isTrustedAccessibilityClient(false);
  return { screen, accessibility };
}

ipcMain.handle('check-permissions', () => checkPermissions());

ipcMain.handle('open-screen-recording-settings', () => {
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
});

ipcMain.handle('open-accessibility-settings', () => {
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
});

ipcMain.handle('request-accessibility', () => {
  // Passing true triggers the system prompt if not yet granted
  return systemPreferences.isTrustedAccessibilityClient(true);
});

// ─── desktopCapturer: list available screens for the renderer to pick from ──

ipcMain.handle('get-screen-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 300, height: 180 } });
  // display_id links each capture source back to the matching Electron
  // Display object (see get-displays below) — needed so the renderer can
  // show a human-friendly label/arrangement and so main.js knows which
  // Display's bounds to use for mouse-coordinate mapping once this source
  // is selected (see set-active-display).
  return sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(), displayId: s.display_id }));
});

// All connected displays, in Electron's DIP (logical point) coordinate
// space — the SAME coordinate space nut.js's mouse/screen APIs use
// (verified empirically: nut.js screen.width()/height() on this machine
// returned 1728x1117, matching screen.getPrimaryDisplay().size exactly,
// i.e. DIP, not physical pixels). This lets us feed a Display's `bounds`
// (which includes its x/y offset in the shared virtual desktop) straight
// into nut.js's mouse.setPosition() for correct multi-monitor targeting,
// with zero unit conversion.
ipcMain.handle('get-displays', () => {
  return screen.getAllDisplays().map(d => ({
    id: d.id,
    bounds: d.bounds, // { x, y, width, height } in DIP — includes this display's offset in the virtual desktop
    scaleFactor: d.scaleFactor || 1,
    isPrimary: d.id === screen.getPrimaryDisplay().id,
  }));
});

// Real screen pixel resolution (accounting for Retina scale factor) for a
// specific display — used by the renderer to request full-resolution
// desktop capture matching whichever display the user picked, instead of
// always assuming the primary display.
ipcMain.handle('get-screen-size', (_event, displayId) => {
  const display = displayId != null
    ? screen.getAllDisplays().find(d => d.id === displayId) || screen.getPrimaryDisplay()
    : screen.getPrimaryDisplay();
  const { width, height } = display.size;
  const scale = display.scaleFactor || 1;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
});

// ─── Active display tracking (multi-monitor support) ───────────────────────
// input-inject.js needs to know which display's `bounds` (DIP coordinates,
// including that display's x/y offset in the shared virtual desktop — see
// get-displays above) to use when converting the viewer's normalized 0..1
// coordinates into an absolute mouse position. Without this, mouse control
// silently only ever worked on whichever display happens to sit at
// (0,0) in the virtual desktop — nut.js has no concept of "which screen
// was captured", it only accepts one absolute virtual-desktop coordinate.
let activeDisplayBounds = null; // null = fall back to primary display, offset (0,0)

ipcMain.handle('set-active-display', (_event, displayId) => {
  const display = screen.getAllDisplays().find(d => d.id === displayId);
  activeDisplayBounds = display ? display.bounds : null;
  return activeDisplayBounds;
});

// ─── Config passthrough ───────────────────────────────────────────────────────

ipcMain.handle('get-signal-url', () => getSignalUrl());

ipcMain.handle('get-config', () => ({
  signalUrl: getSignalUrl(),
}));

ipcMain.handle('set-config', (_event, patch) => {
  saveConfig(patch);
  return { signalUrl: getSignalUrl() };
});

// ─── Input injection (mouse/keyboard events from the paired iPhone) ─────────
// Renderer forwards parsed DataChannel messages here via IPC since nut.js
// needs to run with full Node access (main process), not the sandboxed renderer.

ipcMain.on('inject-input', (_event, data) => {
  console.log('[main] inject-input received:', JSON.stringify(data));
  injectEvent(data, activeDisplayBounds).then(() => {
    console.log('[main] injectEvent succeeded for', data.type);
  }).catch(err => {
    console.error('[input-inject] failed:', err.message);
  });
});

// ─── Trusted-device tokens (plan.md §4, "device auto-reconnect") ───────────
// After a successful PIN pairing, the renderer calls `issue-device-token`
// to mint a long-lived token for that viewer. The renderer also needs to
// validate tokens presented by reconnecting viewers (relayed to us by the
// signaling server as a `verify-token` WS message — handled in renderer.js,
// which calls these same device-store functions via IPC since devices.json
// lives in the main process).

ipcMain.handle('issue-device-token', (_event, deviceLabel) => {
  const { rawToken, record } = deviceStore.issueToken(deviceLabel);
  console.log(`[device-store] issued token for "${record.deviceLabel}", expires ${new Date(record.expiresAt).toLocaleString()}`);
  return { rawToken, record };
});

ipcMain.handle('validate-device-token', (_event, rawToken) => {
  const record = deviceStore.validateToken(rawToken);
  if (record) {
    console.log(`[device-store] validated token for "${record.deviceLabel}"`);
    // Fire a system notification so the user has after-the-fact visibility
    // into passwordless reconnects, even though no manual confirmation is
    // required (per design decision: the user is physically away from the
    // Mac when reconnecting remotely, so a blocking prompt isn't viable).
    new Notification({
      title: 'Remote Control — Device Connected',
      body: `${record.deviceLabel} reconnected without a PIN (trusted device).`,
      silent: false,
    }).show();
  } else {
    console.log('[device-store] token validation failed (unknown/expired/revoked)');
  }
  return record; // null if invalid — renderer relays this back over the signaling channel
});

ipcMain.handle('list-devices', () => deviceStore.listDevices());

ipcMain.handle('revoke-device', (_event, id) => {
  deviceStore.revokeDevice(id);
  return deviceStore.listDevices();
});

ipcMain.handle('revoke-all-devices', () => {
  deviceStore.revokeAll();
  return deviceStore.listDevices();
});

// ─── VNC relay bridge (plan.md M5, "lock-screen control" dual-track) ────────
// Entirely separate channel from the WebRTC flow above — see vnc-bridge.js
// for why this exists (screensharingd is not subject to the lock-screen
// restrictions that block nut.js/desktopCapturer). Only one bridge runs at
// a time; starting a new one while another is active tears down the old
// one first so there's never more than one outbound relay connection.
let activeVncBridge = null;

ipcMain.handle('vnc-bridge-start', async (event) => {
  if (activeVncBridge) {
    activeVncBridge.stop();
    activeVncBridge = null;
  }
  const bridge = new VncBridge(getSignalUrl());
  activeVncBridge = bridge;
  bridge.onStatusChange = (status, detail) => {
    // Fire-and-forget push to the renderer so the UI can show live status
    // ("waiting for viewer", "bridging", etc.) without polling.
    if (!event.sender.isDestroyed()) {
      event.sender.send('vnc-bridge-status', { status, detail });
    }
  };
  try {
    const code = await bridge.start();
    return { ok: true, code };
  } catch (err) {
    activeVncBridge = null;
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('vnc-bridge-stop', () => {
  if (activeVncBridge) {
    activeVncBridge.stop();
    activeVncBridge = null;
  }
  return { ok: true };
});

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (activeVncBridge) {
    activeVncBridge.stop();
    activeVncBridge = null;
  }
});
