const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pulse', {
  onStats: (cb) => ipcRenderer.on('stats-update', (_e, data) => cb(data)),
  onStatsError: (cb) => ipcRenderer.on('stats-error', (_e, msg) => cb(msg)),
  onWindowState: (cb) => ipcRenderer.on('window-state', (_e, state) => cb(state)),
  getSpecs: () => ipcRenderer.invoke('specs:get'),
  killProcess: (pid) => ipcRenderer.invoke('proc:kill', pid),
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),
  platform: process.platform,
});
