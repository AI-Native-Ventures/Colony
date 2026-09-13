//! Company employees: workspace-owned agent identities.
//!
//! One row per employee the workspace employs. The row carries the employee's
//! sealed secret key, which is what lets any member's machine produce work as
//! one colleague without that key ever being copied to a laptop
//! (`docs/design/company-employees.html`).
//!
//! Two guarantees live in the schema rather than in calling code:
//!
//! - **One employee per hire request** (`employees_hire_event_uniq`). Hiring
//!   runs as a best-effort side effect that may execute more than once for the
//!   same request, so a repeat is a no-op rather than a second identity for
//!   one role.
//! - **One active employee per role** (`employees_active_role_uniq`). A
//!   workspace employs one Chief of Staff, not one per member who asked. The
//!   index is partial on `status = 'active'`, so a role can be refilled after
//!   its holder retires.
//!
//! The sealed key is opaque here: sealing and opening live in the relay
//! (`crates/buzz-relay/src/employee_key.rs`), so this layer never handles
//! plaintext key material.

use chrono::Utc;
use sqlx::{PgPool, Row as _};

use crate::error::Result;
use crate::CommunityId;

/// A row from the `employees` table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmployeeRow {
    /// The employee's identity pubkey (32 raw bytes).
    pub pubkey: Vec<u8>,
    /// `nonce || ciphertext` of the employee's secret key. Opaque here.
    pub sealed_key: Vec<u8>,
    /// Stable role slug this employee fills, unique among active employees.
    pub role_id: String,
    /// The name this employee goes by.
    pub display_name: String,
    /// One of `worker`, `leader`, `executive`.
    pub rank: String,
    /// The community owner who hired this employee. `None` on a provisioned
    /// employee, which no owner hired.
    pub hired_by: Option<Vec<u8>>,
    /// The owner-signed hire request this employee answers, so authority can
    /// be re-derived from events without trusting this table. `None` on a
    /// provisioned employee, whose authority comes from the relay binary
    /// rather than from any event.
    pub hire_event: Option<Vec<u8>>,
    /// The agent this employee reports to (32 raw bytes), one rung up the
    /// interrupt ladder. `None` means no manager: the root marker for
    /// executives and the Unassigned-tray state for everyone else. Read by
    /// the relay's `agent_manager` before any event is consulted, so kind
    /// 9046 updates this column and the 30190 head together.
    pub manager: Option<Vec<u8>>,
    /// The bundled entry this row was seeded from, or `None` for a user's own
    /// employee. Seeding is idempotent on this handle, and every refusal path
    /// keys on it to know the row is not a user's to change.
    pub provisioned_handle: Option<String>,
    /// The bundled version that last wrote this row. Always `Some` exactly
    /// when `provisioned_handle` is.
    pub provisioned_version: Option<i32>,
    /// `active` or `retired`.
    pub status: String,
    /// Unix seconds when the employee was hired.
    pub created_at: i64,
    /// Unix seconds of the last change to this row.
    pub updated_at: i64,
}

/// Borrowed input for [`insert_employee`], so the insert does not take ten
/// positional arguments.
#[derive(Debug, Clone, Copy)]
pub struct NewEmployee<'a> {
    /// The employee's identity pubkey (32 raw bytes).
    pub pubkey: &'a [u8],
    /// `nonce || ciphertext` of the employee's secret key.
    pub sealed_key: &'a [u8],
    /// Stable role slug this employee fills.
    pub role_id: &'a str,
    /// The name this employee goes by.
    pub display_name: &'a str,
    /// One of `worker`, `leader`, `executive`.
    pub rank: &'a str,
    /// The community owner who hired this employee.
    pub hired_by: &'a [u8],
    /// The owner-signed hire request being answered.
    pub hire_event: &'a [u8],
    /// The agent this employee reports to (32 raw bytes), or `None` when the
    /// new hire starts with no manager.
    pub manager: Option<&'a [u8]>,
}

