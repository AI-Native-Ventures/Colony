//! Relay-bundled provisioned employees: the colleagues Colony provides.
//!
//! A provisioned employee is an ordinary employee. It has the same row in
//! `employees`, the same relay-held sealed key, the same kind 30190 head, the
//! same place in the interrupt ladder, and its work runs on members' machines
//! through the same job queue (`docs/design/company-employees.html`). Only its
//! provenance differs: an owner hires an employee with a signed kind 9045
//! request, while these are seeded from manifests bundled in the relay binary,
//! the same way Core Blocks are ([`crate::core_blocks`]).
//!
//! That difference is the whole feature. Because Colony writes the manifest,
//! Colony can guarantee what the employee is and keep improving it: a newer
//! bundled version updates every workspace on the next relay start. Because
//! nobody else writes it, nobody else can quietly break it, so the four
//! refusal points in [`crate::handlers::ingest`],
//! [`crate::handlers::identity_archive`] and [`crate::employee_broker`] turn
//! away every user path that would archive, retire, rename or re-prompt one.
//! Employees a workspace creates for itself stay entirely editable; nothing
//! here touches them.
//!
//! Two properties this module is built around:
//!
//! - **Seeding never fails a relay start.** It runs before anyone connects,
//!   and an employee that could not be seeded is a missing colleague, not a
//!   dead workspace. A relay with no employee key-encryption key configured
//!   simply has no provisioned employees, logged once per start.
//! - **Seeding never displaces a user's own employee.** The insert leans on
//!   the same unique indexes the hire path does, so a workspace that already
//!   employs somebody in the role keeps them and the seed settles as a no-op.

use anyhow::Context;
use buzz_core::interrupt::AgentTier;
use buzz_core::kind::{KIND_EMPLOYEE, KIND_MANAGED_AGENT, KIND_PROFILE};
use buzz_core::CommunityId;
use nostr::{Event, EventBuilder, Keys, Kind, Tag};
use serde::Deserialize;
use tracing::{info, warn};

use crate::state::AppState;

/// Every bundled employee: the manifest, and the persona prompt it names.
///
/// The prompt lives in its own file rather than inside the JSON because it is
/// prose that gets edited often and reviewed on its own terms. A manifest and
/// its prompt are bound together here, at the one place both are compiled in.
/// Order matters. An entry's reporting line is resolved against the payroll
/// in the same pass that seeds it, so the Chief of Staff has to exist before
/// anyone who reports to it, or the first pass would seed Sales unassigned
/// and only attach it on the next relay start.
const CORE_EMPLOYEE_ASSETS: [(&str, &str, &str); 2] = [
    (
        "chief-of-staff.json",
        include_str!("core_employees/chief-of-staff.json"),
        include_str!("core_employees/chief-of-staff-prompt.md"),
    ),
    (
        "sales.json",
        include_str!("core_employees/sales.json"),
        include_str!("core_employees/sales-prompt.md"),
    ),
];

/// The schema string every bundled manifest declares, so a file from some
/// other part of the product cannot be read as an employee by accident.
const EMPLOYEE_SCHEMA: &str = "ai-native-office/provisioned-employee/v1";

/// One employee Colony provides, as bundled in the relay binary.
#[derive(Debug, Clone, Deserialize)]
pub struct ProvisionedEmployee {
    /// Schema discriminator; must equal [`EMPLOYEE_SCHEMA`].
    pub schema: String,
    /// Stable identity of this entry across every workspace and every relay
    /// version. Seeding is idempotent on it and every refusal keys on it.
    pub handle: String,
    /// The bundled version. A higher number than the seeded row updates it.
    pub version: i32,
    /// The name this employee goes by in chat.
    pub display_name: String,
    /// The role slug it fills, unique among a workspace's active employees.
    pub role_id: String,
    /// One of `worker`, `leader`, `executive`.
    pub rank: String,
    /// The role slug this employee reports to, or `None` when it reports to
    /// nobody because it is the top of the chart.
    ///
    /// A role rather than a pubkey, because the identity holding a role
    /// differs per workspace while the org shape does not. Resolved against
    /// the payroll at seed time; see [`resolve_reporting_line`].
    #[serde(default)]
    pub reports_to: Option<String>,
    /// The agent harness that runs it, by catalog id (`claude`, `codex`, ...).
    pub harness: String,
    /// The model to pin, or `None` to let the harness choose.
    #[serde(default)]
    pub model: Option<String>,
    /// One line describing what this employee does, shown wherever it is
    /// introduced.
    pub summary: String,
    /// Top-level `buzz` subcommands this employee's brief tells it to use.
    ///
    /// An employee runs the `buzz` that ships inside the installed app, and a
    /// brief naming a command that binary does not have is broken on arrival:
    /// the agent improvises something adjacent and produces work nobody asked
    /// for. So the brief declares its surface here and the client refuses to
    /// launch an employee whose binary cannot satisfy it, naming the missing
    /// command. An employee that stays absent until the app catches up is the
    /// better failure.
    #[serde(default)]
    pub requires_commands: Vec<String>,
    /// The persona prompt, loaded from the manifest's companion file. Not a
    /// JSON field: it is filled in by [`core_employee_manifests`].
    #[serde(skip)]
    pub prompt: String,
}

