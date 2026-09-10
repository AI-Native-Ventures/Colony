//! Shared review-record vectors.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::website::{
    sha256_hex, validate_handover_assets, DecisionKind, DecisionOutcome, DecisionSubmission,
    HandoverAsset, PreviewArtifactRef, QaEvidence, RevisionSubmission, Stage, StageEvidence,
    StageEvidenceKind, WebsiteCaptures, WebsiteError, WebsiteHandover, WebsiteReview,
    WebsiteReviewInit, PREVIEW_SCHEMA,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewVectors {
    schema: String,
    cases: Vec<ReviewCase>,
}

#[derive(Deserialize)]
struct ReviewCase {
    name: String,
    steps: Vec<Step>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Scope {
    #[serde(default)]
    job_id: Option<String>,
    #[serde(default)]
    task_id: Option<String>,
    #[serde(default)]
    channel: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Step {
    op: String,
    #[serde(default)]
    expect: Option<String>,
    #[serde(default)]
    revision: Option<u32>,
    #[serde(default)]
    manifest: Option<Value>,
    #[serde(default)]
    manifest_hash: Option<String>,
    #[serde(default)]
    built_by: Option<String>,
    #[serde(default)]
    reviewer: Option<String>,
    #[serde(default)]
    passed: Option<bool>,
    #[serde(default)]
    qa_hash: Option<String>,
    #[serde(default)]
    qa_revision: Option<u32>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    actor: Option<String>,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    scope: Option<Scope>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    count: Option<usize>,
    #[serde(default)]
    active_approval: Option<bool>,
    #[serde(default)]
    accepted_by: Option<String>,
    #[serde(default)]
    handover_hash: Option<String>,
    #[serde(default)]
    handover_assets: Option<bool>,
    #[serde(default)]
    handover_source_url: Option<String>,
    #[serde(default)]
    handover_archive_hash: Option<String>,
    #[serde(default)]
    handover_asset_path: Option<String>,
    #[serde(default)]
    handover_revision: Option<u32>,
    #[serde(default)]
    handover: Option<bool>,
    #[serde(default)]
    stage: Option<String>,
    #[serde(default)]
    source: Option<String>,
}

/// Outcome of a single vector step.
enum StepOutcome {
    Unit,
    Decision {
        outcome: DecisionOutcome,
        derived: Uuid,
    },
}

/// Mutable state for one vector case.
struct Harness {
    review: WebsiteReview,
    manifests: BTreeMap<u32, String>,
}

impl Harness {
    fn new() -> Self {
        Harness {
            review: WebsiteReview::new(init()).expect("draft review is valid"),
            manifests: BTreeMap::new(),
        }
    }
}

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

fn identity(token: &str) -> String {
    match token {
        "owner" => OWNER.to_string(),
        "builder" => BUILDER.to_string(),
        "coordinator" => COORDINATOR.to_string(),
        "stranger" => STRANGER.to_string(),
        other => other.to_string(),
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

fn other_manifest() -> Value {
    json!({
        "schema": PREVIEW_SCHEMA,
        "entrypoint": "index.html",
        "files": [{
            "path": "index.html",
            "url": "https://cdn.colony.test/sites/other/index.html",
            "sha256": "1".repeat(64),
            "mime": "text/html",
            "size": 99,
        }],
    })
}

fn current_sha(harness: &Harness) -> String {
    harness
        .review
        .current()
        .map(|revision| revision.preview.sha256.clone())
        .unwrap_or_else(|| "0".repeat(64))
}

fn resolve_sha(token: Option<&str>, current: &str) -> String {
    match token {
        None | Some("current") => current.to_string(),
        Some("wrong") => "1".repeat(64),
        Some(literal) => literal.to_string(),
    }
}

fn record_revision(harness: &mut Harness, step: &Step) -> Result<(), WebsiteError> {
    let revision = step
        .revision
        .unwrap_or_else(|| harness.review.current_revision.saturating_add(1));
    let manifest_value = step.manifest.clone().unwrap_or_else(default_manifest);
    let manifest = serde_json::to_string(&manifest_value).expect("manifest serializes");
    let sha = resolve_sha(
        step.manifest_hash.as_deref(),
        &sha256_hex(manifest.as_bytes()),
    );
    let result = harness.review.record_revision(RevisionSubmission {
        revision,
        manifest: manifest.clone(),
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
        built_by: identity(step.built_by.as_deref().unwrap_or("builder")),
    });
    if result.is_ok() {
        harness.manifests.insert(revision, manifest);
    }
    result
}

fn record_qa(harness: &mut Harness, step: &Step) -> Result<(), WebsiteError> {
    let revision = step.revision.unwrap_or(harness.review.current_revision);
    let sha = resolve_sha(step.qa_hash.as_deref(), &current_sha(harness));
    harness.review.record_qa(
        revision,
        QaEvidence {
            reviewer: identity(step.reviewer.as_deref().unwrap_or("stranger")),
            revision: step.qa_revision.unwrap_or(revision),
            manifest_sha256: sha,
            passed: step.passed.unwrap_or(true),
            report_event_id: EVENT_ID.to_string(),
            report: artifact(
                &format!("https://cdn.colony.test/qa/r{revision}-report.json"),
                &"d".repeat(64),
            ),
        },
    )
}

fn attach_evidence(harness: &mut Harness, step: &Step, label: &str) -> Result<(), WebsiteError> {
    let stage = match step.stage.as_deref() {
        None | Some("designBuild") => Stage::DesignBuild,
        Some("brief") => Stage::Brief,
        Some("research") => Stage::Research,
        Some("review") => Stage::Review,
        Some("revision") => Stage::Revision,
        Some("approval") => Stage::Approval,
        Some("handover") => Stage::Handover,
        other => panic!("{label}: unknown stage {other:?}"),
    };
    harness.review.attach_evidence(StageEvidence {
        stage,
        revision: Some(step.revision.unwrap_or(harness.review.current_revision)),
        kind: StageEvidenceKind::WorkEvent,
        event_id: EVENT_ID.to_string(),
    })
}

fn decide(harness: &mut Harness, step: &Step, label: &str) -> Result<StepOutcome, WebsiteError> {
    let kind = match step.kind.as_deref() {
        Some("approve") => DecisionKind::Approve,
        Some("requestChanges") => DecisionKind::RequestChanges,
        other => panic!("{label}: unknown decision kind {other:?}"),
    };
    let scope = step.scope.clone().unwrap_or_default();
    let note = match (step.note.clone(), kind) {
        (Some(note), _) => Some(note),
        (None, DecisionKind::RequestChanges) => Some("please revise".to_string()),
        (None, DecisionKind::Approve) => None,
    };
    let submission = DecisionSubmission {
        job_id: scope
            .job_id
            .as_deref()
            .and_then(|value| value.parse().ok())
            .unwrap_or(harness.review.job_id),
        task_id: scope
            .task_id
            .unwrap_or_else(|| harness.review.task_id.clone()),
        channel: scope
            .channel
            .unwrap_or_else(|| harness.review.channel.clone()),
        kind,
        revision: step.revision.unwrap_or(harness.review.current_revision),
        manifest_sha256: resolve_sha(step.manifest_hash.as_deref(), &current_sha(harness)),
        actor: identity(step.actor.as_deref().unwrap_or("owner")),
        note,
    };
    let derived = submission.derive_id();
    harness
        .review
        .apply_decision(submission)
        .map(|outcome| StepOutcome::Decision { outcome, derived })
}

fn record_handover(harness: &mut Harness, step: &Step) -> Result<(), WebsiteError> {
    let revision_number = step
        .handover_revision
        .unwrap_or(harness.review.current_revision);
    let current_archive = harness
        .review
        .current()
        .map(|revision| revision.archive.clone())
        .expect("handover requires a recorded revision");
    let archive = match step.handover_archive_hash.as_deref() {
        None => current_archive,
        Some(token) => artifact(
            &current_archive.url,
            &resolve_sha(Some(token), &current_archive.sha256),
        ),
    };
    let source_url = step
        .handover_source_url
        .clone()
        .unwrap_or_else(|| SOURCE_URL.to_string());
    let asset_path = step
        .handover_asset_path
        .clone()
        .unwrap_or_else(|| "index.html".to_string());
    let assets = if step.handover_assets.unwrap_or(true) {
        vec![HandoverAsset {
            path: asset_path,
            artifact: artifact(
                "https://cdn.colony.test/sites/fixture/index.html",
                &"0".repeat(64),
            ),
        }]
    } else {
        Vec::new()
    };
    harness.review.record_handover(WebsiteHandover {
        job_id: harness.review.job_id,
        task_id: harness.review.task_id.clone(),
        approved_revision: revision_number,
        approved_manifest_sha256: resolve_sha(step.handover_hash.as_deref(), &current_sha(harness)),
        source_url,
        source_archive: archive,
        assets,
        access_request: None,
        accepted_by: identity(step.accepted_by.as_deref().unwrap_or("owner")),
    })
}

fn check_assets(harness: &Harness, step: &Step, label: &str) -> Result<(), WebsiteError> {
    let handover = harness
        .review
        .handover
        .as_ref()
        .unwrap_or_else(|| panic!("{label}: no handover recorded"));
    let bytes = if step.source.as_deref() == Some("other") {
        serde_json::to_vec(&other_manifest()).expect("manifest serializes")
    } else {
        harness
            .manifests
            .get(&handover.approved_revision)
            .cloned()
            .unwrap_or_else(|| {
                panic!(
                    "{label}: no recorded manifest for revision {}",
                    handover.approved_revision
                )
            })
            .into_bytes()
    };
    validate_handover_assets(handover, &bytes)
}

fn run_step(harness: &mut Harness, step: &Step, label: &str) -> Result<StepOutcome, WebsiteError> {
    match step.op.as_str() {
        "begin_work" => harness.review.begin_work().map(|()| StepOutcome::Unit),
        "record_revision" => record_revision(harness, step).map(|()| StepOutcome::Unit),
        "record_qa" => record_qa(harness, step).map(|()| StepOutcome::Unit),
        "attach_evidence" => attach_evidence(harness, step, label).map(|()| StepOutcome::Unit),
        "mark_ready" => harness
            .review
            .mark_ready_for_review()
            .map(|()| StepOutcome::Unit),
        "record_handover" => record_handover(harness, step).map(|()| StepOutcome::Unit),
        "check_assets" => check_assets(harness, step, label).map(|()| StepOutcome::Unit),
        "decide" => decide(harness, step, label),
        "expect_status" => {
            assert_eq!(
                harness.review.status.as_str(),
                step.status.as_deref().unwrap_or(""),
                "{label}"
            );
            Ok(StepOutcome::Unit)
        }
        "expect_current_revision" => {
            assert_eq!(
                harness.review.current_revision,
                step.revision.unwrap_or(0),
                "{label}"
            );
            Ok(StepOutcome::Unit)
        }
        "expect_decisions" => {
            assert_eq!(
                harness.review.decisions.len(),
                step.count.unwrap_or(0),
                "{label}"
            );
            Ok(StepOutcome::Unit)
        }
        "expect_active_approval" => {
            assert_eq!(
                harness.review.active_approval_id.is_some(),
                step.active_approval.unwrap_or(false),
                "{label}"
            );
            Ok(StepOutcome::Unit)
        }
        "expect_handover" => {
            assert_eq!(
                harness.review.handover.is_some(),
                step.handover.unwrap_or(false),
                "{label}"
            );
            Ok(StepOutcome::Unit)
        }
        "expect_handover_history" => {
            assert_eq!(
                harness.review.handover_history.len(),
                step.count.unwrap_or(0),
                "{label}"
            );
            Ok(StepOutcome::Unit)
        }
        "parse" => {
            let bytes = serde_json::to_vec(&harness.review).expect("review serializes");
            let parsed = WebsiteReview::parse(&bytes)?;
            assert_eq!(&parsed, &harness.review, "{label}");
            Ok(StepOutcome::Unit)
        }
        other => panic!("{label}: unknown op {other}"),
    }
}

fn check_post(review: &WebsiteReview, step: &Step, label: &str) {
    if let Some(expected) = step.status.as_deref() {
        assert_eq!(review.status.as_str(), expected, "{label} post status");
    }
    if let Some(expected) = step.active_approval {
        assert_eq!(
            review.active_approval_id.is_some(),
            expected,
            "{label} post activeApproval"
        );
    }
    if let Some(expected) = step.count {
        assert_eq!(review.decisions.len(), expected, "{label} post decisions");
    }
}

fn assert_result(label: &str, step: &Step, result: Result<StepOutcome, WebsiteError>) {
    let expected = step.expect.as_deref().unwrap_or("ok");
    match result {
        Err(error) => {
            if matches!(expected, "ok" | "applied" | "duplicate") {
                panic!("{label}: expected {expected}, found {}", error.code());
            }
            assert_eq!(error.code(), expected, "{label}");
        }
        Ok(StepOutcome::Unit) => {
            assert_eq!(expected, "ok", "{label}: expected {expected}, succeeded");
        }
        Ok(StepOutcome::Decision { outcome, derived }) => match expected {
            "applied" => match outcome {
                DecisionOutcome::Applied(decision) => {
                    assert_eq!(decision.decision_id, derived, "{label} derived id")
                }
                DecisionOutcome::Duplicate(_) => {
                    panic!("{label}: expected applied, got duplicate")
                }
            },
            "duplicate" => match outcome {
                DecisionOutcome::Duplicate(decision) => {
                    assert_eq!(decision.decision_id, derived, "{label} derived id")
                }
                DecisionOutcome::Applied(_) => {
                    panic!("{label}: expected duplicate, got applied")
                }
            },
            other => panic!("{label}: expected {other}, got a decision"),
        },
    }
}

#[test]
fn review_record_vectors() {
    let vectors: ReviewVectors = serde_json::from_str(include_str!(
        "../../../testdata/website/review_vectors.json"
    ))
    .expect("review vectors are valid JSON");
    assert_eq!(vectors.schema, "colony.website-review-vectors/1");
    assert!(
        vectors.cases.len() >= 25,
        "expected at least 25 review vectors, found {}",
        vectors.cases.len()
    );
    for case in &vectors.cases {
        let mut harness = Harness::new();
        for (index, step) in case.steps.iter().enumerate() {
            let label = format!("case {} step {} ({})", case.name, index + 1, step.op);
            let result = run_step(&mut harness, step, &label);
            assert_result(&label, step, result);
            check_post(&harness.review, step, &label);
        }
    }
}
