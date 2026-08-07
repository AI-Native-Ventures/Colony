//! The job queue: one row per piece of work an employee owes.
//!
//! Employees are shared and workers are not. Two founders can both have a
//! machine that could run the Chief of Staff, so something has to decide which
//! machine runs a given task, and has to keep deciding after that machine dies
//! mid-task (`docs/design/company-employees.html`).
//!
//! That decision cannot live in events. Nostr events are append-only and
//! unordered across clients, so two workers each publishing "I'll take it" are
//! both equally true and neither is the winner. Mutual exclusion needs a
//! compare-and-set against one authority. It is here, in
//! [`claim_job`]: a single conditional UPDATE that lands only when the job is
//! open or its lease has already lapsed. Two racing claims produce one winner
//! and one `Ok(None)`. Everything else in this module is bookkeeping around
//! that one statement.
//!
//! Three rules hold the queue together, and each is a `WHERE` clause rather
//! than a convention calling code is trusted to follow:
//!
//! - **Only the current lease holder may move a job.** [`heartbeat_job`] and
//!   [`finish_job`] require both `lease_holder = $holder` and `attempts =
//!   $attempt`. The pubkey alone is not enough: one founder's laptop and
//!   desktop share an identity, so a worker that hung and lost its lease
//!   carries the same key as the worker that replaced it. The attempt count
//!   rises on every claim, which makes it a fencing token, so a stale worker
//!   waking up cannot overwrite the live one's result.
//! - **A finished job stays finished.** Both also require `status = 'leased'`,
//!   so a duplicate outcome settles as `Ok(None)` instead of reopening a job
//!   or rewriting its result.
//! - **A lapsed lease is claimable by anyone.** [`claim_job`] does not wait
//!   for the sweep to reopen the row. The sweep exists to make the lapse
//!   visible and to stop a job that has killed enough workers; correctness
//!   does not depend on it having run.

use chrono::Utc;
use sqlx::{PgPool, Row as _};

use crate::error::Result;
use crate::CommunityId;

/// A row from the `jobs` table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobRow {
    /// The filing event id, which is the job id (32 raw bytes).
    pub job_id: Vec<u8>,
    /// The employee that owes the work.
    pub employee: Vec<u8>,
    /// Whoever signed the filing.
    pub filed_by: Vec<u8>,
    /// The human the work belongs to, and the only seat allowed to claim it.
    pub originator: Vec<u8>,
    /// The channel the job came from, if any.
    pub channel_id: Option<uuid::Uuid>,
    /// The thread the job came from, if any.
    pub thread: Option<Vec<u8>>,
    /// What to do.
    pub instruction: String,
    /// One of `open`, `leased`, `done`, `failed`, `abandoned`.
    pub status: String,
    /// The seat holding the lease, or that last held it.
    pub lease_holder: Option<Vec<u8>>,
    /// When the lease lapses, in unix seconds.
    pub lease_expires_at: Option<i64>,
    /// How many times this job has been leased.
    pub attempts: i32,
    /// The result, once there is one.
    pub result: Option<String>,
    /// Why it failed, once it has.
    pub failure: Option<String>,
    /// The provider stamp on a finished job, when the worker set one.
    pub provider: Option<String>,
    /// The model stamp on a finished job, when the worker set one.
    pub model: Option<String>,
    /// The stall ask filed about this job, if one has been.
    pub escalated_ask: Option<Vec<u8>>,
    /// Unix seconds when the job was filed.
    pub created_at: i64,
    /// Unix seconds of the last change to this row.
    pub updated_at: i64,
}

/// A job row together with the community it belongs to.
///
/// The sweeps run across every community at once, the way the interrupt sweep
/// does, so their rows have to carry their own tenant rather than inheriting
/// it from the caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TenantJobRow {
    /// The community this job belongs to.
    pub community_id: uuid::Uuid,
    /// That community's host, which a sweep needs to build a tenant context
    /// and publish anything.
    pub host: String,
    /// The job itself.
    pub job: JobRow,
}