impl ProvisionedEmployee {
    /// The rank as the interrupt ladder understands it.
    fn tier(&self) -> Option<AgentTier> {
        AgentTier::parse(&self.rank)
    }
}

/// Parse and validate every manifest bundled with the relay.
///
/// A malformed bundled asset is a build mistake, not a runtime condition, so
/// this is strict: an unknown schema, an empty field, an unparseable rank or a
/// version below one is an error rather than a skipped entry.
pub fn core_employee_manifests() -> anyhow::Result<Vec<ProvisionedEmployee>> {
    let mut parsed = Vec::with_capacity(CORE_EMPLOYEE_ASSETS.len());
    for (path, manifest_source, prompt_source) in CORE_EMPLOYEE_ASSETS {
        let mut employee: ProvisionedEmployee = serde_json::from_str(manifest_source)
            .with_context(|| format!("bundled employee manifest {path} is not valid JSON"))?;
        employee.prompt = prompt_source.trim().to_owned();

        if employee.schema != EMPLOYEE_SCHEMA {
            anyhow::bail!(
                "bundled employee manifest {path} declares schema `{}`, expected `{EMPLOYEE_SCHEMA}`",
                employee.schema
            );
        }
        if employee.handle.trim().is_empty() {
            anyhow::bail!("bundled employee manifest {path} has an empty handle");
        }
        if employee.version < 1 {
            anyhow::bail!(
                "bundled employee manifest {path} has version {}, which must be at least 1",
                employee.version
            );
        }
        if employee.display_name.trim().is_empty() {
            anyhow::bail!("bundled employee manifest {path} has an empty display name");
        }
        if employee.role_id.trim().is_empty() {
            anyhow::bail!("bundled employee manifest {path} has an empty role");
        }
        if employee.harness.trim().is_empty() {
            anyhow::bail!("bundled employee manifest {path} has an empty harness");
        }
        if employee.prompt.is_empty() {
            anyhow::bail!("bundled employee {path} has an empty persona prompt");
        }
        if employee
            .requires_commands
            .iter()
            .any(|command| command.trim().is_empty())
        {
            anyhow::bail!("bundled employee manifest {path} names an empty required command");
        }
        let Some(tier) = employee.tier() else {
            anyhow::bail!(
                "bundled employee manifest {path} has rank `{}`, which is not a tier",
                employee.rank
            );
        };

        // The reporting rule the relay already enforces: an agent reports one
        // rung up, so a `leader` reports to an `executive` and an `executive`
        // reports to nobody. A `worker` would have to report to a leader, and
        // Colony provides no leader for it to report to, so an entry shipping
        // as a worker would land permanently unassigned. Refused at build
        // time rather than discovered in a workspace.
        match tier {
            AgentTier::Executive => {
                if employee.reports_to.is_some() {
                    anyhow::bail!(
                        "bundled employee manifest {path} is an executive, which reports to nobody"
                    );
                }
            }
            AgentTier::Leader => {
                let reports_to = employee
                    .reports_to
                    .as_deref()
                    .map(str::trim)
                    .filter(|role| !role.is_empty());
                if reports_to.is_none() {
                    anyhow::bail!(
                        "bundled employee manifest {path} is a leader and must name the role it \
                         reports to"
                    );
                }
            }
            AgentTier::Worker => anyhow::bail!(
                "bundled employee manifest {path} ships as a worker, which reports to a leader \
                 Colony does not provide; it would stay unassigned in every workspace"
            ),
        }
        parsed.push(employee);
    }

    let mut handles: Vec<&str> = parsed.iter().map(|entry| entry.handle.as_str()).collect();
    handles.sort_unstable();
    let unique = handles.len();
    handles.dedup();
    if handles.len() != unique {
        anyhow::bail!("two bundled employee manifests share a handle");
    }

    Ok(parsed)
}

/// What seeding one employee did, so the caller can log a line that says which.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeedOutcome {
    /// A new identity was minted and its records published.
    Seeded,
    /// A newer bundled version replaced what was already seeded.
    Updated,
    /// The bundled version is already the seeded one. Nothing was written.
    Unchanged,
    /// A user's own employee already holds this role, so the seed stood down.
    RoleTaken,
    /// An agent the workspace created already holds this role, so the seed
    /// stood down and left the owner's arrangement alone.
    RoleClaimedByWorkspaceAgent,
}

