# Releasing Buzz

## Colony releases (this fork)

Releases are automatic and cut from `main` only. Version numbers must never
be minted anywhere else: a release from `develop` skips the full CI matrix,
and two release lines make "higher version" stop meaning "newer".

1. Bump the component version on `develop` as part of normal work.
   Desktop: `just bump-desktop-version <v>`. Relay: `version` in
   `crates/buzz-relay/Cargo.toml`.
2. Open the promotion PR (`develop` into `main`) and merge only when every
   non-skipped check passes.
3. On merge, `auto-tag-on-release-pr-merge.yml` diffs the version files
   against the previous tip of `main` and creates each matching tag
   (`v<v>`, `relay-v<v>`) with the release-tagger App. One merge can
   release several components.
4. The tag push fires the publisher:
   - `v<v>` runs `colony-desktop-release.yml`: builds the dmg on the
     self-hosted Mac runner (labels `self-hosted, macOS, colony-builder`)
     and publishes
     `Colony_<v>_aarch64.dmg` plus the fixed-name `Colony_aarch64.dmg` to
     `AI-Native-Ventures/colony-releases`. The site's download button
     follows `/releases/latest`, so publishing is the whole deploy. The same
     job also ships the auto-update (see below).
   - `relay-v<v>` runs `docker.yml`: builds and pushes
     `ghcr.io/ai-native-ventures/colony-relay:<v>`.
5. Deploying the relay image to Fly stays a deliberate step: dispatch the
   "Deploy relay to Fly" workflow with the image tag.

Credentials: the org GitHub App `colony-release-tagger` (contents: write,
installed on `Colony` and `colony-releases`) supplies both the tag
attribution and the cross-repo publish token, via the
`BUZZ_RELEASE_TAGGER_CLIENT_ID` repo variable and
`BUZZ_RELEASE_TAGGER_PRIVATE_KEY` repo secret. The runner is a launchd
service on the build Mac (`~/actions-runner-colony`, check with
`./svc.sh status`). If a release must go out while either is broken, push
the tag by hand at the release commit; the publisher fires exactly as the
App would, and `workflow_dispatch` at the tag ref re-runs a publisher.

### Auto-update

Installed copies check for updates on launch and every six hours
(`BACKGROUND_UPDATE_CHECK_INTERVAL_MS` in
`desktop/src/features/settings/hooks/UpdaterProvider.tsx`). They fetch one
fixed URL:

```
https://github.com/AI-Native-Ventures/colony-releases/releases/download/colony-desktop-latest/latest.json
```

`colony-desktop-latest` is a rolling prerelease. Every desktop release
overwrites `latest.json` there and uploads that build's
`Colony_<v>_aarch64.app.tar.gz` alongside it. The archive keeps its version
in the filename on purpose: a client holding a cached manifest downloads the
archive that manifest was signed for, instead of a newer archive whose
signature will not verify.

Three things make a build updatable, and missing any one silently produces a
release nobody can update to:

- `vars.BUZZ_UPDATER_PUBLIC_KEY` and the endpoint, which
  `desktop/scripts/build-release-config.mjs` writes into a config overlay.
  `build.rs` only compiles the updater plugin in when both are present, so a
  build without them ships with no updater at all.
- `secrets.TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`) during the build, which
  signs the archive. The workflow fails if the `.sig` is missing or empty.
- The manifest publish step, which the workflow verifies afterwards by
  refetching the endpoint and comparing version, signature, and byte count
  against what it just built.

**The signing key is a one-way door.** Every shipped binary trusts exactly
that public key. Lose the private half and no existing install can ever be
updated again; leak it and anyone can serve a signed update to every install.
It was generated 2026-08-04 and lives in the repo secrets plus a local copy
at `~/Desktop/colony-updater-key/` on the build Mac, which should move to a
password manager.

Anyone still on 0.7.0 or earlier has no updater compiled in and must
download once from the site; 0.8.0 onward updates itself.

### Canary channel

`colony-desktop-canary.yml` ("Colony Canary desktop (develop)") ships a
second, side-by-side desktop app cut from `develop`. It is a product lane, not
a CI lane: do not confuse it with `linux-canary.yml`, `windows-canary.yml`,
`macos-intel-canary.yml` or `signed-macos-canary.yml`, which only prove the
tree still compiles on platforms CI does not otherwise cover.

Testers download it once from:

```
https://github.com/AI-Native-Ventures/colony-releases/releases/download/colony-canary-latest/Colony_Canary_aarch64.dmg
```

