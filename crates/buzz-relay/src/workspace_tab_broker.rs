//! Relay-owned broker for channel workspace-tab ownership transitions.
//!
//! The `workspace_tabs` row is the authority. A client-signed action is
//! allowed to change it only after the broker has checked the actor against
//! that row, and the row transition, relay-signed head, and relay-signed
//! receipt are committed by one database transaction.

use std::sync::Arc;

use buzz_core::kind::{
    event_kind_i32, KIND_WORKSPACE_TAB_ACTION, KIND_WORKSPACE_TAB_HEAD, KIND_WORKSPACE_TAB_RECEIPT,
};
use buzz_core::tenant::TenantContext;
use buzz_core::workspace_tab::{parse_tab_action, WorkspaceTabAction, WorkspaceTabOp};
use buzz_core::{CommunityId, StoredEvent};
use buzz_db::workspace_tabs::WorkspaceTabRow;
use chrono::{DateTime, Utc};
use nostr::{Event, EventBuilder, Keys, Kind, Tag, Timestamp};
use serde_json::json;
use sqlx::{postgres::PgRow, Postgres, Row as _, Transaction};
use uuid::Uuid;

use crate::handlers::event::dispatch_persistent_event;
use crate::state::AppState;

const TAB_UNAVAILABLE: &str = "workspace tab unavailable";
const TAB_REVISION_CONFLICT: &str = "workspace tab revision conflict";
const TAB_NOT_SUPPORTED: &str = "workspace tab operation not yet supported";
const RECEIPT_SCHEMA: &str = "colony.workspace-tab-receipt/v1";

/// The durable result of an applied workspace-tab action.
#[derive(Debug, Clone)]
pub enum TabActionOutcome {
    /// The canonical row, head, and receipt committed successfully.
    Applied {
        /// The canonical row after the transition committed.
        tab: WorkspaceTabRow,
        /// The relay-signed head projection that was committed.
        head: StoredEvent,
        /// The relay-signed receipt that was committed.
        receipt: StoredEvent,
    },
}

/// Whether an event belongs to the workspace-tab action broker.
pub fn is_workspace_tab_action_candidate(event: &Event) -> bool {
    event.kind.as_u16() as u32 == KIND_WORKSPACE_TAB_ACTION
}

/// Apply a validated workspace-tab action against canonical relay state.
///
/// The parsed action is deliberately accepted separately from the signed event
/// because the state transition only needs its validated coordinates and actor.
/// Ingest can use [`handle_workspace_tab_action`] when it also needs the action
/// event itself persisted and referenced by the receipt.
pub async fn apply_tab_action(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    action: &WorkspaceTabAction,
) -> Result<TabActionOutcome, String> {
    apply_tab_action_inner(state, tenant, action, None).await
}

/// Parse and apply one signed workspace-tab action event.
pub async fn handle_workspace_tab_action(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    action_event: &Event,
) -> Result<TabActionOutcome, String> {
    let action = parse_tab_action(action_event).map_err(|error| error.to_string())?;
    apply_tab_action_inner(state, tenant, &action, Some(action_event)).await
}

