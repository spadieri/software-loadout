const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  downloadSoftware: (software) => ipcRenderer.invoke('download-software', software),
  checkInstalled: (softwareList) => ipcRenderer.invoke('check-installed', softwareList),
  getCachedInstalled: () => ipcRenderer.invoke('get-cached-installed'),
  refreshInstalled: () => ipcRenderer.invoke('refresh-installed'),
  onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (_event, data) => callback(data)),
  getDownloadsPath: () => ipcRenderer.invoke('get-downloads-path'),
  openDownloadsFolder: () => ipcRenderer.invoke('open-downloads-folder'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  groups: {
    getAll: () => ipcRenderer.invoke('groups:get-all'),
    save: (group) => ipcRenderer.invoke('groups:save', group),
    delete: (id) => ipcRenderer.invoke('groups:delete', id),
    export: (group) => ipcRenderer.invoke('groups:export', group),
    import: () => ipcRenderer.invoke('groups:import')
  },
  queue: {
    start: (queueId, items) => ipcRenderer.invoke('queue:start', { queueId, items }),
    cancel: () => ipcRenderer.invoke('queue:cancel'),
    onUpdate: (callback) => ipcRenderer.on('queue:item-state', (_event, data) => callback(data))
  },
  updates: {
    getState: () => ipcRenderer.invoke('update:get-state'),
    startDownload: () => ipcRenderer.invoke('update:start-download'),
    quitAndInstall: () => ipcRenderer.invoke('update:quit-and-install'),
    openReleasePage: () => ipcRenderer.invoke('update:open-external'),
    onState: (callback) => ipcRenderer.on('update:state', (_event, state) => callback(state))
  }
});
