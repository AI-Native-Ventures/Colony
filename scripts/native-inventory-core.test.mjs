import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import {
  balancedSlice,
  buildInventory,
  stripComments,
} from "./native-inventory-core.mjs";

const LIB_RS = `use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(generate_handler![
            commands::archive::foo,
            commands::identity::bar,
            commands::ws::disconnect_all,
            commands::media::qux,
            commands::agents::orphan,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
`;

const ARCHIVE_RS = `#[tauri::command]
pub async fn foo(
    state: State<'_, AppState>,
    app: &tauri::AppHandle,
    win: tauri::Window,
    request: tauri::ipc::Request<'_>,
    on_message: tauri::ipc::Channel<serde_json::Value>,
) -> Result<String, String> {
    Ok(format!("{state:?} {app:?} {win:?} {request:?} {on_message:?}"))
}

#[tauri::command]
pub fn bar(state: &State<'_, AppState>) -> String {
    let _ = state;
    String::new()
}

#[tauri::command]
pub fn orphan(app: &AppHandle) -> String {
    let _ = app;
    String::new()
}

fn helper(
    state2: &State<'_, AppState>,
    sink: impl FnOnce(&AppHandle, &AppState),
    wrapped: Option<tauri::AppHandle>,
    axum_state: AxumState<ProxyState>,
) {
    let _ = (state2, sink, wrapped, axum_state);
    let entry = std::fs::read_dir(".").unwrap().next().unwrap().unwrap();
    let _ = entry.path();
    let _ = app.path();
}

#[cfg(test)]
mod tests {
    async fn axum_handler(State(state): State<Arc<TestState>>) {
        let _ = state;
    }
}
`;

const FRONTEND_TS = `import { invokeTauri } from "./api/tauri";
import { addReaction } from "./reactions";

// Trap: same-line matching. The facade wraps its arguments, so the command
// name lives on its own line.
invokeTauri(
  "foo",
  { channelId: "1" },
);

// Trap: plugin prefixes. A plain name comparison misses this call site.
invokeTauri("plugin:websocket|disconnect_all");

// Trap: dynamic imports. A static-import scan misses this line.
const eventApi = await import("@tauri-apps/api/event");
eventApi.listen("some-event", () => invokeTauri("qux"));
`;

const WS_RS = `use tauri::ipc::Channel;

#[tauri::command]
pub fn disconnect_all(on_message: Channel<serde_json::Value>) {
    let _ = on_message;
}

#[tauri::command]
pub fn qux() {}
`;

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-inventory-"));
  const desktop = path.join(root, "desktop");
  const src = path.join(desktop, "src");
  const rust = path.join(desktop, "src-tauri", "src");
  await fs.mkdir(path.join(rust, "commands"), { recursive: true });
  await fs.mkdir(path.join(src, "api"), { recursive: true });
  await fs.mkdir(path.join(src, "reactions"), { recursive: true });
  await fs.writeFile(path.join(rust, "lib.rs"), LIB_RS);
  await fs.writeFile(path.join(rust, "commands", "archive.rs"), ARCHIVE_RS);
  await fs.writeFile(path.join(rust, "native_websocket.rs"), WS_RS);
  await fs.writeFile(path.join(src, "frontend.ts"), FRONTEND_TS);
  return desktop;
}

test("balancedSlice handles nested brackets", () => {
  const src = "generate_handler![a, [b, c], d] tail";
  assert.equal(balancedSlice(src, src.indexOf("["), "[", "]"), "a, [b, c], d");
  assert.throws(() => balancedSlice("a(b", 0, "(", ")"), /unbalanced/);
});

test("stripComments removes line and block comments", () => {
  const src = "// line\nfn a() { /* block\nspan */ } // tail";
  assert.equal(stripComments(src), "\nfn a() {  } ");
});

test("module path splitting: generate_handler! entries yield leaf names", async () => {
  const desktop = await makeFixture();
  try {
    const data = await buildInventory(desktop);
    const names = Object.keys(data.detail);
    assert.ok(names.includes("foo"), "leaf name foo registered");
    assert.ok(names.includes("disconnect_all"), "leaf name disconnect_all registered");
    assert.ok(names.includes("orphan"), "leaf name orphan registered");
    assert.ok(!names.includes("archive"), "module path not split into archive");
    assert.ok(!names.includes("tauri"), "module path not split into tauri");
    assert.equal(data.commands.registered, data.commands.defined);
    assert.equal(data.commands.registered, 5);
  } finally {
    await fs.rm(desktop, { recursive: true, force: true });
  }
});

test("same-line matching: multi-line invokeTauri call is found", async () => {
  const desktop = await makeFixture();
  try {
    const data = await buildInventory(desktop);
    assert.equal(data.detail.foo.reached_by, "frontend");
    assert.deepEqual(data.detail.foo.example_sites, ["src/frontend.ts:7"]);
  } finally {
    await fs.rm(desktop, { recursive: true, force: true });
  }
});

test("plugin prefixes: plugin:websocket|disconnect_all is a real call site", async () => {
  const desktop = await makeFixture();
  try {
    const data = await buildInventory(desktop);
    assert.equal(data.detail.disconnect_all.reached_by, "frontend-plugin-prefixed");
  } finally {
    await fs.rm(desktop, { recursive: true, force: true });
  }
});

