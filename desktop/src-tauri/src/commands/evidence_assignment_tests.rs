use super::*;

use buzz_core_pkg::kind::{KIND_TASK, KIND_WEBSITE_HEAD};
use buzz_core_pkg::{
    block::canonical_json,
    company::{CommercialPurpose, CompanyTask, DoerKind, TaskStatus},
    website::{WebsiteReview, WebsiteReviewInit, WebsiteStatus},
};
use nostr::{Event, EventBuilder, Keys, Kind, Tag};

const TASK_ID: &str = "website-task";
const THREAD_ROOT: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const INSTANCE_ID: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const MANIFEST_ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RELAY_URL: &str = "wss://relay.example";

struct AssignmentFixture {
    scope: VerifiedScope,
    relay_keys: Keys,
    owner_keys: Keys,
    task: CompanyTask,
    website: WebsiteReview,
    task_event: Event,
    website_event: Event,
    managed_event: Event,
}

fn tag(name: &str, value: &str) -> Tag {
    Tag::parse([name, value]).expect("fixture tag parses")
}

fn task_for(scope: &VerifiedScope, status: TaskStatus) -> CompanyTask {
    CompanyTask {
        schema: "colony.task/v1".to_owned(),
        id: scope.task_id.clone(),
        initiative_id: None,
        title: "Build the website".to_owned(),
        status,
        owning_team_id: "company-team:website".to_owned(),
        assignee_persona_ids: vec!["website-builder".to_owned()],
        qa_persona_id: "website-reviewer".to_owned(),
        reviewer_team_id: None,
        cost_centre_id: "cc-web".to_owned(),
        commercial_purpose: CommercialPurpose::ClientDelivery,
        client_organization_id: None,
        source_channel_id: scope.channel_id.to_string(),
        source_event_id: None,
        implicit: false,
        depends_on: Vec::new(),
        subject: None,
        stage: None,
        thread_root: Some(scope.thread_root.clone()),
        doer_kind: DoerKind::Agent,
        wake_at: None,
        outcome_reason: None,
        bounce_reason: None,
        bounce_count: 0,
        reported_complete_by: Vec::new(),
        hidden: false,
        parent_task_id: None,
        created_at: 1_785_400_000,
        updated_at: 1_785_400_001,
    }
}

/// Materialize the exact relay task-head shape from the canonical task type.
/// The relay owns this builder; the desktop test uses its public wire contract
/// and canonical serializer rather than inventing a reduced JSON fixture.
fn signed_task_event(task: &CompanyTask, signer: &Keys) -> Event {
    let status = buzz_core_pkg::company::serde_enum_slug(&task.status)
        .expect("task status has a wire spelling");
    let content =
        canonical_json(&serde_json::to_value(task).expect("task serializes to a JSON value"))
            .expect("task content canonicalizes");
    EventBuilder::new(Kind::Custom(KIND_TASK as u16), content)
        .tags([
            tag("d", &task.id),
            tag("team", &task.owning_team_id),
            tag("cost-centre", &task.cost_centre_id),
            tag("w", &status),
            tag("g", &task.owning_team_id),
        ])
        .sign_with_keys(signer)
        .expect("task head signs")
}

fn website_for(scope: &VerifiedScope) -> WebsiteReview {
    let mut website = WebsiteReview::new(WebsiteReviewInit {
        job_id: scope.job_id,
        task_id: scope.task_id.clone(),
        channel: scope.channel_id.to_string(),
        thread_root: scope.thread_root.clone(),
        owner: scope.owner_pubkey.to_hex(),
        coordinator: Some(scope.relay_pubkey.to_hex()),
        source_url: "https://source.example/website".to_owned(),
    })
    .expect("website review identity validates");
    website.begin_work().expect("website review begins work");
    website
}

