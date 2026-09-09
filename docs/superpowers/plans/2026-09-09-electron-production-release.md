# Electron production release implementation plan

**Goal:** Ship the approved Electron desktop as the main macOS Colony app through the protected promotion and production release lanes, preserving existing accounts and update trust.

**Architecture:** Reuse the native Tauri updater's existing signature verifier and stable manifest, with an explicit path to Electron's main executable. Production uses the historical app identifier, native data directory, keyring and agent nest. Beta and temporary QA profiles remain isolated. macOS production publication requires Developer ID signing, notarization and Gatekeeper verification; ad-hoc candidates can only be Actions proof artifacts. Windows remains the existing Tauri release until the Electron worker isolation and packaging gates exist there.

**Authorization and validation:** The user requested the main app migration and production release, authorized promotion/publication and hook-free signed commits, and prohibited local tests/builds/CI. All executable validation runs in GitHub CI. No new purchases or protection bypasses are authorized.

## Acceptance gates

- [ ] Stable and beta packaging are distinct; fixture/debug/ad-hoc packages cannot publish.
- [ ] Stable retains `xyz.block.buzz.app`, `buzz-desktop` keyring, the existing agent nest, and `Contents/MacOS/buzz-desktop` so a Tauri installation can relaunch the replacement.
- [ ] Temporary QA profiles cannot select stable native state or keyring.
- [ ] Native update selection installs only into the containing `Colony.app`, verifies the existing signed archive and preserves download/install separation. Beta accurately reports updater unavailable.
- [ ] GitHub unit/native tests and relocated production-candidate browser/signup/isolation checks pass.
- [ ] All current promotion PR checks pass before merge to main.
- [ ] Production artifacts are Developer ID signed, notarized, Gatekeeper accepted, updater-signed and verified before publication. Missing credentials stop publication before any stable manifest mutation.
- [ ] Relay image deploy reports the intended version and readiness. Published download/updater entries refer to the verified release bytes.

## Work

1. Add explicit stable/candidate package variants and immutable bundled runtime channel metadata. Add tests for invalid combinations and isolated overrides.
2. Add compile-gated stable native storage selection. Keep beta and test profiles on private namespaces; route stable through the existing boot migrations/keyring/nest.
3. Add a scoped Electron updater command using the existing plugin and a validated parent-bundle executable path; implement the frontend update handle over native resources and cover failure/cleanup behavior.
4. Add production signing/notarization and bundle verification scripts. Use existing GitHub release credentials and Tauri updater key. Preserve the old executable name for Tauri-to-Electron relaunch.
5. Replace only the macOS stable publisher with the production Electron path. Hold publication on credential, smoke, signing or updater failures. Add a hosted production-candidate proof workflow that never publishes.
6. Prepare desktop and relay patch versions, changelogs and exact release instructions. Open normal develop PR, obtain GitHub proof, then promote develop to main and verify all release/deploy gates.

## Known external prerequisite

The accessible repository secret names currently include the Tauri updater key and release GitHub App, but no Apple Developer ID/notarization credentials. The local keychain reports only `FlowVoice Dev`, not a Developer ID identity. Organization-secret visibility is unavailable to this token. The publisher must validate actual credential availability in Actions and report missing names; it must never fall back to ad-hoc signing.
