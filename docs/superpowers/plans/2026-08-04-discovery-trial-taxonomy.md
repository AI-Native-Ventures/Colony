# Discovery Trial and Complete Taxonomy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Colony community a server-enforced 30-day Discovery trial and replace the incomplete business taxonomy fixture with the complete 34-industry, 531-vertical SalesTeams snapshot.

**Architecture:** PostgreSQL remains the entitlement authority and gains expiry-aware access plus automatic trial provisioning. The desktop consumes a static, typed, provider-neutral taxonomy snapshot while the fixture layer continues to decorate it with demo campaigns and lead metrics. No runtime Supabase dependency or client-only entitlement bypass is introduced.

**Tech Stack:** PostgreSQL migrations, Rust/sqlx, TypeScript/React, Node test runner, Playwright, Tauri E2E bridge.

---

## File Map

- Create `migrations/0041_discovery_trials.sql`: expiry column, existing-community seed, and new-community trial trigger.
- Modify `schema/schema.sql`: canonical fresh-install schema for the trial entitlement.
- Modify `crates/buzz-db/src/discovery.rs`: central effective-entitlement SQL and expiry-aware authorization/checkpoints.
- Modify `crates/buzz-db/src/discovery_workspace.rs`: expiry-aware workspace access result.
- Modify `crates/buzz-db/src/migration.rs`: migration contract assertions.
- Modify `crates/buzz-test-client/tests/e2e_discovery.rs`: live access/expiry behavior.
- Create `desktop/src/features/discovery/data/businessTaxonomy.ts`: typed snapshot of 34 industries and 531 verticals.
- Modify `desktop/src/features/discovery/data/fixtures.ts`: build business hierarchy from the snapshot and preserve demo decorations.
- Modify `desktop/src/features/discovery/data/FixtureDiscoveryDataSource.ts`: canonical compatibility alias and generic entitlement model.
- Modify `desktop/src/features/discovery/assets.ts`: parent-industry image resolution and canonical aliases.
- Modify `desktop/src/features/discovery/data/RelayDiscoveryDataSource.ts`: remove LAKA copy while retaining relay authority.
- Modify `desktop/src/features/discovery/data/relayDiscoveryModels.ts`: generic revocation copy.
- Modify `desktop/src/features/discovery/useDiscoveryRun.ts`: generic access error copy.
- Modify `desktop/src/features/discovery/ui/EntitlementLock.tsx`: generic access-required dialog.
- Modify `desktop/src/features/discovery/data/discoveryData.test.mjs`: complete taxonomy regression contract.
- Modify `desktop/src/features/discovery/data/RelayDiscoveryDataSource.test.mjs`: generic entitlement expectations.
- Modify `desktop/tests/e2e/discovery.spec.ts`: trial-enabled live path and absence of LAKA copy.

### Task 1: Prove the taxonomy defect

- [ ] **Step 1: Add a failing completeness test**

In `desktop/src/features/discovery/data/discoveryData.test.mjs`, load all
industries and assert that every returned vertical array matches
`industry.verticalCount`, that the global total is 531, and that Real Estate is
the canonical 14-row list:

```js
const verticalGroups = await Promise.all(
  industries.map(async (industry) => ({
    industry,
    verticals: await source.getVerticals(industry.id),
  })),
);
assert.equal(
  verticalGroups.reduce((total, group) => total + group.verticals.length, 0),
  531,
);
for (const { industry, verticals } of verticalGroups) {
  assert.equal(verticals.length, industry.verticalCount, industry.name);
  assert.ok(verticals.length > 0, industry.name);
  assert.equal(new Set(verticals.map(({ id }) => id)).size, verticals.length);
}
const realEstate = verticalGroups.find(
  ({ industry }) => industry.id === "real-estate",
);
assert.equal(realEstate.verticals.length, 14);
assert.ok(
  realEstate.verticals.some(({ id }) => id === "residential-real-estate"),
);
assert.ok(realEstate.verticals.some(({ id }) => id === "commercial-real-estate"));
assert.ok(realEstate.verticals.some(({ id }) => id === "property-development"));
```

- [ ] **Step 2: Run the regression against the unfixed code**

Run:

```bash
cd desktop && node --import tsx --test src/features/discovery/data/discoveryData.test.mjs
```

Expected: FAIL because the current total is 28 and Real Estate returns zero
verticals.

- [ ] **Step 3: Commit the red test**

```bash
git add desktop/src/features/discovery/data/discoveryData.test.mjs
git commit -s -m "test(discovery): require the complete business taxonomy"
```

### Task 2: Import the authoritative business taxonomy

- [ ] **Step 1: Export only public taxonomy fields from SalesTeams**

Use the existing SalesTeams Supabase client in read-only mode to fetch active
`master_industries` and active approved `master_verticals`. Emit only IDs,
slugs, names, descriptions, display order, and industry relationships. Do not
copy credentials or Supabase client code into Colony.

- [ ] **Step 2: Add the typed snapshot**