async fn apply_tab_action_inner(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    action: &WorkspaceTabAction,
    action_event: Option<&Event>,
) -> Result<TabActionOutcome, String> {
    // Stage 1 deliberately keeps the vocabulary closed. Returning this before
    // looking up the row also keeps the deferred operation's error distinct
    // from the authorization refusal without creating a tab-existence oracle.
    if matches!(
        action.op,
        WorkspaceTabOp::Grant { .. } | WorkspaceTabOp::Release
    ) {
        return Err(TAB_NOT_SUPPORTED.to_owned());
    }

    let mut tx = state
        .db
        .begin_transaction()
        .await
        .map_err(|error| format!("workspace tab transaction failed: {error}"))?;

    let row = match &action.op {
        WorkspaceTabOp::Open { tab_kind, title } => {
            let now = Utc::now().timestamp();
            let inserted = sqlx::query(
                "INSERT INTO workspace_tabs \
                    (community_id, channel_id, tab_id, tab_kind, title, creator, owner, driver, \
                     revision, head_at, created_at, updated_at) \
                 VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 1, $7, $7, $7) \
                 ON CONFLICT DO NOTHING \
                 RETURNING channel_id, tab_id, tab_kind, title, creator, owner, driver, \
                           revision, head_at, created_at, updated_at",
            )
            .bind(tenant.community().as_uuid())
            .bind(action.channel_id)
            .bind(&action.tab_id)
            .bind(tab_kind)
            .bind(title)
            .bind(action.actor.to_bytes().as_slice())
            .bind(now)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|error| format!("workspace tab transaction failed: {error}"))?;

            // A duplicate open is intentionally indistinguishable from an
            // unauthorized take: neither path names or confirms the row.
            inserted
                .map(tab_row)
                .transpose()
                .map_err(|error| format!("workspace tab transaction failed: {error}"))?
                .ok_or_else(|| TAB_UNAVAILABLE.to_owned())?
        }
        WorkspaceTabOp::Take => {
            let current = sqlx::query(
                "SELECT channel_id, tab_id, tab_kind, title, creator, owner, driver, \
                        revision, head_at, created_at, updated_at \
                 FROM workspace_tabs \
                 WHERE community_id = $1 AND channel_id = $2 AND tab_id = $3 \
                 FOR UPDATE",
            )
            .bind(tenant.community().as_uuid())
            .bind(action.channel_id)
            .bind(&action.tab_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|error| format!("workspace tab transaction failed: {error}"))?;

            let current = current
                .map(tab_row)
                .transpose()
                .map_err(|error| format!("workspace tab transaction failed: {error}"))?
                .ok_or_else(|| TAB_UNAVAILABLE.to_owned())?;

            // Do this check before looking at the expected revision. A caller
            // who does not own the tab receives the same refusal whether its
            // revision was current, stale, or omitted.
            if current.owner.as_slice() != action.actor.to_bytes().as_slice() {
                return Err(TAB_UNAVAILABLE.to_owned());
            }

            let expected_revision = action
                .expected_revision
                .ok_or_else(|| TAB_REVISION_CONFLICT.to_owned())?;
            let now = Utc::now().timestamp();
            let updated = sqlx::query(
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
            .bind(tenant.community().as_uuid())
            .bind(action.channel_id)
            .bind(&action.tab_id)
            .bind(expected_revision)
            .bind(action.actor.to_bytes().as_slice())
            .bind(now)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|error| format!("workspace tab transaction failed: {error}"))?;

            // `None` is the CAS loser. It is a conflict, never a successful
            // no-op and never an authorization failure.
            updated
                .map(tab_row)
                .transpose()
                .map_err(|error| format!("workspace tab transaction failed: {error}"))?
                .ok_or_else(|| TAB_REVISION_CONFLICT.to_owned())?
        }
        WorkspaceTabOp::Grant { .. } | WorkspaceTabOp::Release => {
            // The early return above makes this unreachable, but keeping the
            // match exhaustive protects this code if Stage 2 changes the gate.
            return Err(TAB_NOT_SUPPORTED.to_owned());
        }
    };

    let head = build_head(&state.relay_keypair, &row)?;
    let receipt = build_receipt(
        &state.relay_keypair,
        action,
        &head,
        row.revision,
        action_event,
    )?;

    let stored_action = match action_event {
        Some(event) => Some(
            insert_event_tx(&mut tx, tenant.community(), event, Some(action.channel_id)).await?,
        ),
        None => None,
    };
    let stored_head = replace_head_tx(
        &mut tx,
        tenant.community(),
        &head,
        &head_d_tag(&row),
        action.channel_id,
    )
    .await?;
    let stored_receipt = insert_event_tx(
        &mut tx,
        tenant.community(),
        &receipt,
        Some(action.channel_id),
    )
    .await?;

    tx.commit()
        .await
        .map_err(|error| format!("workspace tab transaction failed: {error}"))?;

    let relay_pubkey = state.relay_keypair.public_key().to_hex();
    if let Some(stored_action) = &stored_action {
        dispatch_persistent_event(
            tenant,
            state,
            stored_action,
            KIND_WORKSPACE_TAB_ACTION,
            &action.actor.to_hex(),
            None,
        )
        .await;
    }
    dispatch_persistent_event(
        tenant,
        state,
        &stored_head,
        KIND_WORKSPACE_TAB_HEAD,
        &relay_pubkey,
        None,
    )
    .await;
    dispatch_persistent_event(
        tenant,
        state,
        &stored_receipt,
        KIND_WORKSPACE_TAB_RECEIPT,
        &relay_pubkey,
        None,
    )
    .await;

    Ok(TabActionOutcome::Applied {
        tab: row,
        head: stored_head,
        receipt: stored_receipt,
    })
}

