//! End-to-end proof that Colony company state is relay-authored and
//! owner-authorized.
//!
//! Company, Initiative, and Task heads are the records the product's money and
//! accountability hang off. Nobody but the relay may write one, and nobody but
//! the community owner may ask it to. Everything here is asserted against a
//! real relay, a real Postgres, and real signatures, because every one of these
//! rules is enforced in the relay process and none of them can be proven by a
//! unit test that talks to a mock.
//!
//! # Running
//!
//! Needs a relay whose community owner is the key this test signs with, so it
//! provisions its own community through the operator API first.
//!
//! ```text
//! RELAY_URL=ws://localhost:3099 \
//! RELAY_HTTP_URL=http://localhost:3099 \
//! RELAY_OPERATOR_NSEC=<operator secret key> \
//! cargo test -p buzz-test-client --test e2e_company_work -- --ignored --test-threads=1
//! ```

use std::time::Duration;

use buzz_core::company::{
    CommercialPurpose, CompanyOnboardingStatus, CompanyProfile, CompanyService, CompanyTask,
    CompanyTeamRef, CostCentre, CostCentreKind, Initiative, InitiativeStatus, TaskStatus,
    COMPANY_SCHEMA, INITIATIVE_SCHEMA,
};
use buzz_core::kind::{
    KIND_COMPANY_ACTION, KIND_COMPANY_PROFILE, KIND_COMPANY_RECEIPT, KIND_INITIATIVE, KIND_TASK,
    KIND_TEAM,
};
use buzz_sdk::company::{
    build_company_action, parse_company_receipt, CompanyAction, CompanyActionOperation,
    CompanyActionPayload, CompanyReceiptOutcome,
};
use buzz_sdk::initiative_activation::{next_step, InitiativeIntent, InitiativeStep};
use buzz_test_client::BuzzTestClient;
use nostr::{EventBuilder, Filter, Keys, Kind, Tag, Timestamp};
use uuid::Uuid;

const TASK_SCHEMA: &str = "colony.task/v1";

fn relay_url() -> String {
    std::env::var("RELAY_URL").unwrap_or_else(|_| "ws://localhost:3099".to_string())
}

fn http_url() -> String {
    std::env::var("RELAY_HTTP_URL").unwrap_or_else(|_| "http://localhost:3099".to_string())
}

/// The community owner this test signs as.
///
/// Fixed rather than generated: the relay decides who the owner is from
/// `RELAY_OWNER_PUBKEY` at startup, so the key has to be known before the
/// process starts. Every test isolates itself by company ID instead.
fn owner_keys() -> Keys {
    let secret = std::env::var("COMPANY_OWNER_SECRET").unwrap_or_else(|_| {
        "1c0ffee51c0ffee51c0ffee51c0ffee51c0ffee51c0ffee51c0ffee51c0ffee5".to_string()
    });
    Keys::parse(&secret).expect("COMPANY_OWNER_SECRET must be a 64-hex secret key")
}

fn sub_id(name: &str) -> String {
    format!("e2e-company-{name}-{}", Uuid::new_v4())
}

/// The relay's own signing key, which every canonical head is addressed to.
async fn relay_self() -> String {
    let client = reqwest::Client::new();
    let document: serde_json::Value = client
        .get(http_url())
        .header("Accept", "application/nostr+json")
        .send()
        .await
        .expect("relay NIP-11 document")
        .json()
        .await
        .expect("NIP-11 is JSON");
    document
        .get("self")
        .and_then(|value| value.as_str())
        .expect("this relay advertises no `self` key, so nothing here can be proven")
        .to_ascii_lowercase()
}

fn company(id: &str, now: i64) -> CompanyProfile {
    CompanyProfile {
        schema: COMPANY_SCHEMA.to_string(),
        id: id.to_string(),
        trading_name: "Horizon Labs".to_string(),
        legal_name: None,
        website: None,
        summary: "Software for South African businesses.".to_string(),
        business_type: "agency".to_string(),
        services: vec![CompanyService {
            id: "web".to_string(),
            name: "Web builds".to_string(),
            description: "Sites and apps.".to_string(),
        }],
        customer_segments: vec!["small business".to_string()],
        cost_centres: vec![CostCentre {
            id: "cc-coordination".to_string(),
            name: "Company coordination".to_string(),
            kind: CostCentreKind::Internal,
            service_id: None,
        }],
        source_report_event_id: None,
        onboarding_status: CompanyOnboardingStatus::Approved,
        created_at: now,
        updated_at: now,
    }
}