Create `desktop/src/features/discovery/data/businessTaxonomy.ts` with this
shape and the complete exported rows:

```ts
export type BusinessTaxonomyVertical = {
  slug: string;
  name: string;
  description?: string;
};

export type BusinessTaxonomyIndustry = {
  slug: string;
  name: string;
  description?: string;
  verticals: readonly BusinessTaxonomyVertical[];
};

export const BUSINESS_TAXONOMY = [
  // 34 ordered industries containing all 531 ordered verticals.
] as const satisfies readonly BusinessTaxonomyIndustry[];
```

- [ ] **Step 3: Build fixture hierarchy from the snapshot**

Replace `INDUSTRY_DEFINITIONS` and the hand-written business vertical arrays in
`fixtures.ts` with maps over `BUSINESS_TAXONOMY`. Set `verticalCount` from the
actual array length, use a deterministic fallback description, and decorate
only the two existing demo campaign verticals:

```ts
const DEMO_VERTICAL_CAMPAIGNS = new Map([
  ["automotive/auto-repair", AUTO_REPAIR_CAMPAIGN],
  [
    "professional-services/accounting-financial-advisory",
    ACCOUNTING_CAMPAIGN,
  ],
]);

export const FIXTURE_VERTICALS: Vertical[] = BUSINESS_TAXONOMY.flatMap(
  (industry) =>
    industry.verticals.map((vertical) => ({
      id: vertical.slug,
      slug: vertical.slug,
      industryId: industry.slug,
      name: vertical.name,
      description:
        vertical.description ??
        `Discover businesses in the ${vertical.name} vertical.`,
      imageKey: `industry.${industry.slug}`,
      campaignCount: DEMO_VERTICAL_CAMPAIGNS.has(
        `${industry.slug}/${vertical.slug}`,
      )
        ? 1
        : 0,
      leadCount:
        vertical.slug === "auto-repair"
          ? 10
          : vertical.slug === "accounting-financial-advisory"
            ? 308
            : 0,
      status: DEMO_VERTICAL_CAMPAIGNS.has(
        `${industry.slug}/${vertical.slug}`,
      )
        ? "active"
        : "available",
    })),
);
```

- [ ] **Step 4: Move the demo accounting campaign to the canonical slug**

Update the demo campaign and derived detail checks from
`accounting-practices` to `accounting-financial-advisory`. In
`FixtureDiscoveryDataSource.getVertical`, translate the legacy demo slug before
lookup:

```ts
const LEGACY_VERTICAL_ALIASES: Record<string, string> = {
  "professional-services/accounting-practices":
    "accounting-financial-advisory",
};
```

- [ ] **Step 5: Resolve canonical parent-industry images**

Add asset keys for `industry.home-living`, `industry.financial-services`,
`industry.hospitality`, and `industry.mining-resources`. Add an
industry-aware fallback so unknown `vertical.*` keys cannot silently show the
Automotive image.

- [ ] **Step 6: Run and pass the taxonomy tests**

Run:

```bash
cd desktop && node --import tsx --test src/features/discovery/data/discoveryData.test.mjs
```

Expected: PASS with 34 industries, 531 verticals, and 14 Real Estate verticals.

- [ ] **Step 7: Commit the taxonomy fix**

```bash
git add desktop/src/features/discovery
git commit -s -m "fix(discovery): ship the complete business taxonomy"
```

### Task 3: Prove and implement server-enforced 30-day trials

- [ ] **Step 1: Add migration contract assertions first**

Extend `crates/buzz-db/src/migration.rs` to assert that migration 0041 adds a
nullable expiry, seeds existing communities, and installs the new-community
trigger. The assertion must fail before the migration exists.

- [ ] **Step 2: Run the migration unit test red**

Run:

```bash
cargo test -p buzz-db migration --lib
```

Expected: FAIL because `0041_discovery_trials.sql` is absent.

- [ ] **Step 3: Add the trial migration**

Create `migrations/0041_discovery_trials.sql`:

```sql
ALTER TABLE discovery_entitlements
    ADD COLUMN expires_at TIMESTAMPTZ;

INSERT INTO discovery_entitlements (community_id, active, expires_at, updated_at)
SELECT id, TRUE, now() + interval '30 days', now()
FROM communities
ON CONFLICT (community_id) DO UPDATE
SET active = TRUE,
    expires_at = now() + interval '30 days',
    updated_at = now();

CREATE FUNCTION provision_discovery_trial() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO discovery_entitlements
        (community_id, active, expires_at, updated_at)
    VALUES (NEW.id, TRUE, now() + interval '30 days', now());
    RETURN NEW;
END;
$$;

CREATE TRIGGER communities_provision_discovery_trial
AFTER INSERT ON communities
FOR EACH ROW EXECUTE FUNCTION provision_discovery_trial();
```

Mirror the resulting table, function, and trigger in `schema/schema.sql`.

- [ ] **Step 4: Centralize effective access**

