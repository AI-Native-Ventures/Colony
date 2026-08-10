// OS-process assertions for the managed-agent flow. These run from the spec
// (Node), NOT inside the app: they observe real OS state.
import { execFileSync } from "node:child_process";

export type OsProcess = {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
};

function psSnapshot(): OsProcess[] {
  const out = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,command="], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      return match
        ? {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            pgid: Number(match[3]),
            command: match[4],
          }
        : null;
    })
    .filter((row): row is OsProcess => row !== null);
}

export function psFind(pattern: string): OsProcess[] {
  return psSnapshot().filter((row) => row.command.includes(pattern));
}

export function psFindWhere(
  predicate: (row: OsProcess) => boolean,
): OsProcess[] {
  return psSnapshot().filter(predicate);
}

export function processTree(rootPid: number): OsProcess[] {
  const snapshot = psSnapshot();
  const byParent = new Map<number, OsProcess[]>();
  for (const row of snapshot) {
    const children = byParent.get(row.ppid) ?? [];
    children.push(row);
    byParent.set(row.ppid, children);
  }
  const result: OsProcess[] = [];
  const pending = [rootPid];
  while (pending.length > 0) {
    const parent = pending.pop();
    if (parent === undefined) continue;
    for (const child of byParent.get(parent) ?? []) {
      if (result.some((row) => row.pid === child.pid)) continue;
      result.push(child);
      pending.push(child.pid);
    }
  }
  return result;
}

export function pidIsAlive(pid: number): boolean {
  try {
    execFileSync("/bin/kill", ["-0", String(pid)], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function waitForPidsGone(
  pids: number[],
  timeoutMs = 60_000,
  describe = "tracked process tree",
): Promise<void> {
  const uniquePids = [...new Set(pids)];
  const deadline = Date.now() + timeoutMs;
  while (uniquePids.some(pidIsAlive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const remaining = uniquePids.filter((pid) => pidIsAlive(pid));
  if (remaining.length > 0) {
    throw new Error(
      `${describe} still alive by kill -0: ${remaining.join(",")}`,
    );
  }
}

export function appProcessExists(bundlePath: string): boolean {
  return psFind("Colony.app").some((row) => row.command.includes(bundlePath));
}

export async function waitForProcessWhere(
  predicate: (row: OsProcess) => boolean,
  timeoutMs = 90_000,
  describe: string,
): Promise<OsProcess> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = psFindWhere(predicate);
    if (matches.length > 0) return matches[0];
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `no process matching ${describe} appeared within ${timeoutMs}ms`,
  );
}

export async function waitForNoProcessWhere(
  predicate: (row: OsProcess) => boolean,
  timeoutMs = 60_000,
  describe: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = psFindWhere(predicate);
    if (matches.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `process matching ${describe} still alive after ${timeoutMs}ms`,
  );
}
