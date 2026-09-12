//! End-to-end proof of the Website Manager job broker against a real relay.
//!
//! Everything here goes through real ingest: relay members, channel members,
//! managed-agent ownership, the owner's published team, the owner-authored
//! thread root, the coordinator's schema-valid `website-job` Block instance,
//! and the relay-bundled trusted manifest the instance pins. The lifecycle
//! case at the end additionally fetches immutable public fixture manifests and
//! QA reports through the production bounded fetcher.
//!
//! # Running
//!
//! ```text
//! RELAY_URL=ws://localhost:3099 \
//! RELAY_HTTP_URL=http://localhost:3099 \
//! cargo test -p buzz-test-client --test e2e_website -- --ignored --nocapture --test-threads 1
//! ```
//!
//! The tenant-scoped private Blossom case is feature-gated and runs in the
//! dedicated GitHub job after its relay has been seeded with an HTTPS-shaped
//! tenant host:
//!
//! ```text
//! cargo test -p buzz-test-client --features private-website-proof \
//!   --test e2e_website \
//!   e2e_website_private::private_blossom_website_lifecycle_is_tenant_scoped \
//!   -- --ignored --exact --nocapture --test-threads 1
//! ```
//!
//! Artifact bytes are fetched by the broker from public HTTPS URLs, and the
//! local relay's bounded fetcher rejects localhost and private addresses. The
//! lifecycle case uses immutable public fixture URLs so real ingest and
//! artifact validation are exercised without weakening the production SSRF
//! policy. The archive and capture refs in that synthetic case are structural
//! refs only: handover validates them against the revision while the broker
//! fetches the manifest and QA report bytes.

use std::time::Duration;

use buzz_core::block::BlockManifest;
use buzz_core::company::{CompanyTeamRef, ThreadAttachMode};
use buzz_core::kind::{
    KIND_BLOCK_MANIFEST, KIND_COMPANY_RECEIPT, KIND_MANAGED_AGENT, KIND_STREAM_MESSAGE,
    KIND_STREAM_MESSAGE_V2, KIND_TASK, KIND_TEAM, KIND_WEBSITE_HEAD,
};
use buzz_core::website::{
    HandoverAsset, PreviewArtifactRef, WebsiteAction, WebsiteActionOp, WebsiteCaptures,
    WEBSITE_ACTION_SCHEMA, WEBSITE_APPROVE_ACTION_ID, WEBSITE_JOB_BLOCK_HANDLE,
    WEBSITE_REQUEST_CHANGES_ACTION_ID,
};
use buzz_sdk::blocks::{build_block_action, BlockActionInput};
use buzz_sdk::company::parse_task_event;
use buzz_sdk::thread_task::{plan_thread_attach, ThreadAttachRequest};
use buzz_sdk::website::{build_website_action, build_website_qa_task_report};
use buzz_test_client::BuzzTestClient;
use nostr::{Event, EventBuilder, EventId, Filter, Keys, Kind, Tag, Timestamp};
use uuid::Uuid;

const WEBSITE_FIXTURE_COMMIT: &str = "b6cd791e7172163d2ce7b01b14a2032f89846209";
const REVISION_1_MANIFEST_SHA256: &str =
    "2094c69a758b315af3424d12afbefef6afb2ce1e63a9be575863ea0bf6073d0c";
const REVISION_1_REPORT_SHA256: &str =
    "557c75322777030a01fb4f217bede7a2c21f9b6fd671781854b4de7cc8c47fe4";
const REVISION_2_MANIFEST_SHA256: &str =
    "bf61203da3b662a8a23cd07ad6b9c7887f57878f5c58e66e1917b7f4fd303511";
const REVISION_2_REPORT_SHA256: &str =
    "81185ae0f9717b2205ea57f80026b89b2df0308a2f0e5f12038a233bcc170540";

