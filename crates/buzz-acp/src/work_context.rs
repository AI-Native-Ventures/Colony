//! What a paid turn is charged to.
//!
//! A message that asks an agent to do something carries three references:
//! the Task, its Initiative when it has one, and the team accountable for it.
//! Those are pointers, not facts. This module resolves them against the
//! relay-authored records and builds the accounting snapshot that rides on the
//! turn's NIP-AM metric.
//!
//! Two rules make the difference between attribution and theatre:
//!
//! 1. The classification is recalculated here from the canonical Task, never
//!    read from anything the prompt or the message could have written. A model
//!    that could name its own cost classification could bill client delivery
//!    for its own idle chatter.
//! 2. Context that cannot be established is a refusal, not a default. Charging
//!    a turn to a guess is worse than not running it, because the guess is
//!    indistinguishable from a fact once it is written down.

use std::collections::HashMap;

use buzz_core::{
    company::{
        classify_cost, AgentWorkContext, AttributionState, CommercialPurpose,
        CompanyOnboardingStatus, CompanyProfile, CompanyTask, Initiative,
    },
    kind::{KIND_COMPANY_PROFILE, KIND_INITIATIVE, KIND_TASK},
};
use buzz_sdk::company::{parse_company_event, parse_initiative_event, parse_task_event};
use nostr::Event;

/// The pointers a message carries to the work it belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkReference {
    /// The Task this turn is charged to.
    pub task_id: String,
    /// The Initiative containing it, when it has one.
    pub initiative_id: Option<String>,
    /// The team accountable for the Task.
    pub owning_team_id: String,
}

/// Everything the turn needed, resolved from relay-authored records.
#[derive(Debug, Clone, PartialEq)]
pub struct HydratedWorkContext {
    /// The canonical Task.
    pub task: CompanyTask,
    /// The canonical Initiative, when the Task belongs to one.
    pub initiative: Option<Initiative>,
    /// The canonical Company.
    pub company: CompanyProfile,
    /// The snapshot written into the turn metric.
    pub metric: AgentWorkContext,
}

fn scalar_tag<'a>(event: &'a Event, name: &str) -> Result<Option<&'a str>, String> {
    let mut found: Option<&str> = None;
    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        if parts.first().map(String::as_str) != Some(name) {
            continue;
        }
        if parts.len() != 2 || found.is_some() {
            return Err(format!("message carries a malformed `{name}` reference"));
        }
        found = Some(parts[1].as_str());
    }
    Ok(found)
}

/// The identifier grammar `buzz_core::company` accepts.
fn is_record_id(value: &str) -> bool {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    value.len() <= 128
        && (first.is_ascii_lowercase() || first.is_ascii_digit())
        && bytes.all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'.' | b'_' | b':' | b'-')
        })
}

/// Read the work references off a triggering message.
///
/// `Ok(None)` means the message carries none, which is ordinary human chat.
/// `Err` means it carries something malformed, which is not the same thing:
/// treating a broken reference as an absent one would silently downgrade a
/// message that was meant to be attributed.
pub fn read_work_reference(event: &Event) -> Result<Option<WorkReference>, String> {
    let task_id = scalar_tag(event, "task")?;
    let initiative_id = scalar_tag(event, "initiative")?;
    let owning_team_id = scalar_tag(event, "team")?;

    let (Some(task_id), Some(owning_team_id)) = (task_id, owning_team_id) else {
        if task_id.is_some() || owning_team_id.is_some() || initiative_id.is_some() {
            return Err("message carries an incomplete work reference".to_string());
        }
        return Ok(None);
    };
    if !is_record_id(task_id) || !is_record_id(owning_team_id) {
        return Err("message carries an unusable work identifier".to_string());
    }
    if initiative_id.is_some_and(|id| !is_record_id(id)) {
        return Err("message carries an unusable initiative identifier".to_string());
    }

    Ok(Some(WorkReference {
        task_id: task_id.to_string(),
        initiative_id: initiative_id.map(str::to_string),
        owning_team_id: owning_team_id.to_string(),
    }))
}

/// The NIP-33 filter that resolves one relay-authored record.
pub fn head_filter(kind: u32, relay_pubkey: &nostr::PublicKey, id: &str) -> nostr::Filter {
    nostr::Filter::new()
        .kind(nostr::Kind::Custom(kind as u16))
        .author(*relay_pubkey)
        .identifier(id)
        .limit(1)
}

