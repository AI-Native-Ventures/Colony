//! Colony cost ledger action and receipt envelopes.
//!
//! The owner signs a [`LedgerAction`]; the relay validates it, appends to the
//! addressed book, and signs both the new head and a receipt. The shape
//! mirrors the party contract: three tags on the action, four on the receipt,
//! canonical JSON content, and a compare-and-set head reference so two
//! concurrent appends cannot silently lose one.

use buzz_core::block::canonical_json;
use buzz_core::kind::{KIND_LEDGER_ACTION, KIND_LEDGER_RECEIPT};
use buzz_core::ledger::attribution::{AttributionRule, Budget, Correction};
use buzz_core::ledger::prices::PriceEntry;
use nostr::{Event, EventBuilder, Kind, Tag};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

const ACTION_SCHEMA: &str = "colony.ledger-action/v1";
const RECEIPT_SCHEMA: &str = "colony.ledger-receipt/v1";

/// The `d` tag of the price book head.
pub const PRICE_BOOK_D_TAG: &str = "pricebook";
/// The `d` tag of the attribution rulebook head.
pub const RULEBOOK_D_TAG: &str = "rulebook";
/// The `d` tag of the correction book head.
pub const CORRECTION_BOOK_D_TAG: &str = "corrections";

/// Which book a ledger action addresses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LedgerActionOperation {
    /// Append a price entry to the price book.
    AddPriceEntry,
    /// Append a rule to the attribution rulebook.
    AddRule,
    /// Append a correction to the correction book.
    AddCorrection,
    /// Replace one cost centre's budget for one period.
    SetBudget,
}

impl LedgerActionOperation {
    /// The exact stable value carried in the action tuple tag.
    pub const fn as_tag_value(self) -> &'static str {
        match self {
            Self::AddPriceEntry => "add-price-entry",
            Self::AddRule => "add-rule",
            Self::AddCorrection => "add-correction",
            Self::SetBudget => "set-budget",
        }
    }

    fn parse_tag(value: &str) -> Result<Self, LedgerSdkError> {
        match value {
            "add-price-entry" => Ok(Self::AddPriceEntry),
            "add-rule" => Ok(Self::AddRule),
            "add-correction" => Ok(Self::AddCorrection),
            "set-budget" => Ok(Self::SetBudget),
            _ => Err(LedgerSdkError::InvalidEnvelope("ledger action")),
        }
    }
}

/// What the action appends or sets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum LedgerActionPayload {
    /// A new effective-dated price row.
    PriceEntry(PriceEntry),
    /// A new attribution rule.
    Rule(AttributionRule),
    /// A new owner correction.
    Correction(Correction),
    /// A budget for one cost centre and period.
    Budget(Budget),
}

impl LedgerActionPayload {
    /// The relay-authored kind this payload's head lives at.
    pub const fn head_kind(&self) -> u32 {
        match self {
            Self::PriceEntry(_) => buzz_core::kind::KIND_PRICE_BOOK,
            Self::Rule(_) => buzz_core::kind::KIND_ATTRIBUTION_RULEBOOK,
            Self::Correction(_) => buzz_core::kind::KIND_CORRECTION_BOOK,
            Self::Budget(_) => buzz_core::kind::KIND_LEDGER_BUDGET,
        }
    }

    /// The `d` tag of the head this payload writes to.
    ///
    /// The three books are singletons; a budget is addressed per cost centre
    /// and period, so its coordinate is derived rather than fixed.
    pub fn head_d_tag(&self) -> String {
        match self {
            Self::PriceEntry(_) => PRICE_BOOK_D_TAG.to_owned(),
            Self::Rule(_) => RULEBOOK_D_TAG.to_owned(),
            Self::Correction(_) => CORRECTION_BOOK_D_TAG.to_owned(),
            Self::Budget(budget) => budget_d_tag(&budget.cost_centre_id, &budget.period),
        }
    }