/// Borrowed input for [`finish_job`], so recording an ending does not take
/// eight positional arguments.
#[derive(Debug, Clone, Copy)]
pub struct FinishedJob<'a> {
    /// The job that ended.
    pub job_id: &'a [u8],
    /// The seat reporting it.
    pub holder: &'a [u8],
    /// Which lease that seat holds. See [`heartbeat_job`] for why the pubkey
    /// alone is not enough.
    pub attempt: i32,
    /// `done` or `failed`; the caller has already refused anything else.
    pub status: &'a str,
    /// The result, or why it failed.
    pub detail: &'a str,
    /// Provider stamp for the head, when the outcome carried one.
    pub provider: Option<&'a str>,
    /// Model stamp for the head, when the outcome carried one.
    pub model: Option<&'a str>,
    /// Unix seconds to stamp the row with.
    pub now: i64,
}

/// Borrowed input for [`insert_job`].
#[derive(Debug, Clone, Copy)]
pub struct NewJob<'a> {
    /// The filing event id, which becomes the job id.
    pub job_id: &'a [u8],
    /// The employee that owes the work.
    pub employee: &'a [u8],
    /// Whoever signed the filing.
    pub filed_by: &'a [u8],
    /// The human the work belongs to.
    pub originator: &'a [u8],
    /// The channel the filing came from, if any.
    pub channel_id: Option<uuid::Uuid>,
    /// The thread the filing came from, if any.
    pub thread: Option<&'a [u8]>,
    /// What to do.
    pub instruction: &'a str,
}

