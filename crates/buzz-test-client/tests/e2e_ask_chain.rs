//! End-to-end proof that an agent can actually raise an Ask, against work
//! that actually exists, and that it reaches the human owner.
//!
//! `e2e_interrupts.rs` already proves the ladder's *rules* over a live relay.
//! It proves them against invented inputs: `initiative: "e2e-<uuid>"`,
//! `task: "task-1"`, and a tier published straight onto a managed-agent head.
//! Nothing there could fail because an agent had no initiative to name, no
//! task to name, or no rank -- which is the entire reason zero asks had ever
//! been raised. This suite closes that gap by refusing to invent any of them:
//!
//! - the initiative and the task are **relay-authored company records**,
//!   created by walking the same activation ladder the desktop's
//!   `startInitiative` drives (`buzz_sdk::initiative_activation::next_step`);
//! - the ask is built by **`buzz-cli`'s own `build_ask_event`** -- the exact
//!   code path behind `buzz asks raise`, not a second copy of the tag shape;
//! - the filer's rank comes from an `employees` row, the source
//!   `interrupt_gate::agent_tier` reads;
//! - the owner reads the result back through the **documented Needs-Me
//!   queries** (`{"kinds":[44300],"#p":[owner]}`, then 44301/44302 by `#e`),
//!   with no privileged access to the relay's internal `asks` table.
//!
//! Three scenarios, because they fail for different reasons:
//!
//! 1. `an_employed_worker_raises_an_ask_that_reaches_the_owner` -- work
//!    organized under an initiative, climbing worker -> leader -> executive
//!    -> owner.
//! 2. `an_ask_about_chat_derived_work_with_no_initiative_still_reaches_the_owner`
//!    -- the ordinary case. A task created from chat carries no initiative
//!    (`buzz_sdk::implicit_task`), and `--initiative` used to be required, so
//!    an agent doing the most common kind of work could not construct an ask
//!    at all.
//! 3. `a_managed_agent_that_is_not_an_employee_raises_an_ask_to_the_owner`
//!    -- the agent shape that actually runs. Buzz Desktop generates a managed
//!    agent's key locally and never sends a hire request, so no running agent
//!    has an `employees` row; its rank comes from the role its owner-authored
//!    head names.
//!
//! # Running
//!
//! ```text
//! RELAY_URL=ws://localhost:3000 \
//! DATABASE_URL=postgres://buzz:buzz_dev@localhost:5432/buzz \
//! cargo test -p buzz-test-client --test e2e_ask_chain -- --ignored --nocapture
//! ```
//!
//! Needs a relay started with a durable `BUZZ_RELAY_PRIVATE_KEY`: company
//! heads and the kind-44302 withdrawal that closes a superseded ask are both
//! relay-signed, and the relay refuses to sign either on the ephemeral
//! fallback key. Without one this fails at the first company action rather
//! than silently proving less.

mod common;

use std::time::Duration;

use buzz_cli::{build_ask_event, AskEventFields};
use buzz_core::company::{
    CommercialPurpose, CompanyOnboardingStatus, CompanyProfile, CompanyService, CompanyTask,
    CompanyTeamRef, CostCentre, CostCentreKind, Initiative, InitiativeStatus, TaskStatus,
    COMPANY_SCHEMA, INITIATIVE_SCHEMA,
};
use buzz_core::interrupt::NO_INITIATIVE;
use buzz_core::kind::{
    KIND_ASK, KIND_ASK_RESOLUTION, KIND_ASK_WITHDRAWAL, KIND_COMPANY_PROFILE, KIND_COMPANY_RECEIPT,
    KIND_INITIATIVE, KIND_MANAGED_AGENT, KIND_TASK, KIND_TEAM,
};
use buzz_sdk::company::{
    build_company_action, parse_company_receipt, parse_task_event, CompanyAction,
    CompanyActionOperation, CompanyActionPayload, CompanyReceiptOutcome,
};
use buzz_sdk::initiative_activation::{next_step, InitiativeIntent, InitiativeStep};
use buzz_test_client::BuzzTestClient;
use nostr::{EventBuilder, Filter, Keys, Kind, Tag, Timestamp};
use uuid::Uuid;