    /// The operation that carries this payload.
    pub const fn operation(&self) -> LedgerActionOperation {
        match self {
            Self::PriceEntry(_) => LedgerActionOperation::AddPriceEntry,
            Self::Rule(_) => LedgerActionOperation::AddRule,
            Self::Correction(_) => LedgerActionOperation::AddCorrection,
            Self::Budget(_) => LedgerActionOperation::SetBudget,
        }
    }

    /// Validate what can be checked without reading current state.
    ///
    /// State-dependent checks (duplicate ids, append-only ordering) belong to
    /// the broker, which holds the current head.
    pub fn validate(&self) -> Result<(), LedgerSdkError> {
        match self {
            Self::PriceEntry(entry) => {
                if entry.model.trim().is_empty() {
                    return Err(LedgerSdkError::Refused(
                        "price entry model must be non-empty",
                    ));
                }
            }
            Self::Rule(rule) => {
                if rule.id.trim().is_empty() {
                    return Err(LedgerSdkError::Refused("rule id must be non-empty"));
                }
                validate_assignment_ids(
                    &rule.assign.company_id,
                    &rule.assign.cost_centre_id,
                    &rule.assign.owning_team_id,
                )?;
            }
            Self::Correction(correction) => {
                if correction.id.trim().is_empty() {
                    return Err(LedgerSdkError::Refused("correction id must be non-empty"));
                }
                if !is_event_id_hex(&correction.usage_record_event_id) {
                    return Err(LedgerSdkError::Refused(
                        "correction must reference a usage record event id",
                    ));
                }
                if correction.reason.trim().is_empty() {
                    return Err(LedgerSdkError::Refused("correction must state a reason"));
                }
                validate_assignment_ids(
                    &correction.assign.company_id,
                    &correction.assign.cost_centre_id,
                    &correction.assign.owning_team_id,
                )?;
            }
            Self::Budget(budget) => {
                if budget.cost_centre_id.trim().is_empty() {
                    return Err(LedgerSdkError::Refused(
                        "budget cost centre must be non-empty",
                    ));
                }
                if !is_year_month(&budget.period) {
                    return Err(LedgerSdkError::Refused("budget period must be YYYY-MM"));
                }
            }
        }
        Ok(())
    }
}

/// The `d` tag addressing one cost centre's budget for one period.
pub fn budget_d_tag(cost_centre_id: &str, period: &str) -> String {
    format!("{cost_centre_id}:{period}")
}

fn validate_assignment_ids(
    company_id: &str,
    cost_centre_id: &str,
    owning_team_id: &str,
) -> Result<(), LedgerSdkError> {
    if company_id.trim().is_empty() || cost_centre_id.trim().is_empty() {
        return Err(LedgerSdkError::Refused(
            "assignment company and cost centre must be non-empty",
        ));
    }
    if owning_team_id.trim().is_empty() {
        return Err(LedgerSdkError::Refused(
            "assignment owning team must be non-empty",
        ));
    }
    Ok(())
}

fn is_event_id_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_year_month(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[5..].iter().all(u8::is_ascii_digit)
        && (1..=12).contains(&value[5..].parse::<u8>().unwrap_or(0))
}

/// Owner-signable request to append to a relay-authored ledger book.
#[derive(Debug, Clone, PartialEq)]
pub struct LedgerAction {
    /// Tenant relay public key that must author the resulting head.
    pub relay_pubkey: String,
    /// Requested mutation.
    pub operation: LedgerActionOperation,
    /// Stable UUID identifying this logical request.
    pub request_id: Uuid,
    /// Stable UUID making retries idempotent.
    pub idempotency_key: Uuid,
    /// Target relay-authored coordinate.
    pub target: String,
    /// Current head required, when the book already exists. Absent means the
    /// action expects to create the first version of that book.
    pub expected_head: Option<String>,
    /// What to append or set.
    pub payload: LedgerActionPayload,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LedgerActionContent {
    schema: String,
    operation: LedgerActionOperation,
    request_id: Uuid,
    idempotency_key: Uuid,
    target: String,
    expected_head: Option<String>,
    payload: LedgerActionPayload,
}

/// Outcome reported by a relay-authored ledger receipt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LedgerReceiptOutcome {
    /// The relay applied the requested head.
    Applied,
    /// The request actor or payload was refused, or a compare-and-set
    /// expectation no longer matched.
    Conflict,
    /// Processing failed without applying a head.
    Failed,
}

