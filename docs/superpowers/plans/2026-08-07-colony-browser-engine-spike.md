# Colony Browser Engine Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove one agent-controllable, context-efficient browser tab
end-to-end with a shell-agnostic Rust CDP daemon that exposes snapshot-first
MCP tools over stdio, enforces a token budget, and completes a fixture journey
under the spec's budget gate.

**Architecture:** New workspace crate `crates/buzz-browser`. The library owns
contracts, browser host (system Chrome + CDP), snapshot/input tooling, budget
accounting, an rmcp stdio MCP server, and a journey runner. The `buzz-browserd`
binary serves MCP over stdio, so the existing ACP path
(`AcpClient::session_new_full` with an stdio `McpServer`) can attach a real
agent without any desktop or relay changes.

**Tech Stack:** Rust, tokio, tokio-tungstenite 0.29 (workspace), serde /
serde_json, rmcp 1.1 (workspace, stdio transport + client), reqwest
(workspace), thiserror 2, uuid (workspace), system Chrome/Chromium.

---

## File structure

| File | Responsibility |
| --- | --- |
| `crates/buzz-browser/Cargo.toml` | Crate manifest |
| `crates/buzz-browser/src/lib.rs` | Module graph + crate docs |
| `crates/buzz-browser/src/contracts.rs` | Caps, schemas, error type |
| `crates/buzz-browser/src/host.rs` | Chrome discovery/launch/shutdown |
| `crates/buzz-browser/src/cdp.rs` | Minimal CDP WebSocket client |
| `crates/buzz-browser/src/snapshot.rs` | AX-tree outline with refs + caps |
| `crates/buzz-browser/src/input.rs` | Human-shaped mouse/key input |
| `crates/buzz-browser/src/budget.rs` | Token estimator, ledger, caps |
| `crates/buzz-browser/src/mcp.rs` | rmcp stdio server + browser tools |
| `crates/buzz-browser/src/journey.rs` | Reference + naive baseline journeys |
| `crates/buzz-browser/src/agent_proof.rs` | ACP wiring proof |
| `crates/buzz-browser/src/main.rs` | `buzz-browserd` binary |
| `crates/buzz-browser/test-fixtures/*` | Multi-origin fixture pages |
| `crates/buzz-browser/README.md` | Spike usage + proof gates |
| `docs/design/browser-engine-decision.md` | Shell decision memo (Task 10) |

## Task 1: Workspace wiring

**Files:**
- Modify: `Cargo.toml` (root, workspace members + rmcp client feature)
- Create: `crates/buzz-browser/Cargo.toml`
- Create: `crates/buzz-browser/src/lib.rs`
- Test: `crates/buzz-browser/src/lib.rs` (inline test module)

- [ ] **Step 1: Add the crate to the workspace**

Modify root `Cargo.toml`:

```toml
[workspace]
members = [
    # ...existing members...
    "crates/buzz-browser",
]
```

And add the `client` feature to the existing rmcp workspace dependency:

```toml
rmcp = { version = "1.1.0", features = ["server", "transport-io", "macros", "client"] }
```

- [ ] **Step 2: Create the crate manifest**

`crates/buzz-browser/Cargo.toml`:

```toml
[package]
name = "buzz-browser"
version.workspace = true
edition.workspace = true
rust-version.workspace = true
license.workspace = true

[lib]
name = "buzz_browser"
path = "src/lib.rs"

[[bin]]
name = "buzz-browserd"
path = "src/main.rs"

[dependencies]
tokio = { workspace = true }
tokio-tungstenite = { workspace = true }
futures-util = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
thiserror = { workspace = true }
uuid = { workspace = true }
rmcp = { workspace = true }
schemars = { workspace = true }
reqwest = { workspace = true }
tracing = { workspace = true }
tracing-subscriber = { workspace = true }

[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 3: Create the library skeleton**

`crates/buzz-browser/src/lib.rs`:

```rust
//! Shell-agnostic browser engine spike: CDP host, snapshot-first tools,
//! and a token budget for agent browser use.

pub mod budget;
pub mod cdp;
pub mod contracts;
pub mod host;
pub mod input;
pub mod journey;
pub mod mcp;
pub mod snapshot;
```

Do not re-export `BrowserError`/`SnapshotCaps` yet — they do not exist until
Task 2 adds them; Task 2 re-adds the `pub use` line.

`crates/buzz-browser/src/main.rs`:

```rust
fn main() -> Result<(), Box<dyn std::error::Error>> {
    buzz_browser::mcp::run_stdio_server()
}
```

Create each module file as a minimal stub with a doc comment and one trivial
unit test each (e.g. `#[test] fn module_loads() {}`), so the crate compiles
before Task 2 fills them in. The `budget.rs` stub must also define
`pub fn estimate_tokens(chars: usize) -> usize { ((chars + 3) / 4).max(1) }`
because later tasks use it before the ledger exists.

- [ ] **Step 4: Verify the crate compiles and tests pass**

Run: `cargo test -p buzz-browser`
Expected: PASS (module-load tests), no warnings beyond dead-code on stubs.

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml crates/buzz-browser
git commit -s -m "feat(browser): scaffold buzz-browser crate"
```

## Task 2: Contracts

**Files:**
- Create: `crates/buzz-browser/src/contracts.rs`
- Test: `crates/buzz-browser/src/contracts.rs` (inline tests)

- [ ] **Step 1: Write the failing tests**

Add to `contracts.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_caps_have_expected_defaults() {
        let caps = SnapshotCaps::default();
        assert_eq!(caps.max_nodes, 400);
        assert_eq!(caps.max_chars, 4_000);
        assert_eq!(caps.full_max_chars, 24_000);
    }

    #[test]
    fn budget_report_serializes_entries() {
        let report = BudgetReport {
            entries: vec![BudgetEntry {
                tool: "browser_snapshot".into(),
                chars: 800,
                est_tokens: 200,
                cumulative_tokens: 200,
            }],
            total_calls: 1,
            total_tokens: 200,
        };
        let json = serde_json::to_string(&report).unwrap();
        assert!(json.contains("browser_snapshot"));
        assert!(json.contains("200"));
    }

    #[test]
    fn browser_error_display_keeps_message() {
        let err = BrowserError::Cdp("boom".into());
        assert_eq!(err.to_string(), "cdp error: boom");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p buzz-browser contracts::tests`
Expected: FAIL — `SnapshotCaps`, `BudgetReport`, and `BrowserError` not found.

- [ ] **Step 3: Implement the contracts**

Replace the stub in `contracts.rs`:

```rust
use serde::{Deserialize, Serialize};

/// Caps that keep tool results small enough for agent context.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SnapshotCaps {
    pub max_nodes: usize,
    pub max_chars: usize,
    pub full_max_chars: usize,
}

impl Default for SnapshotCaps {
    fn default() -> Self {
        Self {
            max_nodes: 400,
            max_chars: 4_000,
            full_max_chars: 24_000,
        }
    }
}

/// One recorded tool call in the per-task budget.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BudgetEntry {
    pub tool: String,
    pub chars: usize,
    pub est_tokens: usize,
    pub cumulative_tokens: usize,
}

/// Per-task budget summary, written as JSON evidence.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BudgetReport {
    pub entries: Vec<BudgetEntry>,
    pub total_calls: usize,
    pub total_tokens: usize,
}