// Every query below repeats the same column list. sqlx rejects SQL assembled
// at runtime, so there is no shared constant to interpolate: the repetition is
// the cost of statements the compiler can see. A column added to `jobs` has to
// be added to `row_to_job` and to every query here.
fn row_to_job(row: sqlx::postgres::PgRow) -> Result<JobRow> {
    Ok(JobRow {
        job_id: row.try_get("job_id")?,
        employee: row.try_get("employee")?,
        filed_by: row.try_get("filed_by")?,
        originator: row.try_get("originator")?,
        channel_id: row.try_get("channel_id")?,
        thread: row.try_get("thread")?,
        instruction: row.try_get("instruction")?,
        status: row.try_get("status")?,
        lease_holder: row.try_get("lease_holder")?,
        lease_expires_at: row.try_get("lease_expires_at")?,
        attempts: row.try_get("attempts")?,
        result: row.try_get("result")?,
        failure: row.try_get("failure")?,
        provider: row.try_get("provider")?,
        model: row.try_get("model")?,
        escalated_ask: row.try_get("escalated_ask")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn row_to_tenant_job(row: sqlx::postgres::PgRow) -> Result<TenantJobRow> {
    Ok(TenantJobRow {
        community_id: row.try_get("community_id")?,
        host: row.try_get("host")?,
        job: row_to_job(row)?,
    })
}

/// File a job.
///
/// Returns `Ok(None)` when this filing already produced a job, so the
/// best-effort side effect that files jobs can run twice for one event
/// without producing two.
pub async fn insert_job(
    pool: &PgPool,
    community: CommunityId,
    job: NewJob<'_>,
) -> Result<Option<JobRow>> {
    let now = Utc::now().timestamp();
    let row = sqlx::query(
        "INSERT INTO jobs (community_id, job_id, employee, filed_by, originator, channel_id, \
                           thread, instruction, status, attempts, created_at, updated_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',0,$9,$9) \
         ON CONFLICT DO NOTHING \
         RETURNING job_id, employee, filed_by, originator, channel_id, thread, instruction, \
                   status, lease_holder, lease_expires_at, attempts, result, failure, \
                   provider, model, escalated_ask, created_at, updated_at",
    )
    .bind(community.as_uuid())
    .bind(job.job_id)
    .bind(job.employee)
    .bind(job.filed_by)
    .bind(job.originator)
    .bind(job.channel_id)
    .bind(job.thread)
    .bind(job.instruction)
    .bind(now)
    .fetch_optional(pool)
    .await?;

    row.map(row_to_job).transpose()
}

/// Look a job up by id.
pub async fn find_job(
    pool: &PgPool,
    community: CommunityId,
    job_id: &[u8],
) -> Result<Option<JobRow>> {
    let row = sqlx::query(
        "SELECT job_id, employee, filed_by, originator, channel_id, thread, instruction, \
                status, lease_holder, lease_expires_at, attempts, result, failure, \
                provider, model, escalated_ask, created_at, updated_at \
         FROM jobs WHERE community_id = $1 AND job_id = $2",
    )
    .bind(community.as_uuid())
    .bind(job_id)
    .fetch_optional(pool)
    .await?;

    row.map(row_to_job).transpose()
}

/// Take the lease on a job, if it is there to take.
///
/// This is the queue's whole arbitration. The `WHERE` clause accepts exactly
/// two situations: the job is open, or it is leased to somebody whose lease
/// has already lapsed. Anything else matches no rows and returns `Ok(None)`,
/// which is how a losing claimant learns it lost.
///
/// A lapsed lease is taken over here rather than waiting for the sweep to
/// reopen the row, so a worker that dies is replaced as soon as somebody asks,
/// not as soon as a timer happens to fire.
///
/// The attempt cap is enforced here too, not only in the sweep. A job at the
/// cap has already stopped enough workers that the next seat to try is just
/// the next casualty, and a worker asking for it a moment before the sweep
/// gets to the row would otherwise be handed exactly that.
pub async fn claim_job(
    pool: &PgPool,
    community: CommunityId,
    job_id: &[u8],
    holder: &[u8],
    max_attempts: i32,
    now: i64,
    lease_expires_at: i64,
) -> Result<Option<JobRow>> {
    let row = sqlx::query(
        "UPDATE jobs SET status = 'leased', lease_holder = $3, lease_expires_at = $5, \
                         attempts = attempts + 1, updated_at = $6 \
         WHERE community_id = $1 AND job_id = $2 \
           AND attempts < $4 \
           AND (status = 'open' OR (status = 'leased' AND lease_expires_at < $6)) \
         RETURNING job_id, employee, filed_by, originator, channel_id, thread, instruction, \
                   status, lease_holder, lease_expires_at, attempts, result, failure, \
                   provider, model, escalated_ask, created_at, updated_at",
    )
    .bind(community.as_uuid())
    .bind(job_id)
    .bind(holder)
    .bind(max_attempts)
    .bind(lease_expires_at)
    .bind(now)
    .fetch_optional(pool)
    .await?;

    row.map(row_to_job).transpose()
}

/// Push a lease's deadline out.
///
/// Requires the caller to hold the lease it names, so a worker that hung long
/// enough to lose its lease cannot heartbeat its way back over whoever took
/// the job over. Returns `Ok(None)` when it no longer holds that lease, which
/// is the signal to stop working.
pub async fn heartbeat_job(
    pool: &PgPool,
    community: CommunityId,
    job_id: &[u8],
    holder: &[u8],
    attempt: i32,
    now: i64,
    lease_expires_at: i64,
) -> Result<Option<JobRow>> {
    let row = sqlx::query(
        "UPDATE jobs SET lease_expires_at = $5, updated_at = $6 \
         WHERE community_id = $1 AND job_id = $2 AND status = 'leased' \
           AND lease_holder = $3 AND attempts = $4 \
         RETURNING job_id, employee, filed_by, originator, channel_id, thread, instruction, \
                   status, lease_holder, lease_expires_at, attempts, result, failure, \
                   provider, model, escalated_ask, created_at, updated_at",
    )
    .bind(community.as_uuid())
    .bind(job_id)
    .bind(holder)
    .bind(attempt)
    .bind(lease_expires_at)
    .bind(now)
    .fetch_optional(pool)
    .await?;

    row.map(row_to_job).transpose()
}

/// Record how a job ended.
///
/// `status` is `done` or `failed`; the caller has already refused anything
/// else. Deliberately does not care whether the lease has expired, only
/// whether this caller still holds the lease it names: work that finished a
/// second late is still work, and throwing it away would be worse than
/// accepting it. What it will not accept is an outcome from a superseded
/// lease, because then somebody else owns the answer.
pub async fn finish_job(
    pool: &PgPool,
    community: CommunityId,
    outcome: FinishedJob<'_>,
) -> Result<Option<JobRow>> {
    let FinishedJob {
        job_id,
        holder,
        attempt,
        status,
        detail,
        provider,
        model,
        now,
    } = outcome;
    let row = sqlx::query(
        "UPDATE jobs SET status = $5, \
                         result = CASE WHEN $5 = 'done' THEN $6 ELSE result END, \
                         failure = CASE WHEN $5 = 'failed' THEN $6 ELSE failure END, \
                         provider = CASE WHEN $5 = 'done' THEN $8 ELSE provider END, \
                         model = CASE WHEN $5 = 'done' THEN $9 ELSE model END, \
                         lease_expires_at = NULL, \
                         updated_at = $7 \
         WHERE community_id = $1 AND job_id = $2 AND status = 'leased' \
           AND lease_holder = $3 AND attempts = $4 \
         RETURNING job_id, employee, filed_by, originator, channel_id, thread, instruction, \
                   status, lease_holder, lease_expires_at, attempts, result, failure, \
                   provider, model, escalated_ask, created_at, updated_at",
    )
    .bind(community.as_uuid())
    .bind(job_id)
    .bind(holder)
    .bind(attempt)
    .bind(status)
    .bind(detail)
    .bind(now)
    .bind(provider)
    .bind(model)
    .fetch_optional(pool)
    .await?;

    row.map(row_to_job).transpose()
}

/// Take every lapsed lease away in one statement, across every community.
///
/// A job under the attempt cap goes back to `open` for somebody else to claim.
/// A job at the cap is `abandoned` instead: it has now killed enough workers
/// that offering it to another seat is just spreading the damage, and a human
/// needs to look at it.
///
/// `SKIP LOCKED` means two relay instances sweeping at once split the work
/// rather than blocking on each other.
pub async fn expire_due_leases(
    pool: &PgPool,
    now: i64,
    max_attempts: i32,
    limit: i64,
) -> Result<Vec<TenantJobRow>> {
    let rows = sqlx::query(
        "WITH due AS ( \
             SELECT community_id, job_id FROM jobs \
             WHERE status = 'leased' AND lease_expires_at < $1 \
             ORDER BY lease_expires_at \
             LIMIT $3 \
             FOR UPDATE SKIP LOCKED \
         ) \
         UPDATE jobs SET status = CASE WHEN jobs.attempts >= $2 THEN 'abandoned' ELSE 'open' END, \
                         lease_holder = NULL, \
                         lease_expires_at = NULL, \
                         updated_at = $1 \
         FROM due JOIN communities c ON c.id = due.community_id \
         WHERE jobs.community_id = due.community_id AND jobs.job_id = due.job_id \
         RETURNING jobs.community_id, c.host, jobs.job_id, jobs.employee, jobs.filed_by, \
                   jobs.originator, jobs.channel_id, jobs.thread, jobs.instruction, \
                   jobs.status, jobs.lease_holder, jobs.lease_expires_at, jobs.attempts, \
                   jobs.result, jobs.failure, jobs.provider, jobs.model, jobs.escalated_ask, \
                   jobs.created_at, jobs.updated_at",
    )
    .bind(now)
    .bind(max_attempts)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    rows.into_iter().map(row_to_tenant_job).collect()
}

/// Jobs that need a human told about them, across every community.
///
/// Two shapes qualify: a job abandoned after exhausting its attempts, and a
/// job nobody has claimed since `unclaimed_before`. Both are already excluded
/// once [`record_escalation`] has run, so the sweep asks once and then stops.
pub async fn list_jobs_needing_escalation(
    pool: &PgPool,
    unclaimed_before: i64,
    limit: i64,
) -> Result<Vec<TenantJobRow>> {
    let rows = sqlx::query(
        "SELECT j.community_id, c.host, j.job_id, j.employee, j.filed_by, j.originator, \
                j.channel_id, j.thread, j.instruction, j.status, j.lease_holder, \
                j.lease_expires_at, j.attempts, j.result, j.failure, j.provider, j.model, \
                j.escalated_ask, j.created_at, j.updated_at \
         FROM jobs j JOIN communities c ON c.id = j.community_id \
         WHERE j.escalated_ask IS NULL \
           AND (j.status = 'abandoned' OR (j.status = 'open' AND j.created_at < $1)) \
         ORDER BY j.created_at \
         LIMIT $2",
    )
    .bind(unclaimed_before)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    rows.into_iter().map(row_to_tenant_job).collect()
}

/// Stamp this job's next head, and read the job in the same statement.
///
/// Two things have to be true of a job head, and one statement is what makes
/// them true together.
///
/// **The stamp has to rise.** NIP-33 resolves two revisions of a replaceable
/// event by `created_at`, at one-second resolution, and a job routinely moves
/// twice within one second: filing and claiming are two HTTP requests a worker
/// sends back to back. Two heads stamped with the same second tie, the
/// replacement is undefined, and readers keep showing the older state — a
/// worker claims a job, reads the head back, and is told the job is still
/// open. So the stamp is `GREATEST(head_at + 1, now)`, which makes each job's
/// heads strictly increasing. Under a burst it runs a few seconds ahead of
/// real time and settles back the moment the clock catches up.
///
/// **The newest stamp has to carry the newest state.** Publishers each hold a
/// row snapshot from whenever their own transition ran. If stamping were
/// separate from reading, two concurrent publishers could invert: the one
/// holding the older snapshot takes the higher stamp and its stale state wins.
/// A job would show `open` while the row said `leased`. Returning the row from
/// the stamping statement removes the window, because whoever gets the higher
/// stamp necessarily read the row after everyone below them.
///
/// `Ok(None)` when the job is gone, so a caller does not publish a head for a
/// job that no longer exists.
pub async fn stamp_head(
    pool: &PgPool,
    community: CommunityId,
    job_id: &[u8],
    now: i64,
) -> Result<Option<(i64, JobRow)>> {
    let row = sqlx::query(
        "UPDATE jobs SET head_at = GREATEST(head_at + 1, $3) \
         WHERE community_id = $1 AND job_id = $2 \
         RETURNING head_at, job_id, employee, filed_by, originator, channel_id, thread, \
                   instruction, status, lease_holder, lease_expires_at, attempts, result, \
                   failure, provider, model, escalated_ask, created_at, updated_at",
    )
    .bind(community.as_uuid())
    .bind(job_id)
    .bind(now)
    .fetch_optional(pool)
    .await?;

    let Some(row) = row else {
        return Ok(None);
    };
    let head_at: i64 = row.try_get("head_at")?;
    Ok(Some((head_at, row_to_job(row)?)))
}

/// Remember that a human has been asked about this job.
///
/// Only ever set, never cleared, and only when still unset: a second sweep
/// racing the first files no second ask. Returns whether this call was the one
/// that recorded it, so the caller knows whether to publish the ask.
pub async fn record_escalation(
    pool: &PgPool,
    community: CommunityId,
    job_id: &[u8],
    ask_event: &[u8],
) -> Result<bool> {
    let result = sqlx::query(
        "UPDATE jobs SET escalated_ask = $3, updated_at = $4 \
         WHERE community_id = $1 AND job_id = $2 AND escalated_ask IS NULL",
    )
    .bind(community.as_uuid())
    .bind(job_id)
    .bind(ask_event)
    .bind(Utc::now().timestamp())
    .execute(pool)
    .await?;

    Ok(result.rows_affected() > 0)
}

/// Give back an escalation slot whose ask never got filed.
///
/// [`record_escalation`] is claimed before the ask is published, so two relay
/// instances sweeping the same job produce one ask rather than two. The cost
/// of that ordering is that a filing failure would otherwise make the job
/// permanently un-escalatable, so the failure path hands the slot back.
pub async fn clear_escalation(pool: &PgPool, community: CommunityId, job_id: &[u8]) -> Result<()> {
    sqlx::query(
        "UPDATE jobs SET escalated_ask = NULL, updated_at = $3 \
         WHERE community_id = $1 AND job_id = $2",
    )
    .bind(community.as_uuid())
    .bind(job_id)
    .bind(Utc::now().timestamp())
    .execute(pool)
    .await?;

    Ok(())
}

// Every statement here needs a live Postgres to mean anything: what is being
// asserted is that a conditional UPDATE matches no rows under a race, which a
// mock cannot demonstrate. The proofs are in
// `crates/buzz-test-client/tests/e2e_jobs.rs`, against a real relay.
