'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dsh', {
  kernel: {
    list: () => ipcRenderer.invoke('kernel:list'),
    registry: (limitKBps) => ipcRenderer.invoke('kernel:registry', limitKBps),
    install: (v) => ipcRenderer.invoke('kernel:install', v),
    switchTo: (v) => ipcRenderer.invoke('kernel:switch', v),
    rollbackCandidates: () => ipcRenderer.invoke('kernel:rollbackCandidates'),
    delete: (v) => ipcRenderer.invoke('kernel:delete', v),
    start: () => ipcRenderer.invoke('kernel:start'),
    restart: () => ipcRenderer.invoke('kernel:restart'),
    webUrl: () => ipcRenderer.invoke('kernel:webUrl'),
  },
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (patch) => ipcRenderer.invoke('config:set', patch),
  },
  settings: {
    relocate: (kind, newPath) => ipcRenderer.invoke('settings:relocate', kind, newPath),
    pickDir: () => ipcRenderer.invoke('settings:pickDir'),
  },
  shell: { detect: () => ipcRenderer.invoke('shell:detect') },
  terminal: {
    create: (o) => ipcRenderer.invoke('terminal:create', o),
    input: (id, data) => ipcRenderer.send('terminal:input', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('terminal:resize', { id, cols, rows }),
    dispose: (id) => ipcRenderer.send('terminal:dispose', { id }),
  },
  openDataPath: (p) => ipcRenderer.invoke('app:openPath', p),
  plugins: {
    installed: (profile) => ipcRenderer.invoke('plugins:installed', profile),
    catalog: (limitKBps) => ipcRenderer.invoke('plugins:catalog', limitKBps),
    add: (spec, profile, limitKBps) => ipcRenderer.invoke('plugins:add', spec, profile, limitKBps),
    remove: (name, profile) => ipcRenderer.invoke('plugins:remove', name, profile),
    catalogAdd: (name, desc) => ipcRenderer.invoke('plugins:catalogAdd', name, desc),
    catalogRemove: (name) => ipcRenderer.invoke('plugins:catalogRemove', name),
  },
  on: (ch, cb) => {
    const listener = (_e, ...args) => cb(...args);
    ipcRenderer.on(ch, listener);
    return () => ipcRenderer.removeListener(ch, listener);
  },
});
