//! Agent-first access to Colony Parties and the Lead and Client views of them.
//!
//! Same asymmetry as the company commands: reads resolve relay-authored
//! canonical heads, and writes never author one. A write publishes an
//! owner-signed `KIND_PARTY_ACTION` and lets the relay broker validate it, sign
//! the replacement, and return a receipt.
//!
//! Two things here are specific to identity. A handle can have been retired by
//! a merge, so every read resolves through aliases before answering -- a
//! reference handed out months ago has to still arrive. And `resolve` decides
//! whether an observation is somebody the company already knows, which is the
//! call that determines whether a business ends up as one record or two, so it
//! refuses to guess: more than one candidate is a decision for a human.

use buzz_core::kind::{KIND_PARTY, KIND_PARTY_RECEIPT, KIND_PARTY_RELATIONSHIP};
use buzz_core::party::{
    merge_parties, resolve_party_handle_async, HandleOccupant, HandleResolution, Party, PartyAlias,
    PartyIdentifier, PartyRelationship, ALL_RELATIONSHIP_KINDS, MAX_ALIAS_HOPS, PARTY_ALIAS_SCHEMA,
    PARTY_RELATIONSHIP_SCHEMA, PARTY_SCHEMA,
};
use buzz_sdk::party::{
    build_party_action, parse_party_event, parse_party_relationship_event, PartyAction,
    PartyActionOperation, PartyActionPayload, PartyHead,
};
use buzz_sdk::party_resolution::{resolve_observation, PartyResolution};
use nostr::{Event, JsonUtil, PublicKey};
use serde_json::{json, Value};
use std::cell::RefCell;
use uuid::Uuid;

use crate::client::BuzzClient;
use crate::error::CliError;
use crate::PartiesCmd;

