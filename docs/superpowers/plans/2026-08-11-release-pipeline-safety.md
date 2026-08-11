# Release Pipeline Safety Gate Implementation Plan

> **For Colony maintainers:** Execute this plan in the isolated `codex/release-pipeline-safety` worktree. Keep repository-rules mutations out of the implementation commit; apply them only after the hosted `Promotion Gate` context is visible.

**Goal:** Remove objectively duplicate post-queue CI while adding a unique production promotion gate, publication defense in depth, and a live relay version canary.

**Architecture:** Keep `.github/workflows/ci.yml` as the single source of test jobs, but route those jobs by event and raw path relevance. Required core checks remain forced for `merge_group` and `main` pull requests; secondary suites never run solely because an event is a merge group. A final `Promotion Gate` aggregates the production candidate, the tag workflow independently verifies that result, and Fly deployment gains a public readiness/version probe.

**Tech Stack:** GitHub Actions YAML, Bash, `gh api`, `curl`, `jq`, repository shell contract tests

---

## Acceptance gates

1. **Fail-first:** focused contract tests fail on the unmodified workflow for every missing safety property.
2. **Local green:** the focused release-pipeline contract, mutation probes, and mock canary scenarios pass after implementation.
3. **Diff review:** only the approved workflow, scripts/tests, and design/plan documents change; onboarding files and worktrees remain untouched.
4. **Hosted develop:** PR CI and merge-group required checks pass; the same-SHA `develop` push omits duplicate core checks and runs only relevant secondary work.
5. **Hosted promotion:** exactly one `Promotion Gate` appears and truthfully aggregates all applicable checks.
6. **Ruleset rollout:** only after gate 5, read-modify-write the live `main` and `develop` rulesets, then read them back before promotion merge.
7. **Live deployment:** a later real relay deployment is live-proven only when the public readiness and exact-version canary passes.

## Task 1: Add the fail-first pipeline contract

**Files:**

- Create: `scripts/test-release-pipeline-contract.sh`
- Modify: `scripts/test-release-ref-contract.sh`
- Test: `scripts/test-release-pipeline-contract.sh`

**Step 1: Write the structural assertions**

Create a shell contract that reads the three workflow files and asserts:

- CI still has `merge_group`.
- raw path outputs are distinct from forced core outputs;
- core jobs explicitly exclude `develop` and `main` push reruns while retaining release behavior;
- secondary jobs exclude `merge_group`, exclude `main` pushes, and use raw path relevance;
- Real-shell is explicitly disabled until executable;
- exactly one job is named `Promotion Gate`;
- the promotion job requires a `main` PR from `develop`, uses `always()`, depends on all six required checks/aggregators and all seven applicable secondary results, and rejects non-success required results;
- `.github/workflows/ci.yml` belongs to every relevant secondary path bucket;
- auto-tag verifies exactly one successful `Promotion Gate` for the merged PR before resolving or creating tags;
- Fly deploy invokes the live canary after `flyctl deploy`.

Use explicit error messages for each invariant so a failure identifies the unsafe regression.

**Step 2: Wire it into the unconditional release contract**

Append this command to `scripts/test-release-ref-contract.sh`:

```bash
"$repo_root/scripts/test-release-pipeline-contract.sh"
```

This keeps the contract inside the always-running `Detect Changed Paths` job.

**Step 3: Run against the untouched baseline and record red proof**

Run:

```bash
scripts/test-release-pipeline-contract.sh
```

Expected: non-zero, first reporting that raw versus forced outputs and/or `Promotion Gate` are absent. Preserve this output before editing workflow files.

**Step 4: Prove the test is connected**

Run:

```bash
scripts/test-release-ref-contract.sh
```

Expected: non-zero through the newly wired pipeline contract, demonstrating that the required `Detect Changed Paths` contract entry point will catch the baseline.

## Task 2: Add the live relay canary fail-first test

**Files:**

- Create: `scripts/test-verify-relay-live.sh`
- Create later: `scripts/verify-relay-live.sh`
- Modify: `scripts/test-release-pipeline-contract.sh`

**Step 1: Write mock HTTP scenarios before the implementation**

The test creates a temporary mock `curl` executable and response counter. It invokes the future script with small retry values and covers:

- readiness never becomes ready: failure;
- readiness succeeds but NIP-11 version differs: failure;
- readiness fails once, then readiness and version succeed: success;
- readiness and exact normalized version succeed immediately: success;
- a tag such as `relay-v0.8.1` is rejected as an invalid relay deployment input, while `v0.8.1`/`0.8.1` normalize to `0.8.1` according to the workflow contract.

The mock records the NIP-11 `Accept: application/nostr+json` header so the success case also proves protocol correctness.

**Step 2: Run before creating the implementation**

Run:

