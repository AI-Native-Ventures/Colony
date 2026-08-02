# Colony Discovery live UI and Leads implementation plan

Design: `docs/superpowers/specs/2026-08-02-colony-discovery-live-ui-leads-design.md`

## Gate 1: Private workspace records

- [ ] Add core campaign, Lead, access, pagination, action, and receipt contracts
  with strict bounds and canonical serialization tests.
- [ ] Add workspace action/receipt event kinds to every write/read/search/privacy
  classification and drift test.
- [ ] Add SDK builders/parsers for exact signed workspace envelopes.
- [ ] Add migration `0036_discovery_workspace_records.sql` for campaigns and
  idempotent action claims.
- [ ] Add database authorization, create/get/list campaign, list Lead, and
  action/receipt transaction operations.
- [ ] Require stored campaign search equality when starting a run.
- [ ] Add relay broker routing and isolated integration tests.
- [ ] Commit: `feat(discovery): persist private campaigns and leads`.

## Gate 2: Agent command parity

- [ ] Extend `buzz discovery` with access, campaign create/get/list, and Leads
  list commands.
- [ ] Verify human and granted-agent authorization, stable IDs, bounded output,
  inactive entitlement, and safe errors against an isolated relay.
- [ ] Commit: `feat(discovery): expose campaign and lead commands`.

## Gate 3: Production-aware desktop adapter

- [ ] Implement canonical signed workspace/run action submission and strict
  relay-receipt verification in TypeScript.
- [ ] Implement a hybrid `DiscoveryDataSource`: fixture demo when inactive;
  fixture taxonomy plus relay campaigns/runs/Leads when active.
- [ ] Map the existing campaign creation form to Businesses-only persisted
  campaign search fields and fixed Outscraper source configuration.
- [ ] Map signed run status polling to the existing Discovery event stream and
  cancellation/retry controls.
- [ ] Keep People, Outreach, and Conversations out of the live path with clear
  preview boundaries.
- [ ] Reset all community-scoped adapter caches in `resetCommunityState()`.
- [ ] Commit: `feat(discovery): connect entitled UI to live records`.

## Gate 4: End-to-end proof

- [ ] Prove non-entitled fixture demo and access denial for real records.
- [ ] Prove entitled create -> run -> progress -> automatic Leads in the native
  UI using the isolated relay and loopback provider.
- [ ] Prove rerun/cross-campaign dedup, restart recovery, cancel, entitlement
  revocation, bounded pagination, agent parity, and secret absence.
- [ ] Capture distinct browser screenshots for demo, live campaign progress,
  and retained Leads; inspect them before reporting visual proof.
- [ ] Run focused tests, source proof, `git diff --check`, production marker
  scan, and `just ci`.
- [ ] Recheck the untouched `discovery-engine` worktree.
- [ ] Record implemented/tested/committed separately from real-provider-tested,
  pushed, merged, deployed, and customer-proven.
- [ ] Commit: `docs(discovery): record live UI and Leads gate`.
