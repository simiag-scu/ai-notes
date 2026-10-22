const { contextBridge, ipcRenderer } = require('electron');
const invoke = (channel, data) => ipcRenderer.invoke(`shiye:${channel}`, data);
contextBridge.exposeInMainWorld('shiyeDesktop', {
  info: () => invoke('info'),
  chooseVault: () => invoke('choose-vault'),
  chooseLegacy: () => invoke('choose-legacy'),
  start: options => invoke('start', { importLegacy: options?.importLegacy === true }),
  manage: () => invoke('manage'),
  showData: () => invoke('show-data'),
  showVault: () => invoke('show-vault'),
  installPlugin: () => invoke('install-plugin'),
  setDirty: value => ipcRenderer.send('shiye:dirty', value === true),
  onCommand: callback => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('shiye:command', listener);
    return () => ipcRenderer.removeListener('shiye:command', listener);
  }
});
