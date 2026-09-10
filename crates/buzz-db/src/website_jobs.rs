//! Relay-owned state for Website Manager jobs and once-only action claims.
//!
//! The `website_jobs` row is the authority for one website job: the pinned
//! owner and coordinator, the assigned personas per role, the current review
//! record, and the compare-and-set `generation` every mutation must name. The
//! relay-signed kind:30203 head is a projection of that row.
//!
//! `website_actions` is the durable retry boundary. Its primary key is the
//! per-actor request UUID, so a retry that reuses it reads the recorded head
//! and receipt back instead of applying the transition twice; the canonical
//! payload digest stored alongside detects a replay that reuses the request id
//! with different content, and the unique action event id rejects a resubmitted
//! signed event.

use sqlx::{PgExecutor, Postgres, Row as _, Transaction};
use uuid::Uuid;

use crate::error::Result;
use crate::CommunityId;

/// A row from the `website_jobs` table.
#[derive(Debug, Clone, PartialEq)]
pub struct WebsiteJobRow {
    /// Canonical job UUID.
    pub job_id: Uuid,
    /// Canonical `CompanyTask` id this job serves.
    pub task_id: String,
    /// Channel that owns the job thread.
    pub channel_id: Uuid,
    /// Root event id of the job thread.
    pub thread_root: String,
    /// Coordinator-authored Block instance event id for the review card.
    pub instance_event_id: Vec<u8>,
    /// Block manifest event id the review-card instance pins.
    pub manifest_event_id: Vec<u8>,
    /// Pinned owner pubkey bytes.
    pub owner: Vec<u8>,
    /// Pinned coordinator pubkey bytes.
    pub coordinator: Vec<u8>,
    /// Public HTTPS source reference for the site source.
    pub source_url: String,
    /// Serialized review status (`draft`, `working`, ...).
    pub status: String,
    /// Highest recorded site revision.
    pub current_revision: i32,
    /// Exact compact JSON bytes of the `colony.website-review/v1` record.
    pub review: Vec<u8>,
    /// Personas allowed to record research evidence.
    pub research_personas: Vec<String>,
    /// Personas allowed to add revisions.
    pub build_personas: Vec<String>,
    /// Personas allowed to record independent QA.
    pub review_personas: Vec<String>,
    /// Event id of the current relay-signed head.
    pub head_event_id: Vec<u8>,
    /// Row compare-and-set generation.
    pub generation: i64,
    /// Strictly increasing stamp for the projected head's `created_at`.
    pub head_at: i64,
    /// Unix timestamp when the row was created.
    pub created_at: i64,
    /// Unix timestamp when the row last changed.
    pub updated_at: i64,
}

/// Read and lock a job inside the caller's transaction.
///
/// The row lock serializes every mutation for one job: a second broker
/// transaction waits, then observes the committed generation and review, so
/// authorization decisions are never made against a row another writer is
/// concurrently replacing.
pub async fn lock_website_job_tx(
    tx: &mut Transaction<'_, Postgres>,
    community: CommunityId,
    job_id: Uuid,
) -> Result<Option<WebsiteJobRow>> {
    let sql = format!(
        "SELECT {JOB_COLUMNS} FROM website_jobs \
         WHERE community_id = $1 AND job_id = $2 FOR UPDATE"
    );
    let row = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(community.as_uuid())
        .bind(job_id)
        .fetch_optional(&mut **tx)
        .await?;
    row.map(row_to_job).transpose()
}

/// The fields a new website job needs.
pub struct NewWebsiteJob<'a> {
    /// Canonical job UUID.
    pub job_id: Uuid,
    /// Canonical `CompanyTask` id this job serves.
    pub task_id: &'a str,
    /// Channel that owns the job thread.
    pub channel_id: Uuid,
    /// Root event id of the job thread.
    pub thread_root: &'a str,
    /// Coordinator-authored Block instance event id for the review card.
    pub instance_event_id: &'a [u8],
    /// Block manifest event id the review-card instance pins.
    pub manifest_event_id: &'a [u8],
    /// Pinned owner pubkey bytes.
    pub owner: &'a [u8],
    /// Pinned coordinator pubkey bytes.
    pub coordinator: &'a [u8],
    /// Public HTTPS source reference.
    pub source_url: &'a str,
    /// Exact compact JSON bytes of the initial review record.
    pub review: &'a [u8],
    /// Personas allowed to record research evidence.
    pub research_personas: &'a [String],
    /// Personas allowed to add revisions.
    pub build_personas: &'a [String],
    /// Personas allowed to record independent QA.
    pub review_personas: &'a [String],
    /// Event id of the first relay-signed head.
    pub head_event_id: &'a [u8],
    /// Initial head stamp.
    pub head_at: i64,
    /// Current Unix timestamp.
    pub now: i64,
}

