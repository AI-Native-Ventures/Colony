//! Owner-signable Colony party envelopes and strict relay-authored head parsers.
//!
//! Same split as `company`: the owner signs a request, the relay signs the head
//! and a receipt naming it, and no client ever signs a head directly. The tag
//! layout is validated exactly on both sides, so a head the relay wrote is
//! always one this parser can read back.
//!
//! The tag-shape helpers here are local rather than shared with `company`. They
//! are cardinality checks over a fixed tag list, and the thing that genuinely
//! diverges between two implementations — the canonical JSON encoding — is
//! already shared: both call `buzz_core::block::canonical_json`.

use buzz_core::{
    block::canonical_json,
    kind::{KIND_PARTY, KIND_PARTY_ACTION, KIND_PARTY_RECEIPT, KIND_PARTY_RELATIONSHIP},
    party::{
        validate_alias, validate_party, Party, PartyAlias, PartyContractError, PartyRelationship,
        PARTY_ALIAS_SCHEMA, PARTY_RELATIONSHIP_SCHEMA, PARTY_SCHEMA,
    },
};
use nostr::{Event, EventBuilder, Kind, Tag};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

const ACTION_SCHEMA: &str = "colony.party-action/v1";
const RECEIPT_SCHEMA: &str = "colony.party-receipt/v1";

/// Mutation requested by the current company owner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PartyActionOperation {
    /// Create the first head at a stable coordinate.
    Create,
    /// Replace an existing head without changing lifecycle state.
    Update,
    /// Replace an existing head while applying a lifecycle transition.
    Transition,
    /// Fold one party into another, writing a survivor and an alias together.
    Merge,
}

impl PartyActionOperation {
    fn as_tag_value(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Update => "update",
            Self::Transition => "transition",
            Self::Merge => "merge",
        }
    }

    fn parse_tag(value: &str) -> Result<Self, PartySdkError> {
        match value {
            "create" => Ok(Self::Create),
            "update" => Ok(Self::Update),
            "transition" => Ok(Self::Transition),
            "merge" => Ok(Self::Merge),
            _ => Err(PartySdkError::InvalidEnvelope("party action")),
        }
    }
}

/// Full typed payload carried by a party action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "record",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum PartyActionPayload {
    /// A complete canonical party.
    Party(Party),
    /// A complete Lead or Client relationship.
    Relationship(PartyRelationship),
    /// The result of folding one party into another.
    ///
    /// Both halves travel together because a survivor without its alias would
    /// strand every reference to the retired handle, and an alias without its
    /// survivor would point at a record that never absorbed anything.
    Merge {
        /// The party that survived, already carrying the merged claims.
        survivor: Party,
        /// The pointer the retired handle leaves behind.
        alias: PartyAlias,
    },
}

impl PartyActionPayload {
    /// The relay-authored kind this payload's head lives at.
    pub fn entity_kind(&self) -> u32 {
        match self {
            Self::Party(_) | Self::Merge { .. } => KIND_PARTY,
            Self::Relationship(_) => KIND_PARTY_RELATIONSHIP,
        }
    }

    /// The stable coordinate identifier this payload writes.
    pub fn entity_id(&self) -> &str {
        match self {
            Self::Party(party) => &party.id,
            Self::Relationship(relationship) => &relationship.id,
            Self::Merge { survivor, .. } => &survivor.id,
        }
    }
}

/// Compare-and-set reference that must still resolve to one exact event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PartyExpectedReference {
    /// NIP-33 coordinate whose current head is expected.
    pub target: String,
    /// Lowercase event ID expected at that coordinate.
    pub event_id: String,
}

/// Owner-signable request to create or replace relay-authored party state.
#[derive(Debug, Clone, PartialEq)]
pub struct PartyAction {
    /// Tenant relay public key that must author the resulting head.
    pub relay_pubkey: String,
    /// Requested mutation.
    pub operation: PartyActionOperation,
    /// Stable UUID identifying this logical request.
    pub request_id: Uuid,
    /// Stable UUID making retries idempotent.
    pub idempotency_key: Uuid,
    /// Target relay-authored coordinate.
    pub target: String,
    /// Current head required for update, transition, and merge.
    pub expected_head: Option<String>,
    /// Other records that must still resolve to exact event IDs.
    pub expected_references: Vec<PartyExpectedReference>,
    /// Complete desired state.
    pub payload: PartyActionPayload,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PartyActionContent {
    schema: String,
    operation: PartyActionOperation,
    request_id: Uuid,
    idempotency_key: Uuid,
    target: String,
    expected_head: Option<String>,
    expected_references: Vec<PartyExpectedReference>,
    payload: PartyActionPayload,
}

/// Outcome reported by a relay-authored party receipt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PartyReceiptOutcome {
    /// The relay applied the requested head.
    Applied,
    /// The request actor or payload was rejected.
    Rejected,
    /// A compare-and-set expectation no longer matched.
    Conflict,
    /// Processing failed without applying a head.
    Failed,
}

