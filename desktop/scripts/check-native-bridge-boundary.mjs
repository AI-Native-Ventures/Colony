import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// The NativeBridge seam: every native call in `desktop/src` passes through
// src/shared/api/nativeBridge.ts. Feature code must never import `@tauri-apps/*`
// or touch `__TAURI_INTERNALS__` directly — that dependency lives only in the
// Tauri implementation (src/shared/api/tauriNativeBridge.ts) and the test
// doubles (src/testing/). This guard keeps the shell boundary a single module
// so the Electron migration (and the parity oracle) can swap implementations
// without hunting down stragglers.

// Files where `@tauri-apps/*` imports and `__TAURI_INTERNALS__` are legal:
// the Tauri bridge implementation itself, and the mock/test layer.
const allowedFiles = new Set(["src/shared/api/tauriNativeBridge.ts"]);

const skippedDirs = new Set(["src/testing"]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Compare project-relative paths. `full` is absolute, so matching it
      // against "src/testing" never fired and the documented test-double
      // exemption was dead: the mock layer's legitimate `mockWindows` import
      // was reported as a violation.
      if (!skippedDirs.has(path.relative(projectRoot, full))) walk(full, out);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

const errors = [];
const scanRoot = path.join(projectRoot, "src");

for (const file of walk(scanRoot)) {
  const relative = path.relative(projectRoot, file);
  if (allowedFiles.has(relative)) continue;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const isComment =
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*");
    if (!isComment) {
      if (
        /import\s*\(\s*["']@tauri-apps\//.test(line) ||
        /from\s+["']@tauri-apps\//.test(line)
      ) {
        errors.push(
          `${relative}:${i + 1}: imports @tauri-apps/* directly (must go through @/shared/api/nativeBridge)`,
        );
      }
      if (line.includes("__TAURI_INTERNALS__")) {
        errors.push(
          `${relative}:${i + 1}: touches __TAURI_INTERNALS__ directly (must go through @/shared/api/nativeBridge)`,
        );
      }
    }
  }
}

if (errors.length > 0) {
  console.error(
    `NativeBridge boundary check failed — ${errors.length} violation(s):`,
  );
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}

console.log(
  "NativeBridge boundary check passed: no @tauri-apps/* imports or __TAURI_INTERNALS__ references outside src/testing/ and src/shared/api/tauriNativeBridge.ts",
);
