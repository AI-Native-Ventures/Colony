//! Adversarial invariant tests for stored review records.
//!
//! The vector runner (`tests/review.rs`) exercises lifecycle transitions.
//! These tests cover what a tampered or hand-built stored record must violate,
//! plus explicit reopen/history behavior and lifecycle budgets the vectors
//! cannot reach. Nothing here touches the network, the filesystem, or a
//! database; the record is a pure value.

use serde_json::{json, Value};
use uuid::Uuid;

use crate::website::{
    sha256_hex, validate_handover_assets, DecisionKind, DecisionOutcome, DecisionSubmission,
    HandoverAsset, PreviewArtifactRef, QaEvidence, RevisionSubmission, Stage, StageEvidence,
    StageEvidenceKind, WebsiteCaptures, WebsiteHandover, WebsiteReview, WebsiteReviewInit,
    MAX_REVIEW_BYTES, MAX_STAGE_EVIDENCE, PREVIEW_SCHEMA,
};

const OWNER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BUILDER: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const COORDINATOR: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const STRANGER: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const THREAD_ROOT: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const EVENT_ID: &str = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

const TASK_ID: &str = "task-website";
const CHANNEL: &str = "website-ops";
const SOURCE_URL: &str = "https://source.colony.test/sites/acme";

fn job_id() -> Uuid {
    Uuid::from_u128(0x1111_2222_3333_4444_5555_6666_7777_8888)
}

fn init() -> WebsiteReviewInit {
    WebsiteReviewInit {
        job_id: job_id(),
        task_id: TASK_ID.to_string(),
        channel: CHANNEL.to_string(),
        thread_root: THREAD_ROOT.to_string(),
        owner: OWNER.to_string(),
        coordinator: Some(COORDINATOR.to_string()),
        source_url: SOURCE_URL.to_string(),
    }
}

fn artifact(url: &str, sha256: &str) -> PreviewArtifactRef {
    PreviewArtifactRef {
        url: url.to_string(),
        sha256: sha256.to_string(),
    }
}

fn captures(revision: u32) -> WebsiteCaptures {
    WebsiteCaptures {
        before: artifact(
            &format!("https://cdn.colony.test/captures/r{revision}-before.png"),
            &"a".repeat(64),
        ),
        desktop: artifact(
            &format!("https://cdn.colony.test/captures/r{revision}-desktop.png"),
            &"b".repeat(64),
        ),
        mobile: artifact(
            &format!("https://cdn.colony.test/captures/r{revision}-mobile.png"),
            &"c".repeat(64),
        ),
    }
}

fn default_manifest() -> Value {
    json!({
        "schema": PREVIEW_SCHEMA,
        "entrypoint": "index.html",
        "files": [{
            "path": "index.html",
            "url": "https://cdn.colony.test/sites/fixture/index.html",
            "sha256": "0".repeat(64),
            "mime": "text/html",
            "size": 1234,
        }],
    })
}

fn manifest_bytes() -> Vec<u8> {
    serde_json::to_vec(&default_manifest()).expect("manifest serializes")
}

fn current_sha(review: &WebsiteReview) -> String {
    review
        .current()
        .map(|revision| revision.preview.sha256.clone())
        .unwrap_or_else(|| "0".repeat(64))
}

fn record_revision(review: &mut WebsiteReview, revision: u32) {
    let manifest = String::from_utf8(manifest_bytes()).expect("manifest is utf-8");
    let sha = sha256_hex(manifest.as_bytes());
    review
        .record_revision(RevisionSubmission {
            revision,
            manifest,
            preview: artifact(
                &format!("https://cdn.colony.test/previews/fixture-r{revision}.json"),
                &sha,
            ),
            source_url: SOURCE_URL.to_string(),
            archive: artifact(
                &format!("https://cdn.colony.test/archives/fixture-r{revision}.tar.gz"),
                &"f".repeat(64),
            ),
            captures: captures(revision),
            built_by: BUILDER.to_string(),
        })
        .expect("revision records");
}

fn record_qa(review: &mut WebsiteReview, revision: u32) {
    let sha = current_sha(review);
    review
        .record_qa(
            revision,
            QaEvidence {
                reviewer: STRANGER.to_string(),
                revision,
                manifest_sha256: sha,
                passed: true,
                report_event_id: EVENT_ID.to_string(),
                report: artifact(
                    &format!("https://cdn.colony.test/qa/r{revision}-report.json"),
                    &"d".repeat(64),
                ),
            },
        )
        .expect("qa records");
}

fn decision(
    review: &WebsiteReview,
    kind: DecisionKind,
    actor: &str,
    note: Option<&str>,
) -> DecisionSubmission {
    DecisionSubmission {
        job_id: review.job_id,
        task_id: review.task_id.clone(),
        channel: review.channel.clone(),
        kind,
        revision: review.current_revision,
        manifest_sha256: current_sha(review),
        actor: actor.to_string(),
        note: note.map(str::to_string),
    }
}