/// The three filters one work reference needs, in a fixed order.
pub fn work_filters(
    reference: &WorkReference,
    company_id: Option<&str>,
    relay_pubkey: &nostr::PublicKey,
) -> Vec<nostr::Filter> {
    let mut filters = vec![head_filter(KIND_TASK, relay_pubkey, &reference.task_id)];
    if let Some(initiative_id) = reference.initiative_id.as_deref() {
        filters.push(head_filter(KIND_INITIATIVE, relay_pubkey, initiative_id));
    }
    if let Some(company_id) = company_id {
        filters.push(head_filter(KIND_COMPANY_PROFILE, relay_pubkey, company_id));
    }
    filters
}

fn relay_authored(
    event: &Event,
    relay_pubkey: &nostr::PublicKey,
    what: &str,
) -> Result<(), String> {
    if event.pubkey != *relay_pubkey {
        return Err(format!("the {what} record was not authored by this relay"));
    }
    event
        .verify()
        .map_err(|_| format!("the {what} record is not correctly signed"))
}

/// Resolve one work reference against the records the relay actually holds.
///
/// Every disagreement between the message and the records is a refusal. The
/// message is a claim about where the cost belongs; the records are the answer.
pub fn hydrate(
    reference: &WorkReference,
    task_event: &Event,
    initiative_event: Option<&Event>,
    company_event: &Event,
    relay_pubkey: &nostr::PublicKey,
) -> Result<HydratedWorkContext, String> {
    relay_authored(task_event, relay_pubkey, "task")?;
    relay_authored(company_event, relay_pubkey, "company")?;

    let task =
        parse_task_event(task_event).map_err(|error| format!("task is unreadable: {error}"))?;
    let company = parse_company_event(company_event)
        .map_err(|error| format!("company is unreadable: {error}"))?;

    if task.id != reference.task_id {
        return Err("the task record does not match the reference".to_string());
    }
    // The message names a team. If the Task says another one owns it, the
    // message is wrong about who is accountable, and accepting it would charge
    // the turn to a team that never took the work.
    if task.owning_team_id != reference.owning_team_id {
        return Err("the message and the task disagree about the owning team".to_string());
    }
    if task.company_id != company.id {
        return Err("the task belongs to a different company".to_string());
    }
    if !company
        .cost_centres
        .iter()
        .any(|centre| centre.id == task.cost_centre_id)
    {
        return Err("the task is charged to a cost centre the company does not have".to_string());
    }

    let initiative = match (reference.initiative_id.as_deref(), initiative_event) {
        (Some(initiative_id), Some(event)) => {
            relay_authored(event, relay_pubkey, "initiative")?;
            let initiative = parse_initiative_event(event)
                .map_err(|error| format!("initiative is unreadable: {error}"))?;
            if initiative.id != initiative_id
                || task.initiative_id.as_deref() != Some(initiative_id)
            {
                return Err("the initiative record does not match the reference".to_string());
            }
            if initiative.company_id != task.company_id {
                return Err("the initiative belongs to a different company".to_string());
            }
            Some(initiative)
        }
        (Some(_), None) => {
            return Err("the referenced initiative could not be read".to_string());
        }
        (None, _) => {
            if task.initiative_id.is_some() {
                return Err("the message omits the initiative the task belongs to".to_string());
            }
            None
        }
    };

    // Recalculated, never carried. A model that could name its own cost
    // classification could bill client delivery for its own idle chatter.
    let cost_classification = classify_cost(
        task.commercial_purpose,
        task.client_organization_id.as_deref(),
    );

    let metric = AgentWorkContext {
        company_id: task.company_id.clone(),
        task_id: task.id.clone(),
        initiative_id: task.initiative_id.clone(),
        owning_team_id: task.owning_team_id.clone(),
        cost_centre_id: task.cost_centre_id.clone(),
        commercial_purpose: task.commercial_purpose,
        cost_classification,
        // The message named the Task outright. Inherited and implicit
        // attribution are established before the message is sent, not here.
        attribution_state: AttributionState::Explicit,
        client_organization_id: task.client_organization_id.clone(),
    };

    Ok(HydratedWorkContext {
        task,
        initiative,
        company,
        metric,
    })
}

