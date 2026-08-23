//! Payment top-up intents.
//!
//! One row per checkout attempt, written before the user leaves for the
//! hosted payment page. The reference maps a later provider callback back to
//! the member and the amount we asked for; the callback's own numbers are
//! checked against this row before anything is credited.
//!
//! Tenant scoped like every table here: the primary key leads with
//! `community_id`, so the same reference may exist in two communities and
//! every query binds `community_id` so one tenant's rows can never answer
//! another tenant's question.
//!
//! [`settle_intent`] is deliberately a single conditional UPDATE: the
//! `pending` guard in the WHERE clause is what makes two concurrent provider
//! retries unable to both observe a pending row and both act on it.

use sqlx::{PgPool, Row as _};

use crate::error::Result;
use crate::{deletion::DeletionStore, CommunityId};

/// A stored payment intent row.
#[derive(Debug)]
pub struct PaymentIntent {
    /// The checkout reference this row is keyed by, unique per community.
    pub reference: String,
    /// The member's public key that a settlement credits.
    pub pubkey: Vec<u8>,
    /// The amount we asked the provider to collect, in USD cents.
    pub usd_cents: i64,
    /// Lifecycle state: `pending`, `paid`, `failed`, or `abandoned`.
    pub status: String,
    /// The gateway that issued this reference at initialize time
    /// (`paystack` or `payfast`). A callback arriving through any other
    /// gateway must never settle the row.
    pub provider: String,
    /// The amount actually paid, in USD cents, recorded at settlement.
    pub paid_cents: Option<i64>,
}

