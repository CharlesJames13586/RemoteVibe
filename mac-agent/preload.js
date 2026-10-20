/**
 * Preload script — exposes a minimal, explicit API from main → renderer.
 * contextIsolation is on, so the renderer cannot touch Node/Electron
 * internals directly; everything goes through this bridge.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentApi', {
  checkPermissions: () => ipcRenderer.invoke('check-permissions'),
  openScreenRecordingSettings: () => ipcRenderer.invoke('open-screen-recording-settings'),
  openAccessibilitySettings: () => ipcRenderer.invoke('open-accessibility-settings'),
  requestAccessibility: () => ipcRenderer.invoke('request-accessibility'),
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  getScreenSize: (displayId) => ipcRenderer.invoke('get-screen-size', displayId),
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  setActiveDisplay: (displayId) => ipcRenderer.invoke('set-active-display', displayId),
  getSignalUrl: () => ipcRenderer.invoke('get-signal-url'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (patch) => ipcRenderer.invoke('set-config', patch),
  injectInput: (data) => ipcRenderer.send('inject-input', data),
  // Trusted-device tokens (plan.md §4 "device auto-reconnect")
  issueDeviceToken: (deviceLabel) => ipcRenderer.invoke('issue-device-token', deviceLabel),
  validateDeviceToken: (rawToken) => ipcRenderer.invoke('validate-device-token', rawToken),
  listDevices: () => ipcRenderer.invoke('list-devices'),
  revokeDevice: (id) => ipcRenderer.invoke('revoke-device', id),
  revokeAllDevices: () => ipcRenderer.invoke('revoke-all-devices'),
  // VNC relay bridge (plan.md M5 lock-screen control)
  vncBridgeStart: () => ipcRenderer.invoke('vnc-bridge-start'),
  vncBridgeStop: () => ipcRenderer.invoke('vnc-bridge-stop'),
  onVncBridgeStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('vnc-bridge-status', handler);
    return () => ipcRenderer.removeListener('vnc-bridge-status', handler);
  },
});
