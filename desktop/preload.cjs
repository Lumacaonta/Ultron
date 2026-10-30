const { contextBridge, ipcRenderer } = require('electron')

/*
 * The renderer never receives Node, filesystem, shell, or generic IPC access.
 * It can request only the two native dialogs that the Model Deck needs. The
 * main process independently verifies that every request originates from
 * ULTRON's private renderer origin before showing a dialog.
 */
contextBridge.exposeInMainWorld('ultronDesktop', {
  // The renderer may synchronize and restore its current local session. The
  // main process keeps any durable copy encrypted with OS credential storage;
  // this narrow bridge never exposes raw IPC or filesystem access.
  syncSessionToken: token => ipcRenderer.invoke(
    'ultron:sync-session-token',
    typeof token === 'string' ? token : ''
  ),
  restoreSessionToken: () => ipcRenderer.invoke('ultron:restore-session-token'),
  clearSessionToken: () => ipcRenderer.invoke('ultron:clear-session-token'),
  selectModel: () => ipcRenderer.invoke('ultron:select-model'),
  selectExternalApp: label => ipcRenderer.invoke(
    'ultron:select-external-app',
    typeof label === 'string' ? label : ''
  ),
  selectSkillApp: () => ipcRenderer.invoke('ultron:select-skill-app'),
})
