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
//! An employee a workspace creates for a role Colony does not bundle stays
//! entirely its own; one it created for a bundled role is adopted and becomes
//! Colony-maintained, while an owner-published agent that holds a bundled role
//! keeps its own key and its place in the chart.
//!
//! Two properties this module is built around:
//!
//! - **Seeding never fails a relay start.** It runs before anyone connects,
//!   and an employee that could not be seeded is a missing colleague, not a
//!   dead workspace. A relay with no employee key-encryption key configured
//!   simply has no provisioned employees, logged once per start.
//! - **Seeding never mints a second identity for a role.** A role that is
//!   already filled is honoured. An `employees` row is adopted: the same
//!   pubkey, now carrying the bundled handle, brief, name and rank, so the
//!   workspace gets every later improvement with no user action. An agent
//!   that exists only as an owner-published managed-agent head (kind 30177)
//!   cannot be adopted -- the desktop keeps its key -- but it still means the
//!   role is filled, so no second employee is minted and reporting lines
//!   point at that agent. An employee a workspace creates for a role Colony
//!   does not bundle stays entirely its own.

use std::collections::BTreeSet;

use anyhow::Context;
use buzz_core::employee::is_valid_role_slug;
use buzz_core::interrupt::AgentTier;
use buzz_core::kind::{KIND_EMPLOYEE, KIND_MANAGED_AGENT, KIND_PROFILE};
use buzz_core::CommunityId;
use nostr::{Event, EventBuilder, Keys, Kind, Tag};
use serde::Deserialize;
use tracing::{info, warn};

use crate::state::AppState;

/// How many owner-published managed-agent heads one role lookup will scan.
/// A community has a handful of agents; the cap only bounds a pathological
/// relay.
const MAX_ROLE_HOLDER_HEADS: i64 = 200;

