import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { TerminalService } from "./terminal.mjs";

// The service spawns $SHELL, so an unpinned run would source the developer's
// own rc files: zsh history expansion eats `$!`, and CI has no zsh at all.
process.env.SHELL = "/bin/sh";

/** Live, non-zombie pids with their parents. Zombies are already dead work. */
function liveProcesses() {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,state="], {
    encoding: "utf8",
  });
  const live = new Map();
  for (const line of rows.split("\n")) {
    const [pid, ppid, state] = line.trim().split(/\s+/);
    if (!pid || state?.startsWith("Z")) continue;
    live.set(Number(pid), Number(ppid));
  }
  return live;
}

function harness() {
  const chunks = new Map();
  const exits = new Map();
  const service = new TerminalService({
    onData: (sessionId, chunk) => {
      chunks.set(sessionId, [...(chunks.get(sessionId) ?? []), chunk]);
    },
    onExit: (sessionId, status) => exits.set(sessionId, status),
  });
  const output = (sessionId) =>
    Buffer.concat(chunks.get(sessionId) ?? []).toString("utf8");
  return { service, output, exits };
}

async function waitFor(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

test("output arrives as raw bytes the caller can decode", async (t) => {
  const { service, output } = harness();
  t.after(() => service.closeAll());
  const { sessionId, pid } = service.start({ cwd: process.cwd() });
  assert.ok(pid > 0);
  service.write(sessionId, "printf __MARK__\\n\n");
  assert.ok(
    await waitFor(() => output(sessionId).includes("__MARK__")),
    `marker never arrived: ${JSON.stringify(output(sessionId).slice(-200))}`,
  );
});

test("resize reaches the shell's terminal dimensions", async (t) => {
  const { service, output } = harness();
  t.after(() => service.closeAll());
  const { sessionId } = service.start({
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
  });
  await waitFor(() => output(sessionId).length > 0);
  service.resize(sessionId, 120, 40);
  service.write(sessionId, "stty size\n");
  assert.ok(
    await waitFor(() => /\b40 120\b/.test(output(sessionId))),
    `stty size never reported 40 120: ${JSON.stringify(output(sessionId).slice(-200))}`,
  );
});

test("attach replays the tail written while nothing was listening", async (t) => {
  const { service, output } = harness();
  t.after(() => service.closeAll());
  const { sessionId } = service.start({ cwd: process.cwd() });
  service.write(sessionId, "printf __REPLAY__\\n\n");
  assert.ok(await waitFor(() => output(sessionId).includes("__REPLAY__")));
  const { replay } = service.attach(sessionId);
  assert.ok(Buffer.from(replay).toString("utf8").includes("__REPLAY__"));
});

test("unacked output pauses the pty and an ack resumes it", async (t) => {
  const { service } = harness();
  t.after(() => service.closeAll());
  const { sessionId } = service.start({ cwd: process.cwd() });
  service.write(sessionId, "head -c 2000000 /dev/zero | tr '\\0' x\n");
  assert.ok(
    await waitFor(() => service.isPaused(sessionId)),
    "backpressure never engaged",
  );
  service.ack(sessionId, 2_000_000);
  assert.equal(service.isPaused(sessionId), false);
});

test("close leaves no live process behind, including a job that ignores the hangup", async () => {
  const { service, output } = harness();
  const { sessionId, pid } = service.start({ cwd: process.cwd() });
  // `nohup` ignores SIGHUP, so closing the PTY alone cannot reap it: only the
  // descendant sweep gets it, which is what a detached `claude`/`cargo` needs.
  service.write(sessionId, "nohup sleep 300 >/dev/null 2>&1 &\n");
  service.write(sessionId, "echo __CHILD__:$!\n");
  assert.ok(
    await waitFor(() => /__CHILD__:(\d+)/.test(output(sessionId))),
    `child pid never reported: ${JSON.stringify(output(sessionId).slice(-200))}`,
  );
  const child = Number(/__CHILD__:(\d+)/.exec(output(sessionId))[1]);
  assert.ok(liveProcesses().has(child), "the backgrounded job never started");

  await service.close(sessionId);

  const live = liveProcesses();
  assert.equal(live.has(pid), false, `shell ${pid} survived close`);
  assert.equal(
    live.has(child),
    false,
    `background job ${child} survived close`,
  );
  assert.deepEqual(service.list(), []);
});

test("closeAll is idempotent and reports exits", async () => {
  const { service, exits } = harness();
  const first = service.start({ cwd: process.cwd() });
  const second = service.start({ cwd: process.cwd() });
  assert.equal(service.list().length, 2);
  await service.closeAll();
  await service.closeAll();
  assert.deepEqual(service.list(), []);
  assert.ok(exits.has(first.sessionId));
  assert.ok(exits.has(second.sessionId));
});

test("start refuses a working directory that is not a directory", () => {
  const { service } = harness();
  assert.throws(
    () => service.start({ cwd: "/definitely/not/here" }),
    /does not exist/,
  );
  assert.throws(
    () => service.start({ cwd: import.meta.filename }),
    /not a directory/,
  );
  assert.throws(() => service.start({}), /working directory/);
});

test("unknown sessions are rejected rather than silently ignored", () => {
  const { service } = harness();
  assert.throws(() => service.write("nope", "x"), /Unknown terminal session/);
  assert.throws(() => service.attach("nope"), /Unknown terminal session/);
});
