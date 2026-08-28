//! Shared live-relay fixtures for the Ask chain end-to-end tests.
//!
//! These helpers intentionally build the same company, payroll, role-head,
//! task, and ask records as the original `e2e_ask_chain` suite. Keeping them
//! here lets the live ACP harness test consume the exact fixture rather than a
//! thinner parallel copy.

use std::time::Duration;

use buzz_cli::{build_ask_event, AskEventFields};
use buzz_core::company::{
    CommercialPurpose, CompanyProfile, CompanyService, CompanyTask, CompanyTeamRef, CostCentre,
    CostCentreKind, DoerKind, Initiative, InitiativeStatus, TaskStatus, COMPANY_SCHEMA,
    INITIATIVE_SCHEMA,
};
use buzz_sdk::company::{
    build_company_action, parse_company_receipt, parse_task_event, CompanyAction,
    CompanyActionOperation, CompanyActionPayload, CompanyReceiptOutcome,
};
use buzz_sdk::initiative_activation::{next_step, InitiativeIntent, InitiativeStep};
use buzz_test_client::BuzzTestClient;
use nostr::{EventBuilder, Filter, Keys, Kind, Tag, Timestamp};
use uuid::Uuid;

use super::{e2e_db_pool, query, tag_value};

const TASK_SCHEMA: &str = "colony.task/v1";

/// The relay URL used by the live test client.
pub fn relay_url() -> String {
    std::env::var("RELAY_URL").unwrap_or_else(|_| "ws://localhost:3000".to_string())
}

/// The Host the relay binds requests to, derived from the same `RELAY_URL`
/// this test dials.
pub fn relay_host() -> String {
    relay_url()
        .trim_start_matches("wss://")
        .trim_start_matches("ws://")
        .trim_end_matches('/')
        .to_string()
}

fn relay_http_url() -> String {
    relay_url()
        .replace("wss://", "https://")
        .replace("ws://", "http://")
        .trim_end_matches('/')
        .to_string()
}

/// Insert (or find) the community bound to `host`.
pub async fn ensure_test_community(host: &str) -> Uuid {
    let pool = e2e_db_pool().await;
    sqlx::query(
        "INSERT INTO communities (id, host) VALUES ($1, $2) \
         ON CONFLICT (lower(host)) DO NOTHING",
    )
    .bind(Uuid::new_v4())
    .bind(host)
    .execute(&pool)
    .await
    .unwrap_or_else(|e| panic!("seed community {host}: {e}"));

    sqlx::query_scalar("SELECT id FROM communities WHERE lower(host) = lower($1)")
        .bind(host)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("lookup community {host}: {e}"))
}

/// Put `agent` on the payroll at `rank`, the row
/// `interrupt_gate::agent_tier` resolves a filer's rank from.
pub async fn employ(community_id: Uuid, owner: &Keys, agent: &Keys, role_id: &str, rank: &str) {
    let pool = e2e_db_pool().await;
    let now = Timestamp::now().as_secs() as i64;
    sqlx::query(
        "INSERT INTO employees (community_id, pubkey, sealed_key, role_id, display_name, \
                                rank, hired_by, hire_event, status, created_at, updated_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$9) \
         ON CONFLICT DO NOTHING",
    )
    .bind(community_id)
    .bind(agent.public_key().to_bytes().to_vec())
    .bind(b"sealed-e2e-key".to_vec())
    .bind(role_id)
    .bind(format!("E2E {role_id}"))
    .bind(rank)
    .bind(owner.public_key().to_bytes().to_vec())
    .bind(agent.public_key().to_bytes().to_vec())
    .bind(now)
    .execute(&pool)
    .await
    .unwrap_or_else(|e| panic!("employ {role_id}: {e}"));

    let employed: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM employees WHERE community_id = $1 AND pubkey = $2",
    )
    .bind(community_id)
    .bind(agent.public_key().to_bytes().to_vec())
    .fetch_one(&pool)
    .await
    .unwrap_or_else(|e| panic!("read back employee {role_id}: {e}"));
    assert_eq!(
        employed, 1,
        "the {role_id} fixture did not land: without an employees row this agent has no rank, \
         and every assertion below would be measuring the wrong thing"
    );
}

