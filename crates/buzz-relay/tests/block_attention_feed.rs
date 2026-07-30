use buzz_core::kind::{KIND_BLOCK_RECEIPT, KIND_STREAM_MESSAGE};
use buzz_core::CommunityId;
use buzz_db::Db;
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

async fn community(pool: &PgPool) -> CommunityId {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
        .bind(id)
        .bind(format!("block-attention-{}.example", id.simple()))
        .execute(pool)
        .await
        .expect("insert community");
    CommunityId::from_uuid(id)
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

async fn store(
    db: &Db,
    community: CommunityId,
    channel_id: Uuid,
    kind: u32,
    keys: &Keys,
    mut tags: Vec<Tag>,
    content: &str,
) -> Event {
    let channel_tag = channel_id.to_string();
    tags.push(tag(&["h", &channel_tag]));
    let event = EventBuilder::new(Kind::Custom(kind as u16), content)
        .tags(tags)
        .sign_with_keys(keys)
        .expect("sign event");
    let (_, inserted) = db
        .insert_event(community, &event, Some(channel_id))
        .await
        .expect("store event");
    assert!(inserted);
    event
}

fn tag(parts: &[&str]) -> Tag {
    Tag::parse(parts.iter().copied()).expect("valid test tag")
}

#[tokio::test]
async fn persisted_block_attention_projects_into_needs_action_until_valid_resolution() {
    let (db, pool) = setup().await;
    let workspace = community(&pool).await;
    let other_workspace = community(&pool).await;
    let visible = channel(&pool, workspace, "visible").await;
    let inaccessible = channel(&pool, workspace, "inaccessible").await;
    let other_channel = channel(&pool, other_workspace, "other").await;
    let owner = Keys::generate();
    let owner_hex = owner.public_key().to_hex();
    let owner_bytes = owner.public_key().to_bytes();

    let proposal = store(
        &db,
        workspace,
        visible,
        KIND_STREAM_MESSAGE,
        &Keys::generate(),
        vec![
            tag(&["p", &owner_hex]),
            tag(&["block-attention", "1", "required"]),
        ],
        "Developer proposed hiring Researcher",
    )
    .await;
    let ordinary = store(
        &db,
        workspace,
        visible,
        KIND_STREAM_MESSAGE,
        &Keys::generate(),
        vec![tag(&["p", &owner_hex])],
        "ordinary owner mention",
    )
    .await;

    let mentions = db
        .query_feed_mentions(workspace, &owner_bytes, &[visible], None, 50)
        .await
        .expect("query mentions");
    assert!(mentions.iter().any(|row| row.event.id == proposal.id));
    assert!(mentions.iter().any(|row| row.event.id == ordinary.id));

    let needs_action = db
        .query_feed_needs_action(workspace, &owner_bytes, &[visible], None, 50)
        .await
        .expect("query initial needs action");
    assert!(needs_action.iter().any(|row| row.event.id == proposal.id));
    assert!(needs_action.iter().all(|row| row.event.id != ordinary.id));

    let proposal_id = proposal.id.to_hex();
    for status in ["failed", "timed-out"] {
        store(
            &db,
            workspace,
            visible,
            KIND_BLOCK_RECEIPT,
            &owner,
            vec![
                tag(&["e", &proposal_id, "", "block-instance"]),
                tag(&[
                    "block-receipt",
                    "1",
                    &Uuid::new_v4().to_string(),
                    &Uuid::new_v4().to_string(),
                    status,
                ]),
            ],
            "{}",
        )
        .await;
        assert!(db
            .query_feed_needs_action(workspace, &owner_bytes, &[visible], None, 50)
            .await
            .expect("query retryable needs action")
            .iter()
            .any(|row| row.event.id == proposal.id));
    }

    store(
        &db,
        other_workspace,
        other_channel,
        KIND_BLOCK_RECEIPT,
        &owner,
        vec![
            tag(&["e", &proposal_id, "", "block-instance"]),
            tag(&["block-attention", "1", "resolved"]),
        ],
        "{}",
    )
    .await;
    store(
        &db,
        workspace,
        inaccessible,
        KIND_BLOCK_RECEIPT,
        &owner,
        vec![
            tag(&["e", &proposal_id, "", "block-instance"]),
            tag(&["block-attention", "1", "resolved"]),
        ],
        "{}",
    )
    .await;
    assert!(db
        .query_feed_needs_action(workspace, &owner_bytes, &[visible], None, 50)
        .await
        .expect("query scope-safe needs action")
        .iter()
        .any(|row| row.event.id == proposal.id));

    store(
        &db,
        workspace,
        visible,
        KIND_BLOCK_RECEIPT,
        &owner,
        vec![
            tag(&["e", &proposal_id, "", "block-instance"]),
            tag(&["block-attention", "1", "resolved"]),
        ],
        "{}",
    )
    .await;
    assert!(db
        .query_feed_needs_action(workspace, &owner_bytes, &[visible], None, 50)
        .await
        .expect("query resolved needs action")
        .iter()
        .all(|row| row.event.id != proposal.id));
}
