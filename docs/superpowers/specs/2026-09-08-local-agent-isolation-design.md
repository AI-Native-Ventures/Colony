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

## Gate 1 findings

The policy is currently compiled only into native tests. It does not yet isolate
agents launched by the desktop. Keeping that separation avoids enabling browser
sharing on the strength of a standalone sandbox test.

Real-process proof on this Mac now covers shell children, Colony's `buzz-dev-mcp`,
and a complete `buzz-agent` ACP session using that real MCP child. A deterministic
local HTTP model asks for a useful draft, then attempts a sibling-grant read.
The draft is created, the read is denied by the OS, and the agent shuts down its
MCP process group. No real provider, relay, browser profile, or social account is
used in this gate.

The tests also cover exact host-file permissions across atomic replacement,
policy-parameter injection, symlink and new hardlink escapes, sibling process
environment inspection and signalling, attempted resandboxing, environment
clearing, and allowed versus forbidden local socket/port connections. Positive
controls run the same attacks or connections without isolation.

Two implementation corrections came from actual failures: current macOS requires
its Apple-maintained `dyld-support.sb` bootstrap policy, and Rust requires the
`hw.pagesize_compat` sysctl to initialize its stack guard. Neither is a reason to
allow arbitrary home reads or broad process inspection.

Seatbelt's network-address grammar accepts `localhost` or `*`, not arbitrary
resolved destination IPs. The API therefore permits explicit loopback ports,
with external connections and DNS denied. Gate 2 needs a trusted per-worker
network gateway that enforces relay/provider destinations. A proxy environment
variable alone is insufficient: all actual WebSocket and HTTP paths must adopt
it, and attempts to bypass it must fail. Do not weaken this to unrestricted
network access to make an existing harness start.

Remaining adoption work: native launch wrapping, private storage and credential
provisioning, exact packaged runtime permissions, controlled outbound networking,
unsupported-harness/platform failure behavior, and managed restart/takeover proof.
Signed-in browser access remains unpublished pending those gates.