In every Discovery authorization and checkpoint query, replace raw
`e.active`/`SELECT active` with:

```sql
COALESCE(
    e.active AND (e.expires_at IS NULL OR e.expires_at > now()),
    FALSE
)
```

For single-table reads use:

```sql
SELECT active AND (expires_at IS NULL OR expires_at > now())
FROM discovery_entitlements
WHERE community_id = $1
```

Update `set_discovery_entitlement` so a manual activation represents permanent
access and clears expiry:

```sql
INSERT INTO discovery_entitlements
    (community_id, active, expires_at, updated_at)
VALUES ($1, $2, NULL, now())
ON CONFLICT (community_id) DO UPDATE
SET active = EXCLUDED.active,
    expires_at = NULL,
    updated_at = now()
```

- [ ] **Step 5: Add database behavior tests**

Using the existing ignored Discovery database suite, assert:

```rust
// Existing community seeded by migration has an expiry about 30 days away.
// A community inserted after migrations receives its own expiry about 30 days away.
// An entitlement with expires_at in the past returns EntitlementInactive.
// An active entitlement with expires_at NULL remains authorized.
// set_discovery_entitlement(false) still stops a running job immediately.
```

- [ ] **Step 6: Run migration and Discovery database tests on a fresh database**

Run the migration unit tests, then the ignored Discovery database suite using a
new isolated database as documented by the repository integration test setup.
Expected: all pass; no checksum reuse against a persistent developer database.

- [ ] **Step 7: Commit the server trial**

```bash
git add migrations/0041_discovery_trials.sql schema/schema.sql \
  crates/buzz-db/src/discovery.rs crates/buzz-db/src/discovery_workspace.rs \
  crates/buzz-db/src/migration.rs crates/buzz-test-client/tests/e2e_discovery.rs
git commit -s -m "feat(discovery): provision 30-day workspace trials"
```

### Task 4: Remove LAKA copy and prove the desktop trial experience

- [ ] **Step 1: Replace product copy without weakening authority**

Remove `planName: "LAKA"` and replace all user-facing strings with generic
Discovery access language:

```ts
"Discovery access is required to create a live campaign."
"Discovery access is required to run live Discovery."
"Discovery stopped because this workspace no longer has Discovery access."
```

Change `EntitlementLock` to display `Discovery access required`; retain the
relay-derived state and do not enable its run action when access is inactive.

- [ ] **Step 2: Update unit expectations**

Change fixture and relay data-source tests to assert no plan name and generic
access errors. Add a source-tree assertion that Discovery TypeScript/TSX files
contain no `LAKA` token.

- [ ] **Step 3: Update desktop E2E**

The E2E fixture remains entitled by default to model the 30-day trial. Replace
the LAKA screenshot state with a generic expired-access state and prove:

```ts
await expect(page.getByText(/LAKA/i)).toHaveCount(0);
await expect(page.getByRole("button", { name: "Create Campaign" })).toBeEnabled();
```

Navigate to Real Estate and assert all 14 cards are rendered in the scrollable
workspace.

- [ ] **Step 4: Run focused desktop proof**

Run:

```bash
cd desktop
pnpm test
pnpm test:e2e:smoke -- --grep "Discovery"
```

Expected: PASS with the E2E mock bridge built through `build:e2e`.

- [ ] **Step 5: Commit the product copy and E2E proof**

```bash
git add desktop/src/features/discovery desktop/tests/e2e/discovery.spec.ts
git commit -s -m "fix(discovery): replace the LAKA placeholder with trial access"
```

### Task 5: Full acceptance gate and delivery

- [ ] **Step 1: Scan for incomplete product copy and taxonomy counts**

Run:

```bash
rg -n "LAKA" desktop/src/features/discovery desktop/tests/e2e/discovery.spec.ts
```

Expected: no product-source matches.

- [ ] **Step 2: Run the full repository gate**

Run:

```bash
. ./bin/activate-hermit
just ci
```

Expected: formatting, clippy, desktop lint, unit tests, and builds all pass.

- [ ] **Step 3: Run Discovery integration coverage**

Run `just test` with fresh Postgres and Redis because the change touches
`buzz-db` Discovery authorization. Expected: all integration tests pass.

- [ ] **Step 4: Review the final diff and ancestry**

Run:

```bash
git diff --check
git status --short
git log --oneline --decorate origin/develop..HEAD
git diff --stat origin/develop...HEAD
```

Expected: only the approved trial, taxonomy, copy, tests, and plan files.

- [ ] **Step 5: Push and open a ready PR into develop**

```bash
git push -u origin codex/discovery-trial-taxonomy
gh pr create --repo AI-Native-Ventures/Colony \
  --base develop \
  --head codex/discovery-trial-taxonomy \
  --title "Fix Discovery trials and complete the business taxonomy"
```

The PR must report separately what is implemented, locally proven, merged,
deployed, and live-proven. Do not claim production success before relay and
desktop releases have adopted the merge.

