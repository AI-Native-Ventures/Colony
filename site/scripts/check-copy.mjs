#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const siteRoot = path.resolve(path.dirname(__filename), "..");

const banned = new Set([
  "agent", "agents", "relay", "nostr",
  "workspace", "workspaces", "workflow", "workflows",
  "canvas", "git", "harness", "model", "models",
  "token", "tokens", "keypair",
  "open source", "teammate", "teammates",
  "scout", "horizon labs",
]);
// Exception: "scout" allowed only in WorkspacePreview.tsx (first employee's real name, app illustration)

  const allowedOnlyInFAQ = new Set([
    "channel", "channels", "thread", "threads", "credits",
  ]);


function findFiles(dir, ext) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFiles(full, ext));
    } else if (entry.name.endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}

function stripAndSearch(filePath, content) {
  let text = content;
  // Strip URLs
  text = text.replace(/https?:\/\/\S+/g, "");
  // Strip block comments /* ... */ (multiline, non-greedy)
  text = text.replace(/\/\*[\s\S]*?\*\//g, "");
  // Strip JSX block comments {/* ... */}
  text = text.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  // Strip line comments // to end of line
  text = text.split("\n").map((line) => {
    const idx = line.indexOf("//");
    return idx >= 0 ? line.slice(0, idx) : line;
  }).join("\n");
  // Strip import/export lines
  text = text.split("\n").filter((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("import ") || trimmed.startsWith("export ")) return false;
    return true;
  }).join("\n");
  // Strip className="..." and className={...}
  text = text.replace(/className="[^"]*"/g, "");
  text = text.replace(/className=\{[^}]*\}/g, "");

  const hits = [];
  const lines = text.split("\n");
  const relativePath = path.relative(siteRoot, filePath);
  const isFAQ = relativePath === "src/sections/FAQ.tsx" || relativePath.endsWith("/FAQ.tsx");
  const isWorkspacePreview = relativePath === "src/sections/WorkspacePreview.tsx" || relativePath.endsWith("/WorkspacePreview.tsx");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    // Check for em-dash U+2014
    if (line.includes("\u2014")) {
      hits.push({ path: relativePath, line: lineNum, word: "\u2014 (em-dash)", text: line.trim() });
    }
    // Check banned words (case-insensitive, whole word)
    for (const word of banned) {
    // Skip multi-word phrases for regex word boundary approach; handle phrases separately
    const phraseWords = word.split(" ");
    if (phraseWords.length > 1) {
      const regex = new RegExp(word.replace(/\s+/g, "\\s+"), "i");
      if (regex.test(line)) {
        hits.push({ path: relativePath, line: lineNum, word, text: line.trim() });
      }
    } else {
      // Exception: "scout" allowed in WorkspacePreview.tsx (first employee's real name)
      if (isWorkspacePreview && word.toLowerCase() === "scout") continue;
      const regex = new RegExp("\\b" + word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
      if (regex.test(line)) {
        // If it's an allowed-only-in-FAQ word and we're not in FAQ, it's a hit
        if (allowedOnlyInFAQ.has(word.toLowerCase()) && !isFAQ) {
          hits.push({ path: relativePath, line: lineNum, word, text: line.trim() });
        } else if (!allowedOnlyInFAQ.has(word.toLowerCase())) {
          hits.push({ path: relativePath, line: lineNum, word, text: line.trim() });
        }
      }
    }
  }
  }
  return hits;
}

let allHits = [];
const indexPath = path.join(siteRoot, "index.html");
if (fs.existsSync(indexPath)) {
  allHits.push(...stripAndSearch(indexPath, fs.readFileSync(indexPath, "utf-8")));
}
const srcDir = path.join(siteRoot, "src");
const tsFiles = findFiles(srcDir, ".tsx").concat(findFiles(srcDir, ".ts"));
for (const f of tsFiles) {
  if (f.endsWith("vite-env.d.ts")) continue;
  allHits.push(...stripAndSearch(f, fs.readFileSync(f, "utf-8")));
}

if (allHits.length > 0) {
  for (const h of allHits) {
    console.log(`${h.path}:${h.line}: ${h.word}`);
    console.log(`  ${h.text}`);
  }
  console.log(`\ncopy guard: ${allHits.length} hits found`);
  process.exit(1);
} else {
  console.log("copy guard: 0 hits");
  process.exit(0);
}