/// Write a new pending intent for one member's checkout attempt.
///
/// Runs inside the community lifecycle gate, mirroring `create_account` for
/// this admission-style write: an intent must never appear for a community
/// that deletion has already fenced.
pub async fn create_intent(
    pool: &PgPool,
    community: CommunityId,
    reference: &str,
    pubkey: &[u8],
    usd_cents: i64,
    provider: &str,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    DeletionStore::new(pool.clone())
        .guard_transaction(&mut tx, community)
        .await?;
    sqlx::query(
        "INSERT INTO payment_intents (community_id, reference, pubkey, usd_cents, provider) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(community.as_uuid())
    .bind(reference)
    .bind(pubkey)
    .bind(usd_cents)
    .bind(provider)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Look up one intent by reference inside one tenant.
pub async fn find_intent(
    pool: &PgPool,
    community: CommunityId,
    reference: &str,
) -> Result<Option<PaymentIntent>> {
    let row = sqlx::query(
        "SELECT reference, pubkey, usd_cents, status, provider, paid_cents \
         FROM payment_intents \
         WHERE community_id = $1 AND reference = $2",
    )
    .bind(community.as_uuid())
    .bind(reference)
    .fetch_optional(pool)
    .await?;
    match row {
        Some(row) => Ok(Some(PaymentIntent {
            reference: row.try_get("reference")?,
            pubkey: row.try_get("pubkey")?,
            usd_cents: row.try_get("usd_cents")?,
            status: row.try_get("status")?,
            provider: row.try_get("provider")?,
            paid_cents: row.try_get("paid_cents")?,
        })),
        None => Ok(None),
    }
}

/// Mark one pending intent paid exactly once, recording what was actually
/// paid and when.
///
/// The whole transition is one conditional UPDATE: only a row still reading
/// `pending` is settled, and `RETURNING` turns the row lock into the answer.
/// Two concurrent webhook retries therefore cannot both observe a pending
/// row and both proceed past this call; the loser updates nothing and gets
/// `false`. Returns whether this call did the settling.
pub async fn settle_intent(
    pool: &PgPool,
    community: CommunityId,
    reference: &str,
    paid_cents: i64,
) -> Result<bool> {
    let settled: Option<String> = sqlx::query_scalar(
        "UPDATE payment_intents \
         SET status = 'paid', paid_cents = $3, settled_at = now() \
         WHERE community_id = $1 AND reference = $2 AND status = 'pending' \
         RETURNING reference",
    )
    .bind(community.as_uuid())
    .bind(reference)
    .bind(paid_cents)
    .fetch_optional(pool)
    .await?;
    Ok(settled.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::PgPool;
    use uuid::Uuid;

    const TEST_DB_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz"; // sadscan:disable np.postgres.1

    async fn setup_pool() -> PgPool {
        PgPool::connect(&test_database_url())
            .await
            .expect("connect to test DB")
    }

    fn test_database_url() -> String {
        std::env::var("BUZZ_TEST_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .unwrap_or_else(|_| TEST_DB_URL.to_owned())
    }

    // Mirrors email_accounts.rs verbatim. Do not write a second fixture: a
    // second fixture drifts from the first.
    async fn make_test_community(pool: &PgPool) -> CommunityId {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(id)
            .bind(format!("payment-intents-test-{}.example", id.simple()))
            .execute(pool)
            .await
            .expect("insert test community");
        CommunityId::from_uuid(id)
    }

    async fn delete_test_community(pool: &PgPool, community: CommunityId) {
        let mut tx = pool.begin().await.expect("begin test cleanup");
        // Community rows are permanent tombstones. Authorize this fixture-only
        // cleanup with the initial fence generation, then leave the host row in
        // place instead of bypassing the tombstone contract with DELETE.
        sqlx::query(
            "SELECT set_config('buzz.deletion_executor_community', $1, true), \
                    set_config('buzz.deletion_fence_generation', '0', true)",
        )
        .bind(community.to_string())
        .execute(&mut *tx)
        .await
        .expect("authorize test cleanup");
        sqlx::query("DELETE FROM payment_intents WHERE community_id = $1")
            .bind(community.as_uuid())
            .execute(&mut *tx)
            .await
            .expect("delete test payment intents");
        sqlx::query(
            "UPDATE communities SET deletion_state = 'tombstone', \
                    deleted_at = COALESCE(deleted_at, now()), \
                    archived_at = COALESCE(archived_at, now()), \
                    signing_key = NULL \
             WHERE id = $1 AND deletion_state = 'active'",
        )
        .bind(community.as_uuid())
        .execute(&mut *tx)
        .await
        .expect("tombstone test community");
        tx.commit().await.expect("commit test cleanup");
    }

    fn sample_pubkey() -> Vec<u8> {
        vec![7u8; 32]
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn creates_then_finds_an_intent() {
        let pool = setup_pool().await;
        let community = make_test_community(&pool).await;
        create_intent(&pool, community, "ref-1", &sample_pubkey(), 500, "paystack")
            .await
            .expect("create should succeed");

        let found = find_intent(&pool, community, "ref-1")
            .await
            .expect("lookup should succeed")
            .expect("intent should exist");
        assert_eq!(found.reference, "ref-1");
        assert_eq!(found.pubkey, sample_pubkey());
        assert_eq!(found.usd_cents, 500);
        assert_eq!(found.status, "pending");
        assert_eq!(found.paid_cents, None);
        assert_eq!(found.provider, "paystack");
        delete_test_community(&pool, community).await;
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn rejects_a_duplicate_reference() {
        let pool = setup_pool().await;
        let community = make_test_community(&pool).await;
        create_intent(&pool, community, "ref-1", &sample_pubkey(), 500, "paystack")
            .await
            .expect("first insert");
        let second =
            create_intent(&pool, community, "ref-1", &sample_pubkey(), 500, "paystack").await;
        assert!(second.is_err(), "a duplicate reference must be rejected");
        delete_test_community(&pool, community).await;
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn an_intent_is_invisible_from_another_community() {
        let pool = setup_pool().await;
        let first = make_test_community(&pool).await;
        let second = make_test_community(&pool).await;
        create_intent(&pool, first, "ref-1", &sample_pubkey(), 500, "paystack")
            .await
            .expect("first community");
        let found = find_intent(&pool, second, "ref-1")
            .await
            .expect("cross-tenant lookup");
        assert!(found.is_none(), "intents must not leak across tenants");
        delete_test_community(&pool, first).await;
        delete_test_community(&pool, second).await;
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn settles_once_and_refuses_a_replay() {
        let pool = setup_pool().await;
        let community = make_test_community(&pool).await;
        create_intent(&pool, community, "ref-1", &sample_pubkey(), 500, "paystack")
            .await
            .expect("create");

        let settled = settle_intent(&pool, community, "ref-1", 500)
            .await
            .expect("first settle");
        assert!(settled, "the first settle must win");

        let replay = settle_intent(&pool, community, "ref-1", 500)
            .await
            .expect("replayed settle");
        assert!(!replay, "a replayed settle must be refused");

        let found = find_intent(&pool, community, "ref-1")
            .await
            .expect("lookup")
            .expect("intent exists");
        assert_eq!(found.status, "paid");
        delete_test_community(&pool, community).await;
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn a_settled_intent_keeps_its_original_amount_alongside_paid_cents() {
        let pool = setup_pool().await;
        let community = make_test_community(&pool).await;
        create_intent(&pool, community, "ref-1", &sample_pubkey(), 500, "paystack")
            .await
            .expect("create");

        // The callback reported more than we asked for. Both numbers must
        // survive: what we hoped for and what was actually paid.
        let settled = settle_intent(&pool, community, "ref-1", 700)
            .await
            .expect("settle");
        assert!(settled);

        let found = find_intent(&pool, community, "ref-1")
            .await
            .expect("lookup")
            .expect("intent exists");
        assert_eq!(found.usd_cents, 500, "the asked amount must not move");
        assert_eq!(found.paid_cents, Some(700));
        delete_test_community(&pool, community).await;
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn the_write_fence_covers_the_table() {
        let pool = setup_pool().await;
        let fenced: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pg_trigger trigger \
             JOIN pg_class c ON c.oid = trigger.tgrelid \
             JOIN pg_proc p ON p.oid = trigger.tgfoid \
             WHERE c.relname = 'payment_intents' \
               AND p.proname = 'enforce_community_write_fence' \
               AND NOT trigger.tgisinternal",
        )
        .fetch_one(&pool)
        .await
        .expect("count write fences");
        assert_eq!(fenced, 1, "every new tenant table must carry the fence");
    }
}
