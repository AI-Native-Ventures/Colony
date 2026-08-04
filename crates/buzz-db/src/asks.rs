//! Interrupt Asks projection (see `docs/nips/NIP-IQ.md`).
//!
//! One row per Ask event. The relay's interrupt sweep and the future Open
//! Issues surface read this table instead of scanning events. Two guarantees
//! live here that cannot be enforced by scanning events alone:
//!
//! - **Dedupe**: a partial unique index on `(community_id, initiative_id,
//!   need_key) WHERE status = 'open'` means at most one OPEN ask can exist
//!   per initiative+need at a time. A second `INSERT` while one is still
//!   open fails with a Postgres unique violation; the slot reopens the
//!   moment the first ask is resolved, withdrawn, or promoted.
//! - **Due sweep**: [`query_due_asks`] finds open asks whose `deadline_at`
//!   has passed, across every community, mirroring
//!   [`crate::event::query_due_reminders`].

use chrono::Utc;
use sqlx::{PgPool, Row as _};

use crate::error::Result;
use crate::CommunityId;

/// A row from the `asks` projection table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AskRow {
    /// Community this ask belongs to.
    pub community_id: CommunityId,
    /// The filing Ask event's raw ID bytes.
    pub ask_event_id: Vec<u8>,
    /// One of `decision`, `question`, `credential`, `blocker`, `stall`.
    pub ask_type: String,
    /// The initiative (task/workflow) this ask was filed on behalf of.
    pub initiative_id: String,
    /// Stable key identifying what is being asked for, within the initiative.
    pub need_key: String,
    /// Pubkey the ask is addressed to.
    pub audience_pubkey: Vec<u8>,
    /// Pubkey of the agent that filed the ask.
    pub filer_pubkey: Vec<u8>,
    /// Root event of the thread the ask was raised from, if any.
    pub origin_thread: Option<Vec<u8>>,
    /// The ask this one supersedes (e.g. on re-escalation), if any.
    pub prior_ask: Option<Vec<u8>>,
    /// Escalation category tag (e.g. one of the hard-list categories), if any.
    pub category: Option<String>,
    /// The option label to execute automatically if the deadline passes unanswered.
    pub default_option: Option<String>,
    /// Unix timestamp (seconds) after which this ask is due for the interrupt sweep.
    pub deadline_at: Option<i64>,
    /// One of `open`, `resolved`, `withdrawn`, `promoted`.
    pub status: String,
    /// The event ID that closed this ask: a resolution, a withdrawal, or the
    /// event ID of the ask it was promoted to. Meaning depends on `status`.
    pub resolution_event: Option<Vec<u8>>,
    /// Pubkey that resolved this ask, set only when `status = 'resolved'`.
    pub resolved_by: Option<Vec<u8>>,
    /// Whether the stated default option was executed on timeout.
    pub default_executed: bool,
    /// Unix timestamp (seconds) the row was inserted.
    pub created_at: i64,
    /// Unix timestamp (seconds) of the row's last mutation.
    pub updated_at: i64,
}

/// Fields for filing a new open ask. `status` starts at `open`;
/// `created_at`/`updated_at` are stamped by [`insert_ask`].
pub struct NewAskRow<'a> {
    /// The filing Ask event's raw ID bytes.
    pub ask_event_id: &'a [u8],
    /// One of `decision`, `question`, `credential`, `blocker`, `stall`
    /// (must match [`buzz_core::interrupt::AskType::as_str`]).
    pub ask_type: &'a str,
    /// The initiative (task/workflow) this ask was filed on behalf of.
    pub initiative_id: &'a str,
    /// Stable key identifying what is being asked for, within the initiative.
    pub need_key: &'a str,
    /// Pubkey the ask is addressed to.
    pub audience_pubkey: &'a [u8],
    /// Pubkey of the agent that filed the ask.
    pub filer_pubkey: &'a [u8],
    /// Root event of the thread the ask was raised from, if any.
    pub origin_thread: Option<&'a [u8]>,
    /// The ask this one supersedes (e.g. on re-escalation), if any.
    pub prior_ask: Option<&'a [u8]>,
    /// Escalation category tag (e.g. one of the hard-list categories), if any.
    pub category: Option<&'a str>,
    /// The option label to execute automatically if the deadline passes unanswered.
    pub default_option: Option<&'a str>,
    /// Unix timestamp (seconds) after which this ask is due for the interrupt sweep.
    pub deadline_at: Option<i64>,
}

