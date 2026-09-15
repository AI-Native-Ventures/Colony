//! Monthly partition manager for `events` and `delivery_log`.
//!
//! Call `ensure_future_partitions` on startup and monthly via cron.

use chrono::{DateTime, Datelike, TimeZone, Utc};
use sqlx::{PgPool, Row};
use tracing::{info, warn};

use crate::error::{DbError, Result};

/// Tables that may be partition-managed. Allowlist prevents DDL injection.
const PARTITIONED_TABLES: &[&str] = &["events", "delivery_log"];

/// Suffix of the right-edge catch-all partition created by `0001_initial_schema.sql`.
const CATCH_ALL_SUFFIX: &str = "_p_future";

/// Statement timeout for the roll-forward transaction's exclusive locks.
///
/// The transaction takes ACCESS EXCLUSIVE on the parent table. A relay that is
/// starting up must never block behind a long-running query on `events`, so the
/// attempt is bounded and failure is non-fatal.
const ROLL_FORWARD_LOCK_TIMEOUT: &str = "5s";

/// Postgres `lock_not_available`, raised when `lock_timeout` expires.
const SQLSTATE_LOCK_NOT_AVAILABLE: &str = "55P03";

/// Postgres `invalid_object_definition`, raised by "would overlap partition".
const SQLSTATE_OVERLAPPING_PARTITION: &str = "42P17";

/// Operator script that splits a catch-all partition that already holds rows.
const SPLIT_SCRIPT: &str = "deploy/fly/split-events-catch-all.sh";

/// Ensures monthly partition tables exist for the next `months_ahead` months.
pub async fn ensure_future_partitions(pool: &PgPool, months_ahead: u32) -> Result<()> {
    let now = Utc::now();

    for i in 0..=(months_ahead as i32) {
        let year = now.year();
        let month = now.month() as i32 + i;
        let (target_year, target_month) = if month > 12 {
            (year + (month - 1) / 12, ((month - 1) % 12 + 1) as u32)
        } else {
            (year, month as u32)
        };

        let (end_year, end_month) = if target_month == 12 {
            (target_year + 1, 1u32)
        } else {
            (target_year, target_month + 1)
        };

        let start = Utc
            .with_ymd_and_hms(target_year, target_month, 1, 0, 0, 0)
            .single()
            .ok_or_else(|| {
                DbError::InvalidData(format!("invalid date: {target_year}-{target_month:02}-01"))
            })?;
        let end = Utc
            .with_ymd_and_hms(end_year, end_month, 1, 0, 0, 0)
            .single()
            .ok_or_else(|| {
                DbError::InvalidData(format!("invalid date: {end_year}-{end_month:02}-01"))
            })?;

        let suffix = format!("{:04}_{:02}", target_year, target_month);
        let start_str = start.format("%Y-%m-%d").to_string();
        let end_str = end.format("%Y-%m-%d").to_string();

        for table in PARTITIONED_TABLES {
            ensure_partition(pool, table, &start_str, &end_str, &suffix, end).await?;
        }
    }

    Ok(())
}

/// Validate that a partition suffix is digits and underscores only.
fn validate_partition_suffix(suffix: &str) -> bool {
    !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit() || c == '_')
}

