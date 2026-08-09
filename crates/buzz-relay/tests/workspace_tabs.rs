//! Database integration tests for relay-owned workspace tab state.
//!
//! These tests exercise the `buzz-db` compare-and-swap directly. They require
//! Postgres, like the other relay integration tests in this directory.

use std::sync::Arc;

use buzz_core::CommunityId;
use buzz_db::workspace_tabs::{get_tab, open_tab, set_driver};
use buzz_db::Db;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use tokio::sync::Barrier;
use uuid::Uuid;

const TEST_DB_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz"; // sadscan:disable np.postgres.1 -- local test-only credentials

async fn setup() -> (Db, PgPool) {
    let database_url = std::env::var("BUZZ_TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .unwrap_or_else(|_| TEST_DB_URL.to_owned());
    let pool = PgPool::connect(&database_url)
        .await
        .expect("connect to test Postgres");
    // Not `run_migrations`: CI's integration Postgres is provisioned by
    // `pgschema apply --file schema/schema.sql` and never gets an
    // `_sqlx_migrations` table, so replaying 0001 there aborts on the first
    // `CREATE TYPE` (`42710 type "channel_type" already exists`). A
    // developer's fresh `createdb` still runs the full migrator.
    buzz_db::migration::run_migrations_unless_provisioned(&pool)
        .await
        .expect("apply migrations");
    (Db::from_pool(pool.clone()), pool)
}

async fn setup_with_max_connections(max_connections: u32) -> (Db, PgPool) {
    let database_url = std::env::var("BUZZ_TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .unwrap_or_else(|_| TEST_DB_URL.to_owned());
    let pool = PgPoolOptions::new()
        .max_connections(max_connections)
        .connect(&database_url)
        .await
        .expect("connect to test Postgres");
    buzz_db::migration::run_migrations_unless_provisioned(&pool)
        .await
        .expect("apply migrations");
    (Db::from_pool(pool.clone()), pool)
}

async fn fixture() -> (PgPool, CommunityId, Uuid) {
    let (_db, pool) = setup().await;
    let community = new_community(&pool).await;
    let channel = new_channel(&pool, community, "workspace").await;
    (pool, community, channel)
}

async fn racing_fixture() -> (PgPool, CommunityId, Uuid) {
    let (_db, pool) = setup_with_max_connections(4).await;
    let community = new_community(&pool).await;
    let channel = new_channel(&pool, community, "workspace-race").await;
    (pool, community, channel)
}

async fn new_community(pool: &PgPool) -> CommunityId {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
        .bind(id)
        .bind(format!("workspace-tabs-{}.example", id.simple()))
        .execute(pool)
        .await
        .expect("insert community");
    CommunityId::from_uuid(id)
}

async fn new_channel(pool: &PgPool, community: CommunityId, name: &str) -> Uuid {
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

#[tokio::test]
async fn two_racing_takes_produce_one_winner() {
    let (pool, community, channel) = racing_fixture().await;
    let human = [1u8; 32];
    let agent_a = [2u8; 32];
    let agent_b = [3u8; 32];

    let tab = open_tab(
        &pool,
        community,
        channel,
        "tab-1",
        "scratchpad",
        "Notes",
        &human,
        100,
    )
    .await
    .unwrap()
    .expect("a fresh tab opens");
    assert_eq!(tab.revision, 1);
    assert_eq!(tab.driver, human.to_vec());

    // Both callers captured revision 1 before either transition started.
    // The barrier releases both tasks together, and the pool has spare
    // connections so one query cannot be queued behind the other by the test
    // harness itself.
    let expected_revision = tab.revision;
    let barrier = Arc::new(Barrier::new(3));
    let barrier_a = Arc::clone(&barrier);
    let barrier_b = Arc::clone(&barrier);
    let pool_a = pool.clone();
    let pool_b = pool.clone();
    let first = tokio::spawn(async move {
        barrier_a.wait().await;
        set_driver(
            &pool_a,
            community,
            channel,
            "tab-1",
            expected_revision,
            &agent_a,
            101,
        )
        .await
    });
    let second = tokio::spawn(async move {
        barrier_b.wait().await;
        set_driver(
            &pool_b,
            community,
            channel,
            "tab-1",
            expected_revision,
            &agent_b,
            102,
        )
        .await
    });
    barrier.wait().await;

    let first = first.await.unwrap().unwrap();
    let second = second.await.unwrap().unwrap();
    let winner = match (first, second) {
        (Some(row), None) | (None, Some(row)) => row,
        (Some(_), Some(_)) => panic!("two callers with one expected revision won"),
        (None, None) => panic!("both callers lost the compare-and-swap"),
    };

    assert!(
        winner.driver == agent_a.to_vec() || winner.driver == agent_b.to_vec(),
        "the winner must be one of the racing drivers"
    );
    let current = get_tab(&pool, community, channel, "tab-1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.driver, winner.driver);
    assert_eq!(current.revision, 2);
}

#[tokio::test]
async fn head_at_is_strictly_increasing_even_within_one_second() {
    let (pool, community, channel) = fixture().await;
    let human = [1u8; 32];
    let agent = [2u8; 32];
    let opened = open_tab(
        &pool,
        community,
        channel,
        "tab-1",
        "scratchpad",
        "Notes",
        &human,
        100,
    )
    .await
    .unwrap()
    .unwrap();
    // Same wall-clock second as the open.
    let taken = set_driver(&pool, community, channel, "tab-1", 1, &agent, 100)
        .await
        .unwrap()
        .unwrap();
    assert!(
        taken.head_at > opened.head_at,
        "two transitions in one second must still order: {} vs {}",
        opened.head_at,
        taken.head_at
    );
}

#[tokio::test]
async fn opening_the_same_tab_twice_is_idempotent_not_a_hijack() {
    let (pool, community, channel) = fixture().await;
    let human = [1u8; 32];
    let stranger = [9u8; 32];
    open_tab(
        &pool,
        community,
        channel,
        "tab-1",
        "scratchpad",
        "Notes",
        &human,
        100,
    )
    .await
    .unwrap()
    .unwrap();
    // A second open of the same coordinate must NOT reset ownership: that
    // would be a free takeover for anyone who can guess a tab id.
    let again = open_tab(
        &pool,
        community,
        channel,
        "tab-1",
        "scratchpad",
        "Mine now",
        &stranger,
        101,
    )
    .await
    .unwrap();
    assert!(
        again.is_none(),
        "re-opening an existing tab must not succeed"
    );
    let current = get_tab(&pool, community, channel, "tab-1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.creator, human.to_vec());
    assert_eq!(current.title, "Notes");
}

#[tokio::test]
async fn a_tab_in_another_channel_is_a_different_tab() {
    let (pool, community, channel_a) = fixture().await;
    let channel_b = new_channel(&pool, community, "workspace-other").await;
    let human = [1u8; 32];
    open_tab(
        &pool,
        community,
        channel_a,
        "tab-1",
        "scratchpad",
        "A",
        &human,
        100,
    )
    .await
    .unwrap()
    .unwrap();
    let in_b = open_tab(
        &pool,
        community,
        channel_b,
        "tab-1",
        "scratchpad",
        "B",
        &human,
        100,
    )
    .await
    .unwrap();
    assert!(in_b.is_some(), "the same tab id in another channel is free");
}
