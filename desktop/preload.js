/**
 * The only surface the web app sees of the desktop shell.
 *
 * Anything here is callable as window.rotorops.* from the renderer; nothing
 * else from Node crosses the boundary.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rotorops', {
  isDesktop: true,

  /** Has this install already got a device token? */
  hasToken: () => ipcRenderer.invoke('bridge:hasToken'),

  /** Hand the main process a pairing code to redeem. */
  provision: (code) => ipcRenderer.invoke('bridge:provision', code),

  status: () => ipcRenderer.invoke('bridge:status'),
  recentLog: () => ipcRenderer.invoke('bridge:log'),
  restart: () => ipcRenderer.invoke('bridge:restart'),

  onStatus: (fn) => {
    const handler = (_e, status) => fn(status);
    ipcRenderer.on('bridge:status', handler);
    return () => ipcRenderer.off('bridge:status', handler);
  },
  onEvent: (fn) => {
    const handler = (_e, event) => fn(event);
    ipcRenderer.on('bridge:event', handler);
    return () => ipcRenderer.off('bridge:event', handler);
  },
});
