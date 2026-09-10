//! Validation for review records, revisions, decisions, and handovers.
//!
//! Validation is pure and never mutates: a record that fails any rule is
//! rejected whole, so a tampered persisted record cannot be partially trusted.
//! Decision ids are re-derived from their payload, approvals must mirror the
//! approve decisions, and the active approval must match the current revision.

use std::collections::BTreeSet;

use super::super::error::WebsiteError;
use super::super::preview::{
    is_lower_hex64, parse_preview_manifest, sha256_hex, validate_asset_path, validate_public_url,
    validate_sha256, PreviewArtifactRef, MAX_NOTE_LEN,
};
use super::types::{
    DecisionKind, HandoverAsset, QaEvidence, StageEvidence, WebsiteCaptures, WebsiteDecision,
    WebsiteHandover, WebsiteReview, WebsiteRevision, WebsiteStatus, MAX_ACCESS_REQUEST_CHARS,
    MAX_DECISIONS, MAX_HANDOVER_ASSETS, MAX_REVISIONS, MAX_SCOPE_LEN, MAX_STAGE_EVIDENCE,
    REVIEW_SCHEMA,
};

impl WebsiteCaptures {
    /// Validate all three capture artifact refs.
    pub(super) fn validate(&self) -> Result<(), WebsiteError> {
        validate_artifact_ref(&self.before)?;
        validate_artifact_ref(&self.desktop)?;
        validate_artifact_ref(&self.mobile)
    }
}

impl QaEvidence {
    /// Validate the reviewer identity, hashes, and references.
    pub(super) fn validate(&self) -> Result<(), WebsiteError> {
        validate_identity("qa.reviewer", &self.reviewer)?;
        validate_sha256(&self.manifest_sha256)?;
        validate_event_id("qa.reportEventId", &self.report_event_id)?;
        validate_artifact_ref(&self.report)
    }
}

impl StageEvidence {
    /// Validate the evidence event id and optional revision bound.
    pub(super) fn validate(&self, current_revision: u32) -> Result<(), WebsiteError> {
        validate_event_id("stageEvidence.eventId", &self.event_id)?;
        if let Some(revision) = self.revision {
            if revision == 0 || revision > current_revision {
                return Err(WebsiteError::UnknownRevision(revision));
            }
        }
        Ok(())
    }
}

impl WebsiteRevision {
    /// Validate one revision in isolation, including its QA binding.
    pub(super) fn validate(&self) -> Result<(), WebsiteError> {
        if self.revision == 0 {
            return Err(WebsiteError::RevisionNumberMismatch(1, self.revision));
        }
        validate_artifact_ref(&self.preview)?;
        validate_public_url(&self.source_url)?;
        validate_artifact_ref(&self.archive)?;
        self.captures.validate()?;
        validate_identity("revision.builtBy", &self.built_by)?;
        if let Some(qa) = &self.qa {
            qa.validate()?;
            if qa.revision != self.revision {
                return Err(WebsiteError::QaMismatch("revision"));
            }
            if qa.manifest_sha256 != self.preview.sha256 {
                return Err(WebsiteError::QaMismatch("manifestSha256"));
            }
            if qa.reviewer == self.built_by {
                return Err(WebsiteError::QaNotIndependent(qa.reviewer.clone()));
            }
        }
        Ok(())
    }
}

impl HandoverAsset {
    /// Validate the asset path and artifact ref.
    pub(super) fn validate(&self) -> Result<(), WebsiteError> {
        validate_asset_path(&self.path)?;
        validate_artifact_ref(&self.artifact)
    }
}