/// The fields one compare-and-set job update replaces.
pub struct WebsiteJobUpdate<'a> {
    /// New serialized review status.
    pub status: &'a str,
    /// New highest recorded site revision.
    pub current_revision: i32,
    /// Exact compact JSON bytes of the new review record.
    pub review: &'a [u8],
    /// Event id of the new relay-signed head.
    pub head_event_id: &'a [u8],
    /// New strictly increasing head stamp.
    pub head_at: i64,
    /// Current Unix timestamp.
    pub now: i64,
}

/// A row from the `website_actions` claim table.
#[derive(Debug, Clone, PartialEq)]
pub struct WebsiteActionClaimRow {
    /// Canonical job UUID the action targeted.
    pub job_id: Uuid,
    /// Event id of the applied action.
    pub action_event_id: Vec<u8>,
    /// Operation name.
    pub op: String,
    /// Canonical payload digest bytes.
    pub payload_digest: Vec<u8>,
    /// Event id of the committed head.
    pub head_event_id: Vec<u8>,
    /// Event id of the committed receipt.
    pub receipt_event_id: Vec<u8>,
    /// Committed row generation.
    pub generation: i64,
}

/// The fields one action claim needs.
pub struct NewWebsiteActionClaim<'a> {
    /// Actor pubkey bytes.
    pub actor: &'a [u8],
    /// Per-actor request UUID.
    pub request_id: Uuid,
    /// Canonical job UUID.
    pub job_id: Uuid,
    /// Event id of the applied action.
    pub action_event_id: &'a [u8],
    /// Operation name.
    pub op: &'a str,
    /// Canonical payload digest bytes.
    pub payload_digest: &'a [u8],
    /// Event id of the committed head.
    pub head_event_id: &'a [u8],
    /// Event id of the committed receipt.
    pub receipt_event_id: &'a [u8],
    /// Committed row generation.
    pub generation: i64,
}

const JOB_COLUMNS: &str = "job_id, task_id, channel_id, thread_root, instance_event_id, \
     manifest_event_id, owner, coordinator, \
     source_url, status, current_revision, review, research_personas, build_personas, \
     review_personas, head_event_id, generation, head_at, created_at, updated_at";

// Every `sqlx::query` built with a `format!` below wraps the string in
// `sqlx::AssertSqlSafe`: the only dynamic text is `JOB_COLUMNS` above and all
// values are bound parameters, so the statement shape is const.

fn row_to_job(row: sqlx::postgres::PgRow) -> Result<WebsiteJobRow> {
    Ok(WebsiteJobRow {
        job_id: row.try_get("job_id")?,
        task_id: row.try_get("task_id")?,
        channel_id: row.try_get("channel_id")?,
        thread_root: row.try_get("thread_root")?,
        instance_event_id: row.try_get("instance_event_id")?,
        manifest_event_id: row.try_get("manifest_event_id")?,
        owner: row.try_get("owner")?,
        coordinator: row.try_get("coordinator")?,
        source_url: row.try_get("source_url")?,
        status: row.try_get("status")?,
        current_revision: row.try_get("current_revision")?,
        review: row.try_get("review")?,
        research_personas: row.try_get("research_personas")?,
        build_personas: row.try_get("build_personas")?,
        review_personas: row.try_get("review_personas")?,
        head_event_id: row.try_get("head_event_id")?,
        generation: row.try_get("generation")?,
        head_at: row.try_get("head_at")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn row_to_claim(row: sqlx::postgres::PgRow) -> Result<WebsiteActionClaimRow> {
    Ok(WebsiteActionClaimRow {
        job_id: row.try_get("job_id")?,
        action_event_id: row.try_get("action_event_id")?,
        op: row.try_get("op")?,
        payload_digest: row.try_get("payload_digest")?,
        head_event_id: row.try_get("head_event_id")?,
        receipt_event_id: row.try_get("receipt_event_id")?,
        generation: row.try_get("generation")?,
    })
}

/// Read a job by its canonical UUID.
pub async fn get_website_job<'e, E>(
    executor: E,
    community: CommunityId,
    job_id: Uuid,
) -> Result<Option<WebsiteJobRow>>
where
    E: PgExecutor<'e>,
{
    let sql = format!(
        "SELECT {JOB_COLUMNS} FROM website_jobs WHERE community_id = $1 AND job_id = $2"
    );
    let row = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(community.as_uuid())
        .bind(job_id)
        .fetch_optional(executor)
        .await?;
    row.map(row_to_job).transpose()
}

/// Read a job by the canonical task it serves.
pub async fn get_website_job_by_task<'e, E>(
    executor: E,
    community: CommunityId,
    task_id: &str,
) -> Result<Option<WebsiteJobRow>>
where
    E: PgExecutor<'e>,
{
    let sql = format!(
        "SELECT {JOB_COLUMNS} FROM website_jobs WHERE community_id = $1 AND task_id = $2"
    );
    let row = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(community.as_uuid())
        .bind(task_id)
        .fetch_optional(executor)
        .await?;
    row.map(row_to_job).transpose()
}

/// List jobs in a community, newest first, with a hard bound.
pub async fn list_website_jobs<'e, E>(
    executor: E,
    community: CommunityId,
    limit: i64,
) -> Result<Vec<WebsiteJobRow>>
where
    E: PgExecutor<'e>,
{
    let sql = format!(
        "SELECT {JOB_COLUMNS} FROM website_jobs WHERE community_id = $1 \
         ORDER BY created_at DESC, job_id ASC LIMIT $2"
    );
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(community.as_uuid())
        .bind(limit.clamp(1, 1000))
        .fetch_all(executor)
        .await?;
    rows.into_iter().map(row_to_job).collect()
}

