//! Colony Credits: accounts, the append-only credit ledger, and the atomic
//! debit/credit API.
//!
//! Money is nanoUSD integers everywhere — never floats in the schema or the
//! API (matching `crates/buzz-meter-core/src/cost.rs`). The balance is usage
//! credits: every model call debits the provider's **observed cost 1:1**
//! (see `colony-credits-gateway` spec, "Checkout model"). Colony's fee is
//! charged once at purchase time and never appears in this ledger.
//!
//! Idempotency contract: a replayed `ref` is a no-op that returns the
//! original ledger entry. Concurrent settles with distinct refs never lose
//! updates — the balance change is a single atomic `UPDATE` that row-locks
//! the account, so the last writer always builds on the committed value.
//!
//! Negative balance is representable: bounded overdraft on settle is legal;
//! hard-blocking new calls is admission's job (a later ticket), not ours.

use crate::error::Result;
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};

/// Single source of truth for the nanoUSD unit, re-exported from
/// `buzz-meter-core` so the definition cannot drift from the metering layer.
pub use buzz_meter_core::cost::NANOUSD_PER_USD;

/// A single append-only `credit_ledger` entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LedgerEntry {
    /// Surrogate identity, unique per entry.
    pub id: i64,
    /// Account pubkey (32 raw bytes).
    pub pubkey: Vec<u8>,
    /// Signed nanoUSD change applied to the balance (negative for debits).
    pub delta: i64,
    /// Ledger kind: `debit`, `credit`, `seed`, or `correction`.
    pub kind: String,
    /// Idempotency reference — unique per account.
    pub reference: String,
    /// Model that produced the call, when the entry is a debit.
    pub model: Option<String>,
    /// The provider-stated cost in nanoUSD that this debit is based on.
    pub observed_cost: Option<i64>,
    /// Provider request id, when the entry is a debit.
    pub request_id: Option<String>,
    /// When the entry was recorded (UTC).
    pub created_at: DateTime<Utc>,
}

/// Return the account's current balance in nanoUSD. Accounts that have never
/// been seen have a balance of zero (their row is created on first activity).
pub async fn balance(pool: &PgPool, pubkey: &[u8]) -> Result<i64> {
    let row = sqlx::query("SELECT balance FROM accounts WHERE pubkey = $1")
        .bind(pubkey)
        .fetch_optional(pool)
        .await?;
    Ok(match row {
        Some(row) => row.try_get("balance")?,
        None => 0,
    })
}

/// Credit an account (positive nanoUSD `delta`), idempotent on `reference`.
///
/// Used for purchase webhooks (kind `credit`). A replayed reference is a
/// no-op returning the original entry; the balance is changed at most once.
pub async fn credit(
    pool: &PgPool,
    pubkey: &[u8],
    delta: i64,
    reference: &str,
) -> Result<LedgerEntry> {
    apply_entry(
        pool,
        EntryParams {
            pubkey,
            delta,
            kind: "credit",
            reference,
            model: None,
            observed_cost: None,
            request_id: None,
        },
    )
    .await
}

/// Seed an account (positive nanoUSD `delta`), idempotent on `reference`.
///
/// Operator path for Phase 1 money in (kind `seed`).
pub async fn seed(
    pool: &PgPool,
    pubkey: &[u8],
    delta: i64,
    reference: &str,
) -> Result<LedgerEntry> {
    apply_entry(
        pool,
        EntryParams {
            pubkey,
            delta,
            kind: "seed",
            reference,
            model: None,
            observed_cost: None,
            request_id: None,
        },
    )
    .await
}

/// Debit the provider's observed cost 1:1, idempotent on `reference`.
///
/// `cost` is nanoUSD as reported by the provider (see
/// `buzz-meter-core::observed_cost_nanousd`). The ledger line's `delta` is
/// `-cost` and `observed_cost` records the basis. `model` and `request_id`
/// are the gateway's attribution for the call. A replayed reference is a
/// no-op returning the original entry.
pub async fn debit_observed(
    pool: &PgPool,
    pubkey: &[u8],
    cost: u64,
    reference: &str,
    model: Option<&str>,
    request_id: Option<&str>,
) -> Result<LedgerEntry> {
    let cost = i64::try_from(cost)
        .map_err(|_| crate::error::DbError::InvalidAmount(format!("cost {cost} exceeds i64")))?;
    apply_entry(
        pool,
        EntryParams {
            pubkey,
            delta: -cost,
            kind: "debit",
            reference,
            model,
            observed_cost: Some(cost),
            request_id,
        },
    )
    .await
}