and it updates itself from then on. That URL names the tag explicitly because
`colony-canary-latest` is a prerelease, so `/releases/latest/download` never
resolves to it. The release page is
<https://github.com/AI-Native-Ventures/colony-releases/releases/tag/colony-canary-latest>.

| | Stable | Canary |
|---|---|---|
| Product name | Colony | Colony Canary |
| Bundle identifier | `xyz.block.buzz.app` | `ventures.ainative.colony.canary` |
| dmg | `Colony_<v>_aarch64.dmg` | `Colony_Canary_<v>_aarch64.dmg` |
| Updater endpoint | `colony-desktop-latest/latest.json` | `colony-canary-latest/latest.json` |
| Relay | `wss://relay.colony.ainative.ventures` | `wss://relay-canary.colony.ainative.ventures` |
| Version | `<v>` from the tag | `<desktop package.json version>-canary.<run_number>` |
| Signing | ad-hoc Apple identity + shared Tauri updater key | identical |

The different identifier and product name together are what let the canary
install beside stable: macOS keys application support, preferences and
keychain items off the identifier, and Finder, the Dock and the menu bar off
the bundle name. Both come from `desktop/scripts/build-release-config.mjs`
with `BUZZ_RELEASE_CHANNEL=canary`, which also writes an `Info.canary.plist`
overlay, because the checked-in `Info.plist` hardcodes `CFBundleName` and
those keys beat `productName` in the built app.

Signing is deliberately shared with stable. A second updater keypair would be
a second one-way door to lose, and the channels are already separated by
endpoint: no canary install ever polls the stable manifest, and no stable
install ever polls the canary one.

How it runs:

- Nightly at 03:00 UTC against `develop`. GitHub only fires schedules from the
  default branch, so this file has to be on `develop` for the cron to run at
  all.
- `workflow_dispatch` takes a `ref` input, so any branch can be handed to a
  tester without merging it first, and a `force` input to rebuild an unchanged
  tree.
- A hosted `decide` job compares HEAD against the `canary-sha:` line in the
  rolling release body and exits early when nothing moved, so an idle
  `develop` costs nothing on the self-hosted Mac (which is also somebody's
  development machine).
- That sha is written **after** every verification passes, so a run that built
  and then failed to publish does not suppress the next night's rebuild.
- Mandatory gate: the job runs `strings` over the shipped binary and refuses to
  publish unless `wss://relay-canary.colony.ainative.ventures` is compiled in.
  Nothing in the dmg, the plist, the signature or the manifest reveals a
  wrong compiled-in relay, and the fallback when `BUZZ_RELAY_URL` is missing is
  `ws://localhost:3000`.
- macOS aarch64 only in v1.

### Canary relay (Fly)

The canary app talks to its own relay, not production. That is the whole point:
experimental event kinds and migrations land in a disposable database, and
production is never touched by anything that has not been promoted to `main`.

| | Production | Canary |
|---|---|---|
| Relay app | `colony-relay` | `colony-relay-canary` |
| Postgres | `colony-db-iad` | `colony-db-canary-iad` |
| Redis | `colony-redis` | `colony-redis-canary` |
| Host | `relay.colony.ainative.ventures` | `relay-canary.colony.ainative.ventures` |
| Admin host | `admin.colony.ainative.ventures` | `admin-canary.colony.ainative.ventures` |
| Fly config | `deploy/fly/fly.toml` | `deploy/fly/fly.canary.toml` |
| Deploy trigger | manual dispatch at a `relay-v*` image tag | automatic, every `develop` merge |
| Machines when idle | 1 (always on) | 0 (`auto_stop_machines`) |
| Relay identity key | production `BUZZ_RELAY_PRIVATE_KEY` | its own, generated at provision time |

How a develop merge reaches the canary relay:

1. `docker.yml` now also triggers on pushes to `develop`, publishing
   `ghcr.io/ai-native-ventures/colony-relay:develop` and `:sha-<7>` (plus the
   `debug-` variants). Branch pushes never publish `:latest`, and the
   `push-gateway-*` jobs are guarded to the release lane, so a develop merge
   builds the relay only.
2. `fly-deploy-relay-canary.yml` runs on that workflow's completion, resolves
   the triggering commit's `sha-<7>` tag (never the moving `:develop` tag, so
   every canary deploy is traceable to one commit), retags it into
   `registry.fly.io/colony-relay-canary` and deploys with
   `--config deploy/fly/fly.canary.toml --strategy immediate`.
