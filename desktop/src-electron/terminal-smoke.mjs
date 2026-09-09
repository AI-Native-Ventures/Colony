import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// The shell prints this, but no command line typed into the PTY contains it, so
// the echo of the command cannot satisfy the check on its own.
const MARKER = "__COLONY_TERM_OK__";
const MARKER_COMMAND = `printf '%s_%s\\n' __COLONY TERM_OK__\n`;

/** Parse a `<pid> <cols>` or `<pid>` line from a file; return null if absent/invalid. */
export function parsePidCols(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.length < 1) return null;
  const pid = Number(parts[0]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const cols = parts.length > 1 ? Number(parts[1]) : null;
  if (cols !== null && (!Number.isInteger(cols) || cols < 0)) return null;
  return { pid, cols: cols ?? null };
}

/** Decode PTY chunks collected in the renderer as arrays of byte values. */
export function decodeChunkArrays(chunks) {
  if (!Array.isArray(chunks)) return "";
  const buffers = chunks
    .filter((chunk) => Array.isArray(chunk))
    .map((chunk) => Buffer.from(chunk));
  return Buffer.concat(buffers).toString("utf8");
}

/** Total byte count of chunks collected in the renderer; used to ack backpressure. */
export function countChunkBytes(chunks) {
  if (!Array.isArray(chunks)) return 0;
  let total = 0;
  for (const chunk of chunks) if (Array.isArray(chunk)) total += chunk.length;
  return total;
}

/** Poll a file until it exists and parses; timeout in ms. */
async function pollFileParse(filePath, parser, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(filePath, "utf8");
      const result = parser(text);
      if (result !== null && result !== undefined) return result;
    } catch {
      // Not yet present.
    }
    await delay(200);
  }
  return null;
}

