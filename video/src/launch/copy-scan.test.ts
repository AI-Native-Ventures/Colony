import { readdirSync, readFileSync } from "node:fs";
import { bannedWord } from "./banned.ts";

/**
 * Test helper, not a test: lives in a .test.ts file so the typecheck, which
 * has no Node types, leaves its file reading alone.
 */
/** Every banned word and em dash in the source under `dir`, as "file: word". Skips tests and this list. */
export function copyProblems(dir: URL): string[] {
  const names = readdirSync(dir, { recursive: true }) as string[];
  const out: string[] = [];
  for (const name of names) {
    if (!/\.(ts|tsx)$/.test(name) || name.endsWith(".test.ts")) continue;
    if (name.endsWith("banned.ts")) continue;
    const src = readFileSync(new URL(name, dir), "utf8");
    const hit = bannedWord(src);
    if (hit) out.push(`${name}: ${hit}`);
    if (src.includes("\u2014")) out.push(`${name}: em dash`);
  }
  return out;
}