3. It then asserts the deployed image identity with `flyctl image show` and
   runs `scripts/verify-relay-live.sh` against the canary host. The identity
   check is the load-bearing one: the relay's crate version is not unique per
   develop commit, so readiness alone cannot tell you which build is live.

**This workflow is the only thing that deploys the canary relay, and it deploys
only from `develop`.** No manual pushes from feature branches. A canary that
anyone can push to from anywhere stops meaning "what develop looks like".

Integration and E2E suites never target this relay either. They reseed
databases, and the isolated test harness exists precisely so concurrent runs
stop clobbering each other. The canary is a dogfooding target.

#### Provisioning (one time)

```bash
deploy/fly/provision-canary.sh
```

Idempotent: it checks for each resource before creating it, refuses to touch
any name that does not contain `canary`, stages secrets rather than deploying,
and prints what it created versus skipped. It deliberately does not deploy; the
image tag stays an explicit choice.

Then add both DNS records, or nothing works:

| Type | Name | Value | Proxy |
|---|---|---|---|
| CNAME | `relay-canary` | `colony-relay-canary.fly.dev` | DNS only |
| CNAME | `admin-canary` | `colony-relay-canary.fly.dev` | DNS only |

`*.colony.ainative.ventures` already points at **production**, so both canary
names resolve to the production relay until these explicit records exist. A
more specific record beats the wildcard, which is the only reason a canary can
live inside this domain at all. On Cloudflare both must be grey-cloud:
proxying breaks ACME HTTP-01 and mangles the WebSocket upgrade. `flyctl certs
add` sits at "Awaiting configuration" until DNS lands, then flips to Issued on
its own.

Two things the canary configures differently from production, both load-bearing:

- **The admin host is a separate name.** The router short-circuits `/` whenever
  the request Host matches `BUZZ_ADMIN_HOST` and refuses to serve the web
  bundle, the NIP-11 document or the WebSocket endpoint. Pointing the admin var
  at the relay host would silently kill the canary's WebSocket.
- **`BUZZ_SELF_PROVISION_*` is omitted.** Self-serve community slugs only
  resolve through the wildcard, and the wildcard points at production, so any
  slug the canary minted would land on a production community that does not
  exist.

#### Reseeding

The canary database is cattle. Migration renumbering across parallel branches
will drift it, and the fix is a wipe, not a repair:

```bash
scripts/canary-reset.sh          # prompts; type the app name to confirm
scripts/canary-reset.sh --yes    # unattended
```

It stops the machine, drops and recreates the database, restarts, lets
`BUZZ_AUTO_MIGRATE` rebuild the schema, and proves the result by polling
`/_readiness` on port 3000 (which checks Postgres *and* Redis, so a 200 means
migrations landed and both backends answer). It refuses to run against any app
name other than `colony-relay-canary`, with no override flag.

Everything below this section is the upstream Buzz release process, kept
for reference; its desktop lane (`just release-desktop`, `release.yml`) is
gated to `block/buzz` and does not run in this fork.

---

Buzz has three independent release lanes. Desktop and relay use release PRs.
Mobile uses immutable release-candidate tags cut directly from remote `main`:

| Lane | Entry point | Artifact |
|------|-------------|----------|
| Desktop | `just release-desktop <version>` | Packaged desktop app (signed/notarized macOS, unsigned Windows, and Linux) |
| Relay | `just release-relay` | `ghcr.io/block/buzz` container image |
| Mobile | `scripts/mobile-release.sh candidate X.Y.Z` | Exact `mobile-vX.Y.Z-rc.N` source identity |

The lanes version independently. Desktop reads its manifests, relay reads its
crate manifest, and mobile derives both source and marketing version from the
exact candidate tag. The mobile handoff to the private `buzz-releases` pipeline
remains manual because OSS CI cannot trigger private CI.

## Quick Start

Prepare desktop releases locally from an up-to-date, clean `main` checkout:

```sh
just release-desktop 0.5.3
```

The recipe generates the immutable candidate and opens or updates its pull
request. Candidate branch creation uses the operator's GitHub permissions; the
release App is intentionally limited to creating protected release tags.

```sh
# Relay release
just release-relay
just release-relay 0.4.0

# Publish the next mobile candidate from the exact current remote main commit
scripts/mobile-release.sh candidate 0.5.0
```

Desktop uses an immutable generated candidate PR; relay continues using its
metadata PR. Mobile does not. Each `mobile-vX.Y.Z-rc.N` tag is an immutable
candidate and the artifact of record.
There is no mobile release branch, stable mobile tag alias, finalization step,
or mobile GitHub Release.