fn approve(review: &mut WebsiteReview) -> Uuid {
    let submission = decision(review, DecisionKind::Approve, OWNER, None);
    let id = submission.derive_id();
    let outcome = review.apply_decision(submission).expect("approve applies");
    assert!(matches!(outcome, DecisionOutcome::Applied(_)));
    id
}

fn attach_builder_evidence(review: &mut WebsiteReview, revision: u32) {
    review
        .attach_evidence(StageEvidence {
            stage: Stage::DesignBuild,
            revision: Some(revision),
            kind: StageEvidenceKind::WorkEvent,
            event_id: EVENT_ID.to_string(),
        })
        .expect("evidence attaches");
}

fn handover_for(review: &WebsiteReview) -> WebsiteHandover {
    let current = review.current().expect("revision recorded");
    WebsiteHandover {
        job_id: review.job_id,
        task_id: review.task_id.clone(),
        approved_revision: current.revision,
        approved_manifest_sha256: current.preview.sha256.clone(),
        source_url: current.source_url.clone(),
        source_archive: current.archive.clone(),
        assets: vec![HandoverAsset {
            path: "index.html".to_string(),
            artifact: artifact(
                "https://cdn.colony.test/sites/fixture/index.html",
                &"0".repeat(64),
            ),
        }],
        access_request: None,
        accepted_by: OWNER.to_string(),
    }
}

fn approved_review() -> WebsiteReview {
    let mut review = WebsiteReview::new(init()).expect("draft is valid");
    review.begin_work().expect("begin work");
    record_revision(&mut review, 1);
    record_qa(&mut review, 1);
    review.mark_ready_for_review().expect("ready for review");
    approve(&mut review);
    review
}

fn handed_over_review() -> WebsiteReview {
    let mut review = approved_review();
    attach_builder_evidence(&mut review, 1);
    review
        .record_handover(handover_for(&review))
        .expect("handover records");
    review
}

fn to_value(review: &WebsiteReview) -> Value {
    serde_json::to_value(review).expect("review serializes")
}

fn assert_code(value: &Value, code: &str) {
    let bytes = serde_json::to_vec(value).expect("tampered value serializes");
    let error = WebsiteReview::parse(&bytes).expect_err("tampered record must fail");
    assert_eq!(error.code(), code);
}

#[test]
fn parse_rejects_oversized_review() {
    let review = approved_review();
    let mut bytes = serde_json::to_vec(&review).expect("review serializes");
    assert!(bytes.len() < MAX_REVIEW_BYTES);
    let padding = MAX_REVIEW_BYTES + 1 - bytes.len();
    bytes.extend(std::iter::repeat(b' ').take(padding));
    let error = WebsiteReview::parse(&bytes).expect_err("oversized record is refused");
    assert_eq!(error.code(), "review_too_large");
}

#[test]
fn parse_rejects_missing_archive() {
    let mut value = to_value(&approved_review());
    value["revisions"][0]
        .as_object_mut()
        .expect("revision object")
        .remove("archive");
    assert_code(&value, "review_json");
}

#[test]
fn parse_rejects_missing_handover_source_archive() {
    let mut value = to_value(&handed_over_review());
    value["handover"]
        .as_object_mut()
        .expect("handover object")
        .remove("sourceArchive");
    assert_code(&value, "review_json");
}

#[test]
fn parse_rejects_tampered_decision_id() {
    let mut value = to_value(&approved_review());
    value["decisions"][0]["decisionId"] = json!(Uuid::from_u128(7).to_string());
    assert_code(&value, "decision_id_mismatch");
}

#[test]
fn parse_rejects_tampered_decision_scope() {
    let mut value = to_value(&approved_review());
    value["decisions"][0]["taskId"] = json!("other-task");
    assert_code(&value, "scope_mismatch");
}

#[test]
fn parse_rejects_duplicate_decision_ids() {
    let mut value = to_value(&approved_review());
    let duplicate = value["decisions"][0].clone();
    value["decisions"]
        .as_array_mut()
        .expect("decisions array")
        .push(duplicate);
    assert_code(&value, "duplicate_decision");
}

#[test]
fn parse_rejects_tampered_approval() {
    let mut value = to_value(&approved_review());
    value["approvals"][0]["note"] = json!("tampered");
    assert_code(&value, "approval_mismatch");
}

#[test]
fn parse_rejects_approval_without_qa() {
    let mut value = to_value(&approved_review());
    value["revisions"][0]
        .as_object_mut()
        .expect("revision object")
        .remove("qa");
    assert_code(&value, "qa_missing");
}