impl WebsiteHandover {
    /// Validate the handover against the revision and approval it names.
    ///
    /// The named revision does not have to be current: a handover is retained
    /// as history after a later `requestChanges` or new revision, and this
    /// validation proves only that it closed out the revision it claims.
    pub(super) fn validate(&self, review: &WebsiteReview) -> Result<(), WebsiteError> {
        if self.job_id != review.job_id {
            return Err(WebsiteError::HandoverMismatch("jobId"));
        }
        if self.task_id != review.task_id {
            return Err(WebsiteError::HandoverMismatch("taskId"));
        }
        let revision = review
            .revisions
            .iter()
            .find(|revision| revision.revision == self.approved_revision)
            .ok_or(WebsiteError::HandoverMismatch("approvedRevision"))?;
        if self.approved_manifest_sha256 != revision.preview.sha256 {
            return Err(WebsiteError::HandoverMismatch("approvedManifestSha256"));
        }
        validate_public_url(&self.source_url)?;
        if self.source_url != revision.source_url {
            return Err(WebsiteError::HandoverMismatch("sourceUrl"));
        }
        validate_artifact_ref(&self.source_archive)?;
        if self.source_archive != revision.archive {
            return Err(WebsiteError::HandoverMismatch("sourceArchive"));
        }
        let approved = review.approvals.iter().any(|decision| {
            decision.kind == DecisionKind::Approve
                && decision.revision == revision.revision
                && decision.manifest_sha256 == revision.preview.sha256
        });
        if !approved {
            return Err(WebsiteError::HandoverMismatch("approval"));
        }
        // An approval alone is not enough: the approved revision must carry
        // independent QA that passed. `WebsiteReview::validate` enforces this
        // for every stored approval, and this call keeps a direct
        // `record_handover` on an in-memory record equally strict.
        require_passing_qa(revision)?;
        validate_identity("handover.acceptedBy", &self.accepted_by)?;
        let authorized = self.accepted_by == review.owner
            || review.coordinator.as_deref() == Some(self.accepted_by.as_str());
        if !authorized {
            return Err(WebsiteError::NotAuthorized(self.accepted_by.clone()));
        }
        if self.assets.is_empty() {
            return Err(WebsiteError::InvalidHandover("assets"));
        }
        if self.assets.len() > MAX_HANDOVER_ASSETS {
            return Err(WebsiteError::TooManyHandoverAssets(
                self.assets.len(),
                MAX_HANDOVER_ASSETS,
            ));
        }
        let mut seen = BTreeSet::new();
        for asset in &self.assets {
            asset.validate()?;
            if !seen.insert(asset.path.as_str()) {
                return Err(WebsiteError::InvalidHandover("duplicateAssetPath"));
            }
        }
        let builder_evidence = review
            .stage_evidence
            .iter()
            .any(|evidence| evidence.revision == Some(revision.revision));
        if !builder_evidence {
            return Err(WebsiteError::InvalidHandover("builderEvidence"));
        }
        if let Some(access) = &self.access_request {
            validate_identity("handover.accessRequest.authoredBy", &access.authored_by)?;
            let length = access.text.chars().count();
            if access.text.trim().is_empty() || length > MAX_ACCESS_REQUEST_CHARS {
                return Err(WebsiteError::InvalidHandover("accessRequest"));
            }
            if access
                .text
                .chars()
                .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
            {
                return Err(WebsiteError::InvalidHandover("accessRequest"));
            }
        }
        Ok(())
    }
}

