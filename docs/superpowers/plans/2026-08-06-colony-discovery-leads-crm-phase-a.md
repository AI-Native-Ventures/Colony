# Colony Discovery Leads + CRM — Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Leads the default Discovery surface (Leads + Discover tabs, empty state with Discover more) and replace hardcoded fixture counts with real relay-aggregated lead counts, sorted highest-first.

**Architecture:** Extend the existing 40021/40022 Discovery workspace contract with one new `list_lead_counts` operation; the relay aggregates retained observations per industry/vertical and returns a private signed receipt. The desktop adapter merges those counts into the existing fixture taxonomy in live mode, and the existing Discovery UI gains a top-level two-tab navigation with a leads empty state.

**Tech Stack:** Rust (buzz-core, buzz-sdk, buzz-db, buzz-relay, buzz-cli), Postgres, React 19 + TanStack Router + Tailwind (desktop), Playwright, node:test.

**Spec:** `docs/superpowers/specs/2026-08-06-colony-discovery-leads-crm-design.md`

---

## Task 1: Migration — allow `list_lead_counts` in workspace action claims

**Files:**
- Create: `migrations/0045_discovery_workspace_ops.sql`

- [ ] **Step 1: Write the migration**

Create `migrations/0045_discovery_workspace_ops.sql`:

```sql
-- Phase A: extend the private Discovery workspace contract with lead-count
-- aggregation. The operation check must admit every current operation plus
-- the new list_lead_counts read.
ALTER TABLE discovery_workspace_action_claims
    DROP CONSTRAINT discovery_workspace_action_claims_operation_check,
    ADD CONSTRAINT discovery_workspace_action_claims_operation_check
        CHECK (operation IN (
            'access',
            'create_campaign',
            'update_campaign_sources',
            'get_campaign',
            'list_campaigns',
            'list_leads',
            'list_lead_counts'
        ));
```

- [ ] **Step 2: Apply to a scratch database and verify the constraint**

Run against the isolated Postgres used by the relay harness:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0045_discovery_workspace_ops.sql
```

Expected: no error, and the constraint now contains `'list_lead_counts'`:

```sql
SELECT pg_get_constraintdef(oid) FROM pg_constraint
WHERE conname = 'discovery_workspace_action_claims_operation_check';
```

- [ ] **Step 3: Commit**

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-leads-crm
git add migrations/0045_discovery_workspace_ops.sql
git commit -s -m "migrate(discovery): admit list_lead_counts workspace operation"
```

---

## Task 2: Core contract — `ListLeadCounts` operation and projection

**Files:**
- Modify: `crates/buzz-core/src/discovery_workspace.rs`
- Test: same file, `#[cfg(test)] mod tests`

- [ ] **Step 1: Write the failing tests**

Add to `#[cfg(test)] mod tests` in `crates/buzz-core/src/discovery_workspace.rs`:

```rust
#[test]
fn lead_counts_round_trip_and_operation_mapping() {
    let counts = DiscoveryLeadCounts {
        total: 2,
        industries: vec![DiscoveryLeadCountRow {
            industry_id: "healthcare".into(),
            vertical_id: None,
            count: 2,
        }],
        verticals: vec![DiscoveryLeadCountRow {
            industry_id: "healthcare".into(),
            vertical_id: Some("dentists".into()),
            count: 2,
        }],
    };
    let value = serde_json::to_value(&counts).expect("serialize counts");
    let decoded: DiscoveryLeadCounts =
        serde_json::from_value(value).expect("decode counts");
    assert_eq!(decoded, counts);

    let request = DiscoveryWorkspaceRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        payload: DiscoveryWorkspaceActionPayload::ListLeadCounts,
    };
    assert_eq!(
        request.payload.operation(),
        DiscoveryWorkspaceOperation::ListLeadCounts
    );
    assert_eq!(request.validate(), Ok(()));

    let result = DiscoveryWorkspaceResult::LeadCounts { counts };
    let encoded: DiscoveryWorkspaceResult =
        serde_json::from_value(serde_json::to_value(&result).expect("serialize"))
            .expect("decode");
    assert_eq!(encoded, result);
}
```

- [ ] **Step 2: Run the test to verify it fails to compile**

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-leads-crm
. ./bin/activate-hermit
cargo test -p buzz-core discovery_workspace
```

Expected: compiler errors for `DiscoveryLeadCounts`, `DiscoveryLeadCountRow`, `ListLeadCounts`, and `LeadCounts`.

- [ ] **Step 3: Add the projection types**

After `DiscoveryLeadPage` in `crates/buzz-core/src/discovery_workspace.rs`:

```rust
/// One aggregated retained-Lead count for a taxonomy row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryLeadCountRow {
    /// Taxonomy industry identifier.
    pub industry_id: String,
    /// Taxonomy vertical identifier; present when this row counts a vertical.
    pub vertical_id: Option<String>,
    /// Number of retained Leads in the workspace for this row.
    pub count: u32,
}

/// Aggregated retained-Lead counts for taxonomy grids.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryLeadCounts {
    /// Total retained Leads in the workspace.
    pub total: u32,
    /// Counts per industry, highest first.
    pub industries: Vec<DiscoveryLeadCountRow>,
    /// Counts per vertical within their industry, highest first.
    pub verticals: Vec<DiscoveryLeadCountRow>,
}
```

- [ ] **Step 4: Add the operation variant**

In `enum DiscoveryWorkspaceOperation`, after `ListLeads`:

```rust
    /// List retained-Lead counts per taxonomy row.
    ListLeadCounts,
```

- [ ] **Step 5: Add the payload variant**

In `enum DiscoveryWorkspaceActionPayload`, after `ListLeads`:

```rust
    /// List retained-Lead counts per taxonomy row.
    ListLeadCounts,
