# Colony Discovery Leads + CRM — Phase B Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `get_lead` and `update_lead` to the Discovery workspace contract so a lead can be opened and edited (contact data, score, notes, owner, funnel status), with status changes validated by the existing Party relationship transition rules, plus a status filter on lead lists for the future Pipeline UI.

**Architecture:** Extend the existing 40021/40022 workspace contract with two operations, exactly like Phase A's `list_lead_counts`. Editable lead state lives in a new `discovery_lead_profiles` table; status strings and transition rules are reused from `buzz_core::party` (`RelationshipStatus` + `is_relationship_transition_allowed`) rather than inventing a new vocabulary. Desktop and CLI go through the same signed ops.

**Tech Stack:** Rust (buzz-core, buzz-sdk, buzz-db, buzz-relay, buzz-cli), Postgres, React/TS desktop adapter, node:test, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-06-colony-discovery-leads-crm-design.md`

---

## Task 1: Migration — lead profiles and new workspace operations

**Files:**
- Create: `migrations/0046_discovery_lead_profiles.sql`

- [ ] **Step 1: Write the migration**

Create `migrations/0046_discovery_lead_profiles.sql`:

```sql
-- Phase B: mutable lead state for the Discovery CRM surface. The observation
-- row stays immutable; this profile carries human/agent edits and the funnel
-- status, whose vocabulary and transitions come from the Party contract.
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
            'list_lead_counts',
            'get_lead',
            'update_lead'
        ));

CREATE TABLE discovery_lead_profiles (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    lead_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'candidate'
        CHECK (status IN (
            'candidate', 'accepted', 'qualified', 'dormant', 'disqualified',
            'client_active'
        )),
    owner_persona_id TEXT,
    website TEXT,
    email TEXT,
    phone TEXT,
    linkedin_url TEXT,
    contact_name TEXT,
    contact_title TEXT,
    notes TEXT CHECK (notes IS NULL OR octet_length(notes) <= 8000),
    score SMALLINT CHECK (score IS NULL OR score BETWEEN 0 AND 100),
    updated_by BYTEA NOT NULL CHECK (octet_length(updated_by) = 32),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, lead_id),
    FOREIGN KEY (community_id, lead_id)
        REFERENCES discovery_business_observations(community_id, id)
        ON DELETE CASCADE
);

CREATE INDEX discovery_lead_profiles_status_idx
    ON discovery_lead_profiles (community_id, status);
```

- [ ] **Step 2: Verify the migration against the embedded migrator test**

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-leads-crm-phase-b
. ./bin/activate-hermit
cargo test -p buzz-db migration::tests::embedded_migrator_contains_consolidated_initial_schema
```

Expected: FAIL on the migration-count assertion (44 -> 45). Fix in Task 2's companion step or adjust the assertions now:

- `assert_eq!(migrations.len(), 46);`
- after the `migrations[44]` block, add:

```rust
        assert_eq!(migrations[45].version, 46);
        assert!(migrations[45]
            .sql
            .as_str()
            .contains("CREATE TABLE discovery_lead_profiles"));
```

- [ ] **Step 3: Commit**

```bash
git add migrations/0046_discovery_lead_profiles.sql crates/buzz-db/src/migration.rs
git commit -s -m "migrate(discovery): add lead profiles and get/update_lead operations"
```

---

## Task 2: Core contract — `GetLead`, `UpdateLead`, and the profile projection

**Files:**
- Modify: `crates/buzz-core/src/discovery_workspace.rs`
- Test: same file, `#[cfg(test)] mod tests`

- [ ] **Step 1: Write the failing tests**

Add to the tests module:

