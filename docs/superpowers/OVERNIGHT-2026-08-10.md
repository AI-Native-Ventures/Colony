# Overnight evidence record: workspace Web tab

Date: 2026-08-10

Branch: `feat/workspace-web-tab`

Merge base: `origin/develop` at `c8c1046e4a`

Current source head at the time this record was drafted: `cd99e116f0`

This record keeps implementation, focused local testing, packaged local proof,
commit, push, pull request, hosted CI, and merge as separate states. A local
pass is not called a packaged pass, and a packaged pass is not called stable.

## Status at the evidence boundary

| State | What is true | Evidence or boundary |
| --- | --- | --- |
| Implemented | The default-off Web workspace tab, owned browser launch, CDP frame, input forwarding, lifecycle cleanup, focused proofs, and diagnostics are implemented. | The 27 commits listed below. |
| Focused locally tested | Rust lifecycle tests, engine Chromium and WebKit input tests, scoped clippy, targeted Rust tests, type checks, formatting, and file-size checks passed as recorded below. | These are local tests, not packaged proof. |
| Packaged locally proven | One packaged bundle run passed far enough to show a real CDP frame, real input receipts, visual PASS, and owned process cleanup. | The pass artifact is retained, but Flow 08 is flaky and must not be called stable. |
| Committed | All plan commits through `cd99e116f0` are committed with DCO trailers. | `git log c8c1046e4a..cd99e116f0`. |
| Pushed | The branch was previously pushed through `909ca5ad96`; the Task 7 documentation commit and later local commits require the real-hook push in this task. | Final remote SHA is recorded after the push. |
| PR open | Not yet at the time of drafting this pre-PR record. | Task 7 opens the PR against `develop`. |
| Hosted CI passed | Not yet claimed. Hosted CI runs for PRs targeting `develop`; the final check state is recorded after the PR watch. | No local result is substituted for hosted CI. |
| Merged | No. This task does not merge. | Merge remains a separate decision. |

## What is proven

### Owned-browser lifecycle

Real headless Chromium lifecycle is proven by ignored tests that run with
`BUZZ_BROWSER_REAL=1`, using the real `WebManager::start` chain after the Task 3
fix. The three teardown paths are covered in seconds without a packaged build:

- `close` reaps the browser owned by one session.
- `close_all_async` reaps every owned browser for community reset.
- Synchronous `close_all` reaps every owned browser for app quit, matching the
  production shutdown path.

The GREEN command was:

```text
. ./bin/activate-hermit && BUZZ_BROWSER_REAL=1 cargo test --manifest-path desktop/src-tauri/Cargo.toml web_lifecycle_tests -- --ignored --nocapture --test-threads=1
```

It reported three passed tests in 3.70 seconds. Each test asserts that the
owned browser PID disappears. The tests now use `AppHandle<R>` generics through
`start`, `start_inner`, `run_session`, `run_session_loop`, `emit_frame`, and
`emit_error` so the mock runtime drives the product start path. No production
logic was changed by that generic widening.

The lower `buzz-browser` proof also runs a real owned launch and host drop. Its
GREEN run passed in 1.12 seconds and the process probe found no matching
Chromium process. Attached browser ownership remains a separate existing test:
an attached browser is not treated as owned.

### Real packaged bundle

The retained packaged pass artifact is the `08-web.png` captured by the first
Task 6 evidence commit. Its SHA-256 was:

```text
cc174b0679208458ff649b570dcefbb7a6ce3e62657d63b67d51b46c648a5e10
```

I inspected that image. It shows the Colony window, one URL bar containing the
fixture URL, no DevTools endpoint or target ID controls, the remote fixture
filling the workspace panel with no grey gutters, the entered `colony-web`
value, and the green fixture PASS state. The packaged journey used real Tauri
IPC, an owned headless Chromium, a non-empty `Page.startScreencast` frame, real
pointer and keyboard input, and a screenshot.