impl LedgerReceiptOutcome {
    /// The exact stable value carried in the receipt tuple.
    pub const fn as_tag_value(self) -> &'static str {
        match self {
            Self::Applied => "applied",
            Self::Conflict => "conflict",
            Self::Failed => "failed",
        }
    }

    fn parse_tag(value: &str) -> Result<Self, LedgerSdkError> {
        match value {
            "applied" => Ok(Self::Applied),
            "conflict" => Ok(Self::Conflict),
            "failed" => Ok(Self::Failed),
            _ => Err(LedgerSdkError::InvalidEnvelope("ledger receipt")),
        }
    }
}

/// Public projection of a relay-authored ledger receipt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LedgerReceipt {
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
    pub outcome: LedgerReceiptOutcome,
    /// Resulting head event when the action was applied.
    pub head_event_id: Option<String>,
}

/// Display-safe failure while building or parsing a Colony ledger event.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum LedgerSdkError {
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
    /// The payload was well-formed but the ledger contract refuses it.
    #[error("{0}")]
    Refused(&'static str),
}

fn tag(parts: &[&str], label: &'static str) -> Result<Tag, LedgerSdkError> {
    Tag::parse(parts.iter().copied()).map_err(|_| LedgerSdkError::InvalidTag(label))
}

fn encode<T: Serialize>(value: &T, entity: &'static str) -> Result<String, LedgerSdkError> {
    let value = serde_json::to_value(value).map_err(|_| LedgerSdkError::InvalidContent(entity))?;
    canonical_json(&value).map_err(|_| LedgerSdkError::InvalidContent(entity))
}

fn decode<T: serde::de::DeserializeOwned>(
    content: &str,
    entity: &'static str,
) -> Result<T, LedgerSdkError> {
    let value: serde_json::Value =
        serde_json::from_str(content).map_err(|_| LedgerSdkError::InvalidContent(entity))?;
    if canonical_json(&value).map_err(|_| LedgerSdkError::InvalidContent(entity))? != content {
        return Err(LedgerSdkError::InvalidContent(entity));
    }
    serde_json::from_value(value).map_err(|_| LedgerSdkError::InvalidContent(entity))
}

fn require_kind(event: &Event, expected: u32) -> Result<(), LedgerSdkError> {
    let actual = u32::from(event.kind.as_u16());
    if actual == expected {
        Ok(())
    } else {
        Err(LedgerSdkError::UnexpectedKind { expected, actual })
    }
}

fn required_scalar<'a>(
    event: &'a Event,
    name: &str,
    label: &'static str,
) -> Result<&'a str, LedgerSdkError> {
    let values: Vec<&str> = event
        .tags
        .iter()
        .filter_map(|candidate| {
            let parts = candidate.as_slice();
            (parts.len() == 2 && parts[0] == name).then(|| parts[1].as_str())
        })
        .collect();
    let total = event
        .tags
        .iter()
        .filter(|candidate| candidate.as_slice().first().map(String::as_str) == Some(name))
        .count();
    if values.len() == 1 && total == 1 {
        Ok(values[0])
    } else {
        Err(LedgerSdkError::InvalidTag(label))
    }
}

fn require_exact_tag_names(
    event: &Event,
    required: &[&str],
    label: &'static str,
) -> Result<(), LedgerSdkError> {
    if event.tags.len() != required.len() {
        return Err(LedgerSdkError::UnexpectedTag(label));
    }
    for name in required {
        if event
            .tags
            .iter()
            .filter(|candidate| candidate.as_slice().first().map(String::as_str) == Some(*name))
            .count()
            != 1
        {
            return Err(LedgerSdkError::InvalidTag(label));
        }
    }
    Ok(())
}

