//! End-to-end proof that one thread holds one open task, decided by the relay.
//!
//! Every rule here is enforced inside the relay process against a real
//! Postgres, and none of them can be proven by a unit test that talks to a
//! mock: the whole point of moving the decision to the relay is that two
//! clients preparing the same send cannot talk themselves into two tasks, and
//! only a real database can arbitrate that.
//!
//! # Running
//!
//! ```text
//! RELAY_URL=ws://localhost:3099 \
//! RELAY_HTTP_URL=http://localhost:3099 \
//! cargo test -p buzz-test-client --test e2e_thread_tasks -- --ignored --test-threads=1
//! ```

use std::time::Duration;

use buzz_core::company::{CompanyTask, CompanyTeamRef, TaskStatus, ThreadAttachMode};
use buzz_core::kind::{
    KIND_COMPANY_ACTION, KIND_COMPANY_RECEIPT, KIND_MANAGED_AGENT, KIND_STREAM_MESSAGE_V2,
    KIND_TASK, KIND_TASK_REPORT, KIND_TEAM,
};
use buzz_sdk::company::{
    build_company_action, parse_company_receipt, parse_task_event, CompanyAction,
    CompanyActionOperation, CompanyActionPayload, CompanyReceiptOutcome,
};
use buzz_sdk::thread_task::{plan_thread_attach, ThreadAttachRequest};
use buzz_test_client::BuzzTestClient;
use nostr::{EventBuilder, Filter, Keys, Kind, Tag, Timestamp};
use uuid::Uuid;

fn relay_url() -> String {
    std::env::var("RELAY_URL").unwrap_or_else(|_| "ws://localhost:3099".to_string())
}

fn http_url() -> String {
    std::env::var("RELAY_HTTP_URL").unwrap_or_else(|_| "http://localhost:3099".to_string())
}

/// The community owner this suite signs as, fixed for the same reason
/// `e2e_company_work` fixes it: the relay decides ownership before the process
/// starts, so the key has to be known in advance.
fn owner_keys() -> Keys {
    let secret = std::env::var("COMPANY_OWNER_SECRET").unwrap_or_else(|_| {
        "1c0ffee51c0ffee51c0ffee51c0ffee51c0ffee51c0ffee51c0ffee51c0ffee5".to_string()
    });
    Keys::parse(&secret).expect("COMPANY_OWNER_SECRET must be a 64-hex secret key")
}

fn sub_id(name: &str) -> String {
    format!("e2e-thread-task-{name}-{}", Uuid::new_v4())
}

fn now() -> i64 {
    Timestamp::now().as_secs() as i64
}

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
        .expect("NIP-11 document is JSON");
    document["self"]
        .as_str()
        .expect("relay advertises its own pubkey")
        .to_string()
}

/// A pool that lives exactly as long as the work it is opened for.
///
/// Two ways to get this wrong have already cost a CI round each, and this
/// shape avoids both. Opening a pool per call and never closing it leaks a
/// Postgres connection every time, and once a run approaches the server's
/// ceiling the RELAY cannot acquire one, so its next query sits on an acquire
/// timeout and the client times out first. Caching one pool in a `static`
/// leaks something worse: every `#[tokio::test]` builds its own runtime, so
/// the second case onwards inherits a pool whose background tasks belong to a
/// runtime that no longer exists, and every acquire on it times out.
///
/// So the pool is per call, closed before returning, and its acquire timeout
/// is short: a hold shows up as a fast, named failure rather than a stall.
async fn with_e2e_db<F, Fut, T>(work: F) -> T
where
    F: FnOnce(sqlx::Pool<sqlx::Postgres>) -> Fut,
    Fut: std::future::Future<Output = T>,
{
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://buzz:buzz_dev@localhost:5432/buzz".to_string());
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&database_url)
        .await
        .expect("connect to e2e Postgres");
    let outcome = work(pool.clone()).await;
    pool.close().await;
    outcome
}