```rust
#[test]
fn lead_update_input_round_trips_and_uses_party_status_vocabulary() {
    let input = DiscoveryLeadUpdateInput {
        website: Some("https://acme.example".into()),
        email: Some("hello@acme.example".into()),
        phone: None,
        linkedin_url: None,
        contact_name: None,
        contact_title: None,
        notes: Some("Warm intro from Sipho".into()),
        score: Some(82),
        owner_persona_id: Some("chief-of-staff".into()),
        status: Some(DiscoveryLeadStatus::Qualified),
    };
    assert_eq!(input.validate(), Ok(()));

    let payload = DiscoveryWorkspaceActionPayload::UpdateLead {
        lead_id: Uuid::new_v4(),
        input,
    };
    assert_eq!(
        payload.operation(),
        DiscoveryWorkspaceOperation::UpdateLead
    );
    assert_eq!(payload.validate(), Ok(()));

    let get = DiscoveryWorkspaceActionPayload::GetLead {
        lead_id: Uuid::new_v4(),
    };
    assert_eq!(get.operation(), DiscoveryWorkspaceOperation::GetLead);
    assert_eq!(get.validate(), Ok(()));
}

#[test]
fn lead_status_uses_the_party_lifecycle_and_rejects_client_only_states() {
    assert_eq!(DiscoveryLeadStatus::Candidate.to_relationship_status(), RelationshipStatus::Candidate);
    assert!(is_relationship_transition_allowed(
        RelationshipKind::Lead,
        RelationshipStatus::Candidate,
        RelationshipStatus::Accepted,
    ));
    assert!(!is_relationship_transition_allowed(
        RelationshipKind::Lead,
        RelationshipStatus::Disqualified,
        RelationshipStatus::Accepted,
    ));
}
```

Import `buzz_core::party::{is_relationship_transition_allowed, RelationshipKind, RelationshipStatus}` at the top of the tests module.

- [ ] **Step 2: Run the tests to verify they fail to compile**

```bash
cargo test -p buzz-core discovery_workspace
```

- [ ] **Step 3: Add the status enum and update input**

Add to `crates/buzz-core/src/discovery_workspace.rs`, before `DiscoveryWorkspaceResult`:

```rust
/// Funnel status vocabulary for a retained Lead, mirroring the Party
/// relationship lifecycle (`client_active` displays as Converted).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryLeadStatus {
    Candidate,
    Accepted,
    Qualified,
    Dormant,
    Disqualified,
    ClientActive,
}

impl DiscoveryLeadStatus {
    pub const fn to_relationship_status(self) -> RelationshipStatus {
        match self {
            Self::Candidate => RelationshipStatus::Candidate,
            Self::Accepted => RelationshipStatus::Accepted,
            Self::Qualified => RelationshipStatus::Qualified,
            Self::Dormant => RelationshipStatus::Dormant,
            Self::Disqualified => RelationshipStatus::Disqualified,
            Self::ClientActive => RelationshipStatus::Active,
        }
    }

    pub const fn from_relationship_status(status: RelationshipStatus) -> Self {
        match status {
            RelationshipStatus::Candidate => Self::Candidate,
            RelationshipStatus::Accepted => Self::Accepted,
            RelationshipStatus::Qualified => Self::Qualified,
            RelationshipStatus::Dormant => Self::Dormant,
            RelationshipStatus::Disqualified => Self::Disqualified,
            RelationshipStatus::Active => Self::ClientActive,
            RelationshipStatus::Paused | RelationshipStatus::Former => Self::ClientActive,
        }
    }
}

/// Editable lead fields carried by an `update_lead` workspace action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryLeadUpdateInput {
    pub website: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub linkedin_url: Option<String>,
    pub contact_name: Option<String>,
    pub contact_title: Option<String>,
    pub notes: Option<String>,
    pub score: Option<u16>,
    pub owner_persona_id: Option<String>,
    pub status: Option<DiscoveryLeadStatus>,
}

impl DiscoveryLeadUpdateInput {
    pub fn validate(&self) -> Result<(), DiscoveryWorkspaceValidationError> {
        for (value, field) in [
            (&self.website, "website"),
            (&self.email, "email"),
            (&self.phone, "phone"),
            (&self.linkedin_url, "linkedin_url"),
            (&self.contact_name, "contact_name"),
            (&self.contact_title, "contact_title"),
        ] {
            if let Some(value) = value {
                validate_text(value, 2048, field)?;
            }
        }
        if let Some(notes) = &self.notes {
            validate_text(notes, 8000, "notes")?;
        }
        if let Some(score) = self.score {
            if score > 100 {
                return Err(DiscoveryWorkspaceValidationError::InvalidField("score"));
            }
        }
        if let Some(owner) = &self.owner_persona_id {
            validate_text(owner, 256, "owner_persona_id")?;
        }
        Ok(())
    }
}
```