/// Insert a job inside the caller's transaction.
///
/// `Ok(None)` means the `(community, task)` or `(community, job)` coordinate
/// already exists, so the caller must refuse the create rather than retry with
/// a different identity. One transaction can therefore apply a create at most
/// once even under a race.
pub async fn insert_website_job_tx(
    tx: &mut Transaction<'_, Postgres>,
    community: CommunityId,
    job: NewWebsiteJob<'_>,
) -> Result<Option<WebsiteJobRow>> {
    let sql = format!(
        "INSERT INTO website_jobs \
            (community_id, job_id, task_id, channel_id, thread_root, instance_event_id, \
             manifest_event_id, owner, coordinator, \
             source_url, status, current_revision, review, research_personas, build_personas, \
             review_personas, head_event_id, generation, head_at, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft', 0, $11, $12, $13, $14, $15, 1, \
                 $16, $17, $17) \
         ON CONFLICT DO NOTHING \
         RETURNING {JOB_COLUMNS}"
    );
    let row = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(community.as_uuid())
        .bind(job.job_id)
        .bind(job.task_id)
        .bind(job.channel_id)
        .bind(job.thread_root)
        .bind(job.instance_event_id)
        .bind(job.manifest_event_id)
        .bind(job.owner)
        .bind(job.coordinator)
        .bind(job.source_url)
        .bind(job.review)
        .bind(job.research_personas)
        .bind(job.build_personas)
        .bind(job.review_personas)
        .bind(job.head_event_id)
        .bind(job.head_at)
        .bind(job.now)
        .fetch_optional(&mut **tx)
        .await?;
    row.map(row_to_job).transpose()
}

/// Compare-and-set update of a job row inside the caller's transaction.
///
/// `Ok(None)` is the CAS loser: the row's generation is no longer the one the
/// actor observed, so a concurrent revision or decision won. It is never a
/// successful no-op.
pub async fn update_website_job_cas(
    tx: &mut Transaction<'_, Postgres>,
    community: CommunityId,
    job_id: Uuid,
    expected_generation: i64,
    update: WebsiteJobUpdate<'_>,
) -> Result<Option<WebsiteJobRow>> {
    let sql = format!(
        "UPDATE website_jobs \
            SET status = $4, current_revision = $5, review = $6, head_event_id = $7, \
                generation = generation + 1, head_at = GREATEST($8, head_at + 1), \
                updated_at = $9 \
          WHERE community_id = $1 AND job_id = $2 AND generation = $3 \
      RETURNING {JOB_COLUMNS}"
    );
    let row = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(community.as_uuid())
        .bind(job_id)
        .bind(expected_generation)
        .bind(update.status)
        .bind(update.current_revision)
        .bind(update.review)
        .bind(update.head_event_id)
        .bind(update.head_at)
        .bind(update.now)
        .fetch_optional(&mut **tx)
        .await?;
    row.map(row_to_job).transpose()
}

