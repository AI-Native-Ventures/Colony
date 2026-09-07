import net from "node:net";
import { chmod, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const MAX_REQUEST = 64 * 1024;

export async function startBroker(socketPath, handle) {
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(15000, () => socket.destroy());
    let buffer = "";
    let accepted = false;
    socket.on("data", async (chunk) => {
      if (accepted) return;
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_REQUEST) return socket.destroy();
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      accepted = true;
      try {
        const request = JSON.parse(buffer.slice(0, end));
        const result = await handle(request);
        if (!socket.destroyed) socket.end(`${JSON.stringify({ result })}\n`);
      } catch (error) {
        if (!socket.destroyed)
          socket.end(`${JSON.stringify({ error: error.message })}\n`);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(socketPath, { force: true });
  };
}

export function requestBroker(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.setTimeout(12000, () =>
      socket.destroy(new Error("Browser request timed out")),
    );
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024)
        socket.destroy(new Error("Browser response is too large"));
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        const response = JSON.parse(buffer);
        if (response.error) reject(new Error(response.error));
        else resolve(response.result);
      } catch (error) {
        reject(error);
      }
    });
  });
}
