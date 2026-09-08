# Local agent isolation

The founder approved agent isolation before signed-in browser sharing on
2026-09-08. Routine implementation choices are delegated; another approval of
this same direction is not required.

## Boundary and sequence

Start with the macOS Electron beta. Wrap the entire managed harness and its
children in a deny-by-default OS sandbox. Give each worker a private writable
workspace, read-only access to explicitly selected runtime files and its own
browser grant, and only explicit connection endpoints. Do not expose the host
home, Chromium profile, other workers' storage, arbitrary local services or
unrestricted process inspection. The host remains trusted; this is protection
against Colony-managed workers, not arbitrary unsandboxed apps belonging to the
Mac user.

A tools-only path filter is insufficient because a shell child can bypass it.
A separate virtual machine is a possible fallback if the OS sandbox cannot pass
our real-process gate, but adds installation/runtime work. Start with the OS
boundary already available on this Mac and require proof before enabling it.

## Proof gates

1. Implement a reusable native policy builder and real-process tests. Prove
   allowed file work, denied sibling reads/writes, symlink escape denial,
   inherited restrictions in shell children, and explicit socket/network access.
   Tests use synthetic secrets, never personal browser profiles.
2. Integrate the boundary into the native launcher. Sanitize inherited
   environment, create worker-owned HOME/temp/work directories, supply exact
   runtime paths and endpoints, and reject unsupported/incomplete launches.
   Model credentials and protocol needs must be traced rather than copying
   all host configuration. Existing unsupported harnesses cannot silently run
   unsandboxed. Review process cleanup and private browser grant transport.
3. Run a real managed worker with a deterministic model fixture. Demonstrate
   useful work plus failed attempts to read a sibling grant/profile and contact
   unapproved local services. Test restart, takeover and startup failure.
4. Only then enable owner-facing browser sharing and repeat the packaged-app
   gate, followed by the authorized Instagram draft pilot without publication.

Gate 1 alone is not an isolated product. The policy must be adopted by the
actual launch path and pass the remaining gates before any such claim.

## Runtime implementation

The policy now wraps the complete native-launched ACP harness in the macOS
Electron beta, including the real agent, MCP servers and shell descendants.
Only the built-in Colony Agent runtime is supported. Other Electron harnesses
and platforms fail closed; the legacy Tauri launcher is unchanged.

Each worker has a dedicated HOME/workspace and temporary directory. Host startup
opens directories without following symlinks and changes permissions through the
opened descriptor. The worker cannot remove its workspace root. Runtime files are
read-only; the owner's home, Chromium profile and other workers' files are absent
from its policy. Only the selected provider and explicit agent configuration are
forwarded, rather than the desktop's inherited environment.

The host generates a fresh launch nonce for each process. The browser grant
filename includes that nonce and the canonical agent/community identity. The
sandbox can read only its own launch's grant. An older descendant cannot read a
renewed grant after restart, even if it outlived its original process group.
The broker independently checks the current native roster, launch generation,
owner-only audience, business, tab and control epoch at operation boundaries.

A separate host-owned authenticated proxy is created for each worker launch.
The OS permits only that proxy's loopback port and the exact private browser
socket. The proxy pins the configured relay/provider destinations and denies
other authorities. Fresh proxy credentials prevent reused ports from transferring
access between launches. HTTP uses standard proxy settings; shared WebSocket
transport uses CONNECT while retaining the original TLS, Host and NIP-42 identity.
Invalid/refused gateways have no direct fallback. Dropping the native worker guard
closes the listener and existing tunnels.

The spending checkpoint receives one host-selected loopback listening port, routed
through the same private proxy. A port conflict stops isolated startup; it cannot
silently start without metering. Complete provider base paths are preserved
separately from the existing root-style meter upstream overrides. OpenRouter is
routed through the checkpoint, and DeepSeek accepts its native or legacy key;
checkpoint-owned credentials replace both key names.
Normal HTTPS validation uses Apple's certificate-validation service, without
keychain access. Node startup receives same-sandbox parent identity access, the
specific OS fields required by uname, and metadata access to its host-opened log.

## Evidence and limits

The packaged proof runs the actual Electron app, native create/start/stop commands,
ACP harness, Colony Agent, browser MCP, file/shell tools and an isolated local relay.
The model responses, identities, credentials and page content are synthetic. It
proves page reading/editing, denied sibling grant/profile reads, real CLI replies,
owner takeover, read-only enforcement, process restart and full app relaunch.
Fresh sharing is required after either restart. Separate process tests exercise
symlinks, network bypass, unrelated process inspection and gateway shutdown. A
public HTTPS probe verifies certificate validation without provider credentials.

Earlier Gate 1 was test-only: 11 process tests passed and changing deny-default to
allow-default made 9 fail. Native adoption exposed and corrected additional log,
Node bootstrap, metering, TLS and grant-generation integration failures.

This is an access boundary for Colony-managed workers, not a VM, resource quota,
or protection against arbitrary unsandboxed applications running as the Mac user.
A deliberately detached process retains its original filesystem policy; it never
inherits renewed browser/network credentials. Normal shutdown cleans managed
children, but this phase does not claim adversarial process-tree termination.
Publication/updater distribution, notarization, real provider billing and the
Instagram content pilot remain separate proof gates. No production promotion or
social publication is included.