/// Verify that every handover asset is a member of the approved manifest.
///
/// `manifest_bytes` must be the exact manifest bytes whose SHA-256 is the
/// revision's `preview.sha256`. This helper hashes the slice it is given and
/// compares it to the handover's `approvedManifestSha256`, so the caller does
/// not have to trust its own copy, then parses the manifest (bounded by the
/// manifest size limit) and requires every asset to match a listed file by
/// path, URL, and SHA-256. An asset that is not in the manifest, or whose
/// artifact ref differs from the manifest entry, fails with
/// [`WebsiteError::AssetNotInManifest`].
///
/// The caller must first confirm that the handover closes the review record it
/// claims (`WebsiteReview::validate` or `WebsiteHandover::validate`).
/// Downloading each URL and hashing the bytes behind it remains a broker
/// obligation; this helper proves manifest membership only.
pub fn validate_handover_assets(
    handover: &WebsiteHandover,
    manifest_bytes: &[u8],
) -> Result<(), WebsiteError> {
    let computed = sha256_hex(manifest_bytes);
    if computed != handover.approved_manifest_sha256 {
        return Err(WebsiteError::ManifestHashMismatch(
            handover.approved_manifest_sha256.clone(),
            computed,
        ));
    }
    let manifest = parse_preview_manifest(manifest_bytes)?;
    if handover.assets.is_empty() {
        return Err(WebsiteError::InvalidHandover("assets"));
    }
    if handover.assets.len() > MAX_HANDOVER_ASSETS {
        return Err(WebsiteError::TooManyHandoverAssets(
            handover.assets.len(),
            MAX_HANDOVER_ASSETS,
        ));
    }
    let mut seen = BTreeSet::new();
    for asset in &handover.assets {
        asset.validate()?;
        if !seen.insert(asset.path.as_str()) {
            return Err(WebsiteError::InvalidHandover("duplicateAssetPath"));
        }
        let Some(file) = manifest.files.iter().find(|file| file.path == asset.path) else {
            return Err(WebsiteError::AssetNotInManifest(asset.path.clone()));
        };
        if file.url != asset.artifact.url || file.sha256 != asset.artifact.sha256 {
            return Err(WebsiteError::AssetNotInManifest(asset.path.clone()));
        }
    }
    Ok(())
}