fn tab_row(row: PgRow) -> Result<WorkspaceTabRow, sqlx::Error> {
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

fn scalar_tag(name: &str, value: &str) -> Result<Tag, String> {
    Tag::parse([name, value]).map_err(|error| format!("failed to build `{name}` tag: {error}"))
}

fn head_d_tag(row: &WorkspaceTabRow) -> String {
    format!("{}:{}", row.channel_id, row.tab_id)
}

fn build_head(relay: &Keys, row: &WorkspaceTabRow) -> Result<Event, String> {
    let channel = row.channel_id.to_string();
    let d_tag = head_d_tag(row);
    let tags = vec![
        scalar_tag("d", &d_tag)?,
        scalar_tag("h", &channel)?,
        scalar_tag("tab", &row.tab_id)?,
    ];
    let content = serde_json::to_string(&json!({
        "tab_kind": row.tab_kind,
        "title": row.title,
        "creator": hex::encode(&row.creator),
        "owner": hex::encode(&row.owner),
        "driver": hex::encode(&row.driver),
        "revision": row.revision,
    }))
    .map_err(|error| format!("failed to serialize workspace tab head: {error}"))?;
    EventBuilder::new(Kind::Custom(KIND_WORKSPACE_TAB_HEAD as u16), content)
        .tags(tags)
        // The row's strictly increasing head_at is the NIP-33 ordering stamp.
        .custom_created_at(Timestamp::from(row.head_at.max(0) as u64))
        .sign_with_keys(relay)
        .map_err(|error| format!("failed to sign workspace tab head: {error}"))
}

fn operation_name(op: &WorkspaceTabOp) -> &'static str {
    match op {
        WorkspaceTabOp::Open { .. } => "open",
        WorkspaceTabOp::Take => "take",
        WorkspaceTabOp::Grant { .. } => "grant",
        WorkspaceTabOp::Release => "release",
    }
}

fn build_receipt(
    relay: &Keys,
    action: &WorkspaceTabAction,
    head: &Event,
    revision: i64,
    action_event: Option<&Event>,
) -> Result<Event, String> {
    let channel = action.channel_id.to_string();
    let mut tags = vec![
        scalar_tag("h", &channel)?,
        scalar_tag("tab", &action.tab_id)?,
        scalar_tag("p", &action.actor.to_hex())?,
    ];
    if let Some(action_event) = action_event {
        tags.push(
            Tag::parse(["e", &action_event.id.to_hex(), "", "workspace-tab-action"])
                .map_err(|error| format!("failed to build receipt `e` tag: {error}"))?,
        );
    }
    let content = serde_json::to_string(&json!({
        "schema": RECEIPT_SCHEMA,
        "op": operation_name(&action.op),
        "outcome": "applied",
        "revision": revision,
        "headEventId": head.id.to_hex(),
    }))
    .map_err(|error| format!("failed to serialize workspace tab receipt: {error}"))?;
    EventBuilder::new(Kind::Custom(KIND_WORKSPACE_TAB_RECEIPT as u16), content)
        .tags(tags)
        .sign_with_keys(relay)
        .map_err(|error| format!("failed to sign workspace tab receipt: {error}"))
}