/// Ensure every bundled employee exists for one community.
///
/// Returns how many rows were written or updated. An employee that could not
/// be seeded is logged and skipped: one bad entry must not stop the rest, and
/// the next relay start tries again.
pub async fn ensure_core_employees(
    state: &AppState,
    community: CommunityId,
) -> anyhow::Result<usize> {
    let manifests =
        core_employee_manifests().context("bundled provisioned employees are invalid")?;

    // No key-encryption key means the relay cannot hold employee keys at all,
    // so there is nothing to seed and nothing is wrong. Said once, plainly,
    // rather than once per employee per community.
    if state.employee_key_sealer.is_none() {
        warn!(
            community = %community,
            "no employee key-encryption key is configured; provisioned employees were not seeded"
        );
        return Ok(0);
    }

    let mut written = 0usize;
    for employee in &manifests {
        match seed_one(state, community, employee).await {
            Ok(SeedOutcome::Seeded) => {
                written += 1;
                info!(community = %community, handle = %employee.handle, "provisioned employee seeded");
            }
            Ok(SeedOutcome::Updated) => {
                written += 1;
                info!(
                    community = %community,
                    handle = %employee.handle,
                    version = employee.version,
                    "provisioned employee updated to a newer bundled version"
                );
            }
            Ok(SeedOutcome::Unchanged) => {}
            Ok(SeedOutcome::RoleClaimedByWorkspaceAgent) => {
                warn!(
                    community = %community,
                    handle = %employee.handle,
                    role = %employee.role_id,
                    "an agent this workspace created already holds this role; the provisioned \
                     employee stood down and the owner's arrangement was left alone"
                );
            }
            Ok(SeedOutcome::RoleTaken) => {
                warn!(
                    community = %community,
                    handle = %employee.handle,
                    role = %employee.role_id,
                    "a workspace employee already holds this role; the provisioned employee was not seeded"
                );
            }
            Err(error) => {
                warn!(
                    community = %community,
                    handle = %employee.handle,
                    error = %error,
                    "provisioned employee seeding failed; continuing"
                );
            }
        }

        // Runs on every pass, not only when the row changed. Access is a
        // separate fact from the row, it can be missing while the row is
        // current (every employee seeded before this existed is in exactly
        // that state), and both writes are idempotent, so reconciling here
        // heals an existing workspace on its next relay start.
        if let Err(error) = ensure_workspace_access(state, community, &employee.handle).await {
            warn!(
                community = %community,
                handle = %employee.handle,
                error = %error,
                "provisioned employee workspace access could not be reconciled; continuing"
            );
        }
    }

    Ok(written)
}

/// Give a seeded employee what it needs to do its job: membership of the
/// community, and the Discovery capability its brief depends on.
///
/// Neither is implied by the employees row. An employee that is not a relay
/// member cannot authenticate at all, and one without a `discovery.run` actor
/// grant is refused by the Discovery broker with "this agent has not been
/// granted the Discovery capability". Both were being done by hand, per
/// workspace, which is the definition of something provisioning should own.
///
/// `granted_by` is a real community owner, because the grant records who
/// authorised the capability and a relay-invented grantor would make that
/// record a lie. A community with no owner yet is left alone and reconciled
/// on the next pass rather than granted by nobody.
async fn ensure_workspace_access(
    state: &AppState,
    community: CommunityId,
    handle: &str,
) -> anyhow::Result<()> {
    let Some(row) = state
        .db
        .find_provisioned_employee(community, handle)
        .await
        .context("failed to load the seeded employee")?
    else {
        return Ok(());
    };

    let owners = state
        .db
        .list_relay_owners(community, 1)
        .await
        .context("failed to look up a community owner")?;
    let Some(owner_hex) = owners.first() else {
        warn!(
            community = %community,
            handle,
            "community has no owner yet; employee access will be reconciled on the next pass"
        );
        return Ok(());
    };

    let employee_hex = hex::encode(&row.pubkey);
    let added = state
        .db
        .add_relay_member(community, &employee_hex, "member", Some(owner_hex))
        .await
        .context("failed to add the employee to the community")?;
    if added {
        info!(
            community = %community,
            handle,
            "provisioned employee added to the community"
        );
    }

    let actor: [u8; 32] = row
        .pubkey
        .as_slice()
        .try_into()
        .map_err(|_| anyhow::anyhow!("stored employee pubkey is not 32 bytes"))?;
    let granted_by: [u8; 32] = hex::decode(owner_hex)
        .ok()
        .and_then(|bytes| <[u8; 32]>::try_from(bytes.as_slice()).ok())
        .ok_or_else(|| anyhow::anyhow!("stored community owner pubkey is not 32 bytes"))?;
    state
        .db
        .set_discovery_actor_grant(community, &actor, &granted_by, true)
        .await
        .context("failed to grant the employee the Discovery capability")?;

    Ok(())
}