```bash
scripts/test-verify-relay-live.sh
```

Expected: non-zero because `scripts/verify-relay-live.sh` does not exist.

**Step 3: Add canary test to the release-pipeline contract**

Invoke `scripts/test-verify-relay-live.sh` at the end of `scripts/test-release-pipeline-contract.sh` so the unconditional release contract exercises behavior, not only workflow text.

## Task 3: Implement event-aware CI routing

**Files:**

- Modify: `.github/workflows/ci.yml`
- Test: `scripts/test-release-pipeline-contract.sh`

**Step 1: Separate raw path relevance from forced core outputs**

In `changes.outputs`, retain the existing `rust`, `desktop`, and `desktop-rust` outputs but force them for both `merge_group` and pull requests targeting `main`. Add raw outputs for every secondary ownership decision (`raw-desktop-integration`, `raw-windows`, `raw-security`, `raw-cross-compile`, `raw-web`, `raw-mobile`, `raw-blocks`) directly from dedicated `steps.filter.outputs.*` buckets. Keep the existing raw Rust/desktop outputs available for core and prerequisite routing.

Add `.github/workflows/ci.yml` to desktop, desktop-rust, web, mobile, and blocks filters; it already belongs to rust. This makes a CI workflow change exercise every secondary lane on the promotion PR without contaminating merge-group routing.

**Step 2: Route the six core checks**

Update conditions for `Rust Lint`, `Unit Tests`, the Desktop dependency chain and `Desktop` aggregator, the Relay Suites dependency chain and `Relay Suites` aggregator so:

- `merge_group`: all required work runs;
- `pull_request` to `main`: all required work runs;
- path-relevant pull requests to `develop` or `release`: current behavior remains;
- `push` to `release`: current full behavior remains;
- `push` to `develop` or `main`: core work does not re-run.

Keep `Detect Changed Paths` unconditional so the six required contexts continue to be emitted according to existing branch-protection behavior and the contract tests always execute.

**Step 3: Route secondary coverage**

Update Desktop Integration, Windows, Security, Server Cross-Compile, Web, Mobile, and Blocks conditions so they:

- use only raw path outputs;
- do not run on `merge_group`;
- do not run on `main` push;
- run on path-relevant `develop` push and pull requests;
- preserve full `release` push behavior.

Keep prerequisite artifact jobs available when an applicable secondary or required core job needs them. Do not count a prerequisite job as an extra required status context.

**Step 4: Exclude non-executable Real-shell coverage**

Keep the job definition and explanatory comments for future repair, but set an explicit false condition so it consumes no runner and cannot be mistaken for promotion proof.

**Step 5: Run the structural contract**

Run:

```bash
scripts/test-release-pipeline-contract.sh
```

Expected: still non-zero until the promotion, tag, and canary changes are complete; CI-routing assertions must now pass.

## Task 4: Add the unique Promotion Gate

**Files:**

- Modify: `.github/workflows/ci.yml`
- Test: `scripts/test-release-pipeline-contract.sh`

**Step 1: Add one final aggregation job**

Create job `promotion-gate` with dynamic display name `Promotion Gate` only for a pull request targeting `main`, and `Promotion Gate (not applicable)` otherwise. GitHub emits skipped checks for false job conditions, so this name separation prevents an old skipped merge-group check from satisfying branch protection. Keep `if: always() && github.event_name == 'pull_request' && github.base_ref == 'main'`, read-only permissions, and dependencies covering:

- `changes`
- `rust-lint`
- `unit-tests`
- `desktop-core`
- `desktop`
- `relay-suites`
- `desktop-e2e-integration`
- `windows-rust`
- `security`
- `server-cross-compile`
- `web`
- `mobile`
- `blocks-live-gate`

**Step 2: Enforce the two-branch and result contracts**

The gate script must:

- fail unless `github.head_ref` is exactly `develop`;
- require `success` from every core dependency;
- for each secondary dependency, require `success` when its corresponding raw output is `true`, otherwise allow only `success` or `skipped`;
- fail on missing, cancelled, neutral, or failed results.

Use explicit messages naming the offending dependency and result.

**Step 3: Mutation proof**

Have the contract copy `ci.yml` to a temporary directory and apply one mutation at a time, verifying rejection when:

- `merge_group` is removed;
- a core job regains unconditional push routing;
- a secondary job regains merge-group routing;
- the head-branch assertion is removed;
- one required dependency is removed from `Promotion Gate`.

Expected: every mutated copy fails its targeted assertion.

## Task 5: Make publication verify the gate

**Files:**

- Modify: `.github/workflows/auto-tag-on-release-pr-merge.yml`
- Test: `scripts/test-release-pipeline-contract.sh`

**Step 1: Add check-read permission**

