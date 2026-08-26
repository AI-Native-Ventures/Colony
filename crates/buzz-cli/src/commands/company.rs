//! Agent-first access to Colony Company, Initiative, and Task records.
//!
//! Reads resolve relay-authored canonical heads. Writes never author a head:
//! they publish an owner-signed `KIND_COMPANY_ACTION` and let the relay broker
//! validate it, sign the replacement, and return a receipt. That asymmetry is
//! the whole point of the design — a client that could sign heads directly
//! would split the coordinate the moment community ownership changed.
//!
//! Managed agents may read freely. Mutations require the CLI signing key to be
//! the current company owner, so an agent asks for a change in chat and an
//! owner authorizes it.

use buzz_core::company::{CompanyProfile, CompanyTask, Initiative, TaskStatus};
use buzz_core::kind::{
    KIND_COHORT, KIND_COMPANY_PROFILE, KIND_COMPANY_RECEIPT, KIND_INITIATIVE, KIND_TASK,
    KIND_TEMPLATE,
};
use buzz_sdk::company::{
    build_company_action, parse_company_event, parse_initiative_event, parse_task_event,
    CompanyAction, CompanyActionOperation, CompanyActionPayload,
};
use nostr::{Event, JsonUtil, PublicKey};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::client::BuzzClient;
use crate::error::CliError;
use crate::{CompanyCmd, InitiativesCmd, TasksCmd};

/// Route `buzz company ...`.
pub async fn dispatch_company(command: CompanyCmd, client: &BuzzClient) -> Result<(), CliError> {
    match command {
        CompanyCmd::Get { id } => get_company(client, &id).await,
        CompanyCmd::Put { file } => put_from_file(client, &file).await,
        // Routed before auth in `run`; unreachable here.
        CompanyCmd::Scan { url, max_pages } => scan_public_site(&url, max_pages).await,
        // Routed before auth in `run`; unreachable here.
        CompanyCmd::Blueprint { file } => check_blueprint(&file),
        CompanyCmd::Approve {
            file,
            channel,
            scope,
        } => approve_blueprint(client, &file, &channel, scope.as_deref()).await,
    }
}

/// Validate a proposed blueprint and print its stable hash.
///
/// Needs no relay. The point is to refuse a blueprint before an owner ever
/// sees it, and to hand back the hash that binds their approval to this exact
/// document.
pub fn check_blueprint(file: &str) -> Result<(), CliError> {
    let raw = std::fs::read_to_string(file)
        .map_err(|error| CliError::Usage(format!("could not read {file}: {error}")))?;

    let blueprint = buzz_core::company_roster::parse_blueprint(&raw)
        .map_err(|error| CliError::Usage(error.to_string()))?;

    let hash = buzz_core::company_roster::blueprint_hash(&blueprint);
    println!(
        "{}",
        serde_json::json!({
            "companyId": blueprint.company.id,
            "blueprintHash": hash,
            "requestId": blueprint.request_id,
            "employees": blueprint.roster.iter().filter(|entry| entry.enabled).count(),
            "teams": blueprint.teams.len(),
            "initiatives": blueprint.proposed_initiatives.len(),
        })
    );
    Ok(())
}

/// Collect public evidence from a company website.
///
/// Needs no relay: this is a read of a public site, and keeping it independent
/// means the Chief of Staff can gather evidence before a company record exists.
pub async fn scan_public_site(url: &str, max_pages: Option<usize>) -> Result<(), CliError> {
    let mut limits = crate::company_scan::fetch::ScanLimits::default();
    if let Some(pages) = max_pages {
        limits = limits.with_max_pages(pages);
    }
    match crate::company_scan::fetch::scan_site(url, limits).await {
        Ok(result) => {
            println!(
                "{}",
                serde_json::to_string(&result)
                    .map_err(|error| CliError::Other(format!("cannot serialize scan: {error}")))?
            );
            // A site that served pages but no readable text is valid input that
            // produced unusable evidence — a distinct outcome from a bad URL.
            if result.pages.iter().all(|page| page.text.len() < 200) {
                return Err(CliError::NotFound(
                    "the site served no readable text; ask the user directly instead".to_owned(),
                ));
            }
            Ok(())
        }
        Err(error) => match error {
            crate::company_scan::fetch::ScanError::Rejected(rejection) => {
                Err(CliError::Usage(rejection.to_string()))
            }
            other => Err(CliError::Other(other.to_string())),
        },
    }
}