test("self-matching: definition line and generate_handler! are not callers", async () => {
  const desktop = await makeFixture();
  try {
    const data = await buildInventory(desktop);
    // orphan: defined and registered, never called anywhere.
    assert.equal(data.detail.orphan.reached_by, "NO CALLER FOUND");
    assert.deepEqual(data.detail.orphan.example_sites, []);
        // bar is registered and defined but never called: still NO CALLER FOUND
    // even though its definition line contains `fn bar(`.
    assert.equal(data.detail.bar.reached_by, "NO CALLER FOUND");
    assert.deepEqual(data.commands.no_caller, ["bar", "orphan"]);
    // foo is called from the frontend; the definition line in archive.rs must
    // not count as an internal caller.
    assert.equal(data.detail.foo.reached_by, "frontend");
  } finally {
    await fs.rm(desktop, { recursive: true, force: true });
  }
});

test("dynamic imports: quoted literals are indexed regardless of import form", async () => {
  const desktop = await makeFixture();
  try {
    const data = await buildInventory(desktop);
    // qux is only invoked via the dynamically imported event API module.
    assert.equal(data.detail.qux.reached_by, "frontend");
    assert.deepEqual(data.detail.qux.example_sites, ["src/frontend.ts:16"]);
  } finally {
    await fs.rm(desktop, { recursive: true, force: true });
  }
});

test("params: multi-line signatures, &State, impl FnOnce, axum exclusion", async () => {
  const desktop = await makeFixture();
  try {
    const data = await buildInventory(desktop);
    const params = data.params;
    assert.equal(params.AppHandle, 4); // foo, orphan, sink, wrapped
    assert.equal(params.State, 3); // foo, bar, helper
    assert.equal(params.Window, 1);
    assert.equal(params["ipc::Request"], 1);
    assert.equal(params["ipc::Channel"], 2); // foo + disconnect_all
    assert.equal(data.params_by_context.prod.AppHandle, 4);
    assert.equal(data.params_by_context.test.State, 0);
    // axum extractor State in a #[cfg(test)] module is not Tauri State.
    assert.deepEqual(data.params_by_context.axum_extractor_states, {
      prod: 0,
      test: 1,
    });
  } finally {
    await fs.rm(desktop, { recursive: true, force: true });
  }
});

test("receiver-scoped .path(): DirEntry::path is not AppHandle usage", async () => {
  const desktop = await makeFixture();
  try {
    const data = await buildInventory(desktop);
    assert.equal(data.apphandle_usage[".path()"], 1); // app.path() only
  } finally {
    await fs.rm(desktop, { recursive: true, force: true });
  }
});

test("coupling is classified on stripped source, and the lists are emitted", async () => {
  const desktop = await makeFixture();
  try {
    // A file whose ONLY match is a doc comment asserting the absence of a
    // Tauri dependency. Real example: managed_agents/readiness.rs says
    // "no `AppHandle` dependency so it is fully unit-testable".
    const rust = path.join(desktop, "src-tauri", "src");
    await fs.writeFile(
      path.join(rust, "comment_only.rs"),
      [
        "//! Pure logic. Does NOT require an `AppHandle`, so it is",
        "//! fully unit-testable without tauri::Manager.",
        "pub fn add(a: u32, b: u32) -> u32 {",
        "    a + b",
        "}",
        "",
      ].join("\n"),
    );

    const data = await buildInventory(desktop);
    const { portable_list: portable, tauri_coupled_list: coupled } = data.files;

    assert.ok(
      portable.some((f) => f.endsWith("comment_only.rs")),
      "a comment-only AppHandle mention must not make a file coupled",
    );
    assert.ok(
      !coupled.some((f) => f.endsWith("comment_only.rs")),
      "comment_only.rs must not appear in the coupled list",
    );

    // The lists are the scope source for Phase 1, so they must reconcile with
    // the counts they are reported alongside.
    assert.equal(coupled.length, data.files.tauri_coupled);
    assert.equal(portable.length, data.files.portable);
    assert.equal(coupled.length + portable.length, data.files.rust_total);
    assert.equal(
      new Set([...coupled, ...portable]).size,
      data.files.rust_total,
      "no file may be both coupled and portable",
    );
    assert.deepEqual(coupled, [...coupled].sort(), "coupled list is sorted");
    assert.deepEqual(portable, [...portable].sort(), "portable list is sorted");
  } finally {
    await fs.rm(desktop, { recursive: true, force: true });
  }
});

test("drift check: renaming a registered command makes the inventory stale", async () => {
  const desktop = await makeFixture();
  try {
    const libPath = path.join(desktop, "src-tauri", "src", "lib.rs");
    const before = await buildInventory(desktop);
    const baseline = { ...before };
    delete baseline.commit;
    await fs.writeFile(
      libPath,
      LIB_RS.replace("commands::agents::orphan", "commands::agents::renamed"),
    );
    const after = await buildInventory(desktop);
    const current = { ...after };
    delete current.commit;
    assert.equal(
      isDeepStrictEqual(current, baseline),
      false,
      "renamed command must produce a different inventory",
    );
    assert.ok(current.detail.renamed, "renamed command appears");
    assert.ok(!current.detail.orphan, "old name gone");
  } finally {
    await fs.rm(desktop, { recursive: true, force: true });
  }
});

test("real repo invariants: registered and defined counts must agree", async () => {
  const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "desktop");
  const data = await buildInventory(projectRoot);
  assert.equal(data.commands.registered, data.commands.defined);
  assert.ok(data.files.rust_total > 200, "real crate has >200 rust files");
});