The pass ledger line from that artifact was:

```json
{"flow":"08-workspace-web","status":"pass","detail":"fixture=http://127.0.0.1:54135/ browserPid=71271","at":"2026-08-10T12:33:24.927Z"}
```

That is evidence of one packaged pass, not evidence that the flow is stable.

### Engine input parity

The `engine-chromium` and `engine-webkit` Playwright projects use real driver
mouse, wheel, keyboard, and Enter input against the mock bridge. The final
focused run after the diagnostic fix reported 10 passed tests in 30.7 seconds.
WebKit is the closest fast signal for the packaged macOS webview input path.

The feature remains preview-only and default-off:

```json
{"id":"workspaceWebTab","defaultEnabled":false}
```

The packaged flow enables only this flag in isolated harness local storage.

### Clippy and focused gates

The desktop crate command below passed after the pre-existing baseline errors
were fixed in Task 8:

```text
. ./bin/activate-hermit && cargo clippy --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
```

The `buzz-browser` command also passed:

```text
. ./bin/activate-hermit && cargo clippy -p buzz-browser --all-targets -- -D warnings
```

The Task 8 fixes were a domain alias for `WebShutdownWork` and the intended
`result?` rewrite. No lint suppression was added. `desktop/src-tauri/src/web.rs`
is 982 lines against the hard 1000-line ceiling. Targeted Rust tests, Rust
format checking, `desktop` harness typecheck, Biome, and the file-size gate
passed in their respective focused runs.

## The defect found by moving proof down a layer

The Web tab's wheel input was broken in every environment. The window-level
`useWebviewScrollBoundaryLock` listener runs during capture and consumes wheel
events whose path has no app-local scroll container. The Web screencast surface
is deliberately `overflow-hidden`, so every remote wheel was
`preventDefault`-ed and stopped before React's `onWheel` could forward it.

The packaged run made this look like a WebKit or Tauri boundary limitation. The
25-second Chromium and WebKit engine test exposed the real product bug. Commit
`b4458f2b666978981f577877529704329b02360c` added the explicit
`data-buzz-wheel-forwarding` opt-out marker to the Web surface. The lock now
leaves that surface's wheel event for React, which forwards it through CDP.
The engine test asserts a real wheel produces a `workspace_web_wheel` command.

This is the clearest result of the restructure: a product defect that took
packaged iterations to misdiagnose was isolated and fixed by a fast parity
test.

## Flow 08 instability and remaining proof boundary

Flow 08 must not be described as stable. There are four packaged attempts:

1. Task 6 attempt 1 failed after the fresh build with:
   `fixture never reported target coordinates for 756x469`.
2. Task 6 attempt 2 used `--no-build`, with no source change, and passed at
   `2026-08-10T12:33:24.927Z` with browser PID 71271. This produced the
   inspected `cc174b...` screenshot.
3. Task 9 run 1 passed at `2026-08-10T12:49:29.570Z` with fixture port 58463
   and browser PID 94180. Its inspected screenshot SHA was
   `042b4bf1d39976c02a1c991f7d54197d55ae8afa3c09a14120be0f987dd5c464`.
4. Task 9 run 2, with no code change after run 1, failed after 1m07.7s with:
   `fixture never reported target coordinates for a stable current viewport`.

The current result ledger therefore ends with this failure line:

```json
{"flow":"08-workspace-web","status":"fail","detail":"fixture never reported target coordinates for a stable current viewport","at":"2026-08-10T12:52:06.379Z"}
```

The Task 9 stability change is kept because it removes a demonstrated stale
frame-metrics snapshot race and pairs accepted fixture targets with the same
live metrics. It did not eliminate the flake. No further packaged run or build
was authorized.

Task 10 moved the resize question to the fast engine layer. Chromium and WebKit
both converge at exactly one resize command after one viewport change, and no
command grows during the second settle window. This is a true invariant for the
current mock path because the React observer records `lastSize` before the
asynchronous resize call and the mock bridge always emits a fixed 640x360 frame.
It is not a packaged CDP guarantee. The mock cannot model native intermediate
frame sizes.

