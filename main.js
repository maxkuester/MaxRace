// MaxRace desktop app: one window, everything inside.
// The built-in server opens the NMEA source (TCP/UDP) and serves the dashboard,
// so the separate bridge is no longer needed.
"use strict";
const { app, BrowserWindow, Menu, shell, dialog, globalShortcut } = require("electron");
const path = require("path");
const { startServer } = require("./server");

let win = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

  app.whenReady().then(async () => {
    let srv;
    try {
      srv = await startServer({ root: __dirname, port: 8765, log: (m) => console.log("[maxrace] " + m) });
    } catch (e) {
      dialog.showErrorBox("MaxRace", "Could not start the data server: " + e.message);
      app.quit();
      return;
    }

    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
      { label: "View", submenu: [
        { label: "Full screen", accelerator: process.platform === "darwin" ? "Ctrl+Cmd+F" : "F11", click: () => win && win.setFullScreen(!win.isFullScreen()) },
        { role: "reload" },
        { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
      ]},
      { label: "Help", submenu: [
        { label: "Open on a tablet or phone…", click: () => {
          const urls = srv.addresses.map((a) => `http://${a}:${srv.port}`).join("\n") || "No network found. Connect this computer to the boat network first.";
          dialog.showMessageBox(win, { type: "info", title: "MaxRace on other devices", message: "On a tablet or phone on the same network, open:", detail: urls });
        }},
        { role: "toggleDevTools" },
      ]},
    ]));

    win = new BrowserWindow({
      width: 1280, height: 800, minWidth: 360, minHeight: 480,
      backgroundColor: "#000000", title: "MaxRace", autoHideMenuBar: true,
      icon: path.join(__dirname, "build", "icon.png"),
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.loadURL(`http://127.0.0.1:${srv.port}/`);
    win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
    win.on("closed", () => { win = null; });
    // Esc leaves full screen
    win.webContents.on("before-input-event", (e, input) => {
      if (input.type === "keyDown" && input.key === "Escape" && win.isFullScreen()) win.setFullScreen(false);
    });
  });

  app.on("window-all-closed", () => app.quit());
}