/// Sum of `debit` observed costs for one UTC day (`[day 00:00, day+1 00:00)`).
///
/// The daily reconciliation job compares this against the upstream (Vercel
/// AI Gateway) usage export. The window bounds are bound as `TIMESTAMPTZ`
/// (UTC), never as bare `TIMESTAMP`: Postgres would otherwise coerce the
/// latter using the session TimeZone, silently shifting the window — and a
/// shifted window can mask real drift, which is what reconciliation exists
/// to catch.
pub async fn debits_on_day(pool: &PgPool, day: chrono::NaiveDate) -> Result<i64> {
    let midnight = |date: chrono::NaiveDate| {
        date.and_hms_opt(0, 0, 0)
            .ok_or_else(|| crate::error::DbError::InvalidData("midnight is a valid time".into()))
            .map(|t| t.and_utc())
    };
    let start = midnight(day)?;
    let end = midnight(
        day.succ_opt()
            .ok_or_else(|| crate::error::DbError::InvalidData("date has no successor".into()))?,
    )?;
    let total: Option<i64> = sqlx::query_scalar(
        "SELECT COALESCE(SUM(observed_cost), 0)::BIGINT FROM credit_ledger \
         WHERE kind = 'debit' AND created_at >= $1 AND created_at < $2",
    )
    .bind(start)
    .bind(end)
    .fetch_one(pool)
    .await?;
    Ok(total.unwrap_or(0))
}

fn row_to_entry(row: &sqlx::postgres::PgRow) -> Result<LedgerEntry> {
    Ok(LedgerEntry {
        id: row.try_get("id")?,
        pubkey: row.try_get("pubkey")?,
        delta: row.try_get("delta")?,
        kind: row.try_get("kind")?,
        reference: row.try_get("ref")?,
        model: row.try_get("model")?,
        observed_cost: row.try_get("observed_cost")?,
        request_id: row.try_get("request_id")?,
        created_at: row.try_get("created_at")?,
    })
}

/// Parameters of one ledger entry application (kind + money + attribution).
struct EntryParams<'a> {
    pubkey: &'a [u8],
    delta: i64,
    kind: &'a str,
    reference: &'a str,
    model: Option<&'a str>,
    observed_cost: Option<i64>,
    request_id: Option<&'a str>,
}

async fn apply_entry(pool: &PgPool, params: EntryParams<'_>) -> Result<LedgerEntry> {
    if params.kind == "credit" || params.kind == "seed" {
        if params.delta <= 0 {
            return Err(crate::error::DbError::InvalidAmount(format!(
                "{} must be a positive amount, got {}",
                params.kind, params.delta
            )));
        }
    } else if params.kind == "debit" && params.delta > 0 {
        return Err(crate::error::DbError::InvalidAmount(format!(
            "debit cost must be non-negative, got {}",
            params.delta
        )));
    }
    apply_entry_inner(pool, params).await
}