Add the `use crate::party::{is_relationship_transition_allowed, RelationshipKind, RelationshipStatus};` import to `crates/buzz-core/src/discovery_workspace.rs`.

- [ ] **Step 4: Add the operations and payloads**

In `DiscoveryWorkspaceOperation`:

```rust
    /// Read one retained Lead with its editable profile.
    GetLead,
    /// Update one retained Lead's editable profile and funnel status.
    UpdateLead,
```

In `DiscoveryWorkspaceActionPayload`:

```rust
    /// Read one retained Lead with its editable profile.
    GetLead {
        /// Stable observation identifier.
        lead_id: Uuid,
    },
    /// Update one retained Lead's editable profile and funnel status.
    UpdateLead {
        /// Stable observation identifier.
        lead_id: Uuid,
        /// Complete replacement profile fields.
        input: DiscoveryLeadUpdateInput,
    },
```

Add `operation()` arms:

```rust
            Self::GetLead { .. } => DiscoveryWorkspaceOperation::GetLead,
            Self::UpdateLead { .. } => DiscoveryWorkspaceOperation::UpdateLead,
```

Add `validate()` arms:

```rust
            Self::GetLead { lead_id } => validate_uuid(*lead_id, "lead_id"),
            Self::UpdateLead { lead_id, input } => {
                validate_uuid(*lead_id, "lead_id")?;
                input.validate()
            }
```

- [ ] **Step 5: Add the detail projection and result variant**

After `DiscoveryBusinessLeadProjection`:

```rust
/// One retained Lead plus its editable profile fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryLeadDetail {
    #[serde(flatten)]
    pub lead: DiscoveryBusinessLeadProjection,
    pub status: DiscoveryLeadStatus,
    pub owner_persona_id: Option<String>,
    pub website_override: Option<String>,
    pub email: Option<String>,
    pub phone_override: Option<String>,
    pub linkedin_url: Option<String>,
    pub contact_name: Option<String>,
    pub contact_title: Option<String>,
    pub notes: Option<String>,
    pub score: Option<u16>,
    pub updated_by: String,
    pub updated_at: DateTime<Utc>,
}
```

In `DiscoveryWorkspaceResult`:

```rust
    /// One retained Lead with its editable profile.
    Lead {
        /// Complete entitled lead detail.
        lead: Box<DiscoveryLeadDetail>,
    },
```

- [ ] **Step 6: Run the tests**

```bash
cargo test -p buzz-core discovery_workspace
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/buzz-core/src/discovery_workspace.rs
git commit -s -m "feat(core): add get_lead and update_lead workspace operations"
```

---

## Task 3: SDK wire compatibility

**Files:**
- Modify: `crates/buzz-sdk/src/discovery_workspace.rs`

- [ ] **Step 1: Add the v2-only arms and receipt pairs**

- `is_v1_request`: add

```rust
        buzz_core::discovery_workspace::DiscoveryWorkspaceActionPayload::GetLead { .. }
        | buzz_core::discovery_workspace::DiscoveryWorkspaceActionPayload::UpdateLead { .. } => false,
```

- `receipt_for_wire_version`: add

```rust
            DiscoveryWorkspaceResult::Lead { .. } => {}
```

- `validate_receipt`: add the pair before the closing `)`

```rust
        ) | (
            DiscoveryWorkspaceOperation::GetLead | DiscoveryWorkspaceOperation::UpdateLead,
            DiscoveryWorkspaceResult::Lead { .. }
        )
```

- `operation_tag`: add

```rust
        DiscoveryWorkspaceOperation::GetLead => "get_lead",
        DiscoveryWorkspaceOperation::UpdateLead => "update_lead",
```

- `parse_operation`: add

```rust
        "get_lead" => Ok(DiscoveryWorkspaceOperation::GetLead),
        "update_lead" => Ok(DiscoveryWorkspaceOperation::UpdateLead),
```