---

## How It Works

### Desktop

1. Run `just release-desktop <version>` from a clean, up-to-date `main` checkout.
   The script creates one deterministic candidate commit and records both its
   frozen base and the verified prior release ledger in candidate metadata.
2. Review the exact candidate SHA, complete changelog, and CI. Regenerating or
   pushing the branch creates a new candidate and requires checks to run again.
3. **Squash merge** the PR after all protected-branch checks pass. The merge is
   the human authorization event; an authorized owner/admin bypass is treated
   the same way. Unrelated changes reaching `main` do not invalidate the
   reviewed candidate.
4. `auto-tag-on-release-pr-merge` verifies the closed event against GitHub's PR
   identity, validates candidate content, and proves every required check came
   from its trusted producer and was successful when the PR merged. It creates
   `desktop-v<version>` at the exact reviewed PR head—not the squash commit.
   Retries accept that tag only at the same SHA and never move it. GitHub does
   not expose when an individual check rerun was created, so an ordinary rerun
   after merge deliberately makes tag verification fail closed; inspect that
   run and create a new candidate version rather than retrying the blocked tag.
5. The tag triggers `release.yml`. It builds and stages all platform artifacts,
   publishes the versioned release only after the complete set succeeds, then
   updates the rolling updater manifest last for stable versions.

Because squash merging leaves immutable candidate tags on side history, the next
release uses validated prior candidate metadata as its ledger boundary. It
includes unrelated commits after the prior frozen base and excludes exactly the
prior release's recorded squash commit; tag ancestry is deliberately irrelevant.

### Relay

1. **`just release-relay`** runs locally on `main`, creates or updates a
   `relay-release/<version>` PR, bumps `crates/buzz-relay/Cargo.toml`,
   regenerates `Cargo.lock`, and updates the relay changelog.
2. **Merge the PR.** `auto-tag-on-release-pr-merge` pushes
   `relay-v<version>`.
3. **The tag triggers `docker.yml`.** Stable releases update the version
   aliases and `latest`; prereleases do not. Each release also publishes an
   optimized, symbol-bearing image under matching `debug-` tags (for example,
   `debug-0.3.0` and `debug-latest`) for native profiling. The ordinary tags
   remain stripped and are the default for deployments that do not need it.

Every push to `main` continues to publish the rolling relay `:main` and
`:sha-<7>` tags, plus matching `:debug-main` and `:debug-sha-<7>` variants.

### Mobile

1. **Publish a candidate.** From a clean checkout whose `origin` is the
   canonical `block/buzz` repository, run
   `scripts/mobile-release.sh candidate X.Y.Z`. The script resolves and fetches
   the exact current `origin/main` commit, derives the next number from exact
   remote tags for that marketing version, and publishes an annotated
   `mobile-vX.Y.Z-rc.N` tag there through the dedicated `buzz-release-bot`
   GitHub App. It never uses the operator's checked-out commit and never moves
   an existing candidate.
2. **Build the exact tag.** Enter the candidate tag as `mobile_ref` in the
   private Buzz mobile Buildkite pipeline. OSS CI deliberately cannot trigger
   that private pipeline. The tag supplies both source commit and release
   version. Flutter receives clean marketing version `X.Y.Z`; Buildkite's
   monotonically increasing build number supplies the platform build number.
3. **Promote tested artifacts.** Promote the already-built signed artifact for
   each platform through its store workflow. Record the exact tag with the
   build or rollout record. No source ref is changed and no final build is cut.

The iOS and Android artifacts for one marketing version may come from different
RC tags. For example, iOS can ship `mobile-v0.5.0-rc.2` while Android ships
`mobile-v0.5.0-rc.3`. Each platform's exact candidate tag is its source record.
There is intentionally no single selected or final candidate for the marketing
version.

The simplification trades away a separate stabilization line. Unrelated commits
that reach `main` become part of every later candidate, and there is no retained
hotfix branch or branch-ancestry history. Add a dedicated hotfix flow later if a
release actually needs isolation from `main`.

`mobile/pubspec.yaml` keeps `0.0.0+1` only as a valid, visibly non-release
fallback for local development and validation builds. Release jobs always
inject both version fields. `mobile/CHANGELOG.md` is retained as historical
release data. It is not a release ledger for this flow.

---

## Version Sources

