import path from "node:path";
import { fileURLToPath } from "node:url";
import { runNativeInventory } from "../../scripts/native-inventory-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// Generates and drift-checks the committed native-surface inventory
// (desktop/native-inventory.json). Every count the Electron migration plan
// quotes comes from here; see scripts/native-inventory-core.mjs for the
// measurement rules and the AppHandle/State param-count ruling.
//
// Usage:
//   node ./scripts/native-inventory.mjs                  # print summary
//   node ./scripts/native-inventory.mjs --json ./native-inventory.json
//   node ./scripts/native-inventory.mjs --check [path]   # drift check
const args = process.argv.slice(2);
let jsonPath = null;
let checkPath = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--json") {
    jsonPath = path.resolve(projectRoot, args[i + 1]);
    i += 1;
  } else if (args[i] === "--check") {
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      checkPath = path.resolve(projectRoot, next);
      i += 1;
    } else {
      checkPath = path.join(projectRoot, "native-inventory.json");
    }
  }
}

await runNativeInventory({ projectRoot, jsonPath, checkPath });
