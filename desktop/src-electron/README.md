# Colony Electron desktop migration

This opt-in entry point runs Colony's existing React application in Electron and
uses the real Rust command handlers over private parent/child stdio. The Rust
compatibility host still links Tauri and owns one hidden blank dispatch webview.
This is a migration stage, not complete Tauri removal or a production installer.
Ordinary Tauri development and release commands are unchanged. Live runtime
validation for this phase is macOS only; Windows/Linux shell parity is a later
gate, separate from portable metadata and cookie-store unit tests.

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
