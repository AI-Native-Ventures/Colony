//! The relay's contract for a write that stored nothing (issues #100, #88).
//!
//! Three properties, none of which had a test before, which is why a
//! `buzz grants revoke` that the relay threw away printed success:
//!
//! 1. a NIP-33 write beaten by a different head reports `accepted: false` and
//!    names the winner;
//! 2. re-submitting the identical event reports `accepted: true`, because that
//!    write did land -- this is what the CLI's HTTP retry produces;
//! 3. every response identifies the event the client SUBMITTED, so a NIP-01
//!    client correlating by the id it sent always matches.
//!
//! Requires Postgres; mirrors the harness in `ask_broker.rs`.

use std::sync::Arc;

use buzz_auth::Scope;
use buzz_core::kind::{KIND_ASK_RESOLUTION, KIND_DELEGATION_GRANT, KIND_WORKFLOW_DEF};
use buzz_core::tenant::TenantContext;
use buzz_core::CommunityId;
use buzz_db::Db;
use buzz_relay::handlers::ingest::{ingest_event, IngestAuth, IngestResult, WriteOutcome};
use buzz_relay::state::AppState;
use nostr::{Event, EventBuilder, Keys, Kind, Tag};
use sqlx::PgPool;
use uuid::Uuid;

const TEST_DB_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz"; // sadscan:disable np.postgres.1 -- local test-only credentials

async fn setup() -> (Db, PgPool) {
    let database_url = std::env::var("BUZZ_TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .unwrap_or_else(|_| TEST_DB_URL.to_owned());
    let pool = PgPool::connect(&database_url)
        .await
        .expect("connect to test Postgres");
    buzz_db::migration::run_migrations(&pool)
        .await
        .expect("apply migrations");
    (Db::from_pool(pool.clone()), pool)
}

/// Same shape as `ask_broker.rs`'s harness: Redis is configured but never
/// connected, so nothing in this suite depends on a running Redis.
async fn state(db: Db, pool: &PgPool, relay_keys: Keys) -> Arc<AppState> {
    let mut config = buzz_relay::config::Config::from_env().expect("default config loads");
    config.require_relay_membership = false;
    config.redis_url = "redis://127.0.0.1:1".to_string();
    config.relay_private_key = Some(relay_keys.secret_key().to_secret_hex());
    let redis_pool = deadpool_redis::Config::from_url(&config.redis_url)
        .create_pool(Some(deadpool_redis::Runtime::Tokio1))
        .expect("redis pool (lazy, never connected by this suite)");
    let pubsub = Arc::new(
        buzz_pubsub::PubSubManager::new(&config.redis_url, redis_pool.clone())
            .await
            .expect("pubsub manager (lazy, never connected by this suite)"),
    );
    let pool = pool.clone();
    let audit = buzz_audit::AuditService::new(pool.clone());
    let auth = buzz_auth::AuthService::new(config.auth.clone());
    let search = buzz_search::SearchService::new(pool.clone());
    let workflow_engine = Arc::new(buzz_workflow::WorkflowEngine::new(
        db.clone(),
        buzz_workflow::WorkflowConfig::default(),
    ));
    let media_storage = buzz_media::MediaStorage::new(&config.media).expect("media storage");
    let (state, _audit_shutdown) = AppState::new(
        config,
        db,
        redis_pool,
        audit,
        pubsub,
        auth,
        search,
        workflow_engine,
        relay_keys,
        media_storage,
    );
    Arc::new(state)
}

async fn community(pool: &PgPool) -> CommunityId {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
        .bind(id)
        .bind(format!("dup-contract-{}.example", id.simple()))
        .execute(pool)
        .await
        .expect("insert community");
    CommunityId::from_uuid(id)
}

async fn add_owner(pool: &PgPool, community: CommunityId, pubkey_hex: &str) {
    sqlx::query("INSERT INTO relay_members (community_id, pubkey, role) VALUES ($1, $2, 'owner')")
        .bind(community.as_uuid())
        .bind(pubkey_hex)
        .execute(pool)
        .await
        .expect("insert owner relay member");
}

async fn channel(pool: &PgPool, community: CommunityId, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channels \
            (id, community_id, name, channel_type, visibility, created_by) \
         VALUES ($1, $2, $3, 'stream'::channel_type, 'open'::channel_visibility, $4)",
    )
    .bind(id)
    .bind(community.as_uuid())
    .bind(format!("{name}-{}", id.simple()))
    .bind([0x11_u8; 32].as_slice())
    .execute(pool)
    .await
    .expect("insert channel");
    id
}

