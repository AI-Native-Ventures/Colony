# Release Pipeline Safety Gate Design

**Date:** 2026-08-11
**Status:** Approved design; implementation pending written-spec review
**Scope:** Colony GitHub Actions and repository rules for `develop` promotion to `main`

## Problem

The current merge and release path spends roughly 25 minutes or more repeating CI after the merge queue, yet production tagging can begin without a unique promotion check proving that the production candidate passed the intended matrix. Recent runs show that a successful `merge_group` run is followed by a `develop` push run on the exact same SHA, re-running the same six required checks. A promotion PR can then merge using previously reported contexts while its own CI is still running, and the tag workflow does not independently verify a promotion-specific gate.

The desired outcome is a faster pipeline with a stronger production boundary:

- keep the merge-queue gate intact;
- remove only objectively duplicate post-queue work;
- run additional platform and product coverage when paths make it relevant;
- require one unambiguous promotion result before `main` can merge or publish;
- retain a live, post-deploy proof that the public relay is ready and running the dispatched version.

## Safety Invariants

1. `develop` remains protected by the existing six required checks on pull requests and merge groups: `Detect Changed Paths`, `Desktop`, `Desktop Core`, `Rust Lint`, `Unit Tests`, and `Relay Suites`.
2. The `merge_group` trigger remains present. Its required checks cannot be skipped or path-filtered away.
3. Every promotion PR from `develop` to `main` runs all six core checks, regardless of changed paths. A pull request targeting `main` from any other head branch cannot pass the promotion gate.
4. A unique `Promotion Gate` check succeeds only when the head branch is `develop` and every required and applicable promotion job succeeds. Skipped non-applicable jobs are allowed; failures, cancellations, and missing required results are not.
5. `main` requires pull requests and the unique `Promotion Gate` before merge. Publication additionally verifies that the merged PR contains exactly one successful `Promotion Gate` result.
6. Production deployment keeps its current build and deploy controls and adds a live public canary. The canary proves readiness and deployed version; it does not use the onboarding configuration endpoint as a proxy for relay health.
7. Repository rules are tightened only after the new status context has been emitted and verified, preventing a ruleset deadlock.

## Event Model

### Pull requests targeting `develop`

Keep the current path-selected preflight behavior. The six required contexts remain available under the current develop ruleset. Expensive secondary suites continue to run only when their owned paths change.

### Merge groups targeting `develop`

Run exactly the six merge-queue-required safety contexts. Rust, desktop, and desktop-core path decisions are forced on so the queue can always satisfy its required contexts. Secondary suites that are not required at this gate must not run merely because the event is `merge_group`.

This does not weaken the merge queue, change its minimum wait, or reduce any required test coverage.

### Pushes to `develop`

Do not re-run the six core checks already completed for the exact merge-group candidate. Run only path-selected coverage that is not represented by those six contexts:

- Desktop Integration
- Windows
- Security
- Server Cross-Compile
- Web
- Mobile
- Blocks

Real-shell remains excluded because its hosted job currently skips the meaningful suite when its runtime is unavailable. It can be restored only after it produces executable, enforceable proof.

The live `develop` ruleset must require pull requests so an unvalidated direct push cannot exploit the post-queue optimization. Administrative bypasses remain governed by the existing repository policy.

### Pull requests targeting `main`

This is the production promotion gate. Always run all six core checks. Run secondary coverage only when raw changed paths make it relevant:

- Desktop Integration for desktop integration or desktop E2E ownership
- Windows for Windows-supported Rust, desktop, or packaging ownership
- Security for dependency, authentication, authorization, policy, or security-tooling ownership
- Server Cross-Compile for relay/server Rust and build ownership
- Web for web client ownership
- Mobile for Flutter/mobile ownership
- Blocks for Blocks integration ownership

Changes to `.github/workflows/ci.yml` itself are included in every relevant ownership bucket so CI changes exercise the jobs they can affect.

Path detection exposes two concepts separately:

- **raw relevance outputs**, derived only from the diff and used to decide secondary promotion coverage;
- **forced core outputs**, used only to guarantee required merge-group and promotion checks.

This separation prevents forced required checks from accidentally expanding every secondary matrix.

### Pushes to `main`

Do not run the duplicate CI matrix after a gated promotion merge. Release, deployment, and other purpose-specific workflows continue to trigger normally. Release branches retain their existing behavior unless later evidence supports a separate change.

## Promotion Gate Semantics

Add one job named `Promotion Gate` to the CI workflow. It uses `if: always()` and depends on:

- all six core required jobs or their existing required aggregators;
- every conditional promotion-only job.

The gate runs for every pull request whose base is `main`. Its script first requires `github.head_ref == 'develop'`, enforcing the repository's two-branch promotion model, and then evaluates each dependency result:

- each core dependency must equal `success`;
- each relevant secondary dependency must equal `success`;
- a non-relevant secondary dependency may equal `skipped`;
- `failure`, `cancelled`, or an unexpected/missing result fails the gate.

