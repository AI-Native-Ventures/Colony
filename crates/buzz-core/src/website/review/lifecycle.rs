//! Lifecycle transitions for the website review record.
//!
//! Every method here is total and fail-closed: a refused transition leaves the
//! record byte-for-byte unchanged, so the caller can retry from a known state.
//! Each mutation is applied to a private candidate clone and only committed to
//! `self` after every rule and the serialized-size budget pass, so a failure
//! part-way through can never leave a half-applied record. `apply_decision` is
//! idempotent for an exact retry and refuses a replay that carries a different
//! payload, including a different note.

use super::super::error::WebsiteError;
use super::super::preview::{parse_preview_manifest, sha256_hex, validate_sha256, MAX_NOTE_LEN};
use super::types::{
    DecisionKind, DecisionOutcome, DecisionSubmission, QaEvidence, RevisionSubmission,
    StageEvidence, WebsiteDecision, WebsiteHandover, WebsiteReview, WebsiteReviewInit,
    WebsiteRevision, WebsiteStatus, MAX_DECISIONS, MAX_REVIEW_BYTES, MAX_REVISIONS,
    MAX_STAGE_EVIDENCE, REVIEW_SCHEMA,
};
use super::validate::{
    require_passing_qa, validate_artifact_ref, validate_event_id, validate_identity,
};

/// Refuse a candidate record whose serialized bytes exceed the record budget.
fn require_record_budget(review: &WebsiteReview) -> Result<(), WebsiteError> {
    let bytes =
        serde_json::to_vec(review).map_err(|error| WebsiteError::ReviewJson(error.to_string()))?;
    if bytes.len() > MAX_REVIEW_BYTES {
        return Err(WebsiteError::ReviewTooLarge(bytes.len(), MAX_REVIEW_BYTES));
    }
    Ok(())
}

impl WebsiteReview {
    /// Build a draft record from its identity fields and validate it.
    pub fn new(init: WebsiteReviewInit) -> Result<Self, WebsiteError> {
        let review = WebsiteReview {
            schema: REVIEW_SCHEMA.to_string(),
            job_id: init.job_id,
            task_id: init.task_id,
            channel: init.channel,
            thread_root: init.thread_root,
            owner: init.owner,
            coordinator: init.coordinator,
            source_url: init.source_url,
            status: WebsiteStatus::Draft,
            current_revision: 0,
            revisions: Vec::new(),
            approvals: Vec::new(),
            active_approval_id: None,
            decisions: Vec::new(),
            stage_evidence: Vec::new(),
            handover_history: Vec::new(),
            handover: None,
        };
        review.validate()?;
        Ok(review)
    }

    /// Parse a review record from JSON bytes and validate it.
    ///
    /// The byte limit applies before JSON decoding, so an oversized record
    /// fails with [`WebsiteError::ReviewTooLarge`] without allocating a parse.
    pub fn parse(bytes: &[u8]) -> Result<Self, WebsiteError> {
        if bytes.len() > MAX_REVIEW_BYTES {
            return Err(WebsiteError::ReviewTooLarge(bytes.len(), MAX_REVIEW_BYTES));
        }
        let review: WebsiteReview = serde_json::from_slice(bytes)
            .map_err(|error| WebsiteError::ReviewJson(error.to_string()))?;
        review.validate()?;
        Ok(review)
    }

    /// The current (last recorded) revision, if any.
    pub fn current(&self) -> Option<&WebsiteRevision> {
        self.revisions.last()
    }

    /// Move a draft record into active work.
    pub fn begin_work(&mut self) -> Result<(), WebsiteError> {
        if self.status != WebsiteStatus::Draft {
            return Err(WebsiteError::InvalidTransition(
                self.status.as_str(),
                "beginWork",
            ));
        }
        let mut candidate = self.clone();
        candidate.status = WebsiteStatus::Working;
        candidate.validate()?;
        require_record_budget(&candidate)?;
        *self = candidate;
        Ok(())
    }