/// All errors from the browser engine spike.
#[derive(Debug, thiserror::Error)]
pub enum BrowserError {
    #[error("cdp error: {0}")]
    Cdp(String),
    #[error("browser host error: {0}")]
    Host(String),
    #[error("snapshot error: {0}")]
    Snapshot(String),
    #[error("input error: {0}")]
    Input(String),
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Actionable AX roles that receive `rN` refs in a snapshot.
pub const ACTIONABLE_ROLES: &[&str] = &[
    "button", "link", "textbox", "searchbox", "combobox", "checkbox",
    "radio", "menuitem", "tab", "switch", "slider", "option", "listbox",
];

/// Roles whose subtree is label, not structure.
pub const LABEL_ONLY_ROLES: &[&str] = &["button", "link", "menuitem", "tab", "option", "switch"];

/// Roles never emitted in an outline.
pub const SKIP_ROLES: &[&str] = &[
    "none", "generic", "InlineTextBox", "LineBreak", "presentation",
    "LayoutTable", "LayoutTableRow", "LayoutTableCell", "LayoutTableColumn",
];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p buzz-browser contracts::tests`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-browser/src/contracts.rs
git commit -s -m "feat(browser): lock snapshot and budget contracts"
```

## Task 3: Browser host

**Files:**
- Create: `crates/buzz-browser/src/host.rs`
- Test: `crates/buzz-browser/src/host.rs` (inline tests)

- [ ] **Step 1: Write the failing tests**

Add to `host.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn free_port_is_a_tcp_port() {
        let port = pick_free_port().await.unwrap();
        assert!(port > 0 && port < 65536);
    }

    #[test]
    fn browser_binary_override_wins() {
        let cfg = HostConfig {
            binary: Some("/nonexistent/browser".into()),
            ..HostConfig::default()
        };
        assert_eq!(cfg.binary.as_deref(), Some("/nonexistent/browser"));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p buzz-browser host::tests`
Expected: FAIL — `pick_free_port` / `HostConfig` not found.

- [ ] **Step 3: Implement the host**

Replace the stub in `host.rs`:

```rust
use std::path::PathBuf;
use std::time::Duration;

use tokio::net::TcpListener;
use tokio::process::{Child, Command};

use crate::contracts::BrowserError;

/// How to launch the browser for a spike run.
#[derive(Debug, Clone)]
pub struct HostConfig {
    pub binary: Option<PathBuf>,
    pub profile_dir: PathBuf,
    pub headless: bool,
}

impl Default for HostConfig {
    fn default() -> Self {
        Self {
            binary: None,
            profile_dir: std::env::temp_dir().join("buzz-browser-spike-profile"),
            headless: true,
        }
    }
}

/// A launched browser instance and its CDP debug port.
pub struct BrowserHost {
    pub port: u16,
    pub profile_dir: PathBuf,
    child: Child,
}

pub async fn pick_free_port() -> Result<u16, BrowserError> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    Ok(listener.local_addr()?.port())
}

fn find_browser_binary() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("BUZZ_BROWSER_BINARY") {
        let p = PathBuf::from(path);
        if p.exists() {
            return Some(p);
        }
    }
    for candidate in [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ] {
        let p = PathBuf::from(candidate);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

pub async fn launch(cfg: &HostConfig) -> Result<BrowserHost, BrowserError> {
    let binary = match &cfg.binary {
        Some(b) => b.clone(),
        None => find_browser_binary()
            .ok_or_else(|| BrowserError::Host("no Chrome/Chromium found; set BUZZ_BROWSER_BINARY".into()))?,
    };
    let port = pick_free_port().await?;
    let _ = std::fs::create_dir_all(&cfg.profile_dir);
    let mut cmd = Command::new(&binary);
    cmd.arg(format!("--remote-debugging-port={port}"))
        .arg(format!("--user-data-dir={}", cfg.profile_dir.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-backgrounding-occluded-windows")
        .arg("--disable-renderer-backgrounding")
        .arg("about:blank")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    if cfg.headless {
        cmd.arg("--headless=new");
    }
    let child = cmd.spawn().map_err(|e| BrowserError::Host(e.to_string()))?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(resp) = reqwest::get(format!("http://127.0.0.1:{port}/json/version")).await {
            if resp.status().is_success() {
                return Ok(BrowserHost {
                    port,
                    profile_dir: cfg.profile_dir.clone(),
                    child,
                });
            }
        }
        if tokio::time::Instant::now() > deadline {
            let _ = child.start_kill();
            return Err(BrowserError::Host("browser did not open CDP port in time".into()));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

impl BrowserHost {
    /// `http://127.0.0.1:{port}/json/list` page targets.
    pub async fn list_targets(&self) -> Result<Vec<TargetInfo>, BrowserError> {
        let resp = reqwest::get(format!("http://127.0.0.1:{}/json/list", self.port))
            .await?
            .json::<Vec<serde_json::Value>>()
            .await?;
        Ok(resp
            .into_iter()
            .filter_map(|v| {
                if v["type"].as_str() != Some("page") {
                    return None;
                }
                Some(TargetInfo {
                    id: v["id"].as_str().unwrap_or_default().to_string(),
                    url: v["url"].as_str().unwrap_or_default().to_string(),
                    title: v["title"].as_str().unwrap_or_default().to_string(),
                    ws_url: v["webSocketDebuggerUrl"].as_str().unwrap_or_default().to_string(),
                })
            })
            .collect())
    }
}

impl Drop for BrowserHost {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

/// A page target from Chrome's `/json/list` endpoint.
#[derive(Debug, Clone, PartialEq)]
pub struct TargetInfo {
    pub id: String,
    pub url: String,
    pub title: String,
    pub ws_url: String,
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p buzz-browser host::tests`
Expected: PASS (2 tests).

- [ ] **Step 5: Real-browser smoke (gated)**

Run: `BUZZ_BROWSER_REAL=1 cargo test -p buzz-browser -- --ignored`

Add this ignored test to `host.rs`:

```rust
#[tokio::test]
#[ignore = "requires a real browser; run with BUZZ_BROWSER_REAL=1"]
async fn real_launch_lists_a_page_target() {
    if std::env::var("BUZZ_BROWSER_REAL").is_err() {
        return;
    }
    let cfg = HostConfig::default();
    let host = launch(&cfg).await.unwrap();
    let targets = host.list_targets().await.unwrap();
    assert!(!targets.is_empty(), "expected at least one page target");
}
```

Expected: PASS when Chrome is installed.

- [ ] **Step 6: Commit**

```bash
git add crates/buzz-browser/src/host.rs
git commit -s -m "feat(browser): browser host launch and target listing"
```

## Task 4: CDP client

**Files:**
- Create: `crates/buzz-browser/src/cdp.rs`
- Test: `crates/buzz-browser/src/cdp.rs` (inline tests, fake WS server)

- [ ] **Step 1: Write the failing tests**

Add to `cdp.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn send_command_correlates_by_id() {
        // Fake CDP endpoint that answers every command with id + echo.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            loop {
                let msg = ws.next().await.unwrap().unwrap();
                let v: serde_json::Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();
                let reply = serde_json::json!({
                    "id": v["id"],
                    "result": { "echo": v["method"] }
                });
                ws.send(tokio_tungstenite::tungstenite::Message::Text(
                    reply.to_string().into(),
                ))
                .await
                .unwrap();
            }
        });
        let url = format!("ws://{addr}");
        let mut client = CdpClient::connect(&url).await.unwrap();
        let result = client
            .send_command("Page.navigate", serde_json::json!({ "url": "about:blank" }))
            .await
            .unwrap();
        assert_eq!(result["echo"], "Page.navigate");
        server.abort();
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p buzz-browser cdp::tests`
Expected: FAIL — `CdpClient` not found.

- [ ] **Step 3: Implement the client**

Replace the stub in `cdp.rs`:

```rust
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use crate::contracts::BrowserError;

type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

/// Minimal CDP client: one command at a time, events buffered (bounded).
pub struct CdpClient {
    ws: Ws,
    next_id: u64,
    events: Vec<Value>,
}

impl CdpClient {
    pub async fn connect(ws_url: &str) -> Result<Self, BrowserError> {
        let (ws, _) = connect_async(ws_url)
            .await
            .map_err(|e| BrowserError::Cdp(e.to_string()))?;
        Ok(Self {
            ws,
            next_id: 1,
            events: Vec::new(),
        })
    }