/// Route `buzz initiatives ...`.
pub async fn dispatch_initiatives(
    command: InitiativesCmd,
    client: &BuzzClient,
) -> Result<(), CliError> {
    match command {
        InitiativesCmd::List { company } => list_initiatives(client, &company).await,
        InitiativesCmd::Get { id } => get_initiative(client, &id).await,
        InitiativesCmd::Put { file } => put_from_file(client, &file).await,
    }
}

/// Route `buzz tasks ...`.
pub async fn dispatch_tasks(command: TasksCmd, client: &BuzzClient) -> Result<(), CliError> {
    match command {
        TasksCmd::List {
            company,
            initiative,
        } => list_tasks(client, company.as_deref(), initiative.as_deref()).await,
        TasksCmd::Get { id } => get_task(client, &id).await,
        TasksCmd::Put { file } => put_from_file(client, &file).await,
        TasksCmd::Complete { id } => complete_task(client, &id).await,
    }
}

/// The tenant relay pubkey, which authors every canonical head.
async fn relay_self(client: &BuzzClient) -> Result<PublicKey, CliError> {
    let raw = client.get_public("/").await?;
    let document: Value = serde_json::from_str(&raw)
        .map_err(|error| CliError::Other(format!("relay info is malformed: {error}")))?;
    let value = document
        .get("self")
        .and_then(Value::as_str)
        .ok_or_else(|| CliError::Other("relay info is missing self pubkey".to_owned()))?;
    PublicKey::parse(value)
        .map_err(|error| CliError::Other(format!("relay self pubkey is invalid: {error}")))
}

/// Fetch one canonical head by coordinate.
///
/// Scoped to the relay signer: a head authored by anyone else is not canonical,
/// and reading one would defeat the single-author guarantee.
async fn fetch_head(
    client: &BuzzClient,
    kind: u32,
    id: &str,
    label: &str,
) -> Result<Event, CliError> {
    let relay = relay_self(client).await?;
    let events = client
        .query_paginated(
            json!({
                "kinds": [kind],
                "authors": [relay.to_hex()],
                "#d": [id],
                "limit": 1
            }),
            1,
        )
        .await?;
    let raw = events
        .into_iter()
        .next()
        .ok_or_else(|| CliError::NotFound(format!("{label} {id} not found")))?;
    Event::from_json(raw.to_string())
        .map_err(|error| CliError::Other(format!("{label} head is not a valid event: {error}")))
}

async fn get_company(client: &BuzzClient, id: &str) -> Result<(), CliError> {
    let event = fetch_head(client, KIND_COMPANY_PROFILE, id, "company").await?;
    let profile = parse_company_event(&event)
        .map_err(|error| CliError::Other(format!("company head is unreadable: {error}")))?;
    println!(
        "{}",
        serde_json::to_string(&profile)
            .map_err(|error| CliError::Other(format!("cannot serialize: {error}")))?
    );
    Ok(())
}

async fn get_initiative(client: &BuzzClient, id: &str) -> Result<(), CliError> {
    let event = fetch_head(client, KIND_INITIATIVE, id, "initiative").await?;
    let initiative = parse_initiative_event(&event)
        .map_err(|error| CliError::Other(format!("initiative head is unreadable: {error}")))?;
    println!(
        "{}",
        serde_json::to_string(&initiative)
            .map_err(|error| CliError::Other(format!("cannot serialize: {error}")))?
    );
    Ok(())
}

async fn get_task(client: &BuzzClient, id: &str) -> Result<(), CliError> {
    let event = fetch_head(client, KIND_TASK, id, "task").await?;
    let task = parse_task_event(&event)
        .map_err(|error| CliError::Other(format!("task head is unreadable: {error}")))?;
    println!(
        "{}",
        serde_json::to_string(&task)
            .map_err(|error| CliError::Other(format!("cannot serialize: {error}")))?
    );
    Ok(())
}

/// One string field of a parsed record, for scoping a relay answer the relay
/// could not scope itself.
fn json_field<'a>(value: &'a serde_json::Value, field: &str) -> Option<&'a str> {
    value.get(field).and_then(|found| found.as_str())
}

async fn list_initiatives(client: &BuzzClient, company: &str) -> Result<(), CliError> {
    let relay = relay_self(client).await?;
    let events = client
        .query_all(json!({
            "kinds": [KIND_INITIATIVE],
            "authors": [relay.to_hex()],
            "#c": [company]
        }))
        .await?;
    // Scoped twice on purpose. `#c` is the indexed tag the relay can actually
    // answer, and this narrows again in case the answer came from a head
    // written before that tag existed. Showing an owner another company's work
    // is worse than being slow.
    let initiatives: Vec<_> = parse_all(&events, parse_initiative_event)
        .into_iter()
        .filter(|initiative| json_field(initiative, "companyId") == Some(company))
        .collect();
    println!("{}", json!({ "initiatives": initiatives }));
    Ok(())
}

