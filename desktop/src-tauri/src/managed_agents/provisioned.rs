//! Adopting the employees Colony provides, so this machine can run one.
//!
//! A provisioned employee is minted on the relay: its identity, its brief and
//! its place in the org all exist before any desktop sees it. What a desktop
//! has to do is recognise it, take custody of its key, and run it like any
//! other managed agent.
//!
//! **Recognising it.** An employee Colony provides has no owner-authored
//! kind-30177 definition and never will, because the relay mints these and
//! signs them with the EMPLOYEE's own key rather than its own. That signature
//! is the proof: only the relay can open an employee's sealed key, so a
//! definition whose author IS the agent it describes could only have come
//! from the relay. [`trusted_provisioned_definitions`] requires three things
//! to line up, and each closes a different hole:
//!
//! 1. the definition's author equals its own `d` tag, because anyone may
//!    publish a head ABOUT an agent and only the key holder may publish one
//!    AS it;
//! 2. the definition carries a `provisioned` tag, so an ordinary
//!    self-published head still names nothing;
//! 3. the kind-30190 employee head at that same pubkey ALSO carries a
//!    `provisioned` tag. Ingest refuses an employee head from anyone who is
//!    not an employee of the community, so that is a second independent
//!    record only the relay could have minted. Requiring the tag on both,
//!    rather than merely that some employee head exists, means an employee
//!    the workspace hired itself can never be read as one Colony provides.
//!
//! This mirrors `trustedManagedAgentHeads` in
//! `desktop/src/features/agents/managedAgentHeads.ts` step for step.
//!
//! **Refusing to launch a broken one.** An employee runs the `buzz` that
//! ships inside this app, and a brief naming a command that binary does not
//! have is broken on arrival: the agent improvises something adjacent and
//! produces work nobody can act on. So the manifest declares its command
//! surface in `requires_commands`, and [`missing_commands`] is what stands
//! between a version skew and an employee that starts and guesses. An
//! employee that stays absent until the app catches up is the better failure.

use std::collections::BTreeSet;

use nostr::Event;
use serde::{Deserialize, Serialize};

use buzz_core_pkg::kind::{KIND_EMPLOYEE, KIND_MANAGED_AGENT};

/// One employee Colony provides, as the relay describes it.
///
/// Everything here comes off the kind-30177 definition. Fields the definition
/// does not carry are left empty rather than guessed: a missing harness is a
/// definition this build cannot run, not one to improvise around.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProvisionedDefinition {
    /// The agent's identity pubkey (lowercase hex), from the `d` tag.
    pub pubkey: String,
    /// The bundled entry this was provisioned from, e.g. `sales`.
    pub handle: String,
    /// The bundled version that last wrote it.
    pub version: i64,
    /// The name this employee goes by in chat.
    pub name: String,
    /// The role slug it fills.
    pub role_id: String,
    /// The signed interrupt hierarchy tier, when the definition carries one.
    ///
    /// Older relay definitions may not include this field. That absence is
    /// retained as absence: adoption must never guess a tier from a role or
    /// from a local record.
    pub tier: Option<String>,
    /// The signed pubkey of this employee's manager, when one is declared on
    /// the definition. Invalid or ambiguous manager tags make the definition
    /// untrusted rather than turning them into an unassigned employee.
    pub manager: Option<String>,
    /// The agent harness that runs it, by catalog id.
    pub harness: String,
    /// The model to pin, or `None` to let the harness choose.
    pub model: Option<String>,
    /// The persona prompt: the employee's whole brief.
    pub system_prompt: String,
    /// Top-level `buzz` subcommands the brief tells it to use.
    pub requires_commands: Vec<String>,
}

/// The value of the single tag named `name`, or `None` when it is absent or
/// appears more than once.
///
/// Duplicates resolve to nothing rather than to the first match, mirroring
/// the relay's own fail-closed `event_single_tag`: two conflicting claims are
/// no claim.
fn single_tag(event: &Event, name: &str) -> Option<String> {
    let mut found = None;
    for tag in event.tags.iter() {
        if tag.kind().to_string() != name {
            continue;
        }
        if found.is_some() {
            return None;
        }
        found = tag.content().map(str::to_owned);
    }
    found
}