/// The three rungs an ask climbs, each on the payroll at its own rank.
pub async fn employ_ladder(
    community_id: Uuid,
    owner: &Keys,
    worker: &Keys,
    leader: &Keys,
    executive: &Keys,
) -> (String, String, String) {
    let run = Uuid::new_v4().simple().to_string();
    let run = &run[..8];
    let worker_role = format!("engineer-{run}");
    let leader_role = format!("eng-lead-{run}");
    let executive_role = format!("chief-of-staff-{run}");
    employ(community_id, owner, worker, &worker_role, "worker").await;
    employ(community_id, owner, leader, &leader_role, "leader").await;
    employ(community_id, owner, executive, &executive_role, "executive").await;
    (worker_role, leader_role, executive_role)
}

/// Publish the owner-authored managed-agent head (kind 30177) that says which
/// workspace role `agent` fills.
pub async fn publish_role_head(
    owner_ws: &mut BuzzTestClient,
    owner: &Keys,
    agent: &Keys,
    role_id: &str,
) {
    let event = EventBuilder::new(
        Kind::Custom(buzz_core::kind::KIND_MANAGED_AGENT as u16),
        serde_json::json!({ "display_name": "Ada", "role_id": role_id }).to_string(),
    )
    .tags(vec![
        Tag::parse(["d", &agent.public_key().to_hex()]).expect("d tag")
    ])
    .sign_with_keys(owner)
    .expect("sign managed-agent head");
    let ok = owner_ws
        .send_event(event)
        .await
        .expect("publish managed-agent head");
    assert!(ok.accepted, "managed-agent head rejected: {}", ok.message);
}

fn sub_id(name: &str) -> String {
    format!("e2e-ask-chain-{name}-{}", Uuid::new_v4())
}

/// The relay's own signing key: every canonical company head is authored by
/// it, and every company action is addressed to it.
async fn relay_self() -> String {
    let document: serde_json::Value = reqwest::Client::new()
        .get(relay_http_url())
        .header("Accept", "application/nostr+json")
        .send()
        .await
        .expect("relay NIP-11 document")
        .json()
        .await
        .expect("NIP-11 is JSON");
    document
        .get("self")
        .and_then(serde_json::Value::as_str)
        .expect("this relay advertises no `self` key, so no company record here can be trusted")
        .to_ascii_lowercase()
}

fn now() -> i64 {
    Timestamp::now().as_secs() as i64
}

fn coordinate(kind: u32, relay: &str, id: &str) -> String {
    format!("{kind}:{relay}:{id}")
}

fn action(
    relay: &str,
    operation: CompanyActionOperation,
    payload: CompanyActionPayload,
    target: String,
) -> CompanyAction {
    CompanyAction {
        relay_pubkey: relay.to_string(),
        operation,
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        target,
        expected_head: None,
        expected_references: Vec::new(),
        payload,
    }
}

/// Publish one owner-signed company action and wait for the relay's receipt.
async fn broker(
    client: &mut BuzzTestClient,
    keys: &Keys,
    relay: &str,
    action: &CompanyAction,
) -> CompanyReceiptOutcome {
    let event = build_company_action(action)
        .expect("action builds")
        .sign_with_keys(keys)
        .expect("action signs");
    let action_id = event.id.to_hex();
    let ok = client
        .send_event(event)
        .await
        .expect("the relay answers every action");
    eprintln!(
        "company action {} accepted={} message={:?}",
        &action_id[..12],
        ok.accepted,
        ok.message
    );

    for _ in 0..40 {
        let id = sub_id("receipt");
        let filter = Filter::new()
            .kind(Kind::Custom(buzz_core::kind::KIND_COMPANY_RECEIPT as u16))
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
            return parse_company_receipt(event)
                .expect("receipt parses")
                .outcome;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("the relay never answered a legitimate owner action");
}

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

fn company_profile(stamp: i64) -> CompanyProfile {
    CompanyProfile {
        schema: COMPANY_SCHEMA.to_string(),
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
            id: "general".to_string(),
            name: "Company coordination".to_string(),
            kind: CostCentreKind::Internal,
            service_id: None,
        }],
        source_report_event_id: None,
        created_at: stamp,
        updated_at: stamp,
    }
}

