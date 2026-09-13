//! Event construction and persistence primitives for the website broker.
//!
//! The head is a relay-signed NIP-33 projection of the canonical row; the
//! receipt is relay-signed evidence of one transition; both are persisted in
//! the same transaction as the row change. Head replacement takes the same
//! advisory lock and ordering rule as buzz-db's parameterized replacement, so
//! generic NIP-33 writes and this projection cannot interleave.

use buzz_core::kind::{KIND_WEBSITE_HEAD, KIND_WEBSITE_RECEIPT};
use buzz_core::website::{WebsiteReceipt, WEBSITE_RECEIPT_SCHEMA};
use buzz_core::{CommunityId, StoredEvent};
use chrono::{DateTime, Utc};
use nostr::{Event, EventBuilder, Keys, Kind, Tag, Timestamp};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

/// The `d` tag of a job's head.
pub(crate) fn head_d_tag(job_id: Uuid) -> String {
    job_id.to_string()
}

/// The `created_at` a website head must carry.
///
/// NIP-33 keeps the newer event at a coordinate, so a head written in the same
/// second as the head it replaces loses the comparison and the write is
/// refused. That is ordinary here: a job's creation and its first transition,
/// or two quick transitions, land in one second. The relay authors these heads,
/// so the ordering guarantee is the relay's to keep: one second past the
/// previous head when the clock has not moved on by itself. A brand-new job has
/// no previous head and keeps `now`.
pub(crate) fn next_head_at(now: i64, previous_head_at: Option<i64>) -> i64 {
    match previous_head_at {
        Some(previous) => now.max(previous.saturating_add(1)),
        None => now,
    }
}

/// Build the relay-signed head event for a review snapshot.
///
/// The head carries the pinned review-card instance and manifest event ids as
/// tags, so a reader validates the card it renders against signed identity
/// rather than trusting a same-channel Block of any handle.
#[allow(clippy::too_many_arguments)]
pub(crate) fn build_head(
    relay: &Keys,
    job_id: Uuid,
    channel_id: Uuid,
    task_id: &str,
    thread_root: &str,
    instance_event_id: &[u8],
    manifest_event_id: &[u8],
    owner: &[u8],
    coordinator: &[u8],
    generation: u64,
    review_bytes: &[u8],
    head_at: i64,
) -> Result<Event, String> {
    let content = String::from_utf8(review_bytes.to_vec())
        .map_err(|_| "the website review is not UTF-8".to_owned())?;
    let tags = vec![
        scalar_tag("d", &head_d_tag(job_id))?,
        scalar_tag("h", &channel_id.to_string())?,
        scalar_tag("task", task_id)?,
        scalar_tag("thread", thread_root)?,
        scalar_tag("instance", &hex::encode(instance_event_id))?,
        scalar_tag("manifest", &hex::encode(manifest_event_id))?,
        scalar_tag("generation", &generation.to_string())?,
        scalar_tag("p", &hex::encode(owner))?,
        scalar_tag("p", &hex::encode(coordinator))?,
    ];
    EventBuilder::new(Kind::Custom(KIND_WEBSITE_HEAD as u16), content)
        .tags(tags)
        .custom_created_at(Timestamp::from(head_at.max(0) as u64))
        .sign_with_keys(relay)
        .map_err(|error| format!("failed to sign the website head: {error}"))
}

/// Build a relay-signed receipt for an applied website action.
#[allow(clippy::too_many_arguments)]
pub(crate) fn build_receipt(
    relay: &Keys,
    job_id: Uuid,
    channel_id: Uuid,
    task_id: &str,
    thread_root: &str,
    actor_hex: &str,
    op: &str,
    generation: u64,
    revision: u32,
    head_event_id: &str,
    decision_id: Option<String>,
    action_event: &Event,
) -> Result<Event, String> {
    let receipt = WebsiteReceipt {
        schema: WEBSITE_RECEIPT_SCHEMA.to_owned(),
        op: op.to_owned(),
        outcome: "applied".to_owned(),
        job_id,
        generation,
        revision,
        head_event_id: head_event_id.to_owned(),
        decision_id,
    };
    let content = receipt.encode().map_err(|error| error.to_string())?;
    let tags = vec![
        scalar_tag("h", &channel_id.to_string())?,
        scalar_tag("task", task_id)?,
        scalar_tag("thread", thread_root)?,
        scalar_tag("p", actor_hex)?,
        Tag::parse(["e", &action_event.id.to_hex(), "", "website-action"])
            .map_err(|error| format!("failed to build receipt `e` tag: {error}"))?,
    ];
    EventBuilder::new(Kind::Custom(KIND_WEBSITE_RECEIPT as u16), content)
        .tags(tags)
        .sign_with_keys(relay)
        .map_err(|error| format!("failed to sign the website receipt: {error}"))
}

