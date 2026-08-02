# Colony Discovery live UI and Leads gate

Date: 2026-08-02
Branch: `codex/discovery-next`

## Proven locally

- The private Nostr workspace contract persists entitled Businesses campaigns
  and exposes retained normalized businesses as Leads to authorized humans and
  capable agents.
- A run must reference a persisted campaign and exactly match its immutable
  search. New normalized businesses become `new` Leads automatically; an
  existing workspace business is neither stored nor attached to a later
  campaign again.
- Inactive entitlement blocks real campaign and Lead reads. Revocation fences
  active work. Retained records remain stored and become readable again after
  entitlement restoration.
- The production desktop route uses the relay data source when entitled and the
  cost-free fixture demo when inactive. People, Outreach, and Conversations do
  not enter the live path in this phase.
- The native worker reads the user's Outscraper credential from the existing
  secure credential path. Credentials, provider request IDs, raw provider
  payloads, and monetary-credit claims are absent from campaign, Lead, action,
  and receipt records.
- `buzz discovery` exposes access, campaign create/get/list, Lead list, and the
  existing durable run lifecycle, so the primitive is not tied to one agent.

## Evidence

- `scripts/discovery-outscraper-source-proof.sh` passed against an isolated
  relay and loopback provider, including restart recovery, automatic Leads,
  privacy, cancellation, entitlement fencing, bounded retry, and failure
  classification. It made no paid provider request.
- Discovery protocol, SDK, CLI, relay, database, search-index, worker, and
  desktop-adapter focused tests passed.
- The Discovery Playwright parity journey passed and produced 17 distinct
  screenshots.
- `just ci` passed after the final change: formatting, warning-denying Clippy,
  desktop/web/mobile checks, production builds, 4,044 desktop tests, 1,997
  desktop-native tests, and 914 mobile tests.
- `/Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-engine`
  remained clean on `codex/discovery-engine` at `fa52ff60d`.

## Deliberately unproven release states

- No real Outscraper endpoint was contacted because that spends the user's
  provider credits and needs explicit approval.
- This branch has not been pushed, merged into `develop`, promoted to `main`,
  deployed, or customer-proven.
- LAKA billing-provider integration and a real subscription lifecycle are a
  separate product/release gate; this phase consumes the relay's existing
  entitlement authority without inventing pricing or checkout behavior.
