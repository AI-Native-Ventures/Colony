# Colony desktop migration and browser sign-in import

Status: migration direction approved by the founder on 2026-09-07, including first-launch browser discovery and repeatable cookie import. This document records the approved product behavior and the technical execution gates. It is not implementation or release proof.

## Product contract

Port the existing Colony desktop to Electron. Retain its React interface, communities, channels, threads, workers and Rust business services. Integrate native browser views into the existing workspace. The standalone experiment established browser feasibility; it is no longer the destination for owner onboarding or account import.

On first launch, offer **Bring your signed-in accounts**. Detect installed browser profiles locally, show the source browser/profile, let the owner choose sites and the destination business, then import selected transferable sessions. **Skip for now** leaves the flow available under **Settings → Browser → Import sign-ins**, also reachable from an unsigned-in workspace browser tab. Detection is automatic; account transfer follows the owner's selection. Do not prompt again on every launch after dismissal.

Source profiles are not website accounts. Detection must say **Browser profile found**, not **Instagram connected**. Only a successful authenticated page check establishes that a particular account works. Before a worker uses a transferred session, the owner must be able to see which business and account it belongs to. Importing does not itself grant every agent access.

Repeat import uses the same flow. Preserve existing destination sign-ins by default; offer explicit replacement for a selected site so importing a personal account cannot silently replace a client's account. Do not continuously synchronize browser sessions. Keep Colony and Horizon sessions separate.

## Compatibility and implementation choices

Universal cookie transfer is an aspiration, not a promised compatibility result. Browser encryption, protected storage, session expiry, device-bound credentials and site-specific storage can prevent an imported cookie from working. Show per-site outcomes: **Ready**, **Needs sign-in**, **Import unavailable**, or **Import failed** with a useful next action. A successful cookie write alone is not **Ready**. A valid but unverifiable session remains **Needs verification** until inspected.

Use browser-specific native import adapters where normal OS-granted access makes transfer possible. Keep decoding and cookie values in the local privileged process. If a browser requires a supported helper/extension, describe that route clearly; do not claim a helper is already implemented or quietly disable browser protections. When transfer is unavailable, open the site inside Colony for a one-time sign-in and retain its supported session data afterward. Cookie-only import does not promise transfer of localStorage, IndexedDB, passkeys, passwords or browser-held private keys.

The first discovery module enumerates conventional browser/profile directories using filesystem metadata only. It never opens cookie databases, requests Keychain secrets or reads browser history. Candidate browsers include Chrome, Edge, Brave, Chromium, Firefox and the known macOS Arc, Dia and Safari locations. A discovered location does not certify an importer. Custom and portable profiles require a later explicit folder selection with format validation; they cannot be inferred reliably from conventional paths. The support matrix must be based on real browser/version/OS tests before release.

Imported cookie attributes must retain domain versus host-only scope, path, secure, HttpOnly, SameSite and expiry. Never convert session cookies into long-lived cookies by inventing expiry. Partitioned cookies require a verified equivalent destination representation or an explicit unsupported result; never flatten them into broader unpartitioned cookies. Source profiles are read-only and never terminated forcibly. Locked stores, denied OS access, malformed records and cancellation produce bounded failures without a secret dump.

## Integration boundary

Use the existing `desktop/src/shared/api/nativeBridge.ts` contract for the renderer. Implement the Electron side under `desktop/src-electron/`; remote website views get no privileged preload. Main-frame-validated IPC exposes profile summaries and opaque selection IDs, not cookie values or arbitrary filesystem reads. The native importer resolves IDs against its own discovery catalog. Cookies remain in a business-scoped Electron persistent session and never enter a prompt, relay event, telemetry payload, renderer response or diagnostic log.

Reuse `crates/buzz-native` host interfaces and generated `desktop/native-inventory.json`. The current `desktop/src-tauri/src/host.rs` still adapts those interfaces to Tauri, and `AppState` plus many command wrappers remain Tauri-coupled. The seam is useful groundwork, not a completed standalone daemon. Extract/adapt lifecycle and command dispatch before claiming the actual app works in Electron. Preserve command arguments, error text, binary transport and event/channel subscriptions. Do not simulate a working backend by returning empty values for unported commands.

## Execution gates

1. **Discovery foundation in the real desktop tree:** fixture-driven tests cover conventional profiles, separate browser identities, inaccessible directories, bounded enumeration and metadata-only access. No real cookies imported. This is the first bounded implementation step, not a finished import flow.
2. **Actual app in Electron:** real React entry point, narrow preload and Rust host transport; demonstrate community connection, threads, a real worker session, restarts and the native browser workspace. Keep a per-feature parity ledger, including every unported native operation. UI rendering with mock data is insufficient.
3. **Owner-directed import:** first-launch and Settings entry points wired to native discovery, supported source adapter and selected destination; fixture cookies imported into actual Electron sessions. Test attributes, conflicts, expiry, cancellation, locked/denied stores, business isolation, restart and absence of secrets in logs/IPC.
4. **Live account proof:** owner-selected browser/profile/site imported into the migrated Colony app, authenticated account identity verified, app restarted and account verified again. A browser/site that requires fresh login stays explicitly marked. No social publishing is authorized by this test.
5. **Release parity:** native dialogs, deep links, notifications, key storage, agent shutdown/recovery, terminal/audio, packaging, signing, updater and existing workflow gates. Measure the same browser workload against Tauri before reporting resource differences. Release promotion remains a separate decision and gate.

## Technical references checked on 2026-09-07

- [Electron cookies](https://www.electronjs.org/docs/latest/api/cookies): local session cookie operations and preserved session-cookie lifetime.
- [Chrome cookie API](https://developer.chrome.com/docs/extensions/reference/cookies): extension access requires cookie and host permissions; it is an optional adapter route, not a universal import guarantee.
- [Chrome app-bound encryption](https://security.googleblog.com/2024/07/improving-security-of-chrome-cookies-on.html): explains why reading a profile database is not equivalent to obtaining usable cookies.
- [Device-bound sessions](https://blog.google/security/protecting-cookies-with-device-bound-session-credentials/): exported cookies cannot recreate the non-exportable key used for session refresh.

The local `experiments/electron-browser/README.md` remains the record of the earlier prototype's narrower proof.