- [ ] **Step 2: Add a round-trip test**

Add to the SDK tests module:

```rust
#[test]
fn lead_update_round_trips_as_a_private_canonical_action() {
    let relay = Keys::generate();
    let actor = Keys::generate();
    let request = DiscoveryWorkspaceRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        payload: DiscoveryWorkspaceActionPayload::UpdateLead {
            lead_id: Uuid::new_v4(),
            input: buzz_core::discovery_workspace::DiscoveryLeadUpdateInput {
                website: Some("https://acme.example".into()),
                email: None,
                phone: None,
                linkedin_url: None,
                contact_name: None,
                contact_title: None,
                notes: None,
                score: None,
                owner_persona_id: None,
                status: Some(buzz_core::discovery_workspace::DiscoveryLeadStatus::Accepted),
            },
        },
    };
    let event = build_discovery_workspace_action(relay.public_key(), &request)
        .expect("build update lead")
        .sign_with_keys(&actor)
        .expect("sign update lead");
    let parsed = parse_discovery_workspace_action(&event).expect("parse update lead");
    assert_eq!(parsed.request, request);
}
```

- [ ] **Step 3: Run and commit**

```bash
cargo test -p buzz-sdk discovery_workspace
git add crates/buzz-sdk/src/discovery_workspace.rs
git commit -s -m "feat(sdk): wire get_lead and update_lead workspace operations"
```

---

## Task 4: Database — profile upsert, lead detail, and status filter

**Files:**
- Modify: `crates/buzz-db/src/discovery_workspace.rs`

- [ ] **Step 1: Extend the lead list request with a status filter**

In `crates/buzz-core/src/discovery_workspace.rs`, add to `DiscoveryLeadListRequest`:

```rust
    /// Optional funnel status filter.
    pub status: Option<DiscoveryLeadStatus>,
```

and validate it (no extra check needed beyond the enum). In the SDK's
`DiscoveryCampaignListRequest`-style unit tests, update constructions of
`DiscoveryLeadListRequest` with `status: None`.

- [ ] **Step 2: Add imports and apply arms**

Import `DiscoveryLeadDetail, DiscoveryLeadUpdateInput, DiscoveryLeadStatus` into
`crates/buzz-db/src/discovery_workspace.rs`. Add apply arms:

```rust
        DiscoveryWorkspaceActionPayload::GetLead { lead_id } => {
            Ok(DiscoveryWorkspaceResult::Lead {
                lead: Box::new(get_lead_tx(tx, community_id, *lead_id).await?),
            })
        }
        DiscoveryWorkspaceActionPayload::UpdateLead { lead_id, input } => {
            let lead = update_lead_tx(tx, community_id, actor_pubkey, *lead_id, input).await?;
            Ok(DiscoveryWorkspaceResult::Lead {
                lead: Box::new(lead),
            })
        }
```

Add the `status` predicate to the `list_leads_tx` total and rows SQL:

```sql
AND ($5::text IS NULL OR p.status = $5)
```

with a `LEFT JOIN discovery_lead_profiles p ON p.community_id=o.community_id AND p.lead_id=o.id`
in both queries, binding `request.status.map(|status| status_text(status))` as `$5`
and shifting the existing `$5`/`$6` page params to `$6`/`$7`.

- [ ] **Step 3: Add `get_lead_tx` and `update_lead_tx`**