fn row_to_employee(row: sqlx::postgres::PgRow) -> Result<EmployeeRow> {
    Ok(EmployeeRow {
        pubkey: row.try_get("pubkey")?,
        sealed_key: row.try_get("sealed_key")?,
        role_id: row.try_get("role_id")?,
        display_name: row.try_get("display_name")?,
        rank: row.try_get("rank")?,
        hired_by: row.try_get("hired_by")?,
        hire_event: row.try_get("hire_event")?,
        manager: row.try_get("manager")?,
        provisioned_handle: row.try_get("provisioned_handle")?,
        provisioned_version: row.try_get("provisioned_version")?,
        status: row.try_get("status")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

/// Every column a row-producing `employees` query returns, in the order
/// [`row_to_employee`] reads them. One constant so a new column cannot be
/// added to some SELECTs and not others -- the exact drift a second copy of
/// this list per query would invite.
const EMPLOYEE_COLUMNS: &str =
    "pubkey, sealed_key, role_id, display_name, rank, hired_by, hire_event, manager, \
     provisioned_handle, provisioned_version, status, created_at, updated_at";

/// Record a newly hired employee.
///
/// Returns `Ok(None)` when this hire request already produced an employee or
/// the role is already filled, so a re-run of the hiring side effect settles
/// instead of erroring or minting a duplicate. `ON CONFLICT DO NOTHING`
/// covers both unique indexes.
pub async fn insert_employee(
    pool: &PgPool,
    community: CommunityId,
    employee: NewEmployee<'_>,
) -> Result<Option<EmployeeRow>> {
    let now = Utc::now().timestamp();
    let row = sqlx::query(
        "INSERT INTO employees (community_id, pubkey, sealed_key, role_id, display_name, \
                                rank, hired_by, hire_event, manager, status, created_at, updated_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$10) \
         ON CONFLICT DO NOTHING \
         RETURNING pubkey, sealed_key, role_id, display_name, rank, hired_by, hire_event, manager, \
                   provisioned_handle, provisioned_version, status, created_at, updated_at",
    )
    .bind(community.as_uuid())
    .bind(employee.pubkey)
    .bind(employee.sealed_key)
    .bind(employee.role_id)
    .bind(employee.display_name)
    .bind(employee.rank)
    .bind(employee.hired_by)
    .bind(employee.hire_event)
    .bind(employee.manager)
    .bind(now)
    .fetch_optional(pool)
    .await?;

    row.map(row_to_employee).transpose()
}

/// The employee this hire request already produced, if any. Lets the hiring
/// side effect recognise its own prior run.
pub async fn find_employee_by_hire_event(
    pool: &PgPool,
    community: CommunityId,
    hire_event: &[u8],
) -> Result<Option<EmployeeRow>> {
    // EMPLOYEE_COLUMNS is a compile-time constant; nothing user-supplied is
    // interpolated, so the composed string is safe to assert.
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {EMPLOYEE_COLUMNS} FROM employees \
         WHERE community_id = $1 AND hire_event = $2"
    )))
    .bind(community.as_uuid())
    .bind(hire_event)
    .fetch_optional(pool)
    .await?;

    row.map(row_to_employee).transpose()
}

/// Look an employee up by identity. Used at ingest to decide whether a pubkey
/// claiming to be an employee actually is one.
pub async fn find_employee(
    pool: &PgPool,
    community: CommunityId,
    pubkey: &[u8],
) -> Result<Option<EmployeeRow>> {
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {EMPLOYEE_COLUMNS} FROM employees WHERE community_id = $1 AND pubkey = $2"
    )))
    .bind(community.as_uuid())
    .bind(pubkey)
    .fetch_optional(pool)
    .await?;

    row.map(row_to_employee).transpose()
}