impl WebsiteReview {
    /// Validate the whole record, including cross-field invariants.
    pub fn validate(&self) -> Result<(), WebsiteError> {
        if self.schema != REVIEW_SCHEMA {
            return Err(WebsiteError::ReviewSchema(self.schema.clone()));
        }
        validate_scope_string("taskId", &self.task_id)?;
        validate_scope_string("channel", &self.channel)?;
        validate_event_id("threadRoot", &self.thread_root)?;
        validate_identity("owner", &self.owner)?;
        if let Some(coordinator) = &self.coordinator {
            validate_identity("coordinator", coordinator)?;
        }
        validate_public_url(&self.source_url)?;

        if self.revisions.len() > MAX_REVISIONS {
            return Err(WebsiteError::TooManyRevisions(
                self.revisions.len(),
                MAX_REVISIONS,
            ));
        }
        for (index, revision) in self.revisions.iter().enumerate() {
            let expected = u32::try_from(index + 1).unwrap_or(u32::MAX);
            if revision.revision != expected {
                return Err(WebsiteError::RevisionNumberMismatch(
                    expected,
                    revision.revision,
                ));
            }
            revision.validate()?;
        }
        let highest = self
            .revisions
            .last()
            .map_or(0, |revision| revision.revision);
        if self.current_revision != highest {
            return Err(WebsiteError::CurrentRevisionMismatch(
                highest,
                self.current_revision,
            ));
        }

        if self.decisions.len() > MAX_DECISIONS {
            return Err(WebsiteError::TooManyDecisions(
                self.decisions.len(),
                MAX_DECISIONS,
            ));
        }
        let mut seen_ids = BTreeSet::new();
        for decision in &self.decisions {
            self.validate_decision(decision)?;
            if !seen_ids.insert(decision.decision_id) {
                return Err(WebsiteError::DuplicateDecision(decision.decision_id));
            }
        }

        let approve_decisions: Vec<&WebsiteDecision> = self
            .decisions
            .iter()
            .filter(|decision| decision.kind == DecisionKind::Approve)
            .collect();
        if self.approvals.len() != approve_decisions.len() {
            let id = approve_decisions
                .get(self.approvals.len())
                .copied()
                .or_else(|| self.approvals.get(approve_decisions.len()))
                .map(|decision| decision.decision_id)
                .unwrap_or_default();
            return Err(WebsiteError::ApprovalMismatch(id));
        }
        for (stored, expected) in self.approvals.iter().zip(approve_decisions.iter()) {
            if stored != *expected {
                return Err(WebsiteError::ApprovalMismatch(stored.decision_id));
            }
        }
        for approval in &self.approvals {
            let revision = self
                .revisions
                .iter()
                .find(|revision| revision.revision == approval.revision)
                .ok_or(WebsiteError::UnknownRevision(approval.revision))?;
            require_passing_qa(revision)?;
        }

        match (self.active_approval_id, self.status) {
            (Some(id), WebsiteStatus::Approved | WebsiteStatus::HandedOver) => {
                let approval = self
                    .approvals
                    .iter()
                    .find(|decision| decision.decision_id == id)
                    .ok_or(WebsiteError::MissingActiveApproval(self.status.as_str()))?;
                let current = self
                    .revisions
                    .last()
                    .ok_or(WebsiteError::MissingActiveApproval(self.status.as_str()))?;
                if approval.kind != DecisionKind::Approve
                    || approval.revision != current.revision
                    || approval.manifest_sha256 != current.preview.sha256
                {
                    return Err(WebsiteError::ApprovalMismatch(id));
                }
            }
            (None, WebsiteStatus::Approved | WebsiteStatus::HandedOver) => {
                return Err(WebsiteError::MissingActiveApproval(self.status.as_str()));
            }
            (Some(_), _) => {
                return Err(WebsiteError::UnexpectedActiveApproval(self.status.as_str()))
            }
            (None, _) => {}
        }

        match self.status {
            WebsiteStatus::Draft => {
                if !self.revisions.is_empty()
                    || !self.decisions.is_empty()
                    || !self.approvals.is_empty()
                    || self.handover.is_some()
                    || !self.handover_history.is_empty()
                {
                    return Err(WebsiteError::InconsistentStatus("draft"));
                }
            }
            WebsiteStatus::ReadyForReview => {
                let current = self
                    .revisions
                    .last()
                    .ok_or(WebsiteError::InconsistentStatus("readyForReview"))?;
                require_passing_qa(current)?;
            }
            WebsiteStatus::ChangesRequested => {
                let current = self
                    .revisions
                    .last()
                    .ok_or(WebsiteError::InconsistentStatus("changesRequested"))?;
                let last = self
                    .decisions
                    .last()
                    .ok_or(WebsiteError::InconsistentStatus("changesRequested"))?;
                if last.kind != DecisionKind::RequestChanges || last.revision != current.revision {
                    return Err(WebsiteError::InconsistentStatus("changesRequested"));
                }
            }
            WebsiteStatus::Working => {}
            WebsiteStatus::Approved | WebsiteStatus::HandedOver => {
                let current = self
                    .revisions
                    .last()
                    .ok_or(WebsiteError::InconsistentStatus(self.status.as_str()))?;
                require_passing_qa(current)?;
            }
        }

        if self.status == WebsiteStatus::HandedOver {
            let handover = self
                .handover
                .as_ref()
                .ok_or(WebsiteError::InvalidHandover("handover"))?;
            let current = self
                .revisions
                .last()
                .ok_or(WebsiteError::InvalidHandover("handover"))?;
            if handover.approved_revision != current.revision {
                return Err(WebsiteError::InvalidHandover("handover"));
            }
        }

        if self.stage_evidence.len() > MAX_STAGE_EVIDENCE {
            return Err(WebsiteError::TooManyEvidence(
                self.stage_evidence.len(),
                MAX_STAGE_EVIDENCE,
            ));
        }
        for evidence in &self.stage_evidence {
            evidence.validate(self.current_revision)?;
        }

        if self.handover.is_none() && !self.handover_history.is_empty() {
            return Err(WebsiteError::InvalidHandover("history"));
        }
        let mut last_handed_over = 0;
        for handover in self.handover_history.iter().chain(self.handover.iter()) {
            handover.validate(self)?;
            if handover.approved_revision <= last_handed_over {
                return Err(WebsiteError::InvalidHandover("handoverOrder"));
            }
            last_handed_over = handover.approved_revision;
        }
        Ok(())
    }