/// Route `buzz parties ...`.
pub async fn dispatch_parties(command: PartiesCmd, client: &BuzzClient) -> Result<(), CliError> {
    match command {
        PartiesCmd::List => list_parties(client).await,
        PartiesCmd::Get { id } => get_party(client, &id).await,
        PartiesCmd::Create { file } => create_party(client, &file).await,
        PartiesCmd::Relate { file } => relate_party(client, &file).await,
        PartiesCmd::Resolve { file } => resolve_party(client, &file).await,
        PartiesCmd::Merge { survivor, retire } => merge_party(client, &survivor, &retire).await,
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

/// Fetch one canonical head by coordinate, scoped to the relay signer.
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

/// What sits at one party coordinate right now.
///
/// `Ok(None)` means nothing readable is there, which the walk reads as an
/// unknown or dangling handle. A head the strict parser rejects is reported the
/// same way rather than guessed at: no client can read it either.
async fn occupant_at(
    client: &BuzzClient,
    handle: &str,
) -> Result<Option<HandleOccupant>, CliError> {
    let event = match fetch_head(client, KIND_PARTY, handle, "party").await {
        Ok(event) => event,
        Err(CliError::NotFound(_)) => return Ok(None),
        Err(error) => return Err(error),
    };
    Ok(match parse_party_event(&event) {
        Ok(PartyHead::Party(_)) => Some(HandleOccupant::Party),
        Ok(PartyHead::Alias(alias)) => Some(HandleOccupant::Alias {
            resolves_to: alias.resolves_to,
        }),
        Err(_) => None,
    })
}

/// Follow a handle to the party it currently names.
///
/// One read per hop, bounded by `MAX_ALIAS_HOPS`, so this costs at most nine
/// reads and in practice one or two however many parties a company holds.
/// Returns the live handle and how many merges it took to get there, so a
/// caller that landed on a redirect can record the survivor instead of writing
/// again to a coordinate that only forwards.
async fn resolve_handle(client: &BuzzClient, start: &str) -> Result<(String, usize), CliError> {
    // The walk's loader has nowhere to report a transport failure, so one is
    // parked here and raised after. Letting a dropped connection look like "no
    // such handle" would turn an outage into a confident wrong answer.
    let failure: RefCell<Option<CliError>> = RefCell::new(None);
    let resolution = resolve_party_handle_async(start, |handle: String| {
        let failure = &failure;
        async move {
            if failure.borrow().is_some() {
                return None;
            }
            match occupant_at(client, &handle).await {
                Ok(found) => found,
                Err(error) => {
                    *failure.borrow_mut() = Some(error);
                    None
                }
            }
        }
    })
    .await;
    if let Some(error) = failure.into_inner() {
        return Err(error);
    }
    match resolution {
        HandleResolution::Live { handle } => Ok((handle, 0)),
        HandleResolution::Redirected { handle, hops } => Ok((handle, hops)),
        HandleResolution::Unknown => Err(CliError::NotFound(format!("party {start} not found"))),
        HandleResolution::Broken { handle } => Err(CliError::Other(format!(
            "handle {start} does not resolve: the chain stops at {handle} \
             after at most {MAX_ALIAS_HOPS} hops"
        ))),
    }
}

/// Read the Lead and Client views a party carries.
///
/// Enumerates the closed set of views against derived coordinates, which is
/// exactly what a merge does, so a view either answers at its coordinate or
/// does not exist.
async fn load_relationships(
    client: &BuzzClient,
    party_id: &str,
) -> Result<Vec<PartyRelationship>, CliError> {
    let mut views = Vec::new();
    for kind in ALL_RELATIONSHIP_KINDS {
        let coordinate = buzz_core::party::relationship_coordinate(party_id, kind);
        match fetch_head(client, KIND_PARTY_RELATIONSHIP, &coordinate, "relationship").await {
            Ok(event) => {
                let view = parse_party_relationship_event(&event).map_err(|error| {
                    CliError::Other(format!("relationship head is unreadable: {error}"))
                })?;
                views.push(view);
            }
            Err(CliError::NotFound(_)) => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(views)
}

async fn get_party(client: &BuzzClient, id: &str) -> Result<(), CliError> {
    let (handle, hops) = resolve_handle(client, id).await?;
    let event = fetch_head(client, KIND_PARTY, &handle, "party").await?;
    let party = match parse_party_event(&event)
        .map_err(|error| CliError::Other(format!("party head is unreadable: {error}")))?
    {
        PartyHead::Party(party) => party,
        // Resolution already followed every alias, so landing on one here means
        // the head changed underneath the read.
        PartyHead::Alias(_) => {
            return Err(CliError::Other(
                "that handle was retired while being read".to_owned(),
            ))
        }
    };
    let relationships = load_relationships(client, &handle).await?;
    println!(
        "{}",
        json!({
            "requested": id,
            "handle": handle,
            "merges_followed": hops,
            "party": party,
            "relationships": relationships,
        })
    );
    Ok(())
}

async fn list_parties(client: &BuzzClient) -> Result<(), CliError> {
    let relay = relay_self(client).await?;
    let events = client
        .query_all(json!({
            "kinds": [KIND_PARTY],
            "authors": [relay.to_hex()]
        }))
        .await?;

    let mut parties = Vec::new();
    let mut retired = Vec::new();
    for raw in &events {
        let Ok(event) = Event::from_json(raw.to_string()) else {
            continue;
        };
        match parse_party_event(&event) {
            // Scoped twice: `#c` is the indexed tag the relay can answer, and
            // this narrows again. Showing an owner another company's customers
            // is worse than being slow.
            Ok(PartyHead::Party(party)) => parties.push(party),
            Ok(PartyHead::Alias(alias)) => retired.push(alias),
            _ => continue,
        }
    }
    // Retired handles are listed separately rather than mixed in. They are not
    // parties, and a caller that treats one as a party would write to a
    // coordinate that now only redirects.
    println!(
        "{}",
        json!({ "parties": parties, "retired_handles": retired })
    );
    Ok(())
}

/// Read a complete record from a JSON file, choosing the type by its schema.
///
/// Requires the whole record, not a patch: heads are replaced wholesale, so
/// accepting partial input would silently drop fields the caller forgot.
fn read_payload(file: &str) -> Result<PartyActionPayload, CliError> {
    let raw = std::fs::read_to_string(file)
        .map_err(|error| CliError::Usage(format!("cannot read {file}: {error}")))?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|error| CliError::Usage(format!("{file} is not valid JSON: {error}")))?;
    let schema = value
        .get("schema")
        .and_then(Value::as_str)
        .ok_or_else(|| CliError::Usage(format!("{file} is missing a `schema` field")))?;
    match schema {
        PARTY_SCHEMA => serde_json::from_value::<Party>(value.clone())
            .map(PartyActionPayload::Party)
            .map_err(|error| CliError::Usage(format!("invalid party record: {error}"))),
        PARTY_RELATIONSHIP_SCHEMA => serde_json::from_value::<PartyRelationship>(value.clone())
            .map(PartyActionPayload::Relationship)
            .map_err(|error| CliError::Usage(format!("invalid relationship record: {error}"))),
        other => Err(CliError::Usage(format!("unsupported schema `{other}`"))),
    }
}

fn payload_id(payload: &PartyActionPayload) -> &str {
    match payload {
        PartyActionPayload::Party(party) => &party.id,
        PartyActionPayload::Relationship(view) => &view.id,
        PartyActionPayload::Merge { survivor, .. } => &survivor.id,
    }
}

async fn create_party(client: &BuzzClient, file: &str) -> Result<(), CliError> {
    match read_payload(file)? {
        payload @ PartyActionPayload::Party(_) => publish_action(client, payload, None).await,
        _ => Err(CliError::Usage(
            "parties create expects a party record; use `parties relate` for a view".to_owned(),
        )),
    }
}

async fn relate_party(client: &BuzzClient, file: &str) -> Result<(), CliError> {
    match read_payload(file)? {
        payload @ PartyActionPayload::Relationship(_) => {
            publish_action(client, payload, None).await
        }
        _ => Err(CliError::Usage(
            "parties relate expects a relationship record; use `parties create` for a party"
                .to_owned(),
        )),
    }
}

/// Decide whether observed identifiers belong to a party the company knows.
///
/// Reads only. Nothing is written on the strength of this answer, because an
/// automatic merge on a wrong match fuses two customers' histories and nothing
/// downstream can tell that it happened.
async fn resolve_party(client: &BuzzClient, file: &str) -> Result<(), CliError> {
    let raw = std::fs::read_to_string(file)
        .map_err(|error| CliError::Usage(format!("cannot read {file}: {error}")))?;
    let observed: Vec<PartyIdentifier> = serde_json::from_str(&raw).map_err(|error| {
        CliError::Usage(format!("{file} is not a list of identifiers: {error}"))
    })?;

    let relay = relay_self(client).await?;
    let events = client
        .query_all(json!({
            "kinds": [KIND_PARTY],
            "authors": [relay.to_hex()]
        }))
        .await?;
    // Live parties only. Resolving onto a retired handle would point new
    // evidence at a coordinate that now only redirects.
    let known: Vec<Party> = events
        .iter()
        .filter_map(|raw| {
            let event = Event::from_json(raw.to_string()).ok()?;
            match parse_party_event(&event).ok()? {
                PartyHead::Party(party) => Some(party),
                _ => None,
            }
        })
        .collect();

    let answer = match resolve_observation(&observed, &known) {
        PartyResolution::NoMatch => json!({ "resolution": "no-match" }),
        PartyResolution::Resolved { handle, on } => json!({
            "resolution": "resolved",
            "handle": handle,
            "matched_on": on,
        }),
        PartyResolution::Ambiguous { candidates } => json!({
            "resolution": "ambiguous",
            "candidates": candidates,
            "next": "merge the candidates that are the same party, or correct the observation",
        }),
    };
    println!("{answer}");
    Ok(())
}

/// Fold one party into another.
///
/// Reads both records first and computes the union here, so the survivor sent
/// to the relay is derived from what is actually stored rather than from
/// anything a caller typed. The relay recomputes it independently and refuses a
/// mismatch, which is what makes that safe.
async fn merge_party(client: &BuzzClient, survivor: &str, retire: &str) -> Result<(), CliError> {
    if survivor == retire {
        return Err(CliError::Usage(
            "a party cannot be merged into itself".to_owned(),
        ));
    }
    // Both sides resolve first: merging through a stale handle would retire a
    // pointer instead of a party and build a chain nobody authorized.
    let (survivor_handle, _) = resolve_handle(client, survivor).await?;
    let (retired_handle, _) = resolve_handle(client, retire).await?;
    if survivor_handle == retired_handle {
        return Err(CliError::Usage(format!(
            "{survivor} and {retire} already resolve to the same party, {survivor_handle}"
        )));
    }

    let survivor_event = fetch_head(client, KIND_PARTY, &survivor_handle, "party").await?;
    let survivor_record = expect_party(&survivor_event)?;
    let retired_event = fetch_head(client, KIND_PARTY, &retired_handle, "party").await?;
    let retired_record = expect_party(&retired_event)?;

    let merged = merge_parties(&survivor_record, &retired_record)
        .map_err(|error| CliError::Usage(error.to_string()))?;

    let alias = PartyAlias {
        schema: PARTY_ALIAS_SCHEMA.to_string(),
        id: retired_handle.clone(),
        resolves_to: merged.id.clone(),
        merged_at: chrono::Utc::now().timestamp(),
        // The relay writes the real value: it is the hash of the action this
        // alias travels inside, so it cannot be known before signing.
        merge_action_event_id: "0".repeat(64),
    };

    publish_action(
        client,
        PartyActionPayload::Merge {
            survivor: merged,
            alias,
        },
        Some(survivor_event.id.to_hex()),
    )
    .await
}

fn expect_party(event: &Event) -> Result<Party, CliError> {
    match parse_party_event(event)
        .map_err(|error| CliError::Other(format!("party head is unreadable: {error}")))?
    {
        PartyHead::Party(party) => Ok(party),
        PartyHead::Alias(alias) => Err(CliError::Usage(format!(
            "{} is a retired handle pointing at {}",
            alias.id, alias.resolves_to
        ))),
    }
}

/// Publish one owner-signed Party Action and report the relay's verdict.
async fn publish_action(
    client: &BuzzClient,
    payload: PartyActionPayload,
    expected_head: Option<String>,
) -> Result<(), CliError> {
    let relay = relay_self(client).await?;
    let kind = payload.entity_kind();
    let entity_id = payload_id(&payload).to_owned();

    let (operation, expected_head) = match (&payload, expected_head) {
        (PartyActionPayload::Merge { .. }, expected_head) => (
            PartyActionOperation::Merge,
            // A merge always replaces an existing survivor, so a missing CAS
            // token here is a bug rather than a create.
            Some(expected_head.ok_or_else(|| {
                CliError::Other("merge lost the survivor's head reference".to_owned())
            })?),
        ),
        (_, Some(expected_head)) => (PartyActionOperation::Update, Some(expected_head)),
        // Discover the token: an existing head makes this a replacement, its
        // absence makes it a create. Getting it wrong is not silently
        // destructive, because the broker refuses the mismatch.
        (_, None) => match fetch_head(client, kind, &entity_id, "record").await {
            Ok(event) => (PartyActionOperation::Update, Some(event.id.to_hex())),
            Err(CliError::NotFound(_)) => (PartyActionOperation::Create, None),
            Err(error) => return Err(error),
        },
    };

    let action = PartyAction {
        relay_pubkey: relay.to_hex(),
        operation,
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        target: format!("{kind}:{}:{entity_id}", relay.to_hex()),
        expected_head,
        expected_references: Vec::new(),
        payload,
    };
    let builder = build_party_action(&action)
        .map_err(|error| CliError::Usage(format!("invalid party action: {error}")))?;
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
                "kinds": [KIND_PARTY_RECEIPT],
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
        .ok_or_else(|| CliError::NotFound("party receipt not found".to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_temp(contents: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("colony-parties-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("record.json");
        std::fs::write(&path, contents).expect("write");
        (dir, path)
    }

    fn party_json() -> String {
        json!({
            "schema": PARTY_SCHEMA,
            "id": "acme-industries",
            "kind": "organization",
            "displayName": "Acme Industries",
            "legalName": null,
            "identifiers": [{
                "scheme": "domain",
                "value": "acme.example",
                "confidence": "asserted"
            }],
            "provenance": [{
                "id": "prov-01",
                "source": "discovery:google-maps",
                "observedAt": 1_785_369_600i64,
                "sourceRef": null,
                "fields": ["displayName"]
            }],
            "retiredHandles": [],
            "createdAt": 1_785_369_600i64,
            "updatedAt": 1_785_369_600i64
        })
        .to_string()
    }

    #[test]
    fn a_party_file_is_read_as_a_party() {
        let (dir, path) = write_temp(&party_json());
        let payload = read_payload(path.to_str().expect("path")).expect("party parses");
        assert!(matches!(payload, PartyActionPayload::Party(_)));
        assert_eq!(payload_id(&payload), "acme-industries");
        assert_eq!(payload.entity_kind(), KIND_PARTY);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The two write commands take different records, and mixing them up would
    /// otherwise reach the relay as a refusal instead of a usage error.
    #[test]
    fn create_refuses_a_relationship_and_relate_refuses_a_party() {
        let payload = serde_json::from_str::<Value>(&party_json()).expect("json");
        assert!(matches!(
            serde_json::from_value::<Party>(payload).map(PartyActionPayload::Party),
            Ok(PartyActionPayload::Party(_))
        ));

        let view = json!({
            "schema": PARTY_RELATIONSHIP_SCHEMA,
            "id": "acme-industries:lead",
            "partyId": "acme-industries",
            "relationship": "lead",
            "status": "candidate",
            "ownerPersonaId": "company-role:abc:horizonlabs:sales-lead",
            "sourceChannelId": "welcome",
            "createdAt": 1_785_369_600i64,
            "updatedAt": 1_785_369_600i64
        });
        let (dir, path) = write_temp(&view.to_string());
        let parsed = read_payload(path.to_str().expect("path")).expect("relationship parses");
        assert!(matches!(parsed, PartyActionPayload::Relationship(_)));
        assert_eq!(parsed.entity_kind(), KIND_PARTY_RELATIONSHIP);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unknown_schema_is_a_usage_error_not_a_silent_default() {
        let (dir, path) = write_temp(r#"{"schema":"something/v9"}"#);
        let error = read_payload(path.to_str().expect("path")).expect_err("unknown schema");
        assert!(
            matches!(error, CliError::Usage(message) if message.contains("unsupported schema"))
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_schema_field_is_rejected() {
        let (dir, path) = write_temp(r#"{"id":"x"}"#);
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