/// Materialize the exact relay Website-head shape from the canonical review
/// record. Website heads are relay-authored, so the SDK intentionally exposes
/// parsers rather than an owner-side head builder.
fn signed_website_event(scope: &VerifiedScope, website: &WebsiteReview, signer: &Keys) -> Event {
    let content = canonical_json(
        &serde_json::to_value(website).expect("website review serializes to a JSON value"),
    )
    .expect("website content canonicalizes");
    let job_id = scope.job_id.to_string();
    let channel_id = scope.channel_id.to_string();
    EventBuilder::new(Kind::Custom(KIND_WEBSITE_HEAD as u16), content)
        .tags([
            tag("d", &job_id),
            tag("h", &channel_id),
            tag("task", &scope.task_id),
            tag("thread", &scope.thread_root),
            tag("instance", INSTANCE_ID),
            tag("manifest", MANIFEST_ID),
            tag("generation", "1"),
            tag("p", &scope.owner_pubkey.to_hex()),
            tag("p", &scope.relay_pubkey.to_hex()),
        ])
        .sign_with_keys(signer)
        .expect("website head signs")
}

fn signed_managed_agent_event(scope: &VerifiedScope, owner: &Keys, persona_id: &str) -> Event {
    let record = crate::managed_agents::ManagedAgentRecord {
        pubkey: scope.worker_pubkey.to_hex(),
        name: "Website Builder".to_owned(),
        persona_id: Some(persona_id.to_owned()),
        ..Default::default()
    };
    crate::managed_agents::agent_events::build_agent_event(&record)
        .expect("managed-agent head uses the production serializer")
        .sign_with_keys(owner)
        .expect("managed-agent head signs")
}

fn fixture() -> AssignmentFixture {
    let relay_keys = Keys::generate();
    let owner_keys = Keys::generate();
    let worker_keys = Keys::generate();
    let scope = VerifiedScope {
        relay_url: RELAY_URL.to_owned(),
        owner_pubkey: owner_keys.public_key(),
        relay_pubkey: relay_keys.public_key(),
        job_id: uuid::Uuid::from_u128(0x1111_2222_3333_4444_5555_6666_7777_8888),
        task_id: TASK_ID.to_owned(),
        channel_id: uuid::Uuid::from_u128(0x9999_aaaa_bbbb_cccc_dddd_eeee_ffff_0000),
        thread_root: THREAD_ROOT.to_owned(),
        worker_pubkey: worker_keys.public_key(),
    };
    let task = task_for(&scope, TaskStatus::InProgress);
    let website = website_for(&scope);
    let task_event = signed_task_event(&task, &relay_keys);
    let website_event = signed_website_event(&scope, &website, &relay_keys);
    let managed_event = signed_managed_agent_event(&scope, &owner_keys, "website-builder");
    AssignmentFixture {
        scope,
        relay_keys,
        owner_keys,
        task,
        website,
        task_event,
        website_event,
        managed_event,
    }
}

fn events(fixture: &AssignmentFixture) -> Vec<Event> {
    vec![
        fixture.task_event.clone(),
        fixture.website_event.clone(),
        fixture.managed_event.clone(),
    ]
}

#[test]
fn event_ids_are_strictly_lowercase() {
    assert!(lower_hex_event_id(&"a".repeat(64), "root").is_ok());
    assert!(lower_hex_event_id(&"A".repeat(64), "root").is_err());
    assert!(lower_hex_event_id(&"a".repeat(63), "root").is_err());
}

#[test]
fn task_identifiers_cannot_be_used_as_paths_or_unbounded_input() {
    assert!(valid_identifier("thread-task:abc", "task").is_ok());
    assert!(valid_identifier("../outside", "task").is_err());
    assert!(valid_identifier(&"x".repeat(MAX_IDENTIFIER_BYTES + 1), "task").is_err());
    assert!(valid_identifier("task\nother", "task").is_err());
}

#[test]
fn evidence_requires_an_accepted_live_task_and_website_phase() {
    for status in [
        TaskStatus::Ready,
        TaskStatus::InProgress,
        TaskStatus::InReview,
    ] {
        assert!(task_allows_evidence(status));
    }
    for status in [
        TaskStatus::Proposed,
        TaskStatus::Blocked,
        TaskStatus::Snoozed,
        TaskStatus::Completed,
        TaskStatus::Cancelled,
    ] {
        assert!(!task_allows_evidence(status));
    }
    for status in [
        WebsiteStatus::Working,
        WebsiteStatus::ReadyForReview,
        WebsiteStatus::Approved,
        WebsiteStatus::ChangesRequested,
    ] {
        assert!(website_allows_evidence(status));
    }
    for status in [WebsiteStatus::Draft, WebsiteStatus::HandedOver] {
        assert!(!website_allows_evidence(status));
    }
}