fn proposed_initiative(id: &str, owner_persona_id: &str, stamp: i64) -> Initiative {
    Initiative {
        schema: INITIATIVE_SCHEMA.to_string(),
        id: id.to_string(),
        title: "Tennant premium site".to_string(),
        summary: "Ship the premium build.".to_string(),
        status: InitiativeStatus::Proposed,
        owner_persona_id: owner_persona_id.to_string(),
        cost_centre_id: "general".to_string(),
        commercial_purpose: CommercialPurpose::ClientDelivery,
        client_organization_id: None,
        expected_cost_usd: None,
        source_channel_id: "welcome".to_string(),
        source_event_id: None,
        template_id: None,
        template_version: None,
        cohort_id: None,
        created_at: stamp,
        updated_at: stamp,
    }
}

/// A Task with no initiative -- the shape Colony creates for any instruction
/// that arrives in chat.
fn chat_task(id: &str, team: &CompanyTeamRef, stamp: i64) -> CompanyTask {
    CompanyTask {
        schema: TASK_SCHEMA.to_string(),
        id: id.to_string(),
        initiative_id: None,
        title: "Take a look at the failing deploy".to_string(),
        status: TaskStatus::InProgress,
        owning_team_id: team.id.clone(),
        assignee_persona_ids: vec![team.lead_persona_id.clone()],
        qa_persona_id: team.lead_persona_id.clone(),
        reviewer_team_id: None,
        cost_centre_id: "general".to_string(),
        commercial_purpose: CommercialPurpose::Administration,
        client_organization_id: None,
        source_channel_id: "engineering".to_string(),
        source_event_id: None,
        implicit: true,
        depends_on: Vec::new(),
        subject: None,
        stage: None,
        thread_root: None,
        doer_kind: DoerKind::Agent,
        wake_at: None,
        outcome_reason: None,
        bounce_reason: None,
        bounce_count: 0,
        created_at: stamp,
        updated_at: stamp,
    }
}

async fn publish_team(client: &mut BuzzTestClient, keys: &Keys, team: &CompanyTeamRef) {
    let content = serde_json::json!({
        "id": team.id,
        "lead_persona_id": team.lead_persona_id,
        "persona_ids": team.persona_ids,
    });
    let event = EventBuilder::new(
        Kind::Custom(buzz_core::kind::KIND_TEAM as u16),
        serde_json::to_string(&content).expect("team json"),
    )
    .tags(vec![Tag::parse(["d", team.id.as_str()]).expect("d tag")])
    .sign_with_keys(keys)
    .expect("team signs");
    client.send_event(event).await.expect("relay accepts team");
}

/// One community with an owner, one company, one team.
pub struct Workspace {
    owner: Keys,
    relay: String,
    company: CompanyProfile,
    team: CompanyTeamRef,
}

pub async fn workspace(client: &mut BuzzTestClient, owner: Keys) -> Workspace {
    let relay = relay_self().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let team = CompanyTeamRef {
        id: format!("team-{}", &suffix[..12]),
        lead_persona_id: format!("lead-{}", &suffix[..12]),
        persona_ids: vec![format!("lead-{}", &suffix[..12])],
    };
    publish_team(client, &owner, &team).await;

    // The relay writes every community a default profile at startup, so the
    // profile already exists here and carries the default cost centre rather
    // than this suite's. Create it if somehow absent, otherwise EDIT it: the
    // Tasks below charge to `cc-coordination`, and `validate_task` refuses a
    // Nothing here writes the community profile. The relay writes every
    // community its own at startup, carrying the `general` cost centre these
    // fixtures charge to, and that profile is shared across every
    // concurrently-running test — so each one editing it was an ordinary
    // compare-and-set race the relay was right to refuse. Reading what is
    // already there removes the contention instead of retrying through it.
    Workspace {
        owner,
        relay,
        company: company_profile(now()),
        team,
    }
}

