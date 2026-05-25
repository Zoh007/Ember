const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getBriefing: () => ipcRenderer.invoke('get-briefing'),
  getActivities: () => ipcRenderer.invoke('get-activities'),
  deleteAllData: () => ipcRenderer.invoke('delete-all-data'),
  onLiveJson: (cb) => ipcRenderer.on('live-json', (event, payload) => cb(payload)),
});
