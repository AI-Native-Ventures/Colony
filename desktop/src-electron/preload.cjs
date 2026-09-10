const { contextBridge, ipcRenderer } = require("electron");

const listeners = new Map();
ipcRenderer.on("colony:event", (_event, message) => {
  for (const callback of listeners.values()) callback(message);
});
let sequence = 0;
const terminalDataListeners = new Map();
const terminalExitListeners = new Map();
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
  terminal: {
    start: async (payload) => {
      const reply = await ipcRenderer.invoke(
        "colony:terminal",
        "start",
        payload,
      );
      if (!reply.ok) throw reply.error;
      return reply.result;
    },
    write: async (payload) => {
      const reply = await ipcRenderer.invoke(
        "colony:terminal",
        "write",
        payload,
      );
      if (!reply.ok) throw reply.error;
      return reply.result;
    },
    resize: async (payload) => {
      const reply = await ipcRenderer.invoke(
        "colony:terminal",
        "resize",
        payload,
      );
      if (!reply.ok) throw reply.error;
      return reply.result;
    },
    ack: async (payload) => {
      const reply = await ipcRenderer.invoke("colony:terminal", "ack", payload);
      if (!reply.ok) throw reply.error;
      return reply.result;
    },
    close: async (payload) => {
      const reply = await ipcRenderer.invoke(
        "colony:terminal",
        "close",
        payload,
      );
      if (!reply.ok) throw reply.error;
      return reply.result;
    },
    closeAll: async () => {
      const reply = await ipcRenderer.invoke(
        "colony:terminal",
        "closeAll",
        null,
      );
      if (!reply.ok) throw reply.error;
      return reply.result;
    },
    list: async () => {
      const reply = await ipcRenderer.invoke("colony:terminal", "list", null);
      if (!reply.ok) throw reply.error;
      return reply.result;
    },
    attach: async (payload) => {
      const reply = await ipcRenderer.invoke(
        "colony:terminal",
        "attach",
        payload,
      );
      if (!reply.ok) throw reply.error;
      return reply.result;
    },
    onData: (callback) => {
      const id = ++sequence;
      const listener = (_event, sessionId, chunk) => callback(sessionId, chunk);
      terminalDataListeners.set(id, listener);
      ipcRenderer.on("colony:terminal:data", listener);
      return () => {
        terminalDataListeners.delete(id);
        ipcRenderer.removeListener("colony:terminal:data", listener);
      };
    },
    onExit: (callback) => {
      const id = ++sequence;
      const listener = (_event, sessionId, info) => callback(sessionId, info);
      terminalExitListeners.set(id, listener);
      ipcRenderer.on("colony:terminal:exit", listener);
      return () => {
        terminalExitListeners.delete(id);
        ipcRenderer.removeListener("colony:terminal:exit", listener);
      };
    },
  },
});