/// Walk a proposed initiative to active and take the Task its activation
/// produces.
#[allow(dead_code)]
pub async fn start_initiative(client: &mut BuzzTestClient, ws: &Workspace) -> (String, String) {
    let initiative_id = "tennant-premium".to_string();
    let proposed = proposed_initiative(&initiative_id, &ws.team.lead_persona_id, now());
    let outcome = broker(
        client,
        &ws.owner,
        &ws.relay,
        &action(
            &ws.relay,
            CompanyActionOperation::Create,
            CompanyActionPayload::Initiative(proposed),
            coordinate(buzz_core::kind::KIND_INITIATIVE, &ws.relay, &initiative_id),
        ),
    )
    .await;
    assert_eq!(outcome, CompanyReceiptOutcome::Applied);

    let teams = [ws.team.clone()];
    let mut task_id = None;
    for _ in 0..4 {
        let current = head(
            client,
            &ws.relay,
            buzz_core::kind::KIND_INITIATIVE,
            &initiative_id,
        )
        .await
        .expect("initiative head");
        let record =
            buzz_sdk::company::parse_initiative_event(&current).expect("initiative parses");
        let step = next_step(
            &record,
            &current.id.to_hex(),
            &teams,
            &ws.relay,
            InitiativeIntent::Start,
        )
        .expect("the step function must have an answer for a live head");

        let next_action = match step {
            InitiativeStep::Settled { .. } => break,
            InitiativeStep::Transition { action, .. } => *action,
            InitiativeStep::Kickoff {
                task_id: id,
                action,
                ..
            } => {
                task_id = Some(id);
                *action
            }
        };
        assert_eq!(
            broker(client, &ws.owner, &ws.relay, &next_action).await,
            CompanyReceiptOutcome::Applied,
            "the relay must accept every rung of the activation ladder"
        );
        if task_id.is_some() {
            break;
        }
    }

    let task_id = task_id.expect("an active initiative produces a first task");
    let stored = head(client, &ws.relay, buzz_core::kind::KIND_TASK, &task_id)
        .await
        .expect("the kickoff task must exist as a relay-authored record");
    let record = parse_task_event(&stored).expect("task parses");
    assert_eq!(
        record.initiative_id.as_deref(),
        Some(initiative_id.as_str()),
        "the ask's task and initiative must really be related, not two loose strings"
    );

    (initiative_id, task_id)
}

/// Create the relay-authored Task an ask about chat work hangs off.
pub async fn create_chat_task(client: &mut BuzzTestClient, ws: &Workspace) -> String {
    let task_id = format!("chat:{}", Uuid::new_v4().simple());
    let record = chat_task(&task_id, &ws.team, now());
    assert_eq!(
        broker(
            client,
            &ws.owner,
            &ws.relay,
            &action(
                &ws.relay,
                CompanyActionOperation::Create,
                CompanyActionPayload::Task(record),
                coordinate(buzz_core::kind::KIND_TASK, &ws.relay, &task_id),
            ),
        )
        .await,
        CompanyReceiptOutcome::Applied
    );

    let stored = head(client, &ws.relay, buzz_core::kind::KIND_TASK, &task_id)
        .await
        .expect("the chat task must exist as a relay-authored record");
    let record = parse_task_event(&stored).expect("task parses");
    assert_eq!(
        record.initiative_id, None,
        "the point of this fixture is a task with no initiative"
    );
    task_id
}

