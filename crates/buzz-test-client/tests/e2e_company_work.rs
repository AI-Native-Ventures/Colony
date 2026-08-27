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
    CommercialPurpose, CompanyProfile, CompanyService, CompanyTask, CompanyTeamRef, CostCentre,
    CostCentreKind, DoerKind, Initiative, InitiativeStatus, TaskStatus, COMMUNITY_PROFILE_ID,
    COMPANY_SCHEMA, INITIATIVE_SCHEMA,
};
use buzz_core::job::{TaskArtifact, TaskArtifactKind, TaskCheckpoint};
use buzz_core::kind::{
    KIND_COMPANY_ACTION, KIND_COMPANY_PROFILE, KIND_COMPANY_RECEIPT, KIND_EMPLOYEE,
    KIND_HIRE_REQUEST, KIND_INITIATIVE, KIND_JOB_CHECKPOINT, KIND_JOB_CLAIM, KIND_JOB_FILING,
    KIND_JOB_HEAD, KIND_JOB_OUTCOME, KIND_STREAM_MESSAGE_V2, KIND_TASK, KIND_TEAM,
};
use buzz_sdk::company::{
    build_company_action, parse_company_receipt, parse_task_event, CompanyAction,
    CompanyActionOperation, CompanyActionPayload, CompanyReceiptOutcome,
};
use buzz_sdk::implicit_task::plan_implicit_task;
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

fn company(now: i64) -> CompanyProfile {
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
            id: "cc-coordination".to_string(),
            name: "Company coordination".to_string(),
            kind: CostCentreKind::Internal,
            service_id: None,
        }],
        source_report_event_id: None,
        created_at: now,
        updated_at: now,
    }
}

fn initiative(id: &str, owner_persona_id: &str, now: i64) -> Initiative {
    Initiative {
        schema: INITIATIVE_SCHEMA.to_string(),
        id: id.to_string(),
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
        template_id: None,
        template_version: None,
        cohort_id: None,
        created_at: now,
        updated_at: now,
    }
}

