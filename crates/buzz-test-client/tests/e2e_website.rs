//! End-to-end proof of the Website Manager job broker against a real relay.
//!
//! Everything here goes through real ingest: relay members, channel members,
//! managed-agent ownership, the owner's published team, the owner-authored
//! thread root, the coordinator's schema-valid `website-job` Block instance,
//! and the relay-bundled trusted manifest the instance pins.
//!
//! # Running
//!
//! ```text
//! RELAY_URL=ws://localhost:3099 \
//! RELAY_HTTP_URL=http://localhost:3099 \
//! cargo test -p buzz-test-client --test e2e_website -- --ignored --nocapture --test-threads 1
//! ```
//!
//! Artifact-bytes seam: `revision`, `qa`, and `handover` need public HTTPS
//! manifest/report bytes, which a local relay fixture cannot serve. Those
//! paths are covered by `buzz-relay` integration tests through
//! `website_broker::apply_website_action`, whose `manifest: Option<&[u8]>`
//! parameter is the pre-fetched-bytes seam the ingest handler already threads
//! through. The suite below covers the create/beginWork/authorization/retry
//! surface that needs no network.

use std::time::Duration;

use buzz_core::company::{CompanyTeamRef, ThreadAttachMode};
use buzz_core::kind::{
    KIND_BLOCK_MANIFEST, KIND_COMPANY_RECEIPT, KIND_MANAGED_AGENT, KIND_STREAM_MESSAGE,
    KIND_STREAM_MESSAGE_V2, KIND_TASK, KIND_TEAM, KIND_WEBSITE_HEAD,
};
use buzz_core::website::{WebsiteAction, WebsiteActionOp, WEBSITE_JOB_BLOCK_HANDLE};
use buzz_sdk::company::parse_task_event;
use buzz_sdk::thread_task::{plan_thread_attach, ThreadAttachRequest};
use buzz_sdk::website::build_website_action;
use buzz_test_client::BuzzTestClient;
use nostr::{EventBuilder, Filter, Keys, Kind, Tag, Timestamp};
use uuid::Uuid;

fn relay_url() -> String {
    std::env::var("RELAY_URL").unwrap_or_else(|_| "ws://localhost:3099".to_string())
}

fn http_url() -> String {
    std::env::var("RELAY_HTTP_URL").unwrap_or_else(|_| "http://localhost:3099".to_string())
}

fn owner_keys() -> Keys {
    let secret = std::env::var("COMPANY_OWNER_SECRET").unwrap_or_else(|_| {
        "1c0ffee51c0ffee51c0ffee51c0ffee51c0ffee51c0ffee51c0ffee51c0ffee5".to_string()
    });
    Keys::parse(&secret).expect("COMPANY_OWNER_SECRET must be a 64-hex secret key")
}

fn sub_id(name: &str) -> String {
    format!("e2e-website-{name}-{}", Uuid::new_v4())
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
        .bind(&pubkey_hex)
        .bind(role)
        .execute(&pool)
        .await
        .expect("seed the member role");
    })
    .await;
}

async fn seed_channel_member(channel: &str, keys: &Keys) {
    let community = community_id().await;
    let channel_id = Uuid::parse_str(channel).expect("channel UUID");
    let pubkey = keys.public_key().to_bytes().to_vec();
    with_e2e_db(|pool| async move {
        sqlx::query(
            "INSERT INTO channel_members (community_id, channel_id, pubkey) VALUES ($1, $2, $3) \
             ON CONFLICT (community_id, channel_id, pubkey) DO NOTHING",
        )
        .bind(community)
        .bind(channel_id)
        .bind(pubkey)
        .execute(&pool)
        .await
        .expect("seed the channel member");
    })
    .await;
}

