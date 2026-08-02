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
    /// Company that owns this view of the party.
    pub company_id: String,
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
    /// Company that owns the merge.
    pub company_id: String,
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
    /// Company that owns the relationship.
    pub company_id: String,
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
    validate_id(&party.company_id, "party.companyId")?;
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
    validate_immutable(
        &previous.company_id,
        &replacement.company_id,
        "party.companyId",
    )?;
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
    validate_id(&alias.company_id, "alias.companyId")?;
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
    validate_id(&relationship.company_id, "relationship.companyId")?;
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
    if relationship.company_id != party.company_id {
        return Err(PartyContractError::MismatchedReference(
            "relationship.companyId",
        ));
    }
    // The coordinate is what makes a second Lead on one party impossible, so an
    // ID that does not derive from the party and the view would let one exist.
    let expected = format!(
        "{}:{}",
        relationship.party_id,
        relationship.relationship.slug()
    );
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
    validate_immutable(
        &previous.company_id,
        &replacement.company_id,
        "relationship.companyId",
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

    if survivor.company_id != retired.company_id {
        return Err(PartyContractError::MismatchedReference("party.companyId"));
    }
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
            company_id: "horizonlabs".to_string(),
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
            company_id: "horizonlabs".to_string(),
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
            company_id: "horizonlabs".to_string(),
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
        let cases: [Mutation; 3] = [
            ("handle", |p: &mut Party| p.id = "acme-inc".to_string()),
            ("company", |p: &mut Party| {
                p.company_id = "someone-else".to_string()
            }),
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
    fn parties_from_different_companies_never_merge() {
        let survivor = party("acme-industries");
        let mut foreign = party("acme-inc");
        foreign.company_id = "someone-else".to_string();
        assert_eq!(
            merge_parties(&survivor, &foreign),
            Err(PartyContractError::MismatchedReference("party.companyId"))
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