fn task(id: &str, team: &CompanyTeamRef, now: i64) -> CompanyTask {
    CompanyTask {
        schema: TASK_SCHEMA.to_string(),
        id: id.to_string(),
        initiative_id: None,
        title: "Draft the first prospect list".to_string(),
        status: TaskStatus::Ready,
        owning_team_id: team.id.clone(),
        assignee_persona_ids: vec![team.lead_persona_id.clone()],
        qa_persona_id: team.lead_persona_id.clone(),
        reviewer_team_id: None,
        cost_centre_id: "cc-coordination".to_string(),
        commercial_purpose: CommercialPurpose::Administration,
        client_organization_id: None,
        source_channel_id: "welcome".to_string(),
        source_event_id: None,
        implicit: false,
        depends_on: Vec::new(),
        subject: None,
        stage: None,
        thread_root: None,
        doer_kind: DoerKind::Agent,
        wake_at: None,
        outcome_reason: None,
        bounce_reason: None,
        bounce_count: 0,
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

/// Prefix the relay uses when an action lost an idempotency claim to an
/// earlier signed action (`ingest::broker_duplicate_result`).
const SUPERSEDED_PREFIX: &str = "conflict: superseded by original action ";

/// Read the winning action's id out of a supersede answer, if that is what
/// this answer is.
///
/// Two signings of the same `CompanyAction` differ only in `created_at`, which
/// nostr stamps at second granularity. Inside one second they produce the same
/// event id and the relay answers `accepted=true` against a receipt that
/// already exists. Across a second boundary they produce two ids, the claim is
/// already held, and the relay supersedes the second one — deliberately, per
/// `company_broker::replay_claim`. Only the winner has a receipt, so the loser's
/// id is a dead end to poll and the caller must follow the winner named here.
fn superseding_action_id(ok: &buzz_ws_client::OkResponse) -> Option<String> {
    if ok.accepted {
        return None;
    }
    let id = ok.message.strip_prefix(SUPERSEDED_PREFIX)?.trim();
    (id.len() == 64 && id.chars().all(|c| c.is_ascii_hexdigit())).then(|| id.to_owned())
}

#[test]
fn superseding_action_id_follows_the_winner_named_by_the_relay() {
    let winner = "a".repeat(64);
    let superseded = buzz_ws_client::OkResponse {
        event_id: "b".repeat(64),
        accepted: false,
        message: format!("{SUPERSEDED_PREFIX}{winner}"),
    };
    assert_eq!(superseding_action_id(&superseded), Some(winner));
}

/// The prefix is asserted against a message copied verbatim off the wire, not
/// against itself: `SUPERSEDED_PREFIX` is a guess about relay wording, and a
/// guess that drifts silently stops matching and restores the original flake.
/// This is the run that first exposed it (Relay E2E, PR #472).
#[test]
fn superseding_action_id_reads_the_message_the_relay_actually_sent() {
    let observed = "conflict: superseded by original action \
                    7d8f661f1e48fecd0cb6439cf97bb63e0489a58fbd05df91e2518c04f267816a";
    let ok = buzz_ws_client::OkResponse {
        event_id: "e1bb24caae7e6350381a978addfe504028aaf53420f52017c58a275e7078f694".to_owned(),
        accepted: false,
        message: observed.to_owned(),
    };
    assert_eq!(
        superseding_action_id(&ok).as_deref(),
        Some("7d8f661f1e48fecd0cb6439cf97bb63e0489a58fbd05df91e2518c04f267816a")
    );
}

#[test]
fn superseding_action_id_ignores_every_other_answer() {
    let cases = [
        (true, String::new()),
        (true, "identical action already applied".to_owned()),
        (false, "conflict: that record already exists".to_owned()),
        (
            false,
            "conflict: the record changed since this request was prepared".to_owned(),
        ),
        // A malformed id must not be polled as if it were real.
        (false, format!("{SUPERSEDED_PREFIX}not-hex")),
    ];
    for (accepted, message) in cases {
        let ok = buzz_ws_client::OkResponse {
            event_id: "b".repeat(64),
            accepted,
            message: message.clone(),
        };
        assert_eq!(
            superseding_action_id(&ok),
            None,
            "accepted={accepted} message={message:?} must not be read as a supersede"
        );
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

    // A superseded action has no receipt of its own — the claim it lost is
    // answered by the winner's receipt, which is the outcome this helper is
    // asked for. Follow the winner rather than polling an id the relay will
    // never author against.
    let receipt_action_id = match superseding_action_id(&ok) {
        Some(winner) => {
            eprintln!(
                "action {} was superseded by {}; reading that receipt instead",
                &action_id[..12],
                &winner[..12]
            );
            winner
        }
        None => action_id,
    };

    // The receipt is authored by the relay after it processes the action, so
    // this polls rather than assuming it is already stored.
    for attempt in 0..40 {
        let id = sub_id("receipt");
        let filter = Filter::new()
            .kind(Kind::Custom(KIND_COMPANY_RECEIPT as u16))
            .author(nostr::PublicKey::from_hex(relay).expect("relay key"))
            .event(nostr::EventId::from_hex(&receipt_action_id).expect("action id"))
            .limit(1);
        client
            .subscribe(&id, vec![filter])
            .await
            .expect("subscribe");
        // A single silent window (no EOSE inside the timeout) is a transport
        // hiccup, not an answer: the loop below exists to poll, so a timed
        //-out window is retried like an empty one instead of failing the
        // whole suite. The final panic stays strict — 40 windows with no
        // receipt at all IS an answer, a wrong one.
        let events = match client.collect_until_eose(&id, Duration::from_secs(5)).await {
            Ok(events) => events,
            Err(error) => {
                eprintln!(
                    "receipt poll {attempt} for {receipt_action_id} errored, retrying: {error}"
                );
                let _ = client.close_subscription(&id).await;
                tokio::time::sleep(Duration::from_millis(250)).await;
                continue;
            }
        };
        let _ = client.close_subscription(&id).await;
        if let Some(event) = events.first() {
            let receipt = parse_company_receipt(event).expect("receipt parses");
            assert_eq!(
                receipt.action_event_id, receipt_action_id,
                "a receipt must name the action it answers"
            );
            return (receipt.outcome, receipt.head_event_id);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("the relay never answered a legitimate owner action");
}

/// Read one relay-authored head by coordinate.
///
/// A single silent window (`collect_until_eose` errors before EOSE) is the
/// same relay-side transport stall `broker`'s receipt poll retries past, not
/// an absent record — every occurrence observed so far had already ingested
/// its write with `accepted=true` before the read connection went quiet. An
/// `Ok` result, even empty, is a real answer: "no head yet" is a legitimate
/// outcome for a caller checking one does not exist, and returns immediately
/// without retrying. Only a transport ERROR is retried; the final panic
/// stays strict.
async fn head(
    client: &mut BuzzTestClient,
    relay: &str,
    kind: u32,
    d_tag: &str,
) -> Option<nostr::Event> {
    for attempt in 0..10 {
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
        match client.collect_until_eose(&id, Duration::from_secs(5)).await {
            Ok(events) => {
                let _ = client.close_subscription(&id).await;
                return events.into_iter().next();
            }
            Err(error) => {
                eprintln!("head poll {attempt} for {d_tag} errored, retrying: {error}");
                let _ = client.close_subscription(&id).await;
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
    }
    panic!("the relay never answered a head read for {d_tag}");
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
    Timestamp::now().as_secs() as i64
}

async fn e2e_db_pool() -> sqlx::Pool<sqlx::Postgres> {
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://buzz:buzz_dev@localhost:5432/buzz".to_string());
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .expect("connect to e2e Postgres")
}

/// The company broker requires the acting key to be a human community
/// owner: a relay_members row with role 'owner' plus a users row without an
/// agent_owner_pubkey. Owner assignment has no Nostr-event form in this
/// codebase, so this is a DB fixture on the same pattern as
/// `e2e_interrupts::seed_relay_owner`, not a protocol step under test.
async fn seed_company_owner(keys: &Keys) {
    let pool = e2e_db_pool().await;
    let host = relay_url().replace("wss://", "").replace("ws://", "");
    let community_id: Uuid =
        sqlx::query_scalar("SELECT id FROM communities WHERE lower(host) = lower($1)")
            .bind(&host)
            .fetch_optional(&pool)
            .await
            .expect("query the deployment community")
            .unwrap_or_else(|| {
                panic!("community for host {host} must exist; start-relay-for-tests.sh seeds it")
            });

    // users.pubkey is BYTEA; relay_members.pubkey is TEXT hex.
    sqlx::query("INSERT INTO users (community_id, pubkey) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(community_id)
        .bind(keys.public_key().to_bytes())
        .execute(&pool)
        .await
        .expect("seed the owner as a user");
    sqlx::query(
        "INSERT INTO relay_members (community_id, pubkey, role, added_by) \
         VALUES ($1, $2, 'owner', NULL) \
         ON CONFLICT (community_id, pubkey) DO UPDATE SET role = 'owner'",
    )
    .bind(community_id)
    .bind(keys.public_key().to_hex())
    .execute(&pool)
    .await
    .expect("seed the owner member role");
}

/// Provision a real channel the owner may post into, via the same signed
/// kind:9007 event `e2e_relay::create_test_channel` uses.
///
/// Nothing in the CI relay seed (start-relay-for-tests.sh) creates channels
/// or grants membership: it seeds only the deployment community row and
/// bootstraps the configured owner. A test that needs a channel must create
/// one, or it only ever passes against an environment that happens to have a
/// channel pre-seeded — which is exactly how this suite rotted unnoticed.
async fn create_task_channel(keys: &Keys) -> String {
    let client = reqwest::Client::new();
    let pubkey_hex = keys.public_key().to_hex();
    let channel_uuid = Uuid::new_v4();

    let event = EventBuilder::new(Kind::Custom(9007), "")
        .tags(vec![
            Tag::parse(["h", channel_uuid.to_string().as_str()]).expect("h tag"),
            Tag::parse(["name", format!("company-e2e-{}", channel_uuid).as_str()])
                .expect("name tag"),
            Tag::parse(["channel_type", "stream"]).expect("type tag"),
            Tag::parse(["visibility", "open"]).expect("visibility tag"),
        ])
        .sign_with_keys(keys)
        .expect("create-channel event signs");

    let response = client
        .post(format!("{}/events", http_url()))
        .header("X-Pubkey", pubkey_hex)
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(&event).expect("event serializes"))
        .send()
        .await
        .expect("submit create-channel event");
    assert!(
        response.status().is_success(),
        "channel creation event failed: {}",
        response.status()
    );
    let body: serde_json::Value = response.json().await.expect("event response is JSON");
    assert!(
        body["accepted"].as_bool().unwrap_or(false),
        "channel creation not accepted: {body}"
    );

    channel_uuid.to_string()
}

async fn hire_employee(client: &mut BuzzTestClient, owner: &Keys) -> String {
    let role = format!("task-runner-{}", Uuid::new_v4().simple());
    let request = EventBuilder::new(Kind::Custom(KIND_HIRE_REQUEST as u16), "")
        .tags(vec![
            Tag::parse(["role", role.as_str()]).expect("role tag"),
            Tag::parse(["name", "Durable task runner"]).expect("name tag"),
            Tag::parse(["rank", "worker"]).expect("rank tag"),
        ])
        .sign_with_keys(owner)
        .expect("hire request signs");
    let request_id = request.id;
    let accepted = client
        .send_event(request)
        .await
        .expect("hire request response");
    assert!(
        accepted.accepted,
        "hire request rejected: {:?}",
        accepted.message
    );

    // This loop already existed to wait for the employee to be created; the
    // `.expect("collect")` it used to carry defeated that purpose against a
    // transport error, since a panic never lets a `for` loop retry. A
    // silent window is retried like an empty one, same as `broker`'s
    // receipt poll; the final panic stays strict.
    for attempt in 0..40 {
        let id = sub_id("employee");
        let filter = Filter::new()
            .kind(Kind::Custom(KIND_EMPLOYEE as u16))
            .event(request_id)
            .limit(1);
        client
            .subscribe(&id, vec![filter])
            .await
            .expect("subscribe");
        let events = match client.collect_until_eose(&id, Duration::from_secs(5)).await {
            Ok(events) => events,
            Err(error) => {
                eprintln!("employee poll {attempt} for {request_id} errored, retrying: {error}");
                let _ = client.close_subscription(&id).await;
                tokio::time::sleep(Duration::from_millis(250)).await;
                continue;
            }
        };
        let _ = client.close_subscription(&id).await;
        if let Some(event) = events.first() {
            return event.pubkey.to_hex();
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("employee was not created for hire request {request_id}");
}

fn job_event(keys: &Keys, kind: u32, content: &str, tags: Vec<Vec<String>>) -> nostr::Event {
    let tags = tags
        .into_iter()
        .map(Tag::parse)
        .collect::<Result<Vec<_>, _>>()
        .expect("job tags parse");
    EventBuilder::new(Kind::Custom(kind as u16), content)
        .tags(tags)
        .sign_with_keys(keys)
        .expect("job event signs")
}

/// Read the current job head, retrying past a silent transport window the
/// same way `head` does — see its doc comment. `await_job_head`'s own retry
/// loop depends on this NOT panicking on a transient error, since a panic
/// here would kill that outer loop on the first hiccup rather than let it
/// retry.
async fn current_job_head(client: &mut BuzzTestClient, job_id: &str) -> Option<nostr::Event> {
    for attempt in 0..10 {
        let id = sub_id("job-head");
        let filter = Filter::new()
            .kind(Kind::Custom(KIND_JOB_HEAD as u16))
            .identifier(job_id)
            .limit(1);
        client
            .subscribe(&id, vec![filter])
            .await
            .expect("subscribe");
        match client.collect_until_eose(&id, Duration::from_secs(5)).await {
            Ok(events) => {
                let _ = client.close_subscription(&id).await;
                return events.into_iter().next();
            }
            Err(error) => {
                eprintln!("job head poll {attempt} for {job_id} errored, retrying: {error}");
                let _ = client.close_subscription(&id).await;
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
    }
    panic!("the relay never answered a job head read for {job_id}");
}

async fn await_job_head(
    client: &mut BuzzTestClient,
    job_id: &str,
    description: &str,
    predicate: impl Fn(&nostr::Event) -> bool,
) -> nostr::Event {
    let mut last = None;
    for _ in 0..40 {
        if let Some(event) = current_job_head(client, job_id).await {
            if predicate(&event) {
                return event;
            }
            last = Some(event);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("job {job_id} never became {description}; last head: {last:?}");
}

fn event_tag(event: &nostr::Event, key: &str) -> String {
    event
        .tags
        .iter()
        .find_map(|tag| {
            let values = tag.as_slice();
            (values.first().map(String::as_str) == Some(key))
                .then(|| values.get(1).cloned())
                .flatten()
        })
        .unwrap_or_default()
}

async fn expire_job_lease(job_id: &str) {
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://buzz:buzz_dev@localhost:5432/buzz".to_string());
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .expect("connect to relay Postgres");
    let result = sqlx::query("UPDATE jobs SET lease_expires_at = 1 WHERE job_id = $1")
        .bind(hex::decode(job_id).expect("job id hex"))
        .execute(&pool)
        .await
        .expect("expire lease");
    assert_eq!(result.rows_affected(), 1, "exactly one lease expires");
}

/// One owner, one company, one team: the fixture every assertion runs against.
struct Fixture {
    owner: Keys,
    relay: String,
    team: CompanyTeamRef,
    /// Unique per test run. The community profile is a singleton, but
    /// initiatives and tasks are not: two tests sharing an id would collide
    /// on the same coordinate and the second Create would be refused.
    token: String,
}

async fn setup(client: &mut BuzzTestClient, owner: Keys) -> Fixture {
    let relay = relay_self().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let team = CompanyTeamRef {
        id: format!("team-{}", &suffix[..12]),
        lead_persona_id: format!("lead-{}", &suffix[..12]),
        persona_ids: vec![format!("lead-{}", &suffix[..12])],
    };
    publish_team(client, &owner, &team).await;
    Fixture {
        owner,
        relay,
        team,
        token: suffix[..12].to_string(),
    }
}

#[tokio::test]
#[ignore = "requires a running relay with Postgres and BUZZ_EMPLOYEE_KEK"]
async fn an_implicit_chat_task_recovers_from_interruption_before_evidence_gated_delivery() {
    let owner = owner_keys();
    seed_company_owner(&owner).await;
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let fixture = setup(&mut client, owner.clone()).await;
    let stamp = now();

    let profile = company(stamp);
    let create_company = action(
        &fixture.relay,
        CompanyActionOperation::Create,
        CompanyActionPayload::Company(profile.clone()),
        coordinate(KIND_COMPANY_PROFILE, &fixture.relay, COMMUNITY_PROFILE_ID),
        None,
    );
    // Applied the first time this community sees a profile, Conflict after:
    // the profile is a singleton at a fixed coordinate, so a second Create is
    // refused rather than making a second company. Every fixture builds the
    // same profile, so an existing one is equivalent for what follows.
    assert!(matches!(
        broker(&mut client, &fixture.owner, &fixture.relay, &create_company,)
            .await
            .0,
        CompanyReceiptOutcome::Applied | CompanyReceiptOutcome::Conflict
    ));

    // The chat thread lives in a channel this test provisions itself. The
    // old hardcoded UUID only existed in the abandoned isolated harness's
    // seed, so on any other relay the membership refusal fired here instead
    // of the Task-run protocol this scenario proves.
    let channel_id = create_task_channel(&fixture.owner).await;
    let chat_root_event = job_event(
        &fixture.owner,
        KIND_STREAM_MESSAGE_V2,
        "Prepare the interruption-safe investor update",
        vec![vec!["h".to_string(), channel_id.clone()]],
    );
    let chat_root = chat_root_event.id.to_hex();
    assert!(
        client
            .send_event(chat_root_event)
            .await
            .expect("canonical task thread root")
            .accepted,
        "the Task proof needs a real stored canonical thread root"
    );
    let plan = plan_implicit_task(
        &profile,
        std::slice::from_ref(&fixture.team),
        &fixture.team.lead_persona_id,
        &channel_id,
        &chat_root,
        "Prepare the interruption-safe investor update",
        None,
        &fixture.relay,
        stamp + 1,
    )
    .expect("implicit chat task plans");
    assert_eq!(plan.owning_team_id, fixture.team.id);
    let planned_task = match &plan.action.payload {
        CompanyActionPayload::Task(task) => task,
        other => panic!("implicit plan produced {other:?}"),
    };
    assert_eq!(
        planned_task.assignee_persona_ids,
        vec![fixture.team.lead_persona_id.clone()],
        "the implicit Task has one accountable assigned persona"
    );
    let task_id = plan.task_id.clone();
    let create_task = *plan.action;
    let (task_outcome, task_head_id) =
        broker(&mut client, &fixture.owner, &fixture.relay, &create_task).await;
    assert_eq!(task_outcome, CompanyReceiptOutcome::Applied);
    let task_head_id = task_head_id.expect("implicit Task receipt names its head");
    assert_eq!(
        head(&mut client, &fixture.relay, KIND_TASK, &task_id)
            .await
            .expect("implicit Task head exists")
            .id
            .to_hex(),
        task_head_id,
        "the chat-created Task receipt names the canonical head"
    );

    let employee = hire_employee(&mut client, &fixture.owner).await;
    let filing = job_event(
        &fixture.owner,
        KIND_JOB_FILING,
        "Prepare the interruption-safe investor update",
        vec![
            vec!["p".to_string(), employee.clone()],
            vec!["task".to_string(), task_id.clone()],
            vec!["h".to_string(), channel_id.clone()],
            vec!["e".to_string(), chat_root.clone()],
        ],
    );
    let job_id = filing.id.to_hex();
    let filed = client.send_event(filing).await.expect("filing response");
    assert!(
        filed.accepted,
        "Task run filing rejected: {:?}",
        filed.message
    );
    let open = await_job_head(&mut client, &job_id, "queued", |head| {
        event_tag(head, "status") == "open"
    })
    .await;
    assert_eq!(event_tag(&open, "task"), task_id);
    assert_eq!(event_tag(&open, "employee"), employee);

    let claim_one = job_event(
        &fixture.owner,
        KIND_JOB_CLAIM,
        "",
        vec![
            vec!["job".to_string(), job_id.clone()],
            vec!["nonce".to_string(), Uuid::new_v4().to_string()],
        ],
    );
    assert!(
        client
            .send_event(claim_one)
            .await
            .expect("claim one")
            .accepted
    );
    let lease_one = await_job_head(&mut client, &job_id, "executing attempt one", |head| {
        event_tag(head, "status") == "leased" && event_tag(head, "attempts") == "1"
    })
    .await;
    assert_eq!(event_tag(&lease_one, "task"), task_id);

    let checkpoint_body = serde_json::to_string(&TaskCheckpoint {
        summary: "Research complete; resume by drafting".to_string(),
        resume_token: Some("phase:draft".to_string()),
        progress: Some(55),
    })
    .expect("checkpoint JSON");
    let checkpoint_one = job_event(
        &fixture.owner,
        KIND_JOB_CHECKPOINT,
        &checkpoint_body,
        vec![
            vec!["job".to_string(), job_id.clone()],
            vec!["attempt".to_string(), "1".to_string()],
            vec!["sequence".to_string(), "1".to_string()],
        ],
    );
    let checkpoint_one_id = checkpoint_one.id.to_hex();
    assert!(
        client
            .send_event(checkpoint_one)
            .await
            .expect("checkpoint one")
            .accepted
    );
    let checkpointed = await_job_head(&mut client, &job_id, "checkpointed", |head| {
        event_tag(head, "checkpoint-seq") == "1"
    })
    .await;
    assert_eq!(
        event_tag(&checkpointed, "checkpoint-event"),
        checkpoint_one_id
    );

    expire_job_lease(&job_id).await;

    let stale_checkpoint = job_event(
        &fixture.owner,
        KIND_JOB_CHECKPOINT,
        &checkpoint_body,
        vec![
            vec!["job".to_string(), job_id.clone()],
            vec!["attempt".to_string(), "1".to_string()],
            vec!["sequence".to_string(), "2".to_string()],
        ],
    );
    let _ = client
        .send_event(stale_checkpoint)
        .await
        .expect("stale checkpoint response");
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        event_tag(
            &current_job_head(&mut client, &job_id)
                .await
                .expect("head after stale checkpoint"),
            "checkpoint-seq"
        ),
        "1",
        "an expired holder cannot advance recovery state"
    );

    let late_artifact = TaskArtifact {
        kind: TaskArtifactKind::Text,
        reference: "Investor update delivered".to_string(),
        label: Some("Primary investor update".to_string()),
    };
    let expired_delivery = job_event(
        &fixture.owner,
        KIND_JOB_OUTCOME,
        "Late result from the interrupted worker",
        vec![
            vec!["job".to_string(), job_id.clone()],
            vec!["attempt".to_string(), "1".to_string()],
            vec!["status".to_string(), "done".to_string()],
            vec!["task".to_string(), task_id.clone()],
            vec!["artifact".to_string(), late_artifact.canonical_json()],
        ],
    );
    let _ = client
        .send_event(expired_delivery)
        .await
        .expect("expired delivery response");
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        event_tag(
            &current_job_head(&mut client, &job_id)
                .await
                .expect("head after expired delivery"),
            "status"
        ),
        "leased",
        "an expired Task lease cannot deliver even before a replacement claims it"
    );

    let claim_two = job_event(
        &fixture.owner,
        KIND_JOB_CLAIM,
        "",
        vec![
            vec!["job".to_string(), job_id.clone()],
            vec!["nonce".to_string(), Uuid::new_v4().to_string()],
        ],
    );
    assert!(
        client
            .send_event(claim_two)
            .await
            .expect("claim two")
            .accepted
    );
    let recovered = await_job_head(&mut client, &job_id, "recovered attempt two", |head| {
        event_tag(head, "status") == "leased" && event_tag(head, "attempts") == "2"
    })
    .await;
    assert_eq!(event_tag(&recovered, "checkpoint-seq"), "1");
    assert_eq!(event_tag(&recovered, "checkpoint-event"), checkpoint_one_id);
    assert_eq!(event_tag(&recovered, "task"), task_id);
    assert_eq!(event_tag(&recovered, "run-status"), "executing");

    let no_artifact = job_event(
        &fixture.owner,
        KIND_JOB_OUTCOME,
        "Draft prepared but no deliverable declared",
        vec![
            vec!["job".to_string(), job_id.clone()],
            vec!["attempt".to_string(), "2".to_string()],
            vec!["status".to_string(), "done".to_string()],
            vec!["task".to_string(), task_id.clone()],
        ],
    );
    let _ = client
        .send_event(no_artifact)
        .await
        .expect("missing-artifact response");
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        event_tag(
            &current_job_head(&mut client, &job_id)
                .await
                .expect("head after missing artifact"),
            "status"
        ),
        "leased",
        "work without declared delivery evidence cannot become Delivered"
    );

    let stale_evidence_event = job_event(
        &fixture.owner,
        KIND_STREAM_MESSAGE_V2,
        "Stale attempt evidence",
        vec![
            vec!["h".to_string(), channel_id.clone()],
            vec![
                "e".to_string(),
                chat_root.clone(),
                String::new(),
                "root".to_string(),
            ],
            vec![
                "e".to_string(),
                chat_root.clone(),
                String::new(),
                "reply".to_string(),
            ],
            vec!["task".to_string(), task_id.clone()],
            vec!["job".to_string(), job_id.clone()],
            vec!["attempt".to_string(), "1".to_string()],
        ],
    );
    let stale_artifact = TaskArtifact {
        kind: TaskArtifactKind::Event,
        reference: stale_evidence_event.id.to_hex(),
        label: Some("Stale investor update".to_string()),
    };
    assert!(
        client
            .send_event(stale_evidence_event)
            .await
            .expect("store stale-attempt evidence")
            .accepted
    );
    let stale_evidence_delivery = job_event(
        &fixture.owner,
        KIND_JOB_OUTCOME,
        "Attempt two must not cite attempt one evidence",
        vec![
            vec!["job".to_string(), job_id.clone()],
            vec!["attempt".to_string(), "2".to_string()],
            vec!["status".to_string(), "done".to_string()],
            vec!["task".to_string(), task_id.clone()],
            vec!["artifact".to_string(), stale_artifact.canonical_json()],
        ],
    );
    let stale_response = client
        .send_event(stale_evidence_delivery.clone())
        .await
        .expect("stale-evidence delivery response");
    assert!(
        !stale_response.accepted,
        "wrong-attempt evidence was accepted"
    );
    assert!(stale_response.message.contains("wrong attempt fence"));
    let stale_retry = client
        .send_event(stale_evidence_delivery)
        .await
        .expect("stale-evidence retry response");
    assert!(
        !stale_retry.accepted && stale_retry.message.contains("wrong attempt fence"),
        "a stored invalid outcome must remain rejected when retried: {stale_retry:?}"
    );
    assert_eq!(
        event_tag(
            &current_job_head(&mut client, &job_id)
                .await
                .expect("head after stale evidence"),
            "status"
        ),
        "leased",
        "wrong-attempt evidence cannot finish the live lease"
    );

    let artifact_event = job_event(
        &fixture.owner,
        KIND_STREAM_MESSAGE_V2,
        "Investor update delivered",
        vec![
            vec!["h".to_string(), channel_id.clone()],
            vec![
                "e".to_string(),
                chat_root.clone(),
                String::new(),
                "root".to_string(),
            ],
            vec![
                "e".to_string(),
                chat_root.clone(),
                String::new(),
                "reply".to_string(),
            ],
            vec!["task".to_string(), task_id.clone()],
            vec!["job".to_string(), job_id.clone()],
            vec!["attempt".to_string(), "2".to_string()],
        ],
    );
    let artifact = TaskArtifact {
        kind: TaskArtifactKind::Event,
        reference: artifact_event.id.to_hex(),
        label: Some("Primary investor update".to_string()),
    };
    assert!(
        client
            .send_event(artifact_event)
            .await
            .expect("store signed delivery evidence")
            .accepted,
        "the accepted artifact must be a real signed relay event"
    );

    let delivered = job_event(
        &fixture.owner,
        KIND_JOB_OUTCOME,
        "Investor update delivered",
        vec![
            vec!["job".to_string(), job_id.clone()],
            vec!["attempt".to_string(), "2".to_string()],
            vec!["status".to_string(), "done".to_string()],
            vec!["task".to_string(), task_id.clone()],
            vec!["artifact".to_string(), artifact.canonical_json()],
        ],
    );
    let delivered_id = delivered.id.to_hex();
    assert!(
        client
            .send_event(delivered)
            .await
            .expect("delivery response")
            .accepted
    );
    let delivered_head = await_job_head(&mut client, &job_id, "delivered", |head| {
        event_tag(head, "status") == "done"
    })
    .await;
    let parsed = buzz_core::job::parse_job_head(&delivered_head).expect("delivered head parses");
    assert_eq!(event_tag(&delivered_head, "run-status"), "delivered");
    assert_eq!(parsed.task_id.as_deref(), Some(task_id.as_str()));
    assert_eq!(
        parsed.run_status,
        Some(buzz_core::job::TaskRunStatus::Delivered)
    );
    assert_eq!(parsed.checkpoint_sequence, 1);
    assert_eq!(
        parsed.checkpoint_event_hex.as_deref(),
        Some(checkpoint_one_id.as_str())
    );
    assert_eq!(
        parsed.outcome_event_hex.as_deref(),
        Some(delivered_id.as_str())
    );
    assert_eq!(parsed.artifacts, vec![artifact]);

    client.disconnect().await.ok();
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
    let profile = company(stamp);
    let create = action(
        &fixture.relay,
        CompanyActionOperation::Create,
        CompanyActionPayload::Company(profile.clone()),
        coordinate(KIND_COMPANY_PROFILE, &fixture.relay, COMMUNITY_PROFILE_ID),
        None,
    );
    let (outcome, head_id) = broker(&mut client, &fixture.owner, &fixture.relay, &create).await;
    // Applied the first time this community sees a profile, Conflict after:
    // the profile is a singleton at a fixed coordinate, so a second Create is
    // refused rather than making a second company. Every fixture builds the
    // same profile, so an existing one is equivalent for what follows.
    assert!(
        matches!(
            outcome,
            CompanyReceiptOutcome::Applied | CompanyReceiptOutcome::Conflict
        ),
        "the community profile must exist, got {outcome:?}"
    );

    let stored = head(
        &mut client,
        &fixture.relay,
        KIND_COMPANY_PROFILE,
        COMMUNITY_PROFILE_ID,
    )
    .await
    .expect("the community profile head exists");
    // Only an Applied receipt names a head; a Conflict created nothing, so
    // there is no receipt-to-head correspondence left to check.
    if let Some(head_id) = head_id {
        assert_eq!(
            stored.id.to_hex(),
            head_id,
            "the receipt names the real head"
        );
    }
    assert_eq!(
        stored.pubkey.to_hex(),
        fixture.relay,
        "the relay, not the owner, authored the head"
    );

    // --- Create an initiative and two tasks ---------------------------------
    let initiative_id = format!("launch-{}", fixture.token);
    let proposed = initiative(&initiative_id, &fixture.team.lead_persona_id, stamp);
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
        let task_id = format!("task-{suffix}-{}", fixture.token);
        let record = task(&task_id, &fixture.team, stamp);
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
    let replay_id = format!("task-replay-{}", fixture.token);
    let replay_record = task(&replay_id, &fixture.team, stamp);
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
    // Cross a `created_at` second boundary before retrying. Nostr stamps
    // `created_at` in whole seconds, so two signings of one action inside the
    // same second are byte-identical and the relay answers the trivial
    // "duplicate: identical action already applied" — which never reaches the
    // claim-replay path this block exists to test. Waiting makes the retry a
    // genuinely distinct event, so every run exercises the supersede branch
    // instead of testing it on roughly one run in twenty by luck.
    tokio::time::sleep(Duration::from_millis(1_100)).await;
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

    let profile = company(stamp);
    let (outcome, _) = broker(
        &mut client,
        &fixture.owner,
        &fixture.relay,
        &action(
            &fixture.relay,
            CompanyActionOperation::Create,
            CompanyActionPayload::Company(profile.clone()),
            coordinate(KIND_COMPANY_PROFILE, &fixture.relay, COMMUNITY_PROFILE_ID),
            None,
        ),
    )
    .await;
    // Applied the first time this community sees a profile, Conflict after:
    // the profile is a singleton at a fixed coordinate, so a second Create is
    // refused rather than making a second company. Every fixture builds the
    // same profile, so an existing one is equivalent for what follows.
    assert!(matches!(
        outcome,
        CompanyReceiptOutcome::Applied | CompanyReceiptOutcome::Conflict
    ));

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
        COMMUNITY_PROFILE_ID,
    )
    .await
    .expect("company head");
    let event = build_company_action(&action(
        &fixture.relay,
        CompanyActionOperation::Transition,
        CompanyActionPayload::Company(hijack),
        coordinate(KIND_COMPANY_PROFILE, &fixture.relay, COMMUNITY_PROFILE_ID),
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
        COMMUNITY_PROFILE_ID,
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
            .tags(vec![Tag::parse(["d", COMMUNITY_PROFILE_ID]).expect("d")])
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

/// A chain actually advances: B depends on A and sits blocked; completing A
/// through the ordinary owner-signed action path wakes B, asserted by
/// reading B's head back from the relay rather than by calling any
/// derivation function. A replayed completion must not produce a second
/// wake, proven by B's head event id staying identical.
///
/// This is the end-to-end half of blocked-to-ready derivation: the unit
/// tests in `buzz-relay` prove the decision logic against snapshots, and
/// this proves the relay actually finds dependents through stored `v` tags,
/// republishes them, and stays idempotent against real Postgres.
///
/// Needs no `BUZZ_EMPLOYEE_KEK`: nothing here hires an employee. It does
/// need `DATABASE_URL` to seed the owner fixture.
#[tokio::test]
#[ignore = "requires a running relay with Postgres (DATABASE_URL for owner seeding)"]
async fn a_completed_dependency_wakes_its_blocked_dependent_exactly_once() {
    let owner = owner_keys();
    seed_company_owner(&owner).await;
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let fixture = setup(&mut client, owner.clone()).await;
    let stamp = now();

    // --- Company and two tasks: A human-doer InProgress, B Blocked on A ----
    let profile = company(stamp);
    let profile_outcome = broker(
        &mut client,
        &fixture.owner,
        &fixture.relay,
        &action(
            &fixture.relay,
            CompanyActionOperation::Create,
            CompanyActionPayload::Company(profile),
            coordinate(KIND_COMPANY_PROFILE, &fixture.relay, COMMUNITY_PROFILE_ID),
            None,
        ),
    )
    .await
    .0;
    assert!(matches!(
        profile_outcome,
        CompanyReceiptOutcome::Applied | CompanyReceiptOutcome::Conflict
    ));

    let task_a_id = format!("call-the-client-{}", fixture.token);
    let task_b_id = format!("send-the-followup-{}", fixture.token);

    // A is a phone call: doerKind human, so it completes without review.
    let mut task_a = task(&task_a_id, &fixture.team, stamp);
    task_a.status = TaskStatus::InProgress;
    task_a.doer_kind = DoerKind::Human;
    let (a_outcome, a_head_id) = broker(
        &mut client,
        &fixture.owner,
        &fixture.relay,
        &action(
            &fixture.relay,
            CompanyActionOperation::Create,
            CompanyActionPayload::Task(task_a.clone()),
            coordinate(KIND_TASK, &fixture.relay, &task_a_id),
            None,
        ),
    )
    .await;
    assert_eq!(a_outcome, CompanyReceiptOutcome::Applied);
    let a_head_id = a_head_id.expect("an applied receipt names its head");

    // B starts blocked on A, exactly the eager fan-out shape: the whole
    // graph exists up front and downstream work waits.
    let mut task_b = task(&task_b_id, &fixture.team, stamp);
    task_b.status = TaskStatus::Blocked;
    task_b.depends_on = vec![task_a_id.clone()];
    assert_eq!(
        broker(
            &mut client,
            &fixture.owner,
            &fixture.relay,
            &action(
                &fixture.relay,
                CompanyActionOperation::Create,
                CompanyActionPayload::Task(task_b.clone()),
                coordinate(KIND_TASK, &fixture.relay, &task_b_id),
                None,
            ),
        )
        .await
        .0,
        CompanyReceiptOutcome::Applied
    );

    async fn dependent_head(
        client: &mut BuzzTestClient,
        relay: &str,
        d_tag: &str,
    ) -> buzz_core::company::CompanyTask {
        let event = head(client, relay, KIND_TASK, d_tag)
            .await
            .unwrap_or_else(|| panic!("head for {d_tag} must exist"));
        parse_task_event(&event).expect("the relay's own head parses")
    }

    // Before anything completes, B is blocked. Reading from the relay, not
    // trusting local state.
    let before = dependent_head(&mut client, &fixture.relay, &task_b_id).await;
    assert_eq!(
        before.status,
        TaskStatus::Blocked,
        "the dependent must start blocked"
    );

    // --- Complete A through the ordinary owner-signed action path ---------
    let mut completed_a = task_a.clone();
    completed_a.status = TaskStatus::Completed;
    // A human doer must say what actually happened: there is no bare "done"
    // for a person, because "40 completed" is worthless and the reason is the
    // only funnel data the chain ever produces. The stage supplies the real
    // vocabulary once pipeline templates exist.
    completed_a.outcome_reason = Some("reached-and-agreed".to_string());
    completed_a.updated_at += 1;
    assert_eq!(
        broker(
            &mut client,
            &fixture.owner,
            &fixture.relay,
            &action(
                &fixture.relay,
                CompanyActionOperation::Update,
                CompanyActionPayload::Task(completed_a),
                coordinate(KIND_TASK, &fixture.relay, &task_a_id),
                Some(a_head_id.clone()),
            ),
        )
        .await
        .0,
        CompanyReceiptOutcome::Applied,
        "a human phone call completes without review"
    );

    // The wake is derived after the commit, so poll rather than assume.
    let mut woken_head_id = None;
    for _ in 0..40 {
        let event = head(&mut client, &fixture.relay, KIND_TASK, &task_b_id)
            .await
            .expect("B head exists");
        if parse_task_event(&event)
            .expect("the relay's own head parses")
            .status
            == TaskStatus::Ready
        {
            woken_head_id = Some(event.id.to_hex());
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let woken_head_id =
        woken_head_id.expect("the dependent must become ready after its dependency completed");

    // --- Replay the same completion; nothing may wake twice ---------------
    // A second completion action carries a stale compare-and-set head (B's
    // wake did not touch A, but A moved when it completed), so the relay
    // refuses it rather than applying anything. The assertion that matters
    // is downstream: B's head event id is unchanged, meaning no second wake
    // was ever published even though the completion was attempted twice.
    let mut completed_again = task_a.clone();
    completed_again.status = TaskStatus::Completed;
    completed_again.updated_at += 1;
    let (replay_outcome, _) = broker(
        &mut client,
        &fixture.owner,
        &fixture.relay,
        &action(
            &fixture.relay,
            CompanyActionOperation::Update,
            CompanyActionPayload::Task(completed_again),
            coordinate(KIND_TASK, &fixture.relay, &task_a_id),
            Some(a_head_id),
        ),
    )
    .await;
    assert_eq!(
        replay_outcome,
        CompanyReceiptOutcome::Conflict,
        "completing an already-completed head must lose compare-and-set"
    );

    let after_replay = dependent_head(&mut client, &fixture.relay, &task_b_id).await;
    let after_replay_head = head(&mut client, &fixture.relay, KIND_TASK, &task_b_id)
        .await
        .expect("B head exists");
    assert_eq!(after_replay.status, TaskStatus::Ready, "B stays ready");
    assert_eq!(
        after_replay_head.id.to_hex(),
        woken_head_id,
        "no second wake: B's head is byte-for-byte the one the first completion produced"
    );

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
    seed_company_owner(&owner).await;
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let fixture = setup(&mut client, owner.clone()).await;
    let stamp = now();

    let profile = company(stamp);
    let (outcome, _) = broker(
        &mut client,
        &fixture.owner,
        &fixture.relay,
        &action(
            &fixture.relay,
            CompanyActionOperation::Create,
            CompanyActionPayload::Company(profile.clone()),
            coordinate(KIND_COMPANY_PROFILE, &fixture.relay, COMMUNITY_PROFILE_ID),
            None,
        ),
    )
    .await;
    // Applied first, Conflict after: the profile is a community singleton.
    assert!(matches!(
        outcome,
        CompanyReceiptOutcome::Applied | CompanyReceiptOutcome::Conflict
    ));

    let initiative_id = format!("launch-{}", fixture.token);
    let proposed = initiative(&initiative_id, &fixture.team.lead_persona_id, stamp);
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

/// The attributed turn metric, through a real relay.
///
/// A metric that carries work context is only useful if the owner can get it
/// back and read it. That path crosses a real encryption boundary and a real
/// relay: the agent encrypts to the owner, the relay stores an opaque blob it
/// cannot read, and the owner decrypts it later. Nothing about that is provable
/// against a mock, and a classification that survived the harness but not the
/// round trip would be a number nobody could audit.
///
/// What this does not prove is that a live harness *hydrates* the context
/// correctly; that is `buzz-acp`'s own suite. This proves the metric contract
/// holds end to end once it has.
#[tokio::test]
#[ignore = "requires a running relay whose community owner is this test's key"]
async fn an_attributed_turn_metric_round_trips_through_the_relay() {
    use buzz_core::agent_turn_metric::{
        decrypt_agent_turn_metric, encrypt_agent_turn_metric, AgentTurnMetricPayload, TokenCounts,
    };
    use buzz_core::company::{AgentWorkContext, AttributionState, CostClassification};
    use buzz_core::kind::KIND_AGENT_TURN_METRIC;

    let owner = owner_keys();
    let agent = Keys::generate();
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let suffix = Uuid::new_v4().simple().to_string();

    // Client delivery with a named client is the case the classifier has to get
    // right, because it is the one that moves money between COGS and OPEX.
    let work = AgentWorkContext {
        task_id: format!("co{}:chat:0001", &suffix[..12]),
        initiative_id: Some(format!("co{}:launch", &suffix[..12])),
        owning_team_id: format!("team-{}", &suffix[..12]),
        cost_centre_id: "cc-coordination".to_string(),
        commercial_purpose: CommercialPurpose::ClientDelivery,
        cost_classification: buzz_core::company::classify_cost(
            CommercialPurpose::ClientDelivery,
            Some("acme"),
        ),
        attribution_state: AttributionState::Explicit,
        client_organization_id: Some("acme".to_string()),
    };
    assert_eq!(
        work.cost_classification,
        CostClassification::Cogs,
        "client delivery for a named client is a cost of goods sold"
    );

    let payload = AgentTurnMetricPayload {
        harness: "e2e-company-work".to_string(),
        model: Some("proof".to_string()),
        channel_id: None,
        session_id: Some(format!("session-{suffix}")),
        turn_id: Some(format!("turn-{suffix}")),
        turn_seq: Some(1),
        timestamp: "2026-08-02T00:00:00.000Z".to_string(),
        turn: Some(TokenCounts {
            input_tokens: Some(120),
            output_tokens: Some(45),
            total_tokens: Some(165),
            cache_read_tokens: None,
            cache_write_tokens: None,
            cost_usd: None,
        }),
        cumulative: None,
        delta_reliable: true,
        stop_reason: Some(buzz_core::agent_turn_metric::StopReason::EndTurn),
        pricing_identity: None,
        work_context: Some(work.clone()),
    };

    let ciphertext = encrypt_agent_turn_metric(&agent, &owner.public_key(), &payload)
        .expect("the agent encrypts its metric to the owner");
    let metric = EventBuilder::new(Kind::Custom(KIND_AGENT_TURN_METRIC as u16), ciphertext)
        .tags(vec![
            Tag::parse(["p", &owner.public_key().to_hex()]).expect("p tag"),
            Tag::parse(["agent", &agent.public_key().to_hex()]).expect("agent tag"),
        ])
        .sign_with_keys(&agent)
        .expect("metric signs");
    let metric_id = metric.id.to_hex();

    // The relay refuses a metric whose `p` tag is not the agent's registered
    // owner, so the agent connects through NIP-OA to establish that it is
    // owned. That guard is why an agent cannot address a cost report to
    // someone who never hired it.
    let auth_tag_json =
        buzz_sdk::nip_oa::compute_auth_tag(&owner, &agent.public_key(), "kind=44200")
            .expect("owner signs the agent's auth tag");
    let auth_tag = buzz_sdk::nip_oa::parse_auth_tag(&auth_tag_json).expect("auth tag parses");
    let mut agent_client = BuzzTestClient::connect_unauthenticated(&relay_url())
        .await
        .expect("connect as agent");
    agent_client
        .authenticate_with_nip_oa(&agent, &auth_tag)
        .await
        .expect("the agent authenticates as owned by this owner");
    let ok = agent_client
        .send_event(metric)
        .await
        .expect("the relay answers the metric");
    assert!(ok.accepted, "the relay refused the metric: {}", ok.message);

    // Read it back the way the owner would: by kind, addressed to them. The
    // metric was JUST sent, so this races relay propagation the same way
    // `head`'s read-after-write does; a silent window is retried the same
    // way, with the final panic strict.
    let mut events = Vec::new();
    for attempt in 0..10 {
        let id = sub_id("metric");
        let filter = Filter::new()
            .kind(Kind::Custom(KIND_AGENT_TURN_METRIC as u16))
            .pubkey(owner.public_key())
            .limit(20);
        client
            .subscribe(&id, vec![filter])
            .await
            .expect("subscribe");
        match client
            .collect_until_eose(&id, Duration::from_secs(10))
            .await
        {
            Ok(found) => {
                let _ = client.close_subscription(&id).await;
                events = found;
                break;
            }
            Err(error) => {
                eprintln!("metric read-back poll {attempt} errored, retrying: {error}");
                let _ = client.close_subscription(&id).await;
                if attempt == 9 {
                    panic!("the relay never answered the metric read-back: {error}");
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
    }

    let stored = events
        .iter()
        .find(|event| event.id.to_hex() == metric_id)
        .expect("the owner can read back their own turn metric");

    // The relay stored a blob it cannot read. Anything legible here would mean
    // the company's cost structure is visible to whoever runs the relay.
    assert!(
        !stored.content.contains("clientDelivery") && !stored.content.contains("acme"),
        "the stored metric must not leak its work context in plaintext"
    );

    let decrypted =
        decrypt_agent_turn_metric(&owner, stored).expect("the owner decrypts their own metric");
    let recovered = decrypted
        .work_context
        .expect("an attributed turn carries its work context through the relay");
    assert_eq!(
        recovered, work,
        "every work-context field survives the round trip"
    );
    assert_eq!(recovered.cost_classification, CostClassification::Cogs);
    assert_eq!(recovered.attribution_state, AttributionState::Explicit);

    agent_client.disconnect().await.ok();
    client.disconnect().await.ok();
}

/// Seed one company, team, initiative, and Task with fixed identifiers, then
/// print the flags a live agent run needs.
///
/// Not an assertion suite: this is the setup step for the live NIP-AM run in
/// TESTING.md, kept here because it goes through the same owner-signed action
/// path everything else in this file does. Seeding by hand through a second
/// implementation would prove the harness against records the relay would
/// never have accepted.
#[tokio::test]
#[ignore = "seeds live fixtures; run explicitly before a live agent turn"]
async fn seed_live_work_context() {
    let owner = owner_keys();
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let relay = relay_self().await;
    let stamp = now();

    // Not an identifier any more, just a distinctive prefix for this
    // seed's own initiative and task ids.
    let prefix = "livecompany";
    let team = CompanyTeamRef {
        id: "live-team".to_string(),
        lead_persona_id: "live-lead".to_string(),
        persona_ids: vec!["live-lead".to_string()],
    };
    let initiative_id = format!("{prefix}:live-initiative");
    let task_id = format!("{prefix}:live-task");

    publish_team(&mut client, &owner, &team).await;

    for action in [
        action(
            &relay,
            CompanyActionOperation::Create,
            CompanyActionPayload::Company(company(stamp)),
            coordinate(KIND_COMPANY_PROFILE, &relay, COMMUNITY_PROFILE_ID),
            None,
        ),
        action(
            &relay,
            CompanyActionOperation::Create,
            CompanyActionPayload::Initiative(initiative(
                &initiative_id,
                &team.lead_persona_id,
                stamp,
            )),
            coordinate(KIND_INITIATIVE, &relay, &initiative_id),
            None,
        ),
        action(
            &relay,
            CompanyActionOperation::Create,
            CompanyActionPayload::Task({
                let mut record = task(&task_id, &team, stamp);
                record.initiative_id = Some(initiative_id.clone());
                // Client delivery for a named client, so the classification the
                // live run reads back is COGS rather than the default.
                record.commercial_purpose = CommercialPurpose::ClientDelivery;
                record.client_organization_id = Some("acme".to_string());
                record.status = TaskStatus::InProgress;
                record
            }),
            coordinate(KIND_TASK, &relay, &task_id),
            None,
        ),
    ] {
        let (outcome, _) = broker(&mut client, &owner, &relay, &action).await;
        assert!(
            matches!(
                outcome,
                CompanyReceiptOutcome::Applied | CompanyReceiptOutcome::Conflict
            ),
            "seeding must either write the record or find it already there, got {outcome:?}"
        );
    }

    println!("LIVE_TASK={task_id}");
    println!("LIVE_INITIATIVE={initiative_id}");
    println!("LIVE_TEAM={}", team.id);
    println!("LIVE_COMPANY={COMMUNITY_PROFILE_ID}");
    client.disconnect().await.ok();
}

/// Print the agent credentials a live ACP run needs.
///
/// The auth tag is what tells the relay this agent is owned by this owner;
/// without it the relay refuses the agent's turn metric outright. Computed
/// through `nip_oa::compute_auth_tag`, the same function the desktop uses, so
/// a live run is authorized exactly the way a real agent launch is.
///
/// Set `LIVE_AGENT_SECRET` to keep an agent identity stable across runs.
#[test]
#[ignore = "prints live agent credentials; run explicitly before a live agent turn"]
fn print_live_agent_credentials() {
    let owner = owner_keys();
    let agent = match std::env::var("LIVE_AGENT_SECRET") {
        Ok(secret) => Keys::parse(&secret).expect("LIVE_AGENT_SECRET must be a 64-hex secret"),
        Err(_) => Keys::parse("2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a")
            .expect("default live agent key"),
    };
    let auth_tag = buzz_sdk::nip_oa::compute_auth_tag(&owner, &agent.public_key(), "kind=9")
        .expect("the owner signs the agent's auth tag");
    println!("LIVE_AGENT_PUBKEY={}", agent.public_key().to_hex());
    println!("LIVE_AGENT_SECRET={}", agent.secret_key().to_secret_hex());
    println!("LIVE_AGENT_AUTH_TAG={auth_tag}");
    println!("LIVE_OWNER_PUBKEY={}", owner.public_key().to_hex());
}

/// Read every turn metric addressed to the owner and print its work context.
///
/// The inspection half of the live NIP-AM run: after a real agent turn, this is
/// what tells you whether the harness actually charged it to anything. It
/// asserts nothing about which turns exist, because that depends on what was
/// run; it asserts that anything it does find decrypts and is internally
/// consistent.
#[tokio::test]
#[ignore = "inspects live turn metrics; run after a live agent turn"]
async fn inspect_live_turn_metrics() {
    use buzz_core::agent_turn_metric::decrypt_agent_turn_metric;
    use buzz_core::company::classify_cost;
    use buzz_core::kind::KIND_AGENT_TURN_METRIC;

    let owner = owner_keys();
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");

    // Deliberately left strict, unlike the CI-run polls above: this is a
    // human-invoked inspection command ("run after a live agent turn"), not
    // a correctness assertion racing a just-written record. If the read
    // fails, that is exactly as informative to the person running it as a
    // retried success would be, and retry machinery would only obscure
    // what a live, one-off inspection actually saw.
    let id = sub_id("inspect");
    let filter = Filter::new()
        .kind(Kind::Custom(KIND_AGENT_TURN_METRIC as u16))
        .pubkey(owner.public_key())
        .limit(50);
    client
        .subscribe(&id, vec![filter])
        .await
        .expect("subscribe");
    let events = client
        .collect_until_eose(&id, Duration::from_secs(10))
        .await
        .expect("collect");
    let _ = client.close_subscription(&id).await;

    println!("METRICS_FOUND={}", events.len());
    let mut attributed = 0usize;
    for event in &events {
        let payload = match decrypt_agent_turn_metric(&owner, event) {
            Ok(payload) => payload,
            Err(error) => {
                println!("METRIC {} undecryptable: {error}", &event.id.to_hex()[..12]);
                continue;
            }
        };
        match payload.work_context {
            Some(work) => {
                attributed += 1;
                // The classification is derived, so it must agree with the
                // purpose and client it was derived from. A metric that
                // disagreed with itself would be an unauditable number.
                assert_eq!(
                    work.cost_classification,
                    classify_cost(
                        work.commercial_purpose,
                        work.client_organization_id.as_deref()
                    ),
                    "a stored classification must match what its own fields imply"
                );
                println!(
                    "METRIC {} harness={} stop={:?} task={} initiative={:?} team={} cost_centre={} purpose={:?} classification={:?} client={:?}",
                    &event.id.to_hex()[..12],
                    payload.harness,
                    payload.stop_reason,
                    work.task_id,
                    work.initiative_id,
                    work.owning_team_id,
                    work.cost_centre_id,
                    work.commercial_purpose,
                    work.cost_classification,
                    work.client_organization_id,
                );
            }
            None => println!(
                "METRIC {} harness={} UNATTRIBUTED",
                &event.id.to_hex()[..12],
                payload.harness
            ),
        }
    }
    println!("METRICS_ATTRIBUTED={attributed}");
    client.disconnect().await.ok();
}