async fn add_channel_member(
    pool: &PgPool,
    community: CommunityId,
    channel_id: Uuid,
    pubkey: &[u8],
) {
    sqlx::query(
        "INSERT INTO channel_members (community_id, channel_id, pubkey, role) \
         VALUES ($1, $2, $3, 'member')",
    )
    .bind(community.as_uuid())
    .bind(channel_id)
    .bind(pubkey)
    .execute(pool)
    .await
    .expect("insert channel member");
}

/// A kind:30620 workflow definition, the shape `buzz-sdk`'s
/// `build_workflow_def` emits: a `d` tag carrying the workflow id, which is
/// what puts it on `persist_command_event`'s NIP-33 branch.
fn workflow_def(
    author: &Keys,
    workflow_id: &str,
    channel_id: &str,
    created_at: u64,
    name: &str,
) -> Event {
    let yaml = format!(
        "name: {name}\ntrigger:\n  on: message_posted\nsteps:\n  - id: notify\n    \
         action: send_message\n    text: '{name}'\n"
    );
    EventBuilder::new(Kind::Custom(KIND_WORKFLOW_DEF as u16), yaml)
        .custom_created_at(nostr::Timestamp::from_secs(created_at))
        .tags(vec![tag(&["d", workflow_id]), tag(&["h", channel_id])])
        .sign_with_keys(author)
        .expect("sign workflow definition")
}

fn tag(parts: &[&str]) -> Tag {
    Tag::parse(parts.iter().copied()).expect("valid test tag")
}

/// A kind:30189 delegation grant at an explicit `created_at`, with `nonce`
/// varying the content so callers can search the id space.
fn grant_at(author: &Keys, d_tag: &str, created_at: u64, nonce: u64) -> Event {
    let content = serde_json::json!({
        "category": "copy_change",
        "scope": "blog_post_titles",
        "active": true,
        "nonce": nonce,
    })
    .to_string();
    EventBuilder::new(Kind::Custom(KIND_DELEGATION_GRANT as u16), content)
        .custom_created_at(nostr::Timestamp::from_secs(created_at))
        .tags(vec![tag(&["d", d_tag])])
        .sign_with_keys(author)
        .expect("sign grant")
}

/// Two grants at the SAME `created_at` and address, where `loser`'s id sorts
/// at or above `winner`'s.
///
/// That is exactly the tiebreak `replace_parameterized_event` applies: Nostr
/// `created_at` is whole seconds, so two heads written inside one second
/// collide and the loser is decided by a byte comparison of 32-byte event ids.
/// Searching for the pair makes the race deterministic instead of ~50/50.
fn same_second_pair(author: &Keys, d_tag: &str, created_at: u64) -> (Event, Event) {
    let first = grant_at(author, d_tag, created_at, 0);
    for nonce in 1..10_000 {
        let candidate = grant_at(author, d_tag, created_at, nonce);
        if candidate.id.as_bytes() >= first.id.as_bytes() {
            return (first, candidate);
        }
    }
    panic!("no losing id found in 10000 attempts");
}

async fn ingest(state: &Arc<AppState>, tenant: &TenantContext, event: &Event) -> IngestResult {
    ingest_event(state, tenant, event.clone(), auth_for_event(event))
        .await
        .unwrap_or_else(|error| panic!("ingest must not error: {error:?}"))
}

fn auth_for_event(event: &Event) -> IngestAuth {
    IngestAuth::Nip42 {
        pubkey: event.pubkey,
        scopes: Scope::all_known(),
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    }
}

/// Whether `event_id` is retrievable from the relay's own store, rather than
/// only known to this test from the copy it signed.
async fn is_stored(pool: &PgPool, community: CommunityId, event: &Event) -> bool {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT 1::bigint FROM events \
         WHERE community_id = $1 AND id = $2 AND deleted_at IS NULL",
    )
    .bind(community.as_uuid())
    .bind(event.id.as_bytes().as_slice())
    .fetch_optional(pool)
    .await
    .expect("query stored event");
    row.is_some()
}