/// The deployment community, looked up once per process.
///
/// A plain value rather than a cached pool: it is a `Uuid`, so it carries no
/// runtime-bound state across the per-test runtimes.
static E2E_COMMUNITY: std::sync::OnceLock<Uuid> = std::sync::OnceLock::new();

async fn community_id() -> Uuid {
    if let Some(community) = E2E_COMMUNITY.get() {
        return *community;
    }
    let host = relay_url().replace("wss://", "").replace("ws://", "");
    let community: Uuid = with_e2e_db(|pool| async move {
        sqlx::query_scalar("SELECT id FROM communities WHERE lower(host) = lower($1)")
            .bind(&host)
            .fetch_optional(&pool)
            .await
            .expect("query the deployment community")
            .unwrap_or_else(|| panic!("community for host {host} must exist"))
    })
    .await;
    *E2E_COMMUNITY.get_or_init(|| community)
}

/// Seed one member. `agent_owner` marks the key as an agent, which is what
/// the relay's sub-task authorization keys off.
async fn seed_member(keys: &Keys, role: &str, agent_owner: Option<&Keys>) {
    let community = community_id().await;
    let pubkey_bytes = keys.public_key().to_bytes().to_vec();
    let pubkey_hex = keys.public_key().to_hex();
    let agent_owner = agent_owner.map(|owner| owner.public_key().to_bytes().to_vec());
    with_e2e_db(|pool| async move {
        sqlx::query(
            "INSERT INTO users (community_id, pubkey, agent_owner_pubkey) VALUES ($1, $2, $3) \
             ON CONFLICT (community_id, pubkey) DO UPDATE SET agent_owner_pubkey = EXCLUDED.agent_owner_pubkey",
        )
        .bind(community)
        .bind(pubkey_bytes)
        .bind(agent_owner)
        .execute(&pool)
        .await
        .expect("seed the member as a user");
        sqlx::query(
            "INSERT INTO relay_members (community_id, pubkey, role, added_by) \
             VALUES ($1, $2, $3, NULL) \
             ON CONFLICT (community_id, pubkey) DO UPDATE SET role = EXCLUDED.role",
        )
        .bind(community)
        .bind(pubkey_hex)
        .bind(role)
        .execute(&pool)
        .await
        .expect("seed the member role");
    })
    .await;
}

/// Send one event, retrying past a silent transport window.
///
/// `e2e_company_work` learned this the hard way and its comment is worth
/// repeating: the relay going quiet for one window proves nothing about the
/// write, so a stalled window reported as "team accepted: Timeout" is a
/// transport event dressed up as a relay verdict. Only `Timeout` is retried.
/// An answered-but-rejected write is returned untouched, because a relay that
/// says no is an answer, and retrying past it would hide exactly the failures
/// this suite exists to catch.
///
/// Safe because the same signed event carries the same id: an addressable
/// event replaces itself, and a re-sent one the relay already stored comes
/// back as a duplicate rather than as a second write. This is not a sleep
/// waiting for something to become true; it is a resend of an idempotent
/// write whose answer went missing.
async fn send_past_transport_stall(
    client: &mut BuzzTestClient,
    event: nostr::Event,
    what: &str,
) -> buzz_ws_client::OkResponse {
    for attempt in 0..8 {
        match client.send_event(event.clone()).await {
            Ok(ok) => return ok,
            Err(buzz_test_client::TestClientError::Timeout) => {
                eprintln!("{what} send attempt {attempt} timed out, retrying");
            }
            Err(error) => panic!("{what}: {error}"),
        }
    }
    panic!("{what}: the relay never answered eight send attempts");
}

