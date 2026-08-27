//! Colony canonical party identity: Organizations, People, and the company's
//! Lead and Client views over them.
//!
//! Every later phase writes about external parties. Discovery finds them,
//! Outreach contacts them, Opportunities value them, Clients bill them, and the
//! Cost Ledger attributes delivery cost to them. If each keeps its own copy the
//! same business becomes several records that disagree, and no report about a
//! customer can be trusted. So there is one identity, and Lead and Client are
//! views over it rather than copies of it.
//!
//! Two rules carry most of the weight:
//!
//! 1. **Nothing exists without provenance.** A party field that cannot be traced
//!    to an observation is a claim nobody made, and it is indistinguishable from
//!    a fact once it is written down.
//! 2. **A handle that was handed out keeps resolving.** Merging is how
//!    duplicates get fixed, and a merge that broke references would make the
//!    fix more expensive than the duplicate.
//!
//! Implementation lands in Task 2 of
//! `docs/superpowers/plans/2026-08-02-colony-party-identity.md`; the validators
//! below are deliberately permissive stubs so the contract tests fail against
//! them rather than against a compile error.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Schema string every canonical Party carries.
pub const PARTY_SCHEMA: &str = "colony.party/v1";
/// Schema string every retired-handle alias carries.
pub const PARTY_ALIAS_SCHEMA: &str = "colony.party-alias/v1";
/// Schema string every Lead or Client relationship carries.
pub const PARTY_RELATIONSHIP_SCHEMA: &str = "colony.party-relationship/v1";

const MAX_ID_LEN: usize = 128;
const MAX_NAME_LEN: usize = 200;
const MAX_IDENTIFIERS: usize = 50;
const MAX_PROVENANCE: usize = 200;
const MAX_RETIRED_HANDLES: usize = 100;

/// Whether a party is an organization or an individual.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PartyKind {
    /// A company, institution, or other legal entity.
    Organization,
    /// An individual person.
    Person,
}

/// The kind of external identifier a claim is made under.
///
/// Closed on purpose. A domain and an email that happen to share text are not
/// the same claim, and merge decisions are only defensible when the thing being
/// compared is typed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IdentifierScheme {
    /// A registrable domain, such as `acme.example`.
    Domain,
    /// An email address.
    Email,
    /// A telephone number in E.164 form.
    Phone,
    /// A LinkedIn company or member slug.
    Linkedin,
    /// A government company registration number.
    RegistrationNumber,
}

/// How strongly an identifier is believed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IdentifierConfidence {
    /// Observed from a source without independent confirmation.
    Asserted,
    /// Confirmed by a second source or by the party itself.
    Verified,
}

/// One typed external identifier for a party.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PartyIdentifier {
    /// What kind of identifier this is.
    pub scheme: IdentifierScheme,
    /// The identifier itself, normalized by the caller.
    pub value: String,
    /// How strongly it is believed.
    pub confidence: IdentifierConfidence,
}

/// The party fields a provenance entry may claim to be the source of.
pub const PROVENANCE_FIELDS: [&str; 4] = ["kind", "displayName", "legalName", "identifiers"];

/// One observation that contributed to a party record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProvenanceEntry {
    /// Stable identifier for this observation within the party.
    pub id: String,
    /// Where the observation came from, such as `discovery:google-maps`.
    pub source: String,
    /// Unix timestamp at which the observation was made.
    pub observed_at: i64,
    /// Opaque reference into the source, for re-reading the raw evidence.
    pub source_ref: Option<String>,
    /// Which party fields this observation is the source of.
    pub fields: Vec<String>,
}

/// A canonical external Organization or Person.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Party {
    /// Exact content schema identifier.
    pub schema: String,
    /// Stable party handle. Never reused, never reassigned.
    pub id: String,
    /// Organization or person.
    pub kind: PartyKind,
    /// The name the company refers to them by.
    pub display_name: String,
    /// Registered name, when known.
    pub legal_name: Option<String>,
    /// Typed external identifiers.
    pub identifiers: Vec<PartyIdentifier>,
    /// Every observation that contributed to this record.
    pub provenance: Vec<ProvenanceEntry>,
    /// Handles merged into this one, oldest first.
    pub retired_handles: Vec<String>,
    /// Unix timestamp at which the party was created.
    pub created_at: i64,
    /// Unix timestamp at which the party was last updated.
    pub updated_at: i64,
}

/// The pointer a retired handle leaves behind after a merge.
///
/// Written at the retired handle's own coordinate, so a reference handed out
/// before the merge still resolves to a definite answer afterwards.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PartyAlias {
    /// Exact content schema identifier.
    pub schema: String,
    /// The retired handle.
    pub id: String,
    /// The handle that survived.
    pub resolves_to: String,
    /// Unix timestamp of the merge.
    pub merged_at: i64,
    /// The owner-signed action that authorized the merge.
    pub merge_action_event_id: String,
}

/// Whether a relationship is the Lead view or the Client view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RelationshipKind {
    /// Campaign membership, qualification, CRM state, and Sales ownership.
    Lead,
    /// Contracts, services, billing, delivery, and account health.
    Client,
}

impl RelationshipKind {
    /// The exact suffix this relationship contributes to a coordinate.
    pub const fn slug(self) -> &'static str {
        match self {
            Self::Lead => "lead",
            Self::Client => "client",
        }
    }
}

/// Lifecycle state of a Lead or Client relationship.
///
/// One enum for both views, validated against the view it appears on. A client
/// status on a lead relationship is a record that cannot be reasoned about, and
/// splitting the enum in two would only move that check to the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RelationshipStatus {
    /// Lead: returned by Discovery, not yet accepted by the company.
    Candidate,
    /// Lead: accepted as a prospect the company owns.
    Accepted,
    /// Lead: qualified for commercial pursuit.
    Qualified,
    /// Lead: judged not worth pursuing.
    Disqualified,
    /// Lead: parked without being ruled out.
    Dormant,
    /// Client: currently engaged.
    Active,
    /// Client: engagement temporarily suspended.
    Paused,
    /// Client: engagement ended.
    Former,
}

impl RelationshipStatus {
    /// Whether this status belongs to that relationship view.
    pub const fn belongs_to(self, relationship: RelationshipKind) -> bool {
        matches!(
            (relationship, self),
            (
                RelationshipKind::Lead,
                Self::Candidate
                    | Self::Accepted
                    | Self::Qualified
                    | Self::Disqualified
                    | Self::Dormant
            ) | (
                RelationshipKind::Client,
                Self::Active | Self::Paused | Self::Former
            )
        )
    }
}

/// A company's Lead or Client view over one party.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PartyRelationship {
    /// Exact content schema identifier.
    pub schema: String,
    /// Stable coordinate identifier, `{partyId}:{relationship}`.
    pub id: String,
    /// The party this is a view of.
    pub party_id: String,
    /// Lead or Client.
    pub relationship: RelationshipKind,
    /// Current lifecycle state.
    pub status: RelationshipStatus,
    /// Persona accountable for it.
    pub owner_persona_id: String,
    /// Channel the relationship originated in.
    pub source_channel_id: String,
    /// Unix timestamp at which the relationship was created.
    pub created_at: i64,
    /// Unix timestamp at which the relationship was last updated.
    pub updated_at: i64,
}

