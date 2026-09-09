# Electron production release implementation plan

**Goal:** Ship the approved Electron desktop as the main macOS Colony app through the protected promotion and production release lanes, preserving existing accounts and update trust.

**Architecture:** Reuse the native Tauri updater's existing signature verifier and stable manifest, with an explicit path to Electron's main executable. Production uses the historical app identifier, native data directory, keyring and agent nest. Beta and temporary QA profiles remain isolated. The owner explicitly approved ad-hoc Mac distribution without Apple Developer signing or notarization on 2026-09-09. Production uses a reviewed explicit mode; missing Apple credentials never trigger a silent fallback. Updater signatures and package integrity remain mandatory. Unpublished CI packages are proof artifacts until the protected tag publisher uploads them. Windows remains the existing Tauri release until the Electron worker isolation and packaging gates exist there.

**Authorization and validation:** The user requested the main app migration and production release, authorized promotion/publication and hook-free signed commits, and prohibited local tests/builds/CI. All executable validation runs in GitHub CI. No new purchases or protection bypasses are authorized.

## Acceptance gates

- [ ] Stable and beta packaging are distinct; fixture/debug/private-candidate packages cannot publish; stable ad-hoc distribution must be explicit.
- [ ] Stable retains `xyz.block.buzz.app`, `buzz-desktop` keyring, the existing agent nest, and `Contents/MacOS/buzz-desktop` so a Tauri installation can relaunch the replacement.
- [ ] Temporary QA profiles cannot select stable native state or keyring.
- [ ] Native update selection installs only into the containing `Colony.app`, verifies the existing signed archive and preserves download/install separation. Beta accurately reports updater unavailable.
- [ ] GitHub unit/native tests and relocated production-candidate browser/signup/isolation checks pass.
- [ ] All current promotion PR checks pass before merge to main.
- [ ] Production artifacts match the reviewed signing mode, are updater-signed and verified before publication. Ad-hoc downloads are clearly labelled without Apple signing/notarization. Missing updater/publisher credentials stop publication before any stable manifest mutation.
- [ ] Relay image deploy reports the intended version and readiness. Published download/updater entries refer to the verified release bytes.

## Work

1. Add explicit stable/candidate package variants and immutable bundled runtime channel metadata. Add tests for invalid combinations and isolated overrides.
2. Add compile-gated stable native storage selection. Keep beta and test profiles on private namespaces; route stable through the existing boot migrations/keyring/nest.
3. Add a scoped Electron updater command using the existing plugin and a validated parent-bundle executable path; implement the frontend update handle over native resources and cover failure/cleanup behavior.
4. Add production signing/notarization and bundle verification scripts. Use existing GitHub release credentials and Tauri updater key. Preserve the old executable name for Tauri-to-Electron relaunch.
5. Replace only the macOS stable publisher with the production Electron path. Hold publication on credential, smoke, signing or updater failures. Add a hosted production-candidate proof workflow that never publishes.
6. Prepare desktop and relay patch versions, changelogs and exact release instructions. Open normal develop PR, obtain GitHub proof, then promote develop to main and verify all release/deploy gates.

## Current release phase: 0.16.9

The earlier v0.16.8 publisher stopped before uploads because Apple credentials
were absent. Its tag remains immutable. The owner then confirmed there is no
Apple Developer membership and explicitly requested continuing without that
signing setup. No membership will be purchased and no Apple setup is required.

0.16.9 deliberately includes reviewed onboarding PR #666 (develop merge
`5cfa527139da6095dc0a7a8de5ca6ab9afd2f8d0`) and the explicit ad-hoc distribution
change. It must pass GitHub source, stable package, migration and full promotion
gates before a new immutable tag is published. The Mac release carries checksum
and detached updater-signature assets. Public DMG bytes are downloaded and hashed
against the built artifact. The existing live relay is already 0.11.8 and ready;
this distribution-only phase does not need another relay deployment.

### Frontend state migration gate

The first stable Electron launch now loads an inert bundled page in the original
`tauri://localhost` WebKit origin, transfers application-owned durable localStorage
through the private native bridge, and imports it at `colony://app` before React.
Disposable relay snapshots are excluded. Source state is never deleted or edited;
existing Electron values win, and the completion marker is written only after
verified destination writes. Failures keep the recovery page visible and retryable.
Native identity, provider credentials and agent files continue through the existing
native namespace rather than being recopied by this frontend migration.
Migration also requires the nested native process to resolve the expected macOS
bundle identifier. An absent or unrelated process bundle fails closed instead of
marking an unrelated empty WebKit store as a successful migration.
The hosted candidate and fixture both initially failed this guard as `unbundled`.
The release helper now embeds the standard macOS command-line tool Info.plist
section with an immutable build-specific identifier. Before loading the WebKit
page, it separately validates the canonical containing app, its Info.plist ID,
and its expected outer executable. The embedded identity alone cannot authorize
a standalone helper or a different app.

Candidate and explicit QA profiles use an incognito hidden WebKit store, even
though their outer application bundle may have the stable bundle identifier. The
production native feature cannot be combined with the onboarding fixture feature.
The separately compiled hosted fixture can seed only fixed synthetic state in its
own distinct bundle's persistent WebKit origin. A fixture-only legacy layout first
persists the state and exits normally. Electron then imports without reseeding;
an independent legacy read after Chromium edits must match the original key/value
hash. This hosted gate covers actual WebKit-to-Chromium transfer across executable
layouts, two communities, an owner marker, an unsent draft, appearance and relaunch
non-overwrite. Normal candidates remain incognito. Pure fault-injection tests cover
untouched source, malformed state, storage failure and retry. The exact Tauri-to-Electron upgrade of a real existing
default WebKit store remains unproven until an installed upgrade is observed; passing the private fixture must not be described as that proof.
