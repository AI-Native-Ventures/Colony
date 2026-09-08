# Managed teammate access to the Electron browser

This is Gate 2 of the approved installable-beta phase, following the relocatable
package. The owner shares a tab with a named running local teammate and chooses
read or interact. The product handles MCP configuration; the owner never handles
a file path or token. Take control revokes the grant immediately.

## Local connection

Electron creates a private temporary browser-runtime directory at startup and
passes its location, its executable and the packaged MCP module path to the
private native host. Every local managed process receives a server configuration
through the existing ACP session/new MCP-server list. A server starts without a
tab grant and reports that the owner has not shared a tab yet. It reads the
worker-specific grant file on each call, so sharing works without restarting an
agent or interrupting its work.

The grant filename is derived from normalized relay URL plus the full managed
agent public key. Neither configuration nor bearer tokens enter relay events,
public agent definitions or chat. Reserve the new harness environment keys
against per-agent/global config overrides. Clear the Electron variables when
launching ordinary Tauri or remote agents.

## Authority

The trusted owner renderer requests a roster through Electron. Electron reads
the native owner/community-scoped managed-agent roster, projects only public
selection fields, and offers eligible running local owner-only agents. On share,
it re-reads the roster, verifies the tab belongs to the active business and the
agent belongs to its relay, then creates the existing single-tab scoped token.
Other users of a shared agent must not acquire the owner's signed-in accounts;
shared-audience agents are ineligible in this beta.

Each broker request checks the existing token, tab, origin, revision and mode,
then rechecks native worker status and eligibility. Stopped agents, changed
ownership/audience/community, a closed tab, cross-origin navigation, takeover,
renderer reset or application exit revoke access. Failed native validation
denies access; it never falls back to an unscoped browser or DevTools endpoint.

## UI

Replace the manual Agent connection disclosure in ElectronWebBody with a
teammate selector, read/interact selector and Share button. Show who has control,
the chosen mode, and a persistent Take control action. Empty state explains that
a local teammate must be running. Show actionable errors rather than configuration
terms. Technical grant transport remains internal.

## Proof

Unit tests exercise wrong business/relay, unowned or shared agents, stale
running status, grant replacement and all revocation paths. ACP tests prove
ordinary Tauri stays unchanged, incomplete Electron configuration fails closed,
and the exact executable/arguments/environment reach session/new. Run a real
managed-process integration with a deterministic local model fixture to prove
MCP discovery and actual browser tool execution; label the model fixture
explicitly. A real provider and owner-selected Instagram sign-in are the final
live pilot gate, with drafts only and no publication.


## Security gate discovered during implementation (2026-09-08)

This design is a local draft, not ready to enable for arbitrary agents.
Independent review reproduced an unassigned process reading a sibling worker's
JSON grant and using it against the real local broker. Local agents currently
run under the same OS user with general filesystem access. Bearer tokens and
roster eligibility checks do not establish process isolation, and the browser
profile itself also needs protection. The owner-only picker is an access policy
for cooperating agents; it is not a boundary against a malicious local agent.

The founder approved agent containment before enabling signed-in browser work on
2026-09-08. The scope decision is resolved; see
[the isolation design](2026-09-08-local-agent-isolation-design.md). The first local
process-boundary gate is proven, but native launch adoption and real managed-browser
execution remain outstanding. Keep this feature unpublished until those gates pass.

Current local implementation includes the owner controls, private ACP startup
configuration, late-read MCP grant, explicit owner attribution, and worker status
checks. New shares and queued tool calls check current eligibility. An already
started page operation is not undone by a worker exit; immediate owner takeover
is checked at existing page-operation boundaries. Real managed-process browser
execution remains unproven.

Independent review also reproduced and corrected two asynchronous races: takeover
while a share awaited the native roster, and stale validation revoking a newer
grant. Both regressions failed before the fixes and passed afterwards. Tab grant
epochs now fence takeover, cleanup revokes only its own token, and per-worker
serialization protects file replacement. A delayed-rename regression covers the
replacement order. Re-review found no remaining blocker in those race fixes.


The existing tool implementations confirm this is an execution-boundary issue:
`crates/buzz-dev-mcp/src/paths.rs::resolve_path` accepts and canonicalizes absolute
paths outside the working directory, and `shell.rs::run` starts a normal shell
under the same OS user. Restricting only the browser tool's arguments cannot
protect the host's browser storage from that shell. A containment phase must
cover file tools, shell children, browser data and broker access together, while
preserving explicitly granted project files and required model/network access.

The acceptance test for containment should run an unassigned real agent with
its normal tools and prove it cannot read another agent's grant or Chromium
profile, cannot use another worker's browser connection, and cannot regain
access after takeover/restart. The assigned agent must still complete useful
browser work and owner-approved file operations. Token naming, prompt rules and
hiding the grant path are not substitutes for that test.


Local draft verification: full `just ci` passed after these corrections (6,845
desktop tests, 2,894 native tests with 21 existing ignores, 967 mobile tests with
one existing skip). Focused ACP configuration and persistent MCP subprocess tests
passed. Independent re-review ran 13 authority/managed-worker tests successfully.
These checks do not prove agent containment or real managed-agent browser work.