#[test]
fn parse_rejects_non_independent_qa() {
    let mut value = to_value(&approved_review());
    value["revisions"][0]["qa"]["reviewer"] = json!(BUILDER);
    assert_code(&value, "qa_not_independent");
}

#[test]
fn parse_rejects_failed_qa_on_approved_record() {
    let mut value = to_value(&approved_review());
    value["revisions"][0]["qa"]["passed"] = json!(false);
    assert_code(&value, "qa_not_passed");
}

#[test]
fn parse_rejects_approved_without_active_approval() {
    let mut value = to_value(&approved_review());
    value
        .as_object_mut()
        .expect("review object")
        .remove("activeApprovalId");
    assert_code(&value, "missing_active_approval");
}

#[test]
fn parse_rejects_unexpected_active_approval() {
    let mut value = to_value(&approved_review());
    value["status"] = json!("readyForReview");
    assert_code(&value, "unexpected_active_approval");
}

#[test]
fn parse_rejects_tampered_draft_status() {
    let mut value = to_value(&approved_review());
    value["status"] = json!("draft");
    value
        .as_object_mut()
        .expect("review object")
        .remove("activeApprovalId");
    assert_code(&value, "inconsistent_status");
}

#[test]
fn parse_rejects_tampered_changes_requested_status() {
    let mut value = to_value(&approved_review());
    value["status"] = json!("changesRequested");
    value
        .as_object_mut()
        .expect("review object")
        .remove("activeApprovalId");
    assert_code(&value, "inconsistent_status");
}

#[test]
fn parse_rejects_tampered_handover_source() {
    let mut value = to_value(&handed_over_review());
    value["handover"]["sourceUrl"] = json!("https://other.colony.test/site");
    assert_code(&value, "handover_mismatch");
}

#[test]
fn parse_rejects_handover_by_stranger() {
    let mut value = to_value(&handed_over_review());
    value["handover"]["acceptedBy"] = json!(STRANGER);
    assert_code(&value, "not_authorized");
}

#[test]
fn parse_rejects_detached_handover_history() {
    let mut value = to_value(&handed_over_review());
    let handover = value["handover"].clone();
    value["handoverHistory"] = json!([handover]);
    value["status"] = json!("working");
    let object = value.as_object_mut().expect("review object");
    object.remove("handover");
    object.remove("activeApprovalId");
    assert_code(&value, "invalid_handover");
}

#[test]
fn parse_rejects_duplicate_handover_revision() {
    let mut value = to_value(&handed_over_review());
    let handover = value["handover"].clone();
    value["handoverHistory"] = json!([handover]);
    assert_code(&value, "invalid_handover");
}

#[test]
fn reject_changed_note_retry() {
    let mut review = approved_review();
    let unchanged = serde_json::to_vec(&review).expect("review serializes");
    let error = review
        .apply_decision(decision(
            &review,
            DecisionKind::Approve,
            OWNER,
            Some("different note"),
        ))
        .expect_err("changed payload is refused");
    assert_eq!(error.code(), "decision_payload_mismatch");
    assert_eq!(
        serde_json::to_vec(&review).expect("review serializes"),
        unchanged
    );
    assert!(matches!(
        review
            .apply_decision(decision(&review, DecisionKind::Approve, OWNER, None))
            .expect("exact retry"),
        DecisionOutcome::Duplicate(_)
    ));
}

#[test]
fn reject_whitespace_request_changes_note() {
    let mut review = approved_review();
    let error = review
        .apply_decision(decision(
            &review,
            DecisionKind::RequestChanges,
            COORDINATOR,
            Some("   "),
        ))
        .expect_err("whitespace note is refused");
    assert_eq!(error.code(), "note_empty");
}

#[test]
fn stale_exact_retry_is_duplicate_without_mutation() {
    let mut review = WebsiteReview::new(init()).expect("draft is valid");
    review.begin_work().expect("begin work");
    record_revision(&mut review, 1);
    record_qa(&mut review, 1);
    review.mark_ready_for_review().expect("ready for review");
    let submission = decision(
        &review,
        DecisionKind::RequestChanges,
        COORDINATOR,
        Some("revise"),
    );
    let outcome = review
        .apply_decision(submission.clone())
        .expect("change request applies");
    assert!(matches!(outcome, DecisionOutcome::Applied(_)));
    record_revision(&mut review, 2);
    let before = serde_json::to_vec(&review).expect("review serializes");
    let outcome = review.apply_decision(submission).expect("stale retry");
    assert!(matches!(outcome, DecisionOutcome::Duplicate(_)));
    assert_eq!(
        serde_json::to_vec(&review).expect("review serializes"),
        before
    );
}

