// OS-process assertions for the managed-agent flow. These run from the spec
// (Node), NOT inside the app: they observe real OS state.
import { execFileSync } from "node:child_process";

export type OsProcess = { pid: number; command: string };

function psSnapshot(): OsProcess[] {
  const out = execFileSync("/bin/ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.*)$/);
      return match ? { pid: Number(match[1]), command: match[2] } : null;
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