async fn insert_event_tx(
    tx: &mut Transaction<'static, Postgres>,
    community: CommunityId,
    event: &Event,
    channel_id: Option<Uuid>,
) -> Result<StoredEvent, String> {
    let created_at_secs = event.created_at.as_secs() as i64;
    let created_at = DateTime::from_timestamp(created_at_secs, 0)
        .ok_or_else(|| format!("invalid workspace event timestamp: {created_at_secs}"))?;
    let received_at = Utc::now();
    let tags = serde_json::to_value(&event.tags)
        .map_err(|error| format!("failed to serialize workspace event tags: {error}"))?;
    let d_tag = (event.kind.as_u16() as u32 == KIND_WORKSPACE_TAB_HEAD).then(|| {
        event
            .tags
            .iter()
            .find_map(|tag| {
                let parts = tag.as_slice();
                (parts.len() >= 2 && parts[0] == "d").then(|| parts[1].clone())
            })
            .unwrap_or_default()
    });
    let result = sqlx::query(
        "INSERT INTO events \
            (community_id, id, pubkey, created_at, kind, tags, content, sig, received_at, channel_id, d_tag, not_before) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL)",
    )
    .bind(community.as_uuid())
    .bind(event.id.as_bytes().as_slice())
    .bind(event.pubkey.to_bytes().as_slice())
    .bind(created_at)
    .bind(event_kind_i32(event))
    .bind(tags)
    .bind(&event.content)
    .bind(event.sig.serialize().as_slice())
    .bind(received_at)
    .bind(channel_id)
    .bind(d_tag)
    .execute(&mut **tx)
    .await
    .map_err(|error| format!("failed to persist workspace event: {error}"))?;
    if result.rows_affected() != 1 {
        return Err("workspace event was already stored".to_owned());
    }
    Ok(StoredEvent::with_received_at(
        event.clone(),
        received_at,
        channel_id,
        true,
    ))
}

async fn replace_head_tx(
    tx: &mut Transaction<'static, Postgres>,
    community: CommunityId,
    head: &Event,
    d_tag: &str,
    channel_id: Uuid,
) -> Result<StoredEvent, String> {
    let lock_key = replacement_lock_key(
        community,
        KIND_WORKSPACE_TAB_HEAD as i32,
        head.pubkey.to_bytes().as_slice(),
        d_tag.as_bytes(),
    );
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(lock_key)
        .execute(&mut **tx)
        .await
        .map_err(|error| format!("failed to lock workspace tab head: {error}"))?;

    let existing: Option<(DateTime<Utc>, Vec<u8>)> = sqlx::query_as(
        "SELECT created_at, id FROM events \
         WHERE community_id = $1 AND kind = $2 AND pubkey = $3 AND d_tag = $4 \
           AND deleted_at IS NULL \
         ORDER BY created_at DESC, id ASC LIMIT 1",
    )
    .bind(community.as_uuid())
    .bind(KIND_WORKSPACE_TAB_HEAD as i32)
    .bind(head.pubkey.to_bytes().as_slice())
    .bind(d_tag)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|error| format!("failed to read workspace tab head: {error}"))?;
    let incoming_at = DateTime::from_timestamp(head.created_at.as_secs() as i64, 0)
        .ok_or_else(|| "invalid workspace tab head timestamp".to_owned())?;
    if existing.as_ref().is_some_and(|(created_at, id)| {
        incoming_at < *created_at
            || (incoming_at == *created_at && head.id.as_bytes().as_slice() >= id.as_slice())
    }) {
        return Err("workspace tab head ordering conflict".to_owned());
    }
    if let Some((_, id)) = existing {
        sqlx::query(
            "UPDATE events SET deleted_at = NOW() \
             WHERE community_id = $1 AND kind = $2 AND pubkey = $3 AND d_tag = $4 \
               AND id = $5 AND deleted_at IS NULL",
        )
        .bind(community.as_uuid())
        .bind(KIND_WORKSPACE_TAB_HEAD as i32)
        .bind(head.pubkey.to_bytes().as_slice())
        .bind(d_tag)
        .bind(id)
        .execute(&mut **tx)
        .await
        .map_err(|error| format!("failed to retire workspace tab head: {error}"))?;
    }
    insert_event_tx(tx, community, head, Some(channel_id)).await
}

fn replacement_lock_key(community: CommunityId, kind: i32, pubkey: &[u8], d_tag: &[u8]) -> i64 {
    // Keep this byte-for-byte aligned with buzz-db's replacement lock key so
    // generic NIP-33 writes and this relay-owned projection serialize alike.
    let mut hash: u64 = 0xcbf29ce484222325;
    for bytes in [
        community.as_uuid().as_bytes().as_slice(),
        kind.to_le_bytes().as_slice(),
        pubkey,
        d_tag,
    ] {
        for byte in bytes {
            hash ^= *byte as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    hash as i64
}
