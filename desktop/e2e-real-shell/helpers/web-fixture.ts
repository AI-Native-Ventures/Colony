import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export type WebFixtureReceipts = {
  pointerEvents: number;
  actions: number;
  inputValues: string[];
  maxScrollY: number;
  targets: WebFixtureTargets | null;
  viewport: { width: number; height: number } | null;
  visualPass: boolean;
  pass: boolean;
};

export type WebFixturePoint = { x: number; y: number };

export type WebFixtureTargets = {
  input: WebFixturePoint;
  action: WebFixturePoint;
  scroll: WebFixturePoint;
};

export type WebFixture = {
  url: string;
  receipts: () => Readonly<WebFixtureReceipts>;
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
        background: #09111f;
        color: #e6edf7;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main { max-width: 980px; margin: 0 auto; padding: 42px; }
      .eyebrow { color: #6ee7b7; font-weight: 800; letter-spacing: .16em; }
      h1 { margin: 10px 0 24px; font-size: 46px; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
      .card {
        border: 2px solid #263449;
        border-radius: 18px;
        background: #111c2d;
        padding: 24px;
        box-shadow: 0 20px 60px rgb(0 0 0 / 30%);
      }
      label { display: block; margin-bottom: 10px; font-weight: 700; }
      input, button {
        width: 100%;
        border-radius: 10px;
        border: 2px solid #3b4b63;
        padding: 14px;
        font: inherit;
      }
      input { background: #08101d; color: #fff; }
      button {
        margin-top: 14px;
        background: #34d399;
        color: #062116;
        font-weight: 900;
        cursor: pointer;
      }
      #remote-status {
        display: grid;
        min-height: 126px;
        place-items: center;
        border-radius: 14px;
        background: #18263a;
        color: #fbbf24;
        font-size: 54px;
        font-weight: 950;
      }
      #remote-status.pass { background: #064e3b; color: #a7f3d0; }
      #scroll-region {
        height: 112px;
        margin-bottom: 18px;
        overflow: auto;
        border: 2px solid #3b4b63;
        border-radius: 12px;
        background: #08101d;
      }
      .scroll-content {
        display: grid;
        height: 900px;
        place-items: end center;
        padding: 28px;
        background: linear-gradient(#17243a, #312e81, #064e3b);
        font-weight: 800;
      }
      .hint { margin: 14px 0 0; color: #9fb0c6; }
    </style>
  </head>
  <body>
    <main>
      <div class="eyebrow">COLONY CDP LOOPBACK</div>
      <h1>Real screencast and input proof</h1>
      <section class="grid">
        <div class="card">
          <div id="scroll-region" tabindex="0">
            <div class="scroll-content">SCROLL RECEIPT</div>
          </div>
          <label for="remote-input">Type the proof phrase</label>
          <input id="remote-input" autocomplete="off" placeholder="colony-web" />
          <button id="remote-action" type="button">Verify CDP input</button>
          <p class="hint">Type the phrase, then verify through the live browser surface.</p>
        </div>
        <div class="card">
          <div id="remote-status">WAITING</div>
          <p class="hint">PASS requires pointer, exact text once, and one action.</p>
        </div>
      </section>
    </main>
    <script>
      const input = document.querySelector("#remote-input");
      const action = document.querySelector("#remote-action");
      const status = document.querySelector("#remote-status");
      const scroller = document.querySelector("#scroll-region");
      let queue = Promise.resolve({ pass: false });
      const receipt = (body) => {
        queue = queue.then(() => fetch("/receipt", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }).then((response) => response.json()));
        return queue;
      };
      const center = (selector) => {
        const bounds = document.querySelector(selector).getBoundingClientRect();
        return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      };
      const reportLayout = () => void receipt({
        kind: "layout",
        input: center("#remote-input"),
        action: center("#remote-action"),
        scroll: center("#scroll-region"),
        viewport: { width: window.innerWidth, height: window.innerHeight },
      });
      requestAnimationFrame(reportLayout);
      window.addEventListener("resize", () => requestAnimationFrame(reportLayout), {
        passive: true,
      });
      input.addEventListener("pointerdown", () => void receipt({ kind: "pointer" }));
      scroller.addEventListener("scroll", () => {
        if (scroller.scrollTop > 0) {
          void receipt({ kind: "scroll", scrollY: scroller.scrollTop });
        }
      }, { passive: true });
      const verify = async () => {
        const result = await receipt({ kind: "action", value: input.value });
        status.textContent = result.pass ? "PASS" : "FAILED";
        status.className = result.pass ? "pass" : "";
        if (result.pass) {
          requestAnimationFrame(() => requestAnimationFrame(() => {
            void receipt({ kind: "visual" });
          }));
        }
      };
      action.addEventListener("click", () => void verify());
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") void verify();
      });
    </script>
  </body>
</html>`;

type ReceiptInput =
  | ({
      kind: "layout";
      viewport: { width: number; height: number };
    } & WebFixtureTargets)
  | { kind: "pointer" }
  | { kind: "scroll"; scrollY: number }
  | { kind: "action"; value: string }
  | { kind: "visual" };

function snapshot(state: Omit<WebFixtureReceipts, "pass">): WebFixtureReceipts {
  return {
    ...state,
    inputValues: [...state.inputValues],
    targets: state.targets
      ? {
          input: { ...state.targets.input },
          action: { ...state.targets.action },
          scroll: { ...state.targets.scroll },
        }
      : null,
    viewport: state.viewport ? { ...state.viewport } : null,
    pass:
      state.pointerEvents > 0 &&
      state.actions === 1 &&
      state.inputValues.length === 1 &&
      state.inputValues[0] === "colony-web",
  };
}

async function readReceipt(request: IncomingMessage): Promise<ReceiptInput> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 4096) throw new Error("receipt body exceeds 4096 bytes");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as ReceiptInput;
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

/** Start the deterministic loopback page used by packaged Web-tab proof. */
export async function startWebFixture(): Promise<WebFixture> {
  const state: Omit<WebFixtureReceipts, "pass"> = {
    pointerEvents: 0,
    actions: 0,
    inputValues: [],
    maxScrollY: 0,
    targets: null,
    viewport: null,
    visualPass: false,
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "text/html; charset=utf-8",
        });
        response.end(PAGE);
        return;
      }
      if (request.method === "POST" && url.pathname === "/receipt") {
        const receipt = await readReceipt(request);
        if (receipt.kind === "layout") {
          state.targets = {
            input: receipt.input,
            action: receipt.action,
            scroll: receipt.scroll,
          };
          state.viewport = { ...receipt.viewport };
        }
        if (receipt.kind === "pointer") state.pointerEvents += 1;
        if (receipt.kind === "scroll" && Number.isFinite(receipt.scrollY)) {
          state.maxScrollY = Math.max(state.maxScrollY, receipt.scrollY);
        }
        if (receipt.kind === "action") {
          state.actions += 1;
          state.inputValues.push(receipt.value);
        }
        if (receipt.kind === "visual") state.visualPass = true;
        sendJson(response, 200, snapshot(state));
        return;
      }
      sendJson(response, 404, { error: "not found" });
    } catch (cause: unknown) {
      sendJson(response, 400, {
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
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
    receipts: () => snapshot(state),
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