Grant the auto-tag job only the additional read permission required to list check runs for the merged PR's head SHA.

**Step 2: Verify before release resolution**

Before `Resolve release lane and version`, use the default read-only `GITHUB_TOKEN` and `gh api` to fetch check runs for `github.event.pull_request.head.sha`. Filter exact-name matches for `Promotion Gate`; require count `1` and conclusion `success`. Fail before any release version is resolved or any App token with write capability is created.

Do not query the merge commit, which can acquire unrelated post-merge check runs. The gate belongs to the reviewed promotion head.

**Step 3: Contract and mutation proof**

Verify the structural contract passes, then mutate away the verification step in a temporary workflow copy and confirm the contract fails.

## Task 6: Implement and wire the live canary

**Files:**

- Create: `scripts/verify-relay-live.sh`
- Modify: `.github/workflows/fly-deploy-relay.yml`
- Test: `scripts/test-verify-relay-live.sh`

**Step 1: Implement bounded retries**

Write a strict Bash script accepting the deployed tag/version. Normalize an optional leading `v`, validate semantic-version syntax, and allow test-only environment overrides for base URL, attempt count, retry delay, and curl binary. In each attempt:

- fetch `/_readiness`, parse with `jq -e '.status == "ready"'`;
- fetch `/` with the NIP-11 Accept header, parse `.version`, and compare exactly;
- succeed only when both observations pass in the same attempt;
- otherwise log a concise reason and retry until exhaustion.

No secrets or response bodies are printed.

**Step 2: Invoke after deploy**

Add a separate `Verify live relay readiness and version` step after the `flyctl deploy` step, passing `${{ inputs.tag }}`. A separate step makes deploy completion and live proof visible as distinct log phases.

**Step 3: Run mock scenarios**

Run:

```bash
scripts/test-verify-relay-live.sh
```

Expected: all four behavior scenarios and the header/version assertions pass without network access.

## Task 7: Run local green proof and review scope

**Files:** all files above

**Step 1: Run focused contracts**

Run:

```bash
. ./bin/activate-hermit
scripts/test-release-pipeline-contract.sh
scripts/test-release-ref-contract.sh
git diff --check
```

Expected: all pass.

**Step 2: Validate shell syntax**

Run:

```bash
bash -n scripts/verify-relay-live.sh scripts/test-verify-relay-live.sh scripts/test-release-pipeline-contract.sh scripts/test-release-ref-contract.sh
```

Expected: no output, exit zero.

**Step 3: Inspect the exact diff and worktree boundary**

Run:

```bash
git status --short
git diff --stat origin/develop...HEAD
git diff -- .github/workflows/ci.yml .github/workflows/auto-tag-on-release-pr-merge.yml .github/workflows/fly-deploy-relay.yml scripts docs/superpowers
git worktree list --porcelain
```

Expected: only approved release-pipeline files in this isolated worktree; onboarding hotfix worktrees unchanged and retained.

**Step 4: Commit implementation**

Run:

```bash
. ./bin/activate-hermit
git add .github/workflows/ci.yml .github/workflows/auto-tag-on-release-pr-merge.yml .github/workflows/fly-deploy-relay.yml scripts/verify-relay-live.sh scripts/test-verify-relay-live.sh scripts/test-release-pipeline-contract.sh scripts/test-release-ref-contract.sh
git commit -s -m "ci: add production promotion safety gate"
```

Expected: signed implementation commit; no ruleset mutation, push, merge, tag, or deploy.

## Task 8: Hosted proof and staged ruleset rollout (not part of local implementation)

**Step 1: Publish through the normal develop lane**

Push the scoped branch, open a PR to `develop`, arm auto-merge, and wait for PR CI plus merge-group CI. Do not bypass or weaken any required check.

**Step 2: Verify post-queue routing**

For the merged SHA, inspect the `develop` push run. Confirm the six core jobs did not run and only path-relevant secondary jobs did. Record PR, merge-group, and push run IDs/timings separately.

**Step 3: Open but do not merge the promotion PR**

Open `develop` to `main`. Confirm exactly one `Promotion Gate` is present and successful, and every non-skipped check is green.

**Step 4: Tighten `main` safely**

Read the live main ruleset, preserve bypass actors and all current settings, add `Promotion Gate` to required checks, retain the existing six during rollout, and ensure pull requests remain required. Write the minimally changed ruleset and read it back.

**Step 5: Tighten `develop` safely**

Read the live develop ruleset, preserve its merge queue and current six required checks, add the pull-request rule, write the minimally changed ruleset, and read it back.

**Step 6: Re-check terminal promotion gate**

Only after both ruleset readbacks and a fresh `gh pr checks` show every non-skipped check passing may the promotion merge proceed. Publication, deploy, and live canary are subsequent distinct terminal gates.
