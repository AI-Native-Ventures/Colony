//! Relay-owned state for channel workspace tabs.
//!
//! The `workspace_tabs` row is the authority for tab ownership and the active
//! driver. In particular, driver transitions use a revision compare-and-swap:
//! a caller that read a stale row matches no rows and receives `Ok(None)`.

use sqlx::{PgPool, Row as _};
use uuid::Uuid;

use crate::error::Result;
use crate::CommunityId;

/// A row from the `workspace_tabs` table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceTabRow {
    /// The channel containing the tab.
    pub channel_id: Uuid,
    /// The client-chosen tab coordinate, unique within the channel.
    pub tab_id: String,
    /// The opaque registry kind for this tab.
    pub tab_kind: String,
    /// The human-readable tab title.
    pub title: String,
    /// The identity that first opened the tab.
    pub creator: Vec<u8>,
    /// The identity that owns the tab.
    pub owner: Vec<u8>,
    /// The identity currently driving the tab.
    pub driver: Vec<u8>,
    /// The compare-and-swap revision of this row.
    pub revision: i64,
    /// Strictly increasing timestamp for the projected head.
    pub head_at: i64,
    /// Unix timestamp when the row was opened.
    pub created_at: i64,
    /// Unix timestamp when the row last changed.
    pub updated_at: i64,
}

/// The fields a new tab needs.
///
/// A struct rather than eight positional arguments, because
/// `open_tab(pool, community, channel, id, kind, title, creator, now)` has two
/// adjacent `&str` pairs and two adjacent byte slices that a caller can
/// silently transpose.
pub struct NewWorkspaceTab<'a> {
    /// Client-chosen tab coordinate, unique within the channel.
    pub tab_id: &'a str,
    /// Opaque registry kind for the tab body.
    pub tab_kind: &'a str,
    /// Human-readable title shown in the tab strip.
    pub title: &'a str,
    /// Identity that opens and initially owns and drives the tab.
    pub creator: &'a [u8],
}

fn row_to_tab(row: sqlx::postgres::PgRow) -> Result<WorkspaceTabRow> {
    Ok(WorkspaceTabRow {
        channel_id: row.try_get("channel_id")?,
        tab_id: row.try_get("tab_id")?,
        tab_kind: row.try_get("tab_kind")?,
        title: row.try_get("title")?,
        creator: row.try_get("creator")?,
        owner: row.try_get("owner")?,
        driver: row.try_get("driver")?,
        revision: row.try_get("revision")?,
        head_at: row.try_get("head_at")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

/// Open a tab at a channel coordinate.
///
/// The first caller to open `(community, channel, tab_id)` creates the row
/// with itself as creator, owner, and driver. A later caller gets `Ok(None)`;
/// an existing row is never reset or overwritten.
pub async fn open_tab(
    pool: &PgPool,
    community: CommunityId,
    channel: Uuid,
    tab: NewWorkspaceTab<'_>,
    now: i64,
) -> Result<Option<WorkspaceTabRow>> {
    let row = sqlx::query(
        "INSERT INTO workspace_tabs \
            (community_id, channel_id, tab_id, tab_kind, title, creator, owner, driver, \
             revision, head_at, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 1, $7, $7, $7) \
         ON CONFLICT DO NOTHING \
         RETURNING channel_id, tab_id, tab_kind, title, creator, owner, driver, \
                   revision, head_at, created_at, updated_at",
    )
    .bind(community.as_uuid())
    .bind(channel)
    .bind(tab.tab_id)
    .bind(tab.tab_kind)
    .bind(tab.title)
    .bind(tab.creator)
    .bind(now)
    .fetch_optional(pool)
    .await?;

    row.map(row_to_tab).transpose()
}

/// Read a tab by its channel coordinate.
pub async fn get_tab(
    pool: &PgPool,
    community: CommunityId,
    channel: Uuid,
    tab_id: &str,
) -> Result<Option<WorkspaceTabRow>> {
    let row = sqlx::query(
        "SELECT channel_id, tab_id, tab_kind, title, creator, owner, driver, \
                revision, head_at, created_at, updated_at \
         FROM workspace_tabs \
         WHERE community_id = $1 AND channel_id = $2 AND tab_id = $3",
    )
    .bind(community.as_uuid())
    .bind(channel)
    .bind(tab_id)
    .fetch_optional(pool)
    .await?;

    row.map(row_to_tab).transpose()
}

/// Move the driver seat if the caller still holds the current revision.
///
/// The `WHERE` clause is the arbitration: it matches only when the row is
/// still at `expected_revision`. Two racing transitions therefore produce one
/// updated row and one `Ok(None)`, which is how the losing caller learns that
/// it lost the seat. Authorization belongs to the relay broker, not this
/// database primitive.
///
/// `head_at` is stamped strictly greater than its current value rather than
/// trusting the wall clock. NIP-33 orders revisions by `created_at` at
/// one-second resolution, while two transitions in the same second are
/// ordinary here.
pub async fn set_driver(
    pool: &PgPool,
    community: CommunityId,
    channel: Uuid,
    tab_id: &str,
    expected_revision: i64,
    new_driver: &[u8],
    now: i64,
) -> Result<Option<WorkspaceTabRow>> {
    let row = sqlx::query(
        "UPDATE workspace_tabs \
            SET driver = $5, \
                revision = revision + 1, \
                head_at = GREATEST($6, head_at + 1), \
                updated_at = $6 \
          WHERE community_id = $1 AND channel_id = $2 AND tab_id = $3 \
            AND revision = $4 \
      RETURNING channel_id, tab_id, tab_kind, title, creator, owner, driver, \
                revision, head_at, created_at, updated_at",
    )
    .bind(community.as_uuid())
    .bind(channel)
    .bind(tab_id)
    .bind(expected_revision)
    .bind(new_driver)
    .bind(now)
    .fetch_optional(pool)
    .await?;

    row.map(row_to_tab).transpose()
}
