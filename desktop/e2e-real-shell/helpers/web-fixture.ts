import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export type WebFixture = {
  url: string;
  loaded: () => boolean;
  close: () => Promise<void>;
};

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Colony CDP Loopback</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #09111f;
        color: #e6edf7;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body::before {
        content: "";
        position: fixed;
        inset: 0 auto auto 0;
        width: 64px;
        height: 64px;
        background: #22c55e;
      }
      main {
        width: min(760px, calc(100vw - 64px));
        border: 2px solid #263449;
        border-radius: 18px;
        background: #111c2d;
        padding: 42px;
        box-shadow: 0 20px 60px rgb(0 0 0 / 30%);
      }
      .eyebrow {
        color: #6ee7b7;
        font-weight: 800;
        letter-spacing: .16em;
      }
      h1 { margin: 12px 0; font-size: 46px; }
      p { margin: 0; color: #9fb0c6; font-size: 20px; }
    </style>
  </head>
  <body>
    <main>
      <div class="eyebrow">COLONY CDP LOOPBACK</div>
      <h1>Real packaged screencast</h1>
      <p>This page arrived through native Tauri IPC and Page.startScreencast.</p>
    </main>
  </body>
</html>`;

function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    });
    response.end(PAGE);
    return;
  }
  response.writeHead(404, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
  });
  response.end("not found");
}

/** Start the loopback page used by the packaged IPC/frame proof. */
export async function startWebFixture(): Promise<WebFixture> {
  let loaded = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/") loaded = true;
    handleRequest(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}/`,
    loaded: () => loaded,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