/// Ensure bundled employees for every active community on this relay.
///
/// Every community is attempted even if one fails, and a failure is reported
/// rather than returned: a relay that cannot seed an employee still serves
/// chat, and the seed converges on the next start.
pub async fn ensure_core_employees_for_all_communities(state: &AppState) -> anyhow::Result<usize> {
    let communities = state
        .db
        .list_active_communities()
        .await
        .context("failed to list active communities for provisioned employee seeding")?;

    let mut written = 0usize;
    for community in communities {
        match ensure_core_employees(state, community.id).await {
            Ok(count) => written += count,
            Err(error) => {
                warn!(
                    community = %community.id,
                    host = %community.host,
                    error = %error,
                    "provisioned employee seeding failed for community"
                );
            }
        }
    }

    Ok(written)
}

/// Seed, update, or leave alone one bundled employee in one community.
async fn seed_one(
    state: &AppState,
    community: CommunityId,
    employee: &ProvisionedEmployee,
) -> anyhow::Result<SeedOutcome> {
    let sealer = state
        .employee_key_sealer
        .as_ref()
        .context("no employee key-encryption key is configured")?;

    let already_seeded = state
        .db
        .find_provisioned_employee(community, &employee.handle)
        .await
        .context("failed to look up an already-seeded employee")?;

    // Stand down before minting anything, but only for a workspace that has
    // not already adopted this employee: once ours exists, an owner creating
    // an agent in the same role must not make ours stop being maintained.
    if already_seeded.is_none()
        && role_claimed_by_workspace_agent(state, community, &employee.role_id).await?
    {
        return Ok(SeedOutcome::RoleClaimedByWorkspaceAgent);
    }

    let manager = resolve_reporting_line(state, community, employee).await?;

    if let Some(existing) = already_seeded {
        if existing.provisioned_version.unwrap_or(0) >= employee.version {
            return Ok(SeedOutcome::Unchanged);
        }

        let updated = state
            .db
            .update_provisioned_employee(
                community,
                buzz_db::employees::ProvisionedEmployeeUpdate {
                    handle: &employee.handle,
                    display_name: &employee.display_name,
                    role_id: &employee.role_id,
                    rank: &employee.rank,
                    version: employee.version,
                    manager: manager.as_deref(),
                },
            )
            .await
            .context("failed to apply a newer bundled version")?
            .context("the seeded employee vanished while being updated")?;

        let keys = open_keys(sealer, community, &updated.pubkey, &updated.sealed_key)?;
        publish_records(state, community, employee, &keys, manager.as_deref()).await;
        return Ok(SeedOutcome::Updated);
    }

    // Mint independently of the relay's own keypair, for the same reason
    // hiring does: deriving from it would make every dev install share
    // employee identities, because the dev relay key is a repo constant.
    let keys = Keys::generate();
    let pubkey_bytes = keys.public_key().to_bytes().to_vec();
    let secret: [u8; 32] = keys.secret_key().to_secret_bytes();
    let employee_pubkey: [u8; 32] = keys.public_key().to_bytes();
    let sealed = sealer
        .seal(*community.as_uuid(), &employee_pubkey, &secret)
        .map_err(|error| anyhow::anyhow!("could not seal the employee key: {error}"))?;

    let inserted = state
        .db
        .insert_provisioned_employee(
            community,
            buzz_db::employees::NewProvisionedEmployee {
                pubkey: &pubkey_bytes,
                sealed_key: &sealed,
                role_id: &employee.role_id,
                display_name: &employee.display_name,
                rank: &employee.rank,
                provisioned_handle: &employee.handle,
                provisioned_version: employee.version,
                manager: manager.as_deref(),
            },
        )
        .await
        .context("failed to record the provisioned employee")?;

    // `None` means a unique index refused the row. The handle index is
    // handled above, so reaching here means a workspace employee already
    // holds the role. The minted key is simply dropped: it was never
    // published, so nothing refers to it.
    if inserted.is_none() {
        return Ok(SeedOutcome::RoleTaken);
    }

    publish_records(state, community, employee, &keys, manager.as_deref()).await;
    Ok(SeedOutcome::Seeded)
}

/// Upper bound on the managed-agent heads one stand-down check reads. A
/// workspace has tens of agents, not thousands, and this only has to find
/// whether ONE role is already claimed.
const MAX_ROLE_CLAIM_HEADS: i64 = 200;