/// Apply a ledger entry and its balance change in ONE transaction.
///
/// - The account row is created on first activity (`ON CONFLICT DO NOTHING`).
/// - The ledger insert is idempotent on `(pubkey, ref)`: a replay conflicts
///   and is a no-op that returns the original entry.
/// - The balance update is a single atomic `UPDATE accounts SET balance =
///   balance + delta`; the row lock serializes concurrent distinct-ref
///   settles, so no update is ever lost.
async fn apply_entry_inner(pool: &PgPool, params: EntryParams<'_>) -> Result<LedgerEntry> {
    let pubkey = params.pubkey;
    let delta = params.delta;
    let kind = params.kind;
    let reference = params.reference;
    let model = params.model;
    let observed_cost = params.observed_cost;
    let request_id = params.request_id;
    let mut tx = pool.begin().await?;

    sqlx::query("INSERT INTO accounts (pubkey) VALUES ($1) ON CONFLICT (pubkey) DO NOTHING")
        .bind(pubkey)
        .execute(&mut *tx)
        .await?;

    let row = sqlx::query(
        "INSERT INTO credit_ledger (pubkey, delta, kind, ref, model, observed_cost, request_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) \
         ON CONFLICT (pubkey, ref) DO NOTHING \
         RETURNING id, pubkey, delta, kind, ref, model, observed_cost, request_id, created_at",
    )
    .bind(pubkey)
    .bind(delta)
    .bind(kind)
    .bind(reference)
    .bind(model)
    .bind(observed_cost)
    .bind(request_id)
    .fetch_optional(&mut *tx)
    .await?;

    let entry = match row {
        Some(row) => {
            // Fresh entry: apply the balance change atomically. The row lock
            // on `accounts` serializes concurrent distinct-ref settles.
            sqlx::query(
                "UPDATE accounts SET balance = balance + $1, updated_at = now() \
                 WHERE pubkey = $2",
            )
            .bind(delta)
            .bind(pubkey)
            .execute(&mut *tx)
            .await?;
            row_to_entry(&row)?
        }
        None => {
            // Replayed ref: the conflicting row is committed (our insert
            // waited on it) — return the original entry, balance untouched.
            //
            // Why this is a no-op rather than a double debit: under READ
            // COMMITTED (the pool default) the conflicting insert either
            // committed before ours — ours then sees the row and this branch
            // is taken — or it commits after ours, in which case ours won the
            // conflict and never reaches here. Either way the account UPDATE
            // runs exactly once. `apply_entry` opening its own transaction is
            // what keeps callers from weakening this: the conflict resolution
            // and the re-select share one transaction, and no caller-supplied
            // transaction can widen the window. Under REPEATABLE READ the
            // same race fails loudly with a serialization error instead of
            // double-debiting — the dangerous direction always errors.
            let row = sqlx::query(
                "SELECT id, pubkey, delta, kind, ref, model, observed_cost, request_id, created_at \
                 FROM credit_ledger WHERE pubkey = $1 AND ref = $2",
            )
            .bind(pubkey)
            .bind(reference)
            .fetch_one(&mut *tx)
            .await?;
            row_to_entry(&row)?
        }
    };

    tx.commit().await?;
    Ok(entry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::Keys;
    use sqlx::postgres::PgPoolOptions;
    use sqlx::PgPool;

    const TEST_DB_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz";

    fn random_pubkey() -> Vec<u8> {
        Keys::generate().public_key().to_bytes().to_vec()
    }

    /// Admin pool on the server named by `TEST_DATABASE_URL` (defaults to the
    /// standard dev Postgres; point it at an isolated harness when running
    /// concurrently).
    async fn admin_pool() -> PgPool {
        let url = std::env::var("TEST_DATABASE_URL").unwrap_or_else(|_| TEST_DB_URL.into());
        PgPool::connect(&url)
            .await
            .expect("connect to admin test DB")
    }

    /// Create a scratch database, run the full migration set, and return
    /// (pool, db_name). Callers must drop it with `drop_scratch`.
    async fn scratch(admin: &PgPool, prefix: &str) -> (PgPool, String) {
        let name = format!("{}_{}", prefix, uuid::Uuid::new_v4().simple());
        sqlx::query(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
            .execute(admin)
            .await
            .expect("create scratch db");
        let base = std::env::var("TEST_DATABASE_URL").unwrap_or_else(|_| TEST_DB_URL.into());
        let scratch_url = {
            let idx = base.rfind('/').expect("db url has a path segment");
            format!("{}/{}", &base[..idx], name)
        };
        let pool = PgPool::connect(&scratch_url)
            .await
            .expect("connect scratch db");
        crate::migration::run_migrations(&pool)
            .await
            .expect("migrate scratch db");
        (pool, name)
    }

    async fn drop_scratch(admin: &PgPool, pool: PgPool, name: &str) {
        pool.close().await;
        let _ = sqlx::query(sqlx::AssertSqlSafe(format!(
            "DROP DATABASE IF EXISTS {name} WITH (FORCE)"
        )))
        .execute(admin)
        .await;
    }

    async fn entry_count(pool: &PgPool, pubkey: &[u8]) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM credit_ledger WHERE pubkey = $1")
            .bind(pubkey)
            .fetch_one(pool)
            .await
            .expect("count ledger entries")
    }

    /// Acceptance 1: two concurrent `debit_observed` with distinct refs both
    /// land — no lost update.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn concurrent_distinct_ref_debits_both_land() {
        let admin = admin_pool().await;
        let (pool, name) = scratch(&admin, "credits_conc").await;
        let pubkey = random_pubkey();
        seed(&pool, &pubkey, 1_000_000_000, "seed-conc")
            .await
            .expect("seed");

        let (a, b) = tokio::join!(
            debit_observed(
                &pool,
                &pubkey,
                250_000_000,
                "req-a",
                Some("deepseek-v4-flash"),
                None
            ),
            debit_observed(
                &pool,
                &pubkey,
                300_000_000,
                "req-b",
                Some("deepseek-v4-flash"),
                None
            ),
        );
        a.expect("debit a must land");
        b.expect("debit b must land");

        let bal = balance(&pool, &pubkey).await.expect("balance");
        assert_eq!(
            bal,
            1_000_000_000 - 250_000_000 - 300_000_000,
            "both concurrent debits must be reflected in the balance"
        );
        assert_eq!(
            entry_count(&pool, &pubkey).await,
            3,
            "seed + both debits recorded"
        );
        drop_scratch(&admin, pool, &name).await;
    }

    /// Acceptance 1: a replayed ref (raced) is a no-op returning the original
    /// entry; the balance changes once.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn concurrent_same_ref_replay_is_noop() {
        let admin = admin_pool().await;
        let (pool, name) = scratch(&admin, "credits_replay").await;
        let pubkey = random_pubkey();
        seed(&pool, &pubkey, 1_000_000_000, "seed-replay")
            .await
            .expect("seed");

        let (a, b) = tokio::join!(
            debit_observed(&pool, &pubkey, 100_000_000, "req-same", None, Some("rid-1")),
            debit_observed(&pool, &pubkey, 100_000_000, "req-same", None, Some("rid-1")),
        );
        let ea = a.expect("first debit must land");
        let eb = b.expect("replayed debit must be a no-op, not an error");

        assert_eq!(ea.id, eb.id, "replay returns the original entry");
        assert_eq!(ea.delta, -100_000_000);
        assert_eq!(eb.delta, -100_000_000);
        let bal = balance(&pool, &pubkey).await.expect("balance");
        assert_eq!(bal, 900_000_000, "replay must not debit twice");
        assert_eq!(
            entry_count(&pool, &pubkey).await,
            2,
            "seed + exactly one debit recorded"
        );
        drop_scratch(&admin, pool, &name).await;
    }

    /// Acceptance 1: sequential replay returns the original entry and changes
    /// nothing.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn sequential_replay_returns_original_entry() {
        let admin = admin_pool().await;
        let (pool, name) = scratch(&admin, "credits_seq").await;
        let pubkey = random_pubkey();
        seed(&pool, &pubkey, 1_000_000_000, "seed-seq")
            .await
            .expect("seed");

        let first = debit_observed(&pool, &pubkey, 42_000_000, "req-seq", None, None)
            .await
            .expect("first debit");
        let second = debit_observed(&pool, &pubkey, 42_000_000, "req-seq", None, None)
            .await
            .expect("replay");
        assert_eq!(first.id, second.id, "replay returns the original entry");
        assert_eq!(first.created_at, second.created_at);
        assert_eq!(balance(&pool, &pubkey).await.expect("balance"), 958_000_000);
        assert_eq!(entry_count(&pool, &pubkey).await, 2);
        drop_scratch(&admin, pool, &name).await;
    }

    /// Acceptance 2: a debit that takes the balance negative succeeds and
    /// records the negative balance.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn negative_balance_is_representable() {
        let admin = admin_pool().await;
        let (pool, name) = scratch(&admin, "credits_neg").await;
        let pubkey = random_pubkey();
        seed(&pool, &pubkey, 100_000_000, "seed-neg")
            .await
            .expect("seed");

        let entry = debit_observed(&pool, &pubkey, 250_000_000, "req-neg", None, None)
            .await
            .expect("overdraft debit succeeds");
        assert_eq!(entry.delta, -250_000_000);
        assert_eq!(entry.observed_cost, Some(250_000_000));
        let bal = balance(&pool, &pubkey).await.expect("balance");
        assert_eq!(bal, -150_000_000, "negative balance recorded");
        drop_scratch(&admin, pool, &name).await;
    }

    /// Acceptance 4 (DB layer): seeding twice with one ref credits once.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn seed_twice_same_ref_credits_once() {
        let admin = admin_pool().await;
        let (pool, name) = scratch(&admin, "credits_seed").await;
        let pubkey = random_pubkey();

        let first = seed(&pool, &pubkey, 500_000_000, "seed-op-1")
            .await
            .expect("seed 1");
        let second = seed(&pool, &pubkey, 500_000_000, "seed-op-1")
            .await
            .expect("seed replay");
        assert_eq!(first.id, second.id, "replay returns the original entry");
        assert_eq!(first.kind, "seed");
        assert_eq!(balance(&pool, &pubkey).await.expect("balance"), 500_000_000);
        assert_eq!(entry_count(&pool, &pubkey).await, 1);
        drop_scratch(&admin, pool, &name).await;
    }

    /// A zero-cost debit is a legal ledger line (the provider stated the call
    /// was free); a zero or negative credit is rejected.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn zero_cost_debit_allowed_but_zero_credit_rejected() {
        let admin = admin_pool().await;
        let (pool, name) = scratch(&admin, "credits_zero").await;
        let pubkey = random_pubkey();
        seed(&pool, &pubkey, 100_000_000, "seed-zero")
            .await
            .expect("seed");

        let entry = debit_observed(&pool, &pubkey, 0, "req-zero", None, None)
            .await
            .expect("zero-cost debit is legal");
        assert_eq!(entry.delta, 0);
        assert_eq!(entry.observed_cost, Some(0));
        assert_eq!(balance(&pool, &pubkey).await.expect("balance"), 100_000_000);

        let err = seed(&pool, &pubkey, 0, "seed-zero-bad")
            .await
            .expect_err("zero seed rejected");
        assert!(
            err.to_string().contains("positive amount"),
            "unexpected: {err}"
        );
        let err = credit(&pool, &pubkey, -5, "credit-bad")
            .await
            .expect_err("negative credit rejected");
        assert!(
            err.to_string().contains("positive amount"),
            "unexpected: {err}"
        );
        drop_scratch(&admin, pool, &name).await;
    }

    /// Acceptance: `debits_on_day` is independent of the session TimeZone —
    /// the day window is UTC by contract. Regression: `start`/`end` were
    /// bound as `NaiveDateTime`, which sqlx sends as bare `TIMESTAMP`;
    /// Postgres coerces that to `TIMESTAMPTZ` using the session TimeZone, so
    /// under `Africa/Johannesburg` (UTC+2, no DST) the window shifted two
    /// hours. A shifted window can mask real reconciliation drift — the exact
    /// failure this query exists to catch.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn debits_on_day_window_is_independent_of_session_timezone() {
        let admin = admin_pool().await;
        let (pool, name) = scratch(&admin, "credits_tz").await;
        let base = std::env::var("TEST_DATABASE_URL").unwrap_or_else(|_| TEST_DB_URL.into());
        let scratch_url = {
            let idx = base.rfind('/').expect("db url has a path segment");
            format!("{}/{}", &base[..idx], name)
        };
        // One connection so `SET TIME ZONE` deterministically applies to the
        // queries that follow (a pool could route them to different sessions).
        let single = PgPoolOptions::new()
            .max_connections(1)
            .connect(&scratch_url)
            .await
            .expect("connect scratch db single-connection");
        let pubkey = random_pubkey();

        // Direct inserts so `created_at` is exact. Johannesburg midnight is
        // 22:00 UTC, so 21:59:59Z is still the previous JNB day and 22:00:00Z
        // the next one — a 2h-shifted window returns a different row set for
        // the same UTC day.
        let rows: [(&str, i64, &str); 3] = [
            ("2026-08-06 22:00:00+00", 100, "tz-a"),
            ("2026-08-07 21:59:59+00", 200, "tz-b"),
            ("2026-08-07 22:00:00+00", 400, "tz-c"),
        ];
        for (at, cost, reference) in rows {
            sqlx::query(
                "INSERT INTO credit_ledger \
                    (pubkey, delta, kind, ref, observed_cost, created_at) \
                 VALUES ($1, -$2, 'debit', $3, $2, $4::timestamptz)",
            )
            .bind(&pubkey)
            .bind(cost)
            .bind(reference)
            .bind(at)
            .execute(&pool)
            .await
            .expect("insert boundary debit");
        }

        let day = chrono::NaiveDate::from_ymd_opt(2026, 8, 7).expect("valid date");

        sqlx::query("SET TIME ZONE 'UTC'")
            .execute(&single)
            .await
            .expect("set session timezone to UTC");
        let utc_total = debits_on_day(&single, day).await.expect("utc total");
        assert_eq!(
            utc_total, 600,
            "UTC window [08-07 00:00, 08-08 00:00) covers the 21:59:59Z and \
             22:00:00Z debits, not the previous day 22:00:00Z one"
        );

        sqlx::query("SET TIME ZONE 'Africa/Johannesburg'")
            .execute(&single)
            .await
            .expect("set session timezone to Africa/Johannesburg");
        let jnb_total = debits_on_day(&single, day).await.expect("jnb total");
        assert_eq!(
            jnb_total, utc_total,
            "session TimeZone must not shift the UTC day window: got \
             {jnb_total}, expected {utc_total}"
        );

        single.close().await;
        drop_scratch(&admin, pool, &name).await;
    }
}