async fn create_channel(keys: &Keys) -> String {
    let client = reqwest::Client::new();
    let channel_uuid = Uuid::new_v4();
    let event = EventBuilder::new(Kind::Custom(9007), "")
        .tags(vec![
            Tag::parse(["h", channel_uuid.to_string().as_str()]).expect("h tag"),
            Tag::parse(["name", format!("thread-task-e2e-{channel_uuid}").as_str()])
                .expect("name tag"),
            Tag::parse(["channel_type", "stream"]).expect("type tag"),
            Tag::parse(["visibility", "open"]).expect("visibility tag"),
        ])
        .sign_with_keys(keys)
        .expect("create-channel event signs");
    let response = client
        .post(format!("{}/events", http_url()))
        .header("X-Pubkey", keys.public_key().to_hex())
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(&event).expect("event serializes"))
        .send()
        .await
        .expect("submit create-channel event");
    assert!(response.status().is_success(), "channel creation failed");
    channel_uuid.to_string()
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
    assert!(
        send_past_transport_stall(client, event, "team accepted")
            .await
            .accepted,
        "the relay must accept the team head this suite validates against"
    );
}

/// Publish the managed-agent head that binds one agent key to one persona.
/// The relay reads this rather than trusting a persona named in a request.
async fn publish_managed_agent(
    client: &mut BuzzTestClient,
    owner: &Keys,
    agent: &Keys,
    persona_id: &str,
) {
    let content = serde_json::json!({ "persona_id": persona_id });
    let event = EventBuilder::new(
        Kind::Custom(KIND_MANAGED_AGENT as u16),
        serde_json::to_string(&content).expect("agent json"),
    )
    .tags(vec![Tag::parse([
        "d",
        agent.public_key().to_hex().as_str(),
    ])
    .expect("d tag")])
    .sign_with_keys(owner)
    .expect("managed agent signs");
    assert!(
        send_past_transport_stall(client, event, "managed agent accepted")
            .await
            .accepted,
        "the relay must accept the managed-agent head personas resolve through"
    );
}

