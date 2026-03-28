/**
 * Stoplight – Electron Main Process
 * Manages the login window and the transparent floating widget window.
 */

const {
  app, BrowserWindow, ipcMain, screen, nativeTheme, Menu
} = require('electron');
const path = require('path');

let loginWindow  = null;
let widgetWindow = null;
const isDev = process.argv.includes('--dev');

// ── Login window ──────────────────────────────────────────────────
function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width:     420,
    height:    680,
    resizable: true,
    center:    true,
    frame:     true,
    title:     'Stoplight – Sign In',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false
    }
  });

  loginWindow.loadFile(path.join(__dirname, 'src', 'login.html'));
  loginWindow.setMenuBarVisibility(false);

  if (isDev) loginWindow.webContents.openDevTools({ mode: 'detach' });

  loginWindow.on('closed', () => { loginWindow = null; });
}

// ── Widget window (transparent, floating) ────────────────────────
function createWidgetWindow(sessionData) {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  widgetWindow = new BrowserWindow({
    width:       180,
    height:      400,
    x:           width - 210,
    y:           80,
    transparent: true,
    frame:       false,
    hasShadow:   false,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable:   false,   // Resize handled manually via IPC drag
    movable:     false,   // Move handled manually via IPC drag
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false
    }
  });

  // Keep it floating above full-screen apps on Mac
  widgetWindow.setAlwaysOnTop(true, 'floating');
  widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  widgetWindow.loadFile(path.join(__dirname, 'src', 'widget.html'));
  widgetWindow.setMenuBarVisibility(false);

  if (isDev) widgetWindow.webContents.openDevTools({ mode: 'detach' });

  widgetWindow.webContents.once('did-finish-load', () => {
    widgetWindow.webContents.send('session-data', sessionData);
  });

  widgetWindow.on('closed', () => { widgetWindow = null; });
}

// ── IPC handlers ──────────────────────────────────────────────────

// Login succeeded → open widget, close login
ipcMain.on('login-success', (event, sessionData) => {
  createWidgetWindow(sessionData);
  if (loginWindow) {
    // Small delay so widget is ready before login disappears
    setTimeout(() => {
      if (loginWindow) loginWindow.close();
    }, 300);
  }
});

// Drag the widget (renderer sends absolute screen coords)
ipcMain.on('widget-drag', (event, { x, y }) => {
  if (widgetWindow) {
    widgetWindow.setPosition(Math.round(x), Math.round(y));
  }
});

// Resize the widget from the drag handle
ipcMain.on('widget-resize', (event, { width, height }) => {
  if (widgetWindow) {
    const w = Math.max(130, Math.min(480, Math.round(width)));
    const h = Math.max(280, Math.min(900, Math.round(height)));
    widgetWindow.setSize(w, h);
  }
});

// Sign out → close widget, reopen login
ipcMain.on('sign-out', () => {
  if (widgetWindow) { widgetWindow.close(); widgetWindow = null; }
  createLoginWindow();
});

// Quit the app entirely
ipcMain.on('quit-app', () => {
  app.quit();
});

// Get current widget bounds (for resize calculations)
ipcMain.handle('get-widget-bounds', () => {
  return widgetWindow ? widgetWindow.getBounds() : null;
});

// ── App lifecycle ─────────────────────────────────────────────────
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  nativeTheme.themeSource = 'dark';
  createLoginWindow();

  app.on('activate', () => {
    if (!loginWindow && !widgetWindow) createLoginWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