/// Resolve the work a triggering message points at, against the live relay.
///
/// Two round trips, because the Task names the company and the company is not
/// known until it is read. Both name their kinds and pin the author to the
/// relay's own key.
pub async fn resolve_for_event(
    rest: &crate::relay::RestClient,
    event: &Event,
) -> Result<Option<HydratedWorkContext>, String> {
    let Some(reference) = read_work_reference(event)? else {
        return Ok(None);
    };
    let relay_pubkey = rest
        .relay_self()
        .await
        .map_err(|error| format!("could not read the relay identity: {error}"))?
        .ok_or_else(|| {
            "this relay advertises no stable identity, so its company records cannot be trusted"
                .to_string()
        })?;

    let first = rest
        .query_events(&work_filters(&reference, None, &relay_pubkey))
        .await
        .map_err(|error| format!("could not read the work records: {error}"))?;
    let task_event = first
        .iter()
        .find(|event| event.kind.as_u16() as u32 == KIND_TASK)
        .ok_or_else(|| "the task this message names does not exist".to_string())?;
    let initiative_event = first
        .iter()
        .find(|event| event.kind.as_u16() as u32 == KIND_INITIATIVE)
        .cloned();

    let task =
        parse_task_event(task_event).map_err(|error| format!("task is unreadable: {error}"))?;
    let company_events = rest
        .query_events(&[head_filter(
            KIND_COMPANY_PROFILE,
            &relay_pubkey,
            &task.company_id,
        )])
        .await
        .map_err(|error| format!("could not read the company record: {error}"))?;
    let company_event = company_events
        .first()
        .ok_or_else(|| "the company this work belongs to does not exist".to_string())?;

    hydrate(
        &reference,
        task_event,
        initiative_event.as_ref(),
        company_event,
        &relay_pubkey,
    )
    .map(Some)
}

/// Resolve the workspace's onboarding status from an already-fetched set of
/// company-profile heads.
///
/// A Colony workspace has at most one company. NIP-33 replacement is enforced
/// at write time (`Db::replace_parameterized_replaceable`), so at most one
/// live head exists per company id -- this never has to resolve "latest
/// wins" itself, only "how many distinct companies are live".
///
/// `None` covers two states [`crate::should_inject_company_onboarding`]
/// treats identically: no company has been published yet, and -- a
/// defensive case this data model does not otherwise produce -- more than
/// one distinct company id is live at once. Guessing which of several
/// companies governs the workspace would be worse than withholding the
/// protocol, so ambiguity logs a warning and falls back to `None` rather
/// than picking one.
fn resolve_onboarding_status_from_heads(
    events: &[Event],
    relay_pubkey: &nostr::PublicKey,
) -> Option<CompanyOnboardingStatus> {
    let mut by_id: HashMap<String, CompanyOnboardingStatus> = HashMap::new();
    for event in events {
        if relay_authored(event, relay_pubkey, "company").is_err() {
            continue;
        }
        let Ok(profile) = parse_company_event(event) else {
            continue;
        };
        by_id.insert(profile.id, profile.onboarding_status);
    }
    match by_id.len() {
        0 => None,
        1 => by_id.into_values().next(),
        count => {
            tracing::warn!(
                target: "work_context::onboarding",
                company_count = count,
                "more than one company profile is live; withholding the onboarding protocol \
                 rather than guessing which one governs the workspace"
            );
            None
        }
    }
}

/// Fetch every company-profile head this relay has published and resolve the
/// workspace's onboarding status from them.
///
/// Queried by kind and author only -- no `d` tag -- because the caller does
/// not know a company id to look up yet; that is exactly the "no company
/// yet" state the onboarding protocol exists for. `limit` is generous
/// headroom over the "at most one" a workspace is expected to hold.
pub async fn fetch_company_onboarding_status(
    rest: &crate::relay::RestClient,
) -> Result<Option<CompanyOnboardingStatus>, String> {
    let relay_pubkey = rest
        .relay_self()
        .await
        .map_err(|error| format!("could not read the relay identity: {error}"))?
        .ok_or_else(|| {
            "this relay advertises no stable identity, so its company records cannot be trusted"
                .to_string()
        })?;

    let filter = nostr::Filter::new()
        .kind(nostr::Kind::Custom(KIND_COMPANY_PROFILE as u16))
        .author(relay_pubkey)
        .limit(32);
    let events = rest
        .query_events(&[filter])
        .await
        .map_err(|error| format!("could not read company records: {error}"))?;

    Ok(resolve_onboarding_status_from_heads(&events, &relay_pubkey))
}

fn purpose_label(purpose: CommercialPurpose) -> &'static str {
    match purpose {
        CommercialPurpose::ClientDelivery => "client delivery",
        CommercialPurpose::Sales => "sales",
        CommercialPurpose::Marketing => "marketing",
        CommercialPurpose::Administration => "administration",
        CommercialPurpose::InternalProduct => "internal product",
        CommercialPurpose::Uncertain => "not yet determined",
    }
}