/// Whether an agent the workspace created already holds `role_id`.
///
/// Colony provides employees; it does not take a job somebody has already
/// given to an agent of their own. Six production workspaces had an
/// owner-created agent holding `chief-of-staff` before this shipped, and
/// seeding ours beside it would have put two executives in one workspace.
/// That is worse than doing nothing: `unique_executive_in_roster` returns
/// None when more than one pubkey qualifies, by design, so the workspace
/// that had a working escalation target would have ended up with none.
///
/// Only OWNER-authored heads count, which matters more than it looks.
/// Kind 30177 is client-writable, so without that filter an agent could
/// claim a role to keep Colony out of it. It also keeps us from standing
/// down against ourselves: a provisioned employee's own definition is signed
/// by the employee, never by an owner, so our Sales definition can never be
/// read as a workspace agent already holding `sales`.
///
/// Fails closed. A read error stands the seed down rather than risking a
/// second holder of the role.
async fn role_claimed_by_workspace_agent(
    state: &AppState,
    community: CommunityId,
    role_id: &str,
) -> anyhow::Result<bool> {
    let rows = state
        .db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![KIND_MANAGED_AGENT as i32]),
            global_only: true,
            limit: Some(MAX_ROLE_CLAIM_HEADS),
            ..buzz_db::event::EventQuery::for_community(community)
        })
        .await
        .context("failed to read managed-agent heads while checking the role")?;

    for stored in rows {
        let claims_role = serde_json::from_str::<serde_json::Value>(&stored.event.content)
            .ok()
            .and_then(|content| {
                content
                    .get("role_id")
                    .and_then(serde_json::Value::as_str)
                    .map(|value| value.trim().to_ascii_lowercase())
            })
            .is_some_and(|claimed| claimed == role_id.trim().to_ascii_lowercase());
        if !claims_role {
            continue;
        }

        let author_is_owner = state
            .db
            .get_relay_member(community, &stored.event.pubkey.to_hex())
            .await
            .context("failed to check a managed-agent head's author")?
            .is_some_and(|member| member.role == "owner");
        if author_is_owner {
            return Ok(true);
        }
    }

    Ok(false)
}

/// The pubkey of the employee holding `role_id`, when one does and it can
/// legitimately be this employee's manager.
///
/// Deliberately narrow. Seeding writes `employees.manager` directly, which
/// bypasses `employee_broker::validate_manager_for_rank`, so this has to
/// apply the same rule the gate would apply to an owner doing it by hand:
/// the manager must be a real agent in THIS community whose tier is exactly
/// the escalation target of the rank being seeded. An ACTIVE employee row is
/// the only source that satisfies it without trusting a client-writable
/// head, and it is the same source `active_role_ranks` reads.
///
/// `None` is the honest answer whenever the role is unfilled or the holder
/// is the wrong rank. An employee left unassigned is visibly unplaced; an
/// employee pointed at an escalation target the relay cannot rank looks
/// placed and escalates nowhere.
async fn resolve_reporting_line(
    state: &AppState,
    community: CommunityId,
    employee: &ProvisionedEmployee,
) -> anyhow::Result<Option<Vec<u8>>> {
    let Some(role) = employee
        .reports_to
        .as_deref()
        .map(str::trim)
        .filter(|role| !role.is_empty())
    else {
        return Ok(None);
    };
    let Some(tier) = employee.tier() else {
        return Ok(None);
    };

    let manager = state
        .db
        .find_active_employee_by_role(community, &role.to_ascii_lowercase())
        .await
        .context("failed to resolve the reporting line")?;
    let Some(manager) = manager else {
        return Ok(None);
    };

    let expected = tier.escalation_target();
    match AgentTier::parse(&manager.rank) {
        Some(actual) if actual == expected => Ok(Some(manager.pubkey)),
        other => {
            warn!(
                community = %community,
                handle = %employee.handle,
                role,
                manager_rank = other.map(|tier| tier.as_str()).unwrap_or("unparseable"),
                expected = expected.as_str(),
                "the employee holding this role is the wrong rank to be a manager; \
                 leaving the reporting line unset"
            );
            Ok(None)
        }
    }
}

/// Re-derive a seeded employee's signing keys from its sealed column.
fn open_keys(
    sealer: &crate::employee_key::EmployeeKeySealer,
    community: CommunityId,
    pubkey: &[u8],
    sealed_key: &[u8],
) -> anyhow::Result<Keys> {
    let employee_pubkey: [u8; 32] = pubkey
        .try_into()
        .map_err(|_| anyhow::anyhow!("stored employee pubkey is not 32 bytes"))?;
    let secret = sealer
        .open(*community.as_uuid(), &employee_pubkey, sealed_key)
        .map_err(|error| anyhow::anyhow!("could not open the employee key: {error}"))?;
    Keys::parse(&hex::encode(secret.as_slice()))
        .map_err(|error| anyhow::anyhow!("stored employee key is unusable: {error}"))
}

