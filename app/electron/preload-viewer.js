const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getBriefing: () => ipcRenderer.invoke('get-briefing'),
  getActivities: () => ipcRenderer.invoke('get-activities'),
});
