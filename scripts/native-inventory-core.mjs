import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";

const LINE_COMMENT = /\/\/[^\n]*/g;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;

const FN_SIGNATURE = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>(]*>)?\s*\(/g;
const GENERATE_HANDLER = /generate_handler!\s*\[/g;
const COMMAND_ATTR =
  /#\[tauri::command[^\]]*\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([a-z_][a-z0-9_]*)/g;
const QUOTED_LITERAL = /["'`]([A-Za-z0-9_:|.-]+)["'`]/g;
const CALL_SITE = (name) => new RegExp(`(?<![A-Za-z0-9_])${name}\\s*\\(`);
const FN_DEFINITION = (name) => new RegExp(`\\bfn\\s+${name}\\b`);

const REGISTERED_IN = [
  "src-tauri/src/lib.rs",
  "src-tauri/src/native_websocket.rs",
];

function toPosixPath(relativePath) {
  return relativePath.split(path.sep).join("/");
}

export function stripComments(src) {
  return src.replace(LINE_COMMENT, "").replace(BLOCK_COMMENT, "");
}

export function balancedSlice(src, start, openCh, closeCh) {
  const open = src.indexOf(openCh, start);
  if (open === -1) {
    throw new Error(`no ${openCh} at/after offset ${start}`);
  }
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === openCh) depth += 1;
    else if (src[i] === closeCh) {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced ${openCh} from offset ${start}`);
}

async function walk(root, extensions, out = []) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(full, extensions, out);
    } else if (extensions.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

async function rustFiles(projectRoot) {
  return walk(path.join(projectRoot, "src-tauri", "src"), new Set([".rs"]));
}

async function readStripped(filePath) {
  const src = await fs.readFile(filePath, "utf8");
  return stripComments(src);
}

async function registeredCommands(projectRoot) {
  const out = new Map();
  for (const rel of REGISTERED_IN) {
    const filePath = path.join(projectRoot, rel);
    let src;
    try {
      src = await readStripped(filePath);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const match of src.matchAll(GENERATE_HANDLER)) {
      const body = balancedSlice(src, match.index, "[", "]");
      for (const entry of body.split(",")) {
        const name = entry.trim().split("::").pop().trim();
        if (/^[a-z_][a-z0-9_]*$/.test(name)) {
          out.set(name, rel);
        }
      }
    }
  }
  return out;
}

async function commandDefinitions(files) {
  const out = new Map();
  for (const filePath of files) {
    const src = await readStripped(filePath);
    for (const match of src.matchAll(COMMAND_ATTR)) {
      if (!out.has(match[1])) out.set(match[1], filePath);
    }
  }
  return out;
}

async function frontendSources(projectRoot, includeTests) {
  const extensions = new Set([".ts", ".tsx"]);
  const paths = await walk(path.join(projectRoot, "src"), extensions);
  if (includeTests) return paths;
  return paths.filter((p) => !p.split(path.sep).includes("testing"));
}

async function frontendIndex(paths, projectRoot) {
  const index = new Map();
  for (const filePath of paths) {
    const rel = toPosixPath(path.relative(projectRoot, filePath));
    const src = await fs.readFile(filePath, "utf8");
    for (const [lineNo, line] of src.split(/\r?\n/).entries()) {
      for (const match of line.matchAll(QUOTED_LITERAL)) {
        const key = match[1];
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(`${rel}:${lineNo + 1}`);
      }
    }
  }
  return index;
}

function classifyCallers(name, fe, feTest, rustLines) {
  const pluginHits = [];
  for (const [key, sites] of fe) {
    if (key.startsWith("plugin:") && key.endsWith(`|${name}`)) {
      pluginHits.push(...sites);
    }
  }
  if (fe.has(name)) return ["frontend", fe.get(name).slice(0, 3)];
  if (pluginHits.length > 0) {
    return ["frontend-plugin-prefixed", pluginHits.slice(0, 3)];
  }
  const call = CALL_SITE(name);
  const defn = FN_DEFINITION(name);
  const internal = [];
  for (const [rel, lineNo, line] of rustLines) {
    if (
      call.test(line) &&
      !defn.test(line) &&
      !line.includes("generate_handler")
    ) {
      internal.push(`${rel}:${lineNo}`);
      if (internal.length === 3) break;
    }
  }
  if (internal.length > 0) return ["rust-internal", internal];
  if (feTest.has(name)) return ["test-only", feTest.get(name).slice(0, 3)];
  return ["NO CALLER FOUND", []];
}

const PARAM_KINDS = [
  {
    key: "AppHandle",
    // Real AppHandle params: `AppHandle`, `&AppHandle`, `&mut AppHandle`,
    // `tauri::AppHandle`, and wrapped forms (`Option<...AppHandle...>`,
    // `impl FnOnce(&AppHandle, ...)`). The reference pattern required a `:`
    // immediately before the type and missed `impl FnOnce(&AppHandle, ...)`.
    pattern: /(?<![A-Za-z0-9_])(?:&(?:mut\s+)?\s*)?(?:tauri::)?AppHandle\b/,
  },
  {
    key: "State",
    // Tauri State params always carry a lifetime (`State<'_, AppState>`,
    // `&State<'_, AppState>`, `tauri::State<'_, AppState>`). Requiring the
    // lifetime excludes axum extractor `State<Arc<...>>` / `State<X>` params,
    // which the reference counted (7 of them, all in #[cfg(test)] modules).
    pattern: /(?<![A-Za-z0-9_])(?:&(?:mut\s+)?\s*)?(?:tauri::)?State\s*<'/,
  },
  {
    key: "Window",
    pattern: /(?<![A-Za-z0-9_])(?:&(?:mut\s+)?\s*)?(?:tauri::)?(?:Webview)?Window\b/,
  },
  { key: "ipc::Request", pattern: /(?<![A-Za-z0-9_])tauri::ipc::Request\b/ },
  {
    key: "ipc::Channel",
    pattern: /(?<![A-Za-z0-9_])(?:tauri::ipc::)?Channel\s*</,
  },
];

const AXUM_STATE = /(?<![A-Za-z0-9_])State\s*</;

function countLines(text) {
  // Python splitlines() semantics: a trailing newline does not add an empty
  // line, and an empty file has zero lines.
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

function splitParams(params) {
  const out = [];
  let depth = 0;
  let current = "";
  for (const ch of params) {
    if ("([{<".includes(ch)) depth += 1;
    else if (")]}>".includes(ch)) depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current);
  return out;
}

const CFG_TEST_ATTR = /#\[cfg\(([^\]]*)\)\]/g;
const MOD_DECL = /#\[cfg\([^\]]*\)\](\s*(?:#\[[^\]]*\]\s*)*)mod\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*;/g;
const PATH_ATTR = /#\[path\s*=\s*"([^"]+)"\]/g;
const SCOPE_TOKENS =
  /#\[cfg\([^\]]*\)\]|\bmod\b|\b(?:impl|trait|fn|struct|enum|union|type|macro_rules!)\b|;|\{|\}/g;

function isTestAttr(attr) {
  return attr.includes("test") && !attr.includes("not(test)");
}

function resolveModulePath(dir, name, attrsBetween) {
  PATH_ATTR.lastIndex = 0;
  const pathMatch = [...attrsBetween.matchAll(PATH_ATTR)].pop();
  const fileName = pathMatch ? pathMatch[1] : `${name}.rs`;
  return path.join(dir, fileName);
}

async function testModuleFiles(files) {
  const testFiles = new Set();
  for (const filePath of files) {
    const src = await readStripped(filePath);
    for (const match of src.matchAll(MOD_DECL)) {
      const attrBlock = match[0];
      CFG_TEST_ATTR.lastIndex = 0;
      const cfg = [...attrBlock.matchAll(CFG_TEST_ATTR)].shift();
      if (!cfg || !isTestAttr(cfg[1])) continue;
      const resolved = resolveModulePath(
        path.dirname(filePath),
        match[2],
        match[1],
      );
      testFiles.add(resolved);
    }
  }
  return testFiles;
}

function inlineTestScope(src, pos) {
  const stack = [];
  let pendingMod = false;
  let pendingTest = false;
  let pendingDecl = null;
  for (const match of src.matchAll(SCOPE_TOKENS)) {
    if (match.index >= pos) break;
    const token = match[0];
    if (token.startsWith("#[cfg")) {
      const attr = token.slice(6, -1);
      pendingTest = isTestAttr(attr);
      continue;
    }
    if (token === "mod") {
      pendingMod = true;
      pendingDecl = "mod";
      continue;
    }
    if (
      ["impl", "trait", "fn", "struct", "enum", "union", "type", "macro_rules!"].includes(
        token,
      )
    ) {
      pendingDecl = token;
      continue;
    }
    if (token === ";") {
      pendingMod = false;
      pendingTest = false;
      pendingDecl = null;
      continue;
    }
    if (token === "{") {
      const isMod = pendingMod || pendingDecl === "mod";
      stack.push({
        test: isMod ? pendingTest : false,
      });
      pendingMod = false;
      pendingDecl = null;
      pendingTest = false;
      continue;
    }
    if (token === "}") {
      stack.pop();
    }
  }
  return stack.some((scope) => scope.test);
}

function countSignatureParams(src, testFile) {
  const counts = { prod: {}, test: {}, axumExtractor: { prod: 0, test: 0 } };
  for (const kind of PARAM_KINDS) {
    counts.prod[kind.key] = 0;
    counts.test[kind.key] = 0;
  }
  for (const match of src.matchAll(FN_SIGNATURE)) {
    let params;
    try {
      params = balancedSlice(src, match.index, "(", ")");
    } catch {
      continue;
    }
    const isTest = testFile || inlineTestScope(src, match.index);
    for (const param of splitParams(params)) {
      const colon = param.indexOf(":");
      const typeText = colon === -1 ? param : param.slice(colon + 1);
      const bucket = isTest ? counts.test : counts.prod;
      let tauriState = false;
      for (const kind of PARAM_KINDS) {
        kind.pattern.lastIndex = 0;
        if (kind.pattern.test(typeText)) {
          bucket[kind.key] += 1;
          if (kind.key === "State") tauriState = true;
          break;
        }
      }
      // axum extractor State params (`State<Arc<TestState>>` in test
      // modules) are not Tauri State and are reported separately so the
      // Tauri count stays honest.
      if (!tauriState) {
        AXUM_STATE.lastIndex = 0;
        if (AXUM_STATE.test(typeText)) {
          counts.axumExtractor[isTest ? "test" : "prod"] += 1;
        }
      }
    }
  }
  return counts;
}

// Callers must pass comment-stripped source. Doc comments routinely say things
// like "no `AppHandle` dependency so it is fully unit-testable", and matching
// raw text counted those files as coupled — 11 of them, including
// managed_agents/readiness.rs, whose only matches were comments asserting the
// opposite. That inflated tauri_coupled and shrank the portable set that
// Phase 1's move ticket is scoped from.
function tauriCoupling(strippedText) {
  return /tauri::|AppHandle|State<|WebviewWindow|Emitter|Manager/.test(
    strippedText,
  );
}

const EMIT_EVENT = /\.emit(?:_to|_filter)?\s*\(\s*(?:[A-Za-z0-9_"'.&]+\s*,\s*)?"([a-z0-9:_-]+)"/g;
const EMIT_MULTILINE = /\.emit(?:_to|_filter)?\s*\([^)"]{0,200}?"([a-z0-9:_-]+)"/g;

async function emittedEvents(files, projectRoot) {
  const out = new Map();
  for (const filePath of files) {
    const rel = toPosixPath(path.relative(projectRoot, filePath));
    const src = await fs.readFile(filePath, "utf8");
    for (const [lineNo, line] of src.split(/\r?\n/).entries()) {
      for (const match of line.matchAll(EMIT_EVENT)) {
        const name = match[1];
        if (!out.has(name)) out.set(name, []);
        out.get(name).push(`${rel}:${lineNo + 1}`);
      }
    }
    const stripped = stripComments(src);
    for (const match of stripped.matchAll(EMIT_MULTILINE)) {
      const name = match[1];
      if (!out.has(name)) {
        out.set(name, [`${rel}:?`]);
      }
    }
  }
  return out;
}

const USAGE_PATTERNS = {
  ".state::<": /\.state::</g,
  ".emit(": /\.emit\s*\(/g,
  ".emit_to(": /\.emit_to\s*\(/g,
  ".dialog()": /\.dialog\s*\(\s*\)/g,
  ".shell()": /\.shell\s*\(\s*\)/g,
  ".opener()": /\.opener\s*\(\s*\)/g,
  ".notification()": /\.notification\s*\(\s*\)/g,
  ".updater()": /\.updater\s*\(\s*\)/g,
  ".get_webview_window(": /\.get_webview_window\s*\(/g,
  ".global_shortcut(": /\.global_shortcut\s*\(/g,
  ".request_restart(": /\.request_restart\s*\(/g,
  ".run_on_main_thread(": /\.run_on_main_thread\s*\(/g,
  // Receiver-scoped: `.path()`, `.config()`, `.env()` and `.exit()` collide
  // with std and third-party methods (`DirEntry::path`, `Command::env`), so
  // they only count on an app-handle-shaped receiver. Unscoped, `.path(`
  // reports 940 hits, nearly all of them std.
  ".config()": /(?:app|app_handle|handle|_app|self\.app|self\.app_handle|ctx\.app)\s*\.\s*config\s*\(\s*\)/g,
  ".env()": /(?:app|app_handle|handle|_app|self\.app|self\.app_handle|ctx\.app)\s*\.\s*env\s*\(\s*\)/g,
  ".path()": /(?:app|app_handle|handle|_app|self\.app|self\.app_handle|ctx\.app)\s*\.\s*path\s*\(\s*\)/g,
  ".exit(": /(?:app|app_handle|handle|_app|self\.app|self\.app_handle|ctx\.app)\s*\.\s*exit\s*\(/g,
};

async function apphandleUsage(files) {
  const counts = {};
  for (const key of Object.keys(USAGE_PATTERNS)) counts[key] = 0;
  for (const filePath of files) {
    const src = await readStripped(filePath);
    for (const key of Object.keys(USAGE_PATTERNS)) {
      const pattern = USAGE_PATTERNS[key];
      pattern.lastIndex = 0;
      counts[key] += [...src.matchAll(pattern)].length;
    }
  }
  return counts;
}

function gitHead(projectRoot) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export async function buildInventory(projectRoot) {
  const files = await rustFiles(projectRoot);
  const registered = await registeredCommands(projectRoot);
  const definitions = await commandDefinitions(files);
  const testFiles = await testModuleFiles(files);

  const rustLines = [];
  for (const filePath of files) {
    const rel = toPosixPath(path.relative(projectRoot, filePath));
    const src = await readStripped(filePath);
    for (const [lineNo, line] of src.split(/\r?\n/).entries()) {
      rustLines.push([rel, lineNo + 1, line]);
    }
  }

  const fe = await frontendIndex(
    await frontendSources(projectRoot, false),
    projectRoot,
  );
  const feTest = await frontendIndex(
    await frontendSources(projectRoot, true),
    projectRoot,
  );

  const commands = {};
  for (const name of [...registered.keys()].sort()) {
    const definingFile = definitions.has(name)
      ? toPosixPath(path.relative(projectRoot, definitions.get(name)))
      : "UNKNOWN";
    const [reachedBy, sites] = classifyCallers(name, fe, feTest, rustLines);
    commands[name] = {
      defining_file: definingFile,
      module: path.basename(definingFile, ".rs"),
      registered_in: registered.get(name),
      reached_by: reachedBy,
      example_sites: sites,
    };
  }

  const coupled = [];
  const portable = [];
  let portableLines = 0;
  let totalLines = 0;
  for (const filePath of files) {
    const rel = toPosixPath(path.relative(projectRoot, filePath));
    const text = await fs.readFile(filePath, "utf8");
    const lineCount = countLines(text);
    totalLines += lineCount;
    if (tauriCoupling(stripComments(text))) {
      coupled.push(rel);
    } else {
      portable.push(rel);
      portableLines += lineCount;
    }
  }
  coupled.sort();
  portable.sort();

  const paramCounts = { prod: {}, test: {}, axumExtractor: {} };
  for (const filePath of files) {
    const src = await readStripped(filePath);
    const testFile = testFiles.has(filePath);
    const perFile = countSignatureParams(src, testFile);
    for (const bucket of ["prod", "test"]) {
      for (const [kind, value] of Object.entries(perFile[bucket])) {
        paramCounts[bucket][kind] =
          (paramCounts[bucket][kind] ?? 0) + value;
      }
    }
    for (const bucket of ["prod", "test"]) {
      paramCounts.axumExtractor[bucket] =
        (paramCounts.axumExtractor[bucket] ?? 0) +
        perFile.axumExtractor[bucket];
    }
  }

  const params = {};
  for (const kind of PARAM_KINDS) {
    params[kind.key] =
      (paramCounts.prod[kind.key] ?? 0) + (paramCounts.test[kind.key] ?? 0);
  }

  const events = await emittedEvents(files, projectRoot);

  const perModule = new Map();
  for (const command of Object.values(commands)) {
    perModule.set(
      command.defining_file,
      (perModule.get(command.defining_file) ?? 0) + 1,
    );
  }

  const byReach = {};
  for (const command of Object.values(commands)) {
    byReach[command.reached_by] = (byReach[command.reached_by] ?? 0) + 1;
  }

  return {
    commit: gitHead(projectRoot),
    files: {
      rust_total: files.length,
      rust_lines: totalLines,
      tauri_coupled: coupled.length,
      portable: portable.length,
      portable_lines: portableLines,
      // The lists themselves, not just the counts. Phase 1's move ticket is
      // scoped from `portable_list`, and its per-file ticket allocation from
      // `tauri_coupled_list`. Both were previously hand-grepped, which is how
      // a comment-only match got treated as a real Tauri dependency.
      tauri_coupled_list: coupled,
      portable_list: portable,
    },
    commands: {
      registered: registered.size,
      defined: definitions.size,
      by_reach: Object.fromEntries(
        Object.entries(byReach).sort((a, b) => b[1] - a[1]),
      ),
      no_caller: Object.keys(commands)
        .filter((name) => commands[name].reached_by === "NO CALLER FOUND")
        .sort(),
    },
    params,
    params_by_context: {
      prod: paramCounts.prod,
      test: paramCounts.test,
      axum_extractor_states: paramCounts.axumExtractor,
    },
    apphandle_usage: await apphandleUsage(files),
    events: {
      distinct: events.size,
      emit_sites: [...events.values()].reduce((sum, sites) => sum + sites.length, 0),
      names: [...events.keys()].sort(),
    },
    commands_per_module: Object.fromEntries(
      [...perModule.entries()].sort((a, b) => b[1] - a[1]),
    ),
    detail: commands,
  };
}

export function formatSummary(data) {
  const { files, commands, params, events } = data;
  const lines = [];
  const comma = (n) => n.toLocaleString("en-US");
  lines.push(`${files.rust_total} files / ${comma(files.rust_lines)} lines`);
  lines.push(
    `${files.tauri_coupled} tauri-coupled, ${files.portable} portable (${comma(files.portable_lines)} lines)`,
  );
  lines.push(
    `${commands.registered} registered commands = ${commands.defined} defined  (these must agree)`,
  );
  lines.push(`${Object.keys(data.commands_per_module).length} modules define commands`);
  const reachLabels = {
    frontend: "reached from frontend",
    "frontend-plugin-prefixed": "via plugin: prefix",
    "test-only": "test-double-only",
    "rust-internal": "rust-internal",
  };
  const byReach = [];
  for (const kind of ["frontend", "frontend-plugin-prefixed", "test-only", "rust-internal"]) {
    if (commands.by_reach[kind] > 0) {
      byReach.push(`${commands.by_reach[kind]} ${reachLabels[kind]}`);
    }
  }
  lines.push(byReach.join(", "));
  if (commands.no_caller.length > 0) {
    lines.push(`${commands.no_caller.length} with NO CALLER: ${commands.no_caller.join(", ")}`);
  }
  lines.push(`${events.distinct} distinct events, ${events.emit_sites} emit sites`);
  const paramBits = [
    `AppHandle ${params.AppHandle}`,
    `State ${params.State}`,
    `Window ${params.Window}`,
    `ipc::Request ${params["ipc::Request"]}`,
    `ipc::Channel ${params["ipc::Channel"]}`,
  ];
  lines.push(`params: ${paramBits.join(", ")}`);
  const axum = data.params_by_context.axum_extractor_states;
  const axumTotal = axum.prod + axum.test;
  if (axumTotal > 0) {
    lines.push(
      `  (${axumTotal} axum extractor State params in #[cfg(test)] modules are not Tauri State)`,
    );
  }
  const usage = data.apphandle_usage;
  const usageBits = Object.entries(usage)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${kind} ${count}`);
  if (usage[".shell()"] === 0) usageBits.push(".shell() 0");
  const wrapped = [];
  let current = "AppHandle usage: ";
  for (const bit of usageBits) {
    if (current.length + bit.length + 2 > 83) {
      wrapped.push(current.trimEnd());
      current = "                 ";
    }
    current += `${bit}, `;
  }
  wrapped.push(current.trimEnd().replace(/,$/, ""));
  lines.push(wrapped.join("\n"));
  return lines.join("\n");
}

export async function runNativeInventory({ projectRoot, jsonPath, checkPath }) {
  const data = await buildInventory(projectRoot);
  if (checkPath) {
    let committed;
    try {
      committed = JSON.parse(await fs.readFile(checkPath, "utf8"));
    } catch (error) {
      console.error(
        `cannot read committed inventory at ${checkPath}: ${error.message}`,
      );
      console.error(
        `Run \`pnpm generate:native-inventory\` to create it, then commit the result.`,
      );
      process.exitCode = 1;
      return;
    }
    const current = { ...data };
    delete current.commit;
    const baseline = { ...committed };
    delete baseline.commit;
    if (!isDeepStrictEqual(current, baseline)) {
      console.error(
        "native inventory is stale: desktop/src-tauri code no longer matches desktop/native-inventory.json.",
      );
      console.error(
        "Run `pnpm generate:native-inventory`, review the diff, and commit the result.",
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `native inventory up to date (${path.relative(process.cwd(), checkPath)})`,
    );
    return;
  }
  if (jsonPath) {
    await fs.writeFile(jsonPath, `${JSON.stringify(data, null, 2)}\n`);
  }
  console.log(formatSummary(data));
}