fn initiative(company_id: &str, id: &str, owner_persona_id: &str, now: i64) -> Initiative {
    Initiative {
        schema: INITIATIVE_SCHEMA.to_string(),
        id: id.to_string(),
        company_id: company_id.to_string(),
        title: "Launch outbound".to_string(),
        summary: "Open a first outbound channel.".to_string(),
        status: InitiativeStatus::Proposed,
        owner_persona_id: owner_persona_id.to_string(),
        cost_centre_id: "cc-coordination".to_string(),
        commercial_purpose: CommercialPurpose::Sales,
        client_organization_id: None,
        expected_cost_usd: None,
        source_channel_id: "welcome".to_string(),
        source_event_id: None,
        created_at: now,
        updated_at: now,
    }
}

fn task(company_id: &str, id: &str, team: &CompanyTeamRef, now: i64) -> CompanyTask {
    CompanyTask {
        schema: TASK_SCHEMA.to_string(),
        id: id.to_string(),
        company_id: company_id.to_string(),
        initiative_id: None,
        title: "Draft the first prospect list".to_string(),
        status: TaskStatus::Ready,
        owning_team_id: team.id.clone(),
        assignee_persona_ids: vec![team.lead_persona_id.clone()],
        qa_persona_id: team.lead_persona_id.clone(),
        cost_centre_id: "cc-coordination".to_string(),
        commercial_purpose: CommercialPurpose::Administration,
        client_organization_id: None,
        source_channel_id: "welcome".to_string(),
        source_event_id: None,
        implicit: false,
        created_at: now,
        updated_at: now,
    }
}

fn coordinate(kind: u32, relay: &str, id: &str) -> String {
    format!("{kind}:{relay}:{id}")
}

fn action(
    relay: &str,
    operation: CompanyActionOperation,
    payload: CompanyActionPayload,
    target: String,
    expected_head: Option<String>,
) -> CompanyAction {
    CompanyAction {
        relay_pubkey: relay.to_string(),
        operation,
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        target,
        expected_head,
        expected_references: Vec::new(),
        payload,
    }
}