use common::{e2e_db_pool, query, seed_relay_owner, tag_value};

const TASK_SCHEMA: &str = "colony.task/v1";

fn relay_url() -> String {
    std::env::var("RELAY_URL").unwrap_or_else(|_| "ws://localhost:3000".to_string())
}

/// The Host the relay binds requests to, derived from the same `RELAY_URL`
/// this test dials. Fixtures seeded against a hardcoded host while requests
/// bind to another land in one community while the run happens in a second,
/// which fails on whichever assertion happens to need them first rather than
/// on the mismatch itself.
fn relay_host() -> String {
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
async fn ensure_test_community(host: &str) -> Uuid {
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
///
/// A fixture, and it has to be: `employee_broker` mints an employee's keypair
/// and seals it inside the relay, so a hired employee's secret key is
/// unavailable to any test that then needs to *sign* as that employee. The
/// same shape `crates/buzz-relay/tests/interrupt_gate.rs::employ` uses. What
/// is under test is what the rank then permits and forbids, which is decided
/// in the relay from this row, over the wire, for real.
async fn employ(community_id: Uuid, owner: &Keys, agent: &Keys, role_id: &str, rank: &str) {
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
    // One hire request produces one employee, so the column is unique; a
    // shared constant would make every insert after the first a silent no-op.
    .bind(agent.public_key().to_bytes().to_vec())
    .bind(now)
    .execute(&pool)
    .await
    .unwrap_or_else(|e| panic!("employ {role_id}: {e}"));

    // `employees` is uniquely indexed on the role as well as the hire event,
    // so `ON CONFLICT DO NOTHING` silently inserts nothing when a role slug is
    // reused inside one community. The resulting run reads as an authorization
    // bug -- the relay answers "owners answer asks; they do not file them",
    // because an agent with no employees row has no rank -- rather than as the
    // fixture never landing. Assert the row, so that failure is legible.
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
///
/// Role slugs are unique per run because `employees` is uniquely indexed on
/// `(community, role_id)` and every test here shares one community: the relay
/// binds requests to a community by Host header, so two suites against one
/// relay cannot be isolated by using different hosts.
async fn employ_ladder(
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
///
/// Exactly the shape Buzz Desktop writes: a `role_id` and no `tier`, because
/// no product code path has ever written a `tier`. Owner-signed, because
/// `interrupt_gate::agent_tier` only trusts a head whose author currently
/// holds the community's `owner` role -- a self-signed one confers nothing.
async fn publish_role_head(
    owner_ws: &mut BuzzTestClient,
    owner: &Keys,
    agent: &Keys,
    role_id: &str,
) {
    let event = EventBuilder::new(
        Kind::Custom(KIND_MANAGED_AGENT as u16),
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

fn company_profile(id: &str, stamp: i64) -> CompanyProfile {
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
        created_at: stamp,
        updated_at: stamp,
    }
}

fn proposed_initiative(
    company_id: &str,
    id: &str,
    owner_persona_id: &str,
    stamp: i64,
) -> Initiative {
    Initiative {
        schema: INITIATIVE_SCHEMA.to_string(),
        id: id.to_string(),
        company_id: company_id.to_string(),
        title: "Tennant premium site".to_string(),
        summary: "Ship the premium build.".to_string(),
        status: InitiativeStatus::Proposed,
        owner_persona_id: owner_persona_id.to_string(),
        cost_centre_id: "cc-coordination".to_string(),
        commercial_purpose: CommercialPurpose::ClientDelivery,
        client_organization_id: None,
        expected_cost_usd: None,
        source_channel_id: "welcome".to_string(),
        source_event_id: None,
        created_at: stamp,
        updated_at: stamp,
    }
}

/// A Task with no initiative -- the shape Colony creates for any instruction
/// that arrives in chat (`buzz_sdk::implicit_task`), and the majority of
/// agent work.
fn chat_task(company_id: &str, id: &str, team: &CompanyTeamRef, stamp: i64) -> CompanyTask {
    CompanyTask {
        schema: TASK_SCHEMA.to_string(),
        id: id.to_string(),
        company_id: company_id.to_string(),
        initiative_id: None,
        title: "Take a look at the failing deploy".to_string(),
        status: TaskStatus::InProgress,
        owning_team_id: team.id.clone(),
        assignee_persona_ids: vec![team.lead_persona_id.clone()],
        qa_persona_id: team.lead_persona_id.clone(),
        cost_centre_id: "cc-coordination".to_string(),
        commercial_purpose: CommercialPurpose::Administration,
        client_organization_id: None,
        source_channel_id: "engineering".to_string(),
        source_event_id: None,
        implicit: true,
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
        Kind::Custom(KIND_TEAM as u16),
        serde_json::to_string(&content).expect("team json"),
    )
    .tags(vec![Tag::parse(["d", team.id.as_str()]).expect("d tag")])
    .sign_with_keys(keys)
    .expect("team signs");
    client.send_event(event).await.expect("relay accepts team");
}

/// One community with an owner, one company, one team.
struct Workspace {
    owner: Keys,
    relay: String,
    company: CompanyProfile,
    team: CompanyTeamRef,
}

async fn workspace(client: &mut BuzzTestClient, owner: Keys) -> Workspace {
    let relay = relay_self().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let company_id = format!("co{}", &suffix[..12]);
    let team = CompanyTeamRef {
        id: format!("team-{}", &suffix[..12]),
        lead_persona_id: format!("lead-{}", &suffix[..12]),
        persona_ids: vec![format!("lead-{}", &suffix[..12])],
    };
    publish_team(client, &owner, &team).await;

    let company = company_profile(&company_id, now());
    let outcome = broker(
        client,
        &owner,
        &relay,
        &action(
            &relay,
            CompanyActionOperation::Create,
            CompanyActionPayload::Company(company.clone()),
            coordinate(KIND_COMPANY_PROFILE, &relay, &company_id),
        ),
    )
    .await;
    assert_eq!(
        outcome,
        CompanyReceiptOutcome::Applied,
        "the workspace's company must be created before any work can hang off it"
    );

    Workspace {
        owner,
        relay,
        company,
        team,
    }
}

/// Walk a proposed initiative to active and take the Task its activation
/// produces -- the exact ladder `desktop/src/features/company/startInitiative.ts`
/// drives, decided by the same `buzz_sdk` step function.
///
/// Returns `(initiative_id, task_id)`, both relay-authored records.
async fn start_initiative(client: &mut BuzzTestClient, ws: &Workspace) -> (String, String) {
    let initiative_id = format!("{}:tennant-premium", ws.company.id);
    let proposed = proposed_initiative(
        &ws.company.id,
        &initiative_id,
        &ws.team.lead_persona_id,
        now(),
    );
    let outcome = broker(
        client,
        &ws.owner,
        &ws.relay,
        &action(
            &ws.relay,
            CompanyActionOperation::Create,
            CompanyActionPayload::Initiative(proposed),
            coordinate(KIND_INITIATIVE, &ws.relay, &initiative_id),
        ),
    )
    .await;
    assert_eq!(outcome, CompanyReceiptOutcome::Applied);

    let teams = [ws.team.clone()];
    let mut task_id = None;
    for _ in 0..4 {
        let current = head(client, &ws.relay, KIND_INITIATIVE, &initiative_id)
            .await
            .expect("initiative head");
        let record =
            buzz_sdk::company::parse_initiative_event(&current).expect("initiative parses");
        let step = next_step(
            &record,
            &current.id.to_hex(),
            &ws.company,
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
    let stored = head(client, &ws.relay, KIND_TASK, &task_id)
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
async fn create_chat_task(client: &mut BuzzTestClient, ws: &Workspace) -> String {
    let task_id = format!("{}:chat:{}", ws.company.id, Uuid::new_v4().simple());
    let record = chat_task(&ws.company.id, &task_id, &ws.team, now());
    assert_eq!(
        broker(
            client,
            &ws.owner,
            &ws.relay,
            &action(
                &ws.relay,
                CompanyActionOperation::Create,
                CompanyActionPayload::Task(record),
                coordinate(KIND_TASK, &ws.relay, &task_id),
            ),
        )
        .await,
        CompanyReceiptOutcome::Applied
    );

    let stored = head(client, &ws.relay, KIND_TASK, &task_id)
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
async fn raise(
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
async fn raise_with_window(
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
///
/// Resolution content follows `buzz-cli`'s builder exactly: the decision and
/// rationale live under the `answer` key, and the single `e` tag names the
/// ask event being closed.
async fn answer_ask(
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
    let resolution = EventBuilder::new(Kind::Custom(KIND_ASK_RESOLUTION as u16), content)
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
async fn asks_addressed_to(owner: &Keys) -> Vec<serde_json::Value> {
    query(
        owner,
        serde_json::json!({ "kinds": [KIND_ASK], "#p": [owner.public_key().to_hex()] }),
    )
    .await
}

/// The Needs-Me surface's second query, verbatim: which of them are closed.
async fn closures_naming(owner: &Keys, ask_ids: &[String]) -> Vec<serde_json::Value> {
    query(
        owner,
        serde_json::json!({
            "kinds": [KIND_ASK_RESOLUTION, KIND_ASK_WITHDRAWAL],
            "#e": ask_ids,
        }),
    )
    .await
}

/// Wait until the deadline sweep promotes an unanswered ask to `audience`.
///
/// The positive control in the absorption gate uses this to prove that the
/// relay sweep is live in the current run; an absence assertion for the
/// answered ask is meaningful only after this observed successor exists.
async fn wait_for_successor(audience: &Keys, prior: &str) -> Vec<serde_json::Value> {
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

/// The absorption gate: the worker's ask is addressed to its leader, the
/// leader answers it, and the deadline sweep creates no successor ask for the
/// executive or owner.
///
/// This drives the relay protocol directly (publish/query), not the ACP
/// harness. It proves that an answered ask is not promoted by the deadline
/// sweep, so it never reaches the founder; ACP prompt delivery itself is
/// covered only by the unit tests in `buzz-acp`.
///
/// Run this gate against a fresh database with exactly one owner in the
/// community: the suite seeds a new owner per test into its one host-bound
/// community, so a persistent volume accumulates owners and disables the
/// sweep's never-guessing human hop.
#[tokio::test]
#[ignore = "requires a running relay and Postgres"]
async fn a_leader_answers_a_workers_ask_and_the_owner_never_sees_it() {
    let community_id = ensure_test_community(&relay_host()).await;

    let owner = Keys::generate();
    seed_relay_owner(community_id, &owner).await;

    let mut owner_ws = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("owner connect");
    let ws = workspace(&mut owner_ws, owner.clone()).await;
    let task_id = create_chat_task(&mut owner_ws, &ws).await;

    let worker = Keys::generate();
    let leader = Keys::generate();
    let executive = Keys::generate();
    let (worker_role, leader_role, executive_role) =
        employ_ladder(community_id, &owner, &worker, &leader, &executive).await;
    publish_role_head(&mut owner_ws, &owner, &worker, &worker_role).await;
    publish_role_head(&mut owner_ws, &owner, &leader, &leader_role).await;
    publish_role_head(&mut owner_ws, &owner, &executive, &executive_role).await;

    let mut worker_ws = BuzzTestClient::connect(&relay_url(), &worker)
        .await
        .expect("worker connect");
    let mut leader_ws = BuzzTestClient::connect(&relay_url(), &leader)
        .await
        .expect("leader connect");

    let before = asks_addressed_to(&owner).await.len();
    let ask_id = raise_with_window(
        &mut worker_ws,
        &worker,
        &leader.public_key().to_hex(),
        None,
        &task_id,
        &format!("sms-vendor-{}", Uuid::new_v4().simple()),
        "Which vendor should we use for SMS?",
        None,
        Some(1),
    )
    .await;

    // An unanswered sibling is the positive control: it must be promoted by
    // the same sweep that must leave the answered ask alone. Its distinct
    // need key keeps this from exercising the filing dedupe slot instead.
    let control_ask_id = raise_with_window(
        &mut worker_ws,
        &worker,
        &leader.public_key().to_hex(),
        None,
        &task_id,
        &format!("sms-vendor-control-{}", Uuid::new_v4().simple()),
        "Control ask left unanswered for the sweep",
        None,
        Some(1),
    )
    .await;

    let addressed_to_leader = asks_addressed_to(&leader).await;
    assert!(
        addressed_to_leader
            .iter()
            .any(|ask| ask["id"] == serde_json::json!(ask_id))
            && addressed_to_leader
                .iter()
                .any(|ask| ask["id"] == serde_json::json!(control_ask_id)),
        "the leader must be able to see both asks addressed to it"
    );

    answer_ask(
        &mut leader_ws,
        &leader,
        &ask_id,
        "Use Twilio; we already hold the account",
    )
    .await;

    // The control's successor is the positive signal that the deadline sweep
    // actually ran in this test, rather than an absence that passes
    // vacuously when the sweep is dead.
    let control_successors = wait_for_successor(&executive, &control_ask_id).await;
    let successors = asks_addressed_to(&executive)
        .await
        .into_iter()
        .chain(asks_addressed_to(&owner).await)
        .filter(|ask| tag_value(ask, "prior") == ask_id)
        .collect::<Vec<_>>();
    assert!(
        successors.is_empty(),
        "an answered ask must not be promoted to the executive or owner; successors: {successors:#?}; positive control: {control_successors:#?}"
    );

    let closures = closures_naming(&owner, std::slice::from_ref(&ask_id)).await;
    assert_eq!(
        closures.len(),
        1,
        "answering must produce exactly one closure event for the ask"
    );

    let after = asks_addressed_to(&owner).await;
    assert_eq!(
        after.len(),
        before,
        "the owner's Needs-Me surface must be unchanged: an ask a leader \
         answered must never appear in front of the founder. Got {} asks, \
         expected {before}",
        after.len()
    );

    owner_ws.disconnect().await.ok();
    worker_ws.disconnect().await.ok();
    leader_ws.disconnect().await.ok();
}

/// The whole point: an employed worker, blocked on real work, files an ask
/// that ends up in front of the human owner and is readable by exactly the
/// query the owner's surface runs.
///
/// Every input is a record the relay authored. Before this suite, none of
/// them could be: local dev held zero initiatives and zero tasks, so the two
/// tags `parse_ask` requires had nothing to point at, and the relay-members
/// table held zero owners, so the top of the ladder did not exist.
#[tokio::test]
#[ignore = "requires a running relay and Postgres"]
async fn an_employed_worker_raises_an_ask_that_reaches_the_owner() {
    let community_id = ensure_test_community(&relay_host()).await;

    let owner = Keys::generate();
    seed_relay_owner(community_id, &owner).await;

    let mut owner_ws = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("owner connect");
    let ws = workspace(&mut owner_ws, owner.clone()).await;
    let (initiative_id, task_id) = start_initiative(&mut owner_ws, &ws).await;

    let worker = Keys::generate();
    let leader = Keys::generate();
    let executive = Keys::generate();
    employ_ladder(community_id, &owner, &worker, &leader, &executive).await;

    let mut worker_ws = BuzzTestClient::connect(&relay_url(), &worker)
        .await
        .expect("worker connect");
    let mut leader_ws = BuzzTestClient::connect(&relay_url(), &leader)
        .await
        .expect("leader connect");
    let mut executive_ws = BuzzTestClient::connect(&relay_url(), &executive)
        .await
        .expect("executive connect");

    let need = format!("batch-size-{}", Uuid::new_v4().simple());

    // Worker -> leader. This is the hop the product asks every blocked agent
    // to make, against work that exists.
    let raised = raise(
        &mut worker_ws,
        &worker,
        &leader.public_key().to_hex(),
        Some(&initiative_id),
        &task_id,
        &need,
        "Choose the outreach batch size",
        None,
    )
    .await;

    // Leader -> executive -> owner. Each hop supersedes the last, so each
    // needs its own `need` slug: the previous one's dedupe slot is released
    // by the relay's own supersede withdrawal, and reusing it would make a
    // pass here indistinguishable from deduping onto a stale row.
    let escalated = raise(
        &mut leader_ws,
        &leader,
        &executive.public_key().to_hex(),
        Some(&initiative_id),
        &task_id,
        &format!("{need}-esc"),
        "Leader cannot unblock: choose the outreach batch size",
        Some(&raised),
    )
    .await;
    let filed = raise(
        &mut executive_ws,
        &executive,
        &owner.public_key().to_hex(),
        Some(&initiative_id),
        &task_id,
        &format!("{need}-filed"),
        "Your call: choose the outreach batch size",
        Some(&escalated),
    )
    .await;

    // ---- The owner's own surface, through the documented queries ---------
    let mine = asks_addressed_to(&owner).await;
    let found = mine
        .iter()
        .find(|event| event["id"].as_str() == Some(filed.as_str()))
        .unwrap_or_else(|| {
            panic!("the ask filed to the owner must come back from {{kinds:[44300], #p:[owner]}}")
        });

    assert_eq!(
        tag_value(found, "initiative"),
        initiative_id,
        "the ask must carry the real initiative, which is how the surface groups it"
    );
    assert_eq!(
        tag_value(found, "task"),
        task_id,
        "the ask must carry the real task, which is what is blocked"
    );
    assert_eq!(
        tag_value(found, "prior"),
        escalated,
        "the chain the owner is looking at must be walkable back to the worker"
    );

    // Open/closed, computed exactly as `buzz asks list --status open` does:
    // from the public event stream, since the `asks` projection has no HTTP
    // read surface.
    let closed = closures_naming(&owner, std::slice::from_ref(&filed)).await;
    assert!(
        closed.is_empty(),
        "an ask nobody has answered must read as open, got {closed:#?}"
    );

    // And the hop below it really was superseded, so the owner's surface is
    // not showing three live copies of one need.
    let earlier = closures_naming(&owner, &[raised.clone(), escalated.clone()]).await;
    assert_eq!(
        earlier.len(),
        2,
        "each superseded hop must be closed by its own withdrawal, got {earlier:#?}"
    );

    owner_ws.disconnect().await.ok();
    worker_ws.disconnect().await.ok();
    leader_ws.disconnect().await.ok();
    executive_ws.disconnect().await.ok();
}

/// The ordinary case: the work has no initiative.
///
/// Colony creates a Task for every instruction that arrives in chat and none
/// of them belong to an initiative, so this is the majority of agent work,
/// not an edge. `parse_ask` requires exactly one `initiative` tag and the
/// relay's `asks` projection column is `NOT NULL`, so an agent here had
/// nothing valid to name and could file no ask at all -- the only paths left
/// were to invent an identifier or to interrupt a human directly.
#[tokio::test]
#[ignore = "requires a running relay and Postgres"]
async fn an_ask_about_chat_derived_work_with_no_initiative_still_reaches_the_owner() {
    let community_id = ensure_test_community(&relay_host()).await;

    let owner = Keys::generate();
    seed_relay_owner(community_id, &owner).await;

    let mut owner_ws = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("owner connect");
    let ws = workspace(&mut owner_ws, owner.clone()).await;
    let task_id = create_chat_task(&mut owner_ws, &ws).await;

    let worker = Keys::generate();
    let leader = Keys::generate();
    let executive = Keys::generate();
    employ_ladder(community_id, &owner, &worker, &leader, &executive).await;

    let mut worker_ws = BuzzTestClient::connect(&relay_url(), &worker)
        .await
        .expect("worker connect");
    let mut leader_ws = BuzzTestClient::connect(&relay_url(), &leader)
        .await
        .expect("leader connect");
    let mut executive_ws = BuzzTestClient::connect(&relay_url(), &executive)
        .await
        .expect("executive connect");

    let need = format!("dns-txt-{}", Uuid::new_v4().simple());

    let raised = raise(
        &mut worker_ws,
        &worker,
        &leader.public_key().to_hex(),
        None,
        &task_id,
        &need,
        "DNS needs a TXT record only a human can add",
        None,
    )
    .await;
    let escalated = raise(
        &mut leader_ws,
        &leader,
        &executive.public_key().to_hex(),
        None,
        &task_id,
        &format!("{need}-esc"),
        "Leader cannot add the DNS record either",
        Some(&raised),
    )
    .await;
    let filed = raise(
        &mut executive_ws,
        &executive,
        &owner.public_key().to_hex(),
        None,
        &task_id,
        &format!("{need}-filed"),
        "Only you can add the DNS TXT record",
        Some(&escalated),
    )
    .await;

    let mine = asks_addressed_to(&owner).await;
    let found = mine
        .iter()
        .find(|event| event["id"].as_str() == Some(filed.as_str()))
        .expect("an ask about initiative-less work must reach the owner like any other");

    assert_eq!(
        tag_value(found, "initiative"),
        NO_INITIATIVE,
        "it must group under the reserved value the relay's own stall sweep uses"
    );
    assert_eq!(
        tag_value(found, "task"),
        task_id,
        "the ask must name the real chat-derived task it is blocked on"
    );

    let closed = closures_naming(&owner, std::slice::from_ref(&filed)).await;
    assert!(
        closed.is_empty(),
        "an unanswered ask must read as open, got {closed:#?}"
    );

    owner_ws.disconnect().await.ok();
    worker_ws.disconnect().await.ok();
    leader_ws.disconnect().await.ok();
    executive_ws.disconnect().await.ok();
}

/// The shape that actually runs: agents with no `employees` row at all.
///
/// Every other case here, and every case in `e2e_interrupts.rs`, gives the
/// filer an `employees` row. No agent Buzz Desktop launches has one: it
/// generates the key locally (`record.private_key_nsec`) and never sends a
/// hire request, so the by-pubkey rank lookup never fires for a real agent.
/// What it does have is an owner-authored head naming the workspace role it
/// fills, and that role is employed. This is the first proof that the kind of
/// agent the product actually spawns can raise an ask at all.
///
/// The employees rows here are the *roles*, filled by relay-held identities
/// nobody signs with. The pubkeys that sign are the agents.
#[tokio::test]
#[ignore = "requires a running relay and Postgres"]
async fn a_managed_agent_that_is_not_an_employee_raises_an_ask_to_the_owner() {
    let community_id = ensure_test_community(&relay_host()).await;

    let owner = Keys::generate();
    seed_relay_owner(community_id, &owner).await;

    let mut owner_ws = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("owner connect");
    let ws = workspace(&mut owner_ws, owner.clone()).await;
    let task_id = create_chat_task(&mut owner_ws, &ws).await;

    // The payroll: three roles at three ranks. Unique per run because
    // `employees` is uniquely indexed on `(community, role_id)` among active
    // rows and every case here shares the relay's own community.
    let run = Uuid::new_v4().simple().to_string();
    let run = &run[..8];
    let engineer_role = format!("frontend-engineer-{run}");
    let lead_role = format!("cto-{run}");
    let chief_role = format!("chief-of-staff-{run}");
    for (role, rank) in [
        (&engineer_role, "worker"),
        (&lead_role, "leader"),
        (&chief_role, "executive"),
    ] {
        employ(community_id, &owner, &Keys::generate(), role, rank).await;
    }

    // The processes: their own keys, no employees rows, owner-authored heads
    // naming the roles they fill.
    let worker_agent = Keys::generate();
    let leader_agent = Keys::generate();
    let executive_agent = Keys::generate();
    publish_role_head(&mut owner_ws, &owner, &worker_agent, &engineer_role).await;
    publish_role_head(&mut owner_ws, &owner, &leader_agent, &lead_role).await;
    publish_role_head(&mut owner_ws, &owner, &executive_agent, &chief_role).await;

    let mut worker_ws = BuzzTestClient::connect(&relay_url(), &worker_agent)
        .await
        .expect("worker connect");
    let mut leader_ws = BuzzTestClient::connect(&relay_url(), &leader_agent)
        .await
        .expect("leader connect");
    let mut executive_ws = BuzzTestClient::connect(&relay_url(), &executive_agent)
        .await
        .expect("executive connect");

    let need = format!("vendor-key-{run}");

    let raised = raise(
        &mut worker_ws,
        &worker_agent,
        &leader_agent.public_key().to_hex(),
        None,
        &task_id,
        &need,
        "Need the vendor API key",
        None,
    )
    .await;
    let escalated = raise(
        &mut leader_ws,
        &leader_agent,
        &executive_agent.public_key().to_hex(),
        None,
        &task_id,
        &format!("{need}-esc"),
        "Lead cannot provision the vendor API key",
        Some(&raised),
    )
    .await;
    let filed = raise(
        &mut executive_ws,
        &executive_agent,
        &owner.public_key().to_hex(),
        None,
        &task_id,
        &format!("{need}-filed"),
        "Only you can provision the vendor API key",
        Some(&escalated),
    )
    .await;

    let mine = asks_addressed_to(&owner).await;
    let found = mine
        .iter()
        .find(|event| event["id"].as_str() == Some(filed.as_str()))
        .expect("an ask raised by the agents the product actually runs must reach the owner");
    assert_eq!(tag_value(found, "task"), task_id);
    assert_eq!(tag_value(found, "prior"), escalated);

    // And the wall still holds for the same identities: a worker whose rank
    // comes from its role is as restricted as one whose rank comes from its
    // own employment. Granting rank through a role must not be a way around
    // the gate it exists to feed.
    let direct = EventBuilder::new(
        Kind::Custom(buzz_core::kind::KIND_STREAM_MESSAGE as u16),
        "hey owner, got a sec?",
    )
    .tags(vec![
        Tag::parse(["h", &Uuid::new_v4().to_string()]).expect("h tag"),
        Tag::parse(["p", &owner.public_key().to_hex()]).expect("p tag"),
    ])
    .sign_with_keys(&worker_agent)
    .expect("sign direct message");
    let wall = worker_ws
        .send_event(direct)
        .await
        .expect("the relay answers the probe");
    assert!(
        !wall.accepted,
        "a worker-ranked managed agent must not address the owner directly"
    );
    assert!(
        wall.message.contains("cannot address an owner"),
        "unexpected wall-probe rejection: {}",
        wall.message
    );

    owner_ws.disconnect().await.ok();
    worker_ws.disconnect().await.ok();
    leader_ws.disconnect().await.ok();
    executive_ws.disconnect().await.ok();
}