/// Build a relay-signed duplicate receipt for an already-stored transition.
///
/// `action_marker` names the signed event the receipt references: the Block
/// action for owner decisions, or the website action for a coordinator's
/// ordinary request-changes command.
#[allow(clippy::too_many_arguments)]
pub(crate) fn build_duplicate_receipt(
    relay: &Keys,
    action_event: &Event,
    job_id: Uuid,
    channel_id: Uuid,
    task_id: &str,
    thread_root: &str,
    op: &str,
    action_marker: &str,
    generation: i64,
    revision: u32,
    head_event_id: &str,
    decision_id: Option<String>,
) -> Result<Event, String> {
    let receipt = WebsiteReceipt {
        schema: WEBSITE_RECEIPT_SCHEMA.to_owned(),
        op: op.to_owned(),
        outcome: "duplicate".to_owned(),
        job_id,
        generation: u64::try_from(generation).unwrap_or(0),
        revision,
        head_event_id: head_event_id.to_owned(),
        decision_id,
    };
    let content = receipt.encode().map_err(|error| error.to_string())?;
    let tags = vec![
        scalar_tag("h", &channel_id.to_string())?,
        scalar_tag("task", task_id)?,
        scalar_tag("thread", thread_root)?,
        scalar_tag("p", &action_event.pubkey.to_hex())?,
        Tag::parse(["e", &action_event.id.to_hex(), "", action_marker])
            .map_err(|error| format!("failed to build receipt `e` tag: {error}"))?,
    ];
    EventBuilder::new(Kind::Custom(KIND_WEBSITE_RECEIPT as u16), content)
        .tags(tags)
        .sign_with_keys(relay)
        .map_err(|error| format!("failed to sign the website receipt: {error}"))
}

pub(crate) fn scalar_tag(name: &str, value: &str) -> Result<Tag, String> {
    Tag::parse([name, value]).map_err(|error| format!("failed to build `{name}` tag: {error}"))
}

/// Insert a signed event inside the broker transaction.
pub(crate) async fn insert_event_tx(
    tx: &mut Transaction<'static, Postgres>,
    community: CommunityId,
    event: &Event,
    channel_id: Option<Uuid>,
) -> Result<StoredEvent, String> {
    let created_at_secs = event.created_at.as_secs() as i64;
    let created_at = DateTime::from_timestamp(created_at_secs, 0)
        .ok_or_else(|| format!("invalid website event timestamp: {created_at_secs}"))?;
    let received_at = Utc::now();
    let tags = serde_json::to_value(&event.tags)
        .map_err(|error| format!("failed to serialize website event tags: {error}"))?;
    let d_tag = (event.kind.as_u16() as u32 == KIND_WEBSITE_HEAD).then(|| {
        event
            .tags
            .iter()
            .find_map(|tag| {
                let parts = tag.as_slice();
                (parts.len() >= 2 && parts[0] == "d").then(|| parts[1].clone())
            })
            .unwrap_or_default()
    });
    let result = sqlx::query(
        "INSERT INTO events \
            (community_id, id, pubkey, created_at, kind, tags, content, sig, received_at, channel_id, d_tag, not_before) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL)",
    )
    .bind(community.as_uuid())
    .bind(event.id.as_bytes().as_slice())
    .bind(event.pubkey.to_bytes().as_slice())
    .bind(created_at)
    .bind(buzz_core::kind::event_kind_i32(event))
    .bind(tags)
    .bind(&event.content)
    .bind(event.sig.serialize().as_slice())
    .bind(received_at)
    .bind(channel_id)
    .bind(d_tag)
    .execute(&mut **tx)
    .await
    .map_err(|error| format!("failed to persist website event: {error}"))?;
    if result.rows_affected() != 1 {
        return Err("website event was already stored".to_owned());
    }
    Ok(StoredEvent::with_received_at(
        event.clone(),
        received_at,
        channel_id,
        true,
    ))
}