const REVISION_1_ENTRY_URL: &str =
    "https://raw.githubusercontent.com/AI-Native-Ventures/Colony/b7e18f9a26c663a0b35d4234f9cf008430849e52/crates/buzz-browser/test-fixtures/other.html";
const REVISION_1_ENTRY_SHA256: &str =
    "810a3f1fded27c7bb0fc44e0a1b5f02539e40ee900b4d2a98407083419b760aa";
const REVISION_2_ENTRY_URL: &str =
    "https://raw.githubusercontent.com/AI-Native-Ventures/Colony/b7e18f9a26c663a0b35d4234f9cf008430849e52/crates/buzz-browser/test-fixtures/index.html";
const REVISION_2_ENTRY_SHA256: &str =
    "8a9653da7b251e47497e881e9603fa46ef6412147ae777aeca894e4120eba090";

fn website_fixture_url(file: &str) -> String {
    format!(
        "https://raw.githubusercontent.com/AI-Native-Ventures/Colony/{WEBSITE_FIXTURE_COMMIT}/crates/buzz-test-client/tests/fixtures/website/{file}"
    )
}

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
                        eprintln!("{what} rate-limited, retry {rate_limit_retries}/3 in {wait}s");
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
    // Every test in this file re-seeds the same four agents, and a
    // parameterized-replaceable head published inside the same second as the
    // previous test's is refused as superseded. The precondition this seeding
    // exists for is that a head is there for personas to resolve through, and
    // a newer one already being stored satisfies it.
    let already_current = ok.message.contains("superseded");
    assert!(
        ok.accepted || already_current,
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
    instance_id: Uuid,
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
            // Attention must be declared for the `p` tag to become the
            // decision maker the website authority pins against.
            Tag::parse(["block-attention", "1", "required"]).expect("attention declaration"),
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
        instance_id,
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
        target_pubkey: None,
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

fn artifact_ref(url: impl Into<String>, sha256: &str) -> PreviewArtifactRef {
    PreviewArtifactRef {
        url: url.into(),
        sha256: sha256.to_owned(),
    }
}

fn revision_manifest_ref(revision: u32) -> PreviewArtifactRef {
    let (file, sha256) = match revision {
        1 => ("revision-1-manifest.json", REVISION_1_MANIFEST_SHA256),
        2 => ("revision-2-manifest.json", REVISION_2_MANIFEST_SHA256),
        other => panic!("the lifecycle fixture has no revision {other}"),
    };
    artifact_ref(website_fixture_url(file), sha256)
}

fn revision_entry_ref(revision: u32) -> PreviewArtifactRef {
    match revision {
        1 => artifact_ref(REVISION_1_ENTRY_URL, REVISION_1_ENTRY_SHA256),
        2 => artifact_ref(REVISION_2_ENTRY_URL, REVISION_2_ENTRY_SHA256),
        other => panic!("the lifecycle fixture has no revision {other}"),
    }
}

fn update_action(
    fixture: &Fixture,
    actor: &Keys,
    generation: u64,
    op: WebsiteActionOp,
) -> WebsiteAction {
    let target_pubkey = matches!(&op, &WebsiteActionOp::BeginWork)
        .then(|| fixture.coordinator.public_key().to_hex());
    WebsiteAction {
        channel_id: Uuid::parse_str(&fixture.channel).expect("channel"),
        task_id: fixture.task_id.clone(),
        thread_root: fixture.thread_root.clone(),
        instance_event_id: None,
        manifest_event_id: None,
        request_id: Uuid::new_v4(),
        generation: Some(generation),
        actor: actor.public_key(),
        target_pubkey,
        op,
    }
}

fn add_revision_action(
    fixture: &Fixture,
    builder: &Keys,
    generation: u64,
    revision: u32,
) -> WebsiteAction {
    let manifest = revision_manifest_ref(revision);
    let entry = revision_entry_ref(revision);
    // The public fixture commit contains only manifest and QA JSON. The
    // broker fetches and verifies the manifest here; archive and capture refs
    // remain structural evidence for this synthetic lifecycle.
    WebsiteAction {
        channel_id: Uuid::parse_str(&fixture.channel).expect("channel"),
        task_id: fixture.task_id.clone(),
        thread_root: fixture.thread_root.clone(),
        instance_event_id: None,
        manifest_event_id: None,
        request_id: Uuid::new_v4(),
        generation: Some(generation),
        actor: builder.public_key(),
        target_pubkey: None,
        op: WebsiteActionOp::AddRevision {
            revision,
            manifest: manifest.clone(),
            source_url: "https://source.colony.test/sites/acme".to_owned(),
            archive: manifest,
            captures: WebsiteCaptures {
                before: entry.clone(),
                desktop: entry.clone(),
                mobile: entry,
            },
        },
    }
}

fn qa_fixture(revision: u32) -> (&'static str, &'static str) {
    match revision {
        1 => ("revision-1-qa.json", REVISION_1_REPORT_SHA256),
        2 => ("revision-2-qa.json", REVISION_2_REPORT_SHA256),
        other => panic!("the lifecycle fixture has no QA report for revision {other}"),
    }
}

async fn publish_qa_report(
    client: &mut BuzzTestClient,
    reviewer: &Keys,
    fixture: &Fixture,
    revision: u32,
    manifest_sha256: &str,
) -> String {
    let (file, report_sha256) = qa_fixture(revision);
    let report_url = website_fixture_url(file);
    let event = build_website_qa_task_report(
        &fixture.task_id,
        revision,
        manifest_sha256,
        &report_url,
        report_sha256,
        "independent QA inspected the immutable public fixture",
    )
    .expect("QA task report builds")
    .sign_with_keys(reviewer)
    .expect("QA task report signs");
    let event_id = event.id.to_hex();
    let ok = send_past_transport_stall(client, event, "QA task report").await;
    assert!(
        ok.accepted,
        "the assigned reviewer task report must be accepted: {}",
        ok.message
    );
    event_id
}

async fn website_head_from_response(
    client: &mut BuzzTestClient,
    ok: &buzz_ws_client::OkResponse,
) -> (Event, buzz_core::website::WebsiteReview) {
    assert!(
        ok.accepted,
        "website transition must be accepted: {}",
        ok.message
    );
    let message: serde_json::Value = serde_json::from_str(&ok.message).expect("result JSON");
    assert!(
        message["receipt_event_id"].as_str().is_some(),
        "accepted website transition names its receipt: {}",
        ok.message
    );
    let head_event_id = message["head_event_id"]
        .as_str()
        .expect("accepted website transition names its head");
    let head = event_by_id(client, head_event_id)
        .await
        .expect("website head stored");
    assert_eq!(head.kind.as_u16() as u32, KIND_WEBSITE_HEAD);
    let review = buzz_sdk::website::parse_website_head(&head).expect("head review parses");
    (head, review)
}

fn assert_head_generation(head: &Event, expected: u64) {
    let generation = head
        .tags
        .iter()
        .find_map(|tag| {
            let parts = tag.as_slice();
            (parts.len() == 2 && parts[0] == "generation").then(|| parts[1].parse::<u64>())
        })
        .expect("website head carries a generation")
        .expect("website head generation is numeric");
    assert_eq!(generation, expected);
}

fn decision_data(
    job_id: Uuid,
    task_id: &str,
    generation: u64,
    revision: u32,
    manifest_sha256: &str,
    note: Option<&str>,
) -> serde_json::Value {
    let mut data = serde_json::json!({
        "schema": WEBSITE_ACTION_SCHEMA,
        "jobId": job_id.to_string(),
        "taskId": task_id,
        "generation": generation,
        "revision": revision,
        "manifestSha256": manifest_sha256,
    });
    if let Some(note) = note {
        data.as_object_mut()
            .expect("decision data is an object")
            .insert(
                "note".to_owned(),
                serde_json::Value::String(note.to_owned()),
            );
    }
    data
}

fn block_decision_event(
    fixture: &Fixture,
    owner: &Keys,
    manifest: &BlockManifest,
    action_id: &str,
    data: serde_json::Value,
    idempotency_key: Uuid,
) -> Event {
    build_block_action(&BlockActionInput {
        channel_id: Uuid::parse_str(&fixture.channel).expect("channel"),
        processor: fixture.coordinator.public_key(),
        instance_event_id: EventId::from_hex(&fixture.instance_event_id).expect("instance event"),
        manifest_id: EventId::from_hex(&fixture.manifest_event_id).expect("manifest event"),
        instance_id: fixture.instance_id,
        manifest,
        action_id: action_id.to_owned(),
        data,
        idempotency_key: Some(idempotency_key),
    })
    .expect("website Block decision builds against the trusted manifest")
    .builder
    .sign_with_keys(owner)
    .expect("website Block decision signs")
}

#[allow(clippy::too_many_arguments)] // Test helper mirrors the signed Block action fields.
async fn send_block_decision(
    client: &mut BuzzTestClient,
    fixture: &Fixture,
    owner: &Keys,
    manifest: &BlockManifest,
    action_id: &str,
    data: serde_json::Value,
    idempotency_key: Uuid,
    what: &str,
) -> buzz_ws_client::OkResponse {
    let event = block_decision_event(fixture, owner, manifest, action_id, data, idempotency_key);
    send_past_transport_stall(client, event, what).await
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
    let create_event = build_website_action(&action)
        .expect("action builds")
        .sign_with_keys(&owner)
        .expect("action signs");
    let original_action_id = create_event.id.to_hex();
    let ok = send_past_transport_stall(&mut client, create_event, "website action").await;
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
    let receipt_event_id = message["receipt_event_id"]
        .as_str()
        .expect("create receipt names its receipt");
    let head = event_by_id(&mut client, head_event_id)
        .await
        .expect("head stored");
    assert_eq!(head.kind.as_u16() as u32, KIND_WEBSITE_HEAD);
    let review = buzz_sdk::website::parse_website_head(&head).expect("head review parses");
    assert_eq!(review.status, buzz_core::website::WebsiteStatus::Draft);
    assert_eq!(review.owner, owner.public_key().to_hex());

    // Exact retry: the same action, re-signed, returns the recorded result.
    //
    // Nostr stamps `created_at` in whole seconds, so re-signing inside the same
    // second produces a byte-identical event that the relay answers from the
    // recorded claim. Crossing a second boundary makes the retry a genuinely
    // distinct signed event that still carries the same request id, which is
    // the real retry contract this block exists to prove.
    tokio::time::sleep(Duration::from_millis(1_100)).await;
    let event = build_website_action(&action)
        .expect("action builds")
        .sign_with_keys(&owner)
        .expect("action signs");
    let retry = send_past_transport_stall(&mut client, event, "exact create retry").await;
    assert!(
        retry.accepted,
        "an exact retry is answered, not refused: {:?}",
        retry.message
    );
    let retry_message = retry.message.as_str();
    assert!(
        retry_message.contains(&original_action_id),
        "the retry names the original action: {retry_message}"
    );
    assert!(
        retry_message.contains(head_event_id),
        "the retry returns the recorded head: {retry_message}"
    );
    assert!(
        retry_message.contains(receipt_event_id),
        "the retry returns the recorded receipt: {retry_message}"
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
        "an agent without the installed team's persona cannot create: {}",
        ok.message
    );
    assert!(
        ok.message
            .contains("may only create the website job it coordinates"),
        "the refusal must be about coordinator ownership, not a broken fixture: {}",
        ok.message
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
        target_pubkey: Some(fixture.coordinator.public_key().to_hex()),
        op: WebsiteActionOp::BeginWork,
    };

    let stale = send_action(&mut client, &owner, &build_action(99)).await;
    assert!(
        !stale.accepted,
        "a stale generation must be refused: {}",
        stale.message
    );
    assert!(
        stale.message.contains("website job generation conflict"),
        "the stale refusal must be the generation CAS, not a broken fixture: {}",
        stale.message
    );
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
        target_pubkey: Some(fixture.coordinator.public_key().to_hex()),
        op: WebsiteActionOp::BeginWork,
    };
    begin.actor = stranger.public_key();
    let mut stranger_client = BuzzTestClient::connect(&relay_url(), &stranger)
        .await
        .expect("connect as stranger");
    let ok = send_action(&mut stranger_client, &stranger, &begin).await;
    assert!(
        !ok.accepted,
        "a stranger cannot advance someone else's job: {}",
        ok.message
    );
    assert!(
        ok.message.contains("website job unavailable"),
        "the stranger refusal must be the non-revealing job refusal, not a broken fixture: {}",
        ok.message
    );
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
        "the same request UUID with a different payload is a conflict: {}",
        ok.message
    );
    assert!(
        ok.message
            .contains("website request replay carries a different payload"),
        "the conflict refusal must be the replay-digest check, not a broken fixture: {}",
        ok.message
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
        "an overlapping build/review persona is refused: {}",
        ok.message
    );
    assert!(
        ok.message
            .contains("invalid persona list for reviewPersonas"),
        "the overlap refusal must be the persona-list parser, not a broken fixture: {}",
        ok.message
    );
    assert!(job_row_generation(&fixture.task_id).await.is_none());
}