/// The timestamp a fresh set of records must carry in order to win.
///
/// All three records are replaceable, and replacement is decided by
/// `created_at` with ties broken by event id, which is a coin flip on a
/// sha256. Two seed runs inside the same second would therefore have an even
/// chance of leaving the OLD records in place while every check stayed
/// green -- the same trap Core Block manifests hit when a manifest was
/// edited without moving its timestamp. So a republish never merely uses
/// `now`: it uses one second past whatever this employee has already
/// published, whenever that is not already in the past.
///
/// A read failure falls back to `now`, because a seed that publishes at the
/// wrong second is better than a seed that publishes nothing.
async fn next_created_at(
    state: &AppState,
    community: CommunityId,
    keys: &Keys,
) -> nostr::Timestamp {
    let now = nostr::Timestamp::now();
    let existing = state
        .db
        .query_events(&buzz_db::event::EventQuery {
            authors: Some(vec![keys.public_key().to_bytes().to_vec()]),
            global_only: true,
            limit: Some(10),
            ..buzz_db::event::EventQuery::for_community(community)
        })
        .await;

    let newest = match existing {
        Ok(rows) => rows
            .iter()
            .map(|stored| stored.event.created_at.as_secs())
            .max(),
        Err(error) => {
            warn!(
                community = %community,
                error = %error,
                "could not read an employee's existing records; publishing at the current time"
            );
            None
        }
    };

    match newest {
        Some(previous) if previous >= now.as_secs() => nostr::Timestamp::from_secs(previous + 1),
        _ => now,
    }
}

/// Publish the three records that make a seeded employee visible: its profile,
/// its employee head, and its agent definition.
///
/// Relay-authored writes bypass ingest, so this stores each event directly.
/// Failures are logged rather than returned, exactly as the hire path treats
/// its heads: the durable record of employment is the row, and a lost head is
/// republished by the next seed run.
async fn publish_records(
    state: &AppState,
    community: CommunityId,
    employee: &ProvisionedEmployee,
    keys: &Keys,
    manager: Option<&[u8]>,
) {
    let created_at = next_created_at(state, community, keys).await;
    for event in build_records(employee, keys, created_at, manager) {
        match event {
            Ok(event) => {
                if let Err(error) = state.db.insert_event(community, &event, None).await {
                    warn!(
                        community = %community,
                        handle = %employee.handle,
                        kind = event.kind.as_u16(),
                        error = %error,
                        "provisioned employee record could not be stored"
                    );
                }
            }
            Err(error) => {
                warn!(
                    community = %community,
                    handle = %employee.handle,
                    error = %error,
                    "provisioned employee record could not be built"
                );
            }
        }
    }
}

/// Build the profile, employee head and agent definition for one seeded
/// employee, all signed with its own key.
///
/// Split out from publishing so the event shapes can be asserted without a
/// database.
pub fn build_records(
    employee: &ProvisionedEmployee,
    keys: &Keys,
    created_at: nostr::Timestamp,
    manager: Option<&[u8]>,
) -> Vec<anyhow::Result<Event>> {
    vec![
        build_profile(employee, keys, created_at),
        build_employee_head(employee, keys, created_at, manager),
        build_agent_definition(employee, keys, created_at, manager),
    ]
}

/// Append the `manager` tag when a reporting line was resolved.
///
/// One helper for both heads: `direct_reports` queries kinds 30190 and 30177
/// by this tag, and the desktop org chart reads it off both, so a line
/// written onto one and not the other would draw half a chart.
fn push_manager_tag(tags: &mut Vec<Tag>, manager: Option<&[u8]>) -> anyhow::Result<()> {
    if let Some(manager) = manager {
        tags.push(Tag::parse(["manager", &hex::encode(manager)])?);
    }
    Ok(())
}

/// The kind 0 profile, so a seeded employee renders as a colleague rather than
/// a bare pubkey.
fn build_profile(
    employee: &ProvisionedEmployee,
    keys: &Keys,
    created_at: nostr::Timestamp,
) -> anyhow::Result<Event> {
    let content = serde_json::json!({
        "display_name": employee.display_name,
        "name": employee.display_name,
        "about": employee.summary,
    })
    .to_string();
    Ok(
        EventBuilder::new(Kind::Custom(KIND_PROFILE as u16), content)
            .custom_created_at(created_at)
            .sign_with_keys(keys)?,
    )
}