| Lane | Release version authority |
|------|---------------------------|
| Desktop | `desktop/package.json` and synchronized desktop manifests |
| Relay | `crates/buzz-relay/Cargo.toml` |
| Mobile | Exact `mobile-vX.Y.Z-rc.N` remote tag |

`just bump-desktop-version <version>` updates the desktop manifests and
regenerates their lockfiles. `just bump-relay-version <version>` updates the
relay crate and regenerates `Cargo.lock`. Mobile has no bump recipe or
release-metadata PR.

---

## Signed macOS Canary

Use the manual **Signed macOS Canary** workflow when you need an Apple Silicon
build of current `main` for explicit testing without publishing a release:

```sh
gh workflow run signed-macos-canary.yml --repo block/buzz --ref main
```

The workflow derives a `-test.<run-number>` version, signs and notarizes the
DMG, verifies it with Gatekeeper, and uploads it as a short-lived Actions
artifact with seven-day retention. Because this is a public repository, any
signed-in GitHub user can download that artifact while it exists; it is
unpublished, not private. The workflow has no release permissions, does not
create or move tags, and cannot update `buzz-desktop-latest` or `latest.json`.

Download the artifact from the completed run:

```sh
gh run download <run-id> --repo block/buzz --name <artifact-name>
```

The workflow intentionally accepts only `main`. Use the normal release process
for distributable builds or builds from an immutable release tag.

---

## Release Retry

`release.yml` has no manual dispatch and cannot build from `main` or another
caller-selected ref. If a run for an existing immutable
`desktop-v<version>` tag fails, rerun that failed workflow from GitHub Actions
(or use `gh run rerun <run-id> --failed --repo block/buzz`). A rerun
repairs the versioned draft if publication did not complete. It does not
promote that version to the auto-updater; promotion is a separate manual
action. Do not recreate, move, or push the immutable tag again.

Mobile intentionally has no branch or arbitrary-ref fallback. The private
Buildkite pipeline accepts only an exact candidate tag.

---

## Internal Releases

