# Colony Electron desktop migration

This opt-in entry point runs Colony's existing React application in Electron and
uses the real Rust command handlers over private parent/child stdio. The Rust
compatibility host still links Tauri and owns one hidden blank dispatch webview.
This is a migration stage, not complete Tauri removal or a production installer.
Ordinary Tauri development and release commands are unchanged. Live runtime
validation for this phase is macOS only; Windows/Linux shell parity is a later
gate, separate from portable metadata and cookie-store unit tests.

## Installable macOS beta

`pnpm --dir desktop electron:package` builds the frontend, Rust compatibility
host and six real CLI/agent helpers, then packages a relocatable **Colony Electron
Beta.app** and zip under `desktop/electron-dist`. Use `--debug` for a faster
local validation build. It requires the repository's activated Hermit toolchain
at build time; the resulting app starts without a terminal or checkout.

The branded package bakes the same hosted account service as Colony stable and
canary (`relay.colony.ainative.ventures`), independently of local relay overrides
in the build shell. It keeps automatic root-community connection off so signup
can provision the founder's business first. Use `electron:dev` for a custom local
relay. The manifest records these defaults, and the relocated-app gate verifies
the compiled endpoint before exercising its local fixtures.

The package stages only the built frontend, Electron runtime modules, CSP and
version metadata. Native executables live together outside the application
archive. Packaged runtime discovery prefers these bundled helpers instead of
build-time workspace output. Placeholder executables fail packaging.

The beta is ad-hoc signed for local testing, **not Developer ID signed or
notarized**. It has no update feed and does not replace the Tauri distribution.
Native state and the keyring service are scoped to the Electron profile, so a
temporary test profile cannot reuse a business's normal agent records or keys.
The development native namespace changes from the initial migration's shared
development namespace; no existing profile is migrated automatically.

After packaging, run the full relocated-app gate:

```sh
COLONY_SMOKE_APP="/absolute/path/to/Colony Electron Beta.app" node desktop/src-electron/smoke.mjs
COLONY_SMOKE_APP="/absolute/path/to/Colony Electron Beta.app" node desktop/src-electron/signup-smoke.mjs
```

This copies the bundle outside the checkout, preserves macOS framework symlinks,
launches with a minimal PATH and no host override, asserts that the real native
catalog resolves the bundled Colony Agent, then exercises the same browser,
synthetic import, takeover and restart checks described below. A debug package
passed this gate on Apple Silicon; release-profile and notarized-package proof
remain separate.

The signup gate drives the real Account screen through Recovery and relaunches
the same temporary profile to prove the original recovery code survives without
a second signup request. It uses an ephemeral localhost account server and
verifies renderer password derivation and both native encrypted backups; no
hosted account is created. Cleanup removes only this run's synthetic profile and
keyring entry. Set `COLONY_SMOKE_PROOF_DIR` to save account and recovery screenshots
(the recovery code is masked).
Account requests to any other destination are blocked. The beta workflow requires
both this flow and the compiled hosted-endpoint check before uploading an artifact.

## Run

From the repository root, activate Hermit and install workspace dependencies:

```sh
. ./bin/activate-hermit
pnpm install --frozen-lockfile
just _ensure-sidecar-stubs
cargo build --manifest-path desktop/src-tauri/Cargo.toml --features electron-host --bin colony-native-host
cd desktop
pnpm electron:dev
```

The stubs are compile-only. Build the actual packaged agent/CLI helpers before
claiming worker execution parity. `COLONY_NATIVE_HOST` can point to another
absolute path to the compiled host. The default frontend address is
`http://127.0.0.1:1425`; the development runner owns and stops its Vite process.
For the built frontend, run Electron with `src-electron/main.mjs` after `pnpm build`
and omit `COLONY_ELECTRON_DEV_URL`. Electron serves `dist` using `colony://app`.

The Electron development profile, Rust app data, nest and owner keyring service
are separate from the installed Tauri app. Existing accounts and agent records
are not automatically migrated. Do not run two different test profile overrides
against the same native development data concurrently.

## Browser and sign-ins

Existing workspace web tabs use native Chromium views. Business changes close
the views and revoke agent grants. Each business has its own persistent partition.
Remote content has no preload or Node integration; permissions, popups and
downloads are denied in this initial stage.

First launch offers **Bring your signed-in accounts**. The same owner-facing flow
is available in **Settings → Browser**. Discovery reads profile metadata only.
Selecting a supported profile reads site names; pressing Import after selecting
sites authorizes local cookie access and, when necessary, an OS Keychain prompt.
Cookie values never pass through renderer IPC, agent tools or the relay.

Initial import support:

- Firefox SQLite stores: selected ordinary cookies; containers and partitioned
  cookies are skipped.
- Chrome and Chromium on macOS: v10 encryption, including v24 host binding.
- Other detected browsers and unsupported browser protection: direct sign-in.

This is not universal session migration. Passwords, local storage, IndexedDB,
passkeys and device-bound credentials are not copied. Expired or unsupported
cookies are counted as skipped. Existing Colony cookies are preserved unless the
owner explicitly selects replacement for the chosen sites. An import
can finish partially; counts describe the writes and do not claim an active login.
Open each selected site to verify the account. Session cookies keep their original
lifetime rather than becoming artificially persistent.

Advanced browser sharing creates an owner-issued, one-tab grant. The local MCP
adapter takes its grant file path as its only argument. Its Electron executable
must run with `ELECTRON_RUN_AS_NODE=1`. Grants are revoked by takeover, tab close,
business switch and cross-origin navigation. A full renderer reload revokes
browser grants and retires its native sockets,
event subscriptions and terminal sessions before accepting new native calls.
Managed agents remain running. An uncertain cleanup requires an app restart.

Automatic managed-agent assignment and owner-facing teammate controls remain a
subsequent migration gate.

## Validation

```sh
pnpm electron:test
# With Vite running at the development address and a compiled Rust host:
node src-electron/smoke.mjs
# After pnpm build, verify the packaged-asset protocol without Vite:
COLONY_SMOKE_BUILT=1 node src-electron/smoke.mjs
```

The smoke test uses a synthetic identity and a temporary Electron profile. It
checks the real React renderer/Rust request and event path, remote-view isolation,
business revocation, real websocket/event cleanup across renderer reloads, the
first-launch and Settings import UI, and a synthetic Firefox cookie store imported
into a real Electron session and consumed by an authenticated fixture page. It also restarts
Electron to verify that persistent imported cookies remain available. The
import-service fixture injects profile discovery; it never reads personal cookies or OS Keychain
secrets. It does not prove authentication to Instagram or any external account.

The Electron feature's Rust clippy/protocol tests run alongside Desktop Core in
CI. The default desktop suite includes Electron transport/import unit tests.
Release signing, updater, microphone/camera permissions, notifications, auxiliary
windows, per-site account verification, additional browser import adapters,
managed-agent browser assignment, real agent helpers and authenticated
business workflows are additional parity gates before replacing the Tauri release.