/// The pubkeys whose kind-30190 employee head says they are provisioned.
///
/// This is condition 3 of the trust rule, gathered once so the definition
/// scan is a lookup rather than a second pass over every event.
fn provisioned_employee_pubkeys(events: &[Event]) -> BTreeSet<String> {
    events
        .iter()
        .filter(|event| u32::from(event.kind.as_u16()) == KIND_EMPLOYEE)
        .filter(|event| {
            single_tag(event, "provisioned").is_some_and(|handle| !handle.trim().is_empty())
        })
        .filter_map(|event| single_tag(event, "d"))
        .map(|pubkey| pubkey.trim().to_ascii_lowercase())
        .filter(|pubkey| is_hex64(pubkey))
        .collect()
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Read the optional manager tag without treating a malformed claim as an
/// absent one.
///
/// `Some(None)` means the event has no manager tag. `None` means a manager tag
/// was present but had no valid, unique 64-character hex value, or that more
/// than one manager tag was present. The caller drops the whole definition in
/// that case, preserving the signed-definition trust boundary.
fn optional_manager_tag(event: &Event) -> Option<Option<String>> {
    let mut values = event
        .tags
        .iter()
        .filter(|tag| tag.kind().to_string() == "manager")
        .map(|tag| tag.content());
    match (values.next(), values.next()) {
        (None, None) => Some(None),
        (Some(Some(value)), None) => {
            let value = value.trim().to_ascii_lowercase();
            is_hex64(&value).then_some(Some(value))
        }
        _ => None,
    }
}

/// Parse one kind-30177 event into a definition, if it is one.
///
/// Returns `None` for anything malformed rather than failing the whole read:
/// a stray event must not hide a real employee.
fn parse_definition(event: &Event) -> Option<ProvisionedDefinition> {
    if u32::from(event.kind.as_u16()) != KIND_MANAGED_AGENT {
        return None;
    }
    let pubkey = single_tag(event, "d")?.trim().to_ascii_lowercase();
    if !is_hex64(&pubkey) {
        return None;
    }
    let handle = single_tag(event, "provisioned")?.trim().to_owned();
    if handle.is_empty() {
        return None;
    }

    let content: serde_json::Value = serde_json::from_str(&event.content).ok()?;
    let text = |key: &str| -> String {
        content
            .get(key)
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_owned()
    };
    let tier = match content.get("tier") {
        None => None,
        Some(value) => {
            let tier = value.as_str()?.trim();
            if !matches!(tier, "worker" | "leader" | "executive") {
                return None;
            }
            Some(tier.to_owned())
        }
    };
    let manager = optional_manager_tag(event)?;

    Some(ProvisionedDefinition {
        pubkey,
        handle,
        version: content
            .get("version")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0),
        name: text("name"),
        role_id: text("role_id"),
        tier,
        manager,
        harness: text("harness"),
        model: content
            .get("model")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|model| !model.is_empty())
            .map(str::to_owned),
        system_prompt: text("system_prompt"),
        requires_commands: content
            .get("requires_commands")
            .and_then(serde_json::Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|command| !command.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
    })
}

