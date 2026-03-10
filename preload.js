/**
 * @name         Startup Sentry
 * @license      BSL 1.1 — See LICENSE.md
 * @description  Preload script — exposes safe IPC bridge to the renderer process
 * @author       Cloud Nimbus LLC
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sentry', {
  getStartupItems: () => ipcRenderer.invoke('get-startup-items'),
  enableItem:  (item)          => ipcRenderer.invoke('enable-item', item),
  disableItem: (item)          => ipcRenderer.invoke('disable-item', item),
  addItem:     (name, command) => ipcRenderer.invoke('add-item', name, command),
  removeItem:  (item)          => ipcRenderer.invoke('remove-item', item),
  openLocation:(command)       => ipcRenderer.invoke('open-location', command),
  getSettings: ()              => ipcRenderer.invoke('get-settings'),
  saveSettings:(settings)      => ipcRenderer.invoke('save-settings', settings),
  checkAdmin:  ()              => ipcRenderer.invoke('check-admin'),
  selfElevate: ()              => ipcRenderer.invoke('self-elevate')
});
