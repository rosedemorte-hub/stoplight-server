/**
 * Preload script — exposes a safe, limited API to renderer processes
 * via contextBridge. No direct Node/Electron APIs exposed.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Login → main process
  loginSuccess: (sessionData) => ipcRenderer.send('login-success', sessionData),

  // Widget drag (move window)
  dragWidget: (coords) => ipcRenderer.send('widget-drag', coords),

  // Widget resize
  resizeWidget: (dims) => ipcRenderer.send('widget-resize', dims),

  // Get current window bounds (for resize calc)
  getWidgetBounds: () => ipcRenderer.invoke('get-widget-bounds'),

  // Sign out
  signOut: () => ipcRenderer.send('sign-out'),

  // Quit the app entirely
  quitApp: () => ipcRenderer.send('quit-app'),

  // Receive session data after login
  onSessionData: (callback) => {
    ipcRenderer.on('session-data', (event, data) => callback(data));
  }
});