/// Seconds the relay asked the caller to wait, when this is a rate-limit
/// rejection. `None` for any other refusal, which must be returned untouched.
fn rate_limited_retry_seconds(message: &str) -> Option<u64> {
    if !message.contains("rate-limited") {
        return None;
    }
    let marker = "retry in ";
    let index = message.find(marker)? + marker.len();
    let digits: String = message[index..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse::<u64>().ok()
}

async fn send_past_transport_stall(
    client: &mut BuzzTestClient,
    event: nostr::Event,
    what: &str,
) -> buzz_ws_client::OkResponse {
    let mut rate_limit_retries = 0_u8;
    for attempt in 0..8 {
        match client.send_event(event.clone()).await {
            Ok(ok) => {
                if rate_limit_retries < 3 {
                    if let Some(seconds) = rate_limited_retry_seconds(&ok.message) {
                        rate_limit_retries += 1;
                        let wait = seconds.min(5);
                        eprintln!(
                            "{what} rate-limited, retry {rate_limit_retries}/3 in {wait}s"
                        );
                        tokio::time::sleep(Duration::from_secs(wait)).await;
                        continue;
                    }
                }
                return ok;
            }
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
            Tag::parse(["name", format!("website-e2e-{channel_uuid}").as_str()]).expect("name tag"),
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
    let ok = send_past_transport_stall(client, event, "team head").await;
    assert!(
        ok.accepted,
        "the relay must accept the team head: {}",
        ok.message
    );
}

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
    let ok = send_past_transport_stall(client, event, "managed agent head").await;
    assert!(
        ok.accepted,
        "the relay must accept the managed-agent head personas resolve through: {}",
        ok.message
    );
}

/// The relay-bundled, active `website-job` manifest event id for this community.
async fn bundled_website_job_manifest(client: &mut BuzzTestClient, relay: &str) -> String {
    let id = sub_id("manifest");
    let filter = Filter::new()
        .kind(Kind::Custom(KIND_BLOCK_MANIFEST as u16))
        .author(nostr::PublicKey::from_hex(relay).expect("relay key"))
        .limit(100);
    client
        .subscribe(&id, vec![filter])
        .await
        .expect("subscribe");
    let events = client
        .collect_until_eose(&id, Duration::from_secs(10))
        .await
        .unwrap_or_default();
    let _ = client.close_subscription(&id).await;
    for event in events {
        if event.content.contains("\"handle\":\"website-job\"") {
            return event.id.to_hex();
        }
    }
    panic!("the relay must seed the bundled website-job manifest");
}

/// Poll for the task head whose thread root is `root`.
async fn await_task_root(client: &mut BuzzTestClient, task_id: &str, root: &str) -> nostr::Event {
    for _ in 0..40 {
        let id = sub_id("task");
        let filter = Filter::new()
            .kind(Kind::Custom(KIND_TASK as u16))
            .limit(200);
        client
            .subscribe(&id, vec![filter])
            .await
            .expect("subscribe");
        let events = client
            .collect_until_eose(&id, Duration::from_secs(5))
            .await
            .unwrap_or_default();
        let _ = client.close_subscription(&id).await;
        for event in events {
            let Ok(task) = parse_task_event(&event) else {
                continue;
            };
            if task.id == task_id && task.thread_root.as_deref() == Some(root) {
                return event;
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("the task head never learned its thread root");
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

struct Fixture {
    channel: String,
    task_id: String,
    thread_root: String,
    instance_event_id: String,
    manifest_event_id: String,
    coordinator: Keys,
    personas: TeamPersonas,
}

struct TeamPersonas {
    research: String,
    build: String,
    review: String,
}

fn agent_keys(seed: u8) -> Keys {
    let secret = format!("{seed:02x}").repeat(32);
    Keys::parse(&secret).expect("deterministic agent secret")
}

async fn setup(client: &mut BuzzTestClient, owner: &Keys) -> Fixture {
    seed_member(owner, "owner", None).await;
    let relay = relay_self().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let coordinator = agent_keys(0x51);
    let research = agent_keys(0x52);
    let builder = agent_keys(0x53);
    let reviewer = agent_keys(0x54);
    for agent in [&coordinator, &research, &builder, &reviewer] {
        seed_member(agent, "member", Some(owner)).await;
    }
    let personas = TeamPersonas {
        research: format!("persona-research-{}", &suffix[..12]),
        build: format!("persona-build-{}", &suffix[..12]),
        review: format!("persona-review-{}", &suffix[..12]),
    };
    let coordinator_persona = format!("persona-coordinator-{}", &suffix[..12]);
    // Keep the id ending in the coordination slug as well as naming the
    // coordinator persona in the attach: either path must settle this team
    // without depending on another suite's coordination team.
    let team = CompanyTeamRef {
        id: format!("team-{}-company-coordination", &suffix[..12]),
        lead_persona_id: coordinator_persona.clone(),
        persona_ids: vec![
            coordinator_persona.clone(),
            personas.research.clone(),
            personas.build.clone(),
            personas.review.clone(),
        ],
    };
    publish_team(client, owner, &team).await;
    publish_managed_agent(client, owner, &coordinator, &coordinator_persona).await;
    publish_managed_agent(client, owner, &research, &personas.research).await;
    publish_managed_agent(client, owner, &builder, &personas.build).await;
    publish_managed_agent(client, owner, &reviewer, &personas.review).await;

    let channel = create_channel(owner).await;
    for keys in [owner, &coordinator, &research, &builder, &reviewer] {
        seed_channel_member(&channel, keys).await;
    }

    // The owner's ordinary message roots the thread and opens the canonical
    // task; the website job references that same task/thread.
    let send_id = format!("send-{}", &suffix[..12]);
    let attach = plan_thread_attach(ThreadAttachRequest {
        channel_id: &channel,
        thread_root: None,
        conversation_scope: false,
        send_id: &send_id,
        mode: ThreadAttachMode::Open,
        title: "Improve our website",
        agent_persona_id: Some(coordinator_persona.as_str()),
        client_organization_id: None,
        parent_task_id: None,
        owner_pubkey: &owner.public_key().to_hex(),
        relay_pubkey: &relay,
        now: now(),
    })
    .expect("attach plans");
    let attach_event = buzz_sdk::company::build_company_action(&attach)
        .expect("attach builds")
        .sign_with_keys(owner)
        .expect("attach signs");
    let attach_id = attach_event.id.to_hex();
    let attach_ok = send_past_transport_stall(client, attach_event, "thread attach").await;
    assert!(
        attach_ok.accepted,
        "the thread attach must be accepted: {}",
        attach_ok.message
    );
    let task_id = await_receipt_task(client, &relay, &attach_id).await;

    let root_event = EventBuilder::new(
        Kind::Custom(KIND_STREAM_MESSAGE_V2 as u16),
        "@Website Manager please improve our website",
    )
    .tags(vec![
        Tag::parse(["h", channel.as_str()]).expect("h tag"),
        Tag::parse(["task", task_id.as_str()]).expect("task tag"),
    ])
    .sign_with_keys(owner)
    .expect("root signs");
    let thread_root = root_event.id.to_hex();
    let root_ok = send_past_transport_stall(client, root_event, "thread root").await;
    assert!(
        root_ok.accepted,
        "the owner's root message is stored: {}",
        root_ok.message
    );
    await_task_root(client, &task_id, &thread_root).await;

    // The coordinator's schema-valid review card, inside the owner's thread.
    let manifest_event_id = bundled_website_job_manifest(client, &relay).await;
    let instance_id = Uuid::new_v4();
    let source_url = "https://source.colony.test/sites/acme";
    let brief = serde_json::json!({
        "summary": "Improve the site while keeping the brand",
        "preserve": ["wordmark"],
        "redesign": ["hero"],
        "deliverables": ["preview", "source archive"]
    });
    let data = serde_json::json!({
        "taskId": task_id,
        "threadRoot": thread_root,
        "sourceUrl": source_url,
        "brief": brief,
    });
    let canonical = buzz_core::block::canonical_json(&data).expect("canonical instance data");
    let instance_event = EventBuilder::new(Kind::Custom(KIND_STREAM_MESSAGE as u16), "Website job")
        .tags(vec![
            Tag::parse(["h", channel.as_str()]).expect("h tag"),
            Tag::parse([
                "block",
                "1",
                WEBSITE_JOB_BLOCK_HANDLE,
                manifest_event_id.as_str(),
                instance_id.to_string().as_str(),
            ])
            .expect("block tag"),
            // The instance must reference the exact manifest event under the
            // `block` marker; a bare `block` tag is not enough.
            Tag::parse(["e", manifest_event_id.as_str(), "", "block"]).expect("manifest tag"),
            Tag::parse(["block-data", canonical.as_str()]).expect("data tag"),
            Tag::parse([
                "block-processor",
                "1",
                coordinator.public_key().to_hex().as_str(),
            ])
            .expect("processor tag"),
            Tag::parse(["p", owner.public_key().to_hex().as_str()]).expect("attention tag"),
            Tag::parse(["e", thread_root.as_str(), "", "reply"]).expect("reply tag"),
        ])
        .sign_with_keys(&coordinator)
        .expect("instance signs");
    let instance_event_id = instance_event.id.to_hex();
    // The relay refuses an event whose pubkey is not the authenticated
    // identity, so every signer needs its own connection.
    let mut coordinator_client = BuzzTestClient::connect(&relay_url(), &coordinator)
        .await
        .expect("connect as coordinator");
    let instance_ok =
        send_past_transport_stall(&mut coordinator_client, instance_event, "review instance").await;
    assert!(
        instance_ok.accepted,
        "the review card instance must be accepted by generic Block validation: {}",
        instance_ok.message
    );

    Fixture {
        channel,
        task_id,
        thread_root,
        instance_event_id,
        manifest_event_id,
        coordinator,
        personas,
    }
}

async fn await_receipt_task(client: &mut BuzzTestClient, relay: &str, action_id: &str) -> String {
    for _ in 0..40 {
        let id = sub_id("receipt");
        let filter = Filter::new()
            .kind(Kind::Custom(KIND_COMPANY_RECEIPT as u16))
            .author(nostr::PublicKey::from_hex(relay).expect("relay key"))
            .event(nostr::EventId::from_hex(action_id).expect("action id"))
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
            let receipt = buzz_sdk::company::parse_company_receipt(event).expect("receipt");
            assert_eq!(
                receipt.outcome,
                buzz_sdk::company::CompanyReceiptOutcome::Applied
            );
            let head_id = receipt.head_event_id.expect("attach names its head");
            let head = event_by_id(client, &head_id)
                .await
                .expect("task head stored");
            let task = parse_task_event(&head).expect("task parses");
            return task.id;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("the relay never answered the thread attach");
}

fn create_action(fixture: &Fixture, coordinator_hex: &str) -> WebsiteAction {
    WebsiteAction {
        channel_id: Uuid::parse_str(&fixture.channel).expect("channel"),
        task_id: fixture.task_id.clone(),
        thread_root: fixture.thread_root.clone(),
        instance_event_id: Some(fixture.instance_event_id.clone()),
        manifest_event_id: Some(fixture.manifest_event_id.clone()),
        request_id: Uuid::new_v4(),
        generation: None,
        actor: fixture.coordinator.public_key(),
        op: WebsiteActionOp::Create {
            coordinator: coordinator_hex.to_owned(),
            source_url: "https://source.colony.test/sites/acme".to_owned(),
            research_personas: vec![fixture.personas.research.clone()],
            build_personas: vec![fixture.personas.build.clone()],
            review_personas: vec![fixture.personas.review.clone()],
        },
    }
}

async fn send_action(
    client: &mut BuzzTestClient,
    keys: &Keys,
    action: &WebsiteAction,
) -> buzz_ws_client::OkResponse {
    let event = build_website_action(action)
        .expect("action builds")
        .sign_with_keys(keys)
        .expect("action signs");
    send_past_transport_stall(client, event, "website action").await
}

async fn job_row_generation(task_id: &str) -> Option<i64> {
    let community = community_id().await;
    with_e2e_db(|pool| async move {
        sqlx::query_scalar(
            "SELECT generation FROM website_jobs WHERE community_id = $1 AND task_id = $2",
        )
        .bind(community)
        .bind(task_id)
        .fetch_optional(&pool)
        .await
        .expect("read website job generation")
    })
    .await
}

#[tokio::test]
#[ignore = "requires a running relay with Postgres"]
async fn owner_create_commits_a_head_receipt_and_job_row() {
    let owner = owner_keys();
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let fixture = setup(&mut client, &owner).await;
    let coordinator_hex = fixture.coordinator.public_key().to_hex();

    let action = create_action(&fixture, &coordinator_hex);
    let ok = send_action(&mut client, &owner, &action).await;
    assert!(
        ok.accepted,
        "owner create must be accepted: {:?}",
        ok.message
    );
    assert_eq!(job_row_generation(&fixture.task_id).await, Some(1));

    let message: serde_json::Value = serde_json::from_str(&ok.message).expect("result json");
    let head_event_id = message["head_event_id"]
        .as_str()
        .expect("create receipt names its head");
    let head = event_by_id(&mut client, head_event_id)
        .await
        .expect("head stored");
    assert_eq!(head.kind.as_u16() as u32, KIND_WEBSITE_HEAD);
    let review = buzz_sdk::website::parse_website_head(&head).expect("head review parses");
    assert_eq!(review.status, buzz_core::website::WebsiteStatus::Draft);
    assert_eq!(review.owner, owner.public_key().to_hex());

    // Exact retry: same signed action returns the recorded result.
    let event = build_website_action(&action)
        .expect("action builds")
        .sign_with_keys(&owner)
        .expect("action signs");
    let action_id = event.id.to_hex();
    let retry = send_past_transport_stall(&mut client, event, "exact create retry").await;
    assert!(retry.accepted, "an exact retry is answered, not refused");
    let retry_message = retry.message.as_str();
    assert!(
        retry_message.contains(&action_id),
        "the retry names the original action: {retry_message}"
    );
    assert_eq!(
        job_row_generation(&fixture.task_id).await,
        Some(1),
        "a retry must not advance the generation"
    );
}

#[tokio::test]
#[ignore = "requires a running relay with Postgres"]
async fn coordinator_agent_create_is_accepted_for_its_owners_job() {
    let owner = owner_keys();
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let fixture = setup(&mut client, &owner).await;
    let coordinator_hex = fixture.coordinator.public_key().to_hex();
    let action = create_action(&fixture, &coordinator_hex);

    let mut coordinator_client = BuzzTestClient::connect(&relay_url(), &fixture.coordinator)
        .await
        .expect("connect as coordinator");
    let ok = send_action(&mut coordinator_client, &fixture.coordinator, &action).await;
    assert!(
        ok.accepted,
        "the coordinator must create its owner's job: {:?}",
        ok.message
    );
}

#[tokio::test]
#[ignore = "requires a running relay with Postgres"]
async fn an_unassigned_agent_cannot_create() {
    let owner = owner_keys();
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let fixture = setup(&mut client, &owner).await;
    let outsider = agent_keys(0x55);
    seed_member(&outsider, "member", Some(&owner)).await;
    seed_channel_member(&fixture.channel, &outsider).await;
    let coordinator_hex = fixture.coordinator.public_key().to_hex();

    let mut action = create_action(&fixture, &coordinator_hex);
    action.actor = outsider.public_key();
    let mut outsider_client = BuzzTestClient::connect(&relay_url(), &outsider)
        .await
        .expect("connect as outsider");
    let ok = send_action(&mut outsider_client, &outsider, &action).await;
    assert!(
        !ok.accepted,
        "an agent without the installed team's persona cannot create"
    );
    assert!(job_row_generation(&fixture.task_id).await.is_none());
}

#[tokio::test]
#[ignore = "requires a running relay with Postgres"]
async fn begin_work_requires_the_current_generation() {
    let owner = owner_keys();
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let fixture = setup(&mut client, &owner).await;
    let coordinator_hex = fixture.coordinator.public_key().to_hex();
    let create = create_action(&fixture, &coordinator_hex);
    assert!(send_action(&mut client, &owner, &create).await.accepted);

    let build_action = |generation: u64| WebsiteAction {
        channel_id: Uuid::parse_str(&fixture.channel).expect("channel"),
        task_id: fixture.task_id.clone(),
        thread_root: fixture.thread_root.clone(),
        instance_event_id: None,
        manifest_event_id: None,
        request_id: Uuid::new_v4(),
        generation: Some(generation),
        actor: owner.public_key(),
        op: WebsiteActionOp::BeginWork,
    };

    let stale = send_action(&mut client, &owner, &build_action(99)).await;
    assert!(!stale.accepted, "a stale generation must be refused");
    assert_eq!(job_row_generation(&fixture.task_id).await, Some(1));

    let fresh = send_action(&mut client, &owner, &build_action(1)).await;
    assert!(
        fresh.accepted,
        "the current generation is applied: {:?}",
        fresh.message
    );
    assert_eq!(job_row_generation(&fixture.task_id).await, Some(2));
}

#[tokio::test]
#[ignore = "requires a running relay with Postgres"]
async fn a_stranger_cannot_read_or_advance_the_job() {
    let owner = owner_keys();
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let fixture = setup(&mut client, &owner).await;
    let coordinator_hex = fixture.coordinator.public_key().to_hex();
    let create = create_action(&fixture, &coordinator_hex);
    assert!(send_action(&mut client, &owner, &create).await.accepted);

    let stranger = agent_keys(0x56);
    seed_member(&stranger, "member", Some(&owner)).await;
    seed_channel_member(&fixture.channel, &stranger).await;
    let mut begin = WebsiteAction {
        channel_id: Uuid::parse_str(&fixture.channel).expect("channel"),
        task_id: fixture.task_id.clone(),
        thread_root: fixture.thread_root.clone(),
        instance_event_id: None,
        manifest_event_id: None,
        request_id: Uuid::new_v4(),
        generation: Some(1),
        actor: stranger.public_key(),
        op: WebsiteActionOp::BeginWork,
    };
    begin.actor = stranger.public_key();
    let mut stranger_client = BuzzTestClient::connect(&relay_url(), &stranger)
        .await
        .expect("connect as stranger");
    let ok = send_action(&mut stranger_client, &stranger, &begin).await;
    assert!(!ok.accepted, "a stranger cannot advance someone else's job");
    assert_eq!(job_row_generation(&fixture.task_id).await, Some(1));
}

#[tokio::test]
#[ignore = "requires a running relay with Postgres"]
async fn a_mismatched_request_payload_is_refused() {
    let owner = owner_keys();
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let fixture = setup(&mut client, &owner).await;
    let coordinator_hex = fixture.coordinator.public_key().to_hex();
    let create = create_action(&fixture, &coordinator_hex);
    assert!(send_action(&mut client, &owner, &create).await.accepted);

    let mut conflicting = create.clone();
    conflicting.request_id = create.request_id;
    conflicting.op = WebsiteActionOp::Create {
        coordinator: coordinator_hex.clone(),
        source_url: "https://source.colony.test/other".to_owned(),
        research_personas: vec![fixture.personas.research.clone()],
        build_personas: vec![fixture.personas.build.clone()],
        review_personas: vec![fixture.personas.review.clone()],
    };
    let ok = send_action(&mut client, &owner, &conflicting).await;
    assert!(
        !ok.accepted,
        "the same request UUID with a different payload is a conflict"
    );
}

#[tokio::test]
#[ignore = "requires a running relay with Postgres"]
async fn builder_and_reviewer_cannot_be_the_same_agent() {
    let owner = owner_keys();
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let fixture = setup(&mut client, &owner).await;
    let coordinator_hex = fixture.coordinator.public_key().to_hex();
    let mut action = create_action(&fixture, &coordinator_hex);
    // Same persona named for build and review; the parser refuses the overlap
    // before any storage.
    action.op = WebsiteActionOp::Create {
        coordinator: coordinator_hex,
        source_url: "https://source.colony.test/sites/acme".to_owned(),
        research_personas: vec![fixture.personas.research.clone()],
        build_personas: vec![fixture.personas.build.clone()],
        review_personas: vec![fixture.personas.build.clone()],
    };
    let ok = send_action(&mut client, &owner, &action).await;
    assert!(
        !ok.accepted,
        "an overlapping build/review persona is refused"
    );
    assert!(job_row_generation(&fixture.task_id).await.is_none());
}