/// Issue #100: a dominated NIP-33 write is NOT accepted, and the response
/// names the head that beat it.
///
/// Before the fix this returned `accepted: true` with a bare `"duplicate:"`,
/// so `buzz grants revoke` exited 0 while the grant stayed active.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_dominated_nip33_write_is_not_accepted_and_names_the_winner() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db, &pool, Keys::generate()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let d_tag = format!("grant-{}", Uuid::new_v4().simple());
    let created_at = nostr::Timestamp::now().as_secs();
    let (winner, loser) = same_second_pair(&owner, &d_tag, created_at);

    let first = ingest(&state, &tenant, &winner).await;
    assert!(
        first.accepted(),
        "the first head must be stored: {}",
        first.message()
    );
    assert_eq!(first.outcome(), &WriteOutcome::Stored);

    let second = ingest(&state, &tenant, &loser).await;

    assert!(
        !second.accepted(),
        "a write the relay discarded must not be reported as accepted; got message: {}",
        second.message()
    );
    assert_eq!(
        second.outcome(),
        &WriteOutcome::Superseded {
            winner_event_id: winner.id.to_hex(),
        },
        "the discarded write must name the head that beat it"
    );
    assert_eq!(
        second.event_id(),
        loser.id.to_hex(),
        "the response must identify the SUBMITTED event, not the winner (issue #88)"
    );

    assert!(
        !is_stored(&pool, community, &loser).await,
        "the dominated event must not be in the store, which is what `accepted: false` claims"
    );
    assert!(
        is_stored(&pool, community, &winner).await,
        "the winning head must still be the stored one"
    );
}

/// Re-submitting the identical event is an idempotent repeat, not a conflict.
///
/// `buzz`'s HTTP client re-posts the same serialized bytes on a dropped body,
/// timeout, or 502-504. If the relay committed the first attempt and the
/// response was lost, that retry is this case, and reporting it as a discard
/// would make an agent re-file a decision it had already filed.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn re_submitting_the_identical_event_is_accepted() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db, &pool, Keys::generate()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let d_tag = format!("grant-{}", Uuid::new_v4().simple());
    let grant = grant_at(&owner, &d_tag, nostr::Timestamp::now().as_secs(), 0);

    let first = ingest(&state, &tenant, &grant).await;
    assert!(first.accepted(), "first write: {}", first.message());
    assert_eq!(first.outcome(), &WriteOutcome::Stored);

    let retry = ingest(&state, &tenant, &grant).await;

    assert!(
        retry.accepted(),
        "the retried write DID land, so it must not be reported as a conflict; got: {}",
        retry.message()
    );
    assert_eq!(
        retry.outcome(),
        &WriteOutcome::AlreadyStored,
        "an identical re-submission is distinguishable from a dominance discard"
    );
    assert_eq!(retry.event_id(), grant.id.to_hex());
    assert!(
        is_stored(&pool, community, &grant).await,
        "the event `accepted: true` refers to must actually be in the store"
    );
}

/// A stale write (older `created_at`, no tiebreak involved) is the same
/// discard, and reports the same way.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_stale_nip33_write_is_superseded_by_the_newer_head() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db, &pool, Keys::generate()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let d_tag = format!("grant-{}", Uuid::new_v4().simple());
    let now = nostr::Timestamp::now().as_secs();
    let newer = grant_at(&owner, &d_tag, now, 1);
    let older = grant_at(&owner, &d_tag, now - 60, 2);

    assert!(ingest(&state, &tenant, &newer).await.accepted());
    let stale = ingest(&state, &tenant, &older).await;

    assert!(!stale.accepted(), "a stale write stores nothing");
    assert_eq!(
        stale.outcome(),
        &WriteOutcome::Superseded {
            winner_event_id: newer.id.to_hex(),
        }
    );
    assert_eq!(stale.event_id(), older.id.to_hex());
}

/// Issue #88, at the seam both transports read: the id slot is the submitted
/// id on every outcome. The WebSocket handler passes `IngestResult::event_id`
/// straight into the `OK` frame, so a client correlating by the id it sent
/// resolves its pending publish instead of timing out.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn every_outcome_identifies_the_submitted_event() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db, &pool, Keys::generate()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let d_tag = format!("grant-{}", Uuid::new_v4().simple());
    let created_at = nostr::Timestamp::now().as_secs();
    let (winner, loser) = same_second_pair(&owner, &d_tag, created_at);

    for event in [&winner, &loser, &winner] {
        let result = ingest(&state, &tenant, event).await;
        assert_eq!(
            result.event_id(),
            event.id.to_hex(),
            "outcome {:?} put the wrong id in the id slot",
            result.outcome()
        );
    }
}

/// The wire tokens are the client-visible half of the contract, so they are
/// pinned here: a rename is a wire break, not a refactor.
#[test]
fn wire_tokens_are_stable() {
    assert_eq!(WriteOutcome::Stored.as_wire_token(), "stored");
    assert_eq!(
        WriteOutcome::AlreadyStored.as_wire_token(),
        "already_stored"
    );
    assert_eq!(
        WriteOutcome::Superseded {
            winner_event_id: "abc".to_owned()
        }
        .as_wire_token(),
        "superseded"
    );
    assert_eq!(WriteOutcome::Refused.as_wire_token(), "refused");

    assert!(WriteOutcome::Stored.is_accepted());
    assert!(WriteOutcome::AlreadyStored.is_accepted());
    assert!(!WriteOutcome::Superseded {
        winner_event_id: "abc".to_owned()
    }
    .is_accepted());
    assert!(!WriteOutcome::Refused.is_accepted());
}