The next authorized packaged diagnostic is one timestamped
`workspace_web_resize` sequence carrying every width and height payload, or an
equivalent invocation counter, from the packaged path. The 20-sample viewport
trace added by `cd99e116f0` distinguishes frame-size change from fixture receipt
lag, but viewport samples alone cannot prove resize-call oscillation.

## RED before GREEN evidence

### Task 2: owned browser host drop

With only the custom `BrowserHost::Drop` body neutralized, the test passed
unexpectedly because `kill_on_drop(true)` was a second teardown path. The
implementer then disabled both the custom drop body and `kill_on_drop` for the
probe. The real RED command failed after the full timeout with:

```text
thread 'host::tests::real_owned_launch_exposes_a_pid_and_reaps_it_on_drop' panicked at crates/buzz-browser/src/host.rs:466:9:
owned browser 34040 survived the host drop
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 29 filtered out; finished in 31.24s
```

The production changes were reverted before the GREEN run. The final test
passed in 1.12 seconds and no profile Chromium remained.

### Task 3: WebManager lifecycle

Each of the three lifecycle tests was independently red with only its method
neutralized. The exact failures were:

```text
browser 88111 survived session close
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 2227 filtered out; finished in 31.18s
```

```text
browser 90392 survived close_all
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 2227 filtered out; finished in 32.53s
```

```text
browser 93548 survived synchronous close_all
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 2227 filtered out; finished in 30.99s
```

The corresponding GREEN command reported all three tests passed in 3.70
seconds. No other teardown path was disabled for these probes, and no matching
remote-debugging process remained after cleanup.

## Task 5 decision

Task 5 was skipped by the controller. It would have repeated the expensive
packaged build and flow iteration after the focused proof had moved to Rust and
engine projects. The later Task 6 packaged run was the one authorized bundle
attempt, followed by one no-build retry and the explicitly stopped Task 9
verification pair. No additional packaged build is claimed here.

## Local CI and hook history

Broad local CI was skipped by owner instruction throughout this plan. No
`just ci`, `pnpm check`, workspace-wide clippy, or workspace-wide test run is
claimed as local evidence.

Commits through `909ca5ad9615fcfa6906904f6144dd5601a4eac3` were pushed with
`core.hooksPath=/dev/null` on the owner's authorization because the normal
pre-push hook invoked prohibited broad jobs. That authorization was revoked
once clippy was green. From the `909ca5ad96` evidence boundary onward, the
real hooks ran and passed in 112.96 seconds as recorded by the packaged proof
task. The Task 7 commit and push must also use the real hooks; a blocked hook
will be reported rather than bypassed.

## Every plan commit

All 27 commits below are committed on this branch. The early implementation
and design commits establish the feature and its proof surfaces; the later
focused and packaged commits establish the evidence described above.

