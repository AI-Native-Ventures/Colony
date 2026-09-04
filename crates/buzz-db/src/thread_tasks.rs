//! The claim that makes one thread hold one open task.
//!
//! Task heads are relay-authored NIP-33 events. Replaceable events have no row
//! a uniqueness constraint can protect, so "does this thread already have an
//! open task" cannot be answered by the event store: two clients preparing the
//! same send would each read "no open task" and each ask for one. The claim
//! here is the decision. The winning `INSERT` owns the slot, and the loser
//! reads the winner's task id back out rather than writing a second task.

use sqlx::{PgPool, Postgres, Transaction};

use crate::{CommunityId, Result};

/// Which of a thread's two slots a claim addresses.
///
/// `Work` is the thread's visible task. `Chat` carries the cost of turns that
/// were not work, so a greeting still charges somewhere without putting a
/// greeting on the Tasks page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadSlot {
    /// The thread's visible work task.
    Work,
    /// The thread's hidden task for turns that were not work.
    Chat,
}

impl ThreadSlot {
    /// The exact stable string this slot is stored as.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Work => "work",
            Self::Chat => "chat",
        }
    }
}

/// Everything that identifies one thread's slot.
#[derive(Debug, Clone, Copy)]
pub struct ThreadSlotKey<'a> {
    /// Channel the thread lives in.
    pub channel_id: &'a str,
    /// Thread root, send id, or conversation marker. See the migration.
    pub thread_key: &'a str,
    /// Member the task belongs to. A second member in one thread opens their
    /// own task so their turns settle against their own team.
    pub owner_pubkey: &'a str,
    /// Which slot is being claimed.
    pub slot: ThreadSlot,
}

/// The outcome of asking a thread which task its next turn belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ThreadClaim {
    /// This caller won the slot; the task named still has to be written.
    Opened {
        /// Task id the slot now points at.
        task_id: String,
    },
    /// The slot was already held; this caller attaches to what it names.
    Attached {
        /// Task id the slot already pointed at.
        task_id: String,
    },
}

impl ThreadClaim {
    /// The task id either outcome names.
    pub fn task_id(&self) -> &str {
        match self {
            Self::Opened { task_id } | Self::Attached { task_id } => task_id,
        }
    }

    /// Whether this caller is the one that must write the task head.
    pub fn opened(&self) -> bool {
        matches!(self, Self::Opened { .. })
    }
}

/// Claim a thread's slot, or read back whoever already holds it.
///
/// `force_new` is the composer's explicit "start a second task" switch: the
/// slot is repointed at the proposed task, so later sends in the thread attach
/// to the new one, while the task it replaced stays open until it closes on
/// its own terms. Without it the first writer wins and every later caller
/// attaches, which is exactly the invariant two racing clients need.
pub async fn claim_thread_task(
    pool: &PgPool,
    community: CommunityId,
    key: ThreadSlotKey<'_>,
    proposed_task_id: &str,
    force_new: bool,
) -> Result<ThreadClaim> {
    let mut tx = pool.begin().await?;
    let claim = claim_thread_task_tx(&mut tx, community, key, proposed_task_id, force_new).await?;
    tx.commit().await?;
    Ok(claim)
}