#[tokio::test]
#[ignore = "requires a running relay with Postgres and public fixture fetches"]
async fn public_artifact_lifecycle_reaches_handover_and_rejects_replays() {
    let owner = owner_keys();
    let mut owner_client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let fixture = setup(&mut owner_client, &owner).await;
    let builder = agent_keys(0x53);
    let reviewer = agent_keys(0x54);
    let mut builder_client = BuzzTestClient::connect(&relay_url(), &builder)
        .await
        .expect("connect as builder");
    let mut reviewer_client = BuzzTestClient::connect(&relay_url(), &reviewer)
        .await
        .expect("connect as reviewer");
    let mut coordinator_client = BuzzTestClient::connect(&relay_url(), &fixture.coordinator)
        .await
        .expect("connect as coordinator");

    let job_id =
        WebsiteAction::derive_job_id(community_id().await, &fixture.task_id, &fixture.thread_root);
    let manifest_event = event_by_id(&mut owner_client, &fixture.manifest_event_id)
        .await
        .expect("the pinned website-job manifest is stored");
    let block_manifest = buzz_core::block::parse_manifest(&manifest_event.content)
        .expect("the pinned website-job manifest parses");

    let coordinator_hex = fixture.coordinator.public_key().to_hex();
    let create = create_action(&fixture, &coordinator_hex);
    let create_ok = send_action(&mut owner_client, &owner, &create).await;
    let (head, review) = website_head_from_response(&mut owner_client, &create_ok).await;
    assert_head_generation(&head, 1);
    assert_eq!(review.status, buzz_core::website::WebsiteStatus::Draft);
    assert_eq!(review.current_revision, 0);
    assert_eq!(job_row_generation(&fixture.task_id).await, Some(1));

    let begin = update_action(&fixture, &owner, 1, WebsiteActionOp::BeginWork);
    let begin_ok = send_action(&mut owner_client, &owner, &begin).await;
    let (head, review) = website_head_from_response(&mut owner_client, &begin_ok).await;
    assert_head_generation(&head, 2);
    assert_eq!(review.status, buzz_core::website::WebsiteStatus::Working);

    let add_revision_1 = add_revision_action(&fixture, &builder, 2, 1);
    let add_revision_1_ok = send_action(&mut builder_client, &builder, &add_revision_1).await;
    let (head, review) = website_head_from_response(&mut builder_client, &add_revision_1_ok).await;
    assert_head_generation(&head, 3);
    assert_eq!(review.status, buzz_core::website::WebsiteStatus::Working);
    assert_eq!(review.current_revision, 1);
    assert_eq!(review.revisions[0].built_by, builder.public_key().to_hex());
    assert!(review.revisions[0].qa.is_none());

    let report_1 = publish_qa_report(
        &mut reviewer_client,
        &reviewer,
        &fixture,
        1,
        REVISION_1_MANIFEST_SHA256,
    )
    .await;
    let record_qa_1 = update_action(
        &fixture,
        &reviewer,
        3,
        WebsiteActionOp::RecordQa {
            revision: 1,
            passed: true,
            report_event_id: report_1,
            report: artifact_ref(
                website_fixture_url("revision-1-qa.json"),
                REVISION_1_REPORT_SHA256,
            ),
        },
    );
    let record_qa_1_ok = send_action(&mut reviewer_client, &reviewer, &record_qa_1).await;
    let (head, review) = website_head_from_response(&mut reviewer_client, &record_qa_1_ok).await;
    assert_head_generation(&head, 4);
    assert_eq!(review.status, buzz_core::website::WebsiteStatus::Working);
    assert_eq!(
        review.revisions[0].qa.as_ref().map(|qa| qa.passed),
        Some(true)
    );
    assert_eq!(
        review.revisions[0]
            .qa
            .as_ref()
            .expect("revision 1 QA")
            .reviewer,
        reviewer.public_key().to_hex()
    );

    let ready_1 = update_action(&fixture, &fixture.coordinator, 4, WebsiteActionOp::Ready);
    let ready_1_ok = send_action(&mut coordinator_client, &fixture.coordinator, &ready_1).await;
    let (head, review) = website_head_from_response(&mut coordinator_client, &ready_1_ok).await;
    assert_head_generation(&head, 5);
    assert_eq!(
        review.status,
        buzz_core::website::WebsiteStatus::ReadyForReview
    );
    assert_eq!(review.current_revision, 1);

    let request_changes_key = Uuid::new_v4();
    let request_changes_data = decision_data(
        job_id,
        &fixture.task_id,
        5,
        1,
        REVISION_1_MANIFEST_SHA256,
        Some("Keep the wordmark, but revise the mobile hero before approval."),
    );
    let request_changes = send_block_decision(
        &mut owner_client,
        &fixture,
        &owner,
        &block_manifest,
        WEBSITE_REQUEST_CHANGES_ACTION_ID,
        request_changes_data.clone(),
        request_changes_key,
        "owner request changes",
    )
    .await;
    let (head, review) = website_head_from_response(&mut owner_client, &request_changes).await;
    assert_head_generation(&head, 6);
    assert_eq!(
        review.status,
        buzz_core::website::WebsiteStatus::ChangesRequested
    );
    assert_eq!(review.current_revision, 1);
    assert_eq!(review.decisions.len(), 1);
    assert_eq!(job_row_generation(&fixture.task_id).await, Some(6));
    let changes_head_id = head.id.to_hex();

    // Re-sign the exact decision after crossing a Nostr timestamp boundary.
    // The relay must return the original action/head/receipt and leave the
    // review at generation 6.
    tokio::time::sleep(Duration::from_millis(1_100)).await;
    let replay = send_block_decision(
        &mut owner_client,
        &fixture,
        &owner,
        &block_manifest,
        WEBSITE_REQUEST_CHANGES_ACTION_ID,
        request_changes_data,
        request_changes_key,
        "replayed owner request changes",
    )
    .await;
    assert!(
        replay.accepted,
        "exact Block replay is accepted: {}",
        replay.message
    );
    const DUPLICATE_PREFIX: &str = "duplicate: ";
    assert!(
        replay.message.starts_with(DUPLICATE_PREFIX),
        "exact Block replay must carry the idempotent duplicate discriminator: {}",
        replay.message
    );
    let replay_body = replay
        .message
        .strip_prefix(DUPLICATE_PREFIX)
        .expect("duplicate prefix was asserted above");
    let replay_message: serde_json::Value =
        serde_json::from_str(replay_body).unwrap_or_else(|error| {
            panic!("replay result JSON after duplicate prefix: {error}; body={replay_body}")
        });
    assert_eq!(
        replay_message["action_event_id"].as_str(),
        Some(request_changes.event_id.as_str()),
        "replay identifies the original owner action"
    );
    assert_eq!(
        replay_message["head_event_id"].as_str(),
        Some(changes_head_id.as_str()),
        "replay returns the original changes-requested head"
    );
    assert_eq!(job_row_generation(&fixture.task_id).await, Some(6));

    let conflicting_request = decision_data(
        job_id,
        &fixture.task_id,
        5,
        1,
        REVISION_1_MANIFEST_SHA256,
        Some("A conflicting replay must never replace the recorded feedback."),
    );
    let conflict = send_block_decision(
        &mut owner_client,
        &fixture,
        &owner,
        &block_manifest,
        WEBSITE_REQUEST_CHANGES_ACTION_ID,
        conflicting_request,
        request_changes_key,
        "conflicting owner request changes",
    )
    .await;
    assert!(!conflict.accepted, "a conflicting replay is refused");
    assert!(
        conflict
            .message
            .contains("website request replay carries a different payload"),
        "the conflict is rejected by the request digest: {}",
        conflict.message
    );
    assert_eq!(job_row_generation(&fixture.task_id).await, Some(6));

    let add_revision_2 = add_revision_action(&fixture, &builder, 6, 2);
    let add_revision_2_ok = send_action(&mut builder_client, &builder, &add_revision_2).await;
    let (head, review) = website_head_from_response(&mut builder_client, &add_revision_2_ok).await;
    assert_head_generation(&head, 7);
    assert_eq!(review.status, buzz_core::website::WebsiteStatus::Working);
    assert_eq!(review.current_revision, 2);
    assert_eq!(review.revisions.len(), 2);
    assert!(review.revisions[0].qa.is_some());
    assert!(review.revisions[1].qa.is_none());

    let report_2 = publish_qa_report(
        &mut reviewer_client,
        &reviewer,
        &fixture,
        2,
        REVISION_2_MANIFEST_SHA256,
    )
    .await;
    let record_qa_2 = update_action(
        &fixture,
        &reviewer,
        7,
        WebsiteActionOp::RecordQa {
            revision: 2,
            passed: true,
            report_event_id: report_2,
            report: artifact_ref(
                website_fixture_url("revision-2-qa.json"),
                REVISION_2_REPORT_SHA256,
            ),
        },
    );
    let record_qa_2_ok = send_action(&mut reviewer_client, &reviewer, &record_qa_2).await;
    let (head, review) = website_head_from_response(&mut reviewer_client, &record_qa_2_ok).await;
    assert_head_generation(&head, 8);
    assert_eq!(
        review.revisions[1].qa.as_ref().map(|qa| qa.passed),
        Some(true)
    );

    let ready_2 = update_action(&fixture, &fixture.coordinator, 8, WebsiteActionOp::Ready);
    let ready_2_ok = send_action(&mut coordinator_client, &fixture.coordinator, &ready_2).await;
    let (head, review) = website_head_from_response(&mut coordinator_client, &ready_2_ok).await;
    assert_head_generation(&head, 9);
    assert_eq!(
        review.status,
        buzz_core::website::WebsiteStatus::ReadyForReview
    );
    assert_eq!(review.current_revision, 2);

    let stale_approval = send_block_decision(
        &mut owner_client,
        &fixture,
        &owner,
        &block_manifest,
        WEBSITE_APPROVE_ACTION_ID,
        decision_data(
            job_id,
            &fixture.task_id,
            8,
            2,
            REVISION_2_MANIFEST_SHA256,
            Some("stale approval must be refused"),
        ),
        Uuid::new_v4(),
        "stale owner approval",
    )
    .await;
    assert!(!stale_approval.accepted, "stale approval is refused");
    assert!(
        stale_approval
            .message
            .contains("website job generation conflict"),
        "stale approval fails the generation CAS: {}",
        stale_approval.message
    );
    assert_eq!(job_row_generation(&fixture.task_id).await, Some(9));

    let same_generation_old_revision = send_block_decision(
        &mut owner_client,
        &fixture,
        &owner,
        &block_manifest,
        WEBSITE_APPROVE_ACTION_ID,
        decision_data(
            job_id,
            &fixture.task_id,
            9,
            1,
            REVISION_1_MANIFEST_SHA256,
            Some("an older revision must be refused at the current generation"),
        ),
        Uuid::new_v4(),
        "same-generation old revision approval",
    )
    .await;
    assert!(
        !same_generation_old_revision.accepted,
        "approval for an older revision is refused even at the current generation"
    );
    assert!(
        same_generation_old_revision
            .message
            .contains("stale_revision"),
        "the immutable revision gate rejects the old revision: {}",
        same_generation_old_revision.message
    );
    assert_eq!(job_row_generation(&fixture.task_id).await, Some(9));

    let approval = send_block_decision(
        &mut owner_client,
        &fixture,
        &owner,
        &block_manifest,
        WEBSITE_APPROVE_ACTION_ID,
        decision_data(
            job_id,
            &fixture.task_id,
            9,
            2,
            REVISION_2_MANIFEST_SHA256,
            Some("Approve the exact current revision."),
        ),
        Uuid::new_v4(),
        "exact owner approval",
    )
    .await;
    let (head, review) = website_head_from_response(&mut owner_client, &approval).await;
    assert_head_generation(&head, 10);
    assert_eq!(review.status, buzz_core::website::WebsiteStatus::Approved);
    assert_eq!(review.current_revision, 2);
    assert!(review.active_approval_id.is_some());
    assert_eq!(review.decisions.len(), 2);

    let revision_2_manifest = revision_manifest_ref(2);
    let revision_2_entry = revision_entry_ref(2);
    let handover = update_action(
        &fixture,
        &fixture.coordinator,
        10,
        WebsiteActionOp::Handover {
            approved_revision: 2,
            approved_manifest_sha256: REVISION_2_MANIFEST_SHA256.to_owned(),
            source_url: "https://source.colony.test/sites/acme".to_owned(),
            source_archive: revision_2_manifest,
            assets: vec![HandoverAsset {
                path: "index.html".to_owned(),
                artifact: revision_2_entry,
            }],
            access_request: None,
        },
    );
    let handover_ok = send_action(&mut coordinator_client, &fixture.coordinator, &handover).await;
    let (head, review) = website_head_from_response(&mut coordinator_client, &handover_ok).await;
    assert_head_generation(&head, 11);
    assert_eq!(review.status, buzz_core::website::WebsiteStatus::HandedOver);
    assert_eq!(review.current_revision, 2);
    let saved_handover = review.handover.as_ref().expect("handover is persisted");
    assert_eq!(saved_handover.approved_revision, 2);
    assert_eq!(
        saved_handover.approved_manifest_sha256,
        REVISION_2_MANIFEST_SHA256
    );
    assert_eq!(saved_handover.assets[0].path, "index.html");
    assert_eq!(
        saved_handover.accepted_by,
        fixture.coordinator.public_key().to_hex()
    );
}

#[cfg(feature = "private-website-proof")]
#[path = "e2e_website/private/mod.rs"]
mod e2e_website_private;