async fn list_tasks(
    client: &BuzzClient,
    company: Option<&str>,
    initiative: Option<&str>,
) -> Result<(), CliError> {
    let relay = relay_self(client).await?;
    let mut filter = json!({
        "kinds": [KIND_TASK],
        "authors": [relay.to_hex()]
    });
    match (company, initiative) {
        (None, None) => {
            return Err(CliError::Usage(
                "tasks list requires --company or --initiative".to_owned(),
            ))
        }
        _ => {
            if let Some(company) = company {
                filter["#c"] = json!([company]);
            }
            if let Some(initiative) = initiative {
                filter["#initiative"] = json!([initiative]);
            }
        }
    }
    let events = client.query_all(filter).await?;
    // `#c` is indexed and `#initiative` is not, so the initiative scope in
    // particular still has to be applied here.
    let tasks: Vec<_> = parse_all(&events, parse_task_event)
        .into_iter()
        .filter(|task| company.is_none_or(|company| json_field(task, "companyId") == Some(company)))
        .filter(|task| initiative.is_none_or(|id| json_field(task, "initiativeId") == Some(id)))
        .collect();
    println!("{}", json!({ "tasks": tasks }));
    Ok(())
}

/// Parse a batch of heads, dropping any the strict parser rejects.
///
/// A single unreadable head must not blank an entire listing; the caller sees
/// the records that are valid.
fn parse_all<T: serde::Serialize, E>(
    events: &[Value],
    parse: impl Fn(&Event) -> Result<T, E>,
) -> Vec<Value> {
    events
        .iter()
        .filter_map(|raw| {
            let event = Event::from_json(raw.to_string()).ok()?;
            let parsed = parse(&event).ok()?;
            serde_json::to_value(parsed).ok()
        })
        .collect()
}

/// Whether an existing head means this write is a replacement.
enum WriteTarget {
    Create,
    Replace { expected_head: String },
}

/// Read a complete entity payload from a JSON file.
///
/// Deliberately requires the WHOLE record, not a patch: heads are replaced
/// wholesale, and accepting partial input would silently drop fields the caller
/// forgot to include.
fn read_payload(file: &str) -> Result<CompanyActionPayload, CliError> {
    let raw = std::fs::read_to_string(file)
        .map_err(|error| CliError::Usage(format!("cannot read {file}: {error}")))?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|error| CliError::Usage(format!("{file} is not valid JSON: {error}")))?;
    let schema = value
        .get("schema")
        .and_then(Value::as_str)
        .ok_or_else(|| CliError::Usage(format!("{file} is missing a `schema` field")))?;
    match schema {
        "colony.company/v1" => serde_json::from_value::<CompanyProfile>(value.clone())
            .map(CompanyActionPayload::Company)
            .map_err(|error| CliError::Usage(format!("invalid company record: {error}"))),
        "colony.initiative/v1" => serde_json::from_value::<Initiative>(value.clone())
            .map(CompanyActionPayload::Initiative)
            .map_err(|error| CliError::Usage(format!("invalid initiative record: {error}"))),
        "colony.task/v1" => serde_json::from_value::<CompanyTask>(value.clone())
            .map(CompanyActionPayload::Task)
            .map_err(|error| CliError::Usage(format!("invalid task record: {error}"))),
        other => Err(CliError::Usage(format!("unsupported schema `{other}`"))),
    }
}

fn payload_kind(payload: &CompanyActionPayload) -> u32 {
    match payload {
        CompanyActionPayload::Company(_) => KIND_COMPANY_PROFILE,
        CompanyActionPayload::Initiative(_) => KIND_INITIATIVE,
        CompanyActionPayload::Task(_) => KIND_TASK,
        CompanyActionPayload::Cohort(_) => KIND_COHORT,
        CompanyActionPayload::Template(_) => KIND_TEMPLATE,
    }
}

fn payload_id(payload: &CompanyActionPayload) -> &str {
    match payload {
        CompanyActionPayload::Company(profile) => &profile.id,
        CompanyActionPayload::Initiative(initiative) => &initiative.id,
        CompanyActionPayload::Task(task) => &task.id,
        CompanyActionPayload::Cohort(cohort) => &cohort.id,
        CompanyActionPayload::Template(template) => &template.id,
    }
}