/// One hop of the ladder, built by `buzz-cli`'s own ask builder and sent over
/// the filer's own connection. Returns the stored ask's event id.
#[allow(clippy::too_many_arguments)]
#[allow(dead_code)]
pub async fn raise(
    filer_ws: &mut BuzzTestClient,
    filer: &Keys,
    audience_hex: &str,
    initiative_id: Option<&str>,
    task_id: &str,
    need: &str,
    headline: &str,
    prior: Option<&str>,
) -> String {
    raise_with_window(
        filer_ws,
        filer,
        audience_hex,
        initiative_id,
        task_id,
        need,
        headline,
        prior,
        None,
    )
    .await
}

/// File an ask with an optional explicit deadline window.
#[allow(clippy::too_many_arguments)]
pub async fn raise_with_window(
    filer_ws: &mut BuzzTestClient,
    filer: &Keys,
    audience_hex: &str,
    initiative_id: Option<&str>,
    task_id: &str,
    need: &str,
    headline: &str,
    prior: Option<&str>,
    window_secs: Option<u64>,
) -> String {
    let task_ids = vec![task_id.to_string()];
    let builder = build_ask_event(&AskEventFields {
        ask_type: "decision",
        audience_hex,
        initiative_id,
        task_ids: &task_ids,
        need_key: need,
        thread_hex: None,
        prior_hex: prior,
        category: None,
        channel: None,
        headline,
        cost_of_delay: "47 leads are waiting on this",
        options: &[],
        default_option: None,
        window_secs,
    })
    .expect("the CLI's own builder must produce an ask event");
    let event = builder.sign_with_keys(filer).expect("sign ask");
    let ask_id = event.id.to_hex();
    let ok = filer_ws.send_event(event).await.expect("send ask");
    assert!(
        ok.accepted,
        "a filer ranked one tier below its audience must be accepted, got: {}",
        ok.message
    );
    ask_id
}

/// Answer an open ask as its addressed audience.
#[allow(dead_code)]
pub async fn answer_ask(
    answerer_ws: &mut BuzzTestClient,
    answerer: &Keys,
    ask_id: &str,
    decision: &str,
) {
    let content = serde_json::json!({
        "answer": {
            "decision": decision,
            "rationale": "within this tier's authority",
        },
    })
    .to_string();
    let resolution = EventBuilder::new(
        Kind::Custom(buzz_core::kind::KIND_ASK_RESOLUTION as u16),
        content,
    )
    .tags([Tag::parse(["e", ask_id]).expect("e tag")])
    .sign_with_keys(answerer)
    .expect("sign resolution");
    let ok = answerer_ws
        .send_event(resolution)
        .await
        .expect("send resolution");
    assert!(
        ok.accepted,
        "the addressed leader must be allowed to resolve its ask: {}",
        ok.message
    );
}

/// The Needs-Me surface's first query, verbatim: every ask addressed to me.
pub async fn asks_addressed_to(owner: &Keys) -> Vec<serde_json::Value> {
    query(
        owner,
        serde_json::json!({
            "kinds": [buzz_core::kind::KIND_ASK],
            "#p": [owner.public_key().to_hex()]
        }),
    )
    .await
}

/// The Needs-Me surface's second query, verbatim: which of them are closed.
pub async fn closures_naming(owner: &Keys, ask_ids: &[String]) -> Vec<serde_json::Value> {
    query(
        owner,
        serde_json::json!({
            "kinds": [
                buzz_core::kind::KIND_ASK_RESOLUTION,
                buzz_core::kind::KIND_ASK_WITHDRAWAL
            ],
            "#e": ask_ids,
        }),
    )
    .await
}

/// Wait until the deadline sweep promotes an unanswered ask to `audience`.
pub async fn wait_for_successor(audience: &Keys, prior: &str) -> Vec<serde_json::Value> {
    for attempt in 0..60 {
        let successors = asks_addressed_to(audience)
            .await
            .into_iter()
            .filter(|ask| tag_value(ask, "prior") == prior)
            .collect::<Vec<_>>();
        if !successors.is_empty() {
            return successors;
        }
        if attempt < 59 {
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }
    panic!("the deadline sweep did not promote unanswered ask {prior} within 120 seconds");
}
