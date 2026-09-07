const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("colonyBrowser", {
  command: (command) => ipcRenderer.invoke("browser:command", command),
  subscribe: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("browser:state", listener);
    return () => ipcRenderer.removeListener("browser:state", listener);
  },
});