/// I1: the message prefix a WebSocket client reads must agree with the
/// `outcome` an HTTP client reads, on every outcome.
///
/// NIP-01's OK frame has no room for the token, so the prefix IS the
/// discriminator on that transport, and the two agreeing is the whole reason a
/// client can trust either one. The constructors derive the prefix from the
/// outcome, so this asserts the derivation rather than a hand-written string at
/// each site.
#[test]
fn every_message_carries_the_prefix_its_outcome_requires() {
    let cases = [
        (IngestResult::stored("mine"), None),
        (
            IngestResult::stored_with_message("mine", r#"response:{"ok":true}"#),
            None,
        ),
        (
            IngestResult::already_stored("mine", "identical event already stored"),
            Some("duplicate:"),
        ),
        (
            IngestResult::superseded("mine", "theirs", "superseded by event theirs"),
            Some("conflict:"),
        ),
        (
            IngestResult::refused("mine", "channel already exists"),
            Some("conflict:"),
        ),
    ];

    for (result, expected) in cases {
        assert_eq!(
            result.outcome().message_prefix(),
            expected,
            "outcome {:?} maps to the wrong prefix",
            result.outcome()
        );
        match expected {
            Some(prefix) => assert!(
                result.message().starts_with(prefix),
                "outcome {:?} produced message {:?}, which does not start with {prefix}",
                result.outcome(),
                result.message()
            ),
            None => assert!(
                !result.message().starts_with("duplicate:")
                    && !result.message().starts_with("conflict:"),
                "a stored write must not look like a discard: {:?}",
                result.message()
            ),
        }
        // The prefix set is closed on `accepted`: `duplicate:` only ever
        // accompanies an accepted write, `conflict:` only a rejected one. A
        // client branching on the prefix alone must never be misled.
        if result.message().starts_with("duplicate:") {
            assert!(result.accepted(), "duplicate: implies accepted");
        }
        if result.message().starts_with("conflict:") {
            assert!(!result.accepted(), "conflict: implies not accepted");
        }
    }
}

/// I2: a discovery broker's JSON payload lives INSIDE the prefix, so this path
/// obeys the same closed prefix set as every other duplicate path.
///
/// A bare JSON message would read as `stored` to a WebSocket client following
/// the documented table, even when `accepted` is false.
#[test]
fn a_json_payload_still_carries_its_outcome_prefix() {
    let superseded = IngestResult::superseded("mine", "theirs", r#"{"duplicate":true}"#);
    assert!(
        superseded.message().starts_with("conflict: "),
        "got: {}",
        superseded.message()
    );
    assert!(
        superseded.message().contains(r#"{"duplicate":true}"#),
        "the payload must survive the prefixing: {}",
        superseded.message()
    );
}

/// N1: a reason is prefixed exactly once.
///
/// The I1 change moved prefixing into the constructors but left the ask
/// broker's refusal arm formatting its own, so every ask refusal read
/// "conflict: conflict: the referenced ask does not exist". Thirteen refusal
/// sites funnel through that arm: every altitude rejection, unauthorized
/// signer, unknown or closed ask, null answer, and non-executive withdrawal.
#[test]
fn a_reason_is_prefixed_exactly_once() {
    for result in [
        IngestResult::refused("mine", "the referenced ask does not exist"),
        IngestResult::superseded("mine", "theirs", "superseded by event theirs"),
        IngestResult::already_stored("mine", "identical event already stored"),
    ] {
        let message = result.message();
        let prefix = result
            .outcome()
            .message_prefix()
            .expect("these outcomes all carry a prefix");
        assert_eq!(
            message.matches(prefix).count(),
            1,
            "{message:?} repeats the {prefix:?} prefix"
        );
        assert!(
            !message.starts_with(&format!("{prefix} {prefix}")),
            "double prefix: {message:?}"
        );
    }
}

/// An empty reason yields the bare prefix, not a dangling separator.
#[test]
fn an_empty_reason_yields_a_bare_prefix() {
    assert_eq!(
        IngestResult::already_stored("mine", "").message(),
        "duplicate:"
    );
    assert_eq!(IngestResult::stored("mine").message(), "");
}

/// C1: a command event beaten by a newer head at the same NIP-33 coordinate is
/// NOT accepted, and the domain mutation behind it did not run.
///
/// `persist_command_event` runs its own dominance check, separate from
/// `replace_parameterized_event`, and its two-variant result collapsed the same
/// two cases #100 is about. A stale `buzz workflows update` reported
/// `accepted: true, outcome: already_stored` while the definition row kept its
/// old value, which is a stronger falsehood than the bug this branch fixed.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_dominated_command_write_is_not_accepted_and_names_the_winner() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db, &pool, Keys::generate()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let author = Keys::generate();
    add_owner(&pool, community, &author.public_key().to_hex()).await;
    let channel_id = channel(&pool, community, "workflows").await;
    add_channel_member(
        &pool,
        community,
        channel_id,
        &author.public_key().to_bytes(),
    )
    .await;

    let workflow_id = Uuid::new_v4().to_string();
    let now = nostr::Timestamp::now().as_secs();
    let newer = workflow_def(&author, &workflow_id, &channel_id.to_string(), now, "newer");
    let stale = workflow_def(
        &author,
        &workflow_id,
        &channel_id.to_string(),
        now - 60,
        "stale",
    );

    let first = ingest(&state, &tenant, &newer).await;
    assert!(
        first.accepted(),
        "the first definition must be stored: {}",
        first.message()
    );

    let second = ingest(&state, &tenant, &stale).await;

    assert!(
        !second.accepted(),
        "a command write the relay discarded must not be reported as accepted; got: {}",
        second.message()
    );
    assert_eq!(
        second.outcome(),
        &WriteOutcome::Superseded {
            winner_event_id: newer.id.to_hex(),
        },
        "the discarded command write must name the head that beat it"
    );
    assert_eq!(
        second.event_id(),
        stale.id.to_hex(),
        "the response must identify the SUBMITTED event"
    );
    assert!(
        !is_stored(&pool, community, &stale).await,
        "the dominated command event must not be in the store"
    );
}

/// The other half: re-sending the identical command event is an idempotent
/// repeat, so it stays accepted.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn re_submitting_the_identical_command_event_is_accepted() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db, &pool, Keys::generate()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let author = Keys::generate();
    add_owner(&pool, community, &author.public_key().to_hex()).await;
    let channel_id = channel(&pool, community, "workflows").await;
    add_channel_member(
        &pool,
        community,
        channel_id,
        &author.public_key().to_bytes(),
    )
    .await;

    let workflow_id = Uuid::new_v4().to_string();
    let def = workflow_def(
        &author,
        &workflow_id,
        &channel_id.to_string(),
        nostr::Timestamp::now().as_secs(),
        "only",
    );

    assert!(ingest(&state, &tenant, &def).await.accepted());
    let retry = ingest(&state, &tenant, &def).await;

    assert!(
        retry.accepted(),
        "the retried command write DID land: {}",
        retry.message()
    );
    assert_eq!(retry.outcome(), &WriteOutcome::AlreadyStored);
    assert_eq!(retry.event_id(), def.id.to_hex());
}

/// N1 at the real ingest boundary: an ask refusal is prefixed once.
///
/// The unit test above pins the constructor. This drives an actual
/// `AskBrokerOutcome::Refused` through `ingest_event`, which is the path that
/// shipped `conflict: conflict: ...` and which no existing suite covered: the
/// `ask_broker` tests call `handle_ask_event` directly, so they stayed green
/// through the whole defect. Thirteen refusal sites funnel through this arm.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn an_ask_refusal_through_ingest_is_prefixed_once() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db, &pool, Keys::generate()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let author = Keys::generate();
    add_owner(&pool, community, &author.public_key().to_hex()).await;

    // A resolution naming an ask that was never raised: the broker refuses it
    // with "the referenced ask does not exist".
    let unknown_ask = "a".repeat(64);
    let content =
        serde_json::json!({"answer": {"text": "no"}, "default_executed": false}).to_string();
    let resolution = EventBuilder::new(Kind::Custom(KIND_ASK_RESOLUTION as u16), content)
        .tags(vec![tag(&["e", &unknown_ask])])
        .sign_with_keys(&author)
        .expect("sign resolution");

    let result = ingest(&state, &tenant, &resolution).await;

    assert!(!result.accepted(), "an unknown ask cannot be resolved");
    assert_eq!(
        result.message().matches("conflict:").count(),
        1,
        "the refusal must be prefixed exactly once, got: {}",
        result.message()
    );
    assert!(
        result.message().starts_with("conflict: the referenced ask"),
        "unexpected refusal message: {}",
        result.message()
    );
}