/// Replace the job's head at its NIP-33 coordinate inside the transaction.
pub(crate) async fn replace_head_tx(
    tx: &mut Transaction<'static, Postgres>,
    community: CommunityId,
    head: &Event,
    d_tag: &str,
    channel_id: Uuid,
) -> Result<StoredEvent, String> {
    let lock_key = replacement_lock_key(
        community,
        KIND_WEBSITE_HEAD as i32,
        head.pubkey.to_bytes().as_slice(),
        d_tag.as_bytes(),
    );
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(lock_key)
        .execute(&mut **tx)
        .await
        .map_err(|error| format!("failed to lock the website head: {error}"))?;

    let existing: Option<(DateTime<Utc>, Vec<u8>)> = sqlx::query_as(
        "SELECT created_at, id FROM events \
         WHERE community_id = $1 AND kind = $2 AND pubkey = $3 AND d_tag = $4 \
           AND deleted_at IS NULL \
         ORDER BY created_at DESC, id ASC LIMIT 1",
    )
    .bind(community.as_uuid())
    .bind(KIND_WEBSITE_HEAD as i32)
    .bind(head.pubkey.to_bytes().as_slice())
    .bind(d_tag)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|error| format!("failed to read the website head: {error}"))?;
    let incoming_at = DateTime::from_timestamp(head.created_at.as_secs() as i64, 0)
        .ok_or_else(|| "invalid website head timestamp".to_owned())?;
    if existing.as_ref().is_some_and(|(created_at, id)| {
        incoming_at < *created_at
            || (incoming_at == *created_at && head.id.as_bytes().as_slice() >= id.as_slice())
    }) {
        return Err("website head ordering conflict".to_owned());
    }
    if let Some((_, id)) = existing {
        sqlx::query(
            "UPDATE events SET deleted_at = NOW() \
             WHERE community_id = $1 AND kind = $2 AND pubkey = $3 AND d_tag = $4 \
               AND id = $5 AND deleted_at IS NULL",
        )
        .bind(community.as_uuid())
        .bind(KIND_WEBSITE_HEAD as i32)
        .bind(head.pubkey.to_bytes().as_slice())
        .bind(d_tag)
        .bind(id)
        .execute(&mut **tx)
        .await
        .map_err(|error| format!("failed to retire the website head: {error}"))?;
    }
    insert_event_tx(tx, community, head, Some(channel_id)).await
}