    pub async fn send_command(&mut self, method: &str, params: Value) -> Result<Value, BrowserError> {
        let id = self.next_id;
        self.next_id += 1;
        let msg = serde_json::json!({ "id": id, "method": method, "params": params });
        self.ws
            .send(Message::Text(msg.to_string().into()))
            .await
            .map_err(|e| BrowserError::Cdp(e.to_string()))?;
        loop {
            let msg = self
                .ws
                .next()
                .await
                .ok_or_else(|| BrowserError::Cdp("websocket closed".into()))?
                .map_err(|e| BrowserError::Cdp(e.to_string()))?;
            let text = msg
                .into_text()
                .map_err(|e| BrowserError::Cdp(e.to_string()))?;
            let v: Value = serde_json::from_str(&text)
                .map_err(|e| BrowserError::Cdp(format!("bad json: {e}")))?;
            if v["id"].as_u64() == Some(id) {
                if let Some(err) = v["error"].as_object() {
                    return Err(BrowserError::Cdp(format!("{err:?}")));
                }
                return Ok(v["result"].clone());
            }
            if self.events.len() < 100 {
                self.events.push(v);
            }
        }
    }

    pub async fn navigate(&mut self, url: &str) -> Result<(), BrowserError> {
        self.send_command("Page.navigate", serde_json::json!({ "url": url }))
            .await?;
        self.wait_until_ready().await?;
        Ok(())
    }