/// The one employee currently filling `role_id`, if any.
///
/// Scoped to `status = 'active'` because that is what the role means: the
/// `employees_active_role_uniq` index admits exactly one active row per
/// `(community, role_id)` and deliberately excludes retired rows so a role
/// can be refilled. Reading retired rows here would make a role resolve to
/// whoever last held it, which is a different question from who holds it now
/// -- and the caller (`interrupt_gate::agent_tier`) uses this to decide the
/// authority of a *different* pubkey than the employee's own, so answering
/// with a vacated role would hand out rank nobody currently carries.
///
/// `role_id` is compared as stored: `employee_broker` lowercases and trims it
/// off the owner-signed hire request before insert, so callers reading a role
/// from anywhere else must normalize the same way first.
pub async fn find_active_employee_by_role(
    pool: &PgPool,
    community: CommunityId,
    role_id: &str,
) -> Result<Option<EmployeeRow>> {
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {EMPLOYEE_COLUMNS} \
         FROM employees WHERE community_id = $1 AND role_id = $2 AND status = 'active'"
    )))
    .bind(community.as_uuid())
    .bind(role_id)
    .fetch_optional(pool)
    .await?;

    row.map(row_to_employee).transpose()
}

/// Every active employee filling `role_id`, lowest pubkey first.
///
/// [`find_active_employee_by_role`] answers the same question for the cases
/// that only need one row. This variant exists because role resolution has to
/// stay deterministic when more than one row somehow holds a role: callers
/// take the first entry and log the collision, so the same pass always picks
/// the same colleague instead of whatever the planner returns first.
/// `employees_active_role_uniq` should make a second row impossible; this is
/// the read-side guard against a state the schema says cannot exist.
pub async fn list_active_employees_by_role(
    pool: &PgPool,
    community: CommunityId,
    role_id: &str,
) -> Result<Vec<EmployeeRow>> {
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {EMPLOYEE_COLUMNS} \
         FROM employees WHERE community_id = $1 AND role_id = $2 AND status = 'active' \
         ORDER BY pubkey"
    )))
    .bind(community.as_uuid())
    .bind(role_id)
    .fetch_all(pool)
    .await?;

    rows.into_iter().map(row_to_employee).collect()
}

/// Every active employee of a community, oldest first.
pub async fn list_active_employees(
    pool: &PgPool,
    community: CommunityId,
) -> Result<Vec<EmployeeRow>> {
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {EMPLOYEE_COLUMNS} FROM employees \
         WHERE community_id = $1 AND status = 'active' \
         ORDER BY created_at, pubkey"
    )))
    .bind(community.as_uuid())
    .fetch_all(pool)
    .await?;

    rows.into_iter().map(row_to_employee).collect()
}

/// Apply an owner-validated change to an employee's rank, manager, or
/// employment status, returning the updated row.
///
/// Each field is `None` to leave it untouched; `manager` distinguishes
/// "leave" from "clear" with a nested option (`Some(None)` clears). This is
/// the write side of the reporting-line contract: the relay's interrupt gate
/// reads `rank` and `manager` from THIS row before it looks at any event, so
/// kind 9046 applies its change here first and republishes the 30190 head
/// after -- the reverse order would briefly show clients a new head the gate
/// does not yet believe.
pub async fn update_employee(
    pool: &PgPool,
    community: CommunityId,
    pubkey: &[u8],
    rank: Option<&str>,
    manager: Option<Option<&[u8]>>,
    status: Option<&str>,
) -> Result<Option<EmployeeRow>> {
    let now = Utc::now().timestamp();
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE employees SET \
            rank = COALESCE($3, rank), \
            manager = COALESCE($4, manager), \
            status = COALESCE($5, status), \
            updated_at = $6 \
         WHERE community_id = $1 AND pubkey = $2 AND status <> 'retired' \
         RETURNING {EMPLOYEE_COLUMNS}"
    )))
    .bind(community.as_uuid())
    .bind(pubkey)
    .bind(rank)
    .bind(manager)
    .bind(status)
    .bind(now)
    .fetch_optional(pool)
    .await?;

    row.map(row_to_employee).transpose()
}