/// The kind 30190 employee head, in exactly the shape the hire path publishes,
/// plus the two tags that say where this one came from.
///
/// No `hired-by` and no `e`: no owner hired it and no request authorised it.
/// Readers treat both as optional already, because an employee head is
/// identified by its `d` tag and carries its authority in `rank`.
fn build_employee_head(
    employee: &ProvisionedEmployee,
    keys: &Keys,
    created_at: nostr::Timestamp,
    manager: Option<&[u8]>,
) -> anyhow::Result<Event> {
    let mut tags = vec![
        Tag::parse(["d", &keys.public_key().to_hex()])?,
        Tag::parse(["role", &employee.role_id])?,
        Tag::parse(["name", &employee.display_name])?,
        Tag::parse(["rank", &employee.rank])?,
        Tag::parse(["provisioned", &employee.handle])?,
        Tag::parse(["version", &employee.version.to_string()])?,
    ];
    // The TAG is what the org chart and `direct_reports` read; the column is
    // what `agent_manager` reads. Both are written, so the chart can never
    // show a reporting line the gate does not believe.
    push_manager_tag(&mut tags, manager)?;
    Ok(EventBuilder::new(Kind::Custom(KIND_EMPLOYEE as u16), "")
        .tags(tags)
        .custom_created_at(created_at)
        .sign_with_keys(keys)?)
}

