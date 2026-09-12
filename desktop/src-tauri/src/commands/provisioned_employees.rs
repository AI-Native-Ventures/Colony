//! Taking custody of the employees Colony provides, so this machine runs them.
//!
//! The relay mints a provisioned employee and holds its key sealed. This is
//! the command that recognises one, asks the relay for that key, and writes
//! the managed-agent record the ordinary spawn path already knows how to
//! run. Everything about recognising it, and about refusing a brief this
//! build's CLI cannot serve, lives in
//! [`crate::managed_agents::provisioned`]; this module is the wiring.
//!
//! An employee whose handle belongs to one of this build's packs also gets
//! that pack's runbooks placed in the shared agent workspace it will run
//! from, so the skills are simply there before anyone starts it.
//!
//! Adoption is idempotent and safe to call on every community init. A record
//! already holding the current bundled version is left alone, so the cost of
//! calling it again is one relay query.

use std::collections::BTreeSet;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::app_state::AppState;
use crate::managed_agents::provisioned::{
    missing_commands, missing_commands_message, trusted_provisioned_definitions,
    ProvisionedDefinition,
};
use crate::managed_agents::website_team::{
    install_recipe_skills, owns_provisioned_handle, InstalledWebsiteSkill,
};
use crate::managed_agents::{
    storage::{load_managed_agents, save_managed_agents},
    ManagedAgentRecord, DEFAULT_ACP_COMMAND,
};
use buzz_core_pkg::kind::{KIND_EMPLOYEE, KIND_MANAGED_AGENT};

/// What adoption did for one employee, so the caller can say which.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum AdoptionOutcome {
    /// A record was written and this machine can now run the employee.
    Adopted {
        handle: String,
        name: String,
        pubkey: String,
        /// Per-skill failures from placing this build's pack runbooks in the
        /// workspace. Empty when this handle is not one of our packs, or when
        /// every skill landed. Never a reason the adoption itself failed.
        #[serde(skip_serializing_if = "Vec::is_empty")]
        skill_failures: Vec<InstalledWebsiteSkill>,
    },
    /// The record already holds this bundled version. Nothing was written.
    Unchanged {
        handle: String,
        pubkey: String,
        /// Per-skill failures from placing this build's pack runbooks in the
        /// workspace, same shape as the `Adopted` arm. Present even on an
        /// unchanged employee so an app update can add runbooks that were
        /// never installed, without rewriting the employee.
        #[serde(skip_serializing_if = "Vec::is_empty")]
        skill_failures: Vec<InstalledWebsiteSkill>,
    },
    /// The brief names a command this build's `buzz` does not have. The
    /// employee is deliberately absent rather than started and improvising.
    Refused { handle: String, reason: String },
    /// Something went wrong for this one employee. Reported rather than
    /// returned as an error, so one bad entry cannot hide the others.
    Failed { handle: String, reason: String },
}

/// How many heads one adoption pass will look at. A workspace has a handful
/// of employees and this kind is replaceable, so the cap only bounds a
/// pathological relay.
const MAX_HEADS: usize = 200;

