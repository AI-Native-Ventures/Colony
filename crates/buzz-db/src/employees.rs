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
    /// The community owner who hired this employee.
    pub hired_by: Vec<u8>,
    /// The owner-signed hire request this employee answers, so authority can
    /// be re-derived from events without trusting this table.
    pub hire_event: Vec<u8>,
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
        status: row.try_get("status")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

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
                                rank, hired_by, hire_event, status, created_at, updated_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$9) \
         ON CONFLICT DO NOTHING \
         RETURNING pubkey, sealed_key, role_id, display_name, rank, hired_by, hire_event, status, created_at, updated_at",
    )
    .bind(community.as_uuid())
    .bind(employee.pubkey)
    .bind(employee.sealed_key)
    .bind(employee.role_id)
    .bind(employee.display_name)
    .bind(employee.rank)
    .bind(employee.hired_by)
    .bind(employee.hire_event)
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
    let row = sqlx::query(
        "SELECT pubkey, sealed_key, role_id, display_name, rank, hired_by, hire_event, status, created_at, updated_at FROM employees \
         WHERE community_id = $1 AND hire_event = $2",
    )
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
    let row = sqlx::query(
        "SELECT pubkey, sealed_key, role_id, display_name, rank, hired_by, hire_event, status, created_at, updated_at FROM employees WHERE community_id = $1 AND pubkey = $2",
    )
    .bind(community.as_uuid())
    .bind(pubkey)
    .fetch_optional(pool)
    .await?;

    row.map(row_to_employee).transpose()
}

/// Every active employee of a community, oldest first.
pub async fn list_active_employees(
    pool: &PgPool,
    community: CommunityId,
) -> Result<Vec<EmployeeRow>> {
    let rows = sqlx::query(
        "SELECT pubkey, sealed_key, role_id, display_name, rank, hired_by, hire_event, status, created_at, updated_at FROM employees \
         WHERE community_id = $1 AND status = 'active' \
         ORDER BY created_at, pubkey",
    )
    .bind(community.as_uuid())
    .fetch_all(pool)
    .await?;

    rows.into_iter().map(row_to_employee).collect()
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