/// Every provisioned employee `events` proves, newest definition per agent.
///
/// `events` is the raw mix of kind-30177 definitions and kind-30190 employee
/// heads as the relay returned them. Anything that does not satisfy all three
/// conditions in this module's documentation is dropped silently, because an
/// untrustworthy head is not an error to report, it is simply not evidence.
pub fn trusted_provisioned_definitions(events: &[Event]) -> Vec<ProvisionedDefinition> {
    let provisioned = provisioned_employee_pubkeys(events);

    let mut newest: std::collections::BTreeMap<String, (u64, ProvisionedDefinition)> =
        std::collections::BTreeMap::new();
    for event in events {
        let Some(definition) = parse_definition(event) else {
            continue;
        };
        // Condition 1: signed AS the agent, not merely about it.
        if event.pubkey.to_hex().to_ascii_lowercase() != definition.pubkey {
            continue;
        }
        // Condition 3: corroborated by a provisioned employee head.
        if !provisioned.contains(&definition.pubkey) {
            continue;
        }
        let created_at = event.created_at.as_secs();
        newest
            .entry(definition.pubkey.clone())
            .and_modify(|held| {
                if created_at > held.0 {
                    *held = (created_at, definition.clone());
                }
            })
            .or_insert((created_at, definition));
    }

    newest
        .into_values()
        .map(|(_, definition)| definition)
        .collect()
}

/// The commands a definition needs that this build's `buzz` does not have.
///
/// Compared case-insensitively against the subcommand names, and order is
/// preserved so the message names them the way the brief does. An empty
/// result means the employee can be launched.
pub fn missing_commands(required: &[String], available: &BTreeSet<String>) -> Vec<String> {
    required
        .iter()
        .map(|command| command.trim().to_ascii_lowercase())
        .filter(|command| !command.is_empty() && !available.contains(command))
        .collect()
}

/// The refusal an owner sees when this build's CLI cannot serve the brief.
///
/// Names the employee and every missing command, because the useful question
/// after "why is Sales not here" is "what do I need", and an error that says
/// only "unsupported" sends somebody reading source.
pub fn missing_commands_message(name: &str, missing: &[String]) -> String {
    let commands = missing
        .iter()
        .map(|command| format!("`buzz {command}`"))
        .collect::<Vec<_>>()
        .join(", ");
    let subject = if name.trim().is_empty() {
        "This employee"
    } else {
        name
    };
    format!(
        "{subject} needs {commands}, which this version of the app does not have. \
         It will appear once the app is updated."
    )
}

/// Why an employee Colony provides cannot be deleted here.
///
/// Names the employee and says who provides it, because the person reading it
/// did nothing wrong: removing an agent is an ordinary thing to try, and this
/// one simply is not theirs to remove. It also says what would happen anyway,
/// since "you cannot" invites "why not" and the honest answer is that the
/// delete could not stick.
pub fn provisioned_delete_refusal(name: &str, handle: &str) -> String {
    let subject = display_subject(name, handle);
    format!(
        "{subject} is provided by Colony and cannot be deleted.          Removing it here would only drop this machine's copy; the employee          stays on the relay and would be set up again automatically."
    )
}

/// Why an employee Colony provides cannot be edited here.
pub fn provisioned_edit_refusal(name: &str, handle: &str) -> String {
    let subject = display_subject(name, handle);
    format!(
        "{subject} is provided by Colony and cannot be changed.          Colony maintains it, and it updates itself when a newer version ships."
    )
}

/// Refuse an edit when `record` is an employee Colony provides.
///
/// One helper rather than the check written out at each call site, because
/// the two commands that need it live in different modules and a guard that
/// is copied is a guard that drifts.
pub fn refuse_edit_if_provisioned(record: &super::ManagedAgentRecord) -> Result<(), String> {
    match record.provisioned.as_deref() {
        Some(handle) => Err(provisioned_edit_refusal(&record.name, handle)),
        None => Ok(()),
    }
}

/// Refuse a delete when `record` is an employee Colony provides.
pub fn refuse_delete_if_provisioned(record: &super::ManagedAgentRecord) -> Result<(), String> {
    match record.provisioned.as_deref() {
        Some(handle) => Err(provisioned_delete_refusal(&record.name, handle)),
        None => Ok(()),
    }
}

/// The employee's name, falling back to its handle, then to a generic phrase.
///
/// A record with an empty name is not worth a message reading "` ` is provided
/// by Colony".
fn display_subject(name: &str, handle: &str) -> String {
    let name = name.trim();
    if !name.is_empty() {
        return name.to_owned();
    }
    let handle = handle.trim();
    if !handle.is_empty() {
        return handle.to_owned();
    }
    "This employee".to_owned()
}