#[test]
fn reopen_preserves_handover_history() {
    let mut review = handed_over_review();
    assert!(review.handover_history.is_empty());
    let first_approval = review.approvals[0].decision_id;

    let outcome = review
        .apply_decision(decision(
            &review,
            DecisionKind::RequestChanges,
            COORDINATOR,
            Some("reopen"),
        ))
        .expect("requestChanges is allowed after handover");
    assert!(matches!(outcome, DecisionOutcome::Applied(_)));
    assert_eq!(review.status.as_str(), "changesRequested");
    assert!(review.handover.is_some());
    assert!(review.active_approval_id.is_none());
    assert_eq!(review.approvals[0].decision_id, first_approval);

    record_revision(&mut review, 2);
    record_qa(&mut review, 2);
    review.mark_ready_for_review().expect("ready for review");
    approve(&mut review);
    attach_builder_evidence(&mut review, 2);
    review
        .record_handover(handover_for(&review))
        .expect("second handover records");

    assert_eq!(review.handover_history.len(), 1);
    assert_eq!(review.handover_history[0].approved_revision, 1);
    assert_eq!(
        review.handover.as_ref().map(|handover| handover.approved_revision),
        Some(2)
    );

    let bytes = serde_json::to_vec(&review).expect("review serializes");
    let parsed = WebsiteReview::parse(&bytes).expect("reopened record parses");
    assert_eq!(parsed, review);
}

#[test]
fn revision_budget_enforced() {
    let mut review = WebsiteReview::new(init()).expect("draft is valid");
    review.begin_work().expect("begin work");
    for revision in 1..=64 {
        record_revision(&mut review, revision);
    }
    let manifest = String::from_utf8(manifest_bytes()).expect("manifest is utf-8");
    let error = review
        .record_revision(RevisionSubmission {
            revision: 65,
            preview: artifact(
                "https://cdn.colony.test/previews/fixture-r65.json",
                &sha256_hex(manifest.as_bytes()),
            ),
            manifest,
            source_url: SOURCE_URL.to_string(),
            archive: artifact(
                "https://cdn.colony.test/archives/fixture-r65.tar.gz",
                &"f".repeat(64),
            ),
            captures: captures(65),
            built_by: BUILDER.to_string(),
        })
        .expect_err("65th revision is refused");
    assert_eq!(error.code(), "too_many_revisions");
}

#[test]
fn evidence_budget_enforced() {
    let mut review = WebsiteReview::new(init()).expect("draft is valid");
    review.begin_work().expect("begin work");
    record_revision(&mut review, 1);
    for _ in 0..MAX_STAGE_EVIDENCE {
        review
            .attach_evidence(StageEvidence {
                stage: Stage::Review,
                revision: Some(1),
                kind: StageEvidenceKind::WorkEvent,
                event_id: EVENT_ID.to_string(),
            })
            .expect("evidence attaches");
    }
    let error = review
        .attach_evidence(StageEvidence {
            stage: Stage::Review,
            revision: Some(1),
            kind: StageEvidenceKind::WorkEvent,
            event_id: EVENT_ID.to_string(),
        })
        .expect_err("257th evidence record is refused");
    assert_eq!(error.code(), "too_many_evidence");
}

#[test]
fn handover_assets_helper_accepts_manifest_member() {
    let review = handed_over_review();
    let handover = review.handover.as_ref().expect("handover recorded");
    assert!(validate_handover_assets(handover, &manifest_bytes()).is_ok());
}

#[test]
fn handover_assets_helper_rejects_hash_mismatch() {
    let review = handed_over_review();
    let handover = review.handover.as_ref().expect("handover recorded");
    let error = validate_handover_assets(handover, b"{\"schema\":\"other\"}")
        .expect_err("different bytes are refused");
    assert_eq!(error.code(), "manifest_hash_mismatch");
}

#[test]
fn handover_assets_helper_rejects_non_member() {
    let mut review = approved_review();
    attach_builder_evidence(&mut review, 1);
    let mut handover = handover_for(&review);
    handover.assets[0].path = "main.html".to_string();
    review.record_handover(handover).expect("handover records");
    let handover = review.handover.as_ref().expect("handover recorded");
    let error = validate_handover_assets(handover, &manifest_bytes())
        .expect_err("asset outside the manifest is refused");
    assert_eq!(error.code(), "asset_not_in_manifest");
}

#[test]
fn decision_id_encoding_is_delimiter_safe() {
    let base = DecisionSubmission {
        job_id: job_id(),
        task_id: "ab".to_string(),
        channel: "c".to_string(),
        kind: DecisionKind::Approve,
        revision: 1,
        manifest_sha256: "0".repeat(64),
        actor: OWNER.to_string(),
        note: None,
    };
    let split = DecisionSubmission {
        task_id: "a".to_string(),
        channel: "bc".to_string(),
        ..base.clone()
    };
    assert_ne!(base.derive_id(), split.derive_id());
}