/// Display-safe failure produced by a party contract validator.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PartyContractError {
    /// The content schema does not exactly match the supported version.
    #[error("unsupported {0} schema")]
    InvalidSchema(&'static str),
    /// A stable identifier is blank, malformed, or too long.
    #[error("invalid identifier in {0}")]
    InvalidIdentifier(&'static str),
    /// A required or bounded text field is invalid.
    #[error("invalid text in {0}")]
    InvalidText(&'static str),
    /// A collection exceeded its bound.
    #[error("too many entries in {0}")]
    TooManyEntries(&'static str),
    /// The same typed identifier appears twice.
    #[error("duplicate identifier claim")]
    DuplicateIdentifier,
    /// A party carries no evidence for its own existence.
    #[error("a party must carry at least one provenance entry")]
    MissingProvenance,
    /// A provenance entry claims a field the record does not have.
    #[error("provenance names an unknown field")]
    UnknownProvenanceField,
    /// Two records that must describe the same thing do not.
    #[error("{0} does not match its record")]
    MismatchedReference(&'static str),
    /// A status does not belong to the relationship view it appears on.
    #[error("that status does not belong to this relationship")]
    StatusNotOnRelationship,
    /// A merge found the same relationship ended on one side and live on the
    /// other, and no automatic answer is safe.
    #[error("that relationship is ended on one side and live on the other")]
    ConflictingRelationshipStatuses,
    /// A lifecycle transition is not permitted.
    #[error("invalid {0} status transition")]
    InvalidStatusTransition(&'static str),
    /// An immutable field changed between versions.
    #[error("immutable field changed: {0}")]
    ImmutableField(&'static str),
    /// A replacement is not strictly newer than what it replaces.
    #[error("updatedAt is not monotonic")]
    UpdatedAtNotMonotonic,
    /// An alias points at itself, or a merge would form a cycle.
    #[error("that merge would leave a handle pointing at itself")]
    CircularAlias,
    /// A merge names a handle that has already been retired.
    #[error("that handle has already been merged away")]
    AlreadyRetired,
}

/// Whether a string is a usable stable identifier.
///
/// Same grammar the company contract accepts: anything that could be
/// case-folded, normalized, or truncated into a different identifier is refused
/// rather than repaired, because these strings end up in relay coordinates.
fn is_record_id(value: &str) -> bool {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    value.len() <= MAX_ID_LEN
        && (first.is_ascii_lowercase() || first.is_ascii_digit())
        && bytes.all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'.' | b'_' | b':' | b'-')
        })
}

fn validate_id(value: &str, field: &'static str) -> Result<(), PartyContractError> {
    if is_record_id(value) {
        Ok(())
    } else {
        Err(PartyContractError::InvalidIdentifier(field))
    }
}

fn validate_required_text(
    value: &str,
    field: &'static str,
    max_len: usize,
) -> Result<(), PartyContractError> {
    if value.trim().is_empty() || value.len() > max_len {
        return Err(PartyContractError::InvalidText(field));
    }
    Ok(())
}

fn validate_optional_text(
    value: Option<&str>,
    field: &'static str,
    max_len: usize,
) -> Result<(), PartyContractError> {
    match value {
        Some(text) => validate_required_text(text, field, max_len),
        None => Ok(()),
    }
}

fn validate_schema(
    value: &str,
    expected: &str,
    label: &'static str,
) -> Result<(), PartyContractError> {
    if value == expected {
        Ok(())
    } else {
        Err(PartyContractError::InvalidSchema(label))
    }
}

fn is_event_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn validate_timestamps(created_at: i64, updated_at: i64) -> Result<(), PartyContractError> {
    if created_at <= 0 || updated_at < created_at {
        return Err(PartyContractError::InvalidText("timestamps"));
    }
    Ok(())
}

fn validate_replacement_timestamps(
    previous_created_at: i64,
    previous_updated_at: i64,
    replacement_created_at: i64,
    replacement_updated_at: i64,
) -> Result<(), PartyContractError> {
    if previous_created_at != replacement_created_at {
        return Err(PartyContractError::ImmutableField("createdAt"));
    }
    if replacement_updated_at <= previous_updated_at {
        return Err(PartyContractError::UpdatedAtNotMonotonic);
    }
    Ok(())
}

fn validate_immutable(
    previous: &str,
    replacement: &str,
    field: &'static str,
) -> Result<(), PartyContractError> {
    if previous == replacement {
        Ok(())
    } else {
        Err(PartyContractError::ImmutableField(field))
    }
}

/// Validate one canonical party.
pub fn validate_party(party: &Party) -> Result<(), PartyContractError> {
    validate_schema(&party.schema, PARTY_SCHEMA, "party")?;
    validate_id(&party.id, "party.id")?;
    validate_required_text(&party.display_name, "party.displayName", MAX_NAME_LEN)?;
    validate_optional_text(party.legal_name.as_deref(), "party.legalName", MAX_NAME_LEN)?;
    validate_timestamps(party.created_at, party.updated_at)?;

    if party.identifiers.len() > MAX_IDENTIFIERS {
        return Err(PartyContractError::TooManyEntries("party.identifiers"));
    }
    let mut claims = HashSet::new();
    for identifier in &party.identifiers {
        validate_required_text(&identifier.value, "party.identifiers.value", MAX_NAME_LEN)?;
        // Typed: the same text under two schemes is two different claims, and
        // both can legitimately be true of one business.
        if !claims.insert((identifier.scheme, identifier.value.as_str())) {
            return Err(PartyContractError::DuplicateIdentifier);
        }
    }

    // A field nobody observed is a claim nobody made, and once it is written
    // down it is indistinguishable from a fact.
    if party.provenance.is_empty() {
        return Err(PartyContractError::MissingProvenance);
    }
    if party.provenance.len() > MAX_PROVENANCE {
        return Err(PartyContractError::TooManyEntries("party.provenance"));
    }
    let mut observation_ids = HashSet::new();
    for entry in &party.provenance {
        validate_id(&entry.id, "party.provenance.id")?;
        validate_required_text(&entry.source, "party.provenance.source", MAX_NAME_LEN)?;
        validate_optional_text(
            entry.source_ref.as_deref(),
            "party.provenance.sourceRef",
            MAX_NAME_LEN,
        )?;
        if entry.observed_at <= 0 {
            return Err(PartyContractError::InvalidText(
                "party.provenance.observedAt",
            ));
        }
        if !observation_ids.insert(entry.id.as_str()) {
            return Err(PartyContractError::InvalidIdentifier("party.provenance.id"));
        }
        for field in &entry.fields {
            if !PROVENANCE_FIELDS.contains(&field.as_str()) {
                return Err(PartyContractError::UnknownProvenanceField);
            }
        }
    }

    if party.retired_handles.len() > MAX_RETIRED_HANDLES {
        return Err(PartyContractError::TooManyEntries("party.retiredHandles"));
    }
    let mut retired = HashSet::new();
    for handle in &party.retired_handles {
        validate_id(handle, "party.retiredHandles")?;
        if handle == &party.id {
            return Err(PartyContractError::CircularAlias);
        }
        if !retired.insert(handle.as_str()) {
            return Err(PartyContractError::InvalidIdentifier(
                "party.retiredHandles",
            ));
        }
    }

    Ok(())
}

/// Validate a replacement party against the version it replaces.
pub fn validate_party_update(
    previous: &Party,
    replacement: &Party,
) -> Result<(), PartyContractError> {
    validate_party(replacement)?;
    validate_immutable(&previous.schema, &replacement.schema, "party.schema")?;
    validate_immutable(&previous.id, &replacement.id, "party.id")?;
    validate_replacement_timestamps(
        previous.created_at,
        previous.updated_at,
        replacement.created_at,
        replacement.updated_at,
    )?;
    // Evidence is append-only: a replacement may add observations but never
    // drop the ones that justified what is already recorded.
    for entry in &previous.provenance {
        if !replacement
            .provenance
            .iter()
            .any(|candidate| candidate.id == entry.id)
        {
            return Err(PartyContractError::MissingProvenance);
        }
    }
    Ok(())
}

/// Validate one retired-handle alias.
pub fn validate_alias(alias: &PartyAlias) -> Result<(), PartyContractError> {
    validate_schema(&alias.schema, PARTY_ALIAS_SCHEMA, "party alias")?;
    validate_id(&alias.id, "alias.id")?;
    validate_id(&alias.resolves_to, "alias.resolvesTo")?;
    if alias.id == alias.resolves_to {
        return Err(PartyContractError::CircularAlias);
    }
    if alias.merged_at <= 0 {
        return Err(PartyContractError::InvalidText("alias.mergedAt"));
    }
    // An alias with no auditable merge behind it is a redirect nobody
    // authorized.
    if !is_event_id(&alias.merge_action_event_id) {
        return Err(PartyContractError::InvalidIdentifier(
            "alias.mergeActionEventId",
        ));
    }
    Ok(())
}

/// Validate one Lead or Client relationship against its party.
pub fn validate_relationship(
    relationship: &PartyRelationship,
    party: &Party,
) -> Result<(), PartyContractError> {
    validate_party(party)?;
    validate_schema(
        &relationship.schema,
        PARTY_RELATIONSHIP_SCHEMA,
        "party relationship",
    )?;
    validate_id(&relationship.id, "relationship.id")?;
    validate_id(&relationship.party_id, "relationship.partyId")?;
    validate_id(
        &relationship.owner_persona_id,
        "relationship.ownerPersonaId",
    )?;
    validate_id(
        &relationship.source_channel_id,
        "relationship.sourceChannelId",
    )?;
    validate_timestamps(relationship.created_at, relationship.updated_at)?;

    if relationship.party_id != party.id {
        return Err(PartyContractError::MismatchedReference(
            "relationship.partyId",
        ));
    }
    // The coordinate is what makes a second Lead on one party impossible, so an
    // ID that does not derive from the party and the view would let one exist.
    let expected = relationship_coordinate(&relationship.party_id, relationship.relationship);
    if relationship.id != expected {
        return Err(PartyContractError::MismatchedReference("relationship.id"));
    }
    if !relationship.status.belongs_to(relationship.relationship) {
        return Err(PartyContractError::StatusNotOnRelationship);
    }
    Ok(())
}

/// Validate a replacement relationship against the version it replaces.
pub fn validate_relationship_update(
    previous: &PartyRelationship,
    replacement: &PartyRelationship,
    party: &Party,
) -> Result<(), PartyContractError> {
    validate_relationship(replacement, party)?;
    validate_immutable(&previous.schema, &replacement.schema, "relationship.schema")?;
    validate_immutable(&previous.id, &replacement.id, "relationship.id")?;
    validate_immutable(
        &previous.party_id,
        &replacement.party_id,
        "relationship.partyId",
    )?;
    if previous.relationship != replacement.relationship {
        return Err(PartyContractError::ImmutableField(
            "relationship.relationship",
        ));
    }
    validate_replacement_timestamps(
        previous.created_at,
        previous.updated_at,
        replacement.created_at,
        replacement.updated_at,
    )?;
    if !is_relationship_transition_allowed(
        replacement.relationship,
        previous.status,
        replacement.status,
    ) {
        return Err(PartyContractError::InvalidStatusTransition("relationship"));
    }
    Ok(())
}

/// Whether a relationship lifecycle transition is permitted.
///
/// Same-status replacement is allowed so content edits do not need a
/// transition. A disqualified Lead and a former Client are terminal: both are
/// re-entered by a new decision rather than by editing the old record back to
/// where it was, so the history of the first outcome survives.
pub const fn is_relationship_transition_allowed(
    relationship: RelationshipKind,
    from: RelationshipStatus,
    to: RelationshipStatus,
) -> bool {
    if !from.belongs_to(relationship) || !to.belongs_to(relationship) {
        return false;
    }
    if from as u8 == to as u8 {
        return true;
    }
    use RelationshipStatus::*;
    matches!(
        (from, to),
        (Candidate, Accepted | Disqualified)
            | (Accepted, Qualified | Disqualified | Dormant)
            | (Qualified, Dormant | Disqualified)
            | (Dormant, Qualified | Disqualified)
            | (Active, Paused | Former)
            | (Paused, Active | Former)
    )
}

/// Merge one party into another, losing nothing.
///
/// The survivor keeps its handle and absorbs the other's claims, evidence, and
/// retired handles. Nothing is dropped: a merge is how a duplicate is fixed,
/// and a fix that lost evidence would cost more than the duplicate did.
pub fn merge_parties(survivor: &Party, retired: &Party) -> Result<Party, PartyContractError> {
    validate_party(survivor)?;
    validate_party(retired)?;

    if survivor.id == retired.id {
        return Err(PartyContractError::CircularAlias);
    }
    if retired.retired_handles.contains(&survivor.id) {
        return Err(PartyContractError::CircularAlias);
    }
    if survivor.retired_handles.contains(&retired.id) {
        return Err(PartyContractError::AlreadyRetired);
    }

    let mut merged = survivor.clone();

    let mut claims: HashSet<(IdentifierScheme, String)> = survivor
        .identifiers
        .iter()
        .map(|identifier| (identifier.scheme, identifier.value.clone()))
        .collect();
    for identifier in &retired.identifiers {
        if claims.insert((identifier.scheme, identifier.value.clone())) {
            merged.identifiers.push(identifier.clone());
        }
    }

    let mut observations: HashSet<String> = survivor
        .provenance
        .iter()
        .map(|entry| entry.id.clone())
        .collect();
    for entry in &retired.provenance {
        if observations.insert(entry.id.clone()) {
            merged.provenance.push(entry.clone());
        }
    }

    let mut handles: HashSet<String> = survivor.retired_handles.iter().cloned().collect();
    for handle in retired
        .retired_handles
        .iter()
        .cloned()
        .chain(std::iter::once(retired.id.clone()))
    {
        if handle != merged.id && handles.insert(handle.clone()) {
            merged.retired_handles.push(handle);
        }
    }

    if merged.display_name.trim().is_empty() {
        merged.display_name = retired.display_name.clone();
    }
    if merged.legal_name.is_none() {
        merged.legal_name = retired.legal_name.clone();
    }
    merged.updated_at = survivor
        .updated_at
        .max(retired.updated_at)
        .saturating_add(1);

    validate_party(&merged)?;
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One named way of breaking a fixture, so a table of them stays readable.
    type Mutation = (&'static str, fn(&mut Party));

    fn identifier(scheme: IdentifierScheme, value: &str) -> PartyIdentifier {
        PartyIdentifier {
            scheme,
            value: value.to_string(),
            confidence: IdentifierConfidence::Asserted,
        }
    }

    fn provenance(id: &str, fields: &[&str]) -> ProvenanceEntry {
        ProvenanceEntry {
            id: id.to_string(),
            source: "discovery:google-maps".to_string(),
            observed_at: 1_785_369_600,
            source_ref: Some("run-7f3a/result-12".to_string()),
            fields: fields.iter().map(|field| (*field).to_string()).collect(),
        }
    }

    fn party(id: &str) -> Party {
        Party {
            schema: PARTY_SCHEMA.to_string(),
            id: id.to_string(),
            kind: PartyKind::Organization,
            display_name: "Acme Industries".to_string(),
            legal_name: None,
            identifiers: vec![identifier(IdentifierScheme::Domain, "acme.example")],
            provenance: vec![provenance("prov-01", &["displayName", "identifiers"])],
            retired_handles: Vec::new(),
            created_at: 1_785_369_600,
            updated_at: 1_785_369_600,
        }
    }

    fn relationship(
        party_id: &str,
        kind: RelationshipKind,
        status: RelationshipStatus,
    ) -> PartyRelationship {
        PartyRelationship {
            schema: PARTY_RELATIONSHIP_SCHEMA.to_string(),
            id: format!("{party_id}:{}", kind.slug()),
            party_id: party_id.to_string(),
            relationship: kind,
            status,
            owner_persona_id: "company-role:abc:horizonlabs:sales-lead".to_string(),
            source_channel_id: "welcome".to_string(),
            created_at: 1_785_369_600,
            updated_at: 1_785_369_600,
        }
    }

    fn alias(id: &str, resolves_to: &str) -> PartyAlias {
        PartyAlias {
            schema: PARTY_ALIAS_SCHEMA.to_string(),
            id: id.to_string(),
            resolves_to: resolves_to.to_string(),
            merged_at: 1_785_370_000,
            merge_action_event_id: "a".repeat(64),
        }
    }

    // --- Gate A: identity and provenance ----------------------------------

    #[test]
    fn a_well_formed_party_is_accepted() {
        validate_party(&party("acme-industries")).expect("a complete party is valid");
    }

    /// A field nobody observed is a claim nobody made, and once written down it
    /// is indistinguishable from a fact.
    #[test]
    fn a_party_without_provenance_is_refused() {
        let mut orphan = party("acme-industries");
        orphan.provenance.clear();
        assert_eq!(
            validate_party(&orphan),
            Err(PartyContractError::MissingProvenance)
        );
    }

    #[test]
    fn provenance_naming_a_field_the_contract_does_not_have_is_refused() {
        let mut invented = party("acme-industries");
        invented.provenance = vec![provenance("prov-01", &["revenue"])];
        assert_eq!(
            validate_party(&invented),
            Err(PartyContractError::UnknownProvenanceField)
        );
    }

    #[test]
    fn every_declared_provenance_field_is_one_the_party_actually_has() {
        for field in PROVENANCE_FIELDS {
            let mut record = party("acme-industries");
            record.provenance = vec![provenance("prov-01", &[field])];
            validate_party(&record).unwrap_or_else(|error| {
                panic!("{field} is a declared provenance field but was refused: {error}")
            });
        }
    }

    #[test]
    fn the_same_typed_claim_cannot_appear_twice() {
        let mut doubled = party("acme-industries");
        doubled.identifiers = vec![
            identifier(IdentifierScheme::Domain, "acme.example"),
            identifier(IdentifierScheme::Domain, "acme.example"),
        ];
        assert_eq!(
            validate_party(&doubled),
            Err(PartyContractError::DuplicateIdentifier)
        );
    }

    /// The same text under two schemes is two different claims, and both are
    /// legitimate: a business can own a domain and use it in an address.
    #[test]
    fn the_same_text_under_different_schemes_is_not_a_duplicate() {
        let mut record = party("acme-industries");
        record.identifiers = vec![
            identifier(IdentifierScheme::Domain, "acme.example"),
            identifier(IdentifierScheme::Email, "acme.example"),
        ];
        validate_party(&record).expect("two schemes are two claims");
    }

    #[test]
    fn blank_and_oversized_text_is_refused() {
        let cases: [Mutation; 3] = [
            ("blank display name", |p: &mut Party| {
                p.display_name = "   ".to_string()
            }),
            ("oversized display name", |p: &mut Party| {
                p.display_name = "a".repeat(MAX_NAME_LEN + 1)
            }),
            ("blank identifier value", |p: &mut Party| {
                p.identifiers = vec![identifier(IdentifierScheme::Domain, "")]
            }),
        ];
        for (label, mutate) in cases {
            let mut record = party("acme-industries");
            mutate(&mut record);
            assert!(validate_party(&record).is_err(), "{label} must be refused");
        }
    }

    #[test]
    fn an_unsupported_schema_is_refused() {
        let mut wrong = party("acme-industries");
        wrong.schema = "colony.party/v2".to_string();
        assert_eq!(
            validate_party(&wrong),
            Err(PartyContractError::InvalidSchema("party"))
        );
    }

    #[test]
    fn a_handle_outside_the_identifier_grammar_is_refused() {
        for bad in ["Acme", "acme industries", "", &"a".repeat(MAX_ID_LEN + 1)] {
            let mut record = party(bad);
            record.provenance = vec![provenance("prov-01", &["displayName"])];
            assert!(
                validate_party(&record).is_err(),
                "handle {bad:?} must be refused"
            );
        }
    }

    #[test]
    fn a_replacement_may_not_change_what_makes_it_the_same_party() {
        let previous = party("acme-industries");
        let cases: [Mutation; 2] = [
            ("handle", |p: &mut Party| p.id = "acme-inc".to_string()),
            ("created_at", |p: &mut Party| p.created_at += 1),
        ];
        for (label, mutate) in cases {
            let mut replacement = previous.clone();
            replacement.updated_at += 1;
            mutate(&mut replacement);
            assert!(
                validate_party_update(&previous, &replacement).is_err(),
                "changing the {label} must be refused"
            );
        }
    }

    #[test]
    fn a_replacement_must_be_strictly_newer() {
        let previous = party("acme-industries");
        let mut same = previous.clone();
        same.display_name = "Acme Industries Ltd".to_string();
        assert_eq!(
            validate_party_update(&previous, &same),
            Err(PartyContractError::UpdatedAtNotMonotonic)
        );
    }

    // --- Gate B: relationship views ---------------------------------------

    #[test]
    fn one_party_carries_both_views_at_once() {
        let record = party("acme-industries");
        let lead = relationship(
            "acme-industries",
            RelationshipKind::Lead,
            RelationshipStatus::Qualified,
        );
        let client = relationship(
            "acme-industries",
            RelationshipKind::Client,
            RelationshipStatus::Active,
        );
        validate_relationship(&lead, &record).expect("lead view is valid");
        validate_relationship(&client, &record).expect("client view is valid");
        assert_ne!(lead.id, client.id, "each view has its own coordinate");
    }

    /// Sales owns the pipeline and Accounts owns the engagement. They are
    /// different people with different work, so one identity has to be able to
    /// carry both without either one deciding the other's owner.
    #[test]
    fn each_view_of_one_party_keeps_its_own_status_and_its_own_owner() {
        let record = party("acme-industries");
        let mut lead = relationship(
            "acme-industries",
            RelationshipKind::Lead,
            RelationshipStatus::Qualified,
        );
        lead.owner_persona_id = "company-role:abc:horizonlabs:sales-lead".to_string();
        let mut client = relationship(
            "acme-industries",
            RelationshipKind::Client,
            RelationshipStatus::Active,
        );
        client.owner_persona_id = "company-role:abc:horizonlabs:account-lead".to_string();

        validate_relationship(&lead, &record).expect("lead view is valid");
        validate_relationship(&client, &record).expect("client view is valid");
        assert_ne!(lead.owner_persona_id, client.owner_persona_id);
        assert_ne!(lead.status, client.status);
        assert_ne!(lead.id, client.id);
    }

    /// Losing the deal does not end the account. Because each view is its own
    /// NIP-33 coordinate, ending one cannot reach the other -- there is no
    /// shared record for it to touch.
    #[test]
    fn ending_the_lead_leaves_the_client_view_untouched() {
        let record = party("acme-industries");
        let client = relationship(
            "acme-industries",
            RelationshipKind::Client,
            RelationshipStatus::Active,
        );
        let lead = relationship(
            "acme-industries",
            RelationshipKind::Lead,
            RelationshipStatus::Qualified,
        );
        let mut disqualified = lead.clone();
        disqualified.status = RelationshipStatus::Disqualified;
        disqualified.updated_at = lead.updated_at + 1;

        validate_relationship_update(&lead, &disqualified, &record)
            .expect("qualified leads may be disqualified");
        assert_eq!(
            validate_relationship(&client, &record),
            Ok(()),
            "the client view is still valid after the lead ends"
        );
        assert_eq!(client.status, RelationshipStatus::Active);
        assert_ne!(disqualified.id, client.id);
    }

    #[test]
    fn a_client_status_on_a_lead_view_is_refused() {
        let record = party("acme-industries");
        let mut confused = relationship(
            "acme-industries",
            RelationshipKind::Lead,
            RelationshipStatus::Qualified,
        );
        confused.status = RelationshipStatus::Active;
        assert_eq!(
            validate_relationship(&confused, &record),
            Err(PartyContractError::StatusNotOnRelationship)
        );
    }

    #[test]
    fn every_status_belongs_to_exactly_one_view() {
        use RelationshipStatus::*;
        for status in [Candidate, Accepted, Qualified, Disqualified, Dormant] {
            assert!(status.belongs_to(RelationshipKind::Lead));
            assert!(!status.belongs_to(RelationshipKind::Client));
        }
        for status in [Active, Paused, Former] {
            assert!(status.belongs_to(RelationshipKind::Client));
            assert!(!status.belongs_to(RelationshipKind::Lead));
        }
    }

    #[test]
    fn a_relationship_for_another_party_is_refused() {
        let record = party("acme-industries");
        let stray = relationship(
            "other-business",
            RelationshipKind::Lead,
            RelationshipStatus::Accepted,
        );
        assert_eq!(
            validate_relationship(&stray, &record),
            Err(PartyContractError::MismatchedReference(
                "relationship.partyId"
            ))
        );
    }

    /// The retired handle's view has to arrive at the survivor's coordinate,
    /// or the merge leaves a Lead hanging off a handle that only redirects.
    #[test]
    fn a_relationship_with_no_counterpart_moves_to_the_survivor_intact() {
        let retired = relationship(
            "acme-old",
            RelationshipKind::Lead,
            RelationshipStatus::Qualified,
        );
        let moved = repoint_relationship(&retired, None, "acme-industries", 1_785_400_000)
            .expect("no counterpart is not a conflict");
        assert_eq!(moved.id, "acme-industries:lead");
        assert_eq!(moved.party_id, "acme-industries");
        assert_eq!(moved.status, RelationshipStatus::Qualified);
        assert_eq!(moved.owner_persona_id, retired.owner_persona_id);
        assert_eq!(moved.created_at, retired.created_at);
        assert_eq!(moved.updated_at, 1_785_400_000);
    }

    /// Which handle survived a merge is an accident of who typed the command.
    /// It must not decide how far along the company thinks the relationship is.
    #[test]
    fn a_collision_keeps_the_further_progressed_status_either_way_round() {
        let behind = relationship(
            "acme-old",
            RelationshipKind::Lead,
            RelationshipStatus::Candidate,
        );
        let ahead = relationship(
            "acme-industries",
            RelationshipKind::Lead,
            RelationshipStatus::Qualified,
        );
        let survivor_ahead = repoint_relationship(&behind, Some(&ahead), "acme-industries", 1)
            .expect("both live merges");
        let survivor_behind = repoint_relationship(&ahead, Some(&behind), "acme-industries", 1)
            .expect("both live merges");
        assert_eq!(survivor_ahead.status, RelationshipStatus::Qualified);
        assert_eq!(survivor_behind.status, RelationshipStatus::Qualified);
    }

    /// A merge is a discovery that two records are one party. It is not a
    /// reassignment, so the survivor's accountable persona keeps the work.
    #[test]
    fn a_collision_leaves_accountability_with_the_surviving_record() {
        let retired = relationship(
            "acme-old",
            RelationshipKind::Lead,
            RelationshipStatus::Qualified,
        );
        let mut existing = relationship(
            "acme-industries",
            RelationshipKind::Lead,
            RelationshipStatus::Accepted,
        );
        existing.owner_persona_id = "company-role:abc:horizonlabs:account-lead".to_string();
        existing.source_channel_id = "accounts".to_string();
        let merged = repoint_relationship(&retired, Some(&existing), "acme-industries", 1)
            .expect("both live merges");
        assert_eq!(merged.owner_persona_id, existing.owner_persona_id);
        assert_eq!(merged.source_channel_id, existing.source_channel_id);
    }

    /// The relationship is as old as the first evidence of it, whichever handle
    /// that evidence happened to arrive under.
    #[test]
    fn a_collision_dates_the_relationship_from_the_earlier_side() {
        let mut retired = relationship(
            "acme-old",
            RelationshipKind::Client,
            RelationshipStatus::Active,
        );
        retired.created_at = 1_700_000_000;
        let mut existing = relationship(
            "acme-industries",
            RelationshipKind::Client,
            RelationshipStatus::Active,
        );
        existing.created_at = 1_785_369_600;
        let merged = repoint_relationship(&retired, Some(&existing), "acme-industries", 1)
            .expect("both live merges");
        assert_eq!(merged.created_at, 1_700_000_000);
    }

    /// Both answers here are wrong in a way nobody would notice, so the merge
    /// stops in front of the human who can settle it.
    #[test]
    fn an_ended_relationship_meeting_a_live_one_refuses_rather_than_picking() {
        for (left, right) in [
            (RelationshipStatus::Active, RelationshipStatus::Former),
            (RelationshipStatus::Former, RelationshipStatus::Active),
            (
                RelationshipStatus::Qualified,
                RelationshipStatus::Disqualified,
            ),
            (
                RelationshipStatus::Disqualified,
                RelationshipStatus::Candidate,
            ),
        ] {
            assert_eq!(
                merge_relationship_status(left, right),
                Err(PartyContractError::ConflictingRelationshipStatuses),
                "{left:?} against {right:?} must not resolve silently"
            );
        }
    }

    /// Each view has exactly one terminal state, so two ended sides are the
    /// same state and merging them decides nothing.
    #[test]
    fn two_ended_sides_are_the_same_state_and_merge_cleanly() {
        for status in [RelationshipStatus::Former, RelationshipStatus::Disqualified] {
            assert_eq!(merge_relationship_status(status, status), Ok(status));
        }
    }

    /// Enumerating kinds is how a merge finds every relationship coordinate a
    /// retired handle could hold. A kind missing from the list is a view that
    /// silently fails to follow the merge.
    #[test]
    fn every_relationship_kind_is_enumerable_for_a_merge() {
        for kind in ALL_RELATIONSHIP_KINDS {
            let record = party("acme-industries");
            let view = relationship(
                "acme-industries",
                kind,
                match kind {
                    RelationshipKind::Lead => RelationshipStatus::Candidate,
                    RelationshipKind::Client => RelationshipStatus::Active,
                },
            );
            assert_eq!(validate_relationship(&view, &record), Ok(()));
            assert_eq!(
                view.id,
                relationship_coordinate("acme-industries", kind),
                "the coordinate a merge would look under must be the one in use"
            );
        }
    }

    /// The coordinate is what makes a second Lead on the same party impossible,
    /// so an ID that does not derive from the party and the view would let one
    /// exist.
    #[test]
    fn a_relationship_id_that_is_not_derived_from_its_coordinate_is_refused() {
        let record = party("acme-industries");
        let mut hand_rolled = relationship(
            "acme-industries",
            RelationshipKind::Lead,
            RelationshipStatus::Accepted,
        );
        hand_rolled.id = "acme-industries:prospect".to_string();
        assert_eq!(
            validate_relationship(&hand_rolled, &record),
            Err(PartyContractError::MismatchedReference("relationship.id"))
        );
    }

    #[test]
    fn lead_transitions_follow_the_contract() {
        use RelationshipStatus::*;
        let lead = RelationshipKind::Lead;
        for (from, to) in [
            (Candidate, Accepted),
            (Accepted, Qualified),
            (Qualified, Dormant),
            (Dormant, Qualified),
            (Accepted, Disqualified),
        ] {
            assert!(
                is_relationship_transition_allowed(lead, from, to),
                "{from:?} -> {to:?} should be allowed"
            );
        }
        for (from, to) in [
            (Disqualified, Qualified),
            (Qualified, Candidate),
            (Accepted, Candidate),
        ] {
            assert!(
                !is_relationship_transition_allowed(lead, from, to),
                "{from:?} -> {to:?} must be refused"
            );
        }
    }

    #[test]
    fn client_transitions_follow_the_contract() {
        use RelationshipStatus::*;
        let client = RelationshipKind::Client;
        for (from, to) in [(Active, Paused), (Paused, Active), (Active, Former)] {
            assert!(is_relationship_transition_allowed(client, from, to));
        }
        // A former client is re-engaged by a new agreement, not by editing the
        // old one back to active.
        for (from, to) in [(Former, Active), (Former, Paused)] {
            assert!(
                !is_relationship_transition_allowed(client, from, to),
                "{from:?} -> {to:?} must be refused"
            );
        }
    }

    #[test]
    fn a_relationship_replacement_may_not_change_its_party_or_view() {
        let record = party("acme-industries");
        let previous = relationship(
            "acme-industries",
            RelationshipKind::Lead,
            RelationshipStatus::Accepted,
        );
        let mut switched = previous.clone();
        switched.updated_at += 1;
        switched.relationship = RelationshipKind::Client;
        switched.status = RelationshipStatus::Active;
        assert!(validate_relationship_update(&previous, &switched, &record).is_err());
    }

    // --- Gate C: merge without loss ---------------------------------------

    #[test]
    fn a_merge_keeps_every_identifier_and_every_observation() {
        let mut survivor = party("acme-industries");
        survivor.identifiers = vec![identifier(IdentifierScheme::Domain, "acme.example")];
        survivor.provenance = vec![provenance("prov-01", &["displayName"])];

        let mut retired = party("acme-inc");
        retired.identifiers = vec![identifier(IdentifierScheme::Email, "hi@acme.example")];
        retired.provenance = vec![provenance("prov-02", &["identifiers"])];

        let merged = merge_parties(&survivor, &retired).expect("merge");
        assert_eq!(merged.id, "acme-industries");
        assert_eq!(merged.identifiers.len(), 2, "both claims survive");
        assert_eq!(merged.provenance.len(), 2, "both observations survive");
        assert!(
            merged.retired_handles.contains(&"acme-inc".to_string()),
            "the merged-away handle is recorded on the survivor"
        );
    }

    #[test]
    fn a_merge_does_not_duplicate_a_claim_both_sides_already_made() {
        let survivor = party("acme-industries");
        let mut retired = party("acme-inc");
        retired.identifiers = vec![identifier(IdentifierScheme::Domain, "acme.example")];
        retired.provenance = vec![provenance("prov-01", &["displayName", "identifiers"])];

        let merged = merge_parties(&survivor, &retired).expect("merge");
        assert_eq!(merged.identifiers.len(), 1);
        assert_eq!(merged.provenance.len(), 1);
    }

    #[test]
    fn merging_a_party_into_itself_is_refused() {
        let record = party("acme-industries");
        assert_eq!(
            merge_parties(&record, &record),
            Err(PartyContractError::CircularAlias)
        );
    }

    #[test]
    fn merging_a_handle_that_was_already_retired_is_refused() {
        let survivor = party("acme-industries");
        let mut already = party("acme-inc");
        already.retired_handles = vec!["acme-old".to_string()];
        // The retired side is fine; what must be refused is retiring a handle
        // the survivor already absorbed.
        let mut twice = survivor.clone();
        twice.retired_handles = vec!["acme-inc".to_string()];
        assert_eq!(
            merge_parties(&twice, &already),
            Err(PartyContractError::AlreadyRetired)
        );
    }

    #[test]
    fn an_alias_that_points_at_itself_is_refused() {
        assert_eq!(
            validate_alias(&alias("acme-inc", "acme-inc")),
            Err(PartyContractError::CircularAlias)
        );
    }

    #[test]
    fn a_well_formed_alias_is_accepted() {
        validate_alias(&alias("acme-inc", "acme-industries")).expect("alias is valid");
    }

    #[test]
    fn an_alias_carries_the_action_that_authorized_it() {
        let mut unsigned = alias("acme-inc", "acme-industries");
        unsigned.merge_action_event_id = "not-an-event-id".to_string();
        assert!(
            validate_alias(&unsigned).is_err(),
            "an alias with no auditable merge behind it must be refused"
        );
    }

    // --- serde exactness ---------------------------------------------------

    /// The relay validates what it stores and clients re-parse it. An unknown
    /// field accepted here is a field the two implementations disagree about.
    #[test]
    fn unknown_fields_are_refused_on_every_record() {
        let cases = [
            (
                "party",
                serde_json::to_value(party("acme-industries")).expect("party json"),
            ),
            (
                "alias",
                serde_json::to_value(alias("acme-inc", "acme-industries")).expect("alias json"),
            ),
            (
                "relationship",
                serde_json::to_value(relationship(
                    "acme-industries",
                    RelationshipKind::Lead,
                    RelationshipStatus::Accepted,
                ))
                .expect("relationship json"),
            ),
        ];
        for (label, mut value) in cases {
            value
                .as_object_mut()
                .expect("object")
                .insert("favouriteColour".to_string(), serde_json::json!("violet"));
            let round_trip = match label {
                "party" => serde_json::from_value::<Party>(value).err().is_some(),
                "alias" => serde_json::from_value::<PartyAlias>(value).err().is_some(),
                _ => serde_json::from_value::<PartyRelationship>(value)
                    .err()
                    .is_some(),
            };
            assert!(round_trip, "{label} must refuse an unknown field");
        }
    }

    #[test]
    fn bounded_collections_are_bounded() {
        let mut huge = party("acme-industries");
        huge.identifiers = (0..=MAX_IDENTIFIERS)
            .map(|index| identifier(IdentifierScheme::Domain, &format!("acme{index}.example")))
            .collect();
        assert!(validate_party(&huge).is_err(), "identifiers are bounded");

        let mut many = party("acme-industries");
        many.provenance = (0..=MAX_PROVENANCE)
            .map(|index| provenance(&format!("prov-{index}"), &["displayName"]))
            .collect();
        assert!(validate_party(&many).is_err(), "provenance is bounded");

        let mut chained = party("acme-industries");
        chained.retired_handles = (0..=MAX_RETIRED_HANDLES)
            .map(|index| format!("acme-{index}"))
            .collect();
        assert!(
            validate_party(&chained).is_err(),
            "retired handles are bounded"
        );
    }

    #[test]
    fn provenance_ids_are_unique_within_a_party() {
        let mut collided = party("acme-industries");
        collided.provenance = vec![
            provenance("prov-01", &["displayName"]),
            provenance("prov-01", &["identifiers"]),
        ];
        assert!(
            validate_party(&collided).is_err(),
            "two observations cannot share an id"
        );
        let unique: HashSet<&str> = collided
            .provenance
            .iter()
            .map(|entry| entry.id.as_str())
            .collect();
        assert_eq!(unique.len(), 1, "the fixture really does collide");
    }
}

/// How far a handle may be chased through aliases before a reader gives up.
///
/// Merges chain: a handle merged into one that was later merged again resolves
/// in two hops. A cap keeps a cycle that slipped past validation survivable at
/// read time, because a reader that looped would hang rather than report a
/// broken record.
pub const MAX_ALIAS_HOPS: usize = 8;

/// What a handle resolved to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandleResolution {
    /// The handle is a live party.
    Live {
        /// The handle asked for, which is also the one that answered.
        handle: String,
    },
    /// The handle was merged away and now points somewhere else.
    Redirected {
        /// The live handle at the end of the chain.
        handle: String,
        /// How many aliases were followed to get there.
        hops: usize,
    },
    /// Nothing is stored at that coordinate.
    Unknown,
    /// The chain did not end within [`MAX_ALIAS_HOPS`].
    ///
    /// Reported rather than followed further: a caller needs to know its
    /// reference is unusable, and the alternative is an unbounded loop.
    Broken {
        /// Where the chase gave up.
        handle: String,
    },
}

/// One coordinate's current occupant, as a resolver sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandleOccupant {
    /// A live party.
    Party,
    /// A pointer to another handle.
    Alias {
        /// The handle it points at.
        resolves_to: String,
    },
}

/// The walk itself, with no opinion about where occupants come from.
///
/// Callers differ only in how they load a handle: a test hands over a map, the
/// CLI and the desktop each issue one query per hop. The guards that make the
/// walk safe -- the hop cap and the revisit check -- live here once, so a
/// synchronous caller and an asynchronous one cannot drift apart on the two
/// rules that matter.
struct HandleWalk {
    handle: String,
    seen: HashSet<String>,
    hops: usize,
}

impl HandleWalk {
    fn new(start: &str) -> Self {
        let mut seen = HashSet::new();
        seen.insert(start.to_owned());
        Self {
            handle: start.to_owned(),
            seen,
            hops: 0,
        }
    }

    /// The handle to load next, or `None` once the walk has run past the cap.
    fn next_handle(&self) -> Option<&str> {
        (self.hops <= MAX_ALIAS_HOPS).then_some(self.handle.as_str())
    }

    /// Feed in what was found. `Some` means the walk is over.
    fn step(&mut self, found: Option<HandleOccupant>) -> Option<HandleResolution> {
        match found {
            None => Some(if self.hops == 0 {
                HandleResolution::Unknown
            } else {
                // An alias pointing at nothing is a dangling reference, not an
                // absent one: something was merged into a handle that no longer
                // resolves.
                HandleResolution::Broken {
                    handle: self.handle.clone(),
                }
            }),
            Some(HandleOccupant::Party) => Some(if self.hops == 0 {
                HandleResolution::Live {
                    handle: self.handle.clone(),
                }
            } else {
                HandleResolution::Redirected {
                    handle: self.handle.clone(),
                    hops: self.hops,
                }
            }),
            Some(HandleOccupant::Alias { resolves_to }) => {
                if !self.seen.insert(resolves_to.clone()) {
                    return Some(HandleResolution::Broken {
                        handle: resolves_to,
                    });
                }
                self.handle = resolves_to;
                self.hops += 1;
                None
            }
        }
    }

    /// The answer when the chain outran the cap.
    fn ran_out(self) -> HandleResolution {
        HandleResolution::Broken {
            handle: self.handle,
        }
    }
}

/// Chase a handle to the live party it names.
///
/// `load` answers what is stored at one coordinate. Kept as a closure so the
/// chase is testable without a relay. Use this when every occupant is already
/// in hand; [`resolve_party_handle_async`] is the one to reach for when each
/// hop is a query.
pub fn resolve_party_handle<F>(start: &str, mut load: F) -> HandleResolution
where
    F: FnMut(&str) -> Option<HandleOccupant>,
{
    let mut walk = HandleWalk::new(start);
    loop {
        let Some(handle) = walk.next_handle().map(str::to_owned) else {
            return walk.ran_out();
        };
        if let Some(resolution) = walk.step(load(&handle)) {
            return resolution;
        }
    }
}

/// Resolve a handle when each hop is a query rather than a map lookup.
///
/// This is what a client with a relay behind it uses. The walk is bounded by
/// [`MAX_ALIAS_HOPS`], so it costs at most nine reads and in practice one or
/// two -- which is why no client needs to hold every party in memory to answer
/// where a handle points.
pub async fn resolve_party_handle_async<F, Fut>(start: &str, mut load: F) -> HandleResolution
where
    F: FnMut(String) -> Fut,
    Fut: core::future::Future<Output = Option<HandleOccupant>>,
{
    let mut walk = HandleWalk::new(start);
    loop {
        let Some(handle) = walk.next_handle().map(str::to_owned) else {
            return walk.ran_out();
        };
        let found = load(handle).await;
        if let Some(resolution) = walk.step(found) {
            return resolution;
        }
    }
}

/// Whether a status is the end of its lifecycle.
///
/// Each view has exactly one: a Lead ends Disqualified, a Client ends Former.
pub const fn is_terminal_status(status: RelationshipStatus) -> bool {
    matches!(
        status,
        RelationshipStatus::Disqualified | RelationshipStatus::Former
    )
}

/// The status a merged relationship keeps, or a refusal to choose.
///
/// Among live states the further-progressed one wins. A party that was already
/// a qualified Lead under one handle does not become a fresh candidate because
/// the other handle had never been worked.
///
/// An ended state facing a live one is refused rather than resolved. Both
/// answers are wrong in a way nobody would see: taking the ended side marks a
/// paying client former, and taking the live side quietly undoes a
/// disqualification somebody decided on. Since each view has one terminal
/// state, two ended sides are the same state and merge cleanly -- only the
/// mixed case stops, and it stops in front of the human who can settle it.
pub const fn merge_relationship_status(
    left: RelationshipStatus,
    right: RelationshipStatus,
) -> Result<RelationshipStatus, PartyContractError> {
    if is_terminal_status(left) != is_terminal_status(right) {
        return Err(PartyContractError::ConflictingRelationshipStatuses);
    }
    Ok(if progress_rank(left) >= progress_rank(right) {
        left
    } else {
        right
    })
}

/// Every relationship kind a party can carry.
///
/// A merge has to find the retired handle's relationships to re-point them, and
/// the coordinate is derived, so the finite set of kinds enumerates every
/// coordinate that could exist. That is a bounded pair of lookups instead of a
/// scan, and it cannot miss one the way a prefix query over live data can.
pub const ALL_RELATIONSHIP_KINDS: [RelationshipKind; 2] =
    [RelationshipKind::Lead, RelationshipKind::Client];

/// The coordinate a relationship lives at.
///
/// Deriving it, rather than letting a caller name it, is what makes a second
/// Lead on one party structurally impossible: there is nowhere else to put it.
pub fn relationship_coordinate(party_id: &str, kind: RelationshipKind) -> String {
    format!("{party_id}:{}", kind.slug())
}

/// Move a retired party's relationship onto the survivor of a merge.
///
/// A relationship is a view over an identity. When two identities turn out to
/// be one, the views have to follow, or the company is left with a Lead hanging
/// off a coordinate that now only redirects and a Client on the survivor that
/// does not know about it.
///
/// `survivor_existing` is the relationship already at the destination, if any.
/// When both sides carry the same kind the two collapse into one:
///
/// - Status takes the further-progressed side, so a merge never demotes a live
///   customer to a lead because of which handle happened to survive. An ended
///   state facing a live one refuses instead, and the merge stops with it.
/// - Accountability stays with the survivor's persona and channel. The survivor
///   is the record the company keeps working, and a merge is not a reassignment.
/// - `created_at` takes the earlier side. The relationship is as old as the
///   first evidence of it, whichever handle that evidence arrived under.
pub fn repoint_relationship(
    retired: &PartyRelationship,
    survivor_existing: Option<&PartyRelationship>,
    survivor_id: &str,
    now: i64,
) -> Result<PartyRelationship, PartyContractError> {
    let kind = retired.relationship;
    Ok(match survivor_existing {
        Some(existing) => PartyRelationship {
            id: relationship_coordinate(survivor_id, kind),
            party_id: survivor_id.to_owned(),
            status: merge_relationship_status(existing.status, retired.status)?,
            owner_persona_id: existing.owner_persona_id.clone(),
            source_channel_id: existing.source_channel_id.clone(),
            created_at: existing.created_at.min(retired.created_at),
            updated_at: now,
            ..existing.clone()
        },
        None => PartyRelationship {
            id: relationship_coordinate(survivor_id, kind),
            party_id: survivor_id.to_owned(),
            updated_at: now,
            ..retired.clone()
        },
    })
}

/// How far through its lifecycle a status sits, for merge comparison only.
const fn progress_rank(status: RelationshipStatus) -> u8 {
    use RelationshipStatus::*;
    match status {
        Candidate => 0,
        Dormant | Paused => 1,
        Accepted => 2,
        Qualified | Active => 3,
        Disqualified | Former => 4,
    }
}

#[cfg(test)]
mod handle_tests {
    use super::*;
    use std::collections::HashMap;

    fn resolver(entries: &[(&str, HandleOccupant)]) -> impl FnMut(&str) -> Option<HandleOccupant> {
        let map: HashMap<String, HandleOccupant> = entries
            .iter()
            .map(|(handle, occupant)| ((*handle).to_string(), occupant.clone()))
            .collect();
        move |handle: &str| map.get(handle).cloned()
    }

    fn alias_owned(to: String) -> HandleOccupant {
        HandleOccupant::Alias { resolves_to: to }
    }

    fn alias(to: &str) -> HandleOccupant {
        HandleOccupant::Alias {
            resolves_to: to.to_string(),
        }
    }

    #[test]
    fn a_live_handle_resolves_to_itself_with_no_hops() {
        let resolution = resolve_party_handle(
            "acme-industries",
            resolver(&[("acme-industries", HandleOccupant::Party)]),
        );
        assert_eq!(
            resolution,
            HandleResolution::Live {
                handle: "acme-industries".to_string()
            }
        );
    }

    /// The whole reason merging is safe: a reference handed out before a merge
    /// still lands on the party that absorbed it.
    #[test]
    fn a_retired_handle_still_reaches_the_survivor() {
        let resolution = resolve_party_handle(
            "acme-inc",
            resolver(&[
                ("acme-inc", alias("acme-industries")),
                ("acme-industries", HandleOccupant::Party),
            ]),
        );
        assert_eq!(
            resolution,
            HandleResolution::Redirected {
                handle: "acme-industries".to_string(),
                hops: 1,
            }
        );
    }

    #[test]
    fn merges_chain_and_the_oldest_handle_still_arrives() {
        let resolution = resolve_party_handle(
            "acme-old",
            resolver(&[
                ("acme-old", alias("acme-inc")),
                ("acme-inc", alias("acme-industries")),
                ("acme-industries", HandleOccupant::Party),
            ]),
        );
        assert_eq!(
            resolution,
            HandleResolution::Redirected {
                handle: "acme-industries".to_string(),
                hops: 2,
            }
        );
    }

    /// Drive a future to completion without a runtime.
    ///
    /// The loaders below never yield, so the first poll always completes.
    /// buzz-core carries no I/O dependencies on purpose, and a test is not a
    /// reason to add one.
    fn block_on<F: core::future::Future>(future: F) -> F::Output {
        let mut future = core::pin::pin!(future);
        let waker = core::task::Waker::noop();
        let mut context = core::task::Context::from_waker(waker);
        match future.as_mut().poll(&mut context) {
            core::task::Poll::Ready(value) => value,
            core::task::Poll::Pending => {
                panic!("a handle walk must never need to wait on anything but its loader")
            }
        }
    }

    /// Every fixture the two resolvers are held to agree on.
    fn walk_fixtures() -> [(&'static str, Vec<(&'static str, HandleOccupant)>); 6] {
        [
            (
                "acme-industries",
                vec![("acme-industries", HandleOccupant::Party)],
            ),
            (
                "acme-old",
                vec![
                    ("acme-old", alias("acme-industries")),
                    ("acme-industries", HandleOccupant::Party),
                ],
            ),
            (
                "acme-oldest",
                vec![
                    ("acme-oldest", alias("acme-old")),
                    ("acme-old", alias("acme-industries")),
                    ("acme-industries", HandleOccupant::Party),
                ],
            ),
            ("nobody", vec![("acme-industries", HandleOccupant::Party)]),
            ("acme-inc", vec![("acme-inc", alias("gone"))]),
            ("a", vec![("a", alias("b")), ("b", alias("a"))]),
        ]
    }

    /// Two implementations of the same walk are two chances to get it wrong.
    ///
    /// The synchronous one serves callers holding every occupant already; the
    /// asynchronous one serves a client issuing a query per hop. They share the
    /// guards, and this holds them to the same answers so a future edit to one
    /// cannot silently change the other.
    #[test]
    fn the_async_walk_answers_exactly_what_the_sync_walk_answers() {
        for (start, entries) in walk_fixtures() {
            let expected = resolve_party_handle(start, resolver(&entries));
            let map: std::collections::BTreeMap<String, HandleOccupant> = entries
                .iter()
                .map(|(handle, occupant)| ((*handle).to_owned(), occupant.clone()))
                .collect();
            let actual = block_on(resolve_party_handle_async(start, |handle: String| {
                let found = map.get(&handle).cloned();
                async move { found }
            }));
            assert_eq!(actual, expected, "the two walks disagree about {start}");
        }
    }

    /// The reason a client does not need every party in memory.
    ///
    /// A walk costs one read per hop and stops at the cap, so resolving a
    /// handle is bounded work no matter how many parties a company holds.
    #[test]
    fn a_walk_reads_one_handle_per_hop_and_never_more_than_the_cap() {
        let entries = [
            ("acme-oldest", alias("acme-old")),
            ("acme-old", alias("acme-industries")),
            ("acme-industries", HandleOccupant::Party),
        ];
        let map: std::collections::BTreeMap<String, HandleOccupant> = entries
            .iter()
            .map(|(handle, occupant)| ((*handle).to_owned(), occupant.clone()))
            .collect();

        let mut reads = 0usize;
        let resolution = block_on(resolve_party_handle_async(
            "acme-oldest",
            |handle: String| {
                reads += 1;
                let found = map.get(&handle).cloned();
                async move { found }
            },
        ));
        assert_eq!(
            resolution,
            HandleResolution::Redirected {
                handle: "acme-industries".to_string(),
                hops: 2
            }
        );
        assert_eq!(reads, 3, "two merges cost three reads, not the party set");

        // A chain past the cap still stops, and stops at the cap.
        let mut long: Vec<(String, HandleOccupant)> = Vec::new();
        for index in 0..=(MAX_ALIAS_HOPS + 2) {
            long.push((
                format!("link-{index}"),
                alias_owned(format!("link-{}", index + 1)),
            ));
        }
        let long: std::collections::BTreeMap<String, HandleOccupant> = long.into_iter().collect();
        let mut reads = 0usize;
        let resolution = block_on(resolve_party_handle_async("link-0", |handle: String| {
            reads += 1;
            let found = long.get(&handle).cloned();
            async move { found }
        }));
        assert!(matches!(resolution, HandleResolution::Broken { .. }));
        assert_eq!(
            reads,
            MAX_ALIAS_HOPS + 1,
            "the cap bounds the reads, not just the answer"
        );
    }

    /// Validation refuses cycles, but a reader must survive one that slipped
    /// past rather than loop forever.
    ///
    /// Asserts the exact handle rather than only the variant. The hop cap stops
    /// a cycle on its own, so a `matches!(Broken { .. })` test passes with the
    /// revisit check deleted and proves nothing about it. What the revisit check
    /// buys is naming where the loop closed instead of wherever the ninth
    /// pointless load happened to land.
    #[test]
    fn a_cycle_is_reported_where_it_closes_not_where_the_cap_runs_out() {
        let resolution =
            resolve_party_handle("a", resolver(&[("a", alias("b")), ("b", alias("a"))]));
        assert_eq!(
            resolution,
            HandleResolution::Broken {
                handle: "a".to_string()
            }
        );
    }

    #[test]
    fn a_chain_longer_than_the_cap_is_reported_as_broken() {
        let mut entries: Vec<(String, HandleOccupant)> = (0..MAX_ALIAS_HOPS + 2)
            .map(|index| (format!("h{index}"), alias(&format!("h{}", index + 1))))
            .collect();
        entries.push((format!("h{}", MAX_ALIAS_HOPS + 2), HandleOccupant::Party));
        let map: HashMap<String, HandleOccupant> = entries.into_iter().collect();
        let resolution = resolve_party_handle("h0", |handle| map.get(handle).cloned());
        assert!(matches!(resolution, HandleResolution::Broken { .. }));
    }

    #[test]
    fn an_unknown_handle_and_a_dangling_alias_are_different_answers() {
        assert_eq!(
            resolve_party_handle("nobody", resolver(&[])),
            HandleResolution::Unknown
        );
        assert!(matches!(
            resolve_party_handle("acme-inc", resolver(&[("acme-inc", alias("gone"))])),
            HandleResolution::Broken { .. }
        ));
    }

    #[test]
    fn merging_relationship_status_keeps_the_further_progressed_live_state() {
        use RelationshipStatus::*;
        assert_eq!(
            merge_relationship_status(Candidate, Qualified),
            Ok(Qualified)
        );
        assert_eq!(
            merge_relationship_status(Qualified, Candidate),
            Ok(Qualified)
        );
        assert_eq!(merge_relationship_status(Accepted, Dormant), Ok(Accepted));
        assert_eq!(merge_relationship_status(Active, Paused), Ok(Active));
    }
}