/// Submit one action and read the relay's receipt for it.
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
    let ok = send_past_transport_stall(client, event, "the relay answers every action").await;
    eprintln!(
        "action {} accepted={} message={:?}",
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
            .unwrap_or_default();
        let _ = client.close_subscription(&id).await;
        if let Some(event) = events.first() {
            let receipt = parse_company_receipt(event).expect("receipt parses");
            return (receipt.outcome, receipt.head_event_id);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("the relay never answered a legitimate thread attach");
}

/// Read one stored event by id.
async fn event_by_id(client: &mut BuzzTestClient, event_id: &str) -> Option<nostr::Event> {
    for _ in 0..10 {
        let id = sub_id("event");
        let filter = Filter::new()
            .id(nostr::EventId::from_hex(event_id).expect("event id"))
            .limit(1);
        client
            .subscribe(&id, vec![filter])
            .await
            .expect("subscribe");
        let events = client
            .collect_until_eose(&id, Duration::from_secs(5))
            .await
            .unwrap_or_default();
        let _ = client.close_subscription(&id).await;
        if let Some(event) = events.first() {
            return Some(event.clone());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    None
}

/// The task one attach resolved to, read from the head its receipt names.
async fn attached_task(
    client: &mut BuzzTestClient,
    keys: &Keys,
    relay: &str,
    action: &CompanyAction,
) -> CompanyTask {
    let (outcome, head_event_id) = broker(client, keys, relay, action).await;
    assert_eq!(
        outcome,
        CompanyReceiptOutcome::Applied,
        "a legitimate attach is applied"
    );
    let head_event_id = head_event_id.expect("an applied attach names the head it resolved to");
    let head = event_by_id(client, &head_event_id)
        .await
        .expect("the head a receipt names is stored");
    parse_task_event(&head).expect("the head is a readable task")
}

struct Fixture {
    relay: String,
    team: CompanyTeamRef,
    channel: String,
}

async fn setup(client: &mut BuzzTestClient, owner: &Keys, personas: &[String]) -> Fixture {
    seed_member(owner, "owner", None).await;
    let relay = relay_self().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let lead = format!("lead-{}", &suffix[..12]);
    let mut persona_ids = vec![lead.clone()];
    persona_ids.extend(personas.iter().cloned());
    // Named for the coordination slug on purpose: a send that mentions no
    // agent has no persona to resolve a team from, and the coordination team
    // is what `owning_team_for_chat` falls back to. A company without one
    // cannot charge unaddressed chat anywhere, which is a company setup
    // question rather than something this suite should paper over.
    let team = CompanyTeamRef {
        id: format!("team-{}-company-coordination", &suffix[..12]),
        lead_persona_id: lead,
        persona_ids,
    };
    publish_team(client, owner, &team).await;
    let channel = create_channel(owner).await;
    Fixture {
        relay,
        team,
        channel,
    }
}

fn attach<'a>(
    fixture: &'a Fixture,
    signer: &'a str,
    thread_root: Option<&'a str>,
    send_id: &'a str,
    mode: ThreadAttachMode,
    title: &'a str,
    persona: Option<&'a str>,
) -> CompanyAction {
    plan_thread_attach(ThreadAttachRequest {
        channel_id: &fixture.channel,
        thread_root,
        conversation_scope: false,
        send_id,
        mode,
        title,
        agent_persona_id: persona,
        client_organization_id: None,
        parent_task_id: None,
        owner_pubkey: signer,
        relay_pubkey: &fixture.relay,
        now: now(),
    })
    .expect("attach plans")
}

#[tokio::test]
#[ignore = "requires a running relay with Postgres"]
async fn a_task_opened_by_a_threads_first_message_learns_its_root() {
    let owner = owner_keys();
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let fixture = setup(&mut client, &owner, &[]).await;
    let signer = owner.public_key().to_hex();

    // A send that STARTS a thread has no root to name: the event it will
    // become does not exist until it is published. The task is opened first,
    // because the turn must not run unattributed, so it is written with no
    // thread root at all.
    let opened = attached_task(
        &mut client,
        &owner,
        &fixture.relay,
        &attach(
            &fixture,
            &signer,
            None,
            "send-1",
            ThreadAttachMode::Open,
            "Cut the release video",
            Some(&fixture.team.lead_persona_id),
        ),
    )
    .await;
    assert!(
        opened.thread_root.is_none(),
        "the root this task belongs to does not exist yet"
    );

    // Now publish the message that task was opened for, carrying the task the
    // relay handed back.
    let message = EventBuilder::new(
        Kind::Custom(KIND_STREAM_MESSAGE_V2 as u16),
        "Cut the release video",
    )
    .tags(vec![
        Tag::parse(["h", fixture.channel.as_str()]).expect("h tag"),
        Tag::parse(["task", opened.id.as_str()]).expect("task tag"),
    ])
    .sign_with_keys(&owner)
    .expect("message signs");
    let root = message.id.to_hex();
    assert!(
        send_past_transport_stall(&mut client, message, "the relay answers the message")
            .await
            .accepted,
        "the thread root message is stored"
    );

    // The head learns the root the moment it exists. Without this, a reader
    // asking "which task belongs to this thread" finds nothing, so the thread
    // header, Mark done and the new-task switch appear only for tasks opened
    // from a reply.
    let with_root = await_thread_root(&mut client, &fixture.relay, &opened.id, &root).await;
    assert_eq!(with_root.thread_root.as_deref(), Some(root.as_str()));
    assert_eq!(
        with_root.id, opened.id,
        "it is the same task, not a second one"
    );

    // And a reply inside that thread joins it rather than opening a second.
    let reply = attached_task(
        &mut client,
        &owner,
        &fixture.relay,
        &attach(
            &fixture,
            &signer,
            Some(&root),
            "send-2",
            ThreadAttachMode::Open,
            "Add captions too",
            Some(&fixture.team.lead_persona_id),
        ),
    )
    .await;
    assert_eq!(
        reply.id, opened.id,
        "the rebound claim is what makes the first reply join the thread's task"
    );
}

#[tokio::test]
#[ignore = "requires a running relay with Postgres"]
async fn one_thread_holds_one_open_task_however_many_messages_it_takes() {
    let owner = owner_keys();
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let fixture = setup(&mut client, &owner, &[]).await;
    let signer = owner.public_key().to_hex();
    let root = Uuid::new_v4().simple().to_string();

    let first = attached_task(
        &mut client,
        &owner,
        &fixture.relay,
        &attach(
            &fixture,
            &signer,
            Some(&root),
            "send-1",
            ThreadAttachMode::Open,
            "Cut the release video",
            Some(&fixture.team.lead_persona_id),
        ),
    )
    .await;
    assert_eq!(first.status, TaskStatus::InProgress);
    assert_eq!(first.title, "Cut the release video");

    // A second work-implying message in the same thread. Before this change
    // it minted a second Task; now it joins the first.
    let second = attached_task(
        &mut client,
        &owner,
        &fixture.relay,
        &attach(
            &fixture,
            &signer,
            Some(&root),
            "send-2",
            ThreadAttachMode::Open,
            "Add captions too",
            Some(&fixture.team.lead_persona_id),
        ),
    )
    .await;
    assert_eq!(
        second.id, first.id,
        "a second message in one thread joins that thread's open task"
    );
    assert_eq!(
        second.title, first.title,
        "the title stays the instruction that opened the task"
    );

    // A message naming nobody, and not work at all, still charges to the open
    // task rather than running unattributed.
    let greeting = attached_task(
        &mut client,
        &owner,
        &fixture.relay,
        &attach(
            &fixture,
            &signer,
            Some(&root),
            "send-3",
            ThreadAttachMode::Attach,
            "are you there?",
            None,
        ),
    )
    .await;
    assert_eq!(
        greeting.id, first.id,
        "a non-work turn inside live work is charged to that work"
    );
}

#[tokio::test]
#[ignore = "requires a running relay with Postgres"]
async fn the_new_task_switch_opens_a_second_task_and_takes_the_thread() {
    let owner = owner_keys();
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let fixture = setup(&mut client, &owner, &[]).await;
    let signer = owner.public_key().to_hex();
    let root = Uuid::new_v4().simple().to_string();

    let first = attached_task(
        &mut client,
        &owner,
        &fixture.relay,
        &attach(
            &fixture,
            &signer,
            Some(&root),
            "send-1",
            ThreadAttachMode::Open,
            "Cut the release video",
            Some(&fixture.team.lead_persona_id),
        ),
    )
    .await;

    let parallel = attached_task(
        &mut client,
        &owner,
        &fixture.relay,
        &attach(
            &fixture,
            &signer,
            Some(&root),
            "send-2",
            ThreadAttachMode::New,
            "Meanwhile draft the launch post",
            Some(&fixture.team.lead_persona_id),
        ),
    )
    .await;
    assert_ne!(
        parallel.id, first.id,
        "an explicit new-task switch opens a second task"
    );

    // The switch is only useful if the thread now belongs to the new task:
    // otherwise the next plain reply goes back to the old one and nothing the
    // member did is observable.
    let follow_up = attached_task(
        &mut client,
        &owner,
        &fixture.relay,
        &attach(
            &fixture,
            &signer,
            Some(&root),
            "send-3",
            ThreadAttachMode::Open,
            "make it shorter",
            Some(&fixture.team.lead_persona_id),
        ),
    )
    .await;
    assert_eq!(
        follow_up.id, parallel.id,
        "later messages attach to the newest task"
    );
}

#[tokio::test]
#[ignore = "requires a running relay with Postgres"]
async fn a_closed_task_frees_its_thread_for_the_next_piece_of_work() {
    let owner = owner_keys();
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let fixture = setup(&mut client, &owner, &[]).await;
    let signer = owner.public_key().to_hex();
    let root = Uuid::new_v4().simple().to_string();

    let first = attached_task(
        &mut client,
        &owner,
        &fixture.relay,
        &attach(
            &fixture,
            &signer,
            Some(&root),
            "send-1",
            ThreadAttachMode::Open,
            "Cut the release video",
            Some(&fixture.team.lead_persona_id),
        ),
    )
    .await;

    // The owner closes it by hand, which is the other half of the close rule:
    // unanimous assignee reports, or the owner saying so.
    let head = head_of(&mut client, &fixture.relay, &first.id)
        .await
        .expect("the task head is stored");
    let stored = parse_task_event(&head).expect("the stored head parses");
    let mut closed = stored.clone();
    closed.status = TaskStatus::Cancelled;
    // Built from the head as STORED, and strictly newer than it. A
    // replacement is compare-and-set on both the head id and the timestamp,
    // so reusing the value this test read a moment earlier is refused with
    // "updatedAt must strictly increase" rather than applied.
    closed.updated_at = stored.updated_at.max(now()) + 1;
    let close_action = CompanyAction {
        relay_pubkey: fixture.relay.clone(),
        operation: CompanyActionOperation::Transition,
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        target: format!("{KIND_TASK}:{}:{}", fixture.relay, first.id),
        expected_head: Some(head.id.to_hex()),
        expected_references: Vec::new(),
        payload: CompanyActionPayload::Task(Box::new(closed)),
    };
    let (outcome, _) = broker(&mut client, &owner, &fixture.relay, &close_action).await;
    assert_eq!(
        outcome,
        CompanyReceiptOutcome::Applied,
        "the owner may close"
    );

    let next = attached_task(
        &mut client,
        &owner,
        &fixture.relay,
        &attach(
            &fixture,
            &signer,
            Some(&root),
            "send-2",
            ThreadAttachMode::Open,
            "Now write the changelog",
            Some(&fixture.team.lead_persona_id),
        ),
    )
    .await;
    assert_ne!(
        next.id, first.id,
        "work after a close opens a new task in the same thread"
    );
    assert_eq!(next.title, "Now write the changelog");
}

#[tokio::test]
#[ignore = "requires a running relay with Postgres"]
async fn a_turn_that_is_not_work_lands_on_a_hidden_chat_task() {
    let owner = owner_keys();
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let fixture = setup(&mut client, &owner, &[]).await;
    let signer = owner.public_key().to_hex();
    let root = Uuid::new_v4().simple().to_string();

    let chat = attached_task(
        &mut client,
        &owner,
        &fixture.relay,
        &attach(
            &fixture,
            &signer,
            Some(&root),
            "send-1",
            ThreadAttachMode::Attach,
            "are you there?",
            None,
        ),
    )
    .await;
    assert!(
        chat.hidden,
        "a greeting charges somewhere, but never onto the Tasks page"
    );

    let second_greeting = attached_task(
        &mut client,
        &owner,
        &fixture.relay,
        &attach(
            &fixture,
            &signer,
            Some(&root),
            "send-2",
            ThreadAttachMode::Attach,
            "hello?",
            None,
        ),
    )
    .await;
    assert_eq!(
        second_greeting.id, chat.id,
        "one hidden chat task absorbs every non-work turn in a thread"
    );

    // Real work in the same thread opens a real task rather than reusing the
    // hidden one.
    let work = attached_task(
        &mut client,
        &owner,
        &fixture.relay,
        &attach(
            &fixture,
            &signer,
            Some(&root),
            "send-3",
            ThreadAttachMode::Open,
            "Cut the release video",
            Some(&fixture.team.lead_persona_id),
        ),
    )
    .await;
    assert_ne!(work.id, chat.id);
    assert!(!work.hidden);
}

#[tokio::test]
#[ignore = "requires a running relay with Postgres"]
async fn a_second_member_working_in_one_thread_opens_their_own_task() {
    let owner = owner_keys();
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let fixture = setup(&mut client, &owner, &[]).await;
    let root = Uuid::new_v4().simple().to_string();

    let owners_task = attached_task(
        &mut client,
        &owner,
        &fixture.relay,
        &attach(
            &fixture,
            &owner.public_key().to_hex(),
            Some(&root),
            "send-1",
            ThreadAttachMode::Open,
            "Cut the release video",
            Some(&fixture.team.lead_persona_id),
        ),
    )
    .await;

    let member = Keys::generate();
    seed_member(&member, "member", None).await;
    let mut member_client = BuzzTestClient::connect(&relay_url(), &member)
        .await
        .expect("connect as the second member");
    let members_task = attached_task(
        &mut member_client,
        &member,
        &fixture.relay,
        &attach(
            &fixture,
            &member.public_key().to_hex(),
            Some(&root),
            "send-2",
            ThreadAttachMode::Open,
            "I need the raw footage indexed",
            Some(&fixture.team.lead_persona_id),
        ),
    )
    .await;
    assert_ne!(
        members_task.id, owners_task.id,
        "a task belongs to the member who opened it, so a second member opens their own"
    );
}

#[tokio::test]
#[ignore = "requires a running relay with Postgres"]
async fn a_dm_conversation_is_one_thread_for_its_whole_life() {
    let owner = owner_keys();
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let fixture = setup(&mut client, &owner, &[]).await;
    let signer = owner.public_key().to_hex();

    let plan = |send_id: &str, root: &str| {
        plan_thread_attach(ThreadAttachRequest {
            channel_id: &fixture.channel,
            thread_root: Some(root),
            conversation_scope: true,
            send_id,
            mode: ThreadAttachMode::Open,
            title: "look at this",
            agent_persona_id: Some(&fixture.team.lead_persona_id),
            client_organization_id: None,
            parent_task_id: None,
            owner_pubkey: &signer,
            relay_pubkey: &fixture.relay,
            now: now(),
        })
        .expect("attach plans")
    };

    let first_root = Uuid::new_v4().simple().to_string();
    let second_root = Uuid::new_v4().simple().to_string();
    let first = attached_task(
        &mut client,
        &owner,
        &fixture.relay,
        &plan("dm-1", &first_root),
    )
    .await;
    let second = attached_task(
        &mut client,
        &owner,
        &fixture.relay,
        &plan("dm-2", &second_root),
    )
    .await;
    assert_eq!(
        second.id, first.id,
        "in a DM the conversation is the thread, so both messages share one task"
    );
}

#[tokio::test]
#[ignore = "requires a running relay with Postgres"]
async fn a_task_closes_when_every_assignee_has_reported_and_takes_its_sub_task_with_it() {
    let owner = owner_keys();
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let agent = Keys::generate();
    let agent_persona = format!("persona-{}", Uuid::new_v4().simple());
    let fixture = setup(&mut client, &owner, std::slice::from_ref(&agent_persona)).await;
    publish_managed_agent(&mut client, &owner, &agent, &agent_persona).await;
    seed_member(&agent, "member", Some(&owner)).await;
    let signer = owner.public_key().to_hex();
    let root = Uuid::new_v4().simple().to_string();

    let task = attached_task(
        &mut client,
        &owner,
        &fixture.relay,
        &attach(
            &fixture,
            &signer,
            Some(&root),
            "send-1",
            ThreadAttachMode::Open,
            "Cut the release video",
            Some(&agent_persona),
        ),
    )
    .await;
    assert_eq!(task.assignee_persona_ids, vec![agent_persona.clone()]);

    // The agent splits a piece off. Only an assignee of the parent may.
    let mut agent_client = BuzzTestClient::connect(&relay_url(), &agent)
        .await
        .expect("connect as the agent");
    let sub_action = plan_thread_attach(ThreadAttachRequest {
        channel_id: &fixture.channel,
        thread_root: Some(&root),
        conversation_scope: false,
        send_id: "sub-1",
        mode: ThreadAttachMode::Open,
        title: "Render the captions pass",
        agent_persona_id: Some(&agent_persona),
        client_organization_id: None,
        parent_task_id: Some(&task.id),
        owner_pubkey: &agent.public_key().to_hex(),
        relay_pubkey: &fixture.relay,
        now: now(),
    })
    .expect("sub-task attach plans");
    let sub_task = attached_task(&mut agent_client, &agent, &fixture.relay, &sub_action).await;
    assert_eq!(sub_task.parent_task_id.as_deref(), Some(task.id.as_str()));

    // The assignee reports its own share done. That is the only thing that
    // closes a task on its own: no timer anywhere closes one.
    let report = EventBuilder::new(
        Kind::Custom(KIND_TASK_REPORT as u16),
        serde_json::json!({ "schema": "colony.task-report/v1", "note": null }).to_string(),
    )
    .tags(vec![
        Tag::parse(["task", task.id.as_str()]).expect("task tag")
    ])
    .sign_with_keys(&agent)
    .expect("report signs");
    assert!(
        send_past_transport_stall(&mut agent_client, report, "the relay answers the report")
            .await
            .accepted,
        "an assignee may report its own share complete"
    );

    let closed = await_status(&mut client, &fixture.relay, &task.id, TaskStatus::Completed).await;
    assert_eq!(closed.status, TaskStatus::Completed);
    assert_eq!(closed.reported_complete_by, vec![agent_persona.clone()]);

    let closed_child = await_status(
        &mut client,
        &fixture.relay,
        &sub_task.id,
        TaskStatus::Completed,
    )
    .await;
    assert_eq!(
        closed_child.status,
        TaskStatus::Completed,
        "a sub-task closes with its parent"
    );

    // And the thread is free again.
    let next = attached_task(
        &mut client,
        &owner,
        &fixture.relay,
        &attach(
            &fixture,
            &signer,
            Some(&root),
            "send-2",
            ThreadAttachMode::Open,
            "Now write the changelog",
            Some(&agent_persona),
        ),
    )
    .await;
    assert_ne!(next.id, task.id);
}

/// Read one relay-authored task head by coordinate.
async fn head_of(client: &mut BuzzTestClient, relay: &str, task_id: &str) -> Option<nostr::Event> {
    for _ in 0..10 {
        let id = sub_id("head");
        let filter = Filter::new()
            .kind(Kind::Custom(KIND_TASK as u16))
            .author(nostr::PublicKey::from_hex(relay).expect("relay key"))
            .identifier(task_id)
            .limit(1);
        client
            .subscribe(&id, vec![filter])
            .await
            .expect("subscribe");
        let events = client
            .collect_until_eose(&id, Duration::from_secs(5))
            .await
            .unwrap_or_default();
        let _ = client.close_subscription(&id).await;
        if let Some(event) = events.first() {
            return Some(event.clone());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    None
}

/// Poll one task head until it names the thread root the caller expects.
async fn await_thread_root(
    client: &mut BuzzTestClient,
    relay: &str,
    task_id: &str,
    root: &str,
) -> CompanyTask {
    for _ in 0..20 {
        if let Some(event) = head_of(client, relay, task_id).await {
            let task = parse_task_event(&event).expect("task head parses");
            if task.thread_root.as_deref() == Some(root) {
                return task;
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("task {task_id} never learned thread root {root}");
}

/// Poll one task head until it reaches the status the caller expects.
async fn await_status(
    client: &mut BuzzTestClient,
    relay: &str,
    task_id: &str,
    expected: TaskStatus,
) -> CompanyTask {
    for _ in 0..20 {
        if let Some(event) = head_of(client, relay, task_id).await {
            let task = parse_task_event(&event).expect("task head parses");
            if task.status == expected {
                return task;
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("task {task_id} never reached {expected:?}");
}

#[test]
fn a_thread_attach_is_carried_by_the_company_action_kind() {
    let action = plan_thread_attach(ThreadAttachRequest {
        channel_id: "engineering",
        thread_root: Some("abc"),
        conversation_scope: false,
        send_id: "send-1",
        mode: ThreadAttachMode::Open,
        title: "ship it",
        agent_persona_id: None,
        client_organization_id: None,
        parent_task_id: None,
        owner_pubkey: "ab12",
        relay_pubkey: "cd34",
        now: 1_767_225_600,
    })
    .expect("attach plans");
    let event = build_company_action(&action)
        .expect("attach builds")
        .sign_with_keys(&Keys::generate())
        .expect("attach signs");
    assert_eq!(
        event.kind.as_u16() as u32,
        KIND_COMPANY_ACTION,
        "an attach travels on the same envelope every company request does"
    );
}