/// The top-level subcommands `buzz --help` advertises.
///
/// Parsed from the help text rather than probed one command at a time: one
/// process instead of one per command, and it reflects exactly what this
/// binary supports rather than what an exit code happens to mean.
pub fn parse_available_commands(help_text: &str) -> BTreeSet<String> {
    let mut commands = BTreeSet::new();
    let mut in_commands = false;
    for line in help_text.lines() {
        let trimmed = line.trim();
        if trimmed.eq_ignore_ascii_case("commands:") || trimmed.eq_ignore_ascii_case("subcommands:")
        {
            in_commands = true;
            continue;
        }
        if !in_commands {
            continue;
        }
        // A blank line, or a line starting a new unindented section, ends the
        // command list.
        if trimmed.is_empty() {
            continue;
        }
        if !line.starts_with(' ') && !line.starts_with('\t') {
            break;
        }
        let Some(word) = trimmed.split_whitespace().next() else {
            continue;
        };
        // Clap lists flags in the same block shape; only subcommands count.
        if word.starts_with('-') {
            continue;
        }
        if word
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            commands.insert(word.to_ascii_lowercase());
        }
    }
    commands
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    fn definition_content(handle: &str) -> String {
        definition_content_with_tier(handle, "leader")
    }

    fn definition_content_with_tier(handle: &str, tier: &str) -> String {
        serde_json::json!({
            "name": "Sales",
            "role_id": "sales",
            "tier": tier,
            "harness": "claude",
            "model": null,
            "system_prompt": "You are Sales.",
            "provisioned": handle,
            "version": 2,
            "requires_commands": ["discovery", "messages", "outreach"],
        })
        .to_string()
    }

    /// A definition signed by `signer` describing `subject`.
    fn definition_event(signer: &Keys, subject: &Keys, provisioned: Option<&str>) -> Event {
        let mut tags = vec![Tag::parse(["d", &subject.public_key().to_hex()]).expect("d tag")];
        if let Some(handle) = provisioned {
            tags.push(Tag::parse(["provisioned", handle]).expect("provisioned tag"));
        }
        EventBuilder::new(
            Kind::Custom(KIND_MANAGED_AGENT as u16),
            definition_content(provisioned.unwrap_or("sales")),
        )
        .tags(tags)
        .sign_with_keys(signer)
        .expect("sign definition")
    }

    fn employee_head(subject: &Keys, provisioned: Option<&str>) -> Event {
        let mut tags = vec![
            Tag::parse(["d", &subject.public_key().to_hex()]).expect("d tag"),
            Tag::parse(["rank", "leader"]).expect("rank tag"),
        ];
        if let Some(handle) = provisioned {
            tags.push(Tag::parse(["provisioned", handle]).expect("provisioned tag"));
        }
        EventBuilder::new(Kind::Custom(KIND_EMPLOYEE as u16), "")
            .tags(tags)
            .sign_with_keys(subject)
            .expect("sign employee head")
    }

    #[test]
    fn a_self_authored_and_corroborated_definition_is_trusted() {
        let employee = Keys::generate();
        let events = vec![
            definition_event(&employee, &employee, Some("sales")),
            employee_head(&employee, Some("sales")),
        ];
        let found = trusted_provisioned_definitions(&events);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].handle, "sales");
        assert_eq!(found[0].name, "Sales");
        assert_eq!(found[0].harness, "claude");
        assert_eq!(found[0].version, 2);
        assert_eq!(found[0].tier.as_deref(), Some("leader"));
        assert_eq!(found[0].manager, None);
        assert_eq!(found[0].system_prompt, "You are Sales.");
        assert_eq!(
            found[0].requires_commands,
            vec!["discovery", "messages", "outreach"]
        );
        assert_eq!(found[0].model, None);
    }

    #[test]
    fn a_signed_definition_carries_its_manager_without_guessing() {
        let employee = Keys::generate();
        let manager = "f".repeat(64);
        let event = EventBuilder::new(
            Kind::Custom(KIND_MANAGED_AGENT as u16),
            definition_content("website-manager"),
        )
        .tags(vec![
            Tag::parse(["d", &employee.public_key().to_hex()]).expect("d tag"),
            Tag::parse(["provisioned", "website-manager"]).expect("provisioned tag"),
            Tag::parse(["manager", &manager]).expect("manager tag"),
        ])
        .sign_with_keys(&employee)
        .expect("sign definition");

        let found = trusted_provisioned_definitions(&[
            event,
            employee_head(&employee, Some("website-manager")),
        ]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].tier.as_deref(), Some("leader"));
        assert_eq!(found[0].manager.as_deref(), Some(manager.as_str()));
    }

    #[test]
    fn an_ambiguous_or_malformed_manager_claim_is_not_trusted() {
        let employee = Keys::generate();
        let base_tags = || {
            vec![
                Tag::parse(["d", &employee.public_key().to_hex()]).expect("d tag"),
                Tag::parse(["provisioned", "website-manager"]).expect("provisioned tag"),
            ]
        };
        let malformed = EventBuilder::new(
            Kind::Custom(KIND_MANAGED_AGENT as u16),
            definition_content("website-manager"),
        )
        .tags({
            let mut tags = base_tags();
            tags.push(Tag::parse(["manager", "not-a-pubkey"]).expect("manager tag"));
            tags
        })
        .sign_with_keys(&employee)
        .expect("sign malformed definition");
        assert!(trusted_provisioned_definitions(&[
            malformed,
            employee_head(&employee, Some("website-manager")),
        ])
        .is_empty());

        let duplicate = EventBuilder::new(
            Kind::Custom(KIND_MANAGED_AGENT as u16),
            definition_content("website-manager"),
        )
        .tags({
            let mut tags = base_tags();
            tags.push(Tag::parse(["manager", &"a".repeat(64)]).expect("manager tag"));
            tags.push(Tag::parse(["manager", &"b".repeat(64)]).expect("manager tag"));
            tags
        })
        .sign_with_keys(&employee)
        .expect("sign ambiguous definition");
        assert!(trusted_provisioned_definitions(&[
            duplicate,
            employee_head(&employee, Some("website-manager")),
        ])
        .is_empty());

        let invalid_tier = EventBuilder::new(
            Kind::Custom(KIND_MANAGED_AGENT as u16),
            definition_content_with_tier("website-manager", "director"),
        )
        .tags(base_tags())
        .sign_with_keys(&employee)
        .expect("sign invalid tier definition");
        assert!(trusted_provisioned_definitions(&[
            invalid_tier,
            employee_head(&employee, Some("website-manager")),
        ])
        .is_empty());
    }

    #[test]
    fn a_definition_about_an_agent_signed_by_somebody_else_is_not_trusted() {
        // Anyone may publish a head about an agent; only the key holder can
        // publish one as it, and that is the entire proof.
        let employee = Keys::generate();
        let impostor = Keys::generate();
        let events = vec![
            definition_event(&impostor, &employee, Some("sales")),
            employee_head(&employee, Some("sales")),
        ];
        assert!(trusted_provisioned_definitions(&events).is_empty());
    }

    #[test]
    fn a_definition_without_the_provisioned_tag_is_not_trusted() {
        let employee = Keys::generate();
        let events = vec![
            definition_event(&employee, &employee, None),
            employee_head(&employee, Some("sales")),
        ];
        assert!(trusted_provisioned_definitions(&events).is_empty());
    }

    #[test]
    fn a_definition_whose_employee_head_is_not_provisioned_is_not_trusted() {
        // An employee the workspace hired must never be readable as one
        // Colony provides, even if something later lets an owner sign as it.
        let employee = Keys::generate();
        let events = vec![
            definition_event(&employee, &employee, Some("sales")),
            employee_head(&employee, None),
        ];
        assert!(trusted_provisioned_definitions(&events).is_empty());
    }

    #[test]
    fn a_definition_with_no_employee_head_at_all_is_not_trusted() {
        let employee = Keys::generate();
        let events = vec![definition_event(&employee, &employee, Some("sales"))];
        assert!(trusted_provisioned_definitions(&events).is_empty());
    }

    #[test]
    fn the_newest_definition_wins_per_agent() {
        let employee = Keys::generate();
        let older = definition_event(&employee, &employee, Some("sales"));
        let newer = EventBuilder::new(
            Kind::Custom(KIND_MANAGED_AGENT as u16),
            serde_json::json!({
                "name": "Sales",
                "harness": "claude",
                "system_prompt": "A newer brief.",
                "version": 3,
            })
            .to_string(),
        )
        .tags(vec![
            Tag::parse(["d", &employee.public_key().to_hex()]).expect("d tag"),
            Tag::parse(["provisioned", "sales"]).expect("provisioned tag"),
        ])
        .custom_created_at(nostr::Timestamp::from_secs(older.created_at.as_secs() + 60))
        .sign_with_keys(&employee)
        .expect("sign newer definition");

        let events = vec![older, newer, employee_head(&employee, Some("sales"))];
        let found = trusted_provisioned_definitions(&events);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].version, 3);
        assert_eq!(found[0].system_prompt, "A newer brief.");
    }

    #[test]
    fn a_duplicated_provisioned_tag_resolves_to_no_claim() {
        // Two conflicting claims are no claim, the same rule the relay's own
        // single-tag reads apply.
        let employee = Keys::generate();
        let ambiguous = EventBuilder::new(
            Kind::Custom(KIND_MANAGED_AGENT as u16),
            definition_content("sales"),
        )
        .tags(vec![
            Tag::parse(["d", &employee.public_key().to_hex()]).expect("d tag"),
            Tag::parse(["provisioned", "sales"]).expect("provisioned tag"),
            Tag::parse(["provisioned", "support"]).expect("second provisioned tag"),
        ])
        .sign_with_keys(&employee)
        .expect("sign definition");

        let events = vec![ambiguous, employee_head(&employee, Some("sales"))];
        assert!(trusted_provisioned_definitions(&events).is_empty());
    }

    /// The two records a REAL relay served for the seeded sales employee,
    /// captured from an isolated harness on 2026-09-11 (relay 0.11.11, sales
    /// manifest v2) with `POST /query` for kinds 30177 and 30190.
    ///
    /// Hand-built fixtures prove the rule; this proves the rule against what
    /// the relay actually emits. The two drift apart silently otherwise: a
    /// tag renamed on the relay side would leave every test above green while
    /// no desktop could recognise an employee again.
    #[test]
    fn the_records_a_real_relay_serves_are_trusted_and_parse() {
        let raw = include_str!("../../tests/fixtures/provisioned-sales-heads.json");
        let events: Vec<Event> =
            serde_json::from_str(raw).expect("the captured relay payload parses as events");
        assert_eq!(events.len(), 2, "one definition and one employee head");

        let found = trusted_provisioned_definitions(&events);
        assert_eq!(found.len(), 1, "the real records satisfy the trust rule");
        let sales = &found[0];
        assert_eq!(sales.handle, "sales");
        assert_eq!(sales.name, "Sales");
        assert_eq!(sales.role_id, "sales");
        assert_eq!(sales.harness, "claude");
        assert_eq!(sales.version, 2);
        assert_eq!(
            sales.requires_commands,
            vec!["discovery", "messages", "outreach"]
        );
        assert!(
            sales.system_prompt.contains("outreach"),
            "the brief travels on the definition"
        );
    }

    #[test]
    fn the_refusals_name_the_employee_and_say_what_would_happen() {
        let deleted = provisioned_delete_refusal("Sales", "sales");
        assert!(deleted.contains("Sales"));
        assert!(deleted.contains("provided by Colony"));
        assert!(deleted.contains("cannot be deleted"));
        // The honest part: it explains why the delete would not stick.
        assert!(deleted.contains("stays on the relay"));

        let edited = provisioned_edit_refusal("Sales", "sales");
        assert!(edited.contains("Sales"));
        assert!(edited.contains("cannot be changed"));
        assert!(edited.contains("updates itself"));
    }

    #[test]
    fn the_guards_refuse_a_provisioned_record_and_pass_an_ordinary_one() {
        let mut record = crate::managed_agents::ManagedAgentRecord {
            name: "Sales".to_owned(),
            ..Default::default()
        };
        // A workspace's own agent is edited and deleted exactly as before.
        assert!(refuse_edit_if_provisioned(&record).is_ok());
        assert!(refuse_delete_if_provisioned(&record).is_ok());

        record.provisioned = Some("sales".to_owned());
        let edit = refuse_edit_if_provisioned(&record).expect_err("an edit must be refused");
        assert!(edit.contains("Sales") && edit.contains("cannot be changed"));
        let delete = refuse_delete_if_provisioned(&record).expect_err("a delete must be refused");
        assert!(delete.contains("Sales") && delete.contains("cannot be deleted"));
    }

    #[test]
    fn a_nameless_record_falls_back_to_its_handle_then_to_a_phrase() {
        // A record with an empty name must not produce " is provided by
        // Colony and cannot be deleted."
        assert!(provisioned_delete_refusal("", "sales").starts_with("sales is"));
        assert!(provisioned_delete_refusal("  ", "  ").starts_with("This employee is"));
    }

    #[test]
    fn missing_commands_names_only_what_is_absent() {
        let required = vec![
            "discovery".to_owned(),
            "messages".to_owned(),
            "outreach".to_owned(),
        ];
        let available: BTreeSet<String> = ["discovery", "messages"]
            .into_iter()
            .map(str::to_owned)
            .collect();
        assert_eq!(missing_commands(&required, &available), vec!["outreach"]);

        let complete: BTreeSet<String> = ["discovery", "messages", "outreach", "channels"]
            .into_iter()
            .map(str::to_owned)
            .collect();
        assert!(missing_commands(&required, &complete).is_empty());
    }

    #[test]
    fn the_refusal_names_the_employee_and_every_missing_command() {
        let message =
            missing_commands_message("Sales", &["outreach".to_owned(), "discovery".to_owned()]);
        assert!(message.contains("Sales"));
        assert!(message.contains("`buzz outreach`"));
        assert!(message.contains("`buzz discovery`"));
    }

    #[test]
    fn available_commands_are_read_from_the_help_text() {
        let help = "\
Buzz CLI

Usage: buzz [OPTIONS] <COMMAND>

Commands:
  channels   Manage channels
  messages   Send and read messages
  discovery  Find businesses worth contacting
  outreach   Draft and track owner-approved outreach email cards
  help       Print this message

Options:
  -h, --help     Print help
  -V, --version  Print version
";
        let commands = parse_available_commands(help);
        assert!(commands.contains("discovery"));
        assert!(commands.contains("messages"));
        assert!(commands.contains("outreach"));
        assert!(commands.contains("channels"));
        // Flags in the Options block are not subcommands.
        assert!(!commands.contains("-h"));
        assert!(!commands.contains("--help"));
    }

    #[test]
    fn a_build_without_the_command_is_caught_by_the_two_together() {
        // The version skew this whole gate exists for: a 0.17.1-shaped help
        // text with no `outreach`, against a brief that needs it.
        let help = "\
Commands:
  channels   Manage channels
  messages   Send and read messages
  discovery  Find businesses worth contacting
";
        let available = parse_available_commands(help);
        let required = vec![
            "discovery".to_owned(),
            "messages".to_owned(),
            "outreach".to_owned(),
        ];
        let missing = missing_commands(&required, &available);
        assert_eq!(missing, vec!["outreach"]);
        assert!(missing_commands_message("Sales", &missing).contains("`buzz outreach`"));
    }
}
