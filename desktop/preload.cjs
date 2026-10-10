'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const request = async (action, payload = {}) => {
  const response = await ipcRenderer.invoke('fde:request', { action, payload });
  if (!response.ok) throw new Error(response.error || '操作失败，请重试');
  return response.value;
};
contextBridge.exposeInMainWorld('fde', {
  request,
  windowAction: (action, payload = {}) => request(`window:${action}`, payload),
  getPathForFile: file => webUtils.getPathForFile(file),
  onChange: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('fde:changed', listener);
    return () => ipcRenderer.removeListener('fde:changed', listener);
  }
});
