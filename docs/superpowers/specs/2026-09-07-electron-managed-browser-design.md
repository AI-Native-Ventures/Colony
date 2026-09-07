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