/// Every bundled employee: the manifest, and the persona prompt it names.
///
/// The prompt lives in its own file rather than inside the JSON because it is
/// prose that gets edited often and reviewed on its own terms. A manifest and
/// its prompt are bound together here, at the one place both are compiled in.
///
/// Order is the bundle's own order, not the seeding order: reporting lines are
/// validated and sorted by [`core_employee_manifests`] before anything is
/// seeded, so a manager is always inserted before the employees that report to
/// it regardless of where the tuple sits in this list.
const CORE_EMPLOYEE_ASSETS: [(&str, &str, &str); 6] = [
    (
        "sales.json",
        include_str!("core_employees/sales.json"),
        include_str!("core_employees/sales-prompt.md"),
    ),
    (
        "chief-of-staff.json",
        include_str!("core_employees/chief-of-staff.json"),
        include_str!("core_employees/chief-of-staff-prompt.md"),
    ),
    (
        "website-manager.json",
        include_str!("core_employees/website-manager.json"),
        include_str!("core_employees/website-manager-prompt.md"),
    ),
    (
        "website-researcher.json",
        include_str!("core_employees/website-researcher.json"),
        include_str!("core_employees/website-researcher-prompt.md"),
    ),
    (
        "website-designer-builder.json",
        include_str!("core_employees/website-designer-builder.json"),
        include_str!("core_employees/website-designer-builder-prompt.md"),
    ),
    (
        "website-reviewer.json",
        include_str!("core_employees/website-reviewer.json"),
        include_str!("core_employees/website-reviewer-prompt.md"),
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
    /// The bundled `handle` of the employee this one reports to. Absent means
    /// top of the chart. Validated at load: the named handle must be bundled,
    /// and the graph must be acyclic.
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
    /// The `buzz` commands this employee's brief tells it to use: a top-level
    /// subcommand (`messages`), or a command path under one (`website get`).
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
        if employee.tier().is_none() {
            anyhow::bail!(
                "bundled employee manifest {path} has rank `{}`, which is not a tier",
                employee.rank
            );
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

    let mut roles: Vec<&str> = parsed.iter().map(|entry| entry.role_id.as_str()).collect();
    roles.sort_unstable();
    let unique_roles = roles.len();
    roles.dedup();
    if roles.len() != unique_roles {
        anyhow::bail!(
            "two bundled employee manifests share a role; a workspace can employ one agent per role"
        );
    }

    validate_reporting_lines(&parsed)?;
    sort_by_reporting_line(parsed)
}

/// Check every `reports_to` against the bundle: the named handle must exist,
/// and no employee may sit in its own reporting chain.
///
/// Both are bundle bugs that must stop the whole seed rather than one entry.
/// A `reports_to` that names nothing would otherwise seed its employee into
/// the Unassigned tray while every check stayed green; a cycle would leave the
/// topological sort with no first employee to place.
fn validate_reporting_lines(employees: &[ProvisionedEmployee]) -> anyhow::Result<()> {
    let handles: Vec<&str> = employees
        .iter()
        .map(|employee| employee.handle.as_str())
        .collect();

    for employee in employees {
        let Some(manager) = employee.reports_to.as_deref() else {
            continue;
        };
        if manager.trim().is_empty() {
            anyhow::bail!(
                "bundled employee manifest for `{}` names an empty reports_to",
                employee.handle
            );
        }
        if !handles.contains(&manager) {
            anyhow::bail!(
                "bundled employee manifest for `{}` reports to `{manager}`, which is not a bundled handle",
                employee.handle
            );
        }
    }

    // The bundle writes manager columns directly, so apply the same one-rung
    // rule that the interrupt gate applies to owner changes. A role name alone
    // is not enough: a stale or wrongly ranked holder must leave the employee
    // visibly unassigned rather than creating a line the gate cannot use.
    for employee in employees {
        let Some(tier) = employee.tier() else {
            anyhow::bail!(
                "bundled employee manifest for `{}` has an unparseable rank",
                employee.handle
            );
        };
        match (tier, employee.reports_to.as_deref()) {
            (AgentTier::Executive, None) => {}
            (AgentTier::Executive, Some(manager)) => {
                anyhow::bail!(
                    "bundled employee manifest for `{}` is an executive and must report to nobody, not `{manager}`",
                    employee.handle
                );
            }
            (AgentTier::Leader | AgentTier::Worker, None) => {
                anyhow::bail!(
                    "bundled employee manifest for `{}` is a `{}` and must name a manager",
                    employee.handle,
                    tier.as_str()
                );
            }
            (tier, Some(manager)) => {
                let Some(manager_entry) = employees
                    .iter()
                    .find(|candidate| candidate.handle == manager)
                else {
                    anyhow::bail!(
                        "bundled employee manifest for `{}` reports to `{manager}`, but the manager disappeared during validation",
                        employee.handle
                    );
                };
                let manager_tier = manager_entry.tier();
                if manager_tier != Some(tier.escalation_target()) {
                    anyhow::bail!(
                        "bundled employee manifest for `{}` is a `{}` and requires a `{}` manager, but `{manager}` is `{}`",
                        employee.handle,
                        tier.as_str(),
                        tier.escalation_target().as_str(),
                        manager_tier.map_or("unparseable", |value| value.as_str())
                    );
                }
            }
        }
    }

    Ok(())
}

/// Order the bundle so a manager is seeded before the employees that report to
/// it: the topological order of the `reports_to` graph, stable within a rank
/// of independent employees.
///
/// [`validate_reporting_lines`] already proved every name resolves, so the
/// only way to stall here is a cycle, which is refused with the handles still
/// waiting. Kahn's algorithm in bundle order: each pass places every employee
/// whose manager is already placed, so the website manager lands immediately
/// after the chief of staff and the workers after the manager.
fn sort_by_reporting_line(
    mut remaining: Vec<ProvisionedEmployee>,
) -> anyhow::Result<Vec<ProvisionedEmployee>> {
    let mut ordered: Vec<ProvisionedEmployee> = Vec::with_capacity(remaining.len());
    while !remaining.is_empty() {
        let before = remaining.len();
        let mut index = 0;
        while index < remaining.len() {
            let placed = match remaining[index].reports_to.as_deref() {
                None => true,
                Some(manager) => ordered.iter().any(|employee| employee.handle == manager),
            };
            if placed {
                ordered.push(remaining.remove(index));
            } else {
                index += 1;
            }
        }
        if remaining.len() == before {
            let stuck: Vec<&str> = remaining
                .iter()
                .map(|employee| employee.handle.as_str())
                .collect();
            anyhow::bail!(
                "bundled employee reporting lines have a cycle among: {}",
                stuck.join(", ")
            );
        }
    }
    Ok(ordered)
}

/// What seeding one employee did, so the caller can log a line that says which.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeedOutcome {
    /// A new identity was minted and its records published.
    Seeded,
    /// The workspace already employed somebody in this role, so that employee
    /// was adopted into the bundle: the same pubkey, now carrying the bundled
    /// handle and config.
    Adopted,
    /// The role is filled by an owner-published managed-agent head. The relay
    /// holds no sealed key for it, so it is neither adopted nor duplicated:
    /// the desktop keeps the agent and applies the bundle, and reporting
    /// lines resolve to its pubkey.
    HeldByManagedAgent,
    /// A newer bundled version replaced what was already seeded.
    Updated,
    /// The bundled version is already the seeded one. Nothing was written.
    Unchanged,
}

/// Ensure every bundled employee exists for one community.
///
/// Returns how many rows were written: seeded, adopted, or updated. An
/// employee that could not be seeded is logged and skipped: one bad entry must
/// not stop the rest, and the next relay start tries again.
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
        match seed_one(state, community, &manifests, employee).await {
            Ok(SeedOutcome::Seeded) => {
                written += 1;
                info!(community = %community, handle = %employee.handle, "provisioned employee seeded");
            }
            Ok(SeedOutcome::Adopted) => {
                written += 1;
                // Deliberately a warning: the owner's own agent just took
                // Colony's brief, and the owner reading a relay log needs to
                // find out why without knowing this module exists.
                warn!(
                    community = %community,
                    handle = %employee.handle,
                    role = %employee.role_id,
                    version = employee.version,
                    "a workspace employee already held this role; it was adopted into the bundled employee and now carries its brief, name and rank"
                );
            }
            Ok(SeedOutcome::HeldByManagedAgent) => {
                // No row was written. `seed_one` logs the holder (pubkey and
                // head) where it resolved it, so the central log stays quiet
                // rather than repeating a line it has less detail for.
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

/// Seed, update, adopt, or leave alone one bundled employee in one community.
///
/// Three outcomes, in order:
///
/// 1. an already-seeded row is updated when the bundle moved (or its manager
///    edge is missing), so a settled workspace writes nothing;
/// 2. a role already filled by the workspace's own employee is adopted: the
///    same pubkey, the bundle's brief, name and rank stamped on it, and the
///    bundled handle recorded so later versions keep updating it;
/// 3. otherwise a fresh identity is minted and seeded.
async fn seed_one(
    state: &AppState,
    community: CommunityId,
    manifests: &[ProvisionedEmployee],
    employee: &ProvisionedEmployee,
) -> anyhow::Result<SeedOutcome> {
    let sealer = state
        .employee_key_sealer
        .as_ref()
        .context("no employee key-encryption key is configured")?;

    let manager = resolve_manager(state, community, manifests, employee).await?;

    if let Some(existing) = state
        .db
        .find_provisioned_employee(community, &employee.handle)
        .await
        .context("failed to look up an already-seeded employee")?
    {
        let version_current = existing.provisioned_version.unwrap_or(0) >= employee.version;
        // A manager that resolves now but is missing from the row heals even
        // when the version has not moved: that state is how an employee whose
        // manager's own seeding failed on an earlier pass converges without a
        // bundle bump. A bundle that names no manager owns no manager edge, so
        // `None` never forces a write.
        let manager_current = manager
            .as_deref()
            .is_none_or(|resolved| existing.manager.as_deref() == Some(resolved));
        if version_current && manager_current {
            return Ok(SeedOutcome::Unchanged);
        }

        let updated = state
            .db
            .update_provisioned_employee(
                community,
                &employee.handle,
                &employee.display_name,
                &employee.role_id,
                &employee.rank,
                manager.as_deref(),
                employee.version,
            )
            .await
            .context("failed to apply a newer bundled version")?
            .context("the seeded employee vanished while being updated")?;

        let keys = open_keys(sealer, community, &updated.pubkey, &updated.sealed_key)?;
        // The row the write produced is the authority, not the bundle
        // resolution: when the bundle names no manager the update left an
        // existing one in place, and the head must carry that same edge.
        publish_records(
            state,
            community,
            employee,
            updated.manager.as_deref(),
            &keys,
        )
        .await;
        return Ok(SeedOutcome::Updated);
    }

    // Nothing seeded under this handle. Resolve who fills the role across
    // both ledgers: an employee row can be adopted, an owner-published
    // managed-agent head cannot (its key lives on the desktop) but still
    // means the role is filled, so no second identity is minted either way.
    match resolve_role_holder(state, community, &employee.role_id, Some(&employee.handle)).await? {
        Some(RoleHolder::Employee(holder)) => {
            if holder.provisioned_handle.is_some() {
                // A different bundled handle already owns this role. The
                // bundle refuses duplicate roles at load, so this is a row no
                // seeded pass produced; stop rather than fight it.
                warn!(
                    community = %community,
                    handle = %employee.handle,
                    role = %employee.role_id,
                    pubkey = %hex::encode(holder.pubkey),
                    "the role is already held by a different provisioned employee; not seeding this one"
                );
                return Ok(SeedOutcome::Unchanged);
            }

            let adopted = state
                .db
                .adopt_provisioned_employee(
                    community,
                    &holder.pubkey,
                    &employee.handle,
                    employee.version,
                    &employee.display_name,
                    &employee.role_id,
                    &employee.rank,
                    manager.as_deref(),
                )
                .await
                .context("failed to adopt the workspace employee holding this role")?;

            if let Some(adopted) = adopted {
                let keys = open_keys(sealer, community, &adopted.pubkey, &adopted.sealed_key)?;
                // As in the update path: publish the row's own manager, so a
                // reporting line the workspace had before adoption survives on
                // both the row and the head.
                publish_records(
                    state,
                    community,
                    employee,
                    adopted.manager.as_deref(),
                    &keys,
                )
                .await;
                return Ok(SeedOutcome::Adopted);
            }

            // The row moved between the lookup and the update: it retired, or
            // a concurrent pass adopted it first. Nothing is wrong; the next
            // start reconciles from whatever state this pass left behind.
            return Ok(SeedOutcome::Unchanged);
        }
        Some(RoleHolder::ManagedAgent(holder)) => {
            // The owner's own agent holds this role and the relay holds no
            // sealed key for it, so it cannot be adopted into the payroll. The
            // desktop applies the bundle on its side; here the only job is to
            // not mint a duplicate. `reports_to` resolves to this pubkey
            // through the same resolver on this and every later pass.
            info!(
                community = %community,
                handle = %employee.handle,
                role = %employee.role_id,
                pubkey = %hex::encode(holder.pubkey),
                head = %holder.event_id,
                "the role is held by an owner-published agent; no provisioned employee was seeded for it"
            );
            return Ok(SeedOutcome::HeldByManagedAgent);
        }
        None => {}
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
                manager: manager.as_deref(),
                provisioned_handle: &employee.handle,
                provisioned_version: employee.version,
            },
        )
        .await
        .context("failed to record the provisioned employee")?;

    // `None` means a unique index refused the row after both lookups above,
    // so a concurrent seed or hire won a race this pass cannot see. The
    // minted key is simply dropped: it was never published, so nothing refers
    // to it, and the next pass observes the winner.
    let Some(inserted) = inserted else {
        return Ok(SeedOutcome::Unchanged);
    };

    publish_records(
        state,
        community,
        employee,
        inserted.manager.as_deref(),
        &keys,
    )
    .await;
    Ok(SeedOutcome::Seeded)
}

/// Who fills a bundled employee's role in one community, and which ledger
/// answered.
///
/// Two ledgers can hold a role. The payroll (`employees`) is relay-written: a
/// seeded or adopted employee can be updated and republished. An
/// owner-published managed-agent head (kind 30177) is desktop-owned: the
/// relay can resolve it and point reporting lines at it, but it holds no
/// sealed key and can never adopt it into the payroll.
#[derive(Debug, Clone, PartialEq, Eq)]
enum RoleHolder {
    /// A row in `employees`, provisioned or the workspace's own hire. Boxed
    /// because it dwarfs the head variant beside it.
    Employee(Box<buzz_db::employees::EmployeeRow>),
    /// An owner-published managed-agent head naming this role.
    ManagedAgent(ManagedAgentHolder),
}

impl RoleHolder {
    /// The identity a reporting line must carry.
    fn pubkey(&self) -> &[u8] {
        match self {
            Self::Employee(row) => row.pubkey.as_slice(),
            Self::ManagedAgent(holder) => holder.pubkey.as_slice(),
        }
    }

    /// The rank the interrupt gate can resolve for this holder.
    fn tier(&self) -> Option<AgentTier> {
        match self {
            Self::Employee(row) => AgentTier::parse(&row.rank),
            Self::ManagedAgent(holder) => holder.tier,
        }
    }
}

/// One owner-published managed-agent head, resolved to the agent it names.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ManagedAgentHolder {
    /// The head's `d` tag: the agent's pubkey.
    pubkey: [u8; 32],
    /// The head event id, for logs.
    event_id: String,
    /// The rank declared by the owner-authored head, if it is parseable.
    /// Missing rank is deliberately not inferred from a display name or role.
    tier: Option<AgentTier>,
}

/// Every candidate holder for one role, gathered from both ledgers before a
/// choice is made so a crowded role can be logged with what was not chosen.
#[derive(Debug, Default)]
struct RoleCandidates {
    /// A row under the bundled handle the caller named, which outranks every
    /// other candidate.
    provisioned: Option<buzz_db::employees::EmployeeRow>,
    /// Active employee rows filling the role, lowest pubkey first.
    employees: Vec<buzz_db::employees::EmployeeRow>,
    /// Owner-published managed-agent heads naming the role, lowest pubkey
    /// first.
    managed_agents: Vec<ManagedAgentHolder>,
}

/// Pick the holder: the provisioned row under the bundled handle, then an
/// active employee row, then an owner-published agent head. Each list
/// arrives sorted by pubkey, so within a tier the lowest pubkey wins.
fn choose_role_holder(candidates: &RoleCandidates) -> Option<RoleHolder> {
    if let Some(row) = &candidates.provisioned {
        return Some(RoleHolder::Employee(Box::new(row.clone())));
    }
    if let Some(row) = candidates.employees.first() {
        return Some(RoleHolder::Employee(Box::new(row.clone())));
    }
    candidates
        .managed_agents
        .first()
        .cloned()
        .map(RoleHolder::ManagedAgent)
}

/// How many distinct identities could have filled the role, for the choice
/// log. The provisioned row is usually also an active employee row, so this
/// counts pubkeys rather than rows.
fn candidate_pubkeys(candidates: &RoleCandidates) -> BTreeSet<Vec<u8>> {
    let mut pubkeys = BTreeSet::new();
    if let Some(row) = &candidates.provisioned {
        pubkeys.insert(row.pubkey.clone());
    }
    for row in &candidates.employees {
        pubkeys.insert(row.pubkey.clone());
    }
    for holder in &candidates.managed_agents {
        pubkeys.insert(holder.pubkey.to_vec());
    }
    pubkeys
}

/// Resolve who fills `role_id` in this community: a provisioned employee
/// carrying `provisioned_handle` wins, else an active employee row, else an
/// owner-published managed-agent head; ties inside a tier go to the lowest
/// pubkey and a crowded choice is logged.
///
/// The managed-agent scan goes through
/// [`buzz_db::Db::query_latest_owner_authored_heads`], the same access the
/// interrupt gate uses: community-scoped, deleted heads excluded, NIP-33
/// latest-wins per `d` tag, and only heads authored by a CURRENT community
/// owner. A non-owner's head can never fill a role, and a superseded or
/// deleted head stops counting the moment a newer one lands or the delete is
/// recorded.
async fn resolve_role_holder(
    state: &AppState,
    community: CommunityId,
    role_id: &str,
    provisioned_handle: Option<&str>,
) -> anyhow::Result<Option<RoleHolder>> {
    let role_id = role_id.trim().to_ascii_lowercase();
    let mut candidates = RoleCandidates::default();

    if let Some(handle) = provisioned_handle {
        candidates.provisioned = state
            .db
            .find_provisioned_employee(community, handle)
            .await
            .with_context(|| format!("failed to look up the seeded employee `{handle}`"))?;
    }

    candidates.employees = state
        .db
        .list_active_employees_by_role(community, &role_id)
        .await
        .with_context(|| format!("failed to look up who holds role `{role_id}`"))?;

    let heads = state
        .db
        .query_latest_owner_authored_heads(
            community,
            KIND_MANAGED_AGENT as i32,
            MAX_ROLE_HOLDER_HEADS,
        )
        .await
        .context("failed to scan owner-published managed-agent heads")?;
    for stored in heads {
        if managed_agent_role(&stored.event).as_deref() != Some(role_id.as_str()) {
            continue;
        }
        let Some(pubkey) = managed_agent_pubkey(&stored.event) else {
            continue;
        };
        let tier = managed_agent_tier(&stored.event);
        candidates.managed_agents.push(ManagedAgentHolder {
            pubkey,
            event_id: stored.event.id.to_hex(),
            tier,
        });
    }
    candidates
        .managed_agents
        .sort_by_key(|holder| holder.pubkey);

    let Some(holder) = choose_role_holder(&candidates) else {
        return Ok(None);
    };
    let distinct = candidate_pubkeys(&candidates);
    if distinct.len() > 1 {
        warn!(
            community = %community,
            role = %role_id,
            pubkey = %hex::encode(holder.pubkey()),
            candidates = distinct.len(),
            "more than one candidate fills this role; using the preferred holder"
        );
    }
    Ok(Some(holder))
}

/// The role an owner-published managed-agent head claims, normalized the way
/// `employees.role_id` is stored. `None` when the content is not JSON, names
/// no role, or names one outside the role-slug grammar.
fn managed_agent_role(event: &Event) -> Option<String> {
    let content: serde_json::Value = serde_json::from_str(&event.content).ok()?;
    let raw = content.get("role_id")?.as_str()?;
    let role_id = raw.trim().to_ascii_lowercase();
    is_valid_role_slug(&role_id).then_some(role_id)
}

/// Read the owner-authored head's explicit tier. The relay cannot safely
/// infer a rank for a desktop-owned head from its role or display name; an
/// absent tier therefore leaves dependent provisioned employees unassigned
/// until the owner publishes the missing rank.
fn managed_agent_tier(event: &Event) -> Option<AgentTier> {
    let content: serde_json::Value = serde_json::from_str(&event.content).ok()?;
    content
        .get("tier")
        .and_then(serde_json::Value::as_str)
        .and_then(AgentTier::parse)
}

/// The agent an owner-published managed-agent head describes: its `d` tag,
/// which is the agent's pubkey. Managed-agent heads are keyed by the agent
/// they describe, exactly as the interrupt gate reads them.
fn managed_agent_pubkey(event: &Event) -> Option<[u8; 32]> {
    let mut d_tag: Option<&[String]> = None;
    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        if parts.first().is_none_or(|part| part != "d") {
            continue;
        }
        if parts.len() != 2 || d_tag.replace(parts).is_some() {
            return None;
        }
    }
    let hex = d_tag?.get(1)?;
    nostr::PublicKey::from_hex(hex)
        .ok()
        .map(|pubkey| pubkey.to_bytes())
}