async fn put_from_file(client: &BuzzClient, file: &str) -> Result<(), CliError> {
    let payload = read_payload(file)?;
    publish_action(client, payload, None).await
}

/// Complete a Task by reading its current head, flipping only the status, and
/// asking the broker to replace it.
///
/// Reads first on purpose: every identity and ownership field is preserved from
/// what is actually stored, and the head it read becomes the compare-and-set
/// token, so a concurrent edit loses instead of being silently overwritten.
async fn complete_task(client: &BuzzClient, id: &str) -> Result<(), CliError> {
    let event = fetch_head(client, KIND_TASK, id, "task").await?;
    let mut task = parse_task_event(&event)
        .map_err(|error| CliError::Other(format!("task head is unreadable: {error}")))?;
    task.status = TaskStatus::Completed;
    task.updated_at = task.updated_at.max(chrono::Utc::now().timestamp());
    publish_action(
        client,
        CompanyActionPayload::Task(task),
        Some(event.id.to_hex()),
    )
    .await
}

/// Approve a blueprint: publish the company and its three proposed initiatives.
///
/// Every action carries an idempotency key derived from the approval, so
/// running this twice is a no-op at the relay rather than a second company.
/// That is what makes it safe to re-run after a network failure, which is the
/// case it exists for.
async fn approve_blueprint(
    client: &BuzzClient,
    file: &str,
    channel: &str,
    scope: Option<&str>,
) -> Result<(), CliError> {
    let raw = std::fs::read_to_string(file)
        .map_err(|error| CliError::Usage(format!("could not read {file}: {error}")))?;
    let blueprint = buzz_core::company_roster::parse_blueprint(&raw)
        .map_err(|error| CliError::Usage(error.to_string()))?;

    let relay = relay_self(client).await?.to_hex();
    let scope = scope.unwrap_or(&relay).to_owned();

    // Derived from the approval, not the clock: a retry has to rebuild
    // byte-identical events, and `now` would make every attempt a new one.
    let created_at = buzz_core::company_roster::approval_timestamp(&blueprint.request_id);

    let mut actions =
        vec![
            buzz_sdk::company_blueprint::company_action(&blueprint, &relay, created_at)
                .map_err(CliError::Usage)?,
        ];
    actions.extend(
        buzz_sdk::company_blueprint::initiative_actions(
            &blueprint, &scope, &relay, channel, created_at,
        )
        .map_err(CliError::Usage)?,
    );

    let mut results = Vec::with_capacity(actions.len());
    for action in &actions {
        let builder = build_company_action(action)
            .map_err(|error| CliError::Usage(format!("invalid company action: {error}")))?;
        let event = client.sign_event(builder)?;
        let event_id = event.id.to_hex();
        let response = client.submit_event(event).await?;
        let receipt = fetch_receipt(client, &event_id).await.ok();
        results.push(json!({
            "target": action.target,
            "event_id": event_id,
            "accepted": response_accepted(&response),
            "message": response_message(&response),
            "idempotency_key": action.idempotency_key,
            "receipt": receipt,
        }));
    }

    println!(
        "{}",
        json!({
            "company_id": blueprint.company.id,
            "request_id": blueprint.request_id,
            "blueprint_hash": buzz_core::company_roster::blueprint_hash(&blueprint),
            "actions": results,
        })
    );
    Ok(())
}