```

Add the `operation()` arm after `Self::ListLeads { .. }`:

```rust
            Self::ListLeadCounts => DiscoveryWorkspaceOperation::ListLeadCounts,
```

Add the `validate()` arm after `Self::ListLeads { request }`:

```rust
            Self::ListLeadCounts => Ok(()),
```

- [ ] **Step 6: Add the result variant**

In `enum DiscoveryWorkspaceResult`, after `Leads`:

```rust
    /// Aggregated retained-Lead counts.
    LeadCounts {
        /// Complete entitled count aggregation.
        counts: DiscoveryLeadCounts,
    },
```

- [ ] **Step 7: Run the tests**

```bash
cargo test -p buzz-core discovery_workspace
```

Expected: PASS, including the new `lead_counts_round_trip_and_operation_mapping` test.

- [ ] **Step 8: Commit**

```bash
git add crates/buzz-core/src/discovery_workspace.rs
git commit -s -m "feat(core): add list_lead_counts workspace operation"
```

---

## Task 3: SDK wire compatibility for the new operation

**Files:**
- Modify: `crates/buzz-sdk/src/discovery_workspace.rs`
- Test: same file

- [ ] **Step 1: Write the failing test**

Add a test in `crates/buzz-sdk/src/discovery_workspace.rs` (after the existing envelope tests):

```rust
#[test]
fn list_lead_counts_is_v2_only() {
    let relay = nostr::Keys::generate().public_key();
    let request = buzz_core::discovery_workspace::DiscoveryWorkspaceRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        payload: buzz_core::discovery_workspace::DiscoveryWorkspaceActionPayload::ListLeadCounts,
    };
    assert!(
        build_discovery_workspace_action_for_version(
            DiscoveryWorkspaceWireVersion::V2,
            relay,
            &request,
        )
        .is_ok(),
        "v2 must carry the new operation"
    );
    assert!(
        build_discovery_workspace_action_for_version(
            DiscoveryWorkspaceWireVersion::V1,
            relay,
            &request,
        )
        .is_err(),
        "v1 must reject an operation it cannot represent"
    );
}
```

Ensure `Uuid` is imported in the test module (add `use uuid::Uuid;` if missing).

- [ ] **Step 2: Run the test to verify it fails**

```bash
cargo test -p buzz-sdk discovery_workspace
```

Expected: FAIL or compile error for the missing match arm.

- [ ] **Step 3: Mark the operation as v2-only**

In `is_v1_request`, after the `UpdateCampaignSources { .. } => false` arm:

```rust
        buzz_core::discovery_workspace::DiscoveryWorkspaceActionPayload::ListLeadCounts => false,
```

- [ ] **Step 4: Handle the new result in v1 receipt conversion**

In `receipt_for_wire_version`, after `DiscoveryWorkspaceResult::Access { .. } => {}`:

```rust
            DiscoveryWorkspaceResult::LeadCounts { .. } => {}
```

- [ ] **Step 5: Pair the operation with its result in receipt validation**

In `validate_receipt`, add a pair after the `ListLeads`/`Leads` pair:

```rust
        ) | (
            DiscoveryWorkspaceOperation::ListLeadCounts,
            DiscoveryWorkspaceResult::LeadCounts { .. }
        )
```

- [ ] **Step 6: Run the SDK tests**

```bash
cargo test -p buzz-sdk discovery_workspace
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/buzz-sdk/src/discovery_workspace.rs
git commit -s -m "feat(sdk): wire list_lead_counts as a v2 workspace operation"
```

---

## Task 4: Database aggregation — `list_lead_counts_tx`

**Files:**
- Modify: `crates/buzz-db/src/discovery_workspace.rs`

- [ ] **Step 1: Add the import**

Add `DiscoveryLeadCountRow, DiscoveryLeadCounts` to the `buzz_core::discovery_workspace` import block at the top of `crates/buzz-db/src/discovery_workspace.rs`.

- [ ] **Step 2: Add the apply arm**

In `apply_discovery_workspace_command_once`, after the `ListLeads` arm:

```rust
        DiscoveryWorkspaceActionPayload::ListLeadCounts => {
            Ok(DiscoveryWorkspaceResult::LeadCounts {
                counts: list_lead_counts_tx(tx, community_id).await?,
            })
        }
