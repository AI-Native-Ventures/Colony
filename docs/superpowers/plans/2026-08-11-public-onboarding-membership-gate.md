# Public Onboarding Membership Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Colony desktop v0.10.14 so a fresh public user reaches community creation without being auto-connected to the membership-gated root relay.

**Architecture:** Keep the production WebSocket and HTTP relay URLs compiled into both desktop artifacts for provisioning calls. Remove only the public release's auto-connect build flag so `useCommunityInit` preserves the existing no-community path into `WelcomeSetup`; after provisioning, the existing onboarding transaction connects to the returned owned-community host.

**Tech Stack:** GitHub Actions YAML, Bash contract tests, React/TypeScript, Playwright, Tauri/Rust build metadata.

---

### Task 1: Pin the public release contract

**Files:**
- Modify: `scripts/test-colony-desktop-release-relay-contract.sh`
- Modify: `desktop/tests/e2e/onboarding.spec.ts`

- [ ] **Step 1: Make the release contract reject root-relay auto-connect**

  Remove the expected `COLONY_PRODUCTION_RELAY_AUTO_CONNECT` value. In each
  release build step, continue requiring exact `BUZZ_RELAY_URL` and
  `BUZZ_RELAY_HTTP` lines, then fail if the block contains
  `BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY`.

- [ ] **Step 2: Run the contract against v0.10.13 to prove red**

  Run: `scripts/test-colony-desktop-release-relay-contract.sh`

  Expected: `FAIL` because both public build steps still set
  `BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY`.

- [ ] **Step 3: Extend fresh-install E2E coverage**

  In `non-local runtime override keeps community selection without release
  flag`, assert all of the following after boot:

  ```ts
  await expect(page.getByTestId("membership-denied")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Change community" }),
  ).toHaveCount(0);
  await expect(page.getByTestId("community-choice-create")).toBeVisible();
  ```

  This pins the initial-create and recovery symptom to the same absent
  auto-connected root community.

- [ ] **Step 4: Run the focused E2E baseline**

  Run from `desktop/`: `pnpm test:e2e:smoke --grep "non-local runtime override keeps community selection without release flag|non-local default auto-connects when the release flag is enabled|first-community owner can create and connect a hosted community"`

  Expected: all selected tests pass before the workflow change, proving the
  client behavior for flag-off and flag-on builds is already deterministic.

### Task 2: Remove public auto-connect and bump v0.10.14

**Files:**
- Modify: `.github/workflows/colony-desktop-release.yml`
- Modify: `desktop/package.json`
- Modify: `desktop/src-tauri/tauri.conf.json`
- Modify: `desktop/src-tauri/Cargo.toml`
- Modify: `desktop/src-tauri/Cargo.lock`

- [ ] **Step 1: Remove only the public release auto-connect wiring**

  Delete `COLONY_PRODUCTION_RELAY_AUTO_CONNECT` from workflow-level `env` and
  delete `BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY` from the macOS and Windows
  build-step environments. Update nearby comments to state that the two relay
  URLs are compiled for provisioning while fresh installs remain in community
  selection.

- [ ] **Step 2: Run the release contract to prove green**

  Run: `scripts/test-colony-desktop-release-relay-contract.sh`

  Expected: `Colony desktop release relay contract passed`.

- [ ] **Step 3: Bump the desktop release**

  Run: `. ./bin/activate-hermit && just bump-desktop-version 0.10.14`

  Expected: package, Tauri config, Tauri manifest, and Tauri lockfile all report
  `0.10.14`; the root lockfile remains unchanged unless dependency resolution
  requires it.

- [ ] **Step 4: Commit the implementation**

  Run:

  ```bash
  git add .github/workflows/colony-desktop-release.yml \
    scripts/test-colony-desktop-release-relay-contract.sh \
    desktop/tests/e2e/onboarding.spec.ts \
    desktop/package.json desktop/src-tauri/tauri.conf.json \
    desktop/src-tauri/Cargo.toml desktop/src-tauri/Cargo.lock pnpm-lock.yaml
  git commit -s -m "fix(release): keep public onboarding out of membership gate"
  ```

### Task 3: Local verification

**Files:**
- Verify only; no planned source changes.

- [ ] **Step 1: Re-run focused behavior tests**

  Run the Task 1 Playwright command after killing any stale server on port
  4173 through the repository's normal E2E command.

  Expected: selected fresh-install, flag-on, and create-community tests pass.

- [ ] **Step 2: Run release contracts and format checks**

  Run:

  ```bash
  scripts/test-colony-desktop-release-relay-contract.sh
  scripts/test-release-ref-contract.sh
  pnpm --dir desktop exec biome check tests/e2e/onboarding.spec.ts
  ```

  Expected: all pass.

- [ ] **Step 3: Run proportional repository gates**

  Run `. ./bin/activate-hermit && just ci`. If the broad gate is interrupted or
  fails in an untouched suite, report that separately and retain focused proof.

- [ ] **Step 4: Inspect the diff and signoff**

  Run `git diff --check`, `git status --short`, and
  `git log -2 --format='%h %s%n%(trailers:key=Signed-off-by)'`.

### Task 4: PR, CI, promotion, and release

**Files:**
- GitHub state only.

- [ ] **Step 1: Push and open a PR to `develop`**

  Push `codex/fix-public-onboarding-membership-gate`, open a PR with the root
  cause and red/green evidence, and arm merge-queue auto-merge using
  `gh pr merge <number> --repo AI-Native-Ventures/Colony --merge --auto`.

- [ ] **Step 2: Wait for PR and merge-group gates**

  Require every non-skipped required check to pass. Confirm the PR merged and
  `origin/develop` contains its merge commit. A green PR run without a merged
  queue entry is not completion.

- [ ] **Step 3: Promote develop to main**

  Open the normal develop-to-main promotion PR. Arm auto-merge only after the
  full promotion matrix is attached, then wait until all non-skipped checks
  pass and GitHub reports the PR merged.

- [ ] **Step 4: Verify release automation**

  Confirm tag `v0.10.14` points at the promoted main commit. Require both
  macOS and Windows jobs in `colony-desktop-release.yml` to succeed, including
  the production-relay binary scans.

- [ ] **Step 5: Inspect the published artifact**

  Download `Colony_0.10.14_aarch64.app.tar.gz`, verify its published SHA-256,
  unpack it, and inspect the real `buzz-desktop` binary. Require:

  - version `0.10.14` in `Info.plist`;
  - `wss://relay.colony.ainative.ventures` present;
  - `https://relay.colony.ainative.ventures` present;
  - `ws://localhost:3000` absent;
  - `BUZZ_DESKTOP_BUILD_AUTO_CONNECT_DEFAULT_RELAY`'s compiled marker absent.

- [ ] **Step 6: Obtain live first-run proof**

  Use a reset v0.10.14 build without reading or exposing the user's key. Prove
  it reaches `Join or create a community`, opens `Create a community`, and does
  not show `Membership required`. Do not create production data solely for the
  proof unless a disposable identity and cleanup path are explicitly approved.