impl PartyReceiptOutcome {
    /// The exact stable value carried in the receipt tuple.
    pub const fn as_tag_value(self) -> &'static str {
        match self {
            Self::Applied => "applied",
            Self::Rejected => "rejected",
            Self::Conflict => "conflict",
            Self::Failed => "failed",
        }
    }

    fn parse_tag(value: &str) -> Result<Self, PartySdkError> {
        match value {
            "applied" => Ok(Self::Applied),
            "rejected" => Ok(Self::Rejected),
            "conflict" => Ok(Self::Conflict),
            "failed" => Ok(Self::Failed),
            _ => Err(PartySdkError::InvalidEnvelope("party receipt")),
        }
    }
}

/// Public projection of a relay-authored party receipt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartyReceipt {
    /// Owner public key copied into the receipt audience tag.
    pub actor_pubkey: String,
    /// Exact owner-signed action the relay processed.
    pub action_event_id: String,
    /// Stable relay-authored target coordinate.
    pub target: String,
    /// Logical request UUID copied from the action.
    pub request_id: Uuid,
    /// Idempotency UUID copied from the action.
    pub idempotency_key: Uuid,
    /// Relay processing result.
    pub outcome: PartyReceiptOutcome,
    /// Resulting head event when the action was applied.
    pub head_event_id: Option<String>,
}

/// What a relay-authored `KIND_PARTY` coordinate currently holds.
///
/// A retired handle keeps its coordinate and starts holding a pointer instead,
/// so a reader always gets a definite answer rather than a miss.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PartyHead {
    /// A canonical party.
    Party(Party),
    /// A pointer left behind by a merge.
    Alias(PartyAlias),
}