/// Read one action claim by its per-actor request coordinate.
pub async fn find_website_action_claim<'e, E>(
    executor: E,
    community: CommunityId,
    actor: &[u8],
    request_id: Uuid,
) -> Result<Option<WebsiteActionClaimRow>>
where
    E: PgExecutor<'e>,
{
    let row = sqlx::query(
        "SELECT job_id, action_event_id, op, payload_digest, head_event_id, receipt_event_id, \
                generation \
         FROM website_actions \
         WHERE community_id = $1 AND actor = $2 AND request_id = $3",
    )
    .bind(community.as_uuid())
    .bind(actor)
    .bind(request_id)
    .fetch_optional(executor)
    .await?;
    row.map(row_to_claim).transpose()
}

/// Read one action claim by the exact signed event it applied.
pub async fn find_website_action_claim_by_event<'e, E>(
    executor: E,
    community: CommunityId,
    action_event_id: &[u8],
) -> Result<Option<WebsiteActionClaimRow>>
where
    E: PgExecutor<'e>,
{
    let row = sqlx::query(
        "SELECT job_id, action_event_id, op, payload_digest, head_event_id, receipt_event_id, \
                generation \
         FROM website_actions \
         WHERE community_id = $1 AND action_event_id = $2",
    )
    .bind(community.as_uuid())
    .bind(action_event_id)
    .fetch_optional(executor)
    .await?;
    row.map(row_to_claim).transpose()
}