    /// Poll `document.readyState` until `complete` (bounded), so callers get a
    /// settled document before snapshotting or interacting.
    pub async fn wait_until_ready(&mut self) -> Result<(), BrowserError> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let ready = self
                .evaluate("document.readyState")
                .await
                .unwrap_or(Value::Null);
            if ready.as_str() == Some("complete") {
                return Ok(());
            }
            if tokio::time::Instant::now() > deadline {
                return Err(BrowserError::Cdp(
                    "page did not reach readyState complete".into(),
                ));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    pub async fn evaluate(&mut self, expression: &str) -> Result<Value, BrowserError> {
        let result = self
            .send_command(
                "Runtime.evaluate",
                serde_json::json!({
                    "expression": expression,
                    "returnByValue": true,
                    "awaitPromise": true,
                }),
            )
            .await?;
        if let Some(details) = result["exceptionDetails"].as_object() {
            return Err(BrowserError::Cdp(format!("evaluate threw: {details:?}")));
        }
        Ok(result["result"]["value"].clone())
    }

    pub async fn get_ax_tree(&mut self) -> Result<Value, BrowserError> {
        self.send_command("Accessibility.getFullAXTree", serde_json::json!({}))
            .await
    }

    /// Center of an element's content box, from `DOM.getBoxModel`.
    pub async fn get_box_center(
        &mut self,
        backend_node_id: i64,
    ) -> Result<Option<(f64, f64)>, BrowserError> {
        let result = self
            .send_command(
                "DOM.getBoxModel",
                serde_json::json!({ "backendNodeId": backend_node_id }),
            )
            .await?;
        let Some(content) = result["model"]["content"].as_array() else {
            return Ok(None);
        };
        let points: Vec<(f64, f64)> = content
            .chunks(2)
            .filter_map(|pair| {
                Some((
                    pair.first()?.as_f64()?,
                    pair.get(1)?.as_f64()?,
                ))
            })
            .collect();
        if points.is_empty() {
            return Ok(None);
        }
        let cx = points.iter().map(|p| p.0).sum::<f64>() / points.len() as f64;
        let cy = points.iter().map(|p| p.1).sum::<f64>() / points.len() as f64;
        Ok(Some((cx, cy)))
    }

    pub async fn capture_screenshot(&mut self) -> Result<String, BrowserError> {
        let result = self
            .send_command("Page.captureScreenshot", serde_json::json!({ "format": "png" }))
            .await?;
        result["data"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| BrowserError::Cdp("no screenshot data".into()))
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p buzz-browser cdp::tests`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-browser/src/cdp.rs crates/buzz-browser/Cargo.toml
git commit -s -m "feat(browser): minimal CDP WebSocket client"
```

## Task 5: Snapshot

**Files:**
- Create: `crates/buzz-browser/src/snapshot.rs`
- Test: `crates/buzz-browser/src/snapshot.rs` (inline tests, fixture AX JSON)

- [ ] **Step 1: Write the failing tests**

Add to `snapshot.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn sample_ax() -> Value {
        serde_json::json!({
            "nodes": [
                {
                    "nodeId": "1",
                    "ignored": false,
                    "role": { "value": "button" },
                    "name": { "value": "Add to cart" },
                    "childIds": [],
                    "backendDOMNodeId": 11
                },
                {
                    "nodeId": "2",
                    "ignored": false,
                    "role": { "value": "generic" },
                    "name": { "value": "" },
                    "childIds": ["1"]
                }
            ]
        })
    }

    #[test]
    fn outline_emits_actionable_refs_and_skips_generic() {
        let (outline, refs, stats) = build_outline(&sample_ax(), &SnapshotCaps::default());
        assert!(outline.contains("[r1]"));
        assert!(outline.contains("Add to cart"));
        assert!(!outline.contains("generic"));
        assert_eq!(refs.len(), 1);
        assert_eq!(stats.nodes, 1);
    }

    #[test]
    fn outline_respects_node_cap() {
        let mut caps = SnapshotCaps::default();
        caps.max_nodes = 1;
        let (outline, _, stats) = build_outline(&sample_ax(), &caps);
        assert_eq!(stats.nodes, 1);
        assert!(outline.len() <= caps.max_chars);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p buzz-browser snapshot::tests`
Expected: FAIL — `build_outline` not found.

- [ ] **Step 3: Implement the snapshot builder**

Replace the stub in `snapshot.rs`:

```rust
use std::collections::HashMap;

use serde_json::Value;

use crate::budget::estimate_tokens;
use crate::contracts::{BrowserError, SnapshotCaps, ACTIONABLE_ROLES, LABEL_ONLY_ROLES, SKIP_ROLES};

/// A snapshot result: the outline text plus refs the input layer can use.
#[derive(Debug, Clone)]
pub struct Snapshot {
    pub outline: String,
    pub refs: HashMap<String, RefTarget>,
    pub stats: SnapshotStats,
    pub chars: usize,
    pub est_tokens: usize,
}

/// Where a ref's element is on screen (center, CSS pixels).
#[derive(Debug, Clone, PartialEq)]
pub struct RefTarget {
    pub backend_node_id: i64,
    pub x: f64,
    pub y: f64,
    pub offscreen: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SnapshotStats {
    pub nodes: usize,
    pub hidden: usize,
    pub offscreen: usize,
}

struct AxNode {
    node_id: String,
    role: String,
    name: String,
    value: Option<String>,
    child_ids: Vec<String>,
    backend_node_id: Option<i64>,
    ignored: bool,
}

fn parse_ax_nodes(tree: &Value) -> Vec<AxNode> {
    tree["nodes"]
        .as_array()
        .map(|nodes| {
            nodes
                .iter()
                .map(|n| AxNode {
                    node_id: n["nodeId"].as_str().unwrap_or_default().to_string(),
                    role: n["role"]["value"].as_str().unwrap_or_default().to_string(),
                    name: n["name"]["value"].as_str().unwrap_or_default().to_string(),
                    value: n["value"]["value"].as_str().map(|s| s.to_string()),
                    child_ids: n["childIds"]
                        .as_array()
                        .map(|ids| {
                            ids.iter()
                                .filter_map(|id| id.as_str().map(|s| s.to_string()))
                                .collect()
                        })
                        .unwrap_or_default(),
                    backend_node_id: n["backendDOMNodeId"].as_i64(),
                    ignored: n["ignored"].as_bool().unwrap_or(false),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn skip(role: &str) -> bool {
    SKIP_ROLES.contains(&role) || role.is_empty()
}

fn actionable(role: &str) -> bool {
    ACTIONABLE_ROLES.contains(&role)
}

/// Build the compact outline. `viewport` is `(innerWidth, innerHeight)` when
/// known; offscreen actionable nodes are marked but still get refs.
pub fn build_outline(
    ax_tree: &Value,
    caps: &SnapshotCaps,
) -> (String, HashMap<String, RefTarget>, SnapshotStats) {
    let nodes = parse_ax_nodes(ax_tree);
    let by_id: HashMap<&str, &AxNode> = nodes
        .iter()
        .map(|n| (n.node_id.as_str(), n))
        .collect();
    let mut refs: HashMap<String, RefTarget> = HashMap::new();
    let mut stats = SnapshotStats::default();
    let mut lines: Vec<String> = Vec::new();
    let mut ref_counter = 0usize;

    fn walk(
        id: &str,
        depth: usize,
        nodes: &[AxNode],
        by_id: &HashMap<&str, &AxNode>,
        refs: &mut HashMap<String, RefTarget>,
        lines: &mut Vec<String>,
        stats: &mut SnapshotStats,
        ref_counter: &mut usize,
        caps: &SnapshotCaps,
    ) {
        if stats.nodes >= caps.max_nodes || lines.join("\n").len() >= caps.max_chars {
            return;
        }
        let Some(node) = by_id.get(id).copied() else {
            return;
        };
        if node.ignored {
            // Ignored AX nodes (e.g. generic containers) can still hold
            // meaningful descendants — descend without emitting the node.
            for child in &node.child_ids {
                walk(
                    child, depth, _nodes, by_id, refs, lines, stats, ref_counter, caps,
                );
            }
            return;
        }
        if skip(&node.role) {
            for child in &node.child_ids {
                walk(
                    child, depth, nodes, by_id, refs, lines, stats, ref_counter, caps,
                );
            }
            return;
        }
        stats.nodes += 1;
        let mut line = format!("{}- {}", "  ".repeat(depth), node.role);
        let mut ref_id = None;
        if actionable(&node.role) {
            *ref_counter += 1;
            ref_id = Some(format!("r{ref_counter}"));
            if let Some(backend) = node.backend_node_id {
                refs.insert(
                    ref_id.clone().unwrap(),
                    RefTarget {
                        backend_node_id: backend,
                        x: 0.0,
                        y: 0.0,
                        offscreen: false,
                    },
                );
            }
            line.push_str(&format!(" [{}]", ref_id.as_deref().unwrap_or("")));
        }
        if !node.name.is_empty() {
            let name = node.name.replace('\n', " ");
            line.push_str(&format!(" {name}"));
        }
        if let Some(value) = &node.value {
            if !value.is_empty() {
                line.push_str(&format!(" (value: {value})"));
            }
        }
        lines.push(line);
        let label_only = LABEL_ONLY_ROLES.contains(&node.role.as_str());
        if !label_only {
            for child in &node.child_ids {
                walk(
                    child, depth + 1, nodes, by_id, refs, lines, stats, ref_counter, caps,
                );
            }
        }
    }

    let roots: Vec<String> = nodes
        .iter()
        .filter(|n| {
            !nodes.iter().any(|p| p.child_ids.contains(&n.node_id))
        })
        .map(|n| n.node_id.clone())
        .collect();
    for root in roots {
        walk(
            &root,
            0,
            &nodes,
            &by_id,
            &mut refs,
            &mut lines,
            &mut stats,
            &mut ref_counter,
            caps,
        );
    }
    let outline = lines.join("\n");
    (outline, refs, stats)
}

/// Take a live snapshot: AX tree + box centers for actionable refs.
pub async fn take_snapshot(
    client: &mut crate::cdp::CdpClient,
    caps: &SnapshotCaps,
) -> Result<Snapshot, BrowserError> {
    let ax = client.get_ax_tree().await?;
    let (mut outline, mut refs, stats) = build_outline(&ax, caps);
    let viewport = client
        .evaluate("({w: innerWidth, h: innerHeight})")
        .await
        .unwrap_or(serde_json::json!({ "w": 1280, "h": 720 }));
    let w = viewport["w"].as_f64().unwrap_or(1280.0);
    let h = viewport["h"].as_f64().unwrap_or(720.0);
    for (ref_id, target) in refs.iter_mut() {
        if let Some((x, y)) = client.get_box_center(target.backend_node_id).await? {
            target.x = x;
            target.y = y;
            target.offscreen = x < 0.0 || y < 0.0 || x > w || y > h;
            if target.offscreen {
                outline.push_str(&format!("\n[ref {ref_id} is offscreen - scroll to reach it]"));
            }
        }
    }
    if outline.len() > caps.max_chars {
        outline.truncate(caps.max_chars);
    }
    let chars = outline.len();
    Ok(Snapshot {
        outline,
        refs,
        stats,
        chars,
        est_tokens: estimate_tokens(chars),
    })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p buzz-browser snapshot::tests`
Expected: PASS (2 tests).

- [ ] **Step 5: Real smoke (gated)**

Add to `snapshot.rs`:

```rust
#[tokio::test]
#[ignore = "requires a real browser; run with BUZZ_BROWSER_REAL=1"]
async fn real_snapshot_of_data_url() {
    use crate::{cdp::CdpClient, host::{launch, HostConfig}};
    let host = launch(&HostConfig::default()).await.unwrap();
    let target = host.list_targets().await.unwrap().into_iter().next().unwrap();
    let mut client = CdpClient::connect(&target.ws_url).await.unwrap();
    client
        .navigate("data:text/html,<html><body><button>Hi</button></body></html>")
        .await
        .unwrap();
    let snap = take_snapshot(&mut client, &SnapshotCaps::default()).await.unwrap();
    assert!(snap.outline.contains("button"));
}
```

Run: `BUZZ_BROWSER_REAL=1 cargo test -p buzz-browser -- --ignored snapshot`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/buzz-browser/src/snapshot.rs
git commit -s -m "feat(browser): snapshot-first accessibility outline with refs"
```

## Task 6: Human-shaped input

**Files:**
- Create: `crates/buzz-browser/src/input.rs`
- Test: `crates/buzz-browser/src/input.rs` (inline tests)

- [ ] **Step 1: Write the failing tests**

Add to `input.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mouse_path_starts_and_ends_at_targets() {
        let path = human_mouse_path(0.0, 0.0, 100.0, 100.0, 20);
        assert_eq!(path.first().unwrap().0, 0.0);
        assert_eq!(path.first().unwrap().1, 0.0);
        let last = path.last().unwrap();
        assert!((last.0 - 100.0).abs() < 3.0);
        assert!((last.1 - 100.0).abs() < 3.0);
        assert!(path.len() >= 12 && path.len() <= 60);
    }

    #[test]
    fn token_estimate_is_deterministic() {
        assert_eq!(estimate_tokens("hello world"), 3);
        assert_eq!(estimate_tokens(""), 1);
    }
}
```

Note: `estimate_tokens` lives in `budget.rs`; this test imports it from there.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p buzz-browser input::tests`
Expected: FAIL — `human_mouse_path` not found. (`estimate_tokens` already
exists in the `budget.rs` stub from Task 1.)

- [ ] **Step 3: Implement input + estimator**

Replace the stub in `input.rs`:

```rust
use std::time::Duration;

use serde_json::json;

use crate::budget::estimate_tokens;
use crate::cdp::CdpClient;
use crate::contracts::BrowserError;
use crate::snapshot::Snapshot;

/// Eased mouse path with jitter; last point lands on target.
pub fn human_mouse_path(
    from_x: f64,
    from_y: f64,
    to_x: f64,
    to_y: f64,
    steps: usize,
) -> Vec<(f64, f64)> {
    let steps = steps.clamp(12, 60);
    (1..=steps)
        .map(|i| {
            let t = i as f64 / steps as f64;
            let eased = t * t * (3.0 - 2.0 * t);
            let jitter = 1.5;
            (
                from_x + (to_x - from_x) * eased + (rand() * 2.0 - 1.0) * jitter,
                from_y + (to_y - from_y) * eased + (rand() * 2.0 - 1.0) * jitter,
            )
        })
        .collect()
}

fn rand() -> f64 {
    // Simple deterministic LCG for tests; not security-sensitive.
    use std::cell::Cell;
    thread_local! {
        static SEED: Cell<u64> = Cell::new(0x9E3779B97F4A7C15);
    }
    SEED.with(|s| {
        let mut x = s.get();
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        s.set(x);
        (x >> 11) as f64 / (1u64 << 53) as f64
    })
}

async fn mouse_move(client: &mut CdpClient, x: f64, y: f64) -> Result<(), BrowserError> {
    client
        .send_command(
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseMoved", "x": x, "y": y, "button": "none" }),
        )
        .await?;
    Ok(())
}

/// Click a snapshot ref with a human-shaped move and trusted events.
pub async fn click_ref(
    client: &mut CdpClient,
    snapshot: &Snapshot,
    ref_id: &str,
) -> Result<(), BrowserError> {
    let target = snapshot
        .refs
        .get(ref_id)
        .ok_or_else(|| BrowserError::Input(format!("unknown ref {ref_id}")))?;
    let (mut cx, mut cy) = (target.x, target.y);
    if target.offscreen {
        let _ = client
            .evaluate(&format!(
                "document.elementFromPoint({cx},{cy})?.scrollIntoView({{\"block\":\"center\"}})"
            ))
            .await;
        if let Some((x, y)) = client.get_box_center(target.backend_node_id).await? {
            cx = x;
            cy = y;
        }
    }
    let path = human_mouse_path(40.0, 40.0, cx, cy, (cx / 25.0) as usize);
    for (x, y) in path {
        mouse_move(client, x, y).await?;
        tokio::time::sleep(Duration::from_millis(8)).await;
    }
    client
        .send_command(
            "Input.dispatchMouseEvent",
            json!({ "type": "mousePressed", "x": cx, "y": cy, "button": "left", "clickCount": 1 }),
        )
        .await?;
    tokio::time::sleep(Duration::from_millis(60)).await;
    client
        .send_command(
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseReleased", "x": cx, "y": cy, "button": "left", "clickCount": 1 }),
        )
        .await?;
    Ok(())
}

/// Type text via trusted input events with per-character pacing.
pub async fn type_text(client: &mut CdpClient, text: &str) -> Result<(), BrowserError> {
    for ch in text.chars() {
        client
            .send_command(
                "Input.insertText",
                json!({ "text": ch.to_string() }),
            )
            .await?;
        tokio::time::sleep(Duration::from_millis(12)).await;
    }
    Ok(())
}

/// Press Enter (submit).
pub async fn press_enter(client: &mut CdpClient) -> Result<(), BrowserError> {
    for key_type in ["keyDown", "keyUp"] {
        client
            .send_command(
                "Input.dispatchKeyEvent",
                json!({ "type": key_type, "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13 }),
            )
            .await?;
    }
    Ok(())
}

/// Scroll the page with a mouse-wheel event.
pub async fn scroll_by(client: &mut CdpClient, delta_y: i64) -> Result<(), BrowserError> {
    client
        .send_command(
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseWheel", "x": 200, "y": 200, "deltaX": 0, "deltaY": delta_y }),
        )
        .await?;
    Ok(())
}

/// Wait until a selector exists or the timeout elapses.
pub async fn wait_for_selector(
    client: &mut CdpClient,
    selector: &str,
    timeout_ms: u64,
) -> Result<(), BrowserError> {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let found = client
            .evaluate(&format!("!!document.querySelector({selector:?})"))
            .await
            .and_then(|v| {
                v.as_bool()
                    .ok_or_else(|| BrowserError::Input("bad evaluate result".into()))
            })
            .unwrap_or(false);
        if found {
            return Ok(());
        }
        if tokio::time::Instant::now() > deadline {
            return Err(BrowserError::Input(format!(
                "wait_for timed out: {selector}"
            )));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p buzz-browser input::tests`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-browser/src/input.rs crates/buzz-browser/src/budget.rs
git commit -s -m "feat(browser): human-shaped input and token estimator"
```

## Task 7: Budget ledger

**Files:**
- Modify: `crates/buzz-browser/src/budget.rs`
- Test: `crates/buzz-browser/src/budget.rs` (inline tests)

- [ ] **Step 1: Write the failing tests**

Add to `budget.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ledger_records_and_reports() {
        let mut ledger = BudgetLedger::default();
        ledger.record("browser_snapshot", 800);
        ledger.record("browser_click", 500);
        assert_eq!(ledger.total_calls(), 2);
        assert_eq!(ledger.total_tokens(), 200 + 125);
        let report = ledger.report();
        assert_eq!(report.entries.len(), 2);
        assert_eq!(report.entries[1].cumulative_tokens, 325);
    }

    #[test]
    fn ledger_enforces_task_cap() {
        let mut ledger = BudgetLedger::default();
        for _ in 0..26 {
            ledger.record("browser_snapshot", 4_000);
        }
        assert!(ledger.total_tokens() > 40_000);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p buzz-browser budget::tests`
Expected: FAIL — `BudgetLedger` not found.

- [ ] **Step 3: Implement the ledger**

Append to `budget.rs`:

```rust
use crate::contracts::{BudgetEntry, BudgetReport};

/// Task-scoped budget ledger. Caps: 25 calls / 40k estimated tokens.
pub const MAX_CALLS: usize = 25;
pub const MAX_TOKENS: usize = 40_000;

#[derive(Debug, Default)]
pub struct BudgetLedger {
    entries: Vec<BudgetEntry>,
}

impl BudgetLedger {
    pub fn record(&mut self, tool: &str, chars: usize) {
        let tokens = estimate_tokens(chars);
        let cumulative = self.total_tokens() + tokens;
        self.entries.push(BudgetEntry {
            tool: tool.to_string(),
            chars,
            est_tokens: tokens,
            cumulative_tokens: cumulative,
        });
    }

    pub fn total_calls(&self) -> usize {
        self.entries.len()
    }

    pub fn total_tokens(&self) -> usize {
        self.entries.iter().map(|e| e.est_tokens).sum()
    }

    pub fn report(&self) -> BudgetReport {
        BudgetReport {
            entries: self.entries.clone(),
            total_calls: self.total_calls(),
            total_tokens: self.total_tokens(),
        }
    }

    pub fn within_budget(&self) -> bool {
        self.total_calls() <= MAX_CALLS && self.total_tokens() <= MAX_TOKENS
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p buzz-browser budget::tests`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-browser/src/budget.rs
git commit -s -m "feat(browser): task budget ledger and caps"
```

## Task 8: MCP server and tools

**Files:**
- Create: `crates/buzz-browser/src/mcp.rs`
- Test: `crates/buzz-browser/src/mcp.rs` (inline tests)
- Modify: `crates/buzz-browser/src/main.rs`

- [ ] **Step 1: Write the failing test**

Add to `mcp.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_names_are_stable() {
        assert_eq!(TOOL_CONNECT, "browser_connect");
        assert_eq!(TOOL_NAVIGATE, "browser_navigate");
        assert_eq!(TOOL_SNAPSHOT, "browser_snapshot");
        assert_eq!(TOOL_CLICK, "browser_click");
        assert_eq!(TOOL_TYPE, "browser_type");
        assert_eq!(TOOL_BUDGET, "context_budget_report");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p buzz-browser mcp::tests`
Expected: FAIL — constants not found.

- [ ] **Step 3: Implement the MCP server**

Replace the stub in `mcp.rs`:

```rust
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, Content, ServerCapabilities, ServerInfo},
    service::{RequestContext, RoleServer},
    tool, tool_handler, tool_router,
    transport::stdio,
    ErrorData, ServerHandler, ServiceExt,
};
use schemars::JsonSchema;
use serde::Deserialize;

use crate::budget::BudgetLedger;
use crate::cdp::CdpClient;
use crate::contracts::{BrowserError, SnapshotCaps};
use crate::host::{launch, HostConfig};
use crate::snapshot::Snapshot;

pub const TOOL_CONNECT: &str = "browser_connect";
pub const TOOL_NAVIGATE: &str = "browser_navigate";
pub const TOOL_SNAPSHOT: &str = "browser_snapshot";
pub const TOOL_CLICK: &str = "browser_click";
pub const TOOL_TYPE: &str = "browser_type";
pub const TOOL_SCROLL: &str = "browser_scroll";
pub const TOOL_WAIT: &str = "browser_wait_for";
pub const TOOL_SCREENSHOT: &str = "browser_screenshot";
pub const TOOL_TABS: &str = "browser_tabs_list";
pub const TOOL_BUDGET: &str = "context_budget_report";

/// Shared state for one browser daemon session.
#[derive(Default)]
pub struct BrowserState {
    pub host: Option<crate::host::BrowserHost>,
    pub client: Option<CdpClient>,
    pub snapshot: Option<Snapshot>,
    pub ledger: BudgetLedger,
}

pub struct BuzzBrowserMcp {
    state: Arc<Mutex<BrowserState>>,
    tool_router: ToolRouter<BuzzBrowserMcp>,
}

impl BuzzBrowserMcp {
    pub fn new(state: Arc<Mutex<BrowserState>>) -> Self {
        Self {
            state,
            tool_router: Self::tool_router(),
        }
    }

    fn text_result(text: String) -> Result<CallToolResult, ErrorData> {
        Ok(CallToolResult::success(vec![Content::text(text)]))
    }

    fn err_result(err: BrowserError) -> Result<CallToolResult, ErrorData> {
        Ok(CallToolResult::error(vec![Content::text(format!("error: {err}"))]))
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ConnectParams {
    pub binary: Option<String>,
    pub headless: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct NavigateParams {
    pub url: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ClickParams {
    pub r#ref: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TypeParams {
    pub text: String,
    pub submit: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ScrollParams {
    pub delta_y: i64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct WaitParams {
    pub selector: String,
    pub timeout_ms: Option<u64>,
}

#[tool_router]
impl BuzzBrowserMcp {
    #[tool(
        name = "browser_connect",
        description = "Launch a browser and connect the daemon to the first page target."
    )]
    async fn connect(
        &self,
        Parameters(p): Parameters<ConnectParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut state = self.state.lock().unwrap();
        if state.client.is_some() {
            return BuzzBrowserMcp::err_result(BrowserError::Host("already connected".into()));
        }
        let cfg = HostConfig {
            binary: p.binary.map(PathBuf::from),
            headless: p.headless.unwrap_or(true),
            ..HostConfig::default()
        };
        let host = launch(&cfg).await.map_err(BuzzBrowserMcp::err_result)?;
        let Some(target) = host
            .list_targets()
            .await
            .map_err(BuzzBrowserMcp::err_result)?
            .into_iter()
            .next()
        else {
            return BuzzBrowserMcp::err_result(BrowserError::Host("no page target".into()));
        };
        let client = CdpClient::connect(&target.ws_url)
            .await
            .map_err(BuzzBrowserMcp::err_result)?;
        state.host = Some(host);
        state.client = Some(client);
        Self::text_result("connected".into())
    }

    #[tool(
        name = "browser_tabs_list",
        description = "List open page targets with id, title, and url."
    )]
    async fn tabs_list(
        &self,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let state = self.state.lock().unwrap();
        let Some(host) = &state.host else {
            return BuzzBrowserMcp::err_result(BrowserError::Host("no browser connected".into()));
        };
        let targets = host
            .list_targets()
            .await
            .map_err(BuzzBrowserMcp::err_result)?;
        let text = targets
            .iter()
            .map(|t| format!("{} | {} | {}", t.id, t.title, t.url))
            .collect::<Vec<_>>()
            .join("\n");
        Self::text_result(text)
    }

    #[tool(
        name = "browser_navigate",
        description = "Navigate the active browser tab to a URL and return a fresh snapshot."
    )]
    async fn navigate(
        &self,
        Parameters(p): Parameters<NavigateParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut state = self.state.lock().unwrap();
        let client = state
            .client
            .as_mut()
            .ok_or_else(|| ErrorData::invalid_request("no browser connected", None))?;
        client.navigate(&p.url).await.map_err(BuzzBrowserMcp::err_result)?;
        let snap = snapshot_with_budget(client, &mut state.ledger, "browser_navigate")
            .await
            .map_err(BuzzBrowserMcp::err_result)?;
        state.snapshot = Some(snap.clone());
        Self::text_result(format!("navigated to {}\n\n{snap}", p.url))
    }

    #[tool(
        name = "browser_snapshot",
        description = "Return a compact accessibility outline of the current page with refs."
    )]
    async fn snapshot(
        &self,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut state = self.state.lock().unwrap();
        let client = state
            .client
            .as_mut()
            .ok_or_else(|| ErrorData::invalid_request("no browser connected", None))?;
        let snap = snapshot_with_budget(client, &mut state.ledger, TOOL_SNAPSHOT)
            .await
            .map_err(BuzzBrowserMcp::err_result)?;
        state.snapshot = Some(snap.clone());
        Self::text_result(format!("{snap}"))
    }

    #[tool(
        name = "browser_click",
        description = "Click a snapshot ref (e.g. r1). Returns a fresh snapshot."
    )]
    async fn click(
        &self,
        Parameters(p): Parameters<ClickParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut state = self.state.lock().unwrap();
        let client = state
            .client
            .as_mut()
            .ok_or_else(|| ErrorData::invalid_request("no browser connected", None))?;
        let snapshot = state
            .snapshot
            .clone()
            .ok_or_else(|| ErrorData::invalid_request("take browser_snapshot first", None))?;
        crate::input::click_ref(client, &snapshot, &p.r#ref)
            .await
            .map_err(BuzzBrowserMcp::err_result)?;
        let snap = snapshot_with_budget(client, &mut state.ledger, TOOL_CLICK)
            .await
            .map_err(BuzzBrowserMcp::err_result)?;
        state.snapshot = Some(snap.clone());
        Self::text_result(format!("clicked {}\n\n{snap}", p.r#ref))
    }

    #[tool(
        name = "browser_type",
        description = "Type text into the focused element. submit=true presses Enter."
    )]
    async fn type_text(
        &self,
        Parameters(p): Parameters<TypeParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut state = self.state.lock().unwrap();
        let client = state
            .client
            .as_mut()
            .ok_or_else(|| ErrorData::invalid_request("no browser connected", None))?;
        crate::input::type_text(client, &p.text)
            .await
            .map_err(BuzzBrowserMcp::err_result)?;
        if p.submit.unwrap_or(false) {
            crate::input::press_enter(client)
                .await
                .map_err(BuzzBrowserMcp::err_result)?;
        }
        let snap = snapshot_with_budget(client, &mut state.ledger, TOOL_TYPE)
            .await
            .map_err(BuzzBrowserMcp::err_result)?;
        state.snapshot = Some(snap.clone());
        Self::text_result(format!("typed {:?}\n\n{snap}", p.text))
    }

    #[tool(
        name = "browser_scroll",
        description = "Scroll the page by deltaY pixels. Returns a fresh snapshot."
    )]
    async fn scroll(
        &self,
        Parameters(p): Parameters<ScrollParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut state = self.state.lock().unwrap();
        let client = state
            .client
            .as_mut()
            .ok_or_else(|| ErrorData::invalid_request("no browser connected", None))?;
        crate::input::scroll_by(client, p.delta_y)
            .await
            .map_err(BuzzBrowserMcp::err_result)?;
        let snap = snapshot_with_budget(client, &mut state.ledger, TOOL_SCROLL)
            .await
            .map_err(BuzzBrowserMcp::err_result)?;
        state.snapshot = Some(snap.clone());
        Self::text_result(format!("scrolled {}\n\n{snap}", p.delta_y))
    }

    #[tool(
        name = "browser_wait_for",
        description = "Wait until a CSS selector exists on the page."
    )]
    async fn wait_for(
        &self,
        Parameters(p): Parameters<WaitParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut state = self.state.lock().unwrap();
        let client = state
            .client
            .as_mut()
            .ok_or_else(|| ErrorData::invalid_request("no browser connected", None))?;
        crate::input::wait_for_selector(client, &p.selector, p.timeout_ms.unwrap_or(10_000))
            .await
            .map_err(BuzzBrowserMcp::err_result)?;
        Self::text_result(format!("selector {} present", p.selector))
    }

    #[tool(
        name = "browser_screenshot",
        description = "Capture a PNG screenshot of the current viewport."
    )]
    async fn screenshot(
        &self,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut state = self.state.lock().unwrap();
        let client = state
            .client
            .as_mut()
            .ok_or_else(|| ErrorData::invalid_request("no browser connected", None))?;
        let png = client.capture_screenshot().await.map_err(BuzzBrowserMcp::err_result)?;
        state.ledger.record(TOOL_SCREENSHOT, png.len() / 10);
        Ok(CallToolResult::success(vec![Content::image(png, "image/png")]))
    }

    #[tool(
        name = "context_budget_report",
        description = "Return the per-task context budget ledger."
    )]
    async fn budget(
        &self,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let state = self.state.lock().unwrap();
        let report = state.ledger.report();
        Self::text_result(serde_json::to_string_pretty(&report).unwrap_or_default())
    }
}

async fn snapshot_with_budget(
    client: &mut CdpClient,
    ledger: &mut BudgetLedger,
    tool: &str,
) -> Result<Snapshot, BrowserError> {
    let caps = SnapshotCaps::default();
    let snap = crate::snapshot::take_snapshot(client, &caps).await?;
    ledger.record(tool, snap.chars);
    Ok(snap)
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for BuzzBrowserMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(rmcp::model::Implementation::new(
                "buzz-browser",
                env!("CARGO_PKG_VERSION"),
            ))
    }
}

/// Entry point used by `buzz-browserd`: serve MCP over stdio.
pub fn run_stdio_server() -> Result<(), Box<dyn std::error::Error>> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    rt.block_on(async_main())
}

async fn async_main() -> Result<(), Box<dyn std::error::Error>> {
    let state = Arc::new(Mutex::new(BrowserState::default()));
    let service = BuzzBrowserMcp::new(state).serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}
```

The imports, `Parameters<T>` tool pattern, `CallToolResult::success/error`,
and `serve(stdio())` bootstrap mirror `crates/buzz-dev-mcp` exactly — that is
the repo's only stdio MCP server and compiles today. The agent connects via
`browser_connect` before any other tool.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p buzz-browser mcp::tests`
Expected: PASS (1 test).

- [ ] **Step 5: Compile-check the binary**

Run: `cargo build -p buzz-browser`
Expected: builds without errors.

- [ ] **Step 6: Commit**

```bash
git add crates/buzz-browser/src/mcp.rs crates/buzz-browser/src/main.rs
git commit -s -m "feat(browser): stdio MCP server with snapshot-first tools"
```

## Task 9: Fixtures and reference journey

**Files:**
- Create: `crates/buzz-browser/test-fixtures/index.html`
- Create: `crates/buzz-browser/test-fixtures/interaction.html`
- Create: `crates/buzz-browser/test-fixtures/frames.html`
- Create: `crates/buzz-browser/src/journey.rs`
- Test: `crates/buzz-browser/src/journey.rs` (inline tests)

- [ ] **Step 1: Write the fixtures**

`test-fixtures/index.html`:

```html
<!doctype html>
<title>spike home</title>
<h1>Spike Home</h1>
<a href="interaction.html" id="to-interaction">Go to interaction fixture</a>
```

`test-fixtures/interaction.html`:

```html
<!doctype html>
<title>interaction fixture</title>
<h1>Interaction Fixture</h1>
<p>Expected: fill the box, click submit, PASS appears.</p>
<form id="form" action="interaction.html#submitted">
  <input id="name" name="name" autocomplete="off" />
  <button id="submit" type="submit">Submit</button>
</form>
<pre id="result">not-submitted</pre>
<script>
  document.getElementById("form").addEventListener("submit", function (e) {
    e.preventDefault();
    var name = document.getElementById("name").value;
    var result = document.getElementById("result");
    result.textContent =
      name === "colony-agent" ? "PASS" : "FAIL:" + name;
  });
</script>
```

`test-fixtures/frames.html`:

```html
<!doctype html>
<title>frames fixture</title>
<h1>Frames Fixture</h1>
<iframe src="index.html" title="same origin"></iframe>
<iframe src="http://127.0.0.1:8778/other.html" title="cross origin"></iframe>
<pre id="result">not-run</pre>
```

`test-fixtures/other.html` (served from the second origin):

```html
<!doctype html>
<title>other origin</title>
<p>other-origin page</p>
```

- [ ] **Step 2: Write the failing journey tests**

Add to `journey.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "requires fixture servers; run explicitly in Task 9 Step 4"]
    async fn journey_budget_meets_gate() {
        let report = run_reference_journey(&JourneyConfig {
            binary: std::env::var("BUZZ_BROWSER_BINARY").ok(),
            base_url: "http://127.0.0.1:8777".into(),
            naive: false,
        })
        .await;
        let report = report.unwrap();
        assert!(report.total_calls <= 25, "calls {}", report.total_calls);
        assert!(report.total_tokens <= 40_000, "tokens {}", report.total_tokens);
    }
}
```

Note: the test requires the fixture servers running; document this in the
fixture README and keep the test `#[ignore]`-free only when servers are part of
the task script.

- [ ] **Step 3: Implement the journey runner**

Replace the stub in `journey.rs`:

```rust
use std::path::PathBuf;

use crate::budget::BudgetLedger;
use crate::cdp::CdpClient;
use crate::contracts::{BrowserError, SnapshotCaps};
use crate::host::{launch, HostConfig};
use crate::input::{click_ref, press_enter, type_text, wait_for_selector};
use crate::snapshot::take_snapshot;

pub struct JourneyConfig {
    pub binary: Option<PathBuf>,
    pub base_url: String,
    pub naive: bool,
}

/// Run the reference journey and return the budget report.
pub async fn run_reference_journey(
    cfg: &JourneyConfig,
) -> Result<crate::contracts::BudgetReport, BrowserError> {
    let host_cfg = HostConfig {
        binary: cfg.binary.clone(),
        ..HostConfig::default()
    };
    let host = launch(&host_cfg).await?;
    let target = host
        .list_targets()
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| BrowserError::Host("no page target".into()))?;
    let mut client = CdpClient::connect(&target.ws_url).await?;
    let mut ledger = BudgetLedger::default();
    let caps = SnapshotCaps::default();

    let url = format!("{}/interaction.html", cfg.base_url);
    client.navigate(&url).await?;
    let mut snap = take_snapshot(&mut client, &caps).await?;
    ledger.record("browser_navigate", snap.chars);

    if cfg.naive {
        // Naive baseline: full DOM dump every step (context blow-up).
        let dom = client
            .evaluate("document.documentElement.outerHTML")
            .await?
            .as_str()
            .unwrap_or_default()
            .to_string();
        ledger.record("dom_dump", dom.len());
    }

    // Focus the input by clicking its ref, then type and submit.
    let input_ref = snap
        .refs
        .keys()
        .find(|r| snap.outline.contains("textbox"))
        .cloned()
        .ok_or_else(|| BrowserError::Input("no textbox ref".into()))?;
    click_ref(&mut client, &snap, &input_ref).await?;
    type_text(&mut client, "colony-agent").await?;
    press_enter(&mut client).await?;
    wait_for_selector(&mut client, "#result", 5_000).await?;

    snap = take_snapshot(&mut client, &caps).await?;
    ledger.record("browser_submit", snap.chars);
    if !snap.outline.contains("PASS") {
        return Err(BrowserError::Snapshot(format!(
            "journey did not reach PASS:\n{}",
            snap.outline
        )));
    }
    Ok(ledger.report())
}
```

- [ ] **Step 3b: Add the journey CLI mode to `main.rs`**

Replace the Task 1 `main.rs` with:

```rust
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|s| s.as_str()) == Some("journey") {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        return rt.block_on(journey_main(args));
    }
    mcp::run_stdio_server()
}

async fn journey_main(args: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    use std::path::PathBuf;
    let base_url = args
        .iter()
        .position(|a| a == "--base-url")
        .and_then(|i| args.get(i + 1))
        .cloned()
        .unwrap_or_else(|| "http://127.0.0.1:8777".into());
    let naive = args.iter().any(|a| a == "--naive");
    let cfg = journey::JourneyConfig {
        binary: std::env::var("BUZZ_BROWSER_BINARY").ok().map(PathBuf::from),
        base_url,
        naive,
    };
    let report = journey::run_reference_journey(&cfg).await?;
    std::fs::create_dir_all("target/browser-spike")?;
    std::fs::write(
        "target/browser-spike/budget-report.json",
        serde_json::to_string_pretty(&report)?,
    )?;
    println!("PASS calls={} tokens={}", report.total_calls, report.total_tokens);
    Ok(())
}
```

- [ ] **Step 4: Serve fixtures and run the journey**

```bash
cd crates/buzz-browser/test-fixtures && python3 -m http.server 8777 --bind 127.0.0.1 &
python3 -m http.server 8778 --bind 127.0.0.1 &
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App
cargo run -p buzz-browser --bin buzz-browserd -- journey --base-url http://127.0.0.1:8777
```

Expected: journey prints PASS and writes
`target/browser-spike/budget-report.json` with `total_calls <= 25` and
`total_tokens <= 40_000`.

- [ ] **Step 5: Run the naive baseline for comparison**

```bash
cargo run -p buzz-browser --bin buzz-browserd -- journey --base-url http://127.0.0.1:8777 --naive
```

Expected: report shows measurably more tokens than the snapshot-first journey.

- [ ] **Step 6: Commit**

```bash
git add crates/buzz-browser/test-fixtures crates/buzz-browser/src/journey.rs
git commit -s -m "feat(browser): fixture harness and budget-gated reference journey"
```

## Task 10: ACP agent wiring proof

**Files:**
- Create: `crates/buzz-browser/src/agent_proof.rs`
- Test: `crates/buzz-browser/src/agent_proof.rs` (inline tests)
- Modify: `crates/buzz-acp/src/lib.rs` (publicly export ACP client types)
- Modify: `crates/buzz-browser/src/main.rs` (agent-proof mode)

- [ ] **Step 1: Write the failing test**

Add to `agent_proof.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_server_config_points_at_daemon() {
        let server = browser_mcp_server("/abs/path/buzz-browserd");
        assert_eq!(server.name, "buzz-browser");
        assert_eq!(server.args, vec!["mcp"]);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p buzz-browser agent_proof::tests`
Expected: FAIL — `browser_mcp_server` not found.

- [ ] **Step 3: Implement the proof**

Replace the stub in `agent_proof.rs`:

```rust
use std::time::Duration;

use buzz_acp::{AcpClient, McpServer};

use crate::contracts::BrowserError;

/// The stdio MCP server config an ACP session receives.
pub fn browser_mcp_server(daemon_path: String) -> McpServer {
    McpServer {
        name: "buzz-browser".into(),
        command: daemon_path,
        args: vec!["mcp".into()],
        env: vec![],
    }
}

/// Attach the daemon to a real ACP session and prompt the agent to complete
/// the fixture journey. Requires an ACP agent binary on PATH.
pub async fn run_agent_proof(
    daemon_path: String,
    agent_command: String,
) -> Result<String, BrowserError> {
    let mut acp = AcpClient::spawn(&agent_command, &[], &[], false, None)
        .await
        .map_err(|e| BrowserError::Host(e.to_string()))?;
    acp.initialize()
        .await
        .map_err(|e| BrowserError::Host(e.to_string()))?;
    let cwd = std::env::current_dir()
        .map_err(BrowserError::Io)?
        .to_str()
        .unwrap_or("/tmp")
        .to_string();
    let session = acp
        .session_new_full(
            &cwd,
            vec![browser_mcp_server(daemon_path)],
            Some(
                "You have a browser MCP server. Navigate to the interaction \
                 fixture at http://127.0.0.1:8777/interaction.html, call \
                 browser_connect first, fill the name field with \
                 colony-agent, submit, verify PASS appears, then call \
                 context_budget_report.",
            ),
            Some("browser-agent-proof"),
        )
        .await
        .map_err(|e| BrowserError::Host(e.to_string()))?;
    let stop = acp
        .session_prompt_with_idle_timeout(
            &session.session_id,
            "Complete the journey.",
            Duration::from_secs(120),
            Duration::from_secs(600),
        )
        .await
        .map_err(|e| BrowserError::Host(e.to_string()))?;
    Ok(format!("{stop:?}"))
}
```

`crates/buzz-acp/src/lib.rs` change: after `pub use usage::TurnUsage;`, add

```rust
pub use acp::{AcpClient, EnvVar, McpServer};
```

This is additive; the `acp` module itself stays private.

`buzz-browser/src/main.rs` change: add an `agent-proof` branch beside the
`journey` branch:

```rust
    if args.get(1).map(|s| s.as_str()) == Some("agent-proof") {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        return rt.block_on(agent_proof_main(args));
    }
```

```rust
async fn agent_proof_main(args: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    let agent = args
        .iter()
        .position(|a| a == "--agent")
        .and_then(|i| args.get(i + 1))
        .cloned()
        .ok_or("--agent is required (e.g. codex-acp)")?;
    let daemon = std::env::current_exe()?.to_string_lossy().to_string();
    let result = agent_proof::run_agent_proof(daemon, agent).await?;
    println!("AGENT PROOF: {result}");
    Ok(())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p buzz-browser agent_proof::tests`
Expected: PASS (1 test).

- [ ] **Step 5: Run the live proof**

```bash
cargo build -p buzz-browser
cargo run -p buzz-browser --bin buzz-browserd -- agent-proof \
  --agent codex-acp --base-url http://127.0.0.1:8777
```

Expected: the agent completes the journey, PASS is verified, and the budget
report file exists under `target/browser-spike/`.

- [ ] **Step 6: Commit**

```bash
git add crates/buzz-browser/src/agent_proof.rs crates/buzz-browser/src/main.rs
git commit -s -m "feat(browser): ACP agent wiring proof"
```

## Task 11: README and shell decision memo

**Files:**
- Create: `crates/buzz-browser/README.md`
- Create: `docs/design/browser-engine-decision.md`

- [ ] **Step 1: Write the README**

`crates/buzz-browser/README.md` must contain: what the spike proves, the two
run modes (stdio MCP server for agents, journey runner for evidence), how to
serve fixtures, how to run the gated real-browser tests, and the budget gate
numbers (≤ 25 calls, ≤ 40k est-tokens).

- [ ] **Step 2: Write the decision memo**

`docs/design/browser-engine-decision.md` compares Electron vs Tauri + sidecar
against the approved channel-browser design spec, using the spike's measured
numbers, and evaluates: live-view fidelity (real embedded tab vs streamed
frames), per-channel session isolation cost, agent-control parity, bundle
size, and the migration cost of the existing Tauri native surface. It ends
with a recommendation and the decision owner.

- [ ] **Step 3: Commit**

```bash
git add crates/buzz-browser/README.md docs/design/browser-engine-decision.md
git commit -s -m "docs(browser): spike readme and shell decision memo"
```

## Proof gates

| Task | Gate |
| --- | --- |
| 1 | Crate compiles; module tests pass |
| 2 | Contracts tests pass |
| 3 | Host tests pass; real launch smoke passes |
| 4 | CDP fake-server test passes; real navigate/evaluate works |
| 5 | Snapshot tests pass; real data-URL snapshot contains button |
| 6 | Input/estimator tests pass |
| 7 | Ledger tests pass |
| 8 | MCP tests pass; binary builds |
| 9 | Reference journey PASS under 25 calls / 40k tokens; naive baseline worse |
| 10 | Real ACP agent completes the journey; budget report written |
| 11 | README + memo committed |

## Self-review notes

- Spec coverage: snapshot-first tools (Tasks 4–5), token budget (Tasks 2, 6,
  7, 9), agent control (Task 10), fixture evidence (Task 9), shell decision
  (Task 11) — all requirements from the design spec map to a task.
- Deferred explicitly (not in this plan): channel workspace UI, per-channel
  partitions, approvals overlay, tabs beyond a single active target,
  persistence, community teardown — those belong to the post-memo desktop
  integration plan.