```rust
async fn get_lead_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    lead_id: Uuid,
) -> Result<DiscoveryLeadDetail> {
    let row = sqlx::query(
        "SELECT o.id AS lead_id,c.id AS campaign_id,c.industry_id,c.vertical_id,o.provider,o.name,\
                o.website,o.phone,o.full_address,o.city,o.state,o.country,o.category,o.subtypes,\
                o.rating_hundredths,o.reviews_count,o.source_url,o.image_url,o.first_observed_at,\
                p.status,p.owner_persona_id,p.website AS website_override,p.email,p.phone AS phone_override,\
                p.linkedin_url,p.contact_name,p.contact_title,p.notes,p.score,\
                encode(p.updated_by,'hex') AS updated_by,p.updated_at \
         FROM discovery_business_observations o \
         JOIN discovery_runs r ON r.community_id=o.community_id AND r.id=o.first_run_id \
         JOIN discovery_campaigns c ON c.community_id=r.community_id AND c.id=r.campaign_id \
         LEFT JOIN discovery_lead_profiles p ON p.community_id=o.community_id AND p.lead_id=o.id \
         WHERE o.community_id=$1 AND o.id=$2",
    )
    .bind(community_id.as_uuid())
    .bind(lead_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| DbError::NotFound("Discovery Lead".into()))?;
    lead_detail_from_row(&row)
}

async fn update_lead_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    actor_pubkey: &[u8; 32],
    lead_id: Uuid,
    input: &DiscoveryLeadUpdateInput,
) -> Result<DiscoveryLeadDetail> {
    input
        .validate()
        .map_err(|error| DbError::InvalidData(error.to_string()))?;
    let previous = get_lead_tx(tx, community_id, lead_id).await?;
    let next_status = input
        .status
        .unwrap_or(previous.status)
        .to_relationship_status();
    let from = previous.status.to_relationship_status();
    if !is_relationship_transition_allowed(RelationshipKind::Lead, from, next_status) {
        return Err(DbError::InvalidData(format!(
            "Lead status transition {from:?} -> {next_status:?} is not allowed"
        )));
    }
    sqlx::query(
        "INSERT INTO discovery_lead_profiles \
         (community_id,lead_id,status,owner_persona_id,website,email,phone,linkedin_url,\
          contact_name,contact_title,notes,score,updated_by,updated_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now()) \
         ON CONFLICT (community_id,lead_id) DO UPDATE SET \
           status=EXCLUDED.status,owner_persona_id=EXCLUDED.owner_persona_id,\
           website=EXCLUDED.website,email=EXCLUDED.email,phone=EXCLUDED.phone,\
           linkedin_url=EXCLUDED.linkedin_url,contact_name=EXCLUDED.contact_name,\
           contact_title=EXCLUDED.contact_title,notes=EXCLUDED.notes,score=EXCLUDED.score,\
           updated_by=EXCLUDED.updated_by,updated_at=now()",
    )
    .bind(community_id.as_uuid())
    .bind(lead_id)
    .bind(status_text(next_status))
    .bind(input.owner_persona_id.as_deref())
    .bind(input.website.as_deref())
    .bind(input.email.as_deref())
    .bind(input.phone.as_deref())
    .bind(input.linkedin_url.as_deref())
    .bind(input.contact_name.as_deref())
    .bind(input.contact_title.as_deref())
    .bind(input.notes.as_deref())
    .bind(input.score.map(|score| i16::try_from(score).unwrap_or(i16::MAX)))
    .bind(actor_pubkey.as_slice())
    .execute(&mut **tx)
    .await?;
    get_lead_tx(tx, community_id, lead_id).await
}
```

Add helpers `status_text(RelationshipStatus) -> &'static str` (candidate/accepted/qualified/dormant/disqualified/client_active) and `lead_detail_from_row(&PgRow) -> Result<DiscoveryLeadDetail>` that maps the query above, defaulting `p.status` to `candidate` when the profile row is absent (`Option<String>`).

Note: `is_relationship_transition_allowed` treats `ClientActive -> Candidate` as false because `Active` belongs to the Client view; that is the intended won-is-terminal behavior for this phase.

- [ ] **Step 4: Compile**