/// Retire an employee, freeing its role slug for a future hire. Returns
/// whether a row changed, so a repeat retire is distinguishable from a hit.
pub async fn retire_employee(pool: &PgPool, community: CommunityId, pubkey: &[u8]) -> Result<bool> {
    let result = sqlx::query(
        "UPDATE employees SET status = 'retired', updated_at = $3 \
         WHERE community_id = $1 AND pubkey = $2 AND status = 'active'",
    )
    .bind(community.as_uuid())
    .bind(pubkey)
    .bind(Utc::now().timestamp())
    .execute(pool)
    .await?;

    Ok(result.rows_affected() > 0)
}

// ── provisioned employees ──────────────────────────────────────────────────

/// Borrowed input for [`insert_provisioned_employee`].
///
/// Deliberately separate from [`NewEmployee`] rather than a variant of it.
/// An ordinary hire cannot exist without the owner-signed request that
/// authorises it, so that path keeps both hire columns mandatory; a seeded
/// employee has no request at all, and its authority is the relay binary.
/// One struct with four optional fields would let either path write the
/// other's shape.
#[derive(Debug, Clone, Copy)]
pub struct NewProvisionedEmployee<'a> {
    /// The employee's identity pubkey (32 raw bytes).
    pub pubkey: &'a [u8],
    /// `nonce || ciphertext` of the employee's secret key.
    pub sealed_key: &'a [u8],
    /// Stable role slug this employee fills.
    pub role_id: &'a str,
    /// The name this employee goes by.
    pub display_name: &'a str,
    /// One of `worker`, `leader`, `executive`.
    pub rank: &'a str,
    /// The agent this employee reports to (32 raw bytes), written to the same
    /// `manager` column an ordinary hire uses. `None` means top of the chart.
    pub manager: Option<&'a [u8]>,
    /// The bundled entry being seeded.
    pub provisioned_handle: &'a str,
    /// The bundled version doing the seeding.
    pub provisioned_version: i32,
}

/// Seed one provisioned employee.
///
/// Returns `Ok(None)` when the row was not written, which is the ordinary
/// outcome rather than a fault: the handle is already seeded for this
/// community, or a concurrent pass won the same race. Callers resolve a role
/// already held by a workspace employee through
/// [`adopt_provisioned_employee`] before reaching this insert, so a user's
/// employee is never displaced by a seed. `ON CONFLICT DO NOTHING` covers both
/// the provisioned-handle index and the active-role index.
pub async fn insert_provisioned_employee(
    pool: &PgPool,
    community: CommunityId,
    employee: NewProvisionedEmployee<'_>,
) -> Result<Option<EmployeeRow>> {
    let now = Utc::now().timestamp();
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "INSERT INTO employees (community_id, pubkey, sealed_key, role_id, display_name, \
                                rank, manager, provisioned_handle, provisioned_version, status, \
                                created_at, updated_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$10) \
         ON CONFLICT DO NOTHING \
         RETURNING {EMPLOYEE_COLUMNS}"
    )))
    .bind(community.as_uuid())
    .bind(employee.pubkey)
    .bind(employee.sealed_key)
    .bind(employee.role_id)
    .bind(employee.display_name)
    .bind(employee.rank)
    .bind(employee.manager)
    .bind(employee.provisioned_handle)
    .bind(employee.provisioned_version)
    .bind(now)
    .fetch_optional(pool)
    .await?;

    row.map(row_to_employee).transpose()
}

/// The employee seeded from `handle` in this community, if any.
///
/// Reads retired rows too, unlike [`find_active_employee_by_role`]. A
/// provisioned employee cannot be retired through any user path, but reading
/// only active rows would let a row that somehow reached `retired` be seeded
/// a second time under a second identity.
pub async fn find_provisioned_employee(
    pool: &PgPool,
    community: CommunityId,
    handle: &str,
) -> Result<Option<EmployeeRow>> {
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {EMPLOYEE_COLUMNS} FROM employees \
         WHERE community_id = $1 AND provisioned_handle = $2"
    )))
    .bind(community.as_uuid())
    .bind(handle)
    .fetch_optional(pool)
    .await?;

    row.map(row_to_employee).transpose()
}