/// The pubkey `employee` should report to, resolved the way the org chart
/// resolves a role: a provisioned employee carrying the named handle wins;
/// otherwise an active employee row, or an owner-published managed-agent head,
/// fills that handle's role. The employee and head steps are what make an
/// existing Chief of Staff -- adopted, hired, or desktop-owned -- the manager
/// of the employees reporting to that role.
///
/// A missing manager is logged and seeded as no manager rather than failing
/// the pass: the manager's own seeding may have failed, and a later pass heals
/// the edge through the ordinary update path.
async fn resolve_manager(
    state: &AppState,
    community: CommunityId,
    manifests: &[ProvisionedEmployee],
    employee: &ProvisionedEmployee,
) -> anyhow::Result<Option<Vec<u8>>> {
    let Some(manager_handle) = employee.reports_to.as_deref() else {
        return Ok(None);
    };

    let Some(role_id) = manifests
        .iter()
        .find(|entry| entry.handle == manager_handle)
        .map(|entry| entry.role_id.as_str())
    else {
        anyhow::bail!(
            "bundled employee manifest for `{}` names missing manager handle `{manager_handle}`",
            employee.handle
        );
    };
    let Some(employee_tier) = employee.tier() else {
        return Ok(None);
    };
    let expected_manager_tier = employee_tier.escalation_target();

    match resolve_role_holder(state, community, role_id, Some(manager_handle)).await? {
        Some(holder) if holder.tier() == Some(expected_manager_tier) => {
            Ok(Some(holder.pubkey().to_vec()))
        }
        Some(holder) => {
            warn!(
                community = %community,
                handle = %employee.handle,
                manager = manager_handle,
                manager_rank = holder.tier().map_or("unparseable", |tier| tier.as_str()),
                expected = expected_manager_tier.as_str(),
                "the employee holding this role is the wrong rank to be a manager; leaving the reporting line unset"
            );
            Ok(None)
        }
        None => {
            warn!(
                community = %community,
                handle = %employee.handle,
                manager = manager_handle,
                role = role_id,
                "the manager for this provisioned employee is not in place yet; seeding without one"
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
/// `manager` is the manager pubkey (32 raw bytes) the published head must
/// carry. Callers pass the manager the ROW holds after the write, not the
/// bundle's resolution alone: a bundle that names no manager leaves an
/// existing reporting line in place, and the head must carry that same edge.
///
/// Relay-authored writes bypass ingest, so this stores each event directly.
/// Failures are logged rather than returned, exactly as the hire path treats
/// its heads: the durable record of employment is the row, and a lost head is
/// republished by the next seed run.
async fn publish_records(
    state: &AppState,
    community: CommunityId,
    employee: &ProvisionedEmployee,
    manager: Option<&[u8]>,
    keys: &Keys,
) {
    let created_at = next_created_at(state, community, keys).await;
    for event in build_records(employee, manager, keys, created_at) {
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
    manager: Option<&[u8]>,
    keys: &Keys,
    created_at: nostr::Timestamp,
) -> Vec<anyhow::Result<Event>> {
    vec![
        build_profile(employee, keys, created_at),
        build_employee_head(employee, manager, keys, created_at),
        build_agent_definition(employee, manager, keys, created_at),
    ]
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
///
/// The `manager` tag is the event-side copy of the row's `manager` column.
/// `interrupt_gate::agent_manager` trusts the row, and the org chart reads the
/// tag, so both must carry the same edge or the two surfaces disagree.
fn build_employee_head(
    employee: &ProvisionedEmployee,
    manager: Option<&[u8]>,
    keys: &Keys,
    created_at: nostr::Timestamp,
) -> anyhow::Result<Event> {
    let mut tags = vec![
        Tag::parse(["d", &keys.public_key().to_hex()])?,
        Tag::parse(["role", &employee.role_id])?,
        Tag::parse(["name", &employee.display_name])?,
        Tag::parse(["rank", &employee.rank])?,
    ];
    if let Some(manager) = manager {
        tags.push(Tag::parse(["manager", &hex::encode(manager)])?);
    }
    tags.push(Tag::parse(["provisioned", &employee.handle])?);
    tags.push(Tag::parse(["version", &employee.version.to_string()])?);
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
/// owner-authored heads; the `manager` tag is the definition-side copy of the
/// same edge, matching what an owner-authored head carries.
fn build_agent_definition(
    employee: &ProvisionedEmployee,
    manager: Option<&[u8]>,
    keys: &Keys,
    created_at: nostr::Timestamp,
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
    ];
    if let Some(manager) = manager {
        tags.push(Tag::parse(["manager", &hex::encode(manager)])?);
    }
    tags.push(Tag::parse(["provisioned", &employee.handle])?);
    tags.push(Tag::parse(["version", &employee.version.to_string()])?);
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
        assert_eq!(sales.version, 2);
        assert_eq!(sales.tier(), Some(AgentTier::Leader));
        assert!(
            sales.reports_to.is_none(),
            "sales sits at the top of the chart"
        );
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
    fn the_website_team_is_bundled_with_its_reporting_lines() {
        let manifests = core_employee_manifests().expect("bundled employees must be valid");
        let by_handle = |handle: &str| {
            manifests
                .iter()
                .find(|entry| entry.handle == handle)
                .unwrap_or_else(|| panic!("{handle} is bundled"))
        };

        let chief = by_handle("chief-of-staff");
        assert_eq!(chief.display_name, "Chief of Staff");
        assert_eq!(chief.role_id, "chief-of-staff");
        assert_eq!(chief.tier(), Some(AgentTier::Executive));
        assert!(chief.reports_to.is_none(), "the chief sits at the top");
        assert_eq!(chief.version, 1);
        assert_eq!(
            chief.requires_commands,
            vec![
                "asks".to_owned(),
                "channels".to_owned(),
                "decisions".to_owned(),
                "messages".to_owned(),
            ]
        );

        let avery = by_handle("website-manager");
        assert_eq!(avery.display_name, "Avery");
        assert_eq!(avery.role_id, "website-manager");
        assert_eq!(avery.tier(), Some(AgentTier::Leader));
        assert_eq!(avery.reports_to.as_deref(), Some("chief-of-staff"));
        assert_eq!(
            avery.requires_commands,
            vec![
                "messages send".to_owned(),
                "messages thread".to_owned(),
                "tasks list".to_owned(),
                "blocks describe".to_owned(),
                "blocks invoke".to_owned(),
                "blocks actions".to_owned(),
                "blocks act".to_owned(),
                "blocks receipt".to_owned(),
                "website create".to_owned(),
                "website get".to_owned(),
                "website list".to_owned(),
                "website begin-work".to_owned(),
                "website ready".to_owned(),
                "website request-changes".to_owned(),
                "website handover".to_owned(),
            ]
        );

        for (handle, display_name, role_id) in [
            ("website-researcher", "Ren", "website-researcher"),
            (
                "website-designer-builder",
                "Jules",
                "website-designer-builder",
            ),
            ("website-reviewer", "Vera", "website-reviewer"),
        ] {
            let worker = by_handle(handle);
            assert_eq!(worker.display_name, display_name);
            assert_eq!(worker.role_id, role_id);
            assert_eq!(worker.tier(), Some(AgentTier::Worker));
            assert_eq!(worker.reports_to.as_deref(), Some("website-manager"));
            assert_eq!(worker.version, 3);
        }
    }

    #[test]
    fn a_manager_is_always_ordered_before_its_reports() {
        let manifests = core_employee_manifests().expect("bundled employees must be valid");
        let position = |handle: &str| {
            manifests
                .iter()
                .position(|entry| entry.handle == handle)
                .unwrap_or_else(|| panic!("{handle} is bundled"))
        };
        for employee in &manifests {
            if let Some(manager) = employee.reports_to.as_deref() {
                assert!(
                    position(manager) < position(&employee.handle),
                    "{} must be seeded after {manager}",
                    employee.handle
                );
            }
        }
    }

    #[test]
    fn the_records_carry_the_provisioned_tag_and_the_prompt() {
        let manifests = core_employee_manifests().expect("bundled employees must be valid");
        let sales = &manifests[0];
        let keys = Keys::generate();
        let records: Vec<Event> = build_records(sales, None, &keys, nostr::Timestamp::now())
            .into_iter()
            .map(|event| event.expect("records must build"))
            .collect();

        let head = records
            .iter()
            .find(|event| event.kind.as_u16() as u32 == KIND_EMPLOYEE)
            .expect("an employee head is published");
        assert_eq!(tag_value(head, "provisioned").as_deref(), Some("sales"));
        assert_eq!(tag_value(head, "rank").as_deref(), Some("leader"));
        // No owner hired it, so neither hire tag is present, and no manager
        // was resolved, so no manager tag is either.
        assert!(tag_value(head, "hired-by").is_none());
        assert!(tag_value(head, "e").is_none());
        assert!(tag_value(head, "manager").is_none());

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
    fn the_employee_head_carries_the_manager_it_was_resolved_to() {
        let manifests = core_employee_manifests().expect("bundled employees must be valid");
        let avery = manifests
            .iter()
            .find(|entry| entry.handle == "website-manager")
            .expect("the website manager is bundled");
        let manager = Keys::generate();
        let keys = Keys::generate();
        let manager_bytes = manager.public_key().to_bytes();
        let manager_hex = manager.public_key().to_hex();
        let created_at = nostr::Timestamp::now();

        let records: Vec<Event> = build_records(avery, Some(&manager_bytes), &keys, created_at)
            .into_iter()
            .map(|event| event.expect("records must build"))
            .collect();
        let head = records
            .iter()
            .find(|event| event.kind.as_u16() as u32 == KIND_EMPLOYEE)
            .expect("an employee head is published");
        assert_eq!(
            tag_value(head, "manager").as_deref(),
            Some(manager_hex.as_str())
        );
        let definition = records
            .iter()
            .find(|event| event.kind.as_u16() as u32 == KIND_MANAGED_AGENT)
            .expect("an agent definition is published");
        assert_eq!(
            tag_value(definition, "manager").as_deref(),
            Some(manager_hex.as_str())
        );
    }

    /// One manifest with only the fields a reporting-line test reads, so the
    /// validation and ordering helpers can be exercised without the bundle.
    fn manifest(handle: &str, reports_to: Option<&str>) -> ProvisionedEmployee {
        ProvisionedEmployee {
            schema: EMPLOYEE_SCHEMA.to_owned(),
            handle: handle.to_owned(),
            version: 1,
            display_name: handle.to_owned(),
            role_id: handle.to_owned(),
            rank: "worker".to_owned(),
            reports_to: reports_to.map(str::to_owned),
            harness: "claude".to_owned(),
            model: None,
            summary: "test".to_owned(),
            requires_commands: Vec::new(),
            prompt: "test".to_owned(),
        }
    }

    #[test]
    fn an_unknown_reports_to_is_refused() {
        let error = validate_reporting_lines(&[manifest("a", Some("nobody"))])
            .expect_err("an unknown manager must be refused");
        assert!(error.to_string().contains("nobody"));
    }

    #[test]
    fn a_manager_of_the_wrong_rank_is_refused() {
        let mut worker = manifest("worker", Some("executive"));
        worker.rank = "worker".to_owned();
        let mut executive = manifest("executive", None);
        executive.rank = "executive".to_owned();
        let error = validate_reporting_lines(&[worker, executive])
            .expect_err("a worker cannot report directly to an executive");
        assert!(error.to_string().contains("requires a `leader` manager"));
    }

    #[test]
    fn a_reporting_line_cycle_is_refused() {
        let cycle = vec![manifest("a", Some("b")), manifest("b", Some("a"))];
        let error = sort_by_reporting_line(cycle).expect_err("a cycle must be refused");
        assert!(error.to_string().contains("cycle"));
    }

    #[test]
    fn reports_are_ordered_after_their_manager() {
        let lines = vec![
            manifest("worker", Some("leader")),
            manifest("leader", Some("executive")),
            manifest("executive", None),
        ];
        let ordered = sort_by_reporting_line(lines).expect("acyclic reporting lines sort");
        let handles: Vec<&str> = ordered
            .iter()
            .map(|employee| employee.handle.as_str())
            .collect();
        assert_eq!(handles, vec!["executive", "leader", "worker"]);
    }

    /// One employee row with only the fields role resolution reads.
    fn employee_row(pubkey: [u8; 32], handle: Option<&str>) -> buzz_db::employees::EmployeeRow {
        buzz_db::employees::EmployeeRow {
            pubkey: pubkey.to_vec(),
            sealed_key: vec![0; 32],
            role_id: "chief-of-staff".to_owned(),
            display_name: "Fizz".to_owned(),
            rank: "executive".to_owned(),
            hired_by: None,
            hire_event: None,
            manager: None,
            provisioned_handle: handle.map(str::to_owned),
            provisioned_version: handle.map(|_| 1),
            status: "active".to_owned(),
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn role_holders_are_chosen_in_the_contract_order() {
        let provisioned = employee_row([1; 32], Some("chief-of-staff"));
        let employee = employee_row([2; 32], None);
        let head = ManagedAgentHolder {
            pubkey: [3; 32],
            event_id: "cc".repeat(32),
            tier: Some(AgentTier::Executive),
        };

        let head_only = RoleCandidates {
            provisioned: None,
            employees: Vec::new(),
            managed_agents: vec![head.clone()],
        };
        assert_eq!(
            choose_role_holder(&head_only),
            Some(RoleHolder::ManagedAgent(head.clone()))
        );

        let row_and_head = RoleCandidates {
            provisioned: None,
            employees: vec![employee.clone()],
            managed_agents: vec![head.clone()],
        };
        assert_eq!(
            choose_role_holder(&row_and_head),
            Some(RoleHolder::Employee(Box::new(employee.clone())))
        );

        let everything = RoleCandidates {
            provisioned: Some(provisioned.clone()),
            employees: vec![employee],
            managed_agents: vec![head],
        };
        assert_eq!(
            choose_role_holder(&everything),
            Some(RoleHolder::Employee(Box::new(provisioned)))
        );
    }

    #[test]
    fn a_managed_agent_head_names_only_a_valid_normalized_role() {
        let keys = Keys::generate();
        let head = |content: serde_json::Value| {
            EventBuilder::new(Kind::Custom(KIND_MANAGED_AGENT as u16), content.to_string())
                .sign_with_keys(&keys)
                .expect("sign the head")
        };

        let mixed_case = head(serde_json::json!({ "role_id": " Chief-Of-Staff " }));
        assert_eq!(
            managed_agent_role(&mixed_case).as_deref(),
            Some("chief-of-staff")
        );
        assert!(managed_agent_role(&head(serde_json::json!({ "name": "Fizz" }))).is_none());
        let bad_slug = head(serde_json::json!({ "role_id": "chief of staff" }));
        assert!(
            managed_agent_role(&bad_slug).is_none(),
            "a role outside the slug grammar names nothing"
        );
    }

    #[test]
    fn a_managed_agent_head_identifies_its_agent_through_the_d_tag() {
        let owner = Keys::generate();
        let subject = Keys::generate();
        let event = EventBuilder::new(Kind::Custom(KIND_MANAGED_AGENT as u16), "{}")
            .tags(vec![
                Tag::parse(["d", &subject.public_key().to_hex()]).expect("d tag")
            ])
            .sign_with_keys(&owner)
            .expect("sign the head");
        assert_eq!(
            managed_agent_pubkey(&event),
            Some(subject.public_key().to_bytes())
        );

        let unnamed = EventBuilder::new(Kind::Custom(KIND_MANAGED_AGENT as u16), "{}")
            .sign_with_keys(&owner)
            .expect("sign the head");
        assert_eq!(managed_agent_pubkey(&unnamed), None);

        let duplicate = EventBuilder::new(Kind::Custom(KIND_MANAGED_AGENT as u16), "{}")
            .tags(vec![
                Tag::parse(["d", &subject.public_key().to_hex()]).expect("d tag"),
                Tag::parse(["d", &subject.public_key().to_hex()]).expect("duplicate d tag"),
            ])
            .sign_with_keys(&owner)
            .expect("sign the head");
        assert_eq!(
            managed_agent_pubkey(&duplicate),
            None,
            "a duplicate d tag cannot identify a manager head"
        );
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