fn validate_action(action: &LedgerAction) -> Result<(), LedgerSdkError> {
    if action.relay_pubkey.len() != 64
        || !action.relay_pubkey.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(LedgerSdkError::InvalidEnvelope("ledger action"));
    }
    if action.operation != action.payload.operation() {
        return Err(LedgerSdkError::TagContentMismatch("ledger action"));
    }
    if action.target.trim().is_empty() {
        return Err(LedgerSdkError::InvalidEnvelope("ledger action"));
    }
    if let Some(head) = &action.expected_head {
        if !is_event_id_hex(head) {
            return Err(LedgerSdkError::InvalidEnvelope("ledger action"));
        }
    }
    action.payload.validate()
}

/// The NIP-33 coordinate a ledger payload writes to.
pub fn ledger_coordinate(relay_pubkey: &str, payload: &LedgerActionPayload) -> String {
    format!(
        "{}:{}:{}",
        payload.head_kind(),
        relay_pubkey,
        payload.head_d_tag()
    )
}

/// Build the exact three-tag, owner-signable ledger action envelope.
pub fn build_ledger_action(action: &LedgerAction) -> Result<EventBuilder, LedgerSdkError> {
    validate_action(action)?;
    let content = LedgerActionContent {
        schema: ACTION_SCHEMA.to_owned(),
        operation: action.operation,
        request_id: action.request_id,
        idempotency_key: action.idempotency_key,
        target: action.target.clone(),
        expected_head: action.expected_head.clone(),
        payload: action.payload.clone(),
    };
    let request_id = action.request_id.to_string();
    let idempotency_key = action.idempotency_key.to_string();
    let tags = [
        tag(&["p", &action.relay_pubkey], "p")?,
        tag(&["a", &action.target], "a")?,
        tag(
            &[
                "ledger-action",
                "1",
                action.operation.as_tag_value(),
                &request_id,
                &idempotency_key,
            ],
            "ledger-action",
        )?,
    ];
    Ok(EventBuilder::new(
        Kind::Custom(KIND_LEDGER_ACTION as u16),
        encode(&content, "ledger action")?,
    )
    .tags(tags))
}

/// Parse the exact owner-signable ledger action envelope.
///
/// Signature validity and owner authorization remain relay concerns.
pub fn parse_ledger_action(event: &Event) -> Result<LedgerAction, LedgerSdkError> {
    require_kind(event, KIND_LEDGER_ACTION)?;
    require_exact_tag_names(event, &["p", "a", "ledger-action"], "ledger action")?;
    let relay_pubkey = required_scalar(event, "p", "p")?.to_owned();
    let target = required_scalar(event, "a", "a")?.to_owned();

    let tuple = event
        .tags
        .iter()
        .find(|candidate| candidate.as_slice().first().map(String::as_str) == Some("ledger-action"))
        .map(nostr::Tag::as_slice)
        .ok_or(LedgerSdkError::InvalidTag("ledger-action"))?;
    if tuple.len() != 5 || tuple[1] != "1" {
        return Err(LedgerSdkError::InvalidTag("ledger-action"));
    }
    let operation = LedgerActionOperation::parse_tag(&tuple[2])?;

    let content: LedgerActionContent = decode(&event.content, "ledger action")?;
    if content.schema != ACTION_SCHEMA {
        return Err(LedgerSdkError::InvalidContent("ledger action"));
    }
    if content.operation != operation
        || content.request_id.to_string() != tuple[3]
        || content.idempotency_key.to_string() != tuple[4]
        || content.target != target
    {
        return Err(LedgerSdkError::TagContentMismatch("ledger action"));
    }

    let action = LedgerAction {
        relay_pubkey,
        operation: content.operation,
        request_id: content.request_id,
        idempotency_key: content.idempotency_key,
        target: content.target,
        expected_head: content.expected_head,
        payload: content.payload,
    };
    validate_action(&action)?;
    Ok(action)
}