For mobile, trigger the private
[Release Mobile pipeline](https://buildkite.com/runway/buzz-mobile-releases) with
an exact RC tag for the platform build being cut. For desktop, start
[Release Desktop](https://buildkite.com/runway/sprout-releases) and enter the
exact public source tag as `desktop_ref=desktop-v<version>`; a generic
`v<version>` tag is intentionally rejected. See the
[buzz-releases README](https://github.com/squareup/buzz-releases#cutting-a-release)
for the rest of the private pipeline contract.

---

## What Gets Published

Desktop publishes two GitHub releases:

1. **`desktop-v<version>`**: the user-facing release with installers and the
   exact `updater-manifest.json` promotion candidate. Publishing this release
   does not expose it through in-app auto-update.
2. **`buzz-desktop-latest`**: the rolling auto-updater release. Its
   `latest.json` changes only through the manual promotion workflow.

### Promote an OSS desktop release to auto-update

After installing and testing the published `desktop-v<version>` artifacts, run
**Promote OSS Desktop Auto-Update** from the `main` branch and enter the exact
stable `X.Y.Z` version. The workflow validates the immutable tag and release,
the retained manifest and every referenced updater asset, and requires the
version to be newer than the currently promoted version before replacing
`buzz-desktop-latest/latest.json`. Same-version retries succeed only when the
manifest is identical; downgrades are rejected.

Withholding promotion leaves existing clients on the previous version. If a
promoted release is bad, ship and promote a higher patch version; changing the
manifest to an older version does not downgrade clients that already updated.

Mobile publishes only annotated `mobile-vX.Y.Z-rc.N` git tags. Store artifacts
and rollout records retain the exact tag they used. Mobile does not publish a
GitHub Release or a stable `mobile-vX.Y.Z` alias.

---

## Platform Support

The release workflow builds **two separate macOS DMGs**: Apple
Silicon (`darwin-aarch64`, the `release` job) and Intel
(`darwin-x86_64`, the `release-macos-x64` job), an unsigned Windows x64
NSIS installer (its filename includes `_alpha-unsigned`), and Linux `.deb` and
`.AppImage` packages. Both macOS DMGs are codesigned, notarized, and attached
to the same `desktop-v<version>` release. Intel users
download the `_x64.dmg`.

The Linux AppImage is post-processed by `desktop/scripts/fix-appimage.sh`,
which strips infra libraries over-bundled by linuxdeploy (they crash on
Mesa 25+ / GLib 2.88 distros; see
[tauri-apps/tauri#15665](https://github.com/tauri-apps/tauri/issues/15665))
and re-signs the artifact. As a result the AppImage relies on the
host's Wayland/GStreamer/graphics stack and requires GLib >= 2.72
(Ubuntu 22.04 or newer). The `release-linux` job builds inside a
`ubuntu:22.04` container for broad GLIBC compatibility.

---

## Prerequisites

- **Write access** to the `block/buzz` GitHub repository
- An `origin` remote whose configured URL is the canonical `block/buzz`
  repository
- `gh` CLI authenticated with permission to push the candidate branch and open
  its pull request
- The Default `main` ruleset configured for squash-only merging, strict required
  checks, stale-review dismissal, and the **Desktop Release Candidate** check
- Release tag ruleset [`14378754`](https://github.com/block/buzz/rules/14378754)
  active for `desktop-v*` and `mobile-v*`, with creation, update, deletion, and
  non-fast-forward protections and `buzz-release-bot` as its sole always-bypass
  actor
- The `buzz-release-bot` App credentials configured for GitHub Actions
- The following **GitHub Actions variables and secrets** configured for the
  desktop release lane:

  | Name | Kind | Purpose |
  |------|------|---------|
  | `BUZZ_RELEASE_TAGGER_CLIENT_ID` | Variable | GitHub App client ID used to create protected release tags |
  | `BUZZ_RELEASE_TAGGER_PRIVATE_KEY` | Secret | GitHub App private key |
  | `OSX_CODESIGN_ROLE` | Secret | macOS signing role used by `block/apple-codesign-action` |
  | `CODESIGN_S3_BUCKET` | Secret | macOS signing exchange bucket |
  | `BUZZ_UPDATER_PUBLIC_KEY` or `SPROUT_UPDATER_PUBLIC_KEY` | Secret | Tauri updater public key |
  | `TAURI_SIGNING_PRIVATE_KEY` | Secret | Tauri updater private key |
  | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Secret | Password for the private key |

Mobile candidate publication requires workflow-dispatch access and the existing
release App because strict tag protection denies direct human creation. The App
must be installed on `block/buzz`, have Contents write and Metadata read, and
retain an `always` bypass on the immutable `mobile-v*` tag rules. It does not
require GitHub Releases permissions, repository Administration permission, or a
mobile release-branch ruleset. The publisher validates the App token's effective
`current_user_can_bypass` value rather than reading the ruleset's hidden bypass
actor list.

---

## Troubleshooting

### The desktop candidate is stale or cannot be squash merged

Do not update the branch manually and do not weaken the ruleset. Run
`just release-desktop <version>` again from current `main`; this regenerates the
candidate, reruns CI, and requires a fresh trusted approval on the new exact
head. The post-merge verifier refuses to tag a squash whose parent differs from
the recorded candidate base or whose tree differs from the validated PR head.

### Local `just release-desktop` fails with "must be on main branch"
Switch to `main` and pull latest before running the release recipe.

### Local `just release-desktop` fails with "working tree is dirty"
Commit or stash your changes before running the release recipe.

### New commits land after publishing a mobile candidate

Run `scripts/mobile-release.sh candidate <version>` again after the intended
fix reaches remote `main`. It publishes a new immutable RC tag at the new exact
remote commit. Continue referring to each tested or shipped platform artifact by
its own exact tag.

### `scripts/mobile-release.sh candidate` fails because `main` moved during publication

The App-backed workflow may already have published the requested immutable RC
at the prior `main` tip before the operator command detects the race. Do not
move or delete that tag, and do not treat it as the candidate for current
`main`. Inspect the run URL from the command output, then rerun
`scripts/mobile-release.sh candidate <version>` to publish the next RC from the
new current `main` tip.

### A mobile candidate command selects the wrong RC number

Do not retry by moving or deleting a tag. Inspect the exact remote `mobile-v*`
tags and resolve the unexpected state. Candidate numbers are monotonically
increasing remote identities.

### A mobile candidate publication is rejected by repository rules

Confirm `buzz-release-bot` remains the sole always-bypass actor for the active
`mobile-v*` ruleset and that its Actions credentials are available. Do not grant
direct human creation or weaken update or deletion protection. Existing
candidate tags must remain immutable.

### Auto-updater reports "no update available"
Verify that the `buzz-desktop-latest` release exists and contains a
valid `latest.json`. The manifest covers all four platform keys
(`darwin-aarch64`, `darwin-x86_64`, `linux-x86_64`,
`windows-x86_64`); a missing entry usually means that platform's
release job failed. Check the workflow run.