/// Apply a newer bundled version to an already-seeded employee: its display
/// name, role, rank, manager and version, never its identity.
///
/// The key is deliberately untouched. A bumped version is the same colleague
/// with an updated brief, so rewriting its pubkey would orphan every message
/// it has ever sent and every job it has ever done.
///
/// `manager` is the resolved reporting line, or `None` to leave whatever the
/// row already holds. The leave-when-absent shape is deliberate: a bundle
/// that names no manager owns no manager edge, so a reporting line the
/// workspace set before the row was provisioned survives every later version.
#[allow(clippy::too_many_arguments)]
pub async fn update_provisioned_employee(
    pool: &PgPool,
    community: CommunityId,
    handle: &str,
    display_name: &str,
    role_id: &str,
    rank: &str,
    manager: Option<&[u8]>,
    version: i32,
) -> Result<Option<EmployeeRow>> {
    let now = Utc::now().timestamp();
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE employees SET \
            display_name = $3, \
            role_id = $4, \
            rank = $5, \
            manager = COALESCE($6, manager), \
            provisioned_version = $7, \
            status = 'active', \
            updated_at = $8 \
         WHERE community_id = $1 AND provisioned_handle = $2 \
         RETURNING {EMPLOYEE_COLUMNS}"
    )))
    .bind(community.as_uuid())
    .bind(handle)
    .bind(display_name)
    .bind(role_id)
    .bind(rank)
    .bind(manager)
    .bind(version)
    .bind(now)
    .fetch_optional(pool)
    .await?;

    row.map(row_to_employee).transpose()
}

/// Adopt a workspace employee into a bundled entry: the same identity, now
/// carrying the handle and version, with the bundle's display name, role and
/// rank applied.
///
/// Adoption is how a role already filled by the workspace's own employee
/// becomes a provisioned employee. The pubkey never changes, so every message,
/// thread and delegation the employee already owns survives; what changes is
/// provenance and config, not identity. Stamping `provisioned_handle` is what
/// makes the ordinary delete/edit guards apply from the next call onward, so
/// the workspace cannot keep a half-adopted row.
///
/// `manager` is the resolved reporting line, or `None` to leave the row's
/// existing manager alone (see [`update_provisioned_employee`]).
///
/// Returns `Ok(None)` when the row did not move: it no longer exists, it was
/// already provisioned under this or another handle, or `pubkey` names no
/// active row. The caller settles on that rather than minting a second
/// identity for the role.
#[allow(clippy::too_many_arguments)]
pub async fn adopt_provisioned_employee(
    pool: &PgPool,
    community: CommunityId,
    pubkey: &[u8],
    provisioned_handle: &str,
    provisioned_version: i32,
    display_name: &str,
    role_id: &str,
    rank: &str,
    manager: Option<&[u8]>,
) -> Result<Option<EmployeeRow>> {
    let now = Utc::now().timestamp();
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE employees SET \
            provisioned_handle = $3, \
            provisioned_version = $4, \
            display_name = $5, \
            role_id = $6, \
            rank = $7, \
            manager = COALESCE($8, manager), \
            status = 'active', \
            updated_at = $9 \
         WHERE community_id = $1 AND pubkey = $2 AND provisioned_handle IS NULL \
         RETURNING {EMPLOYEE_COLUMNS}"
    )))
    .bind(community.as_uuid())
    .bind(pubkey)
    .bind(provisioned_handle)
    .bind(provisioned_version)
    .bind(display_name)
    .bind(role_id)
    .bind(rank)
    .bind(manager)
    .bind(now)
    .fetch_optional(pool)
    .await?;

    row.map(row_to_employee).transpose()
}