fn replacement_lock_key(community: CommunityId, kind: i32, pubkey: &[u8], d_tag: &[u8]) -> i64 {
    // Byte-for-byte aligned with buzz-db's replacement lock key so generic
    // NIP-33 writes and this relay-owned projection serialize alike.
    let mut hash: u64 = 0xcbf29ce484222325;
    for bytes in [
        community.as_uuid().as_bytes().as_slice(),
        kind.to_le_bytes().as_slice(),
        pubkey,
        d_tag,
    ] {
        for byte in bytes {
            hash ^= *byte as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    hash as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_DB_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz"; // sadscan:disable np.postgres.1 -- local test-only credentials

    fn sample_head(
        relay: &Keys,
        job_id: Uuid,
        channel_id: Uuid,
        generation: u64,
        head_at: i64,
    ) -> Event {
        build_head(
            relay,
            job_id,
            channel_id,
            "task-website",
            &"e".repeat(64),
            &[0x11; 32],
            &[0x22; 32],
            &[0x33; 32],
            &[0x44; 32],
            generation,
            br#"{"schema":"colony.website-review/v1"}"#,
            head_at,
        )
        .expect("build website head")
    }

    /// The stamp policy in isolation: a transition in the same second as its
    /// predecessor must still order strictly after it, while a brand-new job
    /// keeps the clock.
    #[test]
    fn next_head_at_pushes_a_same_second_transition_past_its_predecessor() {
        let now = 1_700_000_000_i64;
        assert_eq!(next_head_at(now, None), now);
        assert_eq!(next_head_at(now, Some(now)), now + 1);
        assert_eq!(next_head_at(now, Some(now - 10)), now);
    }

    /// Two accepted transitions inside one second: the second head must
    /// replace the first and resolve as the coordinate's current event, and a
    /// genuinely older head must still lose the ordering check.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn a_second_transition_in_one_second_replaces_the_head() {
        let database_url = std::env::var("BUZZ_TEST_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .unwrap_or_else(|_| TEST_DB_URL.to_owned());
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await
            .expect("connect to test Postgres");
        buzz_db::migration::run_migrations_unless_provisioned(&pool)
            .await
            .expect("apply migrations");

        let community_uuid = Uuid::new_v4();
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(community_uuid)
            .bind(format!("website-heads-{}.example", community_uuid.simple()))
            .execute(&pool)
            .await
            .expect("insert community");
        let community = CommunityId::from_uuid(community_uuid);
        let channel_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO channels \
                (id, community_id, name, channel_type, visibility, created_by) \
             VALUES ($1, $2, $3, 'stream'::channel_type, 'open'::channel_visibility, $4)",
        )
        .bind(channel_id)
        .bind(community.as_uuid())
        .bind(format!("website-{}", channel_id.simple()))
        .bind([0x11_u8; 32].as_slice())
        .execute(&pool)
        .await
        .expect("insert channel");

        let relay = Keys::generate();
        let job_id = Uuid::new_v4();
        let d_tag = head_d_tag(job_id);
        let now = Utc::now().timestamp();

        // First ordinary transition: a brand-new job keeps `now`.
        let first_at = next_head_at(now, None);
        let first = sample_head(&relay, job_id, channel_id, 1, first_at);
        let mut tx = pool.begin().await.expect("begin first replacement");
        replace_head_tx(&mut tx, community, &first, &d_tag, channel_id)
            .await
            .expect("the first head is accepted");
        tx.commit().await.expect("commit first replacement");

        // Second ordinary transition in the same second: the broker pushes its
        // stamp one second past the first, so NIP-33 accepts the replacement.
        let second_at = next_head_at(now, Some(first_at));
        let second = sample_head(&relay, job_id, channel_id, 2, second_at);
        let mut tx = pool.begin().await.expect("begin second replacement");
        replace_head_tx(&mut tx, community, &second, &d_tag, channel_id)
            .await
            .expect("a same-second transition is accepted");
        tx.commit().await.expect("commit second replacement");
        assert!(
            second.created_at > first.created_at,
            "the replacement head must order strictly after its predecessor"
        );

        // The coordinate resolves to exactly the second head.
        let live: Vec<Vec<u8>> = sqlx::query_scalar(
            "SELECT id FROM events \
             WHERE community_id = $1 AND kind = $2 AND pubkey = $3 AND d_tag = $4 \
               AND deleted_at IS NULL",
        )
        .bind(community.as_uuid())
        .bind(KIND_WEBSITE_HEAD as i32)
        .bind(relay.public_key().to_bytes().as_slice())
        .bind(d_tag.as_str())
        .fetch_all(&pool)
        .await
        .expect("read the live website head");
        assert_eq!(live, vec![second.id.as_bytes().to_vec()]);

        // The ordering check itself is untouched: a genuinely older head is
        // still refused with the ordering conflict.
        let stale = sample_head(&relay, job_id, channel_id, 3, first_at);
        let mut tx = pool.begin().await.expect("begin stale replacement");
        let error = replace_head_tx(&mut tx, community, &stale, &d_tag, channel_id)
            .await
            .expect_err("an older head must be refused");
        assert_eq!(error, "website head ordering conflict");
        tx.rollback().await.expect("rollback stale replacement");
        pool.close().await;
    }
}