/// Build the exact four-tag relay-signed ledger receipt.
pub fn build_ledger_receipt(
    action_event: &Event,
    action: &LedgerAction,
    outcome: LedgerReceiptOutcome,
    head_event_id: Option<&str>,
) -> Result<EventBuilder, LedgerSdkError> {
    let content = encode(
        &serde_json::json!({
            "schema": RECEIPT_SCHEMA,
            "headEventId": head_event_id,
        }),
        "ledger receipt",
    )?;
    let request_id = action.request_id.to_string();
    let idempotency_key = action.idempotency_key.to_string();
    let tags = vec![
        tag(&["p", &action_event.pubkey.to_hex()], "p")?,
        tag(&["e", &action_event.id.to_hex(), "", "ledger-action"], "e")?,
        tag(&["a", &action.target], "a")?,
        tag(
            &[
                "ledger-receipt",
                "1",
                &request_id,
                &idempotency_key,
                outcome.as_tag_value(),
            ],
            "ledger-receipt",
        )?,
    ];
    Ok(EventBuilder::new(Kind::Custom(KIND_LEDGER_RECEIPT as u16), content).tags(tags))
}

/// Parse a relay-authored ledger receipt.
pub fn parse_ledger_receipt(event: &Event) -> Result<LedgerReceipt, LedgerSdkError> {
    require_kind(event, KIND_LEDGER_RECEIPT)?;
    require_exact_tag_names(event, &["p", "e", "a", "ledger-receipt"], "ledger receipt")?;
    let actor_pubkey = required_scalar(event, "p", "p")?.to_owned();
    let target = required_scalar(event, "a", "a")?.to_owned();

    let e_tag = event
        .tags
        .iter()
        .find(|candidate| candidate.as_slice().first().map(String::as_str) == Some("e"))
        .map(nostr::Tag::as_slice)
        .ok_or(LedgerSdkError::InvalidTag("e"))?;
    if e_tag.len() != 4 || e_tag[3] != "ledger-action" {
        return Err(LedgerSdkError::InvalidTag("e"));
    }
    let action_event_id = e_tag[1].clone();

    let tuple = event
        .tags
        .iter()
        .find(|candidate| {
            candidate.as_slice().first().map(String::as_str) == Some("ledger-receipt")
        })
        .map(nostr::Tag::as_slice)
        .ok_or(LedgerSdkError::InvalidTag("ledger-receipt"))?;
    if tuple.len() != 5 || tuple[1] != "1" {
        return Err(LedgerSdkError::InvalidTag("ledger-receipt"));
    }
    let request_id =
        Uuid::parse_str(&tuple[2]).map_err(|_| LedgerSdkError::InvalidTag("ledger-receipt"))?;
    let idempotency_key =
        Uuid::parse_str(&tuple[3]).map_err(|_| LedgerSdkError::InvalidTag("ledger-receipt"))?;
    let outcome = LedgerReceiptOutcome::parse_tag(&tuple[4])?;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ReceiptContent {
        schema: String,
        head_event_id: Option<String>,
    }
    let content: ReceiptContent = decode(&event.content, "ledger receipt")?;
    if content.schema != RECEIPT_SCHEMA {
        return Err(LedgerSdkError::InvalidContent("ledger receipt"));
    }

    Ok(LedgerReceipt {
        actor_pubkey,
        action_event_id,
        target,
        request_id,
        idempotency_key,
        outcome,
        head_event_id: content.head_event_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::company::CommercialPurpose;
    use buzz_core::ledger::attribution::RuleAssignment;
    use buzz_core::ledger::prices::PriceRates;
    use nostr::Keys;

    const RELAY: &str = "aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44";

    fn rates() -> PriceRates {
        PriceRates {
            input_nanousd_per_token: 3_000,
            cache_read_nanousd_per_token: 300,
            cache_write_5m_nanousd_per_token: 3_750,
            cache_write_1h_nanousd_per_token: 6_000,
            output_nanousd_per_token: 15_000,
        }
    }

    fn price_payload() -> LedgerActionPayload {
        LedgerActionPayload::PriceEntry(PriceEntry {
            model: "claude-sonnet-4-5".to_string(),
            effective_from: 1_785_628_800,
            rates: rates(),
            note: None,
        })
    }

    fn assignment() -> RuleAssignment {
        RuleAssignment {
            company_id: "horizon-labs".to_string(),
            cost_centre_id: "web-delivery".to_string(),
            owning_team_id: "web-team".to_string(),
            commercial_purpose: CommercialPurpose::ClientDelivery,
            client_organization_id: Some("tennant-group".to_string()),
            task_id: None,
        }
    }

    fn action(payload: LedgerActionPayload) -> LedgerAction {
        let target = ledger_coordinate(RELAY, &payload);
        LedgerAction {
            relay_pubkey: RELAY.to_string(),
            operation: payload.operation(),
            request_id: Uuid::from_u128(1),
            idempotency_key: Uuid::from_u128(2),
            target,
            expected_head: None,
            payload,
        }
    }

    fn signed(action: &LedgerAction) -> Event {
        let keys = Keys::generate();
        build_ledger_action(action)
            .expect("build")
            .sign_with_keys(&keys)
            .expect("sign")
    }

    #[test]
    fn action_round_trips_through_the_envelope() {
        for payload in [
            price_payload(),
            LedgerActionPayload::Rule(AttributionRule {
                id: "r1".to_string(),
                priority: 10,
                match_provider: Some("anthropic".to_string()),
                match_harness: None,
                match_agent_pubkey: None,
                match_channel_id: None,
                match_model: None,
                assign: assignment(),
            }),
            LedgerActionPayload::Correction(Correction {
                id: "c1".to_string(),
                usage_record_event_id: "ab".repeat(32),
                assign: assignment(),
                reason: "billable client work".to_string(),
                corrected_at: 1_785_628_800,
            }),
            LedgerActionPayload::Budget(Budget {
                cost_centre_id: "web-delivery".to_string(),
                period: "2026-08".to_string(),
                amount_nanousd: 500_000_000_000,
            }),
        ] {
            let original = action(payload);
            let event = signed(&original);
            let parsed = parse_ledger_action(&event).expect("parse");
            assert_eq!(parsed, original);
        }
    }

    #[test]
    fn coordinates_address_the_right_head() {
        assert_eq!(
            ledger_coordinate(RELAY, &price_payload()),
            format!("30184:{RELAY}:pricebook")
        );
        let budget = LedgerActionPayload::Budget(Budget {
            cost_centre_id: "web-delivery".to_string(),
            period: "2026-08".to_string(),
            amount_nanousd: 1,
        });
        assert_eq!(
            ledger_coordinate(RELAY, &budget),
            format!("30187:{RELAY}:web-delivery:2026-08"),
            "a budget is addressed per cost centre and period"
        );
    }

    #[test]
    fn receipt_round_trips_with_every_outcome() {
        let original = action(price_payload());
        let action_event = signed(&original);
        let relay = Keys::generate();

        for (outcome, head) in [
            (LedgerReceiptOutcome::Applied, Some("cd".repeat(32))),
            (LedgerReceiptOutcome::Conflict, None),
            (LedgerReceiptOutcome::Failed, None),
        ] {
            let receipt_event =
                build_ledger_receipt(&action_event, &original, outcome, head.as_deref())
                    .expect("build receipt")
                    .sign_with_keys(&relay)
                    .expect("sign");

            let parsed = parse_ledger_receipt(&receipt_event).expect("parse receipt");
            assert_eq!(parsed.outcome, outcome);
            assert_eq!(parsed.head_event_id, head);
            assert_eq!(parsed.action_event_id, action_event.id.to_hex());
            assert_eq!(parsed.target, original.target);
            assert_eq!(parsed.request_id, original.request_id);
        }
    }

    #[test]
    fn payload_validation_refuses_malformed_records() {
        let blank_model = LedgerActionPayload::PriceEntry(PriceEntry {
            model: "  ".to_string(),
            effective_from: 0,
            rates: rates(),
            note: None,
        });
        assert_eq!(
            blank_model.validate(),
            Err(LedgerSdkError::Refused(
                "price entry model must be non-empty"
            ))
        );

        let bad_reference = LedgerActionPayload::Correction(Correction {
            id: "c1".to_string(),
            usage_record_event_id: "not-an-event-id".to_string(),
            assign: assignment(),
            reason: "because".to_string(),
            corrected_at: 0,
        });
        assert_eq!(
            bad_reference.validate(),
            Err(LedgerSdkError::Refused(
                "correction must reference a usage record event id"
            ))
        );

        let no_reason = LedgerActionPayload::Correction(Correction {
            id: "c1".to_string(),
            usage_record_event_id: "ab".repeat(32),
            assign: assignment(),
            reason: "   ".to_string(),
            corrected_at: 0,
        });
        assert_eq!(
            no_reason.validate(),
            Err(LedgerSdkError::Refused("correction must state a reason"))
        );

        for period in ["2026-8", "2026-13", "2026-00", "not-a-month", "2026-08-01"] {
            let budget = LedgerActionPayload::Budget(Budget {
                cost_centre_id: "web-delivery".to_string(),
                period: period.to_string(),
                amount_nanousd: 1,
            });
            assert_eq!(
                budget.validate(),
                Err(LedgerSdkError::Refused("budget period must be YYYY-MM")),
                "period {period} must be refused"
            );
        }

        let good_budget = LedgerActionPayload::Budget(Budget {
            cost_centre_id: "web-delivery".to_string(),
            period: "2026-12".to_string(),
            amount_nanousd: 1,
        });
        assert!(good_budget.validate().is_ok());
    }

    #[test]
    fn build_refuses_an_operation_that_disagrees_with_its_payload() {
        let mut mismatched = action(price_payload());
        mismatched.operation = LedgerActionOperation::SetBudget;
        assert_eq!(
            build_ledger_action(&mismatched),
            Err(LedgerSdkError::TagContentMismatch("ledger action"))
        );
    }

    #[test]
    fn parse_refuses_a_tampered_tuple_tag() {
        let original = action(price_payload());
        let event = signed(&original);

        // Re-sign the same content under a tuple that claims another
        // operation. Content and tags must agree or the action is refused.
        let tampered = EventBuilder::new(Kind::Custom(KIND_LEDGER_ACTION as u16), &event.content)
            .tags([
                tag(&["p", RELAY], "p").expect("p"),
                tag(&["a", &original.target], "a").expect("a"),
                tag(
                    &[
                        "ledger-action",
                        "1",
                        "set-budget",
                        &original.request_id.to_string(),
                        &original.idempotency_key.to_string(),
                    ],
                    "ledger-action",
                )
                .expect("tuple"),
            ])
            .sign_with_keys(&Keys::generate())
            .expect("sign");

        assert_eq!(
            parse_ledger_action(&tampered),
            Err(LedgerSdkError::TagContentMismatch("ledger action"))
        );
    }

    #[test]
    fn parse_refuses_non_canonical_content() {
        let original = action(price_payload());
        let event = signed(&original);
        let padded = format!("{} ", event.content);
        let tampered = EventBuilder::new(Kind::Custom(KIND_LEDGER_ACTION as u16), padded)
            .tags(event.tags.to_vec())
            .sign_with_keys(&Keys::generate())
            .expect("sign");
        assert_eq!(
            parse_ledger_action(&tampered),
            Err(LedgerSdkError::InvalidContent("ledger action"))
        );
    }
}