/** Parse a file holding a single positive integer. */
function parsePositiveInteger(text) {
  const value = Number(text.trim());
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** Check if a pid is alive using the Electron main process. */
async function isLivePid(application, pid) {
  try {
    const alive = await application.evaluate(
      (_electron, { targetPid }) => {
        try {
          process.kill(targetPid, 0);
          return true;
        } catch {
          return false;
        }
      },
      { targetPid: pid },
    );
    return alive === true;
  } catch {
    return false;
  }
}

/** Write into the packaged PTY through the preload bridge. */
function writeToTerminal(page, sessionId, data) {
  return page.evaluate(
    ({ sessionId, data }) =>
      window.colonyDesktop.terminal.write({ sessionId, data }),
    { sessionId, data },
  );
}

/**
 * Prove the packaged bundle's node-pty, spawn-helper and preload IPC path.
 *
 * This drives `window.colonyDesktop.terminal` directly: the smoke app runs with
 * an unreachable relay, so it has no channel and no workspace tab strip to
 * click. The terminal UI itself is covered by the mock-mode Playwright spec in
 * normal CI; what only the packaged, signed bundle can prove is that a real PTY
 * spawns, resizes, streams to the renderer, survives a reload and is reaped.
 */
export async function verifyTerminal(application, page, { proofDir } = {}) {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "colony-terminal-smoke-"),
  );
  const home = os.homedir();

  // --- Step 1: start a real PTY in the packaged app ---
  const session = await page.evaluate(
    (cwd) => window.colonyDesktop.terminal.start({ cwd, cols: 100, rows: 30 }),
    home,
  );
  assert.ok(
    typeof session?.sessionId === "string" && session.sessionId.length > 0,
    "terminal.start must return a session id",
  );
  assert.ok(
    Number.isInteger(session.pid) && session.pid > 0,
    `terminal.start must return a positive pid: ${session.pid}`,
  );
  assert.equal(
    session.cwd,
    home,
    "terminal.start must report the requested working directory",
  );
  const { sessionId } = session;
  const originalPid = session.pid;
  console.log(`PASS: packaged PTY started (pid=${originalPid}, cols=100)`);

  // --- Step 2: keystrokes reach a real shell ---
  const firstFile = path.join(tmpDir, "one");
  await writeToTerminal(
    page,
    sessionId,
    `printf '%s %s\\n' "$$" "$(tput cols)" > "${firstFile}"\n`,
  );
  const parsedOne = await pollFileParse(firstFile, parsePidCols, 30000);
  assert.ok(parsedOne !== null, "first file never parsed as <pid> <cols>");
  assert.ok(
    Number.isInteger(parsedOne.pid) && parsedOne.pid > 0,
    `first pid must be positive: ${parsedOne.pid}`,
  );
  assert.equal(
    parsedOne.cols,
    100,
    "shell must see the requested column count",
  );
  assert.equal(
    await isLivePid(application, parsedOne.pid),
    true,
    `shell pid ${parsedOne.pid} must be a live process`,
  );
  console.log(
    `PASS: writes reached a real shell (pid=${parsedOne.pid}, cols=${parsedOne.cols})`,
  );

  // --- Step 3: resize propagates to the PTY ---
  await page.evaluate(
    ({ sessionId }) =>
      window.colonyDesktop.terminal.resize({ sessionId, cols: 140, rows: 30 }),
    { sessionId },
  );
  const secondFile = path.join(tmpDir, "two");
  await writeToTerminal(page, sessionId, `tput cols > "${secondFile}"\n`);
  const cols2 = await pollFileParse(secondFile, parsePositiveInteger, 30000);
  assert.equal(cols2, 140, "resize must propagate to the PTY");
  console.log(`PASS: resize propagated to the PTY (cols=${cols2})`);

  // --- Step 4: PTY output reaches the renderer over the preload bridge ---
  await page.evaluate(
    ({ sessionId }) => {
      window.__smokeTermChunks = [];
      window.__smokeTermOff = window.colonyDesktop.terminal.onData(
        (incomingSessionId, chunk) => {
          if (incomingSessionId !== sessionId) return;
          window.__smokeTermChunks.push(Array.from(chunk));
        },
      );
    },
    { sessionId },
  );
  await writeToTerminal(page, sessionId, MARKER_COMMAND);
  const deadline = Date.now() + 30000;
  let received = null;
  while (Date.now() < deadline) {
    const chunks = await page.evaluate(() => window.__smokeTermChunks ?? []);
    if (decodeChunkArrays(chunks).includes(MARKER)) {
      received = chunks;
      break;
    }
    await delay(200);
  }
  assert.ok(received !== null, "PTY output must reach the renderer");
  const receivedBytes = countChunkBytes(received);
  // Release the PTY's backpressure for everything the renderer took.
  await page.evaluate(
    ({ sessionId, bytes }) =>
      window.colonyDesktop.terminal.ack({ sessionId, bytes }),
    { sessionId, bytes: receivedBytes },
  );
  await page.evaluate(() => {
    window.__smokeTermOff?.();
    window.__smokeTermOff = undefined;
  });
  console.log(
    `PASS: renderer received PTY output (chunks=${received.length}, bytes=${receivedBytes})`,
  );

  // --- Step 5: the session survives a renderer reload ---
  await page.reload();
  // The terminal bridge is what step 5 exercises, so wait for the preload
  // surface rather than any screen: by this point the active business has
  // changed and the post-reload view is not the inbox.
  await page.waitForFunction(
    () =>
      !!window.colonyDesktop?.terminal && document.readyState === "complete",
    {},
    {
      timeout: 30000,
    },
  );

  const listed = await page.evaluate(() =>
    window.colonyDesktop.terminal.list(),
  );
  const survivor = listed.find((entry) => entry.sessionId === sessionId);
  assert.ok(survivor, "the session must still be listed after a reload");
  assert.equal(survivor.alive, true, "the surviving session must be alive");
  assert.equal(
    survivor.pid,
    originalPid,
    "the surviving session keeps its pid",
  );

  const replay = await page.evaluate(
    ({ sessionId }) =>
      window.colonyDesktop.terminal
        .attach({ sessionId })
        .then((result) => Array.from(result.replay)),
    { sessionId },
  );
  assert.ok(
    decodeChunkArrays([replay]).includes(MARKER),
    "attach must replay the output produced before the reload",
  );
  console.log(
    `PASS: session survived reload (pid=${originalPid}, replay bytes=${replay.length})`,
  );

  const thirdFile = path.join(tmpDir, "three");
  await writeToTerminal(
    page,
    sessionId,
    `printf '%s\\n' "$$" > "${thirdFile}"\n`,
  );
  const pidAfterReload = await pollFileParse(
    thirdFile,
    parsePositiveInteger,
    30000,
  );
  assert.equal(
    pidAfterReload,
    originalPid,
    "the same shell must still be driving the PTY after a reload",
  );
  console.log(`PASS: same shell answers after reload (pid=${pidAfterReload})`);

  // There is no terminal UI in this gate; the shot is the app window itself,
  // captured so the packaged run leaves the same proof artefact as before.
  if (proofDir) {
    await mkdir(proofDir, { recursive: true });
    await page.screenshot({ path: path.join(proofDir, "terminal.png") });
  }

  // --- Step 6: closing the session reaps the shell and its children ---
  await page.evaluate(
    ({ sessionId }) => window.colonyDesktop.terminal.close({ sessionId }),
    { sessionId },
  );
  const closeDeadline = Date.now() + 10000;
  let pidGone = false;
  while (Date.now() < closeDeadline) {
    if (!(await isLivePid(application, originalPid))) {
      pidGone = true;
      break;
    }
    await delay(300);
  }
  assert.equal(
    pidGone,
    true,
    `shell pid ${originalPid} must be reaped within 10 s of close`,
  );

  const treeCheck = await application.evaluate(
    (_electron, { rootPid }) => {
      try {
        const { execFileSync } = require("node:child_process");
        const rows = execFileSync("ps", ["-axo", "pid=,ppid="], {
          encoding: "utf8",
        });
        for (const line of rows.split("\n")) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 2) continue;
          const pid = Number(parts[0]);
          const ppid = Number(parts[1]);
          if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
          if (ppid === rootPid)
            return { hasChildWithParent: true, childPid: pid };
        }
        return { hasChildWithParent: false };
      } catch {
        return { error: "ps tree check failed" };
      }
    },
    { rootPid: originalPid },
  );
  assert.equal(
    treeCheck?.hasChildWithParent !== true,
    true,
    `no process may have pid ${originalPid} as parent after close`,
  );
  console.log(
    `PASS: shell pid ${originalPid} reaped with no orphaned children`,
  );

  await page.evaluate(() => window.colonyDesktop.terminal.closeAll());
  const remaining = await page.evaluate(() =>
    window.colonyDesktop.terminal.list(),
  );
  assert.equal(remaining.length, 0, "closeAll must leave no live sessions");
  console.log(`PASS: closeAll left ${remaining.length} sessions`);
}