/// Claim a thread's slot inside a caller-owned transaction.
pub async fn claim_thread_task_tx(
    tx: &mut Transaction<'_, Postgres>,
    community: CommunityId,
    key: ThreadSlotKey<'_>,
    proposed_task_id: &str,
    force_new: bool,
) -> Result<ThreadClaim> {
    let owner = key.owner_pubkey.to_ascii_lowercase();
    if force_new {
        sqlx::query(
            r#"
            INSERT INTO thread_open_tasks
                (community_id, channel_id, thread_key, owner_pubkey, slot, task_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (community_id, channel_id, thread_key, owner_pubkey, slot)
            DO UPDATE SET task_id = EXCLUDED.task_id, updated_at = now()
            "#,
        )
        .bind(community.as_uuid())
        .bind(key.channel_id)
        .bind(key.thread_key)
        .bind(&owner)
        .bind(key.slot.as_str())
        .bind(proposed_task_id)
        .execute(&mut **tx)
        .await?;
        return Ok(ThreadClaim::Opened {
            task_id: proposed_task_id.to_owned(),
        });
    }

    let won: Option<String> = sqlx::query_scalar(
        r#"
        INSERT INTO thread_open_tasks
            (community_id, channel_id, thread_key, owner_pubkey, slot, task_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT DO NOTHING
        RETURNING task_id
        "#,
    )
    .bind(community.as_uuid())
    .bind(key.channel_id)
    .bind(key.thread_key)
    .bind(&owner)
    .bind(key.slot.as_str())
    .bind(proposed_task_id)
    .fetch_optional(&mut **tx)
    .await?;

    if let Some(task_id) = won {
        return Ok(ThreadClaim::Opened { task_id });
    }

    let held: Option<String> = sqlx::query_scalar(
        r#"
        SELECT task_id FROM thread_open_tasks
        WHERE community_id = $1 AND channel_id = $2 AND thread_key = $3
          AND owner_pubkey = $4 AND slot = $5
        "#,
    )
    .bind(community.as_uuid())
    .bind(key.channel_id)
    .bind(key.thread_key)
    .bind(&owner)
    .bind(key.slot.as_str())
    .fetch_optional(&mut **tx)
    .await?;

    match held {
        Some(task_id) => Ok(ThreadClaim::Attached { task_id }),
        // The row vanished between the insert losing and this read, which
        // means it was released by a close in that instant. Treat the caller
        // as the opener: the slot is free again and this is the next task.
        None => Ok(ThreadClaim::Opened {
            task_id: proposed_task_id.to_owned(),
        }),
    }
}

/// Read a thread slot without claiming it.
pub async fn read_thread_task(
    pool: &PgPool,
    community: CommunityId,
    key: ThreadSlotKey<'_>,
) -> Result<Option<String>> {
    Ok(sqlx::query_scalar(
        r#"
        SELECT task_id FROM thread_open_tasks
        WHERE community_id = $1 AND channel_id = $2 AND thread_key = $3
          AND owner_pubkey = $4 AND slot = $5
        "#,
    )
    .bind(community.as_uuid())
    .bind(key.channel_id)
    .bind(key.thread_key)
    .bind(key.owner_pubkey.to_ascii_lowercase())
    .bind(key.slot.as_str())
    .fetch_optional(pool)
    .await?)
}

/// Free every slot pointing at a task that has closed.
///
/// The next work-implying message in that thread then opens a new task rather
/// than reopening a finished one. There is deliberately no timer anywhere near
/// this: a thread nobody has written in for a week is a thread waiting, not a
/// task finished.
pub async fn release_thread_task(
    pool: &PgPool,
    community: CommunityId,
    task_id: &str,
) -> Result<u64> {
    let result =
        sqlx::query("DELETE FROM thread_open_tasks WHERE community_id = $1 AND task_id = $2")
            .bind(community.as_uuid())
            .bind(task_id)
            .execute(pool)
            .await?;
    Ok(result.rows_affected())
}

/// Move a claim made before its thread had a root onto the real root.
///
/// A send that starts a thread is claimed under its own send id, because the
/// root event does not exist until the message is published. Once it is, every
/// reply names that event as the thread root, so the claim has to move or the
/// first reply would look like a brand-new thread and open a second task.
pub async fn rebind_thread_task(
    pool: &PgPool,
    community: CommunityId,
    task_id: &str,
    new_thread_key: &str,
) -> Result<bool> {
    // `DO NOTHING` on conflict: if the real root already holds a claim, that
    // claim is the live one and this pending row is stale.
    let mut tx = pool.begin().await?;
    let moved: Option<String> = sqlx::query_scalar(
        r#"
        INSERT INTO thread_open_tasks
            (community_id, channel_id, thread_key, owner_pubkey, slot, task_id)
        SELECT community_id, channel_id, $3, owner_pubkey, slot, task_id
        FROM thread_open_tasks
        WHERE community_id = $1 AND task_id = $2 AND thread_key LIKE 'send:%'
        ON CONFLICT DO NOTHING
        RETURNING task_id
        "#,
    )
    .bind(community.as_uuid())
    .bind(task_id)
    .bind(new_thread_key)
    .fetch_optional(&mut *tx)
    .await?;

    sqlx::query(
        "DELETE FROM thread_open_tasks \
         WHERE community_id = $1 AND task_id = $2 AND thread_key LIKE 'send:%'",
    )
    .bind(community.as_uuid())
    .bind(task_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(moved.is_some())
}

/// Record one sub-task under its parent, refusing past the cap.
///
/// Counted and inserted in one transaction, so two agents opening the twentieth
/// and twenty-first sub-task at the same moment cannot both pass the check.
pub async fn record_thread_subtask(
    pool: &PgPool,
    community: CommunityId,
    parent_task_id: &str,
    task_id: &str,
    cap: usize,
) -> Result<bool> {
    let mut tx = pool.begin().await?;
    let existing: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM thread_subtasks \
         WHERE community_id = $1 AND parent_task_id = $2 \
         FOR UPDATE",
    )
    .bind(community.as_uuid())
    .bind(parent_task_id)
    .fetch_one(&mut *tx)
    .await?;
    if existing as usize >= cap {
        tx.rollback().await?;
        return Ok(false);
    }
    sqlx::query(
        "INSERT INTO thread_subtasks (community_id, parent_task_id, task_id) \
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    )
    .bind(community.as_uuid())
    .bind(parent_task_id)
    .bind(task_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(true)
}

/// Every sub-task a parent holds, for the cascade its closing performs.
pub async fn thread_subtask_ids(
    pool: &PgPool,
    community: CommunityId,
    parent_task_id: &str,
) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar(
        "SELECT task_id FROM thread_subtasks \
         WHERE community_id = $1 AND parent_task_id = $2 ORDER BY created_at, task_id",
    )
    .bind(community.as_uuid())
    .bind(parent_task_id)
    .fetch_all(pool)
    .await?)
}