/// The kind 30177 agent definition: what a client needs in order to run this
/// employee, and the `provisioned` tag it keys on to know the definition is
/// not the workspace's to edit.
///
/// This head is relay-side provenance only. Rank and reporting line still
/// resolve exactly as they do today, from the `employees` row and from
/// owner-authored heads; nothing here changes that read path.
fn build_agent_definition(
    employee: &ProvisionedEmployee,
    keys: &Keys,
    created_at: nostr::Timestamp,
    manager: Option<&[u8]>,
) -> anyhow::Result<Event> {
    let content = serde_json::json!({
        "name": employee.display_name,
        "role_id": employee.role_id,
        "tier": employee.rank,
        "summary": employee.summary,
        "harness": employee.harness,
        "model": employee.model,
        "requires_commands": employee.requires_commands,
        "system_prompt": employee.prompt,
        "provisioned": employee.handle,
        "version": employee.version,
    })
    .to_string();

    let mut tags = vec![
        Tag::parse(["d", &keys.public_key().to_hex()])?,
        Tag::parse(["role", &employee.role_id])?,
        Tag::parse(["name", &employee.display_name])?,
        Tag::parse(["rank", &employee.rank])?,
        Tag::parse(["provisioned", &employee.handle])?,
        Tag::parse(["version", &employee.version.to_string()])?,
    ];
    push_manager_tag(&mut tags, manager)?;
    Ok(
        EventBuilder::new(Kind::Custom(KIND_MANAGED_AGENT as u16), content)
            .tags(tags)
            .custom_created_at(created_at)
            .sign_with_keys(keys)?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_bundled_manifest_parses_and_validates() {
        let manifests = core_employee_manifests().expect("bundled employees must be valid");
        assert_eq!(manifests.len(), CORE_EMPLOYEE_ASSETS.len());
    }

    #[test]
    fn the_sales_employee_is_bundled_with_its_prompt() {
        let manifests = core_employee_manifests().expect("bundled employees must be valid");
        let sales = manifests
            .iter()
            .find(|entry| entry.handle == "sales")
            .expect("the sales employee is bundled");
        assert_eq!(sales.display_name, "Sales");
        // Not pinned here: a bundled version bump is an ordinary event, and a
        // test that hardcodes today's number turns every future bump into a
        // failure that says nothing about the thing that broke.
        assert!(sales.version >= 3);
        assert_eq!(sales.tier(), Some(AgentTier::Leader));
        assert!(sales.prompt.contains("outreach"));
        assert_eq!(
            sales.requires_commands,
            vec![
                "discovery".to_owned(),
                "messages".to_owned(),
                "outreach".to_owned()
            ]
        );
    }

    #[test]
    fn the_records_carry_the_provisioned_tag_and_the_prompt() {
        let manifests = core_employee_manifests().expect("bundled employees must be valid");
        let sales = manifests
            .iter()
            .find(|entry| entry.handle == "sales")
            .expect("sales is bundled");
        let keys = Keys::generate();
        let records: Vec<Event> = build_records(sales, &keys, nostr::Timestamp::now(), None)
            .into_iter()
            .map(|event| event.expect("records must build"))
            .collect();

        let head = records
            .iter()
            .find(|event| event.kind.as_u16() as u32 == KIND_EMPLOYEE)
            .expect("an employee head is published");
        assert_eq!(tag_value(head, "provisioned").as_deref(), Some("sales"));
        assert_eq!(tag_value(head, "rank").as_deref(), Some("leader"));
        // No owner hired it, so neither hire tag is present.
        assert!(tag_value(head, "hired-by").is_none());
        assert!(tag_value(head, "e").is_none());

        let definition = records
            .iter()
            .find(|event| event.kind.as_u16() as u32 == KIND_MANAGED_AGENT)
            .expect("an agent definition is published");
        assert_eq!(
            tag_value(definition, "provisioned").as_deref(),
            Some("sales")
        );
        let content: serde_json::Value =
            serde_json::from_str(&definition.content).expect("the definition is JSON");
        assert_eq!(content["harness"], "claude");
        assert!(content["system_prompt"]
            .as_str()
            .expect("a prompt is carried")
            .contains("outreach"));

        let profile = records
            .iter()
            .find(|event| event.kind.as_u16() as u32 == KIND_PROFILE)
            .expect("a profile is published");
        let profile_content: serde_json::Value =
            serde_json::from_str(&profile.content).expect("the profile is JSON");
        assert_eq!(profile_content["display_name"], "Sales");

        // All three speak as the same identity.
        for event in &records {
            assert_eq!(event.pubkey, keys.public_key());
        }
    }

    #[test]
    fn the_chief_of_staff_is_bundled_and_reports_to_nobody() {
        let manifests = core_employee_manifests().expect("bundled employees must be valid");
        let chief = manifests
            .iter()
            .find(|entry| entry.handle == "chief-of-staff")
            .expect("the chief of staff is bundled");
        assert_eq!(chief.role_id, "chief-of-staff");
        assert_eq!(chief.tier(), Some(AgentTier::Executive));
        assert_eq!(chief.reports_to, None);
    }

    #[test]
    fn the_chief_of_staff_is_seeded_before_anyone_who_reports_to_it() {
        // The reporting line is resolved against the payroll in the same pass
        // that seeds it, so an entry that reports to a role must come after
        // the entry that fills it. Out of order, the first pass would seed
        // Sales unassigned and only attach it on the next relay start.
        let manifests = core_employee_manifests().expect("bundled employees must be valid");
        for (index, employee) in manifests.iter().enumerate() {
            let Some(role) = employee.reports_to.as_deref() else {
                continue;
            };
            let manager_index = manifests
                .iter()
                .position(|candidate| candidate.role_id == role)
                .unwrap_or_else(|| {
                    panic!("{} reports to an unbundled role {role}", employee.handle)
                });
            assert!(
                manager_index < index,
                "{} is seeded before the {role} it reports to",
                employee.handle
            );
        }
    }

    #[test]
    fn every_bundled_rank_satisfies_the_reporting_rule() {
        // An executive reports to nobody, a leader names the role one rung
        // up, and a worker cannot ship at all because Colony provides no
        // leader for it to report to.
        let manifests = core_employee_manifests().expect("bundled employees must be valid");
        for employee in &manifests {
            match employee.tier().expect("a bundled rank parses") {
                AgentTier::Executive => assert_eq!(
                    employee.reports_to, None,
                    "{} is an executive and must report to nobody",
                    employee.handle
                ),
                AgentTier::Leader => assert!(
                    employee.reports_to.is_some(),
                    "{} is a leader and must name the role it reports to",
                    employee.handle
                ),
                AgentTier::Worker => {
                    panic!(
                        "{} ships as a worker, which validation refuses",
                        employee.handle
                    )
                }
            }
        }
    }

    #[test]
    fn a_resolved_reporting_line_lands_on_both_heads() {
        // `direct_reports` queries kinds 30190 and 30177 by the manager tag,
        // and the desktop chart reads it off both, so a line written onto one
        // and not the other draws half a chart.
        let manifests = core_employee_manifests().expect("bundled employees must be valid");
        let sales = manifests
            .iter()
            .find(|entry| entry.handle == "sales")
            .expect("sales is bundled");
        let chief = Keys::generate();
        let manager = chief.public_key().to_bytes();
        let keys = Keys::generate();

        let records: Vec<Event> = build_records(
            sales,
            &keys,
            nostr::Timestamp::now(),
            Some(manager.as_slice()),
        )
        .into_iter()
        .map(|event| event.expect("records must build"))
        .collect();

        for kind in [KIND_EMPLOYEE, KIND_MANAGED_AGENT] {
            let head = records
                .iter()
                .find(|event| u32::from(event.kind.as_u16()) == kind)
                .unwrap_or_else(|| panic!("a head of kind {kind} is published"));
            assert_eq!(
                tag_value(head, "manager").as_deref(),
                Some(hex::encode(manager).as_str()),
                "kind {kind} must carry the manager tag"
            );
        }
    }

    #[test]
    fn no_reporting_line_means_no_manager_tag_at_all() {
        // An unresolved role leaves the employee visibly unplaced rather than
        // pointed at something that cannot be ranked.
        let manifests = core_employee_manifests().expect("bundled employees must be valid");
        let keys = Keys::generate();
        let records: Vec<Event> =
            build_records(&manifests[0], &keys, nostr::Timestamp::now(), None)
                .into_iter()
                .map(|event| event.expect("records must build"))
                .collect();
        for record in &records {
            assert!(tag_value(record, "manager").is_none());
        }
    }

    fn tag_value(event: &Event, name: &str) -> Option<String> {
        event.tags.iter().find_map(|tag| {
            if tag.kind().to_string() == name {
                tag.content().map(|value| value.to_owned())
            } else {
                None
            }
        })
    }
}
