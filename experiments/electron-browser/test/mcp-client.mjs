import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export function connectMcp(grantFile) {
  const child = spawn(
    process.env.COLONY_NODE_BINARY,
    [fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)), grantFile],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const pending = new Map();
  let id = 0;
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const message = JSON.parse(line);
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      message.error
        ? entry.reject(new Error(message.error.message))
        : entry.resolve(message.result);
    } catch (error) {
      for (const entry of pending.values()) entry.reject(error);
    }
  });
  child.on("exit", () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`MCP exited: ${stderr}`));
    }
    pending.clear();
  });
  return {
    call(method, params = {}) {
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("MCP timed out"));
        }, 15000);
        pending.set(requestId, { resolve, reject, timer });
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`,
        );
      });
    },
    async tool(name, args = {}) {
      const result = await this.call("tools/call", { name, arguments: args });
      if (result.isError) throw new Error(result.content[0].text);
      return name === "browser_screenshot"
        ? result.content[0].data
        : JSON.parse(result.content[0].text);
    },
    close() {
      child.stdin.end();
      child.kill("SIGTERM");
    },
  };
}