/// Validate that a catalog-read identifier is safe to interpolate into DDL.
fn validate_identifier(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 63
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// Validate that a date string matches YYYY-MM-DD format.
fn validate_date_str(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(|b| b.is_ascii_digit())
        && bytes[5..7].iter().all(|b| b.is_ascii_digit())
        && bytes[8..].iter().all(|b| b.is_ascii_digit())
}

async fn ensure_partition(
    pool: &PgPool,
    table_name: &str,
    start_date_str: &str,
    end_date_str: &str,
    suffix: &str,
    end: DateTime<Utc>,
) -> Result<()> {
    // Allowlist check -- parameterized queries cannot be used for DDL identifiers.
    if !PARTITIONED_TABLES.contains(&table_name) {
        return Err(DbError::InvalidData(format!(
            "table not in partition allowlist: {table_name:?}"
        )));
    }
    if !validate_partition_suffix(suffix) {
        return Err(DbError::InvalidData(format!(
            "partition suffix contains invalid characters: {suffix:?}"
        )));
    }
    if !validate_date_str(start_date_str) {
        return Err(DbError::InvalidData(format!(
            "start_date_str is not YYYY-MM-DD: {start_date_str:?}"
        )));
    }
    if !validate_date_str(end_date_str) {
        return Err(DbError::InvalidData(format!(
            "end_date_str is not YYYY-MM-DD: {end_date_str:?}"
        )));
    }

    let partition_name = format!("{table_name}_p{suffix}");

    let row = sqlx::query(
        r#"
        SELECT COUNT(*) as cnt
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND c.relname = $1
          AND c.relispartition = true
        "#,
    )
    .bind(&partition_name)
    .fetch_one(pool)
    .await?;

    let cnt: i64 = row.try_get("cnt")?;
    if cnt > 0 {
        return Ok(());
    }

    // DDL identifiers cannot be parameterized -- all inputs are validated above.
    let sql = format!(
        "CREATE TABLE IF NOT EXISTS {partition_name} PARTITION OF {table_name} \
         FOR VALUES FROM ('{start_date_str}') TO ('{end_date_str}')"
    );

    match sqlx::query(sqlx::AssertSqlSafe(sql)).execute(pool).await {
        Ok(_) => {
            info!("added partition {partition_name}");
            Ok(())
        }
        Err(sqlx::Error::Database(db_err))
            if db_err.code().as_deref() == Some(SQLSTATE_OVERLAPPING_PARTITION)
                && db_err.message().contains("would overlap partition") =>
        {
            // Fresh schemas include a right-edge catch-all partition (`*_p_future`)
            // whose lower bound is fixed by the initial schema. Left alone it
            // swallows every month past that bound forever, on every deployment,
            // so roll its lower bound forward and put a real month in front of it.
            roll_catch_all_forward(
                pool,
                table_name,
                &partition_name,
                start_date_str,
                end_date_str,
                end,
            )
            .await
        }
        Err(e) => Err(e.into()),
    }
}

/// The right-edge catch-all partition of `table_name`, as the catalog sees it.
struct CatchAll {
    /// Partition table name, always `{table_name}{CATCH_ALL_SUFFIX}`.
    name: String,
    /// Range partition key column of the parent table.
    key_column: String,
    /// Inclusive lower bound of the catch-all's range.
    lower_bound: DateTime<Utc>,
}

/// Look up `{table_name}_p_future`, if it exists and is unbounded on the right.
///
/// Returns `None` when there is no such partition, when its upper bound is not
/// `MAXVALUE`, or when its lower bound cannot be read: in every one of those
/// cases the overlap was with something this function must not touch.
async fn load_catch_all(pool: &PgPool, table_name: &str) -> Result<Option<CatchAll>> {
    let catch_all_name = format!("{table_name}{CATCH_ALL_SUFFIX}");
    let row = sqlx::query(
        r#"
        SELECT
            substring(
                pg_catalog.pg_get_expr(c.relpartbound, c.oid) from 'FROM \(''([^'']+)''\)'
            )::timestamptz AS lower_bound,
            pg_catalog.pg_get_expr(c.relpartbound, c.oid) LIKE '%TO (MAXVALUE)' AS unbounded,
            a.attname::text AS key_column
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid
        JOIN pg_catalog.pg_class parent ON parent.oid = i.inhparent
        JOIN pg_catalog.pg_namespace n ON n.oid = parent.relnamespace
        JOIN pg_catalog.pg_partitioned_table p ON p.partrelid = parent.oid
        JOIN pg_catalog.pg_attribute a
          ON a.attrelid = parent.oid AND a.attnum = p.partattrs[0]
        WHERE n.nspname = current_schema()
          AND parent.relname = $1
          AND c.relname = $2
        "#,
    )
    .bind(table_name)
    .bind(&catch_all_name)
    .fetch_optional(pool)
    .await?;

    let Some(row) = row else {
        return Ok(None);
    };
    let unbounded: Option<bool> = row.try_get("unbounded")?;
    let lower_bound: Option<DateTime<Utc>> = row.try_get("lower_bound")?;
    let key_column: String = row.try_get("key_column")?;
    let (Some(true), Some(lower_bound)) = (unbounded, lower_bound) else {
        return Ok(None);
    };
    if !validate_identifier(&key_column) {
        return Ok(None);
    }

    Ok(Some(CatchAll {
        name: catch_all_name,
        key_column,
        lower_bound,
    }))
}

/// Replace the catch-all's coverage of `[start, end)` with a real month partition.
///
/// Detaches the catch-all, creates `partition_name` for the month, and re-attaches
/// the catch-all starting at the month's end, all in one transaction so the parent
/// is never left with a gap another writer could fall into.
///
/// Always returns `Ok(())`: this runs on the relay's startup path, and a month that
/// could not be split is the state the relay has been running in all along. Every
/// reason for not splitting is logged.
async fn roll_catch_all_forward(
    pool: &PgPool,
    table_name: &str,
    partition_name: &str,
    start_date_str: &str,
    end_date_str: &str,
    end: DateTime<Utc>,
) -> Result<()> {
    let Some(catch_all) = load_catch_all(pool, table_name).await? else {
        info!(
            partition_name,
            "partition range already covered by an existing partition"
        );
        return Ok(());
    };

    // The catch-all starts at or after this month's end, so it is not what the
    // requested range overlapped. Leave the table exactly as it is.
    if catch_all.lower_bound >= end {
        info!(
            partition_name,
            "partition range already covered by an existing partition"
        );
        return Ok(());
    }

    // ATTACH validates every remaining row against the new lower bound, so the
    // catch-all must hold nothing before this month's end, not merely nothing
    // inside this month. Rows here are an operator job: moving them means
    // rewriting gigabytes under an exclusive lock, which startup must never do.
    let occupying: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT COUNT(*) FROM ONLY {} WHERE {} < $1",
        catch_all.name, catch_all.key_column
    )))
    .bind(end)
    .fetch_one(pool)
    .await?;
    if occupying > 0 {
        warn!(
            catch_all = %catch_all.name,
            rows = occupying,
            through = end_date_str,
            script = SPLIT_SCRIPT,
            "catch-all partition holds rows before this month's end; \
             leaving it in place. Run the operator script to split it."
        );
        return Ok(());
    }

    for attempt in 1..=2 {
        match split_catch_all(
            pool,
            table_name,
            partition_name,
            &catch_all.name,
            start_date_str,
            end_date_str,
        )
        .await
        {
            Ok(()) => {
                info!(
                    partition_name,
                    catch_all = %catch_all.name,
                    from = end_date_str,
                    "rolled the catch-all partition forward"
                );
                return Ok(());
            }
            Err(DbError::Sqlx(sqlx::Error::Database(db_err)))
                if db_err.code().as_deref() == Some(SQLSTATE_LOCK_NOT_AVAILABLE)
                    && attempt == 1 =>
            {
                info!(
                    partition_name,
                    "lock timeout rolling the catch-all forward; retrying once"
                );
            }
            Err(e) => {
                warn!(
                    partition_name,
                    catch_all = %catch_all.name,
                    error = %e,
                    "could not roll the catch-all partition forward; \
                     writes still land in it"
                );
                return Ok(());
            }
        }
    }

    Ok(())
}