/// Display-safe failure while building or parsing a Colony party event.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PartySdkError {
    /// The event kind does not match the requested contract.
    #[error("unexpected event kind: expected {expected}, got {actual}")]
    UnexpectedKind {
        /// Required Nostr kind.
        expected: u32,
        /// Kind found on the event.
        actual: u32,
    },
    /// A controlled tag is missing, duplicated, or malformed.
    #[error("invalid {0} tag cardinality or shape")]
    InvalidTag(&'static str),
    /// The exact public envelope contains an extra tag.
    #[error("unexpected tag on {0} event")]
    UnexpectedTag(&'static str),
    /// Public tags and signed content do not describe the same record.
    #[error("{0} tags and content do not match")]
    TagContentMismatch(&'static str),
    /// Signed JSON content is malformed, non-canonical, or unsupported.
    #[error("invalid {0} event content")]
    InvalidContent(&'static str),
    /// A self-contained envelope field is malformed or inconsistent.
    #[error("invalid {0} envelope")]
    InvalidEnvelope(&'static str),
    /// The core party contract rejected the record.
    #[error("invalid party contract: {0}")]
    Contract(#[from] PartyContractError),
}

fn tag(parts: &[&str], label: &'static str) -> Result<Tag, PartySdkError> {
    Tag::parse(parts.iter().copied()).map_err(|_| PartySdkError::InvalidTag(label))
}

fn encode<T: Serialize>(value: &T, entity: &'static str) -> Result<String, PartySdkError> {
    let value = serde_json::to_value(value).map_err(|_| PartySdkError::InvalidContent(entity))?;
    canonical_json(&value).map_err(|_| PartySdkError::InvalidContent(entity))
}

fn decode<T: serde::de::DeserializeOwned>(
    content: &str,
    entity: &'static str,
) -> Result<T, PartySdkError> {
    let value: serde_json::Value =
        serde_json::from_str(content).map_err(|_| PartySdkError::InvalidContent(entity))?;
    // Re-encoding and comparing is what catches a record that parses but was
    // not written by the encoder both sides agree on.
    if canonical_json(&value).map_err(|_| PartySdkError::InvalidContent(entity))? != content {
        return Err(PartySdkError::InvalidContent(entity));
    }
    serde_json::from_value(value).map_err(|_| PartySdkError::InvalidContent(entity))
}

fn require_kind(event: &Event, expected: u32) -> Result<(), PartySdkError> {
    let actual = u32::from(event.kind.as_u16());
    if actual == expected {
        Ok(())
    } else {
        Err(PartySdkError::UnexpectedKind { expected, actual })
    }
}

fn tag_values<'a>(event: &'a Event, name: &str) -> Vec<&'a str> {
    event
        .tags
        .iter()
        .filter_map(|candidate| {
            let parts = candidate.as_slice();
            (parts.len() == 2 && parts[0] == name).then(|| parts[1].as_str())
        })
        .collect()
}

fn required_scalar<'a>(
    event: &'a Event,
    name: &str,
    label: &'static str,
) -> Result<&'a str, PartySdkError> {
    let values = tag_values(event, name);
    let total = event
        .tags
        .iter()
        .filter(|candidate| candidate.as_slice().first().map(String::as_str) == Some(name))
        .count();
    if values.len() == 1 && total == 1 {
        Ok(values[0])
    } else {
        Err(PartySdkError::InvalidTag(label))
    }
}

fn require_exact_tag_names(
    event: &Event,
    required: &[&str],
    label: &'static str,
) -> Result<(), PartySdkError> {
    if event.tags.len() != required.len() {
        return Err(PartySdkError::UnexpectedTag(label));
    }
    for name in required {
        if event
            .tags
            .iter()
            .filter(|candidate| candidate.as_slice().first().map(String::as_str) == Some(*name))
            .count()
            != 1
        {
            return Err(PartySdkError::InvalidTag(label));
        }
    }
    Ok(())
}

fn require_head_tags(
    event: &Event,
    required: &[&str],
    repeatable: &[&str],
    label: &'static str,
) -> Result<(), PartySdkError> {
    for name in required {
        if event
            .tags
            .iter()
            .filter(|candidate| candidate.as_slice().first().map(String::as_str) == Some(*name))
            .count()
            != 1
        {
            return Err(PartySdkError::InvalidTag(label));
        }
    }
    for candidate in event.tags.iter() {
        let Some(name) = candidate.as_slice().first().map(String::as_str) else {
            return Err(PartySdkError::UnexpectedTag(label));
        };
        if !required.contains(&name) && !repeatable.contains(&name) {
            return Err(PartySdkError::UnexpectedTag(label));
        }
    }
    Ok(())
}

fn ensure_matches(record: &str, tagged: &str, label: &'static str) -> Result<(), PartySdkError> {
    if record == tagged {
        Ok(())
    } else {
        Err(PartySdkError::TagContentMismatch(label))
    }
}

fn validate_action(action: &PartyAction) -> Result<(), PartySdkError> {
    match &action.payload {
        PartyActionPayload::Party(party) => validate_party(party)?,
        PartyActionPayload::Relationship(_) => {}
        PartyActionPayload::Merge { survivor, alias } => {
            validate_party(survivor)?;
            validate_alias(alias)?;
            if alias.resolves_to != survivor.id {
                return Err(PartySdkError::TagContentMismatch("party merge"));
            }
            if !survivor.retired_handles.contains(&alias.id) {
                return Err(PartySdkError::TagContentMismatch("party merge"));
            }
        }
    }

    let expected_target = format!(
        "{}:{}:{}",
        action.payload.entity_kind(),
        action.relay_pubkey,
        action.payload.entity_id()
    );
    if action.target != expected_target {
        return Err(PartySdkError::InvalidEnvelope("party action"));
    }

    // Create asserts no head; everything else replaces one it names.
    match (action.operation, action.expected_head.as_deref()) {
        (PartyActionOperation::Create, Some(_)) => {
            return Err(PartySdkError::InvalidEnvelope("party action"))
        }
        (
            PartyActionOperation::Update
            | PartyActionOperation::Transition
            | PartyActionOperation::Merge,
            None,
        ) => return Err(PartySdkError::InvalidEnvelope("party action")),
        _ => {}
    }

    if matches!(action.operation, PartyActionOperation::Merge)
        != matches!(action.payload, PartyActionPayload::Merge { .. })
    {
        return Err(PartySdkError::InvalidEnvelope("party action"));
    }
    Ok(())
}

/// Build the exact three-tag, owner-signable party action envelope.
pub fn build_party_action(action: &PartyAction) -> Result<EventBuilder, PartySdkError> {
    validate_action(action)?;
    let content = PartyActionContent {
        schema: ACTION_SCHEMA.to_owned(),
        operation: action.operation,
        request_id: action.request_id,
        idempotency_key: action.idempotency_key,
        target: action.target.clone(),
        expected_head: action.expected_head.clone(),
        expected_references: action.expected_references.clone(),
        payload: action.payload.clone(),
    };
    let request_id = action.request_id.to_string();
    let idempotency_key = action.idempotency_key.to_string();
    let tags = [
        tag(&["p", &action.relay_pubkey], "p")?,
        tag(&["a", &action.target], "a")?,
        tag(
            &[
                "party-action",
                "1",
                action.operation.as_tag_value(),
                &request_id,
                &idempotency_key,
            ],
            "party-action",
        )?,
    ];
    Ok(EventBuilder::new(
        Kind::Custom(KIND_PARTY_ACTION as u16),
        encode(&content, "party action")?,
    )
    .tags(tags))
}

/// Parse the exact owner-signable party action envelope.
///
/// Signature validity and owner authorization remain relay concerns.
pub fn parse_party_action(event: &Event) -> Result<PartyAction, PartySdkError> {
    require_kind(event, KIND_PARTY_ACTION)?;
    require_exact_tag_names(event, &["p", "a", "party-action"], "party action")?;
    let relay_pubkey = required_scalar(event, "p", "p")?.to_owned();
    let target = required_scalar(event, "a", "a")?.to_owned();

    let tuple = event
        .tags
        .iter()
        .find(|candidate| candidate.as_slice().first().map(String::as_str) == Some("party-action"))
        .map(nostr::Tag::as_slice)
        .ok_or(PartySdkError::InvalidTag("party-action"))?;
    if tuple.len() != 5 || tuple[1] != "1" {
        return Err(PartySdkError::InvalidTag("party-action"));
    }
    let operation = PartyActionOperation::parse_tag(&tuple[2])?;

    let content: PartyActionContent = decode(&event.content, "party action")?;
    if content.schema != ACTION_SCHEMA {
        return Err(PartySdkError::InvalidContent("party action"));
    }
    if content.operation != operation
        || content.request_id.to_string() != tuple[3]
        || content.idempotency_key.to_string() != tuple[4]
        || content.target != target
    {
        return Err(PartySdkError::TagContentMismatch("party action"));
    }

    let action = PartyAction {
        relay_pubkey,
        operation: content.operation,
        request_id: content.request_id,
        idempotency_key: content.idempotency_key,
        target: content.target,
        expected_head: content.expected_head,
        expected_references: content.expected_references,
        payload: content.payload,
    };
    validate_action(&action)?;
    Ok(action)
}

/// The exact tags a relay-authored party head carries.
pub fn party_head_tags(party: &Party) -> Result<Vec<Tag>, PartySdkError> {
    let mut tags = vec![
        tag(&["d", &party.id], "d")?,
        tag(
            &[
                "party-kind",
                match party.kind {
                    buzz_core::party::PartyKind::Organization => "organization",
                    buzz_core::party::PartyKind::Person => "person",
                },
            ],
            "party-kind",
        )?,
    ];
    // One `identifier` tag per claim, so a Discovery run can find an existing
    // party by domain or email without scanning every head.
    for identifier in &party.identifiers {
        let scheme = serde_json::to_value(identifier.scheme)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .ok_or(PartySdkError::InvalidTag("identifier"))?;
        tags.push(tag(
            &["identifier", &format!("{scheme}:{}", identifier.value)],
            "identifier",
        )?);
    }
    Ok(tags)
}

/// The exact tags a relay-authored alias head carries.
pub fn alias_head_tags(alias: &PartyAlias) -> Result<Vec<Tag>, PartySdkError> {
    Ok(vec![
        tag(&["d", &alias.id], "d")?,
        tag(&["alias", &alias.resolves_to], "alias")?,
    ])
}

/// The exact tags a relay-authored relationship head carries.
pub fn relationship_head_tags(relationship: &PartyRelationship) -> Result<Vec<Tag>, PartySdkError> {
    Ok(vec![
        tag(&["d", &relationship.id], "d")?,
        tag(&["party", &relationship.party_id], "party")?,
    ])
}

/// Parse a relay-authored `KIND_PARTY` head, which is a party or an alias.
pub fn parse_party_event(event: &Event) -> Result<PartyHead, PartySdkError> {
    require_kind(event, KIND_PARTY)?;
    let schema = serde_json::from_str::<serde_json::Value>(&event.content)
        .ok()
        .and_then(|value| {
            value
                .get("schema")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .ok_or(PartySdkError::InvalidContent("party head"))?;

    match schema.as_str() {
        PARTY_SCHEMA => {
            require_head_tags(event, &["d", "party-kind"], &["identifier"], "party head")?;
            let party: Party = decode(&event.content, "party")?;
            validate_party(&party)?;
            ensure_matches(&party.id, required_scalar(event, "d", "d")?, "party")?;

            // Tags are what queries match on. A head whose identifier tags
            // disagree with its claims is findable under a claim it never made.
            let expected = party_head_tags(&party)?;
            let tagged: Vec<&str> = tag_values(event, "identifier");
            let wanted: Vec<String> = expected
                .iter()
                .filter_map(|candidate| {
                    let parts = candidate.as_slice();
                    (parts[0] == "identifier").then(|| parts[1].clone())
                })
                .collect();
            if tagged.len() != wanted.len()
                || !wanted.iter().all(|value| tagged.contains(&value.as_str()))
            {
                return Err(PartySdkError::TagContentMismatch("party"));
            }
            Ok(PartyHead::Party(party))
        }
        PARTY_ALIAS_SCHEMA => {
            require_head_tags(event, &["d", "alias"], &[], "party alias head")?;
            let alias: PartyAlias = decode(&event.content, "party alias")?;
            validate_alias(&alias)?;
            ensure_matches(&alias.id, required_scalar(event, "d", "d")?, "party alias")?;
            ensure_matches(
                &alias.resolves_to,
                required_scalar(event, "alias", "alias")?,
                "party alias",
            )?;
            Ok(PartyHead::Alias(alias))
        }
        _ => Err(PartySdkError::InvalidContent("party head")),
    }
}

/// Parse a relay-authored relationship head.
///
/// Cross-record validation against the party remains a relay concern.
pub fn parse_party_relationship_event(event: &Event) -> Result<PartyRelationship, PartySdkError> {
    require_kind(event, KIND_PARTY_RELATIONSHIP)?;
    require_head_tags(event, &["d", "party"], &[], "party relationship head")?;
    let relationship: PartyRelationship = decode(&event.content, "party relationship")?;
    ensure_matches(
        &relationship.id,
        required_scalar(event, "d", "d")?,
        "party relationship",
    )?;
    ensure_matches(
        &relationship.party_id,
        required_scalar(event, "party", "party")?,
        "party relationship",
    )?;
    if relationship.schema != PARTY_RELATIONSHIP_SCHEMA {
        return Err(PartySdkError::InvalidContent("party relationship"));
    }
    if !relationship.status.belongs_to(relationship.relationship) {
        return Err(PartySdkError::Contract(
            PartyContractError::StatusNotOnRelationship,
        ));
    }
    Ok(relationship)
}

/// Parse a relay-authored party receipt.
pub fn parse_party_receipt(event: &Event) -> Result<PartyReceipt, PartySdkError> {
    require_kind(event, KIND_PARTY_RECEIPT)?;

    let actor_pubkey = required_scalar(event, "p", "p")?.to_owned();
    let target = required_scalar(event, "a", "a")?.to_owned();
    let action_tags: Vec<&nostr::Tag> = event
        .tags
        .iter()
        .filter(|candidate| {
            let parts = candidate.as_slice();
            parts.first().map(String::as_str) == Some("e")
                && parts.get(3).map(String::as_str) == Some("party-action")
        })
        .collect();
    if action_tags.len() != 1 {
        return Err(PartySdkError::InvalidTag("e"));
    }
    let action_event_id = action_tags[0].as_slice()[1].clone();

    let tuple = event
        .tags
        .iter()
        .find(|candidate| candidate.as_slice().first().map(String::as_str) == Some("party-receipt"))
        .map(nostr::Tag::as_slice)
        .ok_or(PartySdkError::InvalidTag("party-receipt"))?;
    if tuple.len() != 5 || tuple[1] != "1" {
        return Err(PartySdkError::InvalidTag("party-receipt"));
    }
    let request_id =
        Uuid::parse_str(&tuple[2]).map_err(|_| PartySdkError::InvalidEnvelope("party receipt"))?;
    let idempotency_key =
        Uuid::parse_str(&tuple[3]).map_err(|_| PartySdkError::InvalidEnvelope("party receipt"))?;
    let outcome = PartyReceiptOutcome::parse_tag(&tuple[4])?;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ReceiptContent {
        schema: String,
        head_event_id: Option<String>,
    }
    let content: ReceiptContent = decode(&event.content, "party receipt")?;
    if content.schema != RECEIPT_SCHEMA {
        return Err(PartySdkError::InvalidContent("party receipt"));
    }
    // Only an applied action names a head; anything else claiming one is a
    // receipt that disagrees with itself.
    if matches!(outcome, PartyReceiptOutcome::Applied) != content.head_event_id.is_some() {
        return Err(PartySdkError::TagContentMismatch("party receipt"));
    }

    Ok(PartyReceipt {
        actor_pubkey,
        action_event_id,
        target,
        request_id,
        idempotency_key,
        outcome,
        head_event_id: content.head_event_id,
    })
}

/// Build the exact four-tag relay-signed party receipt.
pub fn build_party_receipt(
    action_event: &Event,
    action: &PartyAction,
    outcome: PartyReceiptOutcome,
    head_event_id: Option<&str>,
) -> Result<EventBuilder, PartySdkError> {
    let content = encode(
        &serde_json::json!({
            "schema": RECEIPT_SCHEMA,
            "headEventId": head_event_id,
        }),
        "party receipt",
    )?;
    let request_id = action.request_id.to_string();
    let idempotency_key = action.idempotency_key.to_string();
    let tags = vec![
        tag(&["p", &action_event.pubkey.to_hex()], "p")?,
        tag(&["e", &action_event.id.to_hex(), "", "party-action"], "e")?,
        tag(&["a", &action.target], "a")?,
        tag(
            &[
                "party-receipt",
                "1",
                &request_id,
                &idempotency_key,
                outcome.as_tag_value(),
            ],
            "party-receipt",
        )?,
    ];
    Ok(EventBuilder::new(Kind::Custom(KIND_PARTY_RECEIPT as u16), content).tags(tags))
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::party::{
        IdentifierConfidence, IdentifierScheme, PartyIdentifier, PartyKind, ProvenanceEntry,
        RelationshipKind, RelationshipStatus,
    };
    use nostr::Keys;

    const RELAY: &str = "aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44";

    fn party(id: &str) -> Party {
        Party {
            schema: PARTY_SCHEMA.to_string(),
            id: id.to_string(),
            kind: PartyKind::Organization,
            display_name: "Acme Industries".to_string(),
            legal_name: None,
            identifiers: vec![PartyIdentifier {
                scheme: IdentifierScheme::Domain,
                value: "acme.example".to_string(),
                confidence: IdentifierConfidence::Asserted,
            }],
            provenance: vec![ProvenanceEntry {
                id: "prov-01".to_string(),
                source: "discovery:google-maps".to_string(),
                observed_at: 1_785_369_600,
                source_ref: None,
                fields: vec!["displayName".to_string()],
            }],
            retired_handles: Vec::new(),
            created_at: 1_785_369_600,
            updated_at: 1_785_369_600,
        }
    }

    fn coordinate(kind: u32, id: &str) -> String {
        format!("{kind}:{RELAY}:{id}")
    }

    fn action(payload: PartyActionPayload, expected_head: Option<&str>) -> PartyAction {
        let kind = match &payload {
            PartyActionPayload::Relationship(_) => KIND_PARTY_RELATIONSHIP,
            _ => KIND_PARTY,
        };
        let id = match &payload {
            PartyActionPayload::Party(p) => p.id.clone(),
            PartyActionPayload::Relationship(r) => r.id.clone(),
            PartyActionPayload::Merge { survivor, .. } => survivor.id.clone(),
        };
        PartyAction {
            relay_pubkey: RELAY.to_string(),
            operation: if matches!(payload, PartyActionPayload::Merge { .. }) {
                PartyActionOperation::Merge
            } else if expected_head.is_some() {
                PartyActionOperation::Update
            } else {
                PartyActionOperation::Create
            },
            request_id: Uuid::parse_str("6f1d2b3c-0000-4000-8000-000000000001").unwrap(),
            idempotency_key: Uuid::parse_str("6f1d2b3c-0000-4000-8000-000000000002").unwrap(),
            target: coordinate(kind, &id),
            expected_head: expected_head.map(str::to_owned),
            expected_references: Vec::new(),
            payload,
        }
    }

    #[test]
    fn a_party_action_round_trips_through_its_exact_envelope() {
        let original = action(PartyActionPayload::Party(party("acme-industries")), None);
        let event = build_party_action(&original)
            .expect("build")
            .sign_with_keys(&Keys::generate())
            .expect("sign");
        assert_eq!(event.tags.len(), 3, "exactly p, a, and party-action");
        let parsed = parse_party_action(&event).expect("parse");
        assert_eq!(parsed, original);
    }

    #[test]
    fn a_create_may_not_name_a_head_and_a_replace_must() {
        let mut create = action(PartyActionPayload::Party(party("acme-industries")), None);
        create.expected_head = Some("a".repeat(64));
        assert!(build_party_action(&create).is_err());

        let mut update = action(
            PartyActionPayload::Party(party("acme-industries")),
            Some(&"a".repeat(64)),
        );
        update.expected_head = None;
        assert!(build_party_action(&update).is_err());
    }

    #[test]
    fn an_action_pointed_at_another_coordinate_is_refused() {
        let mut stray = action(PartyActionPayload::Party(party("acme-industries")), None);
        stray.target = coordinate(KIND_PARTY, "someone-else");
        assert!(build_party_action(&stray).is_err());
    }

    /// Both halves of a merge travel together: a survivor without its alias
    /// strands every reference to the retired handle.
    #[test]
    fn a_merge_payload_must_agree_with_itself() {
        let mut survivor = party("acme-industries");
        survivor.retired_handles = vec!["acme-inc".to_string()];
        let alias = PartyAlias {
            schema: PARTY_ALIAS_SCHEMA.to_string(),
            id: "acme-inc".to_string(),
            resolves_to: "acme-industries".to_string(),
            merged_at: 1_785_370_000,
            merge_action_event_id: "a".repeat(64),
        };
        let good = action(
            PartyActionPayload::Merge {
                survivor: survivor.clone(),
                alias: alias.clone(),
            },
            Some(&"b".repeat(64)),
        );
        build_party_action(&good).expect("a consistent merge builds");

        for (label, mutate) in [
            ("alias points elsewhere", 0usize),
            ("survivor never absorbed the handle", 1),
        ] {
            let mut broken_survivor = survivor.clone();
            let mut broken_alias = alias.clone();
            if mutate == 0 {
                broken_alias.resolves_to = "other-party".to_string();
            } else {
                broken_survivor.retired_handles.clear();
            }
            let broken = action(
                PartyActionPayload::Merge {
                    survivor: broken_survivor,
                    alias: broken_alias,
                },
                Some(&"b".repeat(64)),
            );
            assert!(build_party_action(&broken).is_err(), "{label}");
        }
    }

    #[test]
    fn a_merge_operation_and_a_merge_payload_imply_each_other() {
        let mut mismatched = action(PartyActionPayload::Party(party("acme-industries")), None);
        mismatched.operation = PartyActionOperation::Merge;
        mismatched.expected_head = Some("a".repeat(64));
        assert!(build_party_action(&mismatched).is_err());
    }

    fn head(kind: u32, record: &serde_json::Value, tags: Vec<Tag>) -> Event {
        EventBuilder::new(
            Kind::Custom(kind as u16),
            canonical_json(record).expect("canonical"),
        )
        .tags(tags)
        .sign_with_keys(&Keys::generate())
        .expect("sign head")
    }

    #[test]
    fn a_party_head_round_trips_and_pins_its_identifier_tags() {
        let record = party("acme-industries");
        let event = head(
            KIND_PARTY,
            &serde_json::to_value(&record).expect("json"),
            party_head_tags(&record).expect("tags"),
        );
        match parse_party_event(&event).expect("parse") {
            PartyHead::Party(parsed) => assert_eq!(parsed, record),
            other => panic!("expected a party, got {other:?}"),
        }
    }

    /// A head findable under a claim it never made would let a Discovery run
    /// resolve to the wrong party.
    #[test]
    fn a_party_head_whose_identifier_tags_disagree_with_its_claims_is_refused() {
        let record = party("acme-industries");
        let mut tags = party_head_tags(&record).expect("tags");
        tags.push(Tag::parse(["identifier", "domain:not-theirs.example"]).expect("tag"));
        let event = head(
            KIND_PARTY,
            &serde_json::to_value(&record).expect("json"),
            tags,
        );
        assert!(matches!(
            parse_party_event(&event),
            Err(PartySdkError::TagContentMismatch("party"))
        ));
    }

    #[test]
    fn an_alias_head_resolves_at_the_retired_coordinate() {
        let alias = PartyAlias {
            schema: PARTY_ALIAS_SCHEMA.to_string(),
            id: "acme-inc".to_string(),
            resolves_to: "acme-industries".to_string(),
            merged_at: 1_785_370_000,
            merge_action_event_id: "a".repeat(64),
        };
        let event = head(
            KIND_PARTY,
            &serde_json::to_value(&alias).expect("json"),
            alias_head_tags(&alias).expect("tags"),
        );
        match parse_party_event(&event).expect("parse") {
            PartyHead::Alias(parsed) => assert_eq!(parsed, alias),
            other => panic!("expected an alias, got {other:?}"),
        }
    }

    #[test]
    fn a_relationship_head_round_trips() {
        let relationship = PartyRelationship {
            schema: PARTY_RELATIONSHIP_SCHEMA.to_string(),
            id: "acme-industries:lead".to_string(),
            party_id: "acme-industries".to_string(),
            relationship: RelationshipKind::Lead,
            status: RelationshipStatus::Qualified,
            owner_persona_id: "company-role:abc:horizonlabs:sales-lead".to_string(),
            source_channel_id: "welcome".to_string(),
            created_at: 1_785_369_600,
            updated_at: 1_785_369_600,
        };
        let event = head(
            KIND_PARTY_RELATIONSHIP,
            &serde_json::to_value(&relationship).expect("json"),
            relationship_head_tags(&relationship).expect("tags"),
        );
        assert_eq!(
            parse_party_relationship_event(&event).expect("parse"),
            relationship
        );
    }

    #[test]
    fn a_relationship_head_carrying_the_other_views_status_is_refused() {
        let mut confused = PartyRelationship {
            schema: PARTY_RELATIONSHIP_SCHEMA.to_string(),
            id: "acme-industries:lead".to_string(),
            party_id: "acme-industries".to_string(),
            relationship: RelationshipKind::Lead,
            status: RelationshipStatus::Qualified,
            owner_persona_id: "company-role:abc:horizonlabs:sales-lead".to_string(),
            source_channel_id: "welcome".to_string(),
            created_at: 1_785_369_600,
            updated_at: 1_785_369_600,
        };
        confused.status = RelationshipStatus::Active;
        let event = head(
            KIND_PARTY_RELATIONSHIP,
            &serde_json::to_value(&confused).expect("json"),
            relationship_head_tags(&confused).expect("tags"),
        );
        assert!(parse_party_relationship_event(&event).is_err());
    }

    #[test]
    fn non_canonical_head_content_is_refused() {
        let record = party("acme-industries");
        let event = EventBuilder::new(
            Kind::Custom(KIND_PARTY as u16),
            serde_json::to_string(&record).expect("json"),
        )
        .tags(party_head_tags(&record).expect("tags"))
        .sign_with_keys(&Keys::generate())
        .expect("sign");
        assert!(parse_party_event(&event).is_err());
    }

    #[test]
    fn a_receipt_round_trips_and_only_an_applied_one_names_a_head() {
        let owner = Keys::generate();
        let original = action(PartyActionPayload::Party(party("acme-industries")), None);
        let action_event = build_party_action(&original)
            .expect("build")
            .sign_with_keys(&owner)
            .expect("sign");

        let head_id = "c".repeat(64);
        let receipt = build_party_receipt(
            &action_event,
            &original,
            PartyReceiptOutcome::Applied,
            Some(&head_id),
        )
        .expect("build receipt")
        .sign_with_keys(&Keys::generate())
        .expect("sign receipt");
        let parsed = parse_party_receipt(&receipt).expect("parse receipt");
        assert_eq!(parsed.outcome, PartyReceiptOutcome::Applied);
        assert_eq!(parsed.head_event_id.as_deref(), Some(head_id.as_str()));
        assert_eq!(parsed.action_event_id, action_event.id.to_hex());

        let conflict = build_party_receipt(
            &action_event,
            &original,
            PartyReceiptOutcome::Conflict,
            None,
        )
        .expect("build conflict")
        .sign_with_keys(&Keys::generate())
        .expect("sign conflict");
        assert_eq!(
            parse_party_receipt(&conflict).expect("parse").outcome,
            PartyReceiptOutcome::Conflict
        );

        // A conflict that names a head is a receipt disagreeing with itself.
        let lying = build_party_receipt(
            &action_event,
            &original,
            PartyReceiptOutcome::Conflict,
            Some(&head_id),
        )
        .expect("build")
        .sign_with_keys(&Keys::generate())
        .expect("sign");
        assert!(parse_party_receipt(&lying).is_err());
    }

    #[test]
    fn only_the_party_kinds_reach_these_parsers() {
        let record = party("acme-industries");
        let wrong_kind = head(
            KIND_PARTY_RELATIONSHIP,
            &serde_json::to_value(&record).expect("json"),
            party_head_tags(&record).expect("tags"),
        );
        assert!(matches!(
            parse_party_event(&wrong_kind),
            Err(PartySdkError::UnexpectedKind { .. })
        ));
    }
}