    /// Record a new revision built against the current one.
    ///
    /// The manifest text is validated as a preview manifest and the exact
    /// bytes are hashed; `submission.preview.sha256` must match that hash. A
    /// new revision clears any active approval (the previous approval remains
    /// in `approvals` as history) and moves the status to `working`.
    pub fn record_revision(&mut self, submission: RevisionSubmission) -> Result<(), WebsiteError> {
        match self.status {
            WebsiteStatus::Working | WebsiteStatus::ChangesRequested => {}
            WebsiteStatus::ReadyForReview => {
                return Err(WebsiteError::RevisionWhileUnderReview(
                    self.current_revision,
                ))
            }
            WebsiteStatus::Approved => {
                return Err(WebsiteError::RevisionAfterApproval(self.current_revision))
            }
            WebsiteStatus::HandedOver => {
                return Err(WebsiteError::RevisionAfterHandover(self.current_revision))
            }
            WebsiteStatus::Draft => {
                return Err(WebsiteError::InvalidTransition(
                    self.status.as_str(),
                    "recordRevision",
                ))
            }
        }
        if self.revisions.len() >= MAX_REVISIONS {
            return Err(WebsiteError::TooManyRevisions(
                self.revisions.len(),
                MAX_REVISIONS,
            ));
        }
        let expected = self.current_revision.saturating_add(1);
        if submission.revision != expected {
            return Err(WebsiteError::RevisionNumberMismatch(
                expected,
                submission.revision,
            ));
        }
        parse_preview_manifest(submission.manifest.as_bytes())?;
        let computed = sha256_hex(submission.manifest.as_bytes());
        if computed != submission.preview.sha256 {
            return Err(WebsiteError::ManifestHashMismatch(
                computed,
                submission.preview.sha256.clone(),
            ));
        }
        let revision = WebsiteRevision {
            revision: submission.revision,
            preview: submission.preview,
            source_url: submission.source_url,
            archive: submission.archive,
            captures: submission.captures,
            built_by: submission.built_by,
            qa: None,
        };
        revision.validate()?;

        let mut candidate = self.clone();
        candidate.revisions.push(revision);
        candidate.current_revision = expected;
        candidate.active_approval_id = None;
        candidate.status = WebsiteStatus::Working;
        candidate.validate()?;
        require_record_budget(&candidate)?;
        *self = candidate;
        Ok(())
    }

    /// Record independent QA evidence on the current revision.
    pub fn record_qa(&mut self, revision: u32, qa: QaEvidence) -> Result<(), WebsiteError> {
        if self.status != WebsiteStatus::Working {
            return Err(WebsiteError::InvalidTransition(
                self.status.as_str(),
                "recordQa",
            ));
        }
        if revision != self.current_revision {
            return Err(WebsiteError::StaleRevision(self.current_revision, revision));
        }
        let mut candidate = self.clone();
        let Some(slot) = candidate
            .revisions
            .iter_mut()
            .find(|entry| entry.revision == revision)
        else {
            return Err(WebsiteError::UnknownRevision(revision));
        };
        if slot.qa.is_some() {
            return Err(WebsiteError::QaAlreadyRecorded(revision));
        }
        validate_identity("qa.reviewer", &qa.reviewer)?;
        if qa.reviewer == slot.built_by {
            return Err(WebsiteError::QaNotIndependent(qa.reviewer.clone()));
        }
        if qa.revision != revision {
            return Err(WebsiteError::QaMismatch("revision"));
        }
        validate_sha256(&qa.manifest_sha256)?;
        if qa.manifest_sha256 != slot.preview.sha256 {
            return Err(WebsiteError::QaMismatch("manifestSha256"));
        }
        validate_event_id("qa.reportEventId", &qa.report_event_id)?;
        validate_artifact_ref(&qa.report)?;
        slot.qa = Some(qa);
        candidate.validate()?;
        require_record_budget(&candidate)?;
        *self = candidate;
        Ok(())
    }

    /// Freeze the current revision for an owner decision.
    ///
    /// Requires recorded QA evidence that passed, is independent of the
    /// builder, and matches the current revision and its manifest hash.
    pub fn mark_ready_for_review(&mut self) -> Result<(), WebsiteError> {
        if self.status != WebsiteStatus::Working {
            return Err(WebsiteError::InvalidTransition(
                self.status.as_str(),
                "markReadyForReview",
            ));
        }
        let current = self.revisions.last().ok_or(WebsiteError::QaMissing(0))?;
        require_passing_qa(current)?;
        let mut candidate = self.clone();
        candidate.status = WebsiteStatus::ReadyForReview;
        candidate.validate()?;
        require_record_budget(&candidate)?;
        *self = candidate;
        Ok(())
    }