/// One transaction: detach the catch-all, create the month, re-attach the
/// catch-all above it.
async fn split_catch_all(
    pool: &PgPool,
    table_name: &str,
    partition_name: &str,
    catch_all_name: &str,
    start_date_str: &str,
    end_date_str: &str,
) -> Result<()> {
    let mut tx = pool.begin().await?;

    sqlx::query(sqlx::AssertSqlSafe(format!(
        "SET LOCAL lock_timeout = '{ROLL_FORWARD_LOCK_TIMEOUT}'"
    )))
    .execute(&mut *tx)
    .await?;

    // DDL identifiers cannot be parameterized. `table_name` is allowlisted,
    // `partition_name` and `catch_all_name` are derived from it plus a validated
    // suffix, and both dates are validated `YYYY-MM-DD`.
    for sql in [
        format!("ALTER TABLE {table_name} DETACH PARTITION {catch_all_name}"),
        format!(
            "CREATE TABLE {partition_name} PARTITION OF {table_name} \
             FOR VALUES FROM ('{start_date_str}') TO ('{end_date_str}')"
        ),
        format!(
            "ALTER TABLE {table_name} ATTACH PARTITION {catch_all_name} \
             FOR VALUES FROM ('{end_date_str}') TO (MAXVALUE)"
        ),
    ] {
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifier_validation() {
        assert!(validate_identifier("created_at"));
        assert!(validate_identifier("delivered_at"));
        assert!(!validate_identifier(""));
        assert!(!validate_identifier("Created_At"));
        assert!(!validate_identifier("created_at; DROP TABLE events--"));
        assert!(!validate_identifier(&"a".repeat(64)));
    }

    #[test]
    fn suffix_validation() {
        assert!(validate_partition_suffix("2026_03"));
        assert!(validate_partition_suffix("9999_12"));
        assert!(!validate_partition_suffix(""));
        assert!(!validate_partition_suffix("2026-03"));
        assert!(!validate_partition_suffix("2026_03; DROP TABLE events--"));
    }

    #[test]
    fn date_str_validation() {
        assert!(validate_date_str("2026-03-01"));
        assert!(validate_date_str("9999-12-31"));
        assert!(!validate_date_str("2026-3-01"));
        assert!(!validate_date_str("2026/03/01"));
        assert!(!validate_date_str("20260301"));
        assert!(!validate_date_str("2026-03-01; DROP TABLE events--"));
    }

    #[test]
    fn table_allowlist() {
        assert!(PARTITIONED_TABLES.contains(&"events"));
        assert!(PARTITIONED_TABLES.contains(&"delivery_log"));
        assert!(!PARTITIONED_TABLES.contains(&"api_tokens"));
        assert!(!PARTITIONED_TABLES.contains(&"users"));
    }

    // ── Postgres-gated: the catch-all roll-forward ────────────────────────────
    //
    // These run against a scratch database migrated from scratch, because the
    // behaviour under test is DDL on a live partition tree: a shared database
    // cannot host it, and a hand-built table would not prove that the real
    // `events` tree (8 triggers, 13 indexes, a deferred replica fence) survives
    // a detach and re-attach.

    use uuid::Uuid;

    const TEST_DB_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz"; // sadscan:disable np.postgres.1

    fn test_database_url() -> String {
        std::env::var("BUZZ_TEST_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .unwrap_or_else(|_| TEST_DB_URL.to_owned())
    }

    /// A migrated scratch database, plus the admin pool that can drop it again.
    struct Scratch {
        admin: PgPool,
        name: String,
        db: Option<crate::Db>,
    }

    impl Scratch {
        async fn create(prefix: &str) -> Self {
            let admin_url = test_database_url();
            let admin = PgPool::connect(&admin_url)
                .await
                .expect("connect to test database server");
            let name = format!("{}_{}", prefix, Uuid::new_v4().simple());
            sqlx::query(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
                .execute(&admin)
                .await
                .expect("create scratch database");
            let path_start = admin_url
                .rfind('/')
                .expect("database URL has a path segment");
            let database_url = format!("{}/{}", &admin_url[..path_start], name);

            let db = crate::Db::new(&crate::DbConfig {
                database_url,
                max_connections: 5,
                min_connections: 0,
                ..crate::DbConfig::default()
            })
            .await
            .expect("connect to scratch database");
            db.migrate().await.expect("migrate scratch database");

            Self {
                admin,
                name,
                db: Some(db),
            }
        }

        fn pool(&self) -> &PgPool {
            &self.db.as_ref().expect("scratch database is open").pool
        }

        async fn drop_database(mut self) {
            let db = self.db.take().expect("scratch database is open");
            db.pool.close().await;
            drop(db);
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "DROP DATABASE IF EXISTS {} WITH (FORCE)",
                self.name
            )))
            .execute(&self.admin)
            .await
            .expect("drop scratch database");
            self.admin.close().await;
        }
    }

    /// Every partition of `table`, as `(name, bound expression)`, name-ordered.
    async fn partitions(pool: &PgPool, table: &str) -> Vec<(String, String)> {
        sqlx::query_as(
            r#"
            SELECT c.relname::text,
                   pg_catalog.pg_get_expr(c.relpartbound, c.oid)
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid
            WHERE i.inhparent = $1::regclass
            ORDER BY 1
            "#,
        )
        .bind(table)
        .fetch_all(pool)
        .await
        .expect("read partition list")
    }

    async fn bound_of(pool: &PgPool, table: &str, partition: &str) -> String {
        partitions(pool, table)
            .await
            .into_iter()
            .find(|(name, _)| name == partition)
            .unwrap_or_else(|| panic!("{partition} exists"))
            .1
    }

    /// The same month arithmetic `ensure_future_partitions` walks, so the
    /// expectations are derived rather than hardcoded to a release date.
    fn month_offset(now: DateTime<Utc>, offset: i32) -> (i32, u32) {
        let month = now.month() as i32 + offset;
        (
            now.year() + (month - 1).div_euclid(12),
            ((month - 1).rem_euclid(12) + 1) as u32,
        )
    }

    fn month_start(year: i32, month: u32) -> String {
        format!("{year:04}-{month:02}-01 00:00:00+00")
    }

    /// A fresh schema's catch-all covers every month from 2026-07 onwards, so
    /// each requested month is an overlap. All of them must become real
    /// partitions, with the catch-all left sitting above the last of them.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn fresh_schema_rolls_the_catch_all_through_every_requested_month() {
        let scratch = Scratch::create("partition_roll").await;
        let pool = scratch.pool().clone();
        let now = Utc::now();

        ensure_future_partitions(&pool, 3)
            .await
            .expect("ensure future partitions");

        for table in PARTITIONED_TABLES {
            for offset in 0..=3 {
                let (year, month) = month_offset(now, offset);
                let (end_year, end_month) = month_offset(now, offset + 1);
                let name = format!("{table}_p{year:04}_{month:02}");
                assert_eq!(
                    bound_of(&pool, table, &name).await,
                    format!(
                        "FOR VALUES FROM ('{}') TO ('{}')",
                        month_start(year, month),
                        month_start(end_year, end_month)
                    ),
                    "{name} covers exactly its month",
                );
            }

            let (last_year, last_month) = month_offset(now, 4);
            assert_eq!(
                bound_of(&pool, table, &format!("{table}{CATCH_ALL_SUFFIX}")).await,
                format!(
                    "FOR VALUES FROM ('{}') TO (MAXVALUE)",
                    month_start(last_year, last_month)
                ),
                "the catch-all starts where the last created month ends",
            );
        }

        // The replica fence refuses to start a relay whose partitions have lost
        // the deferred `created_at` floor trigger. A detach drops the clone and
        // the re-attach must put it back.
        crate::replica_fence::verify_floor_guard_catalog(&pool)
            .await
            .expect("floor guard intact on every partition after the roll");

        scratch.drop_database().await;
    }

    /// A catch-all holding rows cannot be re-attached above them, so it is left
    /// exactly as it is and the operator script does the move. The sibling table
    /// that is empty still rolls: one occupied table must not stall the other.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn occupied_catch_all_is_left_alone() {
        let scratch = Scratch::create("partition_occupied").await;
        let pool = scratch.pool().clone();
        let now = Utc::now();

        let community = Uuid::new_v4();
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(community)
            .bind(format!("partition-test-{}.example", community.simple()))
            .execute(&pool)
            .await
            .expect("insert test community");
        // channel_id stays NULL: the floor guard only fences channel-bearing rows.
        sqlx::query(
            "INSERT INTO events \
             (community_id, id, pubkey, created_at, kind, tags, content, sig) \
             VALUES ($1, $2, $3, $4, 1, '[]'::jsonb, 'occupying row', $5)",
        )
        .bind(community)
        .bind(vec![1u8; 32])
        .bind(vec![2u8; 32])
        .bind(now)
        .bind(vec![3u8; 64])
        .execute(&pool)
        .await
        .expect("insert a row into the catch-all");

        let before = bound_of(&pool, "events", "events_p_future").await;

        ensure_future_partitions(&pool, 3)
            .await
            .expect("ensure future partitions");

        assert_eq!(
            bound_of(&pool, "events", "events_p_future").await,
            before,
            "an occupied catch-all keeps its bound",
        );
        let (year, month) = month_offset(now, 0);
        assert!(
            !partitions(&pool, "events")
                .await
                .iter()
                .any(|(name, _)| name == &format!("events_p{year:04}_{month:02}")),
            "no month partition is carved out from under the rows",
        );
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM events")
            .fetch_one(&pool)
            .await
            .expect("count events");
        assert_eq!(count, 1, "startup never moves rows");

        // delivery_log is empty, so it rolls even while events is blocked.
        let (last_year, last_month) = month_offset(now, 4);
        assert_eq!(
            bound_of(&pool, "delivery_log", "delivery_log_p_future").await,
            format!(
                "FOR VALUES FROM ('{}') TO (MAXVALUE)",
                month_start(last_year, last_month)
            ),
            "the empty sibling table still rolls forward",
        );

        scratch.drop_database().await;
    }

    /// Once rolled, the months exist and the second call has nothing to overlap.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn rolling_twice_changes_nothing_the_second_time() {
        let scratch = Scratch::create("partition_idempotent").await;
        let pool = scratch.pool().clone();
        let now = Utc::now();

        ensure_future_partitions(&pool, 3).await.expect("first run");
        let after_first = partitions(&pool, "events").await;

        ensure_future_partitions(&pool, 3)
            .await
            .expect("second run");

        assert_eq!(
            partitions(&pool, "events").await,
            after_first,
            "the second run is a no-op",
        );
        let (year, month) = month_offset(now, 3);
        assert!(
            after_first
                .iter()
                .any(|(name, _)| name == &format!("events_p{year:04}_{month:02}")),
            "the first run really did create the requested months",
        );

        scratch.drop_database().await;
    }
}