/// Publish one owner-signed Company Action and report the relay's answer.
async fn publish_action(
    client: &BuzzClient,
    payload: CompanyActionPayload,
    expected_head: Option<String>,
) -> Result<(), CliError> {
    let relay = relay_self(client).await?;
    let kind = payload_kind(&payload);
    let entity_id = payload_id(&payload).to_owned();

    // When the caller did not supply a CAS token, discover it: an existing head
    // makes this a replacement, its absence makes it a create. Getting this
    // wrong is not silently destructive — the broker refuses the mismatch.
    let target = match expected_head {
        Some(expected_head) => WriteTarget::Replace { expected_head },
        None => match fetch_head(client, kind, &entity_id, "record").await {
            Ok(event) => WriteTarget::Replace {
                expected_head: event.id.to_hex(),
            },
            Err(CliError::NotFound(_)) => WriteTarget::Create,
            Err(error) => return Err(error),
        },
    };
    let (operation, expected_head) = match target {
        WriteTarget::Create => (CompanyActionOperation::Create, None),
        WriteTarget::Replace { expected_head } => {
            (CompanyActionOperation::Update, Some(expected_head))
        }
    };

    let action = CompanyAction {
        relay_pubkey: relay.to_hex(),
        operation,
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        target: format!("{kind}:{}:{entity_id}", relay.to_hex()),
        expected_head,
        expected_references: Vec::new(),
        payload,
    };
    let builder = build_company_action(&action)
        .map_err(|error| CliError::Usage(format!("invalid company action: {error}")))?;
    let event = client.sign_event(builder)?;
    let event_id = event.id.to_hex();
    let response = client.submit_event(event).await?;

    let accepted = response_accepted(&response);
    // The action is only half the story: the relay signs a receipt naming the
    // outcome and the resulting head. Resolve it so callers act on the relay's
    // verdict rather than on transport acknowledgement.
    let receipt = fetch_receipt(client, &event_id).await.ok();
    println!(
        "{}",
        json!({
            "event_id": event_id,
            "accepted": accepted,
            "message": response_message(&response),
            "entity_id": entity_id,
            "request_id": action.request_id,
            "idempotency_key": action.idempotency_key,
            "receipt": receipt
        })
    );
    if accepted {
        Ok(())
    } else {
        // A refused action is a write conflict, not a transport failure: the
        // relay stored a receipt saying so. Strip the relay's own `conflict:`
        // prefix — CliError::Conflict adds one, and doubling it up reads as a
        // bug in the message rather than a clean explanation.
        let message = response_message(&response);
        let reason = message
            .strip_prefix("conflict: ")
            .unwrap_or(&message)
            .to_owned();
        Err(CliError::Conflict(reason))
    }
}

fn response_accepted(response: &str) -> bool {
    serde_json::from_str::<Value>(response)
        .ok()
        .and_then(|value| value.get("accepted").and_then(Value::as_bool))
        .unwrap_or(false)
}

fn response_message(response: &str) -> String {
    serde_json::from_str::<Value>(response)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| response.to_owned())
}

/// Fetch the relay-signed receipt linked to one action, if it has landed.
async fn fetch_receipt(client: &BuzzClient, action_event_id: &str) -> Result<Value, CliError> {
    let relay = relay_self(client).await?;
    let events = client
        .query_paginated(
            json!({
                "kinds": [KIND_COMPANY_RECEIPT],
                "authors": [relay.to_hex()],
                "#e": [action_event_id],
                "limit": 1
            }),
            1,
        )
        .await?;
    events
        .into_iter()
        .next()
        .ok_or_else(|| CliError::NotFound("company receipt not found".to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_schema_selects_the_matching_record_type() {
        let dir = std::env::temp_dir().join(format!("colony-cli-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");

        let company = dir.join("company.json");
        std::fs::write(
            &company,
            serde_json::to_string(&json!({
                "schema": "colony.company/v1",
                "id": "horizon-labs",
                "tradingName": "Horizon Labs",
                "legalName": null,
                "website": null,
                "summary": "Digital services",
                "businessType": "agency",
                "services": [],
                "customerSegments": [],
                "costCentres": [],
                "sourceReportEventId": null,
                "onboardingStatus": "draft",
                "createdAt": 1000,
                "updatedAt": 1000
            }))
            .expect("json"),
        )
        .expect("write");
        let parsed = read_payload(company.to_str().expect("path")).expect("parse company");
        assert_eq!(payload_kind(&parsed), KIND_COMPANY_PROFILE);
        assert_eq!(payload_id(&parsed), "horizon-labs");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unknown_schema_is_a_usage_error_not_a_silent_default() {
        let dir = std::env::temp_dir().join(format!("colony-cli-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("thing.json");
        std::fs::write(&path, r#"{"schema":"something/v9"}"#).expect("write");

        let error = read_payload(path.to_str().expect("path")).expect_err("unknown schema");
        assert!(
            matches!(error, CliError::Usage(message) if message.contains("unsupported schema")),
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_schema_field_is_rejected() {
        let dir = std::env::temp_dir().join(format!("colony-cli-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("thing.json");
        std::fs::write(&path, r#"{"id":"x"}"#).expect("write");

        let error = read_payload(path.to_str().expect("path")).expect_err("missing schema");
        assert!(matches!(error, CliError::Usage(message) if message.contains("`schema`")));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_response_parsing_defaults_to_not_accepted() {
        assert!(response_accepted(r#"{"accepted":true}"#));
        assert!(!response_accepted(r#"{"accepted":false}"#));
        // An unparseable response must never read as success.
        assert!(!response_accepted("not json"));
        assert_eq!(response_message(r#"{"message":"saved"}"#), "saved");
    }
}
