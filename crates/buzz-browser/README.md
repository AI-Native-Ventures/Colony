# buzz-browser

Shell-agnostic browser engine spike for the Colony channel browser workspace:
a Rust daemon that launches a real Chromium, controls it over CDP, exposes
snapshot-first MCP tools over stdio, and enforces a per-task context budget.

## What this proves

- A real browser tab can be launched, navigated, snapshotted (accessibility
  outline with `rN` refs), clicked, typed into, and verified — all over CDP.
- The snapshot-first information diet keeps agent context tiny: the reference
  journey completes in **2 calls / 148 estimated tokens** vs **3 calls / 317
  estimated tokens** for the naive DOM-dump baseline.
- The daemon is a stdio MCP server, so any ACP agent
  (`goose acp`, `codex-acp`, `claude-agent-acp`) can attach it as an MCP server
  without desktop or relay changes.
- The daemon can drive a browser it did **not** launch. Given a DevTools
  endpoint it attaches to an existing tab and never owns the process, which is
  what lets an agent drive the exact tab a human is watching inside a shell.
  This is the capability no off-the-shelf browser MCP server provides: they all
  launch a browser of their own.

## Run modes

### 1. Stdio MCP server (for agents)

```bash
cargo run -p buzz-browser --bin buzz-browserd
```

The agent's ACP session attaches it as an MCP server named `buzz-browser` and
calls `browser_connect` before any other tool. Tool set:
`browser_connect`, `browser_tabs_list`, `browser_navigate`,
`browser_snapshot`, `browser_click`, `browser_type`, `browser_scroll`,
`browser_wait_for`, `browser_screenshot`, `context_budget_report`.

#### Launch vs attach

`browser_connect` has two modes:

| Arguments | Behaviour |
| --- | --- |
| none (or `binary` / `headless`) | Launches its own Chromium with a spike profile. The daemon owns the process and kills it on drop. |
| `endpoint` (+ optional `target_id`) | Attaches to a browser already running at that DevTools endpoint. The daemon never owns the process; dropping the host leaves the browser alone. |

`endpoint` accepts a bare port, a `host:port`, or a full URL:

```json
{ "endpoint": "9222" }
{ "endpoint": "127.0.0.1:9222", "target_id": "A1B2C3" }
{ "endpoint": "http://127.0.0.1:9222" }
```

The attach mode is how a shell hands the agent a tab it owns. In Electron that
is a `WebContentsView` reachable through the app's remote debugging port; with
a sidecar Chromium it is the port the sidecar was started on. Either way the
daemon is unchanged, which is what keeps the shell decision reversible.

The tool result names the mode it took, so a caller can tell the two apart:

```
attached | A1B2C3 | https://example.com/
launched | 0A1B2C | about:blank
```

### 2. Reference journey (for evidence)

```bash
cd crates/buzz-browser/test-fixtures
python3 -m http.server 8777 --bind 127.0.0.1 &
python3 -m http.server 8778 --bind 127.0.0.1 &

cargo run -p buzz-browser --bin buzz-browserd -- journey --base-url http://127.0.0.1:8777
cargo run -p buzz-browser --bin buzz-browserd -- journey --base-url http://127.0.0.1:8777 --naive
```

The journey fills the interaction fixture, submits, verifies PASS, and writes
`target/browser-spike/budget-report.json` (reference) or
`target/browser-spike/budget-report-naive.json` (naive baseline). Gate:
**≤ 25 calls and ≤ 40,000 estimated input tokens**; the naive baseline must be
measurably worse.

### 3. Agent wiring proof

```bash
cargo run -p buzz-browser --bin buzz-browserd -- agent-proof --agent <acp-agent>
```

Requires an ACP agent binary on PATH (`goose` is auto-passed `acp`; for
`codex-acp` / `claude-agent-acp` run `npm i -g @agentclientprotocol/codex-acp`
or `@agentclientprotocol/claude-agent-acp`).

## Gated real-browser tests

```bash
BUZZ_BROWSER_REAL=1 cargo test -p buzz-browser --lib -- --ignored
```

Covers real Chrome launch/target listing and a live data-URL snapshot. The
journey test (`journey::tests::journey_budget_meets_gate`) additionally needs
the two fixture servers running.

## Budget gate

| Journey | Calls | Est. tokens |
| --- | --- | --- |
| Snapshot-first (reference) | 2 | 148 |
| Naive DOM dump baseline | 3 | 317 |
| Gate | ≤ 25 | ≤ 40,000 |

`estimate_tokens` is a deterministic heuristic (`max(1, ceil(chars/4))`);
real provider token accounting lands via the Colony ledger later.
