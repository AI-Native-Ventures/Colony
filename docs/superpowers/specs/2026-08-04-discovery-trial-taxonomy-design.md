# Discovery Trial and Complete Taxonomy Design

## Problem

The production Discovery surface has two related release blockers:

1. Every normal Colony workspace is denied live Discovery because the relay only
   supports manually toggled boolean entitlements and the desktop labels the
   unavailable state as "LAKA".
2. Colony advertises 34 business industries but only contains vertical records
   for Automotive and Professional Services. Selecting Real Estate or most other
   industries therefore produces an empty screen.

The defects are in the merged product paths, not in the user's setup. A desktop
only bypass would still prevent agents and workers from running Discovery, and
adding a few more fixture rows would leave the taxonomy incomplete.

## Approved Product Behavior

- Every existing Colony community receives a 30-day Discovery trial when the
  relay migration is deployed.
- Every newly created community receives a 30-day Discovery trial automatically.
- A trial is real server-side access. It applies equally to the native UI and
  to any authorized agent using the Discovery capability.
- Explicit revocation or expiry immediately prevents new work and stops active
  runs through the existing entitlement-revocation path.
- Paid access can later be represented by an active entitlement with no expiry.
- The desktop must not display the placeholder name "LAKA".
- Colony owns a provider-neutral static snapshot of the actual SalesTeams
  business taxonomy. Colony must not acquire a runtime Supabase dependency.
- Phase one remains business discovery only; this change does not expand people
  discovery or outreach scope.

## Architecture

### Server-enforced trial

`discovery_entitlements` gains a nullable `expires_at` column. Effective access
is `active AND (expires_at IS NULL OR expires_at > now())`. The migration inserts
one active, 30-day entitlement for every existing community and installs an
`AFTER INSERT` trigger on `communities` that creates the same entitlement for a
new community.

All authorization reads, workspace access reads, worker lease checkpoints, and
provider preflight reads use the same effective-access expression. The existing
manual `set_discovery_entitlement` operation remains the administrative switch:
enabling access writes a permanent entitlement (`expires_at = NULL`), while
disabling access cancels running work exactly as it does today.

### Colony-owned taxonomy snapshot

The current SalesTeams `master_industries` and `master_verticals` rows are
exported once into a typed Colony source file. It contains 34 active industries
and 531 active approved business verticals. Vertical identity is the canonical
SalesTeams slug scoped by industry slug. Missing source descriptions receive a
deterministic local sentence rather than a blank card.

The existing fixture data source continues to own demo campaigns, leads, and
run timelines. It imports the taxonomy snapshot and decorates canonical
verticals with those fixture metrics. The Auto Repair campaign remains attached
to `automotive/auto-repair`. The Professional Services demo campaign moves from
the invented `accounting-practices` slug to the canonical
`accounting-financial-advisory` slug.

All vertical cards use their parent industry's image. Canonical industry slug
aliases map `financial-services`, `hospitality`, `mining-resources`, and
`home-living` to the corresponding Colony-owned image files. This avoids both a
531-image copy and the current incorrect Automotive fallback.

## Compatibility

- Persisted campaign records keep their stored names and slugs; the relay does
  not rewrite them.
- The demo-only `accounting-practices` route is redirected in the fixture read
  path to `accounting-financial-advisory` so existing screenshots or bookmarks
  do not crash.
- Runtime Discovery source credentials and provider execution are unchanged.
- No pricing, checkout flow, billing vendor, or recurring usage charge is
  introduced.

## Acceptance Gate

The phase passes only when all of the following are proven:

1. The old taxonomy test fails because most advertised industries return zero
   verticals, then the corrected test passes with exactly 34 industries and 531
   verticals.
2. Every industry's advertised `verticalCount` equals the number returned by
   `getVerticals`.
3. Real Estate returns exactly 14 canonical verticals, including Residential
   Real Estate, Commercial Real Estate, and Property Development.
4. Existing and newly inserted communities receive active 30-day trials.
5. Expired and explicitly revoked entitlements deny new work; revocation still
   stops an active run; `expires_at = NULL` remains valid permanent access.
6. A trial workspace can create and run live Discovery from the desktop test
   surface, and no user-facing Discovery copy contains "LAKA".
7. Discovery unit tests, database integration tests on a fresh database,
   desktop E2E, and `just ci` pass.