    /// Apply an owner approval or owner/coordinator change request.
    ///
    /// An exact retry (same scope, revision, kind, actor, manifest hash, and
    /// note) returns [`DecisionOutcome::Duplicate`] with the stored record and
    /// changes nothing, even when the decision is now stale. A replay whose
    /// payload differs fails with [`WebsiteError::DecisionPayloadMismatch`].
    /// A `requestChanges` requires a non-empty note. A change request on an
    /// approved or handed-over revision supersedes the approval and clears the
    /// active approval while preserving all history, including the handover.
    pub fn apply_decision(
        &mut self,
        submission: DecisionSubmission,
    ) -> Result<DecisionOutcome, WebsiteError> {
        if submission.job_id != self.job_id {
            return Err(WebsiteError::ScopeMismatch("jobId"));
        }
        if submission.task_id != self.task_id {
            return Err(WebsiteError::ScopeMismatch("taskId"));
        }
        if submission.channel != self.channel {
            return Err(WebsiteError::ScopeMismatch("channel"));
        }
        if let Some(note) = &submission.note {
            let length = note.chars().count();
            if length > MAX_NOTE_LEN {
                return Err(WebsiteError::NoteTooLong(length, MAX_NOTE_LEN));
            }
        }
        if submission.kind == DecisionKind::RequestChanges {
            let feedback = submission.note.as_deref().unwrap_or("");
            if feedback.trim().is_empty() {
                return Err(WebsiteError::NoteEmpty);
            }
        }
        let decision_id = submission.derive_id();
        if let Some(existing) = self
            .decisions
            .iter()
            .find(|decision| decision.decision_id == decision_id)
        {
            if existing.matches_submission(&submission) {
                return Ok(DecisionOutcome::Duplicate(existing.clone()));
            }
            return Err(WebsiteError::DecisionPayloadMismatch(decision_id));
        }
        validate_identity("decision.actor", &submission.actor)?;
        validate_sha256(&submission.manifest_sha256)?;
        if submission.revision == 0 || submission.revision > self.current_revision {
            return Err(WebsiteError::UnknownRevision(submission.revision));
        }
        if submission.revision != self.current_revision {
            return Err(WebsiteError::StaleRevision(
                self.current_revision,
                submission.revision,
            ));
        }
        let current = self
            .revisions
            .last()
            .ok_or(WebsiteError::UnknownRevision(submission.revision))?
            .clone();
        if submission.manifest_sha256 != current.preview.sha256 {
            return Err(WebsiteError::ManifestHashMismatch(
                current.preview.sha256.clone(),
                submission.manifest_sha256.clone(),
            ));
        }
        if let Some(conflict) = self.decisions.iter().find(|decision| {
            decision.revision == submission.revision
                && (decision.kind == submission.kind
                    || (decision.kind == DecisionKind::RequestChanges
                        && submission.kind == DecisionKind::Approve))
        }) {
            return Err(WebsiteError::ConflictingDecision(conflict.decision_id));
        }
        match submission.kind {
            DecisionKind::Approve => {
                if self.status != WebsiteStatus::ReadyForReview {
                    return Err(WebsiteError::NotReadyForReview(self.status.as_str()));
                }
                if submission.actor != self.owner {
                    return Err(WebsiteError::NotPinnedOwner(submission.actor.clone()));
                }
                require_passing_qa(&current)?;
            }
            DecisionKind::RequestChanges => {
                let authorized = submission.actor == self.owner
                    || self.coordinator.as_deref() == Some(submission.actor.as_str());
                if !authorized {
                    return Err(WebsiteError::NotAuthorized(submission.actor.clone()));
                }
                if !matches!(
                    self.status,
                    WebsiteStatus::ReadyForReview
                        | WebsiteStatus::Approved
                        | WebsiteStatus::HandedOver
                ) {
                    return Err(WebsiteError::InvalidTransition(
                        self.status.as_str(),
                        "requestChanges",
                    ));
                }
            }
        }
        if self.decisions.len() >= MAX_DECISIONS {
            return Err(WebsiteError::TooManyDecisions(
                self.decisions.len(),
                MAX_DECISIONS,
            ));
        }
        let decision = WebsiteDecision {
            decision_id,
            kind: submission.kind,
            job_id: submission.job_id,
            task_id: submission.task_id,
            channel: submission.channel,
            revision: submission.revision,
            manifest_sha256: submission.manifest_sha256,
            actor: submission.actor,
            note: submission.note,
        };

        let mut candidate = self.clone();
        candidate.decisions.push(decision.clone());
        match decision.kind {
            DecisionKind::Approve => {
                candidate.approvals.push(decision.clone());
                candidate.active_approval_id = Some(decision.decision_id);
                candidate.status = WebsiteStatus::Approved;
            }
            DecisionKind::RequestChanges => {
                candidate.active_approval_id = None;
                candidate.status = WebsiteStatus::ChangesRequested;
            }
        }
        candidate.validate()?;
        require_record_budget(&candidate)?;
        *self = candidate;
        Ok(DecisionOutcome::Applied(decision))
    }

    /// Record the handover of the approved revision's source and assets.
    ///
    /// The handover must name the current revision, match its source URL and
    /// archive, carry an approval for that revision, and be accepted by the
    /// pinned owner or the coordinator.
    pub fn record_handover(&mut self, handover: WebsiteHandover) -> Result<(), WebsiteError> {
        if self.status != WebsiteStatus::Approved {
            return Err(WebsiteError::InvalidTransition(
                self.status.as_str(),
                "recordHandover",
            ));
        }
        if handover.approved_revision != self.current_revision {
            return Err(WebsiteError::HandoverMismatch("approvedRevision"));
        }
        handover.validate(self)?;
        let mut candidate = self.clone();
        if let Some(previous) = candidate.handover.take() {
            candidate.handover_history.push(previous);
        }
        candidate.handover = Some(handover);
        candidate.status = WebsiteStatus::HandedOver;
        candidate.validate()?;
        require_record_budget(&candidate)?;
        *self = candidate;
        Ok(())
    }

    /// Attach a reference to signed external stage evidence.
    pub fn attach_evidence(&mut self, evidence: StageEvidence) -> Result<(), WebsiteError> {
        if self.stage_evidence.len() >= MAX_STAGE_EVIDENCE {
            return Err(WebsiteError::TooManyEvidence(
                self.stage_evidence.len(),
                MAX_STAGE_EVIDENCE,
            ));
        }
        evidence.validate(self.current_revision)?;
        let mut candidate = self.clone();
        candidate.stage_evidence.push(evidence);
        candidate.validate()?;
        require_record_budget(&candidate)?;
        *self = candidate;
        Ok(())
    }
}