```bash
cargo check -p buzz-db -p buzz-relay
```

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-core/src/discovery_workspace.rs crates/buzz-db/src/discovery_workspace.rs
git commit -s -m "feat(db): persist lead profiles and status-filtered lead lists"
```

---

## Task 5: CLI — `lead-get` and `lead-update`

**Files:**
- Modify: `crates/buzz-cli/src/lib.rs`
- Modify: `crates/buzz-cli/src/commands/discovery.rs`

- [ ] **Step 1: Add CLI variants**

In `DiscoveryCmd`:

```rust
    /// Read one retained Lead with its editable profile
    LeadGet {
        /// Lead UUID.
        #[arg(long)]
        lead: Uuid,
        /// Stable retry key. Reuse it after an uncertain delivery.
        #[arg(long)]
        idempotency_key: Option<Uuid>,
    },
    /// Update one retained Lead's editable profile and funnel status
    LeadUpdate {
        /// Lead UUID.
        #[arg(long)]
        lead: Uuid,
        /// Website override.
        #[arg(long)]
        website: Option<String>,
        /// Email override.
        #[arg(long)]
        email: Option<String>,
        /// Phone override.
        #[arg(long)]
        phone: Option<String>,
        /// LinkedIn profile URL.
        #[arg(long)]
        linkedin_url: Option<String>,
        /// Contact name (People leads).
        #[arg(long)]
        contact_name: Option<String>,
        /// Contact title (People leads).
        #[arg(long)]
        contact_title: Option<String>,
        /// Free-text notes.
        #[arg(long)]
        notes: Option<String>,
        /// Quality score 0-100.
        #[arg(long)]
        score: Option<u16>,
        /// Owner persona id.
        #[arg(long)]
        owner: Option<String>,
        /// Funnel status: candidate, accepted, qualified, dormant, disqualified, client_active
        #[arg(long, value_enum)]
        status: Option<DiscoveryLeadStatusArg>,
        /// Stable retry key. Reuse it after an uncertain delivery.
        #[arg(long)]
        idempotency_key: Option<Uuid>,
    },
```

Add a `DiscoveryLeadStatusArg` clap value enum in `lib.rs` mapping to
`buzz_core::discovery_workspace::DiscoveryLeadStatus` via `From`.

Add to the discovery parse test list:

```rust
            vec!["buzz", "discovery", "lead-get", "--lead", campaign],
            vec![
                "buzz",
                "discovery",
                "lead-update",
                "--lead",
                campaign,
                "--status",
                "accepted",
                "--notes",
                "Warm intro",
            ],
```

- [ ] **Step 2: Add dispatch arms**

```rust
        DiscoveryCmd::LeadGet { lead, idempotency_key } => {
            publish_workspace_payload(
                client,
                DiscoveryWorkspaceActionPayload::GetLead { lead_id: lead },
                idempotency_key,
            )
            .await
        }
        DiscoveryCmd::LeadUpdate {
            lead,
            website,
            email,
            phone,
            linkedin_url,
            contact_name,
            contact_title,
            notes,
            score,
            owner,
            status,
            idempotency_key,
        } => {
            publish_workspace_payload(
                client,
                DiscoveryWorkspaceActionPayload::UpdateLead {
                    lead_id: lead,
                    input: DiscoveryLeadUpdateInput {
                        website: website.map(|value| value.trim().to_owned()),
                        email: email.map(|value| value.trim().to_owned()),
                        phone: phone.map(|value| value.trim().to_owned()),
                        linkedin_url: linkedin_url.map(|value| value.trim().to_owned()),
                        contact_name: contact_name.map(|value| value.trim().to_owned()),
                        contact_title: contact_title.map(|value| value.trim().to_owned()),
                        notes: notes.map(|value| value.trim().to_owned()),
                        score,
                        owner_persona_id: owner.map(|value| value.trim().to_owned()),
                        status: status.map(Into::into),
                    },
                },
                idempotency_key,
            )
            .await
        }
```

Add `DiscoveryLeadUpdateInput` and `DiscoveryLeadStatus` to the imports in `commands/discovery.rs`.

- [ ] **Step 3: Test and commit**

```bash
cargo test -p buzz-cli
git add crates/buzz-cli/src/lib.rs crates/buzz-cli/src/commands/discovery.rs
git commit -s -m "feat(cli): add buzz discovery lead-get and lead-update"
```

---

## Task 6: Desktop adapter — `getLead` and `updateLead`

**Files:**
- Modify: `desktop/src/features/discovery/types.ts`
- Modify: `desktop/src/features/discovery/data/DiscoveryDataSource.ts`
- Modify: `desktop/src/features/discovery/data/FixtureDiscoveryDataSource.ts`
- Modify: `desktop/src/features/discovery/data/RelayDiscoveryDataSource.ts`
- Test: `desktop/src/features/discovery/data/RelayDiscoveryDataSource.test.mjs`

- [ ] **Step 1: Add the desktop types**

```ts
export type LeadStatus = "candidate" | "accepted" | "qualified" | "dormant" | "disqualified" | "client_active";