/// Adopt every provisioned employee this community proves, writing a
/// managed-agent record for each so the ordinary spawn path can run it.
///
/// Never fails as a whole for one employee's sake: each entry reports its own
/// outcome, because an owner with two provisioned employees should not lose
/// the working one to the broken one.
///
/// An employee whose handle belongs to one of this build's packs also gets
/// that pack's runbooks placed in the shared agent workspace it will run from.
/// A skill that cannot be written is reported per skill on the outcome and
/// never fails the employee's adoption.
#[tauri::command]
pub async fn adopt_provisioned_employees(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<AdoptionOutcome>, String> {
    let signer = state.signing_keys()?;
    let api_base = crate::relay::relay_api_base_url_with_override(&state);
    let relay_ws = crate::relay::relay_ws_url_with_override(&state);

    let filters = vec![serde_json::json!({
        "kinds": [KIND_MANAGED_AGENT, KIND_EMPLOYEE],
        "limit": MAX_HEADS,
    })];
    let events =
        crate::relay::query_relay_at_with_keys(&state, &api_base, &filters, &signer, None).await?;

    let definitions = trusted_provisioned_definitions(&events);
    if definitions.is_empty() {
        return Ok(Vec::new());
    }

    let required: Vec<String> = definitions
        .iter()
        .flat_map(|definition| definition.requires_commands.iter().cloned())
        .collect();
    let available = available_cli_commands(&required);
    let owner_hex = signer.public_key().to_hex();
    let mut outcomes = Vec::with_capacity(definitions.len());
    // Placed lazily, once, on the first pack-owned employee that is adopted or
    // confirmed: the four share one workspace, so four passes over the same
    // six files would do the same work four times.
    let mut pack_skill_failures: Option<Vec<InstalledWebsiteSkill>> = None;

    for definition in definitions {
        let mut outcome = match adopt_one(
            &app,
            &state,
            &signer,
            &api_base,
            &relay_ws,
            &owner_hex,
            &available,
            &definition,
        )
        .await
        {
            Ok(outcome) => outcome,
            Err(reason) => AdoptionOutcome::Failed {
                handle: definition.handle.clone(),
                reason,
            },
        };

        if owns_provisioned_handle(&definition.handle) {
            if let AdoptionOutcome::Adopted { skill_failures, .. }
            | AdoptionOutcome::Unchanged { skill_failures, .. } = &mut outcome
            {
                let failures = pack_skill_failures.get_or_insert_with(install_pack_skills);
                skill_failures.extend(failures.iter().cloned());
            }
        }
        outcomes.push(outcome);
    }

    Ok(outcomes)
}

/// Put this build's pack runbooks in the workspace these employees run from.
///
/// Idempotent and edit-preserving: a file the owner edited is never
/// overwritten, a file this app last wrote is upgraded when the bundled
/// version changes, and an already-current file is left alone. Only failures
/// are returned, so a caller can surface a per-skill problem without treating
/// it as a failed adoption.
fn install_pack_skills() -> Vec<InstalledWebsiteSkill> {
    let Some(root) = crate::managed_agents::nest_dir() else {
        return vec![InstalledWebsiteSkill {
            name: "website-manager".to_owned(),
            path: String::new(),
            status: "failed".to_owned(),
            detail: Some("the agent workspace could not be resolved".to_owned()),
        }];
    };
    install_pack_skills_at(&root)
}

/// [`install_pack_skills`] against an explicit root, so the placement is
/// testable without a nest.
fn install_pack_skills_at(root: &std::path::Path) -> Vec<InstalledWebsiteSkill> {
    install_recipe_skills(root)
        .into_iter()
        .filter(|skill| skill.status == "failed")
        .collect()
}

/// Adopt one employee: decide whether anything is needed, refuse a brief this
/// build cannot serve, then fetch the key and write the record.
#[allow(clippy::too_many_arguments)]
async fn adopt_one(
    app: &AppHandle,
    state: &AppState,
    signer: &nostr::Keys,
    api_base: &str,
    relay_ws: &str,
    owner_hex: &str,
    available: &BTreeSet<String>,
    definition: &ProvisionedDefinition,
) -> Result<AdoptionOutcome, String> {
    let existing = load_managed_agents(app)?;
    if existing.iter().any(|record| {
        record.pubkey.eq_ignore_ascii_case(&definition.pubkey)
            && record.provisioned_version.unwrap_or(-1) >= definition.version
    }) {
        return Ok(AdoptionOutcome::Unchanged {
            handle: definition.handle.clone(),
            pubkey: definition.pubkey.clone(),
            skill_failures: Vec::new(),
        });
    }

    // Checked BEFORE the key is fetched. An employee this build cannot serve
    // should not leave a key on the machine as a souvenir.
    let missing = missing_commands(&definition.requires_commands, available);
    if !missing.is_empty() {
        return Ok(AdoptionOutcome::Refused {
            handle: definition.handle.clone(),
            reason: missing_commands_message(&definition.name, &missing),
        });
    }

    let nsec = fetch_employee_key(state, signer, api_base, definition).await?;

    let mut records = load_managed_agents(app)?;
    records.retain(|record| !record.pubkey.eq_ignore_ascii_case(&definition.pubkey));
    records.push(record_for(definition, &nsec, relay_ws, owner_hex));
    save_managed_agents(app, &records)?;

    Ok(AdoptionOutcome::Adopted {
        handle: definition.handle.clone(),
        name: definition.name.clone(),
        pubkey: definition.pubkey.clone(),
        skill_failures: Vec::new(),
    })
}

/// Ask the relay for this employee's runtime key.
///
/// The relay authorises the request against the signing identity, so a
/// member who is not an owner or admin gets a refusal here rather than a
/// record that cannot start.
async fn fetch_employee_key(
    state: &AppState,
    signer: &nostr::Keys,
    api_base: &str,
    definition: &ProvisionedDefinition,
) -> Result<String, String> {
    let url = format!(
        "{api_base}/api/provisioned-employees/{}/key",
        definition.handle
    );
    #[cfg(feature = "onboarding-fixture")]
    crate::relay::validate_fixture_url(&url)?;
    let auth =
        crate::relay::build_nip98_auth_header_for_keys(signer, &reqwest::Method::POST, &url, &[])?;

    let response = state
        .http_client
        .post(&url)
        .header("Authorization", auth)
        .send()
        .await
        .map_err(|error| format!("relay unreachable: {error}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let detail = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or(body);
        return Err(format!("the relay refused the key ({status}): {detail}"));
    }

    let payload: serde_json::Value = serde_json::from_str(&body)
        .map_err(|error| format!("the relay's answer was not JSON: {error}"))?;

    // The relay is the authority on which key belongs to which employee, but
    // a mismatch here would mean writing a record that signs as somebody
    // else, so it is checked rather than trusted.
    let returned_pubkey = payload
        .get("pubkey")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if returned_pubkey != definition.pubkey {
        return Err(
            "the relay returned a key for a different employee than the one requested".to_owned(),
        );
    }

    payload
        .get("nsec")
        .and_then(serde_json::Value::as_str)
        .filter(|nsec| !nsec.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "the relay's answer carried no key".to_owned())
}

/// The managed-agent record for one provisioned employee.
///
/// Deliberately built from the definition rather than from local input: the
/// brief, the harness and the model are Colony's to set, and a field taken
/// from anywhere else here would be a quiet local fork of an employee that is
/// supposed to be identical everywhere.
fn record_for(
    definition: &ProvisionedDefinition,
    nsec: &str,
    relay_ws: &str,
    owner_hex: &str,
) -> ManagedAgentRecord {
    let agent_command = crate::managed_agents::known_acp_runtime_exact(&definition.harness)
        .and_then(|runtime| runtime.commands.first().copied())
        .unwrap_or(definition.harness.as_str())
        .to_owned();

    ManagedAgentRecord {
        provisioned: Some(definition.handle.clone()),
        provisioned_version: Some(definition.version),
        provisioned_requires_commands: definition.requires_commands.clone(),
        pubkey: definition.pubkey.clone(),
        name: definition.name.clone(),
        role_id: (!definition.role_id.is_empty()).then(|| definition.role_id.clone()),
        private_key_nsec: nsec.to_owned(),
        relay_url: relay_ws.to_owned(),
        owner_pubkey: Some(owner_hex.to_owned()),
        acp_command: DEFAULT_ACP_COMMAND.to_owned(),
        agent_command: agent_command.clone(),
        agent_command_override: Some(agent_command),
        system_prompt: (!definition.system_prompt.is_empty())
            .then(|| definition.system_prompt.clone()),
        model: definition.model.clone(),
        ..ManagedAgentRecord::default()
    }
}

/// The subcommands the `buzz` this build ships actually has, for the commands
/// `required` names.
///
/// `buzz --help` only advertises top-level commands, and a brief may name a
/// two-level path (`website create`). Every group a brief reaches into is
/// asked for its own help once, so the check reflects this binary's real
/// surface instead of reading every subcommand as present. An empty set means
/// the CLI could not be found or asked, which reads as "no commands
/// available" and therefore refuses every brief that requires one. That is
/// the safe direction: absent beats started and improvising.
pub(crate) fn available_cli_commands(required: &[String]) -> BTreeSet<String> {
    let Some(path) = crate::managed_agents::resolve_command("buzz") else {
        return BTreeSet::new();
    };
    let mut commands = parse_help(&path, None);
    for group in required_groups(&commands, required) {
        for subcommand in parse_help(&path, Some(group.as_str())) {
            commands.insert(format!("{group} {subcommand}"));
        }
    }
    commands
}

/// The command groups a brief reaches into that this build actually has.
///
/// A group the binary does not advertise is left out rather than probed, so
/// the required command stays missing and the refusal names it.
fn required_groups(available: &BTreeSet<String>, required: &[String]) -> BTreeSet<String> {
    let mut groups = BTreeSet::new();
    for command in required {
        let mut parts = command.split_whitespace();
        let (Some(group), Some(_subcommand)) = (parts.next(), parts.next()) else {
            continue;
        };
        let group = group.to_ascii_lowercase();
        if available.contains(&group) {
            groups.insert(group);
        }
    }
    groups
}

/// Ask one `buzz` command for its help text and parse its subcommands.
fn parse_help(path: &std::path::Path, group: Option<&str>) -> BTreeSet<String> {
    let mut command = std::process::Command::new(path);
    if let Some(group) = group {
        command.arg(group);
    }
    let Ok(output) = command.arg("--help").output() else {
        return BTreeSet::new();
    };
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    // Clap writes help to stderr for some error paths; read both rather than
    // concluding a CLI has no commands because it chose the other stream.
    text.push('\n');
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    crate::managed_agents::provisioned::parse_available_commands(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn definition() -> ProvisionedDefinition {
        ProvisionedDefinition {
            pubkey: "a".repeat(64),
            handle: "sales".to_owned(),
            version: 2,
            name: "Sales".to_owned(),
            role_id: "sales".to_owned(),
            harness: "claude".to_owned(),
            model: None,
            system_prompt: "You are Sales.".to_owned(),
            requires_commands: vec!["outreach".to_owned()],
        }
    }

    #[test]
    fn the_record_carries_the_definition_rather_than_local_choices() {
        let record = record_for(
            &definition(),
            "nsec1test",
            "wss://relay.example",
            &"b".repeat(64),
        );
        assert_eq!(record.provisioned.as_deref(), Some("sales"));
        assert_eq!(record.provisioned_version, Some(2));
        assert_eq!(record.provisioned_requires_commands, vec!["outreach"]);
        assert_eq!(record.pubkey, "a".repeat(64));
        assert_eq!(record.name, "Sales");
        assert_eq!(record.system_prompt.as_deref(), Some("You are Sales."));
        assert_eq!(record.relay_url, "wss://relay.example");
        assert_eq!(
            record.owner_pubkey.as_deref(),
            Some("b".repeat(64).as_str())
        );
        assert_eq!(record.acp_command, DEFAULT_ACP_COMMAND);
        // The harness id resolves to the command that actually runs it, and
        // is pinned per instance so a persona edit cannot silently move a
        // provisioned employee onto another harness.
        assert!(!record.agent_command.is_empty());
        assert_eq!(
            record.agent_command_override.as_deref(),
            Some(record.agent_command.as_str())
        );
    }

    #[test]
    fn an_unknown_harness_falls_back_to_its_own_name() {
        let mut unknown = definition();
        unknown.harness = "not-a-harness".to_owned();
        let record = record_for(
            &unknown,
            "nsec1test",
            "wss://relay.example",
            &"b".repeat(64),
        );
        assert_eq!(record.agent_command, "not-a-harness");
    }

    #[test]
    fn skill_failures_ride_the_outcome_and_an_empty_list_stays_off_the_wire() {
        let adopted = AdoptionOutcome::Adopted {
            handle: "sales".to_owned(),
            name: "Sales".to_owned(),
            pubkey: "a".repeat(64),
            skill_failures: Vec::new(),
        };
        let json = serde_json::to_value(&adopted).expect("outcome serializes");
        assert!(json.get("skill_failures").is_none());

        let failed = AdoptionOutcome::Adopted {
            handle: "website-manager".to_owned(),
            name: "Avery".to_owned(),
            pubkey: "a".repeat(64),
            skill_failures: vec![InstalledWebsiteSkill {
                name: "website-research".to_owned(),
                path: "/tmp/website-research/SKILL.md".to_owned(),
                status: "failed".to_owned(),
                detail: Some("create dir: permission denied".to_owned()),
            }],
        };
        let json = serde_json::to_value(&failed).expect("outcome serializes");
        assert_eq!(json["outcome"], "adopted");
        assert_eq!(json["skill_failures"][0]["name"], "website-research");
        assert_eq!(json["skill_failures"][0]["status"], "failed");
        assert_eq!(
            json["skill_failures"][0]["detail"],
            "create dir: permission denied"
        );
    }

    #[test]
    fn only_groups_this_build_advertises_are_probed_for_subcommands() {
        let available: BTreeSet<String> = ["website", "messages"]
            .into_iter()
            .map(str::to_owned)
            .collect();
        let required = vec![
            "website create".to_owned(),
            "messages".to_owned(),
            "sales outreach".to_owned(),
        ];
        let groups = required_groups(&available, &required);
        assert_eq!(groups, ["website".to_owned()].into_iter().collect());
    }

    #[test]
    fn pack_skills_land_in_the_workspace_and_a_user_edit_survives() {
        let root = tempfile::tempdir().expect("tempdir");
        assert!(
            install_pack_skills_at(root.path()).is_empty(),
            "the first pass lands every skill without a failure"
        );
        let skill = root.path().join(".agents/skills/website-research/SKILL.md");
        assert!(skill.exists(), "the runbook is written to the workspace");

        std::fs::write(&skill, "my edited runbook").expect("write user edit");
        assert!(
            install_pack_skills_at(root.path()).is_empty(),
            "a preserved edit is not a failure"
        );
        assert_eq!(
            std::fs::read_to_string(&skill).expect("read back"),
            "my edited runbook",
            "a user's edit is never overwritten"
        );
    }
}