```

- [ ] **Step 3: Add the aggregation function**

After `list_leads_tx`:

```rust
async fn list_lead_counts_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
) -> Result<DiscoveryLeadCounts> {
    let total: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM discovery_business_observations \
         WHERE community_id=$1",
    )
    .bind(community_id.as_uuid())
    .fetch_one(&mut **tx)
    .await?;
    let industry_rows = sqlx::query(
        "SELECT c.industry_id, count(*) AS lead_count \
         FROM discovery_business_observations o \
         JOIN discovery_runs r ON r.community_id=o.community_id AND r.id=o.first_run_id \
         JOIN discovery_campaigns c ON c.community_id=r.community_id AND c.id=r.campaign_id \
         WHERE o.community_id=$1 \
         GROUP BY c.industry_id \
         ORDER BY count(*) DESC, c.industry_id ASC",
    )
    .bind(community_id.as_uuid())
    .fetch_all(&mut **tx)
    .await?;
    let industries = industry_rows
        .iter()
        .map(|row| {
            Ok(DiscoveryLeadCountRow {
                industry_id: row.try_get("industry_id")?,
                vertical_id: None,
                count: count_to_u32(
                    row.try_get::<i64, _>("lead_count")?,
                    "Lead count",
                )?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let vertical_rows = sqlx::query(
        "SELECT c.industry_id, c.vertical_id, count(*) AS lead_count \
         FROM discovery_business_observations o \
         JOIN discovery_runs r ON r.community_id=o.community_id AND r.id=o.first_run_id \
         JOIN discovery_campaigns c ON c.community_id=r.community_id AND c.id=r.campaign_id \
         WHERE o.community_id=$1 \
         GROUP BY c.industry_id, c.vertical_id \
         ORDER BY count(*) DESC, c.vertical_id ASC",
    )
    .bind(community_id.as_uuid())
    .fetch_all(&mut **tx)
    .await?;
    let verticals = vertical_rows
        .iter()
        .map(|row| {
            Ok(DiscoveryLeadCountRow {
                industry_id: row.try_get("industry_id")?,
                vertical_id: Some(row.try_get("vertical_id")?),
                count: count_to_u32(
                    row.try_get::<i64, _>("lead_count")?,
                    "Lead count",
                )?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(DiscoveryLeadCounts {
        total: count_to_u32(total, "Lead count")?,
        industries,
        verticals,
    })
}
```

- [ ] **Step 4: Compile the database and relay crates**

```bash
cargo check -p buzz-db -p buzz-relay
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-db/src/discovery_workspace.rs
git commit -s -m "feat(db): aggregate retained Lead counts per taxonomy row"
```

---

## Task 5: CLI — `buzz discovery leads-counts`

**Files:**
- Modify: `crates/buzz-cli/src/lib.rs`
- Modify: `crates/buzz-cli/src/commands/discovery.rs`
- Test: `crates/buzz-cli/src/lib.rs`

- [ ] **Step 1: Write the failing parse test**

Near the existing discovery parse tests in `crates/buzz-cli/src/lib.rs`:

```rust
    assert!(Cli::try_parse_from(["buzz", "discovery", "leads-counts"]).is_ok());
    assert!(Cli::try_parse_from(["buzz", "discovery", "leads-counts", "--idempotency-key", uuid]).is_ok());
```

Reuse the existing `uuid` binding in that test block if present; otherwise create `let uuid = Uuid::new_v4().to_string();` before the asserts.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cargo test -p buzz-cli discovery_command_surface_parses
```

Expected: FAIL with "unexpected argument 'leads-counts'".

- [ ] **Step 3: Add the CLI variant**

In `enum DiscoveryCmd` in `crates/buzz-cli/src/lib.rs`, before `Start`:

```rust
    /// List retained-Lead counts per industry and vertical
    LeadsCounts {
        /// Stable retry key. Reuse it after an uncertain delivery.
        #[arg(long)]
        idempotency_key: Option<Uuid>,
    },
```

- [ ] **Step 4: Add the dispatch arm**

In `dispatch` in `crates/buzz-cli/src/commands/discovery.rs`, after the `LeadsList` arm:

```rust
        DiscoveryCmd::LeadsCounts { idempotency_key } => {
            publish_workspace_payload(
                client,
                DiscoveryWorkspaceActionPayload::ListLeadCounts,
                idempotency_key,
            )
            .await
        }
```

- [ ] **Step 5: Run the CLI tests**

```bash
cargo test -p buzz-cli
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/buzz-cli/src/lib.rs crates/buzz-cli/src/commands/discovery.rs
git commit -s -m "feat(cli): add buzz discovery leads-counts"
```

---

## Task 6: Desktop contract — `LeadCounts` type, interface, fixture

**Files:**
- Modify: `desktop/src/features/discovery/types.ts`
- Modify: `desktop/src/features/discovery/data/DiscoveryDataSource.ts`
- Modify: `desktop/src/features/discovery/data/FixtureDiscoveryDataSource.ts`
- Test: `desktop/src/features/discovery/data/discoveryData.test.mjs`

- [ ] **Step 1: Write the failing fixture test**

Add to `desktop/src/features/discovery/data/discoveryData.test.mjs`:

```js
test("fixture lead counts match the taxonomy cards", async () => {
  const source = createFixtureDiscoveryDataSource();
  const [industries, counts] = await Promise.all([
    source.getIndustries(),
    source.getLeadCounts(),
  ]);
  assert.equal(
    counts.total,
    industries.reduce((sum, item) => sum + item.leadCount, 0),
  );
  for (const industry of industries) {
    const row = counts.industries.find(
      (candidate) => candidate.industryId === industry.id,
    );
    assert.equal(row?.count, industry.leadCount);
  }
  assert.ok(counts.verticals.length > 0);
});
```

Check the file's existing imports and add `createFixtureDiscoveryDataSource` if not already imported.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-leads-crm/desktop
pnpm test -- --test-name-pattern "fixture lead counts"
```

Expected: FAIL with "source.getLeadCounts is not a function".

- [ ] **Step 3: Add the types**

In `desktop/src/features/discovery/types.ts`, after `LeadPage`:

```ts
export type LeadCountRow = {
  industryId: string;
  verticalId?: string;
  count: number;
};

export type LeadCounts = {
  total: number;
  industries: LeadCountRow[];
  verticals: LeadCountRow[];
};
```

- [ ] **Step 4: Add the interface method**

In `desktop/src/features/discovery/data/DiscoveryDataSource.ts`, after `getLeads`:

```ts
  getLeadCounts(): Promise<LeadCounts>;
```

Add `LeadCounts` to the type import from `../types`.

- [ ] **Step 5: Implement the fixture method**

In `FixtureDiscoveryDataSource` (`desktop/src/features/discovery/data/FixtureDiscoveryDataSource.ts`), after `getIndustries`:

```ts
  async getLeadCounts(): Promise<LeadCounts> {
    const industries = FIXTURE_INDUSTRIES.map((industry) => ({
      industryId: industry.id,
      count: industry.leadCount,
    }));
    const verticals = FIXTURE_VERTICAL_DETAILS.map((vertical) => ({
      industryId: vertical.industryId,
      verticalId: vertical.id,
      count: vertical.leadCount,
    }));
    return {
      total: industries.reduce((sum, row) => sum + row.count, 0),
      industries,
      verticals,
    };
  }
```

Add `LeadCounts` to the type import from `../types` in that file.

- [ ] **Step 6: Run the desktop unit tests**

```bash
pnpm test
```

Expected: PASS, including `fixture lead counts match the taxonomy cards`.

- [ ] **Step 7: Commit**

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-leads-crm
git add desktop/src/features/discovery/types.ts \
  desktop/src/features/discovery/data/DiscoveryDataSource.ts \
  desktop/src/features/discovery/data/FixtureDiscoveryDataSource.ts \
  desktop/src/features/discovery/data/discoveryData.test.mjs
git commit -s -m "feat(discovery): add lead-count contract and fixture aggregation"
```

---

## Task 7: Relay adapter — live `getLeadCounts` and count-aware read models

**Files:**
- Modify: `desktop/src/features/discovery/data/RelayDiscoveryDataSource.ts`
- Test: `desktop/src/features/discovery/data/RelayDiscoveryDataSource.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add to `RelayDiscoveryDataSource.test.mjs`:

```js
test("live lead counts come from the workspace operation", async () => {
  const live = harness(true);
  const source = new RelayDiscoveryDataSource(live.dependencies);
  const counts = await source.getLeadCounts();
  assert.equal(counts.total, 1);
  assert.equal(counts.industries[0].industryId, "automotive");
  assert.equal(counts.verticals[0].verticalId, "auto-repair");
  assert.ok(live.operations.includes("list_lead_counts"));
});

test("live industries and verticals carry relay lead counts", async () => {
  const live = harness(true);
  const source = new RelayDiscoveryDataSource(live.dependencies);
  const industries = await source.getIndustries();
  const automotive = industries.find((item) => item.id === "automotive");
  assert.equal(automotive?.leadCount, 1);
  const verticals = await source.getVerticals("automotive");
  const repair = verticals.find((item) => item.id === "auto-repair");
  assert.equal(repair?.leadCount, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-leads-crm/desktop
pnpm test -- --test-name-pattern "live lead counts|live industries"
```

Expected: FAIL (`getLeadCounts` missing; `leadCount` still the fixture value).

- [ ] **Step 3: Teach the test harness the new operation**

In the `fetchFirstEvent` handler of `harness()` in `RelayDiscoveryDataSource.test.mjs`, after the `create_campaign` branch:

```js
        } else if (operation === "list_lead_counts") {
          result = {
            result: "lead_counts",
            counts: {
              total: 1,
              industries: [
                { industryId: "automotive", verticalId: null, count: 1 },
              ],
              verticals: [
                {
                  industryId: "automotive",
                  verticalId: "auto-repair",
                  count: 1,
                },
              ],
            },
          };
        } else if (operation === "list_leads") {
```

If the harness has no `list_leads` branch, add this new branch before the final `else` that throws.

- [ ] **Step 4: Add the result and operation types**

At the top of `RelayDiscoveryDataSource.ts`, add `LeadCounts` to the `../types` import. Extend `WorkspaceResult`:

```ts
  | { result: "lead_counts"; counts: LeadCounts };
```

Extend `WorkspaceOperation`:

```ts
  | "list_lead_counts";
```

- [ ] **Step 5: Add `getLeadCounts` and use it in the read models**

In `RelayDiscoveryDataSource`:

```ts
  async getLeadCounts(): Promise<LeadCounts> {
    if (!(await this.live())) return this.demo.getLeadCounts();
    const result = await this.broker.workspace("list_lead_counts", {
      operation: "list_lead_counts",
    });
    if (result.result !== "lead_counts") {
      throw new Error("The relay returned the wrong lead-count result.");
    }
    return {
      ...result.counts,
      industries: result.counts.industries.map((row) => ({
        ...row,
        verticalId: row.verticalId ?? undefined,
      })),
      verticals: result.counts.verticals.map((row) => ({
        ...row,
        verticalId: row.verticalId ?? undefined,
      })),
    };
  }
```

Replace `getIndustries()`:

```ts
  async getIndustries(): Promise<Industry[]> {
    const base = await this.demo.getIndustries();
    if (!(await this.live())) return base;
    const counts = await this.getLeadCounts();
    const byIndustry = new Map(
      counts.industries.map((row) => [row.industryId, row.count]),
    );
    return base.map((industry) => ({
      ...industry,
      leadCount: byIndustry.get(industry.id) ?? 0,
    }));
  }
```

Replace `getVerticals(industryId)`:

```ts
  async getVerticals(industryId: string): Promise<Vertical[]> {
    const base = await this.demo.getVerticals(industryId);
    if (!(await this.live())) return base;
    const counts = await this.getLeadCounts();
    const byVertical = new Map(
      counts.verticals
        .filter((row) => row.verticalId)
        .map((row) => [`${row.industryId}/${row.verticalId}`, row.count]),
    );
    return base.map((vertical) => ({
      ...vertical,
      leadCount:
        byVertical.get(`${vertical.industryId}/${vertical.id}`) ?? 0,
    }));
  }
```

- [ ] **Step 6: Run the tests**

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-leads-crm
git add desktop/src/features/discovery/data/RelayDiscoveryDataSource.ts \
  desktop/src/features/discovery/data/RelayDiscoveryDataSource.test.mjs
git commit -s -m "feat(discovery): serve live lead counts through the relay adapter"
```

---

## Task 8: Route default — bare Discovery opens the Leads surface

**Files:**
- Create: `desktop/src/app/routes/discoverySearch.ts`
- Modify: `desktop/src/app/routes/discovery.tsx`
- Modify: `desktop/src/app/AppShell.tsx`
- Test: `desktop/src/app/routes/discoverySearch.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `desktop/src/app/routes/discoverySearch.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import { validateDiscoverySearch } from "./discoverySearch.ts";

test("a bare discovery route defaults to the Leads surface", () => {
  assert.equal(validateDiscoverySearch({}).surface, "leads");
});

test("an industry deep link keeps an inferred surface", () => {
  const search = validateDiscoverySearch({ industryId: "healthcare" });
  assert.equal(search.surface, undefined);
  assert.equal(search.industryId, "healthcare");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-leads-crm/desktop
pnpm test -- --test-name-pattern "bare discovery route"
```

Expected: module-not-found error for `./discoverySearch.ts`.

- [ ] **Step 3: Extract the pure search module**

Create `desktop/src/app/routes/discoverySearch.ts` by moving the type declarations, constants, and `validateDiscoverySearch` from `discovery.tsx`, with one change: the returned `surface` defaults to `"leads"` when no contextual id is present:

```ts
export type DiscoverySurface =
  | "industries"
  | "verticals"
  | "campaigns"
  | "campaign"
  | "leads";

export type DiscoveryTab =
  | "overview"
  | "discovery"
  | "leads"
  | "outreach"
  | "conversations"
  | "settings";

export type DiscoveryEntity = "businesses" | "people";

export type DiscoverySearch = {
  entity?: DiscoveryEntity;
  surface?: DiscoverySurface;
  industryId?: string;
  verticalId?: string;
  fieldId?: string;
  roleId?: string;
  campaignId?: string;
  tab?: DiscoveryTab;
};

const DISCOVERY_SURFACES: readonly DiscoverySurface[] = [
  "industries",
  "verticals",
  "campaigns",
  "campaign",
  "leads",
];

const DISCOVERY_TABS: readonly DiscoveryTab[] = [
  "overview",
  "discovery",
  "leads",
  "outreach",
  "conversations",
  "settings",
];

const DISCOVERY_ENTITIES: readonly DiscoveryEntity[] = ["businesses", "people"];

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
): T | undefined {
  return typeof value === "string" && values.includes(value as T)
    ? (value as T)
    : undefined;
}

/** Validate and narrow untrusted URL search state at the router boundary. */
export function validateDiscoverySearch(
  search: Record<string, unknown>,
): DiscoverySearch {
  const hasContext = Boolean(
    search.industryId ||
      search.verticalId ||
      search.fieldId ||
      search.roleId ||
      search.campaignId,
  );
  return {
    entity: enumValue(search.entity, DISCOVERY_ENTITIES),
    surface:
      enumValue(search.surface, DISCOVERY_SURFACES) ??
      (hasContext ? undefined : "leads"),
    industryId: nonEmptyString(search.industryId),
    verticalId: nonEmptyString(search.verticalId),
    fieldId: nonEmptyString(search.fieldId),
    roleId: nonEmptyString(search.roleId),
    campaignId: nonEmptyString(search.campaignId),
    tab: enumValue(search.tab, DISCOVERY_TABS),
  };
}
```

- [ ] **Step 4: Slim the route file**

Replace the contents of `desktop/src/app/routes/discovery.tsx`:

```tsx
import { createFileRoute } from "@tanstack/react-router";

import { DiscoveryRouteScreen } from "@/features/discovery/ui/DiscoveryRouteScreen";
import { validateDiscoverySearch } from "./discoverySearch";

export type {
  DiscoveryEntity,
  DiscoverySearch,
  DiscoverySurface,
  DiscoveryTab,
} from "./discoverySearch";

export const Route = createFileRoute("/discovery")({
  validateSearch: validateDiscoverySearch,
  component: DiscoveryRouteComponent,
});

function DiscoveryRouteComponent() {
  return <DiscoveryRouteScreen search={Route.useSearch()} />;
}
```

- [ ] **Step 5: Make the sidebar explicit**

In `desktop/src/app/AppShell.tsx`, change:

```tsx
onSelectDiscovery={() => void goDiscovery()}
```

to:

```tsx
onSelectDiscovery={() => void goDiscovery({ surface: "leads" })}
```

- [ ] **Step 6: Run the tests and typecheck**

```bash
pnpm test
pnpm typecheck
```

Expected: PASS (the new route search tests included).

- [ ] **Step 7: Commit**

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-leads-crm
git add desktop/src/app/routes/discoverySearch.ts \
  desktop/src/app/routes/discoverySearch.test.mjs \
  desktop/src/app/routes/discovery.tsx \
  desktop/src/app/AppShell.tsx
git commit -s -m "feat(discovery): open the Leads surface by default"
```

---

## Task 9: Top-level Leads/Discover tabs and empty state

**Files:**
- Modify: `desktop/src/features/discovery/ui/discoveryLayout.ts`
- Modify: `desktop/src/features/discovery/ui/discoveryLayout.test.mjs`
- Create: `desktop/src/features/discovery/ui/DiscoveryTopTabs.tsx`
- Modify: `desktop/src/features/discovery/ui/DiscoveryRouteScreen.tsx`
- Modify: `desktop/src/features/discovery/ui/LeadsWorkspace.tsx`

- [ ] **Step 1: Write the failing layout test**

Add to `desktop/src/features/discovery/ui/discoveryLayout.test.mjs`:

```js
test("leads surface maps to the Leads top tab and everything else to Discover", () => {
  assert.equal(discoveryTopTab("leads"), "leads");
  assert.equal(discoveryTopTab("industries"), "discover");
  assert.equal(discoveryTopTab("campaign"), "discover");
  assert.equal(discoveryTopTab("verticals"), "discover");
});
```

Add `discoveryTopTab` to the import from `./discoveryLayout.ts`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-leads-crm/desktop
pnpm test -- --test-name-pattern "Leads top tab"
```

Expected: FAIL (function not exported).

- [ ] **Step 3: Add the helper**

In `desktop/src/features/discovery/ui/discoveryLayout.ts`, after `discoverySurface`:

```ts
/** The two top-level Discovery tabs: Leads (default) and Discover. */
export type DiscoveryTopTab = "leads" | "discover";

export function discoveryTopTab(
  surface: NonNullable<DiscoverySearch["surface"]>,
): DiscoveryTopTab {
  return surface === "leads" ? "leads" : "discover";
}
```

- [ ] **Step 4: Create the tabs component**

Create `desktop/src/features/discovery/ui/DiscoveryTopTabs.tsx`:

```tsx
import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import type { DiscoverySearch } from "@/app/routes/discovery";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { discoveryTopTab } from "./discoveryLayout";

export function DiscoveryTopTabs({
  surface,
}: {
  surface: NonNullable<DiscoverySearch["surface"]>;
}) {
  const { goDiscovery } = useAppNavigation();
  return (
    <div className="border-b border-border/50 px-9 pt-6">
      <Tabs
        className="w-full"
        data-testid="discovery-top-tabs"
        onValueChange={(next) => {
          if (next === "leads") {
            void goDiscovery({ surface: "leads" });
          } else {
            void goDiscovery({ surface: "industries" });
          }
        }}
        value={discoveryTopTab(surface)}
      >
        <TabsList>
          <TabsTrigger data-testid="discovery-top-tab-leads" value="leads">
            Leads
          </TabsTrigger>
          <TabsTrigger data-testid="discovery-top-tab-discover" value="discover">
            Discover
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}
```

- [ ] **Step 5: Render the tabs above the workspace**

In `desktop/src/features/discovery/ui/DiscoveryRouteScreen.tsx`:

- import `DiscoveryTopTabs` and `discoverySurface` from `./ui/discoveryLayout`;
- inside the returned wrapper `<div>`, before `<DiscoveryWorkspace ... />`:

```tsx
      <DiscoveryTopTabs surface={discoverySurface(search)} />
```

- [ ] **Step 6: Add the empty state to the global leads workspace**

In `desktop/src/features/discovery/ui/LeadsWorkspace.tsx`:

- add `import { useAppNavigation } from "@/app/navigation/useAppNavigation";`;
- in `GlobalLeads`, add the hook call at the very top of the component,
  before the `isLoading` early return (hooks must not follow a conditional
  return):

```tsx
  const { goDiscovery } = useAppNavigation();
```

- after the `isLoading` early return and before the stats row, add:

```tsx
  if (leads.length === 0) {
    return (
      <div className="space-y-5">
        <GlobalLeadsHeader
          mode={mode}
          onModeChange={setMode}
          onAction={setMessage}
          onExport={() => undefined}
        />
        <Card
          className="border-dashed border-border/70 bg-background/30 p-10 text-center shadow-none"
          data-testid="leads-empty-state"
        >
          <UsersRound aria-hidden="true" className="mx-auto h-8 w-8 text-muted-foreground" />
          <h2 className="mt-3 text-lg font-semibold text-foreground">
            No leads yet
          </h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Run a Discovery campaign and every retained business appears here
            automatically.
          </p>
          <Button
            className="mt-5"
            data-testid="discover-more-button"
            onClick={() => void goDiscovery({ surface: "industries" })}
            type="button"
          >
            <Plus aria-hidden="true" />
            Discover more
          </Button>
        </Card>
      </div>
    );
  }
```

`UsersRound`, `Card`, and `Button` are already imported in the file; `Plus` is imported.

- [ ] **Step 7: Run the unit tests and typecheck**

```bash
pnpm test
pnpm typecheck
pnpm check:px-text
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-leads-crm
git add desktop/src/features/discovery/ui/discoveryLayout.ts \
  desktop/src/features/discovery/ui/discoveryLayout.test.mjs \
  desktop/src/features/discovery/ui/DiscoveryTopTabs.tsx \
  desktop/src/features/discovery/ui/DiscoveryRouteScreen.tsx \
  desktop/src/features/discovery/ui/LeadsWorkspace.tsx
git commit -s -m "feat(discovery): add Leads/Discover tabs and leads empty state"
```

---

## Task 10: Sort taxonomy grids by real lead count

**Files:**
- Modify: `desktop/src/features/discovery/ui/discoveryLayout.ts`
- Modify: `desktop/src/features/discovery/ui/discoveryLayout.test.mjs`
- Modify: `desktop/src/features/discovery/ui/DiscoveryWorkspace.tsx`

- [ ] **Step 1: Write the failing test**

Add to `discoveryLayout.test.mjs`:

```js
test("taxonomy grids sort by lead count descending, then name", () => {
  const sorted = sortByLeadCountDesc([
    { leadCount: 2, name: "Zeta" },
    { leadCount: 9, name: "Alpha" },
    { leadCount: 9, name: "Beta" },
  ]);
  assert.deepEqual(
    sorted.map((item) => item.name),
    ["Alpha", "Beta", "Zeta"],
  );
});
```

Add `sortByLeadCountDesc` to the imports.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test -- --test-name-pattern "taxonomy grids sort"
```

Expected: FAIL (function not exported).

- [ ] **Step 3: Add the sort helper**

In `discoveryLayout.ts`:

```ts
/** Stable descending sort by lead count, then name, for taxonomy grids. */
export function sortByLeadCountDesc<
  T extends { leadCount: number; name: string },
>(items: readonly T[]): T[] {
  return [...items].sort(
    (left, right) =>
      right.leadCount - left.leadCount ||
      left.name.localeCompare(right.name),
  );
}
```

- [ ] **Step 4: Apply the sort in the workspace**

In `DiscoveryWorkspace.tsx`, wrap every grid's visible list with `sortByLeadCountDesc`:

- `visibleIndustries` (businesses industries): `return sortByLeadCountDesc(visibleIndustries);` is not valid before render, so change the final render to use `sortByLeadCountDesc(visibleIndustries)` inside `IndustryGrid industries={...}`.
- `visibleVerticals` (both `surface === "campaigns"` and `surface === "verticals"`): pass `verticals={sortByLeadCountDesc(visibleVerticals)}` to `VerticalGrid`.
- `visibleFields` (people fields): pass `fields={sortByLeadCountDesc(visibleFields)}` to `FieldGrid`.
- `visibleRoles` (both people surfaces): pass `roles={sortByLeadCountDesc(visibleRoles)}` to `RoleGrid`.

Add `sortByLeadCountDesc` to the imports from `./discoveryLayout`.

- [ ] **Step 5: Run the unit tests and typecheck**

```bash
pnpm test
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-leads-crm
git add desktop/src/features/discovery/ui/discoveryLayout.ts \
  desktop/src/features/discovery/ui/discoveryLayout.test.mjs \
  desktop/src/features/discovery/ui/DiscoveryWorkspace.tsx
git commit -s -m "feat(discovery): sort taxonomy grids by real lead count"
```

---

## Task 11: Fixture empty-leads scenario for browser proof

**Files:**
- Modify: `desktop/src/features/discovery/data/FixtureDiscoveryDataSource.ts`
- Modify: `desktop/src/features/discovery/ui/DiscoveryRouteScreen.tsx`
- Modify: `desktop/tests/e2e/discovery.spec.ts`

- [ ] **Step 1: Add the fixture option**

In `FixtureDiscoveryDataSourceOptions`, add:

```ts
  /** Return an empty global Leads page so the empty state is browser-testable. */
  emptyLeads?: boolean;
```

Store it in the class (`private readonly emptyLeads: boolean;` set in the constructor from `options.emptyLeads ?? false`). At the top of `getLeads`:

```ts
    if (this.emptyLeads && scope.scope !== "campaign") {
      return {
        leads: [],
        total: 0,
        page: 1,
        pageSize: scope.pageSize ?? 25,
        hasNextPage: false,
      };
    }
```

- [ ] **Step 2: Read the e2e override in the route**

In `DiscoveryRouteScreen.tsx`, extend `DiscoveryE2eWindow`:

```ts
type DiscoveryE2eWindow = Window & {
  __BUZZ_E2E_DISCOVERY_ENTITLEMENT__?: DiscoveryEntitlementState;
  __BUZZ_E2E_DISCOVERY_EMPTY_LEADS__?: boolean;
};
```

Add a reader next to `fixtureEntitlementOverride`:

```ts
function fixtureEmptyLeadsOverride(): boolean | undefined {
  if (import.meta.env.MODE !== "e2e" || typeof window === "undefined") {
    return undefined;
  }
  return (window as DiscoveryE2eWindow).__BUZZ_E2E_DISCOVERY_EMPTY_LEADS__;
}
```

Pass it to the fixture factory:

```ts
        ? createFixtureDiscoveryDataSource({
            entitlement: fixtureEntitlementOverride(),
            emptyLeads: fixtureEmptyLeadsOverride(),
          })
```

- [ ] **Step 3: Add the browser spec**

Add a test to `desktop/tests/e2e/discovery.spec.ts` (before `test.afterAll`):

```ts
test("Discovery defaults to the Leads tab with an empty state and Discover more", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.addInitScript(() => {
    window.__BUZZ_E2E_DISCOVERY_EMPTY_LEADS__ = true;
  });
  await installMockBridge(page);
  await seedActiveIdentity(page);
  await page.goto("/discovery");
  await expect(page.getByTestId("discovery-top-tabs")).toBeVisible();
  await expect(page.getByTestId("discovery-top-tab-leads")).toHaveAttribute(
    "data-state",
    "active",
  );
  await expect(page.getByTestId("leads-empty-state")).toBeVisible();
  await page.getByTestId("discover-more-button").click();
  await expect(page.getByTestId("discovery-top-tab-discover")).toHaveAttribute(
    "data-state",
    "active",
  );
  expect(errors).toEqual([]);
});
```

Add `window.__BUZZ_E2E_DISCOVERY_EMPTY_LEADS__` to the e2e window type used by the spec (or declare it as `declare global { interface Window { __BUZZ_E2E_DISCOVERY_EMPTY_LEADS__?: boolean } }` at the top of the spec if no shared type exists).

- [ ] **Step 4: Run the browser proof**

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-leads-crm/desktop
pnpm build:e2e
pnpm exec playwright test tests/e2e/discovery.spec.ts --project=integration --grep "Leads tab"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-leads-crm
git add desktop/src/features/discovery/data/FixtureDiscoveryDataSource.ts \
  desktop/src/features/discovery/ui/DiscoveryRouteScreen.tsx \
  desktop/tests/e2e/discovery.spec.ts
git commit -s -m "test(discovery): prove the leads empty state and Discover more journey"
```

---

## Task 12: Relay e2e proof for `list_lead_counts`

**Files:**
- Modify: `crates/buzz-test-client/tests/e2e_discovery.rs`

- [ ] **Step 1: Write the failing e2e test**

Add a new ignored test after `entitled_human_gets_private_relay_signed_receipt`:

```rust
#[tokio::test]
#[ignore = "requires the isolated Postgres, Redis, and relay harness with fake Discovery enabled"]
async fn lead_counts_aggregate_retained_businesses() {
    let _test_guard = DISCOVERY_E2E_LOCK.lock().await;
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://buzz:buzz_dev@localhost:5471/buzz".to_owned());
    let pool = sqlx::PgPool::connect(&database_url)
        .await
        .expect("connect isolated Postgres");
    let host = buzz_core::tenant::relay_url_authority(&relay_url());
    let community_id: Uuid = sqlx::query("SELECT id FROM communities WHERE lower(host)=lower($1)")
        .bind(&host)
        .fetch_one(&pool)
        .await
        .expect("isolated community exists")
        .try_get("id")
        .expect("community UUID");
    let actor = Keys::generate();
    provision_member(&pool, community_id, &actor).await;
    sqlx::query(
        "INSERT INTO discovery_entitlements (community_id,active,updated_at) \
         VALUES ($1,TRUE,now()) ON CONFLICT (community_id) \
         DO UPDATE SET active=TRUE,updated_at=now()",
    )
    .bind(community_id)
    .execute(&pool)
    .await
    .expect("enable entitlement");
    let relay = relay_pubkey().await;
    let mut client = BuzzTestClient::connect(&relay_url(), &actor)
        .await
        .expect("authenticate actor");
    let campaign_id = create_campaign(&mut client, &actor, relay).await;
    let run_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO discovery_runs \
         (community_id,id,campaign_id,requested_by,start_idempotency_key,state,total_steps) \
         VALUES ($1,$2,$3,$4,$5,'succeeded',4)",
    )
    .bind(community_id)
    .bind(run_id)
    .bind(campaign_id)
    .bind(actor.public_key().to_bytes().as_slice())
    .bind(Uuid::new_v4())
    .execute(&pool)
    .await
    .expect("insert succeeded run");
    for (name, provider_record_id) in [
        ("Sandton Dental One", "maps:dentist-1"),
        ("Sandton Dental Two", "maps:dentist-2"),
    ] {
        sqlx::query(
            "INSERT INTO discovery_business_observations \
             (community_id,id,first_run_id,provider,provider_record_id,name,observation_fingerprint) \
             VALUES ($1,$2,$3,'outscraper',$4,$5,decode(repeat('ab',32),'hex'))",
        )
        .bind(community_id)
        .bind(Uuid::new_v4())
        .bind(run_id)
        .bind(provider_record_id)
        .bind(name)
        .execute(&pool)
        .await
        .expect("insert retained observation");
    }
    let result = submit_workspace_action(
        &mut client,
        &actor,
        relay,
        DiscoveryWorkspaceActionPayload::ListLeadCounts,
    )
    .await;
    let DiscoveryWorkspaceResult::LeadCounts { counts } = result else {
        panic!("lead counts must return the counts projection");
    };
    assert_eq!(counts.total, 2);
    let healthcare = counts
        .industries
        .iter()
        .find(|row| row.industry_id == "healthcare")
        .expect("healthcare industry count");
    assert_eq!(healthcare.count, 2);
    let dentists = counts
        .verticals
        .iter()
        .find(|row| row.vertical_id.as_deref() == Some("dentists"))
        .expect("dentists vertical count");
    assert_eq!(dentists.count, 2);
}
```

- [ ] **Step 2: Run the e2e proof**

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-leads-crm
RELAY_URL=ws://localhost:3030 \
DATABASE_URL=postgres://buzz:buzz_dev@localhost:5471/buzz \
cargo test -p buzz-test-client --test e2e_discovery lead_counts_aggregate -- --ignored --nocapture
```

Expected: PASS (requires the isolated harness from `crates/buzz-test-client/TESTING.md`).

- [ ] **Step 3: Commit**

```bash
git add crates/buzz-test-client/tests/e2e_discovery.rs
git commit -s -m "test(discovery): prove relay lead-count aggregation"
```

---

## Task 13: Full gate and screenshots

**Files:** none (verification only; fix any failure found)

- [ ] **Step 1: Run the complete desktop gate**

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-leads-crm/desktop
pnpm test
pnpm typecheck
pnpm check:px-text
pnpm build:e2e
pnpm exec playwright test tests/e2e/discovery.spec.ts --project=integration
```

Expected: all PASS. Fix any regression inline and commit with `-s` before proceeding.

- [ ] **Step 2: Run the Rust gate**

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-leads-crm
cargo test -p buzz-core -p buzz-sdk -p buzz-cli
```

Expected: PASS.

- [ ] **Step 3: Run the repo-wide gate**

```bash
. ./bin/activate-hermit
just ci
```

Expected: PASS. If Tauri fmt fails in the worktree, run `just desktop-tauri-fmt` from the main checkout per the repo's worktree gotcha, re-stage, and commit.

- [ ] **Step 4: Confirm the acceptance gate from the spec**

Verify with the commands above that:

- bare `/discovery` opens the Leads tab (browser spec);
- empty workspace shows the empty state and Discover more routes to Discover;
- live `getIndustries`/`getVerticals` use `list_lead_counts` (desktop unit tests);
- grids sort by count descending (unit tests);
- relay returns per-industry/per-vertical counts and totals (e2e proof);
- fixture demo still returns its existing counts when not entitled.

- [ ] **Step 5: Commit any remaining fixes**

```bash
git add -A
git commit -s -m "chore(discovery): phase A gate fixes"
```

Only run this step if Step 1, 2, or 3 produced fixes.

---

## Phase B and C

`get_lead`, `update_lead` (Party-relationship-backed), the lead detail/edit UI, the Pipeline tab, and lead-card Block mentions are specified in
`docs/superpowers/specs/2026-08-06-colony-discovery-leads-crm-design.md` but intentionally have their own implementation plans after Phase A lands. The Phase A contract (`list_lead_counts`) already exercises the same extension pattern those phases will reuse for `get_lead`/`update_lead`.