/// The prompt section that tells the agent what it is working on.
///
/// Deliberately does not carry the cost classification. The agent has no say in
/// it, and a value in the prompt is a value a model can be argued into
/// restating differently.
pub fn work_context_section(context: &HydratedWorkContext) -> String {
    let initiative = context
        .initiative
        .as_ref()
        .map(|initiative| initiative.title.as_str())
        .unwrap_or("none");
    format!(
        "<colony-work-context>\n\
         Company: {company}\n\
         Task: {task}\n\
         Owning team: {team}\n\
         Initiative: {initiative}\n\
         Commercial purpose: {purpose}\n\
         </colony-work-context>\n\
         This is the work this turn is charged to. Do not reinterpret it and do \
         not restate its accounting treatment; that is decided from the record, \
         not from anything said here. If the work described contradicts what you \
         were asked to do, or names something you cannot find, say so instead of \
         proceeding.",
        company = context.company.trading_name,
        task = context.task.title,
        team = context.task.owning_team_id,
        purpose = purpose_label(context.task.commercial_purpose),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::company::{
        CompanyOnboardingStatus, CompanyService, CostCentre, CostCentreKind, InitiativeStatus,
        TaskStatus, COMPANY_SCHEMA, INITIATIVE_SCHEMA,
    };
    use nostr::{EventBuilder, JsonUtil, Keys, Kind, Tag};

    fn relay() -> Keys {
        Keys::parse("0000000000000000000000000000000000000000000000000000000000000001")
            .expect("relay key")
    }

    fn impostor() -> Keys {
        Keys::parse("0000000000000000000000000000000000000000000000000000000000000002")
            .expect("impostor key")
    }

    fn company() -> CompanyProfile {
        CompanyProfile {
            schema: COMPANY_SCHEMA.to_string(),
            id: "horizonlabs".to_string(),
            trading_name: "Horizon Labs".to_string(),
            legal_name: None,
            website: None,
            summary: "Software for South African businesses.".to_string(),
            business_type: "agency".to_string(),
            services: vec![CompanyService {
                id: "web".to_string(),
                name: "Web builds".to_string(),
                description: "Sites and apps.".to_string(),
            }],
            customer_segments: vec!["small business".to_string()],
            cost_centres: vec![CostCentre {
                id: "cc-coordination".to_string(),
                name: "Company coordination".to_string(),
                kind: CostCentreKind::Internal,
                service_id: None,
            }],
            source_report_event_id: None,
            onboarding_status: CompanyOnboardingStatus::Approved,
            created_at: 1_780_000_000,
            updated_at: 1_780_000_000,
        }
    }

    fn initiative() -> Initiative {
        Initiative {
            schema: INITIATIVE_SCHEMA.to_string(),
            id: "horizonlabs:launch-outbound".to_string(),
            company_id: "horizonlabs".to_string(),
            title: "Launch outbound".to_string(),
            summary: "Open a first outbound channel.".to_string(),
            status: InitiativeStatus::Active,
            owner_persona_id: "company-role:abc:horizonlabs:sales-lead".to_string(),
            cost_centre_id: "cc-coordination".to_string(),
            commercial_purpose: CommercialPurpose::Sales,
            client_organization_id: None,
            expected_cost_usd: None,
            source_channel_id: "welcome".to_string(),
            source_event_id: None,
            created_at: 1_780_000_000,
            updated_at: 1_780_000_000,
        }
    }

    fn task() -> CompanyTask {
        CompanyTask {
            schema: "colony.task/v1".to_string(),
            id: "horizonlabs:chat:0001".to_string(),
            company_id: "horizonlabs".to_string(),
            initiative_id: None,
            title: "Take a look at the failing deploy".to_string(),
            status: TaskStatus::InProgress,
            owning_team_id: "company-team:abc:horizonlabs:engineering".to_string(),
            assignee_persona_ids: vec!["company-role:abc:horizonlabs:cto".to_string()],
            qa_persona_id: "company-role:abc:horizonlabs:cto".to_string(),
            cost_centre_id: "cc-coordination".to_string(),
            commercial_purpose: CommercialPurpose::Administration,
            client_organization_id: None,
            source_channel_id: "engineering".to_string(),
            source_event_id: None,
            implicit: true,
            created_at: 1_780_000_000,
            updated_at: 1_780_000_000,
        }
    }

    fn canonical(value: &serde_json::Value) -> String {
        buzz_core::block::canonical_json(value).expect("canonical json")
    }

    fn head(kind: u32, record: &serde_json::Value, tags: Vec<Tag>, keys: &Keys) -> Event {
        EventBuilder::new(Kind::Custom(kind as u16), canonical(record))
            .tags(tags)
            .sign_with_keys(keys)
            .expect("sign head")
    }

    fn scalar(name: &str, value: &str) -> Tag {
        Tag::parse([name, value]).expect("tag")
    }

    fn company_head(keys: &Keys) -> Event {
        company_head_for(&company(), keys)
    }

    fn company_head_for(record: &CompanyProfile, keys: &Keys) -> Event {
        head(
            KIND_COMPANY_PROFILE,
            &serde_json::to_value(record).expect("company json"),
            vec![
                scalar("d", &record.id),
                scalar("c", &record.id),
                scalar("company", &record.id),
            ],
            keys,
        )
    }

    fn initiative_head(keys: &Keys) -> Event {
        let record = initiative();
        head(
            KIND_INITIATIVE,
            &serde_json::to_value(&record).expect("initiative json"),
            vec![
                scalar("d", &record.id),
                scalar("c", &record.company_id),
                scalar("company", &record.company_id),
                scalar("cost-centre", &record.cost_centre_id),
            ],
            keys,
        )
    }

    fn task_head(record: &CompanyTask, keys: &Keys) -> Event {
        let mut tags = vec![
            scalar("d", &record.id),
            scalar("c", &record.company_id),
            scalar("company", &record.company_id),
            scalar("team", &record.owning_team_id),
            scalar("cost-centre", &record.cost_centre_id),
        ];
        if let Some(initiative_id) = record.initiative_id.as_deref() {
            tags.push(scalar("initiative", initiative_id));
        }
        if let Some(client) = record.client_organization_id.as_deref() {
            tags.push(scalar("client", client));
        }
        head(
            KIND_TASK,
            &serde_json::to_value(record).expect("task json"),
            tags,
            keys,
        )
    }

    fn message(tags: Vec<Tag>) -> Event {
        EventBuilder::new(Kind::Custom(9), "@cto take a look".to_string())
            .tags(tags)
            .sign_with_keys(&impostor())
            .expect("sign message")
    }

    fn reference() -> WorkReference {
        WorkReference {
            task_id: "horizonlabs:chat:0001".to_string(),
            initiative_id: None,
            owning_team_id: "company-team:abc:horizonlabs:engineering".to_string(),
        }
    }

    #[test]
    fn a_message_with_no_work_reference_is_ordinary_chat() {
        let event = message(vec![scalar("h", "engineering")]);
        assert_eq!(read_work_reference(&event).expect("read"), None);
    }

    #[test]
    fn the_exact_three_references_are_read() {
        let event = message(vec![
            scalar("h", "engineering"),
            scalar("task", "horizonlabs:chat:0001"),
            scalar("initiative", "horizonlabs:launch-outbound"),
            scalar("team", "company-team:abc:horizonlabs:engineering"),
        ]);
        assert_eq!(
            read_work_reference(&event).expect("read"),
            Some(WorkReference {
                task_id: "horizonlabs:chat:0001".to_string(),
                initiative_id: Some("horizonlabs:launch-outbound".to_string()),
                owning_team_id: "company-team:abc:horizonlabs:engineering".to_string(),
            })
        );
    }

    // Treating a broken reference as an absent one would silently downgrade a
    // message that was meant to be attributed into unattributed spend.
    #[test]
    fn a_broken_reference_is_refused_rather_than_ignored() {
        for (label, tags) in [
            (
                "duplicate task",
                vec![
                    scalar("task", "horizonlabs:chat:0001"),
                    scalar("task", "horizonlabs:chat:0002"),
                    scalar("team", "company-team:abc:horizonlabs:engineering"),
                ],
            ),
            (
                "task without team",
                vec![scalar("task", "horizonlabs:chat:0001")],
            ),
            (
                "team without task",
                vec![scalar("team", "company-team:abc:horizonlabs:engineering")],
            ),
            (
                "initiative alone",
                vec![scalar("initiative", "horizonlabs:launch-outbound")],
            ),
            (
                "uppercase task id",
                vec![
                    scalar("task", "Horizonlabs:Chat"),
                    scalar("team", "company-team:abc:horizonlabs:engineering"),
                ],
            ),
            (
                "task id with a space",
                vec![
                    scalar("task", "horizon labs"),
                    scalar("team", "company-team:abc:horizonlabs:engineering"),
                ],
            ),
        ] {
            let event = message(tags);
            assert!(
                read_work_reference(&event).is_err(),
                "{label} must be refused"
            );
        }
    }

    #[test]
    fn a_reference_resolves_into_the_canonical_records() {
        let keys = relay();
        let context = hydrate(
            &reference(),
            &task_head(&task(), &keys),
            None,
            &company_head(&keys),
            &keys.public_key(),
        )
        .expect("hydrate");

        assert_eq!(context.task.id, "horizonlabs:chat:0001");
        assert_eq!(context.company.id, "horizonlabs");
        assert_eq!(context.initiative, None);
        assert_eq!(context.metric.task_id, "horizonlabs:chat:0001");
        assert_eq!(
            context.metric.owning_team_id,
            "company-team:abc:horizonlabs:engineering"
        );
        assert_eq!(context.metric.cost_centre_id, "cc-coordination");
        assert_eq!(
            context.metric.commercial_purpose,
            CommercialPurpose::Administration
        );
        assert_eq!(context.metric.attribution_state, AttributionState::Explicit);
    }

    // The classification is the whole point of the snapshot. It is computed
    // from the canonical Task every time rather than carried by anything the
    // message or the model could have written.
    #[test]
    fn the_classification_is_recalculated_from_the_record() {
        let keys = relay();
        let mut delivery = task();
        delivery.commercial_purpose = CommercialPurpose::ClientDelivery;
        delivery.client_organization_id = Some("acme".to_string());
        let context = hydrate(
            &reference(),
            &task_head(&delivery, &keys),
            None,
            &company_head(&keys),
            &keys.public_key(),
        )
        .expect("hydrate");
        assert_eq!(
            context.metric.cost_classification,
            buzz_core::company::CostClassification::Cogs
        );

        let mut unattributed = task();
        unattributed.commercial_purpose = CommercialPurpose::ClientDelivery;
        unattributed.client_organization_id = None;
        let review = hydrate(
            &reference(),
            &task_head(&unattributed, &keys),
            None,
            &company_head(&keys),
            &keys.public_key(),
        )
        .expect("hydrate");
        // Client delivery with no client named cannot be a cost of goods sold.
        assert_eq!(
            review.metric.cost_classification,
            buzz_core::company::CostClassification::NeedsReview
        );
    }

    #[test]
    fn a_task_inside_an_initiative_resolves_both() {
        let keys = relay();
        let mut inside = task();
        inside.initiative_id = Some("horizonlabs:launch-outbound".to_string());
        let mut reference = reference();
        reference.initiative_id = Some("horizonlabs:launch-outbound".to_string());

        let context = hydrate(
            &reference,
            &task_head(&inside, &keys),
            Some(&initiative_head(&keys)),
            &company_head(&keys),
            &keys.public_key(),
        )
        .expect("hydrate");
        assert_eq!(
            context.initiative.as_ref().map(|i| i.id.as_str()),
            Some("horizonlabs:launch-outbound")
        );
        assert_eq!(
            context.metric.initiative_id.as_deref(),
            Some("horizonlabs:launch-outbound")
        );
    }

    // Anyone can publish an event. A head from anyone but this relay is a
    // record somebody wrote about themselves.
    #[test]
    fn records_from_anyone_but_the_relay_are_refused() {
        let keys = relay();
        let forged = impostor();
        assert!(hydrate(
            &reference(),
            &task_head(&task(), &forged),
            None,
            &company_head(&keys),
            &keys.public_key(),
        )
        .is_err());
        assert!(hydrate(
            &reference(),
            &task_head(&task(), &keys),
            None,
            &company_head(&forged),
            &keys.public_key(),
        )
        .is_err());
    }

    // The message is a claim about where the cost belongs; the record is the
    // answer. Every disagreement between them is a refusal.
    #[test]
    fn every_disagreement_between_message_and_record_is_a_refusal() {
        let keys = relay();
        let public = keys.public_key();

        let mut wrong_task = reference();
        wrong_task.task_id = "horizonlabs:chat:9999".to_string();
        assert!(
            hydrate(
                &wrong_task,
                &task_head(&task(), &keys),
                None,
                &company_head(&keys),
                &public
            )
            .is_err(),
            "a task id that does not match its record must be refused"
        );

        let mut wrong_team = reference();
        wrong_team.owning_team_id = "company-team:abc:horizonlabs:sales".to_string();
        assert!(
            hydrate(
                &wrong_team,
                &task_head(&task(), &keys),
                None,
                &company_head(&keys),
                &public
            )
            .is_err(),
            "a team the task does not name must be refused"
        );

        let mut inside = task();
        inside.initiative_id = Some("horizonlabs:launch-outbound".to_string());
        assert!(
            hydrate(
                &reference(),
                &task_head(&inside, &keys),
                None,
                &company_head(&keys),
                &public
            )
            .is_err(),
            "a message omitting the task's initiative must be refused"
        );

        let mut reference_with_initiative = reference();
        reference_with_initiative.initiative_id = Some("horizonlabs:launch-outbound".to_string());
        assert!(
            hydrate(
                &reference_with_initiative,
                &task_head(&inside, &keys),
                None,
                &company_head(&keys),
                &public
            )
            .is_err(),
            "an initiative that could not be read must be refused"
        );
    }

    #[test]
    fn a_cost_centre_the_company_does_not_have_is_refused() {
        let keys = relay();
        let mut stray = task();
        stray.cost_centre_id = "cc-invented".to_string();
        let error = hydrate(
            &reference(),
            &task_head(&stray, &keys),
            None,
            &company_head(&keys),
            &keys.public_key(),
        )
        .expect_err("a task must not charge a cost centre the company does not have");
        assert!(error.contains("cost centre"), "unexpected: {error}");
    }

    #[test]
    fn the_filters_name_their_kinds_and_the_relay_that_authored_them() {
        let keys = relay();
        let mut reference = reference();
        reference.initiative_id = Some("horizonlabs:launch-outbound".to_string());
        let filters = work_filters(&reference, Some("horizonlabs"), &keys.public_key());
        assert_eq!(filters.len(), 3);
        for filter in &filters {
            let json = filter.as_json();
            assert!(
                json.contains("kinds"),
                "every query names its kinds: {json}"
            );
            assert!(json.contains("authors"), "every query pins its author");
        }
    }

    // The agent has no say in the classification, and a value in the prompt is
    // a value a model can be argued into restating differently.
    #[test]
    fn the_prompt_section_states_the_work_without_stating_its_accounting() {
        let keys = relay();
        let context = hydrate(
            &reference(),
            &task_head(&task(), &keys),
            None,
            &company_head(&keys),
            &keys.public_key(),
        )
        .expect("hydrate");
        let section = work_context_section(&context);
        assert!(section.contains("<colony-work-context>"));
        assert!(section.contains("Take a look at the failing deploy"));
        assert!(section.contains("company-team:abc:horizonlabs:engineering"));
        assert!(section.contains("administration"));
        for forbidden in ["cogs", "COGS", "opex", "OPEX", "needsReview"] {
            assert!(
                !section.contains(forbidden),
                "the prompt must not carry the cost classification: {forbidden}"
            );
        }
    }

    #[test]
    fn no_company_heads_resolve_to_no_status() {
        let keys = relay();
        assert_eq!(
            resolve_onboarding_status_from_heads(&[], &keys.public_key()),
            None
        );
    }

    #[test]
    fn a_single_company_head_resolves_to_its_status() {
        let keys = relay();
        let mut draft = company();
        draft.onboarding_status = CompanyOnboardingStatus::Draft;
        assert_eq!(
            resolve_onboarding_status_from_heads(
                &[company_head_for(&draft, &keys)],
                &keys.public_key()
            ),
            Some(CompanyOnboardingStatus::Draft)
        );

        let approved = company(); // fixture default is Approved
        assert_eq!(
            resolve_onboarding_status_from_heads(
                &[company_head_for(&approved, &keys)],
                &keys.public_key()
            ),
            Some(CompanyOnboardingStatus::Approved)
        );
    }

    // Any authenticated member can publish a `KIND_COMPANY_PROFILE` event --
    // the same client-writable exposure `interrupt_runtime.rs` documents for
    // `KIND_MANAGED_AGENT`. Without the author check, an impostor head could
    // convince every agent onboarding is either still open or already closed.
    #[test]
    fn heads_not_authored_by_the_relay_are_ignored() {
        let relay_keys = relay();
        let mut draft = company();
        draft.onboarding_status = CompanyOnboardingStatus::Draft;
        let forged = company_head_for(&draft, &impostor());
        assert_eq!(
            resolve_onboarding_status_from_heads(&[forged], &relay_keys.public_key()),
            None,
            "an impostor-authored head must not decide onboarding status"
        );
    }

    // Never guess which of several companies governs the workspace -- that is
    // the same "Ok(None), never guess" discipline `persona_pubkey_in_roster`
    // and `unique_executive_in_roster` use in `interrupt_runtime.rs`.
    #[test]
    fn more_than_one_distinct_company_is_ambiguous_and_withheld() {
        let keys = relay();
        let mut first = company();
        first.id = "horizonlabs".to_string();
        first.onboarding_status = CompanyOnboardingStatus::Draft;
        let mut second = company();
        second.id = "other-co".to_string();
        second.onboarding_status = CompanyOnboardingStatus::Approved;

        let heads = [
            company_head_for(&first, &keys),
            company_head_for(&second, &keys),
        ];
        assert_eq!(
            resolve_onboarding_status_from_heads(&heads, &keys.public_key()),
            None
        );
    }
}

/// Guards on how the pool wires work context into every turn.
///
/// These read the pool's own source. That is unusual, and it is here because
/// the property they protect is structural rather than behavioural: a turn can
/// end normally, cancelled, interrupted, rotated, timed out, or errored, and
/// every one of those paths publishes its own metric. Exercising all ten
/// through a real harness would need a live relay, a live model, and a way to
/// force each failure; missing one of them silently is exactly the regression
/// worth catching, so the wiring itself is asserted instead.
#[cfg(test)]
mod pool_wiring_tests {
    const POOL: &str = include_str!("pool.rs");

    /// Every production metric publish carries the turn's work context.
    #[test]
    fn every_turn_exit_path_publishes_the_same_work_context() {
        let definition = POOL
            .find("async fn publish_agent_turn_metric(")
            .expect("the metric publisher exists");
        let production = &POOL[..definition];

        let call_sites = production.matches("publish_agent_turn_metric(").count();
        let attributed = production
            .matches("work_context.as_ref().map(|context| &context.metric),")
            .count();

        assert!(
            call_sites >= 10,
            "expected the pool to publish a metric on every turn exit path, found {call_sites}"
        );
        assert_eq!(
            call_sites,
            attributed,
            "{} of {call_sites} metric publishes do not carry the turn's work context",
            call_sites - attributed
        );
    }

    /// The section is built from the resolved context, and leads the prompt.
    #[test]
    fn the_work_section_is_injected_before_the_instruction() {
        assert!(
            POOL.contains("crate::work_context::work_context_section"),
            "the pool must render the work section"
        );
        assert!(
            POOL.contains("crate::work_context::resolve_for_event"),
            "the pool must resolve work context from the triggering event"
        );
        let section = POOL
            .find("let work_section = work_context")
            .expect("the work section is built");
        let blocks = POOL
            .find("let prompt_blocks: Vec<&str>")
            .expect("prompt blocks are assembled");
        assert!(
            section < blocks,
            "the work section must exist before the prompt blocks that carry it"
        );
    }

    /// The composed system prompt only carries the onboarding protocol if
    /// production code actually resolves company status and threads it
    /// through the composition pipeline -- not merely because
    /// `COMPANY_ONBOARDING_PROMPT` and `should_inject_company_onboarding`
    /// exist somewhere in the crate. This is exactly the gap issue #98
    /// closes: the pre-fix tests asserted on the constant directly, which
    /// passed whether or not anything ever injected it.
    #[test]
    fn create_session_and_apply_model_wires_the_onboarding_gate() {
        assert!(
            POOL.contains("crate::should_inject_company_onboarding"),
            "the pool must consult the onboarding gate before composing a session's prompt"
        );
        assert!(
            POOL.contains("crate::work_context::fetch_company_onboarding_status"),
            "the pool must fetch the company's onboarding status, not assume one"
        );

        let definition_start = POOL
            .find("async fn create_session_and_apply_model(")
            .expect("session creation exists");
        let definition_end = POOL[definition_start..]
            .find("\nasync fn ")
            .map(|offset| definition_start + offset)
            .expect("a later top-level async fn bounds this one");
        let body = &POOL[definition_start..definition_end];

        assert!(
            body.contains("onboarding_section: Option<&str>"),
            "session creation must accept the resolved onboarding section as a parameter -- \
             the fetch happens once at the call site, not on every session-creation call"
        );
        assert!(
            body.contains("with_company_onboarding("),
            "the accepted onboarding section must be composed into the system prompt"
        );
    }

    /// Companion to `create_session_and_apply_model_wires_the_onboarding_gate`:
    /// that test proves the gate is consulted at session creation; this one
    /// proves `run_prompt_task` actually retries an unresolved lookup rather
    /// than only checking it once. Complements the pure-logic tests in
    /// `pool::tests` (`retry_recovers_onboarding_after_a_cold_start_timeout`
    /// and its neighbors), which prove the retry decision functions
    /// themselves are correct in isolation but cannot prove anything calls
    /// them in production.
    #[test]
    fn run_prompt_task_wires_the_onboarding_retry() {
        let definition_start = POOL
            .find("pub async fn run_prompt_task(")
            .expect("run_prompt_task exists");
        let definition_end = POOL[definition_start..]
            .find("\nasync fn ")
            .map(|offset| definition_start + offset)
            .expect("a later top-level async fn bounds this one");
        let body = &POOL[definition_start..definition_end];

        assert!(
            body.contains("needs_onboarding_lookup("),
            "the pool must check whether an onboarding lookup is needed, including on retry"
        );
        assert!(
            body.contains("apply_onboarding_resolution("),
            "a resolved lookup must be applied -- cached, and the stale session invalidated \
             when a retry determines it should have carried the protocol"
        );
        assert!(
            body.contains("cached_onboarding_section("),
            "the onboarding section for a new session must come from the resolution cache, \
             not a value computed inline and disconnected from the retry cache"
        );
    }
}

/// The base prompt has to tell agents what the work block means.
#[cfg(test)]
mod base_prompt_tests {
    const BASE_PROMPT: &str = include_str!("base_prompt.md");

    #[test]
    fn agents_are_told_not_to_reinterpret_the_accounting() {
        assert!(BASE_PROMPT.contains("<colony-work-context>"));
        assert!(
            BASE_PROMPT.contains("Never restate or reinterpret the accounting treatment"),
            "the base prompt must refuse agents any say in cost classification"
        );
        assert!(
            BASE_PROMPT.contains("report that rather than proceeding"),
            "the base prompt must tell agents to report contradictory context"
        );
    }
}