export type LeadDetail = Lead & {
  status: LeadStatus;
  owner?: string;
  notes?: string;
  updatedAt?: string;
};
```

Replace the existing `LeadStatus` type (currently `"new" | "enriched" | "qualified" | "rejected"`) and update the `status` field on `Lead` to the new union; update fixture statuses to the Party vocabulary.

- [ ] **Step 2: Extend the interface**

```ts
  getLead(leadId: string): Promise<LeadDetail>;
  updateLead(leadId: string, input: LeadUpdateInput): Promise<LeadDetail>;
```

with `LeadUpdateInput` = the camelCase desktop form of the core input.

- [ ] **Step 3: Fixture implementation**

`getLead` returns the matching global lead with `status` from its profile (default `candidate`); `updateLead` applies fields to the fixture map and returns the detail. Add a unit test in `discoveryData.test.mjs`.

- [ ] **Step 4: Relay adapter**

Add `get_lead`/`update_lead` to `WorkspaceOperation` and `{ result: "lead"; lead: LeadDetail }` to `WorkspaceResult` in `relayBroker.ts`; implement `getLead`/`updateLead` in `RelayDiscoveryDataSource` mapping the relay detail onto `LeadDetail`.

Extend the harness in `RelayDiscoveryDataSource.test.mjs` with `get_lead`/`update_lead` branches and add tests: update round-trips through the op and an illegal status transition surfaces as a relay error.

- [ ] **Step 5: Run and commit**

```bash
cd desktop
pnpm test
pnpm typecheck
cd ..
git add desktop/src/features/discovery/types.ts \
  desktop/src/features/discovery/data/DiscoveryDataSource.ts \
  desktop/src/features/discovery/data/FixtureDiscoveryDataSource.ts \
  desktop/src/features/discovery/data/RelayDiscoveryDataSource.ts \
  desktop/src/features/discovery/data/relayBroker.ts \
  desktop/src/features/discovery/data/discoveryData.test.mjs \
  desktop/src/features/discovery/data/RelayDiscoveryDataSource.test.mjs
git commit -s -m "feat(discovery): expose lead detail and update through the desktop adapter"
```

---

## Task 7: Relay e2e proof

**Files:**
- Modify: `crates/buzz-test-client/tests/e2e_discovery.rs`

- [ ] **Step 1: Add the e2e test**

Add `lead_update_persists_and_rejects_illegal_transitions` to
`crates/buzz-test-client/tests/e2e_discovery.rs` (implemented in Task 7's
commit; it follows the Phase A helpers: provision member, enable entitlement,
create campaign, insert a run + one observation, then `GetLead`,
`UpdateLead { status: accepted, notes, score }`, `ListLeads { status:
accepted }`, `UpdateLead { status: disqualified }`, and a refused
`disqualified -> accepted` transition).

- [ ] **Step 2: Run against the isolated harness**

```bash
./scripts/start-isolated-test-relay.sh --profile debug
# apply migrations/0046_discovery_lead_profiles.sql to the harness DB
RELAY_URL=ws://localhost:3030 DATABASE_URL=postgres://buzz:buzz_dev@localhost:5471/buzz \
cargo test -p buzz-test-client --test e2e_discovery lead_update -- --ignored --nocapture
# tear down: tmux kill-session -t dawn-relay; docker compose -p buzz-harness -f docker-compose.harness.yml down -v
```

- [ ] **Step 3: Commit**

```bash
git add crates/buzz-test-client/tests/e2e_discovery.rs
git commit -s -m "test(discovery): prove lead detail, update, and status filtering"
```

---

## Task 8: Full gate

```bash
cd desktop && pnpm test && pnpm typecheck && pnpm check:px-text && cd ..
cargo test -p buzz-core -p buzz-sdk -p buzz-db -p buzz-cli
just ci
```

Commit any fixes with `-s`. Then push and open the Phase B PR to `develop`.