#[test]
fn assignment_events_require_the_expected_kind_author_and_signature() {
    let fixture = fixture();
    let other_keys = Keys::generate();
    let valid = fixture.task_event.clone();
    assert!(verify_event(
        &valid,
        KIND_TASK,
        &fixture.scope.relay_pubkey,
        "CompanyTask"
    )
    .is_ok());
    assert!(verify_event(&valid, KIND_TASK, &other_keys.public_key(), "CompanyTask").is_err());
    assert!(verify_event(
        &valid,
        KIND_WEBSITE_HEAD,
        &fixture.scope.relay_pubkey,
        "Website head"
    )
    .is_err());
    let mut tampered = valid.clone();
    tampered.content = "changed after signing".to_owned();
    assert!(verify_event(
        &tampered,
        KIND_TASK,
        &fixture.scope.relay_pubkey,
        "CompanyTask"
    )
    .is_err());
}

#[test]
fn signed_assignment_snapshot_is_accepted_for_the_assigned_worker() {
    let fixture = fixture();
    let snapshot = validate_assignment_snapshot(&events(&fixture), &fixture.scope)
        .expect("the signed task, Website head, and managed-agent head join");
    assert_eq!(snapshot.worker_persona_id, "website-builder");
    assert_eq!(snapshot.task_id, TASK_ID);
    assert_eq!(snapshot.website_generation, 1);
    assert_eq!(snapshot.task_event_id, fixture.task_event.id.to_hex());
    assert_eq!(snapshot.website_event_id, fixture.website_event.id.to_hex());
}

#[test]
fn signed_assignment_snapshot_rejects_persona_scope_status_and_author_mismatches() {
    let fixture = fixture();

    let wrong_persona = {
        let mut candidate = events(&fixture);
        candidate[2] =
            signed_managed_agent_event(&fixture.scope, &fixture.owner_keys, "other-persona");
        candidate
    };
    assert_rejected(
        validate_assignment_snapshot(&wrong_persona, &fixture.scope),
        "not assigned",
    );

    let wrong_job = {
        let mut website = fixture.website.clone();
        website.job_id = uuid::Uuid::from_u128(0x2222_3333_4444_5555_6666_7777_8888_9999);
        let mut candidate = events(&fixture);
        candidate[1] = signed_website_event(&fixture.scope, &website, &fixture.relay_keys);
        candidate
    };
    assert_rejected(
        validate_assignment_snapshot(&wrong_job, &fixture.scope),
        "Website head scope",
    );

    let wrong_thread = {
        let mut task = fixture.task.clone();
        task.thread_root =
            Some("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".to_owned());
        let mut candidate = events(&fixture);
        candidate[0] = signed_task_event(&task, &fixture.relay_keys);
        candidate
    };
    assert_rejected(
        validate_assignment_snapshot(&wrong_thread, &fixture.scope),
        "CompanyTask scope",
    );

    let closed_task = {
        let task = task_for(&fixture.scope, TaskStatus::Completed);
        let mut candidate = events(&fixture);
        candidate[0] = signed_task_event(&task, &fixture.relay_keys);
        candidate
    };
    assert_rejected(
        validate_assignment_snapshot(&closed_task, &fixture.scope),
        "CompanyTask is not active",
    );

    let wrong_author = {
        let other_keys = Keys::generate();
        let mut candidate = events(&fixture);
        candidate[0] = signed_task_event(&fixture.task, &other_keys);
        candidate
    };
    assert_rejected(
        validate_assignment_snapshot(&wrong_author, &fixture.scope),
        "CompanyTask head was not found",
    );
}

fn assert_rejected(result: Result<EvidenceAssignmentSnapshot, String>, expected: &str) {
    let error = result.expect_err("the malformed assignment must be rejected");
    assert!(
        error.contains(expected),
        "expected `{expected}` in rejection, got `{error}`"
    );
}