| Commit | Subject | What it establishes |
| --- | --- | --- |
| `d312ae8477254382d495807bc6a7d7be1f61583c` | `feat(desktop): add CDP web workspace tab` | Initial Web tab implementation. |
| `7e59a9e65c7adedb3e13ced96d60e9280ab77ace` | `fix(desktop): gate and fence web workspace starts` | Start gating and generation fencing. |
| `424bd3bbced7dfb54a03ffa62edb20f0e0e25c34` | `docs(workspace): define packaged web tab proof` | Initial packaged proof contract. |
| `7d47c8d868ce3f042bcc53ee6469ac40b2f6f99d` | `docs(workspace): plan packaged web tab proof` | Execution plan for the packaged proof. |
| `3b99f51d0f1e934bc46229b05e119529b58e0cb1` | `chore(desktop): reconcile web native inventory` | Generated native inventory alignment. |
| `6d51c4723a1a0080cf92dd2308cb6925c3774556` | `test(workspace): expose owned web process proof` | Runtime PID exposure for owned sessions. |
| `d2bdd05e4e4afb5bf548d010fb94ec760124f630` | `test(workspace): add deterministic web tab fixture` | Loopback fixture and receipts. |
| `1d0b246ba5e367aeff467e3f425d44d81e324267` | `test(workspace): prove packaged web tab journey` | Initial packaged journey coverage. |
| `2ec735ef8fd091c4ea8d23f272f36d0f9a6802e3` | `fix(workspace): forward webview mouse input` | Real mouse forwarding fix. |
| `2f144caf7ba3d0b92207c527506ae34e1a8e6b0d` | `test(workspace): stabilize packaged web journey` | Packaged journey waits and receipts. |
| `44055c13f105e05a3243a5768cb6c095f3c0c29a` | `feat(workspace): make web tabs fill the panel` | Full-panel Web surface layout. |
| `31d209a304c9c803790122bc04702affd284a74b` | `test(workspace): prove full browser surface` | Surface fill proof. |
| `ff3ec194b3f8d510ffa260af12833995e9da8a25` | `test(workspace): sync web fixture viewport` | Fixture viewport synchronization. |
| `b4458f2b666978981f577877529704329b02360c` | `fix(workspace): let the web tab receive wheel gestures` | Product wheel forwarding bug fix. |
| `1238a70e32ee74e3e59f321de318fa68b06ec69e` | `docs(workspace): plan the web tab proof restructure` | Proof-layer restructure plan. |
| `1fb6b2f2e62df06e42f3074a67c7922ce8eb8710` | `docs(workspace): drop em-dash from restructure plan` | Text constraint correction. |
| `f1814a28f8217515604fc52dc49b5981ae9baf12` | `docs(workspace): record shipped web tab chrome and wheel fix` | Design amendments and proof layering record. |
| `5f760c96ad7b6800ca106ba98e928251f389bcdb` | `test(browser): prove an owned browser is reaped on host drop` | RED/GREEN owned host-drop proof. |
| `0bf181a115bf9d8d6b6ee43dfc2e725ff44d0c61` | `docs(browser): correct hook-bypass attribution and note dual teardown path` | Corrected evidence and teardown caveat. |
| `393bbedd88c8931c8733ff01441a66d6a0c25786` | `test(workspace): prove web session teardown without the packaged app` | Initial native lifecycle tests. |
| `248d33b12c1a236727908acf96ea56fbc68069fa` | `test(workspace): exercise product web lifecycle in mock runtime` | Real `WebManager::start` path and synchronous shutdown proof. |
| `eb0cf3469af2d531f6aef308ba3bcca6216ff105` | `test(workspace): narrow packaged web flow to bundle-only proof` | Packaged flow retains signed-bundle-only assertions. |
| `10b5bc8f9789beaea7f0c3c17c956bbb9bdd1bfc` | `fix(desktop): clear workspace web clippy lints` | Desktop and browser clippy green; web.rs at 982 lines. |
| `909ca5ad9615fcfa6906904f6144dd5601a4eac3` | `test(workspace): record packaged web tab proof artifacts` | Inspected packaged pass artifact and cleanup evidence. |
| `3c31a9b2eb1b08c8561319693761476372876748` | `test(workspace): stabilize web fixture viewport receipt` | Removes stale metrics snapshot race; does not make flow stable. |
| `9953f77fb0415aecee4b9f50ebdf18b5ef53dea7` | `test(workspace): guard web resize convergence` | Mock-layer convergence guard in both engines. |
| `cd99e116f09c00cfcad76cdce0fa7699cb913e55` | `test(workspace): improve resize diagnostics` | Bounded timeout trace and explicit mock proof boundary. |

## Task 7 state after the PR handoff

This section is updated by the Task 7 report after the documentation commit,
push, PR creation, screenshot comment, and hosted CI watch. Until then, the
states above remain the only claims made by this record.
