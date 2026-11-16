const { contextBridge, ipcRenderer } = require('electron');

const invoke = (name) => (...args) => ipcRenderer.invoke(name, ...args);
const subscribe = (name) => (fn) => ipcRenderer.on(name, (_event, data) => fn(data));

contextBridge.exposeInMainWorld('alicecode', {
  state: invoke('app:state'),
  createProject: invoke('project:create'),
  chooseFolder: invoke('project:choose'),
  openProject: invoke('project:open'),
  revealProject: invoke('project:reveal'),
  inspectProject: invoke('project:inspect'),
  readFile: invoke('project:read'),
  readDiff: invoke('project:diff'),
  newChat: invoke('chat:new'),
  selectChat: invoke('chat:select'),
  send: invoke('chat:send'),
  stop: invoke('chat:stop'),
  permission: invoke('chat:permission'),
  saveKey: invoke('settings:save'),
  checkUpdates: invoke('updates:check'),
  installUpdate: invoke('updates:install'),
  onState: subscribe('app:state'),
  onMessage: subscribe('chat:message'),
  onUpdate: subscribe('app:update'),
});