fn row_to_ask_row(row: sqlx::postgres::PgRow) -> Result<AskRow> {
    Ok(AskRow {
        community_id: CommunityId::from_uuid(row.try_get("community_id")?),
        ask_event_id: row.try_get("ask_event_id")?,
        ask_type: row.try_get("ask_type")?,
        initiative_id: row.try_get("initiative_id")?,
        need_key: row.try_get("need_key")?,
        audience_pubkey: row.try_get("audience_pubkey")?,
        filer_pubkey: row.try_get("filer_pubkey")?,
        origin_thread: row.try_get("origin_thread")?,
        prior_ask: row.try_get("prior_ask")?,
        category: row.try_get("category")?,
        default_option: row.try_get("default_option")?,
        deadline_at: row.try_get("deadline_at")?,
        status: row.try_get("status")?,
        resolution_event: row.try_get("resolution_event")?,
        resolved_by: row.try_get("resolved_by")?,
        default_executed: row.try_get("default_executed")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

/// Files a new open ask.
///
/// Fails with a Postgres unique-violation error (surfaced as
/// [`crate::DbError::Sqlx`]) if an OPEN ask already exists for this
/// `(community, initiative_id, need_key)`: that partial unique index is the
/// dedupe guarantee described on the module. The slot reopens once the
/// existing open ask is resolved, withdrawn, or promoted.
pub async fn insert_ask(pool: &PgPool, community: CommunityId, row: NewAskRow<'_>) -> Result<()> {
    let now = Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO asks (\
            community_id, ask_event_id, ask_type, initiative_id, need_key, \
            audience_pubkey, filer_pubkey, origin_thread, prior_ask, \
            category, default_option, deadline_at, created_at, updated_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)",
    )
    .bind(community.as_uuid())
    .bind(row.ask_event_id)
    .bind(row.ask_type)
    .bind(row.initiative_id)
    .bind(row.need_key)
    .bind(row.audience_pubkey)
    .bind(row.filer_pubkey)
    .bind(row.origin_thread)
    .bind(row.prior_ask)
    .bind(row.category)
    .bind(row.default_option)
    .bind(row.deadline_at)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

/// Returns the currently OPEN ask for `(community, initiative_id, need_key)`,
/// or `None` if there isn't one. At most one row can ever match, because of
/// the `asks_open_need_uniq` partial unique index.
pub async fn find_open_ask_by_need(
    pool: &PgPool,
    community: CommunityId,
    initiative_id: &str,
    need_key: &str,
) -> Result<Option<AskRow>> {
    let row = sqlx::query(
        "SELECT community_id, ask_event_id, ask_type, initiative_id, need_key, \
                audience_pubkey, filer_pubkey, origin_thread, prior_ask, category, \
                default_option, deadline_at, status, resolution_event, resolved_by, \
                default_executed, created_at, updated_at \
         FROM asks \
         WHERE community_id = $1 AND initiative_id = $2 AND need_key = $3 AND status = 'open'",
    )
    .bind(community.as_uuid())
    .bind(initiative_id)
    .bind(need_key)
    .fetch_optional(pool)
    .await?;

    row.map(row_to_ask_row).transpose()
}

/// Marks an open ask resolved: records the resolution event, who resolved
/// it, and whether the stated default option was executed on timeout.
///
/// Returns `true` if an open row was flipped, `false` if no open ask with
/// this `ask_event_id` existed in `community` (already resolved/withdrawn/
/// promoted, or never filed). Releases the dedupe slot for its
/// `(initiative_id, need_key)`.
pub async fn resolve_ask(
    pool: &PgPool,
    community: CommunityId,
    ask_event_id: &[u8],
    resolution_event_id: &[u8],
    resolved_by: &[u8],
    default_executed: bool,
) -> Result<bool> {
    let now = Utc::now().timestamp();
    let result = sqlx::query(
        "UPDATE asks SET status = 'resolved', resolution_event = $1, resolved_by = $2, \
            default_executed = $3, updated_at = $4 \
         WHERE community_id = $5 AND ask_event_id = $6 AND status = 'open'",
    )
    .bind(resolution_event_id)
    .bind(resolved_by)
    .bind(default_executed)
    .bind(now)
    .bind(community.as_uuid())
    .bind(ask_event_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// Marks an open ask withdrawn (e.g. the filer no longer needs an answer).
///
/// Returns `true` if an open row was flipped, `false` if no open ask with
/// this `ask_event_id` existed in `community`. Releases the dedupe slot for
/// its `(initiative_id, need_key)`.
pub async fn withdraw_ask(
    pool: &PgPool,
    community: CommunityId,
    ask_event_id: &[u8],
    withdrawal_event_id: &[u8],
) -> Result<bool> {
    let now = Utc::now().timestamp();
    let result = sqlx::query(
        "UPDATE asks SET status = 'withdrawn', resolution_event = $1, updated_at = $2 \
         WHERE community_id = $3 AND ask_event_id = $4 AND status = 'open'",
    )
    .bind(withdrawal_event_id)
    .bind(now)
    .bind(community.as_uuid())
    .bind(ask_event_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// Marks an open ask promoted to a new ask further up the agent hierarchy
/// (e.g. an unanswered ask escalated from a lead agent to the owner).
///
/// Returns `true` if an open row was flipped, `false` if no open ask with
/// this `ask_event_id` existed in `community`. Releases the dedupe slot for
/// its `(initiative_id, need_key)`: the promoted-to ask claims it instead.
pub async fn mark_ask_promoted(
    pool: &PgPool,
    community: CommunityId,
    ask_event_id: &[u8],
    promoted_to_event_id: &[u8],
) -> Result<bool> {
    let now = Utc::now().timestamp();
    let result = sqlx::query(
        "UPDATE asks SET status = 'promoted', resolution_event = $1, updated_at = $2 \
         WHERE community_id = $3 AND ask_event_id = $4 AND status = 'open'",
    )
    .bind(promoted_to_event_id)
    .bind(now)
    .bind(community.as_uuid())
    .bind(ask_event_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// Reverts a `promoted` row back to `open`, clearing the promotion pointer,
/// but ONLY when it is still promoted toward EXACTLY `expected_promoted_to`.
///
/// Compensates for a promotion whose successor failed to be created after
/// [`mark_ask_promoted`] already committed -- the interrupt sweep's
/// `promote_to` calls this when the follow-up `insert_ask` (via
/// `buzz-relay`'s `ask_broker::handle_ask_event`) errors or is refused, so
/// the original ask gets another chance instead of being permanently stuck
/// `promoted` toward an event that was never actually created. Once
/// `status = 'promoted'`, the row no longer surfaces from
/// [`query_due_asks`], so nothing else in this crate would ever notice or
/// retry it.
///
/// The predicate on `resolution_event = expected_promoted_to` is what makes
/// this idempotent and unable to resurrect a row a human closed some other
/// way: it can only ever undo the EXACT promotion attempt named by
/// `expected_promoted_to`, never a different promotion, and never a row
/// that is not (or is no longer) `promoted` at all. Multiple relay
/// instances can safely race this the same way they race
/// [`mark_ask_promoted`] itself -- at most one will match the predicate.
///
/// Returns `true` if the row was reverted, `false` if it no longer matches
/// (already reverted, resolved some other way, or promoted toward a
/// different successor).
pub async fn reopen_promoted_ask(
    pool: &PgPool,
    community: CommunityId,
    ask_event_id: &[u8],
    expected_promoted_to: &[u8],
) -> Result<bool> {
    let now = Utc::now().timestamp();
    let result = sqlx::query(
        "UPDATE asks SET status = 'open', resolution_event = NULL, updated_at = $1 \
         WHERE community_id = $2 AND ask_event_id = $3 AND status = 'promoted' \
           AND resolution_event = $4",
    )
    .bind(now)
    .bind(community.as_uuid())
    .bind(ask_event_id)
    .bind(expected_promoted_to)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}
/// Pushes an open ask's `deadline_at` forward to `new_deadline_at`, without
/// otherwise touching its status, resolution, or any other column.
///
/// Backs the interrupt sweep's no-spin rule for an ask already at the top of
/// the altitude ladder (executive audience with no default, or an
/// owner-audience ask with no default): rather than promoting it -- there is
/// nowhere higher to go -- the sweep re-arms its deadline so [`query_due_asks`]
/// does not keep handing back the same row on every tick.
///
/// Returns `true` if an open row was flipped, `false` if no open ask with
/// this `ask_event_id` existed in `community` (already resolved/withdrawn/
/// promoted by a race that landed first, or never filed).
pub async fn extend_ask_deadline(
    pool: &PgPool,
    community: CommunityId,
    ask_event_id: &[u8],
    new_deadline_at: i64,
) -> Result<bool> {
    let now = Utc::now().timestamp();
    let result = sqlx::query(
        "UPDATE asks SET deadline_at = $1, updated_at = $2 \
         WHERE community_id = $3 AND ask_event_id = $4 AND status = 'open'",
    )
    .bind(new_deadline_at)
    .bind(now)
    .bind(community.as_uuid())
    .bind(ask_event_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// Returns open asks whose `deadline_at` is at or before `now_secs`, across
/// every community, ordered by deadline then event ID, capped at `limit`
/// rows. Mirrors [`crate::event::query_due_reminders`]'s cross-tenant sweep
/// shape. Asks with no `deadline_at` never appear here.
pub async fn query_due_asks(pool: &PgPool, now_secs: i64, limit: i64) -> Result<Vec<AskRow>> {
    let rows = sqlx::query(
        "SELECT community_id, ask_event_id, ask_type, initiative_id, need_key, \
                audience_pubkey, filer_pubkey, origin_thread, prior_ask, category, \
                default_option, deadline_at, status, resolution_event, resolved_by, \
                default_executed, created_at, updated_at \
         FROM asks \
         WHERE status = 'open' AND deadline_at IS NOT NULL AND deadline_at <= $1 \
         ORDER BY deadline_at ASC, ask_event_id ASC LIMIT $2",
    )
    .bind(now_secs)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    rows.into_iter().map(row_to_ask_row).collect()
}

/// Returns every OPEN ask rooted at `thread_root` (its `origin_thread`
/// column), in `community`. Backs owner thread-reply auto-resolution: an
/// owner posting into the thread an ask was raised from can close it
/// without tapping the Ask card.
///
/// No audience filtering happens here -- a thread can host asks addressed
/// to different tiers (a worker's ask to its leader and, later, that
/// leader's escalation to the executive can share a root). The caller
/// decides which of the returned rows are actually eligible to auto-resolve
/// (only owner-audience asks -- see `buzz-relay`'s `ask_broker`).
pub async fn find_open_asks_by_thread(
    pool: &PgPool,
    community: CommunityId,
    thread_root: &[u8],
) -> Result<Vec<AskRow>> {
    let rows = sqlx::query(
        "SELECT community_id, ask_event_id, ask_type, initiative_id, need_key, \
                audience_pubkey, filer_pubkey, origin_thread, prior_ask, category, \
                default_option, deadline_at, status, resolution_event, resolved_by, \
                default_executed, created_at, updated_at \
         FROM asks \
         WHERE community_id = $1 AND origin_thread = $2 AND status = 'open'",
    )
    .bind(community.as_uuid())
    .bind(thread_root)
    .fetch_all(pool)
    .await?;

    rows.into_iter().map(row_to_ask_row).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DbError;
    use uuid::Uuid;

    const TEST_DB_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz";

    async fn setup_pool() -> PgPool {
        let database_url = std::env::var("BUZZ_TEST_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .unwrap_or_else(|_| TEST_DB_URL.to_owned());
        let pool = PgPool::connect(&database_url)
            .await
            .expect("connect to test DB");
        crate::migration::run_migrations(&pool)
            .await
            .expect("apply migrations");
        pool
    }

    async fn make_test_community(pool: &PgPool) -> CommunityId {
        let id = Uuid::new_v4();
        let host = format!("asks-test-{}.example", id.simple());
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(id)
            .bind(host)
            .execute(pool)
            .await
            .expect("insert test community");
        CommunityId::from_uuid(id)
    }

    /// A fresh, effectively-unique 32-byte ID (event ID or pubkey shape).
    fn random_bytes32() -> Vec<u8> {
        let mut bytes = Uuid::new_v4().as_bytes().to_vec();
        bytes.extend_from_slice(Uuid::new_v4().as_bytes());
        bytes
    }

    fn is_unique_violation(err: &DbError) -> bool {
        matches!(
            err,
            DbError::Sqlx(sqlx::Error::Database(db_err)) if db_err.code().as_deref() == Some("23505")
        )
    }

    fn new_ask<'a>(
        ask_event_id: &'a [u8],
        audience_pubkey: &'a [u8],
        filer_pubkey: &'a [u8],
        deadline_at: Option<i64>,
    ) -> NewAskRow<'a> {
        new_ask_for_need(
            ask_event_id,
            "need-1",
            audience_pubkey,
            filer_pubkey,
            deadline_at,
        )
    }

    /// Like [`new_ask`] but with an explicit `need_key`, for tests that file
    /// several simultaneously-open asks in the same community/initiative and
    /// must not collide with the open-need dedupe index themselves.
    fn new_ask_for_need<'a>(
        ask_event_id: &'a [u8],
        need_key: &'a str,
        audience_pubkey: &'a [u8],
        filer_pubkey: &'a [u8],
        deadline_at: Option<i64>,
    ) -> NewAskRow<'a> {
        NewAskRow {
            ask_event_id,
            ask_type: "decision",
            initiative_id: "initiative-1",
            need_key,
            audience_pubkey,
            filer_pubkey,
            origin_thread: None,
            prior_ask: None,
            category: None,
            default_option: Some("proceed"),
            deadline_at,
        }
    }

    /// Reads a row regardless of status: the public API only exposes open
    /// asks, so tests that need to inspect a closed row read the table
    /// directly rather than adding a test-only backdoor to the module.
    async fn fetch_any_ask(pool: &PgPool, community: CommunityId, ask_event_id: &[u8]) -> AskRow {
        let row = sqlx::query(
            "SELECT community_id, ask_event_id, ask_type, initiative_id, need_key, \
                    audience_pubkey, filer_pubkey, origin_thread, prior_ask, category, \
                    default_option, deadline_at, status, resolution_event, resolved_by, \
                    default_executed, created_at, updated_at \
             FROM asks WHERE community_id = $1 AND ask_event_id = $2",
        )
        .bind(community.as_uuid())
        .bind(ask_event_id)
        .fetch_one(pool)
        .await
        .expect("ask row must exist");
        row_to_ask_row(row).expect("map ask row")
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn insert_and_find_open_ask_round_trips() {
        let pool = setup_pool().await;
        let community = make_test_community(&pool).await;
        let ask_event_id = random_bytes32();
        let audience = random_bytes32();
        let filer = random_bytes32();

        insert_ask(
            &pool,
            community,
            new_ask(&ask_event_id, &audience, &filer, None),
        )
        .await
        .expect("insert ask");

        let found = find_open_ask_by_need(&pool, community, "initiative-1", "need-1")
            .await
            .expect("find open ask")
            .expect("ask must be found");

        assert_eq!(found.ask_event_id, ask_event_id);
        assert_eq!(found.community_id, community);
        assert_eq!(found.ask_type, "decision");
        assert_eq!(found.audience_pubkey, audience);
        assert_eq!(found.filer_pubkey, filer);
        assert_eq!(found.status, "open");
        assert_eq!(found.default_option.as_deref(), Some("proceed"));
        assert!(!found.default_executed);
        assert_eq!(found.created_at, found.updated_at);
    }

    /// Load-bearing dedupe test, half 1: a second ask filed for the same
    /// (community, initiative, need) while the first is still open must be
    /// rejected by the `asks_open_need_uniq` partial unique index, not
    /// silently accepted as a duplicate.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn second_open_ask_for_same_need_is_rejected() {
        let pool = setup_pool().await;
        let community = make_test_community(&pool).await;
        let audience = random_bytes32();
        let filer = random_bytes32();

        let first_id = random_bytes32();
        insert_ask(
            &pool,
            community,
            new_ask(&first_id, &audience, &filer, None),
        )
        .await
        .expect("insert first ask");

        let second_id = random_bytes32();
        let err = insert_ask(
            &pool,
            community,
            new_ask(&second_id, &audience, &filer, None),
        )
        .await
        .expect_err("second open ask for the same need must be rejected");
        assert!(
            is_unique_violation(&err),
            "expected a unique-violation error, got: {err:?}"
        );

        // The rejected insert must not have landed a partial row.
        assert!(
            find_open_ask_by_need(&pool, community, "initiative-1", "need-1")
                .await
                .expect("find open ask")
                .is_some_and(|row| row.ask_event_id == first_id)
        );
    }

    /// Load-bearing dedupe test, half 2: once the open ask is resolved, the
    /// dedupe slot must reopen: a fresh ask for the same need succeeds, and
    /// `find_open_ask_by_need` no longer returns the resolved row.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn resolving_an_ask_releases_the_dedupe_slot() {
        let pool = setup_pool().await;
        let community = make_test_community(&pool).await;
        let audience = random_bytes32();
        let filer = random_bytes32();

        let first_id = random_bytes32();
        insert_ask(
            &pool,
            community,
            new_ask(&first_id, &audience, &filer, None),
        )
        .await
        .expect("insert first ask");

        let resolution_event = random_bytes32();
        let resolved_by = random_bytes32();
        let resolved = resolve_ask(
            &pool,
            community,
            &first_id,
            &resolution_event,
            &resolved_by,
            false,
        )
        .await
        .expect("resolve ask");
        assert!(resolved, "resolve_ask must report the open row was flipped");

        assert!(
            find_open_ask_by_need(&pool, community, "initiative-1", "need-1")
                .await
                .expect("find open ask after resolve")
                .is_none(),
            "a resolved ask must no longer be the open ask for its need"
        );

        let closed = fetch_any_ask(&pool, community, &first_id).await;
        assert_eq!(closed.status, "resolved");
        assert_eq!(
            closed.resolution_event.as_deref(),
            Some(&resolution_event[..])
        );
        assert_eq!(closed.resolved_by.as_deref(), Some(&resolved_by[..]));
        assert!(!closed.default_executed);
        assert!(
            closed.updated_at >= closed.created_at,
            "resolve_ask must set updated_at"
        );

        // The slot is free again: a new ask for the same need now succeeds.
        let second_id = random_bytes32();
        insert_ask(
            &pool,
            community,
            new_ask(&second_id, &audience, &filer, None),
        )
        .await
        .expect("insert ask after prior was resolved");
        assert!(
            find_open_ask_by_need(&pool, community, "initiative-1", "need-1")
                .await
                .expect("find open ask")
                .is_some_and(|row| row.ask_event_id == second_id)
        );
    }

    /// Withdrawal is the other closing path (`resolved` and `withdrawn` are
    /// separate statuses) and must release the dedupe slot exactly like
    /// resolution does.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn withdrawing_an_ask_releases_the_dedupe_slot() {
        let pool = setup_pool().await;
        let community = make_test_community(&pool).await;
        let audience = random_bytes32();
        let filer = random_bytes32();

        let first_id = random_bytes32();
        insert_ask(
            &pool,
            community,
            new_ask(&first_id, &audience, &filer, None),
        )
        .await
        .expect("insert first ask");

        let withdrawal_event = random_bytes32();
        let withdrawn = withdraw_ask(&pool, community, &first_id, &withdrawal_event)
            .await
            .expect("withdraw ask");
        assert!(
            withdrawn,
            "withdraw_ask must report the open row was flipped"
        );

        assert!(
            find_open_ask_by_need(&pool, community, "initiative-1", "need-1")
                .await
                .expect("find open ask after withdraw")
                .is_none()
        );

        let closed = fetch_any_ask(&pool, community, &first_id).await;
        assert_eq!(closed.status, "withdrawn");
        assert_eq!(
            closed.resolution_event.as_deref(),
            Some(&withdrawal_event[..])
        );
        assert!(closed.resolved_by.is_none());

        let second_id = random_bytes32();
        insert_ask(
            &pool,
            community,
            new_ask(&second_id, &audience, &filer, None),
        )
        .await
        .expect("insert ask after prior was withdrawn");
    }

    /// Promotion is the third closing path (up the agent hierarchy on
    /// timeout) and must also release the dedupe slot.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn promoting_an_ask_releases_the_dedupe_slot() {
        let pool = setup_pool().await;
        let community = make_test_community(&pool).await;
        let audience = random_bytes32();
        let filer = random_bytes32();

        let first_id = random_bytes32();
        insert_ask(
            &pool,
            community,
            new_ask(&first_id, &audience, &filer, None),
        )
        .await
        .expect("insert first ask");

        let promoted_to = random_bytes32();
        let promoted = mark_ask_promoted(&pool, community, &first_id, &promoted_to)
            .await
            .expect("mark ask promoted");
        assert!(
            promoted,
            "mark_ask_promoted must report the open row was flipped"
        );

        let closed = fetch_any_ask(&pool, community, &first_id).await;
        assert_eq!(closed.status, "promoted");
        assert_eq!(closed.resolution_event.as_deref(), Some(&promoted_to[..]));

        let second_id = random_bytes32();
        insert_ask(
            &pool,
            community,
            new_ask(&second_id, &audience, &filer, None),
        )
        .await
        .expect("insert ask after prior was promoted");
    }

    /// `reopen_promoted_ask` (Task 8 fix round, C3) must revert a `promoted`
    /// row to `open`, clear its promotion pointer, and report `true` -- but
    /// only when the row is still promoted toward the EXACT successor
    /// named. A second call (already reverted) and a call naming the wrong
    /// successor must both report `false` and leave the row untouched,
    /// proving the compensation is idempotent and cannot resurrect a row
    /// closed some other way.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn reopen_promoted_ask_reverts_only_the_exact_promotion_it_names() {
        let pool = setup_pool().await;
        let community = make_test_community(&pool).await;
        let audience = random_bytes32();
        let filer = random_bytes32();

        let original_id = random_bytes32();
        insert_ask(
            &pool,
            community,
            new_ask(&original_id, &audience, &filer, None),
        )
        .await
        .expect("insert original ask");

        let promoted_to = random_bytes32();
        let promoted = mark_ask_promoted(&pool, community, &original_id, &promoted_to)
            .await
            .expect("mark ask promoted");
        assert!(promoted);

        // Naming the WRONG successor must not touch the row.
        let wrong_successor = random_bytes32();
        let reverted_wrong = reopen_promoted_ask(&pool, community, &original_id, &wrong_successor)
            .await
            .expect("reopen with wrong successor");
        assert!(
            !reverted_wrong,
            "must not revert when the named successor does not match"
        );
        let still_promoted = fetch_any_ask(&pool, community, &original_id).await;
        assert_eq!(still_promoted.status, "promoted");

        // Naming the RIGHT successor reverts it.
        let reverted = reopen_promoted_ask(&pool, community, &original_id, &promoted_to)
            .await
            .expect("reopen with correct successor");
        assert!(
            reverted,
            "reopen_promoted_ask must report the promoted row was flipped"
        );
        let reopened = fetch_any_ask(&pool, community, &original_id).await;
        assert_eq!(reopened.status, "open");
        assert!(
            reopened.resolution_event.is_none(),
            "the promotion pointer must be cleared on reopen"
        );

        // The dedupe slot is free again: a fresh ask for the same need
        // succeeds, matching every other closing-then-reopening path.
        let after_reopen = random_bytes32();
        insert_ask(
            &pool,
            community,
            new_ask(&after_reopen, &audience, &filer, None),
        )
        .await
        .expect_err(
            "the REOPENED row itself now holds the dedupe slot again; a second insert must fail",
        );

        // Calling it again (already reverted) must be a no-op, not an error
        // and not a second flip -- idempotency.
        let reverted_again = reopen_promoted_ask(&pool, community, &original_id, &promoted_to)
            .await
            .expect("reopen an already-open row");
        assert!(
            !reverted_again,
            "reopening an already-open row must report false, not flip it again"
        );
    }

    /// `resolve_ask`/`withdraw_ask`/`mark_ask_promoted` return `false`
    /// (rather than erroring) when there is no open row to close: a stale
    /// event replay or a race against another resolution.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn closing_a_nonexistent_or_already_closed_ask_returns_false() {
        let pool = setup_pool().await;
        let community = make_test_community(&pool).await;
        let ghost_id = random_bytes32();

        assert!(!resolve_ask(
            &pool,
            community,
            &ghost_id,
            &random_bytes32(),
            &random_bytes32(),
            false
        )
        .await
        .expect("resolve nonexistent ask"));
        assert!(
            !withdraw_ask(&pool, community, &ghost_id, &random_bytes32())
                .await
                .expect("withdraw nonexistent ask")
        );
        assert!(
            !mark_ask_promoted(&pool, community, &ghost_id, &random_bytes32())
                .await
                .expect("promote nonexistent ask")
        );

        // Now close a real one, then confirm closing it again also reports false.
        let audience = random_bytes32();
        let filer = random_bytes32();
        insert_ask(
            &pool,
            community,
            new_ask(&ghost_id, &audience, &filer, None),
        )
        .await
        .expect("insert ask");
        assert!(resolve_ask(
            &pool,
            community,
            &ghost_id,
            &random_bytes32(),
            &random_bytes32(),
            false
        )
        .await
        .expect("resolve ask"));
        assert!(
            !resolve_ask(
                &pool,
                community,
                &ghost_id,
                &random_bytes32(),
                &random_bytes32(),
                false
            )
            .await
            .expect("resolve already-resolved ask"),
            "resolving an already-resolved ask must report false, not flip it again"
        );
    }

    /// The due-sweep query must return only open asks whose deadline has
    /// passed: not future deadlines, not asks with no deadline, not asks
    /// that are past-due but no longer open, and it must not be scoped to a
    /// single community (mirrors `query_due_reminders`).
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn query_due_asks_returns_only_past_due_open_rows_across_communities() {
        let pool = setup_pool().await;
        let community_a = make_test_community(&pool).await;
        let community_b = make_test_community(&pool).await;
        let now = Utc::now().timestamp();

        // These four all land in community_a with the same initiative, so
        // each needs a distinct need_key or the open-need dedupe index would
        // reject them for a reason unrelated to what this test is proving.
        let due_a = random_bytes32();
        insert_ask(
            &pool,
            community_a,
            new_ask_for_need(
                &due_a,
                "need-due-a",
                &random_bytes32(),
                &random_bytes32(),
                Some(now - 60),
            ),
        )
        .await
        .expect("insert due ask in community A");

        let due_b = random_bytes32();
        insert_ask(
            &pool,
            community_b,
            new_ask(&due_b, &random_bytes32(), &random_bytes32(), Some(now - 30)),
        )
        .await
        .expect("insert due ask in community B");

        let not_yet_due = random_bytes32();
        insert_ask(
            &pool,
            community_a,
            new_ask_for_need(
                &not_yet_due,
                "need-future",
                &random_bytes32(),
                &random_bytes32(),
                Some(now + 3600),
            ),
        )
        .await
        .expect("insert future-deadline ask");

        let no_deadline = random_bytes32();
        insert_ask(
            &pool,
            community_a,
            new_ask_for_need(
                &no_deadline,
                "need-none",
                &random_bytes32(),
                &random_bytes32(),
                None,
            ),
        )
        .await
        .expect("insert no-deadline ask");

        // A past-due ask that has already been resolved must not resurface.
        let resolved_past_due = random_bytes32();
        insert_ask(
            &pool,
            community_a,
            new_ask_for_need(
                &resolved_past_due,
                "need-resolved",
                &random_bytes32(),
                &random_bytes32(),
                Some(now - 120),
            ),
        )
        .await
        .expect("insert soon-to-be-resolved past-due ask");
        resolve_ask(
            &pool,
            community_a,
            &resolved_past_due,
            &random_bytes32(),
            &random_bytes32(),
            false,
        )
        .await
        .expect("resolve past-due ask");

        let due = query_due_asks(&pool, now, 100)
            .await
            .expect("query due asks");
        let due_ids: Vec<&[u8]> = due.iter().map(|row| row.ask_event_id.as_slice()).collect();

        assert!(due_ids.contains(&due_a.as_slice()));
        assert!(due_ids.contains(&due_b.as_slice()));
        assert!(!due_ids.contains(&not_yet_due.as_slice()));
        assert!(!due_ids.contains(&no_deadline.as_slice()));
        assert!(!due_ids.contains(&resolved_past_due.as_slice()));
    }

    /// `extend_ask_deadline` must push `deadline_at` forward and leave
    /// `status` (and every other column) untouched, and must report `false`
    /// -- not error -- when there is no open row to extend.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn extend_ask_deadline_pushes_the_deadline_and_leaves_status_open() {
        let pool = setup_pool().await;
        let community = make_test_community(&pool).await;
        let audience = random_bytes32();
        let filer = random_bytes32();
        let now = Utc::now().timestamp();

        let ask_id = random_bytes32();
        insert_ask(
            &pool,
            community,
            new_ask(&ask_id, &audience, &filer, Some(now - 60)),
        )
        .await
        .expect("insert ask");

        let new_deadline = now + 3600;
        let extended = extend_ask_deadline(&pool, community, &ask_id, new_deadline)
            .await
            .expect("extend deadline");
        assert!(
            extended,
            "extend_ask_deadline must report the open row was flipped"
        );

        let row = fetch_any_ask(&pool, community, &ask_id).await;
        assert_eq!(row.deadline_at, Some(new_deadline));
        assert_eq!(row.status, "open");
        assert!(
            row.updated_at >= row.created_at,
            "extend_ask_deadline must set updated_at"
        );

        // No longer due at the OLD deadline's time -- the sweep must not
        // pick this row up again immediately.
        let due = query_due_asks(&pool, now, 100)
            .await
            .expect("query due asks");
        assert!(
            !due.iter().any(|due_row| due_row.ask_event_id == ask_id),
            "an extended ask must not still read as due"
        );

        // Closing an already-closed (here: nonexistent) ask reports false
        // rather than erroring, matching resolve_ask/withdraw_ask/mark_ask_promoted.
        let ghost_id = random_bytes32();
        assert!(
            !extend_ask_deadline(&pool, community, &ghost_id, new_deadline)
                .await
                .expect("extend nonexistent ask")
        );
    }

    /// `find_open_asks_by_thread` backs owner thread-reply auto-resolution
    /// (Task 6): it must return every OPEN ask rooted at `thread_root`, and
    /// nothing else -- not asks rooted elsewhere, and not an ask that was
    /// rooted there but has already closed (resolved, withdrawn, or
    /// promoted), since a closed ask has nothing left for a reply to
    /// auto-resolve.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn find_open_asks_by_thread_returns_only_open_asks_rooted_there() {
        let pool = setup_pool().await;
        let community = make_test_community(&pool).await;
        let audience = random_bytes32();
        let filer = random_bytes32();
        let thread_root = random_bytes32();

        let first_id = random_bytes32();
        insert_ask(
            &pool,
            community,
            NewAskRow {
                origin_thread: Some(&thread_root),
                ..new_ask_for_need(&first_id, "need-a", &audience, &filer, None)
            },
        )
        .await
        .expect("insert first ask");

        let second_id = random_bytes32();
        insert_ask(
            &pool,
            community,
            NewAskRow {
                origin_thread: Some(&thread_root),
                ..new_ask_for_need(&second_id, "need-b", &audience, &filer, None)
            },
        )
        .await
        .expect("insert second ask");

        // Rooted in a DIFFERENT thread -- must not come back.
        let other_thread = random_bytes32();
        let third_id = random_bytes32();
        insert_ask(
            &pool,
            community,
            NewAskRow {
                origin_thread: Some(&other_thread),
                ..new_ask_for_need(&third_id, "need-c", &audience, &filer, None)
            },
        )
        .await
        .expect("insert third ask");

        // Rooted in the SAME thread but already resolved -- must not come
        // back either.
        let fourth_id = random_bytes32();
        insert_ask(
            &pool,
            community,
            NewAskRow {
                origin_thread: Some(&thread_root),
                ..new_ask_for_need(&fourth_id, "need-d", &audience, &filer, None)
            },
        )
        .await
        .expect("insert fourth ask");
        resolve_ask(
            &pool,
            community,
            &fourth_id,
            &random_bytes32(),
            &random_bytes32(),
            false,
        )
        .await
        .expect("resolve fourth ask");

        let found = find_open_asks_by_thread(&pool, community, &thread_root)
            .await
            .expect("query open asks by thread");
        let found_ids: Vec<&[u8]> = found
            .iter()
            .map(|row| row.ask_event_id.as_slice())
            .collect();

        assert_eq!(
            found.len(),
            2,
            "expected exactly the two still-open asks rooted in this thread"
        );
        assert!(found_ids.contains(&first_id.as_slice()));
        assert!(found_ids.contains(&second_id.as_slice()));
        assert!(!found_ids.contains(&third_id.as_slice()));
        assert!(!found_ids.contains(&fourth_id.as_slice()));
    }
}