/// Insert an action claim inside the caller's transaction.
///
/// Returns `true` when this transaction won the claim. `false` means either
/// the per-actor request coordinate or the exact signed event is already
/// claimed; the caller re-reads the winner and returns its recorded receipt.
pub async fn insert_website_action_claim_tx(
    tx: &mut Transaction<'_, Postgres>,
    community: CommunityId,
    claim: NewWebsiteActionClaim<'_>,
) -> Result<bool> {
    let result = sqlx::query(
        "INSERT INTO website_actions \
            (community_id, actor, request_id, job_id, action_event_id, op, payload_digest, \
             head_event_id, receipt_event_id, generation) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) \
         ON CONFLICT DO NOTHING",
    )
    .bind(community.as_uuid())
    .bind(claim.actor)
    .bind(claim.request_id)
    .bind(claim.job_id)
    .bind(claim.action_event_id)
    .bind(claim.op)
    .bind(claim.payload_digest)
    .bind(claim.head_event_id)
    .bind(claim.receipt_event_id)
    .bind(claim.generation)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected() == 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::PgPool;

    const TEST_DB_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz"; // sadscan:disable np.postgres.1

    fn test_database_url() -> String {
        std::env::var("BUZZ_TEST_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .unwrap_or_else(|_| TEST_DB_URL.to_owned())
    }

    async fn setup() -> (PgPool, CommunityId, Uuid) {
        let pool = PgPool::connect(&test_database_url())
            .await
            .expect("connect to test DB");
        crate::migration::run_migrations_unless_provisioned(&pool)
            .await
            .expect("apply migrations");
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(id)
            .bind(format!("website-jobs-test-{}.example", id.simple()))
            .execute(&pool)
            .await
            .expect("insert test community");
        let community = CommunityId::from_uuid(id);
        let channel = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO channels \
                (id, community_id, name, channel_type, visibility, created_by) \
             VALUES ($1, $2, $3, 'stream'::channel_type, 'open'::channel_visibility, $4)",
        )
        .bind(channel)
        .bind(community.as_uuid())
        .bind(format!("website-{}", channel.simple()))
        .bind([0x11_u8; 32].as_slice())
        .execute(&pool)
        .await
        .expect("insert test channel");
        (pool, community, channel)
    }

    fn review_bytes(job_id: Uuid) -> Vec<u8> {
        let review = buzz_core::website::WebsiteReview::new(buzz_core::website::WebsiteReviewInit {
            job_id,
            task_id: "task-website".to_owned(),
            channel: "website-ops".to_owned(),
            thread_root: "e".repeat(64),
            owner: "a".repeat(64),
            coordinator: Some("b".repeat(64)),
            source_url: "https://source.colony.test/sites/acme".to_owned(),
        })
        .expect("valid review");
        serde_json::to_vec(&review).expect("review serializes")
    }

    async fn insert_job(
        pool: &PgPool,
        community: CommunityId,
        channel: Uuid,
        job_id: Uuid,
        task_id: &str,
    ) -> Option<WebsiteJobRow> {
        let review = review_bytes(job_id);
        let mut tx = pool.begin().await.expect("begin job insert");
        let inserted = insert_website_job_tx(
            &mut tx,
            community,
            NewWebsiteJob {
                job_id,
                task_id,
                channel_id: channel,
                thread_root: &"e".repeat(64),
                instance_event_id: &[0x21_u8; 32],
                manifest_event_id: &[0x22_u8; 32],
                owner: &[0xaa_u8; 32],
                coordinator: &[0xbb_u8; 32],
                source_url: "https://source.colony.test/sites/acme",
                review: &review,
                research_personas: &["persona-research".to_owned()],
                build_personas: &["persona-build".to_owned()],
                review_personas: &["persona-review".to_owned()],
                head_event_id: &[0x31_u8; 32],
                head_at: 1,
                now: 1,
            },
        )
        .await
        .expect("job insert");
        tx.commit().await.expect("commit job insert");
        inserted
    }

    #[tokio::test]
    async fn one_task_owns_one_job() {
        let (pool, community, channel) = setup().await;
        let first = insert_job(&pool, community, channel, Uuid::new_v4(), "task-a")
            .await
            .expect("first job");
        assert_eq!(first.task_id, "task-a");
        assert_eq!(first.generation, 1);

        let second = insert_job(&pool, community, channel, Uuid::new_v4(), "task-a").await;
        assert!(
            second.is_none(),
            "a second create for the same canonical task must lose"
        );
    }

    #[tokio::test]
    async fn generation_cas_refuses_a_stale_writer() {
        let (pool, community, channel) = setup().await;
        let job_id = Uuid::new_v4();
        let job = insert_job(&pool, community, channel, job_id, "task-b")
            .await
            .expect("job");
        let review = review_bytes(job_id);
        let mut tx = pool.begin().await.expect("begin cas");
        let updated = update_website_job_cas(
            &mut tx,
            community,
            job_id,
            job.generation,
            WebsiteJobUpdate {
                status: "working",
                current_revision: 1,
                review: &review,
                head_event_id: &[0x41_u8; 32],
                head_at: 2,
                now: 2,
            },
        )
        .await
        .expect("cas update");
        tx.commit().await.expect("commit cas");
        let updated = updated.expect("first CAS wins");
        assert_eq!(updated.generation, job.generation + 1);

        let mut tx = pool.begin().await.expect("begin stale cas");
        let stale = update_website_job_cas(
            &mut tx,
            community,
            job_id,
            job.generation,
            WebsiteJobUpdate {
                status: "working",
                current_revision: 1,
                review: &review,
                head_event_id: &[0x42_u8; 32],
                head_at: 3,
                now: 3,
            },
        )
        .await
        .expect("stale cas query");
        tx.rollback().await.expect("rollback stale");
        assert!(stale.is_none(), "a stale generation must match no row");
    }

    #[tokio::test]
    async fn action_claim_is_once_only_and_records_the_digest() {
        let (pool, community, channel) = setup().await;
        let job_id = Uuid::new_v4();
        insert_job(&pool, community, channel, job_id, "task-c")
            .await
            .expect("job");
        let request_id = Uuid::new_v4();
        let actor = [0xaa_u8; 32];
        let digest = [0x33_u8; 32];
        let action_event = [0x51_u8; 32];
        let head_event = [0x52_u8; 32];
        let receipt_event = [0x53_u8; 32];

        let mut tx = pool.begin().await.expect("begin claim");
        let won = insert_website_action_claim_tx(
            &mut tx,
            community,
            NewWebsiteActionClaim {
                actor: &actor,
                request_id,
                job_id,
                action_event_id: &action_event,
                op: "create",
                payload_digest: &digest,
                head_event_id: &head_event,
                receipt_event_id: &receipt_event,
                generation: 1,
            },
        )
        .await
        .expect("first claim");
        assert!(won, "the first claim must win");
        tx.commit().await.expect("commit claim");

        let mut tx = pool.begin().await.expect("begin retry");
        let retry = insert_website_action_claim_tx(
            &mut tx,
            community,
            NewWebsiteActionClaim {
                actor: &actor,
                request_id,
                job_id,
                action_event_id: &[0x54_u8; 32],
                op: "create",
                payload_digest: &digest,
                head_event_id: &head_event,
                receipt_event_id: &receipt_event,
                generation: 1,
            },
        )
        .await
        .expect("retry claim");
        tx.rollback().await.expect("rollback retry");
        assert!(!retry, "a reused request UUID must not claim twice");

        let recorded = find_website_action_claim(&pool, community, &actor, request_id)
            .await
            .expect("read claim")
            .expect("claim exists");
        assert_eq!(recorded.payload_digest, digest);
        assert_eq!(recorded.head_event_id, head_event);
        let by_event = find_website_action_claim_by_event(&pool, community, &action_event)
            .await
            .expect("read by event")
            .expect("event claim exists");
        assert_eq!(by_event.job_id, job_id);
        assert_eq!(by_event.receipt_event_id, receipt_event);
    }
}