The exact job name is unique across the repository's workflows so branch protection cannot be satisfied by an unrelated workflow reporting the same context. Because GitHub emits skipped check runs even when a job-level condition is false, non-promotion events use a different display name (`Promotion Gate (not applicable)`); only a pull request targeting `main` can emit the exact required `Promotion Gate` context.

## Publication Defense in Depth

The tag workflow continues to react to a merged release/promotion PR, but tagging is conditional on an API read of that exact merged PR's check runs. It must find exactly one check run named `Promotion Gate`, and that run must have conclusion `success`. Zero, multiple, pending, cancelled, neutral, skipped, or failed matches stop publication.

This workflow check is not a replacement for branch protection. It is a second boundary protecting publication if repository rules drift or an administrator bypasses a merge rule.

## Live Relay Canary

Add `scripts/verify-relay-live.sh` and invoke it immediately after `flyctl deploy` in the relay deployment workflow.

The script receives the expected release tag, normalizes one leading `v` (for example, `v0.8.1` becomes `0.8.1`), and retries the public deployment until a bounded timeout:

1. `GET https://relay.colony.ainative.ventures/_readiness` must return JSON with `.status == "ready"`.
2. `GET https://relay.colony.ainative.ventures/` with `Accept: application/nostr+json` must return NIP-11 JSON whose `.version` equals the normalized version dispatched for deployment.

Transient startup failures retry. Exhausted retries, malformed JSON, non-ready status, or a version mismatch fail the deploy workflow. The existing platform health checks remain unchanged. `/api/communities/config` is explicitly outside this canary because it measures an onboarding contract rather than generic relay readiness and version adoption.

## Repository Rules Rollout

Ruleset changes are staged to avoid requiring a context that no run can yet produce:

1. Land the workflow and test changes on `develop` through the existing PR and merge queue.
2. Open a `develop` to `main` promotion PR.
3. Verify the PR emits exactly one `Promotion Gate` context and that it reflects all applicable dependencies.
4. Update the `main` ruleset to require pull requests and `Promotion Gate`, retaining the six current required contexts during this rollout.
5. Read the live ruleset back and verify the intended requirements.
6. Update the `develop` ruleset to require pull requests before relying on the optimized `develop` push lane.
7. Read the live develop ruleset back and verify both the pull-request and existing merge-queue requirements.
8. Merge the promotion only after every non-skipped check is green and the ruleset readback is correct.

No ruleset mutation occurs during local implementation. Live rules are changed only at the staged hosted-proof gate.

## Verification Strategy

### Fail-first contract proof

Add a focused release-pipeline contract test and run it against the current workflow before editing production workflow files. The baseline must fail for the missing protections it is intended to introduce:

- no unique promotion gate;
- unconditional duplicate core jobs on `develop`/`main` push;
- secondary suites running for every merge group;
- tagging without checking the promotion result;
- deployment without a live relay canary.

Mutation fixtures or temporary mutated copies prove each assertion fails when its protected contract is removed. This prevents a green test whose fixture never exercises the behavior.

### Canary proof

A mock-HTTP test covers:

- readiness failure and retry exhaustion;
- deployed-version mismatch;
- transient readiness failure followed by success;
- immediate exact-version success.

Tests use injected command/URL/timing seams and never contact or deploy to production.

### Hosted proof

Hosted evidence is reported separately from local proof:

- develop PR CI passes;
- merge-group run emits and passes the six required contexts;
- same-SHA develop push does not re-run the core six and runs only relevant secondary coverage;
- promotion PR emits exactly one successful `Promotion Gate`;
- live main and develop ruleset readbacks match the staged design.

The cleanup change does not require triggering a release or production deployment merely to prove CI routing. A later real deployment must provide the live canary evidence before it is called live-proven.

## Expected Impact

- **Merge path:** remove the observed duplicate post-queue core matrix, typically saving the full `develop` push CI wall time from the critical path when no secondary paths apply.
- **Promotion path:** eliminate misleading parallel post-merge CI and replace it with a pre-merge, production-specific decision.
- **Safety:** improve from reused generic statuses to an explicit production gate plus publication verification and live version proof.
- **Cost:** reduce hosted runner consumption for exact duplicate work while preserving relevant platform coverage.

Actual savings remain workload-dependent: secondary path-selected suites, release builds, runner allocation, merge-queue minimum wait, artifact publication, and deployment time remain distinct contributors.

## Non-Goals

- Removing or weakening any of the six develop merge-queue checks.
- Reducing the merge queue's configured wait or timeout.
- Replacing platform release builds with local or hosted CI artifacts.
- Treating deployment completion as live proof without the canary.
- Adding Real-shell as a required signal before its environment reliably executes the suite.
- Changing onboarding behavior, the onboarding hotfix, unrelated workflows, or unrelated worktrees.
- Deleting worktrees, cancelling active workflows, merging, tagging, or deploying during local implementation.