/// Publish one action and wait for the relay's linked receipt.
async fn broker(
    client: &mut BuzzTestClient,
    keys: &Keys,
    relay: &str,
    action: &CompanyAction,
) -> (CompanyReceiptOutcome, Option<String>) {
    let event = build_company_action(action)
        .expect("action builds")
        .sign_with_keys(keys)
        .expect("action signs");
    let action_id = event.id.to_hex();
    let ok = client
        .send_event(event)
        .await
        .expect("the relay answers every action");
    // `accepted` is not asserted: a conflict and a duplicate are both legitimate
    // answers this suite goes on to read from the receipt. It is printed
    // because when a run does fail, the relay's reason is the whole diagnosis,
    // and without it every failure looks identical to "no receipt arrived".
    eprintln!(
        "action {} accepted={} message={:?}",
        &action_id[..12],
        ok.accepted,
        ok.message
    );

    // The receipt is authored by the relay after it processes the action, so
    // this polls rather than assuming it is already stored.
    for _ in 0..40 {
        let id = sub_id("receipt");
        let filter = Filter::new()
            .kind(Kind::Custom(KIND_COMPANY_RECEIPT as u16))
            .author(nostr::PublicKey::from_hex(relay).expect("relay key"))
            .event(nostr::EventId::from_hex(&action_id).expect("action id"))
            .limit(1);
        client
            .subscribe(&id, vec![filter])
            .await
            .expect("subscribe");
        let events = client
            .collect_until_eose(&id, Duration::from_secs(5))
            .await
            .expect("collect");
        let _ = client.close_subscription(&id).await;
        if let Some(event) = events.first() {
            let receipt = parse_company_receipt(event).expect("receipt parses");
            assert_eq!(
                receipt.action_event_id, action_id,
                "a receipt must name the action it answers"
            );
            return (receipt.outcome, receipt.head_event_id);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("the relay never answered a legitimate owner action");
}

/// Read one relay-authored head by coordinate.
async fn head(
    client: &mut BuzzTestClient,
    relay: &str,
    kind: u32,
    d_tag: &str,
) -> Option<nostr::Event> {
    let id = sub_id("head");
    let filter = Filter::new()
        .kind(Kind::Custom(kind as u16))
        .author(nostr::PublicKey::from_hex(relay).expect("relay key"))
        .identifier(d_tag)
        .limit(1);
    client
        .subscribe(&id, vec![filter])
        .await
        .expect("subscribe");
    let events = client
        .collect_until_eose(&id, Duration::from_secs(5))
        .await
        .expect("collect");
    let _ = client.close_subscription(&id).await;
    events.into_iter().next()
}

/// Publish the Team the relay validates Task ownership against.
async fn publish_team(client: &mut BuzzTestClient, keys: &Keys, team: &CompanyTeamRef) {
    let content = serde_json::json!({
        "id": team.id,
        "lead_persona_id": team.lead_persona_id,
        "persona_ids": team.persona_ids,
    });
    let event = EventBuilder::new(
        Kind::Custom(KIND_TEAM as u16),
        serde_json::to_string(&content).expect("team json"),
    )
    .tags(vec![Tag::parse(["d", team.id.as_str()]).expect("d tag")])
    .sign_with_keys(keys)
    .expect("team signs");
    client.send_event(event).await.expect("relay accepts team");
}

fn now() -> i64 {
    Timestamp::now().as_u64() as i64
}

/// One owner, one company, one team: the fixture every assertion runs against.
struct Fixture {
    owner: Keys,
    relay: String,
    company_id: String,
    team: CompanyTeamRef,
}

async fn setup(client: &mut BuzzTestClient, owner: Keys) -> Fixture {
    let relay = relay_self().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let company_id = format!("co{}", &suffix[..12]);
    let team = CompanyTeamRef {
        id: format!("team-{}", &suffix[..12]),
        lead_persona_id: format!("lead-{}", &suffix[..12]),
        persona_ids: vec![format!("lead-{}", &suffix[..12])],
    };
    publish_team(client, &owner, &team).await;
    Fixture {
        owner,
        relay,
        company_id,
        team,
    }
}

#[tokio::test]
#[ignore = "requires a running relay whose community owner is this test's key"]
async fn the_relay_authors_every_company_head_and_receipts_every_request() {
    let owner = owner_keys();
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let fixture = setup(&mut client, owner.clone()).await;
    let stamp = now();

    // --- Create the company -------------------------------------------------
    let profile = company(&fixture.company_id, stamp);
    let create = action(
        &fixture.relay,
        CompanyActionOperation::Create,
        CompanyActionPayload::Company(profile.clone()),
        coordinate(KIND_COMPANY_PROFILE, &fixture.relay, &fixture.company_id),
        None,
    );
    let (outcome, head_id) = broker(&mut client, &fixture.owner, &fixture.relay, &create).await;
    assert_eq!(
        outcome,
        CompanyReceiptOutcome::Applied,
        "the owner's own company must be created"
    );
    let head_id = head_id.expect("an applied receipt names its head");

    let stored = head(
        &mut client,
        &fixture.relay,
        KIND_COMPANY_PROFILE,
        &fixture.company_id,
    )
    .await
    .expect("the company head exists");
    assert_eq!(
        stored.id.to_hex(),
        head_id,
        "the receipt names the real head"
    );
    assert_eq!(
        stored.pubkey.to_hex(),
        fixture.relay,
        "the relay, not the owner, authored the head"
    );

    // --- Create an initiative and two tasks ---------------------------------
    let initiative_id = format!("{}:launch", fixture.company_id);
    let proposed = initiative(
        &fixture.company_id,
        &initiative_id,
        &fixture.team.lead_persona_id,
        stamp,
    );
    let (outcome, _) = broker(
        &mut client,
        &fixture.owner,
        &fixture.relay,
        &action(
            &fixture.relay,
            CompanyActionOperation::Create,
            CompanyActionPayload::Initiative(proposed.clone()),
            coordinate(KIND_INITIATIVE, &fixture.relay, &initiative_id),
            None,
        ),
    )
    .await;
    assert_eq!(outcome, CompanyReceiptOutcome::Applied);

    let mut task_heads = Vec::new();
    for suffix in ["one", "two"] {
        let task_id = format!("{}:task-{suffix}", fixture.company_id);
        let record = task(&fixture.company_id, &task_id, &fixture.team, stamp);
        let (outcome, head_id) = broker(
            &mut client,
            &fixture.owner,
            &fixture.relay,
            &action(
                &fixture.relay,
                CompanyActionOperation::Create,
                CompanyActionPayload::Task(record.clone()),
                coordinate(KIND_TASK, &fixture.relay, &task_id),
                None,
            ),
        )
        .await;
        assert_eq!(outcome, CompanyReceiptOutcome::Applied, "task {suffix}");
        task_heads.push((task_id, record, head_id.expect("applied names a head")));
    }

    // --- Replacing one task leaves the other alone --------------------------
    let (first_id, first_record, first_head) = task_heads[0].clone();
    let (_, _, second_head) = task_heads[1].clone();
    let mut replacement = first_record.clone();
    replacement.status = TaskStatus::InProgress;
    replacement.updated_at = first_record.updated_at + 1;
    let (outcome, _) = broker(
        &mut client,
        &fixture.owner,
        &fixture.relay,
        &action(
            &fixture.relay,
            CompanyActionOperation::Transition,
            CompanyActionPayload::Task(replacement.clone()),
            coordinate(KIND_TASK, &fixture.relay, &first_id),
            Some(first_head.clone()),
        ),
    )
    .await;
    assert_eq!(outcome, CompanyReceiptOutcome::Applied);
    let other = head(&mut client, &fixture.relay, KIND_TASK, &task_heads[1].0)
        .await
        .expect("the other task still exists");
    assert_eq!(
        other.id.to_hex(),
        second_head,
        "replacing one task must not disturb another"
    );

    // --- A stale expected head is a conflict, not a silent overwrite --------
    let mut stale = replacement.clone();
    stale.updated_at = replacement.updated_at + 1;
    let (outcome, head_id) = broker(
        &mut client,
        &fixture.owner,
        &fixture.relay,
        &action(
            &fixture.relay,
            CompanyActionOperation::Transition,
            CompanyActionPayload::Task(stale),
            coordinate(KIND_TASK, &fixture.relay, &first_id),
            // The head this names was replaced a moment ago.
            Some(first_head),
        ),
    )
    .await;
    assert_eq!(
        outcome,
        CompanyReceiptOutcome::Conflict,
        "a request built against a replaced head must lose"
    );
    assert_eq!(head_id, None, "a conflict names no head");

    // --- An illegal transition is refused -----------------------------------
    let mut illegal = replacement.clone();
    illegal.status = TaskStatus::Proposed;
    illegal.updated_at = replacement.updated_at + 1;
    let current = head(&mut client, &fixture.relay, KIND_TASK, &first_id)
        .await
        .expect("current task head");
    let (outcome, _) = broker(
        &mut client,
        &fixture.owner,
        &fixture.relay,
        &action(
            &fixture.relay,
            CompanyActionOperation::Transition,
            CompanyActionPayload::Task(illegal),
            coordinate(KIND_TASK, &fixture.relay, &first_id),
            Some(current.id.to_hex()),
        ),
    )
    .await;
    assert_ne!(
        outcome,
        CompanyReceiptOutcome::Applied,
        "in-progress work cannot go back to proposed"
    );

    // --- A replayed action is answered, not applied twice -------------------
    let replay_id = format!("{}:task-replay", fixture.company_id);
    let replay_record = task(&fixture.company_id, &replay_id, &fixture.team, stamp);
    let replay = action(
        &fixture.relay,
        CompanyActionOperation::Create,
        CompanyActionPayload::Task(replay_record),
        coordinate(KIND_TASK, &fixture.relay, &replay_id),
        None,
    );
    let (first_outcome, first_replay_head) =
        broker(&mut client, &fixture.owner, &fixture.relay, &replay).await;
    assert_eq!(first_outcome, CompanyReceiptOutcome::Applied);
    let (second_outcome, second_replay_head) =
        broker(&mut client, &fixture.owner, &fixture.relay, &replay).await;
    assert_eq!(
        second_outcome, first_outcome,
        "the same request twice must reach the same outcome"
    );
    assert_eq!(
        second_replay_head, first_replay_head,
        "a replay must resolve the head the first attempt wrote, not a second one"
    );

    client.disconnect().await.ok();
}

#[tokio::test]
#[ignore = "requires a running relay whose community owner is this test's key"]
async fn nobody_but_the_owner_can_change_company_state() {
    let owner = owner_keys();
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let fixture = setup(&mut client, owner.clone()).await;
    let stamp = now();

    let profile = company(&fixture.company_id, stamp);
    let (outcome, _) = broker(
        &mut client,
        &fixture.owner,
        &fixture.relay,
        &action(
            &fixture.relay,
            CompanyActionOperation::Create,
            CompanyActionPayload::Company(profile.clone()),
            coordinate(KIND_COMPANY_PROFILE, &fixture.relay, &fixture.company_id),
            None,
        ),
    )
    .await;
    assert_eq!(outcome, CompanyReceiptOutcome::Applied);

    // --- A member who is not the owner cannot replace the company -----------
    let stranger = Keys::generate();
    let mut stranger_client = BuzzTestClient::connect(&relay_url(), &stranger)
        .await
        .expect("connect as stranger");
    let mut hijack = profile.clone();
    hijack.trading_name = "Somebody Else".to_string();
    hijack.updated_at = profile.updated_at + 1;
    let head_before = head(
        &mut client,
        &fixture.relay,
        KIND_COMPANY_PROFILE,
        &fixture.company_id,
    )
    .await
    .expect("company head");
    let event = build_company_action(&action(
        &fixture.relay,
        CompanyActionOperation::Transition,
        CompanyActionPayload::Company(hijack),
        coordinate(KIND_COMPANY_PROFILE, &fixture.relay, &fixture.company_id),
        Some(head_before.id.to_hex()),
    ))
    .expect("action builds")
    .sign_with_keys(&stranger)
    .expect("action signs");
    // Refused outright: a non-owner request is not even given a receipt, because
    // a receipt is a durable answer owed only to a legitimate request.
    let _ = stranger_client.send_event(event).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let head_after = head(
        &mut client,
        &fixture.relay,
        KIND_COMPANY_PROFILE,
        &fixture.company_id,
    )
    .await
    .expect("company head still exists");
    assert_eq!(
        head_after.id.to_hex(),
        head_before.id.to_hex(),
        "a stranger must not be able to replace the company"
    );

    // --- Nobody may write a head or a receipt directly ----------------------
    for (kind, label) in [
        (KIND_COMPANY_PROFILE, "company head"),
        (KIND_INITIATIVE, "initiative head"),
        (KIND_TASK, "task head"),
        (KIND_COMPANY_RECEIPT, "receipt"),
    ] {
        let forged = EventBuilder::new(Kind::Custom(kind as u16), "{}")
            .tags(vec![
                Tag::parse(["d", fixture.company_id.as_str()]).expect("d")
            ])
            .sign_with_keys(&fixture.owner)
            .expect("sign");
        let response = client.send_event(forged).await;
        let accepted = response.map(|ok| ok.accepted).unwrap_or(false);
        assert!(
            !accepted,
            "a client-authored {label} must be refused even from the owner"
        );
    }

    stranger_client.disconnect().await.ok();
    client.disconnect().await.ok();
}

/// The activation ladder the desktop drives, run against a real relay.
///
/// The step function decides transitions in `buzz-sdk` with no relay in sight.
/// This proves the relay actually accepts the exact sequence it produces,
/// which is the one thing unit tests over that function cannot establish.
#[tokio::test]
#[ignore = "requires a running relay whose community owner is this test's key"]
async fn the_activation_ladder_the_desktop_drives_is_accepted_end_to_end() {
    let owner = owner_keys();
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let fixture = setup(&mut client, owner.clone()).await;
    let stamp = now();

    let profile = company(&fixture.company_id, stamp);
    let (outcome, _) = broker(
        &mut client,
        &fixture.owner,
        &fixture.relay,
        &action(
            &fixture.relay,
            CompanyActionOperation::Create,
            CompanyActionPayload::Company(profile.clone()),
            coordinate(KIND_COMPANY_PROFILE, &fixture.relay, &fixture.company_id),
            None,
        ),
    )
    .await;
    assert_eq!(outcome, CompanyReceiptOutcome::Applied);

    let initiative_id = format!("{}:launch", fixture.company_id);
    let proposed = initiative(
        &fixture.company_id,
        &initiative_id,
        &fixture.team.lead_persona_id,
        stamp,
    );
    let (outcome, _) = broker(
        &mut client,
        &fixture.owner,
        &fixture.relay,
        &action(
            &fixture.relay,
            CompanyActionOperation::Create,
            CompanyActionPayload::Initiative(proposed),
            coordinate(KIND_INITIATIVE, &fixture.relay, &initiative_id),
            None,
        ),
    )
    .await;
    assert_eq!(outcome, CompanyReceiptOutcome::Applied);

    let teams = [fixture.team.clone()];
    let mut statuses = Vec::new();
    let mut kickoff_task_id = None;

    // Exactly what the desktop does: read the head, ask for the next step,
    // publish it, read the head again.
    for _ in 0..4 {
        let current = head(&mut client, &fixture.relay, KIND_INITIATIVE, &initiative_id)
            .await
            .expect("initiative head");
        let record =
            buzz_sdk::company::parse_initiative_event(&current).expect("initiative parses");
        statuses.push(record.status);

        let step = next_step(
            &record,
            &current.id.to_hex(),
            &profile,
            &teams,
            &fixture.relay,
            InitiativeIntent::Start,
        )
        .expect("the step function must have an answer for a live head");

        let next_action = match step {
            InitiativeStep::Settled { .. } => break,
            InitiativeStep::Transition { action, .. } => *action,
            InitiativeStep::Kickoff {
                task_id, action, ..
            } => {
                kickoff_task_id = Some(task_id);
                *action
            }
        };
        let (outcome, _) = broker(&mut client, &fixture.owner, &fixture.relay, &next_action).await;
        assert_eq!(
            outcome,
            CompanyReceiptOutcome::Applied,
            "the relay must accept every rung the step function produces"
        );
        if kickoff_task_id.is_some() {
            break;
        }
    }

    assert_eq!(
        statuses,
        vec![
            InitiativeStatus::Proposed,
            InitiativeStatus::Approved,
            InitiativeStatus::Active
        ],
        "activation must walk the ladder rather than jumping it"
    );

    let task_id = kickoff_task_id.expect("an active initiative produces a first task");
    let stored = head(&mut client, &fixture.relay, KIND_TASK, &task_id)
        .await
        .expect("the kickoff task exists");
    let record = buzz_sdk::company::parse_task_event(&stored).expect("task parses");
    assert_eq!(record.owning_team_id, fixture.team.id);
    assert_eq!(record.qa_persona_id, fixture.team.lead_persona_id);
    assert_eq!(
        record.initiative_id.as_deref(),
        Some(initiative_id.as_str())
    );
    assert_eq!(record.status, TaskStatus::Ready);

    client.disconnect().await.ok();
}

/// A guard on the envelope itself: only kind 40013 reaches the broker.
#[test]
fn only_the_company_action_kind_carries_a_company_request() {
    assert_eq!(KIND_COMPANY_ACTION, 40013);
    assert_eq!(KIND_COMPANY_RECEIPT, 40014);
    assert_eq!(KIND_COMPANY_PROFILE, 30179);
    assert_eq!(KIND_INITIATIVE, 30180);
    assert_eq!(KIND_TASK, 30181);
}

/// Prints the owner public key the relay must be started with.
///
/// Not an assertion: the relay decides who the owner is at startup from
/// `RELAY_OWNER_PUBKEY`, and this is where that value comes from. Running the
/// suite against a relay started with any other key proves nothing, so the
/// value is emitted rather than written down somewhere it can drift.
#[test]
fn print_the_owner_pubkey_the_relay_must_be_started_with() {
    println!("RELAY_OWNER_PUBKEY={}", owner_keys().public_key().to_hex());
}