    /// Validate one stored decision against the record and its own payload.
    fn validate_decision(&self, decision: &WebsiteDecision) -> Result<(), WebsiteError> {
        let derived = decision.derived_id();
        if derived != decision.decision_id {
            return Err(WebsiteError::DecisionIdMismatch(
                derived,
                decision.decision_id,
            ));
        }
        validate_identity("decision.actor", &decision.actor)?;
        validate_sha256(&decision.manifest_sha256)?;
        if decision.job_id != self.job_id {
            return Err(WebsiteError::ScopeMismatch("jobId"));
        }
        if decision.task_id != self.task_id {
            return Err(WebsiteError::ScopeMismatch("taskId"));
        }
        if decision.channel != self.channel {
            return Err(WebsiteError::ScopeMismatch("channel"));
        }
        if let Some(note) = &decision.note {
            let length = note.chars().count();
            if length > MAX_NOTE_LEN {
                return Err(WebsiteError::NoteTooLong(length, MAX_NOTE_LEN));
            }
        }
        let revision = self
            .revisions
            .iter()
            .find(|revision| revision.revision == decision.revision)
            .ok_or(WebsiteError::UnknownRevision(decision.revision))?;
        if decision.manifest_sha256 != revision.preview.sha256 {
            return Err(WebsiteError::ManifestHashMismatch(
                revision.preview.sha256.clone(),
                decision.manifest_sha256.clone(),
            ));
        }
        match decision.kind {
            DecisionKind::Approve => {
                if decision.actor != self.owner {
                    return Err(WebsiteError::NotPinnedOwner(decision.actor.clone()));
                }
            }
            DecisionKind::RequestChanges => {
                let authorized = decision.actor == self.owner
                    || self.coordinator.as_deref() == Some(decision.actor.as_str());
                if !authorized {
                    return Err(WebsiteError::NotAuthorized(decision.actor.clone()));
                }
                let feedback = decision.note.as_deref().unwrap_or("");
                if feedback.trim().is_empty() {
                    return Err(WebsiteError::NoteEmpty);
                }
            }
        }
        Ok(())
    }
}

/// Validate a pubkey-style identity field.
pub(super) fn validate_identity(field: &'static str, value: &str) -> Result<(), WebsiteError> {
    if is_lower_hex64(value) {
        Ok(())
    } else {
        Err(WebsiteError::InvalidIdentity(field, value.to_string()))
    }
}

/// Validate an event id field.
pub(super) fn validate_event_id(field: &'static str, value: &str) -> Result<(), WebsiteError> {
    if is_lower_hex64(value) {
        Ok(())
    } else {
        Err(WebsiteError::InvalidEventId(field, value.to_string()))
    }
}

/// Validate a bounded, non-empty scope string.
fn validate_scope_string(field: &'static str, value: &str) -> Result<(), WebsiteError> {
    if value.is_empty() {
        return Err(WebsiteError::EmptyField(field));
    }
    if value.len() > MAX_SCOPE_LEN {
        return Err(WebsiteError::FieldTooLong(
            field,
            value.len(),
            MAX_SCOPE_LEN,
        ));
    }
    Ok(())
}

/// Validate an artifact ref: public HTTPS URL plus a well-formed SHA-256.
pub(super) fn validate_artifact_ref(artifact: &PreviewArtifactRef) -> Result<(), WebsiteError> {
    validate_public_url(&artifact.url)?;
    validate_sha256(&artifact.sha256)
}

/// Require passed, independent QA that matches its revision and manifest hash.
pub(super) fn require_passing_qa(revision: &WebsiteRevision) -> Result<(), WebsiteError> {
    let qa = revision
        .qa
        .as_ref()
        .ok_or(WebsiteError::QaMissing(revision.revision))?;
    if !qa.passed {
        return Err(WebsiteError::QaNotPassed(revision.revision));
    }
    if qa.reviewer == revision.built_by {
        return Err(WebsiteError::QaNotIndependent(qa.reviewer.clone()));
    }
    if qa.revision != revision.revision {
        return Err(WebsiteError::QaMismatch("revision"));
    }
    if qa.manifest_sha256 != revision.preview.sha256 {
        return Err(WebsiteError::QaMismatch("manifestSha256"));
    }
    Ok(())
}
