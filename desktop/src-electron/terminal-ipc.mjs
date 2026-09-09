export function registerTerminalIpc({ ipcMain, webContents, service }) {
  const handler = async (event, op, payload) => {
    if (!event?.sender) {
      return { ok: false, error: "Invalid event" };
    }
    if (event.sender.id !== webContents.id) {
      return { ok: false, error: "Foreign sender" };
    }
    try {
      let result;
      switch (op) {
        case "start":
          result = service.start(payload);
          break;
        case "write": {
          const sid =
            payload && typeof payload === "object"
              ? payload.sessionId
              : payload;
          const data =
            payload && typeof payload === "object" ? payload.data : payload;
          service.write(sid, data);
          result = undefined;
          break;
        }
        case "resize": {
          if (
            payload &&
            typeof payload === "object" &&
            payload.sessionId !== undefined
          ) {
            service.resize(payload.sessionId, payload.cols, payload.rows);
          } else {
            service.resize(payload, undefined, undefined);
          }
          result = undefined;
          break;
        }
        case "ack": {
          if (
            payload &&
            typeof payload === "object" &&
            payload.sessionId !== undefined
          ) {
            service.ack(payload.sessionId, payload.bytes);
          } else {
            service.ack(payload, undefined);
          }
          result = undefined;
          break;
        }
        case "close": {
          const sid = payload?.sessionId ?? payload;
          result = await service.close(sid);
          break;
        }
        case "closeAll": {
          result = await service.closeAll();
          break;
        }
        case "list":
          result = service.list();
          break;
        case "attach": {
          const sid = payload?.sessionId ?? payload;
          const replayResult = service.attach(sid);
          if (replayResult?.replay && Buffer.isBuffer(replayResult.replay)) {
            replayResult.replay = new Uint8Array(replayResult.replay);
          }
          result = replayResult;
          break;
        }
        default:
          return { ok: false, error: `Unknown terminal operation: ${op}` };
      }
      return { ok: true, result };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  ipcMain.handle("colony:terminal", handler);

  const dataHandler = (originalOnData) => (sessionId, chunk) => {
    originalOnData?.(sessionId, chunk);
    if (!webContents.isDestroyed()) {
      webContents.send("colony:terminal:data", sessionId, chunk);
    }
  };

  const exitHandler = (originalOnExit) => (sessionId, info) => {
    originalOnExit?.(sessionId, info);
    if (!webContents.isDestroyed()) {
      webContents.send("colony:terminal:exit", sessionId, info);
    }
  };

  const originalOnData = service.onData
    ? service.onData.bind(service)
    : undefined;
  const originalOnExit = service.onExit
    ? service.onExit.bind(service)
    : undefined;

  service.onData = dataHandler(originalOnData);
  service.onExit = exitHandler(originalOnExit);

  return {
    dispose() {
      ipcMain.removeHandler("colony:terminal");
      if (originalOnData) {
        service.onData = originalOnData;
      } else {
        service.onData = () => {};
      }
      if (originalOnExit) {
        service.onExit = originalOnExit;
      } else {
        service.onExit = () => {};
      }
    },
  };
}
