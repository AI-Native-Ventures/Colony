const { contextBridge, ipcRenderer } = require("electron");

const listeners = new Map();
ipcRenderer.on("colony:event", (_event, message) => {
  for (const callback of listeners.values()) callback(message);
});
let sequence = 0;
contextBridge.exposeInMainWorld("colonyDesktop", {
  request: async (type, payload) => {
    const reply = await ipcRenderer.invoke("colony:request", type, payload);
    if (!reply.ok) throw reply.error;
    return reply.result;
  },
  subscribe: (callback) => {
    const id = ++sequence;
    listeners.set(id, callback);
    return () => listeners.delete(id);
  },
});
