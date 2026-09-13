#![deny(unsafe_code)]
#![warn(missing_docs)]
//! buzz-db — Postgres event store for Buzz.
//!
//! ## Design invariants
//! - AUTH events (kind 22242) are never stored — they carry bearer tokens.
//! - Ephemeral events (20000–29999) are never stored — Redis pub/sub only.
//! - Events table is partitioned by month on `created_at`.
//! - No FK references to partitioned tables.
//! - Uses `sqlx::query()` (runtime) not `sqlx::query!()` (compile-time).
//!
//! ## Runtime and store ownership
//! Database runtime infrastructure and domain persistence are physically
//! separated behind this crate-root compatibility facade:
//!
//! - Runtime concerns own pool construction, writer/replica routing,
//!   transactions, sessions, metrics, health support, and migrations.
//! - Store concerns own domain-specific SQL, row mapping, locking, mutation
//!   rules, indexes, and focused persistence tests.
//!
//! Existing crate-root modules, records, and [`Db`] methods remain the public
//! API. The internal `runtime` and `store` namespaces are not public APIs.
//!
//! Colony-only projections whose operations have no upstream counterpart keep
//! their [`Db`] methods here rather than in a store module, so the shared
//! surface stays byte-comparable with upstream.

mod runtime;
mod store;

/// Database error types.
pub mod error;

pub use runtime::{
    insert_mentions, insert_mentions_tx, migration, replica_fence, Db, DbConfig, DbPoolStats,
    ReadSession,
};
pub(crate) use runtime::{
    insert_mentions_in_transaction, observability, route_proof, ReadSessionInner, RouteDecision,
    RoutePredicate,
};

pub use store::{
    admin_moderation, allowlist, api_token, archived_identities, asks, channel, channel_members,
    community, credits, deletion, discovery, discovery_workspace, dm, email_accounts, employees,
    event, feed, gateway, git_repo, jobs, moderation, operator_analytics, partition,
    payment_intents, product_feedback, push, reaction, relay_invite, relay_members, reminder,
    replaceable, thread, thread_tasks, usage, user, workflow, workspace_tabs,
};

pub use allowlist::AllowlistEntry;
pub use api_token::{ApiTokenRecord, TokenSummary};
pub use community::{
    ArchivedCommunityRecord, CommunityRecord, CreateCommunityWithOwnerResult,
    CreatedCommunityRecord, EnsuredCommunityRecord, OwnedCommunityRecord,
    UnarchivedCommunityRecord,
};
pub use error::{DbError, Result};
pub use event::{
    BlockActionInsert, BlockCatalogActionApply, CompanyActionApply, CompanyActionClaim, EventQuery,
    LedgerActionApply, LedgerActionClaim, PartyActionApply, PartyActionClaim,
    ReactionEventInsertOutcome, ReplaceOutcome, DEFAULT_MAX_PAGE_LIMIT,
};
pub use reminder::DueReminder;
pub use usage::UsageMetricsLeader;

use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::replaceable::{ParameterizedReplacePrecondition, ParameterizedReplaceStatus};
use buzz_core::{CommunityId, StoredEvent};

/// Community row returned by member-scoped community discovery.
///
/// Unlike [`OwnedCommunityRecord`] this covers every community the requester
/// holds any `relay_members` row in, so the requester's own role is carried
/// alongside the community's owner rather than being implied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberCommunityRecord {
    /// Stable server-resolved community id.
    pub id: CommunityId,
    /// Normalized host that maps to this community.
    pub host: String,
    /// When the community row was created.
    pub created_at: DateTime<Utc>,
    /// The requester's role in this community (`owner`, `admin`, `member`).
    pub role: String,
    /// The community's owner, if one is recorded.
    pub owner_pubkey: Option<String>,
}

impl Db {
    /// Borrow the writer pool for callers that need raw SQL access (e.g.
    /// `buzz-admin` credits commands).
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Return every active community for relay-owned startup reconciliation.
    ///
    /// This is an operator/runtime-plane read. Tenant data paths must continue
    /// to use a server-resolved [`CommunityId`] rather than selecting their own
    /// community from this list.
    pub async fn list_active_communities(&self) -> Result<Vec<CommunityRecord>> {
        let rows = sqlx::query(
            r#"
            SELECT id, host
            FROM communities
            WHERE archived_at IS NULL
            ORDER BY created_at ASC, host ASC
            "#,
        )
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|row| {
                Ok(CommunityRecord {
                    id: CommunityId::from_uuid(row.try_get("id")?),
                    host: row.try_get("host")?,
                })
            })
            .collect()
    }

    /// Lists every non-archived community where `member_pubkey` holds any
    /// `relay_members` row, with that member's role and the community owner.
    ///
    /// The member-scoped counterpart of [`list_communities_owned_by`]: it is
    /// keyed only on the requester's own pubkey, so it is safe to expose to
    /// that requester, but it still crosses community boundaries and must
    /// never be called on behalf of a different key.
    pub async fn list_communities_for_member(
        &self,
        member_pubkey: &str,
    ) -> Result<Vec<MemberCommunityRecord>> {
        let member_pubkey = member_pubkey.to_ascii_lowercase();
        let rows = sqlx::query(
            r#"
            SELECT
                c.id,
                c.host,
                c.created_at,
                rm.role,
                (
                    SELECT owner.pubkey
                    FROM relay_members owner
                    WHERE owner.community_id = c.id
                      AND owner.role = 'owner'
                    ORDER BY owner.created_at ASC, owner.pubkey ASC
                    LIMIT 1
                ) AS owner_pubkey
            FROM communities c
            JOIN relay_members rm ON rm.community_id = c.id
            WHERE rm.pubkey = $1
              AND c.archived_at IS NULL
            ORDER BY c.created_at ASC, c.host ASC
            "#,
        )
        .bind(member_pubkey)
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|row| {
                let id: Uuid = row.try_get("id")?;
                let host: String = row.try_get("host")?;
                let created_at: DateTime<Utc> = row.try_get("created_at")?;
                let role: String = row.try_get("role")?;
                let owner_pubkey: Option<String> = row.try_get("owner_pubkey")?;
                Ok(MemberCommunityRecord {
                    id: CommunityId::from_uuid(id),
                    host,
                    created_at,
                    role,
                    owner_pubkey,
                })
            })
            .collect()
    }

    /// One newest owner-authored NIP-33 head per `d` tag for `kind`,
    /// community scoped, global events only, non-deleted.
    ///
    /// See [`event::query_latest_owner_authored_heads`] for the SQL and why
    /// it is safe against a non-owner's newer head shadowing the owner's.
    /// `limit` bounds distinct `d` tags (agents), not revisions.
    pub async fn query_latest_owner_authored_heads(
        &self,
        community_id: CommunityId,
        kind: i32,
        limit: i64,
    ) -> Result<Vec<StoredEvent>> {
        event::query_latest_owner_authored_heads(&self.pool, community_id, kind, limit).await
    }

    /// Returns the `created_at` of the most recent non-deleted event authored
    /// by `pubkey` anywhere in the community -- any kind, channel or global.
    pub async fn get_last_authored_event_at(
        &self,
        community_id: CommunityId,
        pubkey: &[u8],
    ) -> Result<Option<DateTime<Utc>>> {
        event::get_last_authored_event_at(&self.pool, community_id, pubkey).await
    }

    /// Atomically claim and persist a channel-scoped Block action.
    ///
    /// A duplicate result means another signed action already won the
    /// community-local `(instance_event_id, idempotency_key)` claim. Callers
    /// must not fan out or execute duplicate actions.
    pub async fn insert_block_action_once(
        &self,
        community: CommunityId,
        event: &nostr::Event,
        channel_id: Uuid,
        instance_event_id: &[u8],
        idempotency_key: Uuid,
    ) -> Result<BlockActionInsert> {
        let outcome = event::insert_block_action_once(
            &self.pool,
            community,
            event,
            channel_id,
            instance_event_id,
            idempotency_key,
        )
        .await?;

        if let BlockActionInsert::Inserted(_) = &outcome {
            if let Err(e) = insert_mentions(&self.pool, community, event, Some(channel_id)).await {
                tracing::warn!(event_id = %event.id, "Failed to insert mentions: {e}");
            }
        }

        Ok(outcome)
    }

    /// Atomically apply one relay-brokered global Block catalog action.
    ///
    /// The community-local claim, global action event, winning NIP-33 catalog
    /// head, and global receipt commit together. A stale or duplicate proposed
    /// head rolls the entire batch back. Losing the idempotency claim returns
    /// the original action ID without inserting or replacing any event.
    #[allow(clippy::too_many_arguments)]
    pub async fn apply_block_catalog_action_once(
        &self,
        community: CommunityId,
        action_event: &nostr::Event,
        head_event: &nostr::Event,
        head_d_tag: &str,
        receipt_event: &nostr::Event,
        idempotency_key: Uuid,
    ) -> Result<BlockCatalogActionApply> {
        let expected_kinds = [
            (
                action_event,
                buzz_core::kind::KIND_BLOCK_ACTION,
                "catalog action",
            ),
            (
                head_event,
                buzz_core::kind::KIND_BLOCK_CATALOG_ENTRY,
                "catalog head",
            ),
            (
                receipt_event,
                buzz_core::kind::KIND_BLOCK_RECEIPT,
                "catalog receipt",
            ),
        ];
        for (event, expected_kind, label) in expected_kinds {
            if event.kind.as_u16() as u32 != expected_kind {
                return Err(DbError::InvalidData(format!(
                    "{label} has kind {}, expected {expected_kind}",
                    event.kind.as_u16()
                )));
            }
        }
        if head_d_tag.len() > event::D_TAG_MAX_LEN {
            return Err(DbError::InvalidData(format!(
                "catalog head d tag exceeds {} bytes",
                event::D_TAG_MAX_LEN
            )));
        }
        let head_d_tags = head_event
            .tags
            .iter()
            .filter_map(|tag| {
                let parts = tag.as_slice();
                (parts.first().is_some_and(|part| part == "d")).then_some(parts)
            })
            .collect::<Vec<_>>();
        if head_d_tags.len() != 1 || head_d_tags[0].len() != 2 || head_d_tags[0][1] != head_d_tag {
            return Err(DbError::InvalidData(
                "catalog head must contain exactly one matching d tag".to_owned(),
            ));
        }

        let mut tx = self.pool.begin().await?;
        let claimed_action_id: Option<Vec<u8>> = sqlx::query_scalar(
            r#"
            INSERT INTO block_catalog_action_claims
                (community_id, idempotency_key, action_event_id, head_event_id, receipt_event_id)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT DO NOTHING
            RETURNING action_event_id
            "#,
        )
        .bind(community.as_uuid())
        .bind(idempotency_key)
        .bind(action_event.id.as_bytes().as_slice())
        .bind(head_event.id.as_bytes().as_slice())
        .bind(receipt_event.id.as_bytes().as_slice())
        .fetch_optional(&mut *tx)
        .await?;

        if claimed_action_id.is_none() {
            let original_action_event_id: Option<Vec<u8>> = sqlx::query_scalar(
                r#"
                SELECT action_event_id
                FROM block_catalog_action_claims
                WHERE community_id = $1 AND idempotency_key = $2
                "#,
            )
            .bind(community.as_uuid())
            .bind(idempotency_key)
            .fetch_optional(&mut *tx)
            .await?;
            tx.rollback().await?;
            return original_action_event_id
                .map(
                    |original_action_event_id| BlockCatalogActionApply::Duplicate {
                        original_action_event_id,
                    },
                )
                .ok_or_else(|| {
                    DbError::InvalidData(
                        "catalog action claim conflict had no durable winning row".to_owned(),
                    )
                });
        }

        let (action, action_inserted) = event::insert_event_with_thread_metadata_tx(
            &mut tx,
            community,
            action_event,
            None,
            None,
        )
        .await?;
        if !action_inserted {
            tx.rollback().await?;
            return Err(DbError::InvalidData(
                "catalog action event was already stored".to_owned(),
            ));
        }

        let head_result = replaceable::replace_parameterized_event_in_transaction_impl(
            &mut tx,
            community,
            head_event,
            head_d_tag,
            None,
            ParameterizedReplacePrecondition::Unconditional,
        )
        .await?;
        if !matches!(head_result.status, ParameterizedReplaceStatus::Inserted) {
            tx.rollback().await?;
            return Err(DbError::InvalidData(
                "catalog head lost NIP-33 replacement ordering".to_owned(),
            ));
        }

        let (receipt, receipt_inserted) = event::insert_event_with_thread_metadata_tx(
            &mut tx,
            community,
            receipt_event,
            None,
            None,
        )
        .await?;
        if !receipt_inserted {
            tx.rollback().await?;
            return Err(DbError::InvalidData(
                "catalog receipt event was already stored".to_owned(),
            ));
        }

        tx.commit().await?;
        Ok(BlockCatalogActionApply::Applied {
            action,
            head: head_result.event,
            receipt,
        })
    }

    /// Atomically apply one owner-authorized Colony Company Action.
    ///
    /// Company, Initiative, and Task heads are relay-authored, so the only
    /// authority check that matters is whether the *action's* author is the
    /// community's current human owner — and that must hold at commit time,
    /// not at request time. The owner rows are therefore locked `FOR UPDATE`
    /// inside this transaction, the same lock `transfer_ownership` takes, so an
    /// action queued before a transfer is rejected after the transfer lands
    /// instead of committing against stale authority.
    ///
    /// `expected_head_event_id` is the compare-and-set token: `None` asserts
    /// the head does not yet exist (a create), `Some(id)` asserts it is exactly
    /// that event (a replacement). A mismatch rolls back with
    /// [`CompanyActionApply::StaleHead`] and stores nothing.
    ///
    /// Look up a previously applied Company Action by its idempotency key.
    ///
    /// A retry of a legitimate request has to be answerable before the
    /// create-vs-replace contract is checked. Otherwise the second attempt at
    /// an approval that already succeeded is refused as "that record already
    /// exists", which is precisely the case derived idempotency keys exist to
    /// make safe.
    pub async fn find_company_action_claim(
        &self,
        community: CommunityId,
        idempotency_key: Uuid,
    ) -> Result<Option<CompanyActionClaim>> {
        type ClaimRow = (Vec<u8>, Option<Vec<u8>>, Vec<u8>);
        let row: Option<ClaimRow> = sqlx::query_as(
            r#"
            SELECT action_event_id, head_event_id, receipt_event_id
            FROM company_action_claims
            WHERE community_id = $1 AND idempotency_key = $2
            "#,
        )
        .bind(community.as_uuid())
        .bind(idempotency_key)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(
            |(action_event_id, head_event_id, receipt_event_id)| CompanyActionClaim {
                action_event_id,
                head_event_id,
                receipt_event_id,
            },
        ))
    }

    /// The idempotency claim, action, head, and receipt commit as one batch.
    /// Replaying an action ID returns the original result without writing.
    #[allow(clippy::too_many_arguments)]
    pub async fn apply_company_action_once(
        &self,
        community: CommunityId,
        action_event: &nostr::Event,
        head_event: &nostr::Event,
        head_d_tag: &str,
        receipt_event: &nostr::Event,
        idempotency_key: Uuid,
        actor_pubkey_hex: &str,
        expected_head_event_id: Option<&[u8]>,
    ) -> Result<CompanyActionApply> {
        let expected_kinds = [
            (
                action_event,
                buzz_core::kind::KIND_COMPANY_ACTION,
                "company action",
            ),
            (
                receipt_event,
                buzz_core::kind::KIND_COMPANY_RECEIPT,
                "company receipt",
            ),
        ];
        for (event, expected_kind, label) in expected_kinds {
            if event.kind.as_u16() as u32 != expected_kind {
                return Err(DbError::InvalidData(format!(
                    "{label} has kind {}, expected {expected_kind}",
                    event.kind.as_u16()
                )));
            }
        }
        let head_kind = head_event.kind.as_u16() as u32;
        if !matches!(
            head_kind,
            buzz_core::kind::KIND_COMPANY_PROFILE
                | buzz_core::kind::KIND_INITIATIVE
                | buzz_core::kind::KIND_TASK
        ) {
            return Err(DbError::InvalidData(format!(
                "company head has kind {head_kind}, expected a Company, Initiative, or Task head"
            )));
        }
        if head_d_tag.len() > event::D_TAG_MAX_LEN {
            return Err(DbError::InvalidData(format!(
                "company head d tag exceeds {} bytes",
                event::D_TAG_MAX_LEN
            )));
        }
        let head_d_tags = head_event
            .tags
            .iter()
            .filter_map(|tag| {
                let parts = tag.as_slice();
                (parts.first().is_some_and(|part| part == "d")).then_some(parts)
            })
            .collect::<Vec<_>>();
        if head_d_tags.len() != 1 || head_d_tags[0].len() != 2 || head_d_tags[0][1] != head_d_tag {
            return Err(DbError::InvalidData(
                "company head must contain exactly one matching d tag".to_owned(),
            ));
        }

        let mut tx = self.pool.begin().await?;

        // Authority first, and under a lock: `transfer_ownership` takes this
        // exact `FOR UPDATE` on the owner rows, so the two serialize.
        let owners: Vec<String> = sqlx::query_scalar(
            "SELECT pubkey FROM relay_members \
             WHERE community_id = $1 AND role = 'owner' \
             FOR UPDATE",
        )
        .bind(community.as_uuid())
        .fetch_all(&mut *tx)
        .await?;
        let actor = actor_pubkey_hex.to_ascii_lowercase();
        if !owners.iter().any(|owner| owner == &actor) {
            tx.rollback().await?;
            return Ok(CompanyActionApply::NotOwner);
        }

        // An owner row alone is not enough: nothing structurally stops an agent
        // pubkey occupying one (the operator transfer endpoint has no human
        // check). Company state carries commercial and accounting authority, so
        // the transaction enforces humanity itself rather than relying on the
        // caller's pre-check still being there.
        let actor_is_agent: Option<bool> = sqlx::query_scalar(
            "SELECT agent_owner_pubkey IS NOT NULL FROM users \
             WHERE community_id = $1 AND pubkey = $2",
        )
        .bind(community.as_uuid())
        .bind(hex::decode(&actor).unwrap_or_default())
        .fetch_optional(&mut *tx)
        .await?;
        if actor_is_agent.unwrap_or(true) {
            tx.rollback().await?;
            return Ok(CompanyActionApply::NotOwner);
        }

        let claimed_action_id: Option<Vec<u8>> = sqlx::query_scalar(
            r#"
            INSERT INTO company_action_claims
                (community_id, idempotency_key, action_event_id, head_event_id, receipt_event_id)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT DO NOTHING
            RETURNING action_event_id
            "#,
        )
        .bind(community.as_uuid())
        .bind(idempotency_key)
        .bind(action_event.id.as_bytes().as_slice())
        .bind(head_event.id.as_bytes().as_slice())
        .bind(receipt_event.id.as_bytes().as_slice())
        .fetch_optional(&mut *tx)
        .await?;

        if claimed_action_id.is_none() {
            let original_action_event_id: Option<Vec<u8>> = sqlx::query_scalar(
                r#"
                SELECT action_event_id
                FROM company_action_claims
                WHERE community_id = $1 AND idempotency_key = $2
                "#,
            )
            .bind(community.as_uuid())
            .bind(idempotency_key)
            .fetch_optional(&mut *tx)
            .await?;
            tx.rollback().await?;
            return original_action_event_id
                .map(|original_action_event_id| CompanyActionApply::Duplicate {
                    original_action_event_id,
                })
                .ok_or_else(|| {
                    DbError::InvalidData(
                        "company action claim conflict had no durable winning row".to_owned(),
                    )
                });
        }

        // Compare-and-set against the head actually stored right now. Read with
        // the same ordering `replace_parameterized_event_tx` uses so the row we
        // check is the row that would be superseded.
        let current_head_event_id: Option<Vec<u8>> = sqlx::query_scalar(
            "SELECT id FROM events \
             WHERE community_id = $1 AND kind = $2 AND pubkey = $3 AND d_tag = $4 \
               AND deleted_at IS NULL \
             ORDER BY created_at DESC, id ASC LIMIT 1",
        )
        .bind(community.as_uuid())
        .bind(head_kind as i32)
        .bind(head_event.pubkey.to_bytes().as_slice())
        .bind(head_d_tag)
        .fetch_optional(&mut *tx)
        .await?;
        if current_head_event_id.as_deref() != expected_head_event_id {
            tx.rollback().await?;
            return Ok(CompanyActionApply::StaleHead {
                current_head_event_id,
            });
        }

        let (action, action_inserted) = event::insert_event_with_thread_metadata_tx(
            &mut tx,
            community,
            action_event,
            None,
            None,
        )
        .await?;
        if !action_inserted {
            // The refuse path stores the action alongside its failure receipt,
            // so a byte-identical retry of a previously refused action lands
            // here. Report it as its own outcome: it is NOT a claim duplicate
            // (the claim above just rolled back) and reporting the submitter's
            // own id as "the winner" would be self-referential nonsense.
            tx.rollback().await?;
            return Ok(CompanyActionApply::ActionAlreadyStored);
        }

        let head_result = replaceable::replace_parameterized_event_in_transaction_impl(
            &mut tx,
            community,
            head_event,
            head_d_tag,
            None,
            ParameterizedReplacePrecondition::Unconditional,
        )
        .await?;
        if !matches!(head_result.status, ParameterizedReplaceStatus::Inserted) {
            tx.rollback().await?;
            return Err(DbError::InvalidData(
                "company head lost NIP-33 replacement ordering".to_owned(),
            ));
        }

        let (receipt, receipt_inserted) = event::insert_event_with_thread_metadata_tx(
            &mut tx,
            community,
            receipt_event,
            None,
            None,
        )
        .await?;
        if !receipt_inserted {
            tx.rollback().await?;
            return Err(DbError::InvalidData(
                "company receipt event was already stored".to_owned(),
            ));
        }

        tx.commit().await?;
        Ok(CompanyActionApply::Applied {
            action,
            head: head_result.event,
            receipt,
        })
    }

    /// Commit one thread attach: its action, its receipt, and the task head
    /// when the request opened a task rather than joining one.
    ///
    /// Authority here is community membership, not ownership. A thread attach
    /// creates nothing a member could have created by hand: the task's id,
    /// title, team, and cost centre are all relay decisions, and the member is
    /// only saying which conversation their next turn belongs to. Refusing
    /// non-owners would mean a second member in a thread could never have
    /// their own work recorded, which is precisely the case that makes cost
    /// land on the wrong team. The narrower checks that DO belong to specific
    /// requests - an agent may only open a sub-task of a task it is assigned
    /// to - are the relay's, made before this commit.
    ///
    /// `head_event` is `None` when the request attached to a task that
    /// already existed; `claim_head_event_id` then names that existing head,
    /// so the idempotency claim still points at the head this request
    /// resolved to and a retry replays to the same answer.
    #[allow(clippy::too_many_arguments)]
    pub async fn apply_thread_attach_once(
        &self,
        community: CommunityId,
        action_event: &nostr::Event,
        head_event: Option<&nostr::Event>,
        head_d_tag: Option<&str>,
        receipt_event: &nostr::Event,
        claim_head_event_id: &[u8],
        idempotency_key: Uuid,
        actor_pubkey_hex: &str,
    ) -> Result<event::ThreadAttachApply> {
        if action_event.kind.as_u16() as u32 != buzz_core::kind::KIND_COMPANY_ACTION {
            return Err(DbError::InvalidData(format!(
                "thread attach action has kind {}, expected {}",
                action_event.kind.as_u16(),
                buzz_core::kind::KIND_COMPANY_ACTION
            )));
        }
        if receipt_event.kind.as_u16() as u32 != buzz_core::kind::KIND_COMPANY_RECEIPT {
            return Err(DbError::InvalidData(format!(
                "thread attach receipt has kind {}, expected {}",
                receipt_event.kind.as_u16(),
                buzz_core::kind::KIND_COMPANY_RECEIPT
            )));
        }
        let head_pair = match (head_event, head_d_tag) {
            (Some(head), Some(d_tag)) => {
                if head.kind.as_u16() as u32 != buzz_core::kind::KIND_TASK {
                    return Err(DbError::InvalidData(format!(
                        "thread attach head has kind {}, expected a Task head",
                        head.kind.as_u16()
                    )));
                }
                if d_tag.len() > event::D_TAG_MAX_LEN {
                    return Err(DbError::InvalidData(format!(
                        "thread attach head d tag exceeds {} bytes",
                        event::D_TAG_MAX_LEN
                    )));
                }
                Some((head, d_tag))
            }
            (None, None) => None,
            _ => {
                return Err(DbError::InvalidData(
                    "a thread attach head needs its d tag, and a d tag needs its head".to_owned(),
                ));
            }
        };

        let mut tx = self.pool.begin().await?;

        // Membership under the same lock ownership transfer takes, so a member
        // removed while this request was in flight cannot still write.
        let member: Option<String> = sqlx::query_scalar(
            "SELECT role FROM relay_members \
             WHERE community_id = $1 AND lower(pubkey) = $2 \
             FOR UPDATE",
        )
        .bind(community.as_uuid())
        .bind(actor_pubkey_hex.to_ascii_lowercase())
        .fetch_optional(&mut *tx)
        .await?;
        if member.is_none() {
            tx.rollback().await?;
            return Ok(event::ThreadAttachApply::NotMember);
        }

        let claimed: Option<Vec<u8>> = sqlx::query_scalar(
            r#"
            INSERT INTO company_action_claims
                (community_id, idempotency_key, action_event_id, head_event_id, receipt_event_id)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT DO NOTHING
            RETURNING action_event_id
            "#,
        )
        .bind(community.as_uuid())
        .bind(idempotency_key)
        .bind(action_event.id.as_bytes().as_slice())
        .bind(claim_head_event_id)
        .bind(receipt_event.id.as_bytes().as_slice())
        .fetch_optional(&mut *tx)
        .await?;

        if claimed.is_none() {
            let original_action_event_id: Option<Vec<u8>> = sqlx::query_scalar(
                "SELECT action_event_id FROM company_action_claims \
                 WHERE community_id = $1 AND idempotency_key = $2",
            )
            .bind(community.as_uuid())
            .bind(idempotency_key)
            .fetch_optional(&mut *tx)
            .await?;
            tx.rollback().await?;
            return original_action_event_id
                .map(
                    |original_action_event_id| event::ThreadAttachApply::Duplicate {
                        original_action_event_id,
                    },
                )
                .ok_or_else(|| {
                    DbError::InvalidData(
                        "thread attach claim conflict had no durable winning row".to_owned(),
                    )
                });
        }

        let (action, action_inserted) = event::insert_event_with_thread_metadata_tx(
            &mut tx,
            community,
            action_event,
            None,
            None,
        )
        .await?;
        if !action_inserted {
            tx.rollback().await?;
            return Ok(event::ThreadAttachApply::ActionAlreadyStored);
        }

        let stored_head = match head_pair {
            Some((head_event, head_d_tag)) => {
                // A task opened by this request must not exist yet. If one
                // does, another writer won the same coordinate and this
                // request has to be answered from what is stored instead.
                let current_head_event_id: Option<Vec<u8>> = sqlx::query_scalar(
                    "SELECT id FROM events \
                     WHERE community_id = $1 AND kind = $2 AND pubkey = $3 AND d_tag = $4 \
                       AND deleted_at IS NULL \
                     ORDER BY created_at DESC, id ASC LIMIT 1",
                )
                .bind(community.as_uuid())
                .bind(buzz_core::kind::KIND_TASK as i32)
                .bind(head_event.pubkey.to_bytes().as_slice())
                .bind(head_d_tag)
                .fetch_optional(&mut *tx)
                .await?;
                if current_head_event_id.is_some() {
                    tx.rollback().await?;
                    return Ok(event::ThreadAttachApply::StaleHead {
                        current_head_event_id,
                    });
                }
                let head_result = replaceable::replace_parameterized_event_in_transaction_impl(
                    &mut tx,
                    community,
                    head_event,
                    head_d_tag,
                    None,
                    ParameterizedReplacePrecondition::Unconditional,
                )
                .await?;
                if !matches!(head_result.status, ParameterizedReplaceStatus::Inserted) {
                    tx.rollback().await?;
                    return Err(DbError::InvalidData(
                        "thread attach head lost NIP-33 replacement ordering".to_owned(),
                    ));
                }
                Some(head_result.event)
            }
            None => None,
        };

        let (receipt, receipt_inserted) = event::insert_event_with_thread_metadata_tx(
            &mut tx,
            community,
            receipt_event,
            None,
            None,
        )
        .await?;
        if !receipt_inserted {
            tx.rollback().await?;
            return Err(DbError::InvalidData(
                "thread attach receipt event was already stored".to_owned(),
            ));
        }

        tx.commit().await?;
        Ok(event::ThreadAttachApply::Applied {
            action,
            head: stored_head,
            receipt,
        })
    }

    /// Claim a thread's slot, or read back whoever already holds it.
    pub async fn claim_thread_task(
        &self,
        community: CommunityId,
        key: thread_tasks::ThreadSlotKey<'_>,
        proposed_task_id: &str,
        force_new: bool,
    ) -> Result<thread_tasks::ThreadClaim> {
        thread_tasks::claim_thread_task(&self.pool, community, key, proposed_task_id, force_new)
            .await
    }

    /// Read a thread slot without claiming it.
    pub async fn read_thread_task(
        &self,
        community: CommunityId,
        key: thread_tasks::ThreadSlotKey<'_>,
    ) -> Result<Option<String>> {
        thread_tasks::read_thread_task(&self.pool, community, key).await
    }

    /// Free every slot pointing at a task that has closed.
    pub async fn release_thread_task(&self, community: CommunityId, task_id: &str) -> Result<u64> {
        thread_tasks::release_thread_task(&self.pool, community, task_id).await
    }

    /// Move a claim made before its thread had a root onto the real root.
    pub async fn rebind_thread_task(
        &self,
        community: CommunityId,
        task_id: &str,
        new_thread_key: &str,
    ) -> Result<bool> {
        thread_tasks::rebind_thread_task(&self.pool, community, task_id, new_thread_key).await
    }

    /// Record one sub-task under its parent, refusing past the cap.
    pub async fn record_thread_subtask(
        &self,
        community: CommunityId,
        parent_task_id: &str,
        task_id: &str,
        cap: usize,
    ) -> Result<bool> {
        thread_tasks::record_thread_subtask(&self.pool, community, parent_task_id, task_id, cap)
            .await
    }

    /// Every sub-task a parent holds, for the cascade its closing performs.
    pub async fn thread_subtask_ids(
        &self,
        community: CommunityId,
        parent_task_id: &str,
    ) -> Result<Vec<String>> {
        thread_tasks::thread_subtask_ids(&self.pool, community, parent_task_id).await
    }

    /// Whether `pubkey_hex` is the community's current human owner.
    ///
    /// A cheap read used to refuse an unauthorized request before it can
    /// consume validation work or leave a stored event behind. It is NOT the
    /// authority check: that runs inside the commit transaction under
    /// `FOR UPDATE`, because only there is it safe against a concurrent
    /// ownership transfer.
    pub async fn is_community_human_owner(
        &self,
        community: CommunityId,
        pubkey_hex: &str,
    ) -> Result<bool> {
        let actor = pubkey_hex.to_ascii_lowercase();
        let is_owner: Option<bool> = sqlx::query_scalar(
            "SELECT true FROM relay_members \
             WHERE community_id = $1 AND lower(pubkey) = $2 AND role = 'owner'",
        )
        .bind(community.as_uuid())
        .bind(&actor)
        .fetch_optional(&self.pool)
        .await?;
        if is_owner != Some(true) {
            return Ok(false);
        }

        // An owner row alone does not prove humanity: nothing structurally
        // stops an agent pubkey occupying one.
        let actor_is_agent: Option<bool> = sqlx::query_scalar(
            "SELECT agent_owner_pubkey IS NOT NULL FROM users \
             WHERE community_id = $1 AND pubkey = $2",
        )
        .bind(community.as_uuid())
        .bind(hex::decode(&actor).unwrap_or_default())
        .fetch_optional(&self.pool)
        .await?;
        Ok(!actor_is_agent.unwrap_or(false))
    }

    /// Find a durable ledger action claim by community-scoped retry key.
    pub async fn find_ledger_action_claim(
        &self,
        community: CommunityId,
        idempotency_key: Uuid,
    ) -> Result<Option<LedgerActionClaim>> {
        type ClaimRow = (Vec<u8>, Vec<u8>, Vec<u8>);
        let row: Option<ClaimRow> = sqlx::query_as(
            r#"
            SELECT action_event_id, head_event_id, receipt_event_id
            FROM ledger_action_claims
            WHERE community_id = $1 AND idempotency_key = $2
            "#,
        )
        .bind(community.as_uuid())
        .bind(idempotency_key)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(
            |(action_event_id, head_event_id, receipt_event_id)| LedgerActionClaim {
                action_event_id,
                head_event_id,
                receipt_event_id,
            },
        ))
    }

    /// Commit one owner-signed ledger action with its book head and receipt.
    ///
    /// Authority is checked inside the transaction under the same `FOR UPDATE`
    /// that ownership transfer takes, so the two serialize rather than race.
    /// The head is compare-and-set against what is stored right now, which is
    /// what stops two concurrent appends from losing one.
    #[allow(clippy::too_many_arguments)]
    pub async fn apply_ledger_action_once(
        &self,
        community: CommunityId,
        action_event: &nostr::Event,
        head_event: &nostr::Event,
        head_d_tag: &str,
        receipt_event: &nostr::Event,
        idempotency_key: Uuid,
        actor_pubkey_hex: &str,
        expected_head_event_id: Option<&[u8]>,
    ) -> Result<LedgerActionApply> {
        for (event, expected_kind, label) in [
            (
                action_event,
                buzz_core::kind::KIND_LEDGER_ACTION,
                "ledger action",
            ),
            (
                receipt_event,
                buzz_core::kind::KIND_LEDGER_RECEIPT,
                "ledger receipt",
            ),
        ] {
            if event.kind.as_u16() as u32 != expected_kind {
                return Err(DbError::InvalidData(format!(
                    "{label} has kind {}, expected {expected_kind}",
                    event.kind.as_u16()
                )));
            }
        }

        let head_kind = head_event.kind.as_u16() as u32;
        if !matches!(
            head_kind,
            buzz_core::kind::KIND_PRICE_BOOK
                | buzz_core::kind::KIND_ATTRIBUTION_RULEBOOK
                | buzz_core::kind::KIND_CORRECTION_BOOK
                | buzz_core::kind::KIND_LEDGER_BUDGET
        ) {
            return Err(DbError::InvalidData(format!(
                "ledger head has kind {head_kind}, expected a ledger book head"
            )));
        }

        let mut tx = self.pool.begin().await?;

        // Authority first, under the same `FOR UPDATE` that ownership transfer
        // takes, so the two serialize instead of racing.
        let owners: Vec<String> = sqlx::query_scalar(
            "SELECT pubkey FROM relay_members \
             WHERE community_id = $1 AND role = 'owner' \
             FOR UPDATE",
        )
        .bind(community.as_uuid())
        .fetch_all(&mut *tx)
        .await?;
        let actor = actor_pubkey_hex.to_ascii_lowercase();
        if !owners.iter().any(|owner| owner == &actor) {
            tx.rollback().await?;
            return Ok(LedgerActionApply::NotOwner);
        }

        // An owner row alone is not enough: nothing structurally stops an agent
        // pubkey occupying one. The ledger decides what the company believes it
        // spent, so an agent must never be able to rewrite its own prices.
        let actor_is_agent: Option<bool> = sqlx::query_scalar(
            "SELECT agent_owner_pubkey IS NOT NULL FROM users \
             WHERE community_id = $1 AND pubkey = $2",
        )
        .bind(community.as_uuid())
        .bind(hex::decode(&actor).unwrap_or_default())
        .fetch_optional(&mut *tx)
        .await?;
        if actor_is_agent.unwrap_or(true) {
            tx.rollback().await?;
            return Ok(LedgerActionApply::NotOwner);
        }

        let claimed: Option<Vec<u8>> = sqlx::query_scalar(
            r#"
            INSERT INTO ledger_action_claims
                (community_id, idempotency_key, action_event_id, head_event_id,
                 receipt_event_id)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT DO NOTHING
            RETURNING action_event_id
            "#,
        )
        .bind(community.as_uuid())
        .bind(idempotency_key)
        .bind(action_event.id.as_bytes().as_slice())
        .bind(head_event.id.as_bytes().as_slice())
        .bind(receipt_event.id.as_bytes().as_slice())
        .fetch_optional(&mut *tx)
        .await?;

        if claimed.is_none() {
            let original: Option<Vec<u8>> = sqlx::query_scalar(
                r#"
                SELECT action_event_id
                FROM ledger_action_claims
                WHERE community_id = $1 AND idempotency_key = $2
                "#,
            )
            .bind(community.as_uuid())
            .bind(idempotency_key)
            .fetch_optional(&mut *tx)
            .await?;
            tx.rollback().await?;
            return original
                .map(|original_action_event_id| LedgerActionApply::Duplicate {
                    original_action_event_id,
                })
                .ok_or_else(|| {
                    DbError::InvalidData(
                        "ledger action claim conflict had no durable winning row".to_owned(),
                    )
                });
        }

        // Compare-and-set against the head stored right now, read with the same
        // ordering the replacement uses so the row checked is the row that
        // would be superseded.
        let current_head_event_id: Option<Vec<u8>> = sqlx::query_scalar(
            "SELECT id FROM events \
             WHERE community_id = $1 AND kind = $2 AND pubkey = $3 AND d_tag = $4 \
               AND deleted_at IS NULL \
             ORDER BY created_at DESC, id ASC LIMIT 1",
        )
        .bind(community.as_uuid())
        .bind(head_kind as i32)
        .bind(head_event.pubkey.to_bytes().as_slice())
        .bind(head_d_tag)
        .fetch_optional(&mut *tx)
        .await?;
        if current_head_event_id.as_deref() != expected_head_event_id {
            tx.rollback().await?;
            return Ok(LedgerActionApply::StaleHead {
                current_head_event_id,
            });
        }

        let (action, action_inserted) = event::insert_event_with_thread_metadata_tx(
            &mut tx,
            community,
            action_event,
            None,
            None,
        )
        .await?;
        if !action_inserted {
            tx.rollback().await?;
            return Ok(LedgerActionApply::ActionAlreadyStored);
        }

        let head_result = replaceable::replace_parameterized_event_in_transaction_impl(
            &mut tx,
            community,
            head_event,
            head_d_tag,
            None,
            ParameterizedReplacePrecondition::Unconditional,
        )
        .await?;
        if !matches!(head_result.status, ParameterizedReplaceStatus::Inserted) {
            tx.rollback().await?;
            return Err(DbError::InvalidData(
                "ledger book head lost NIP-33 replacement ordering".to_owned(),
            ));
        }

        let (receipt, receipt_inserted) = event::insert_event_with_thread_metadata_tx(
            &mut tx,
            community,
            receipt_event,
            None,
            None,
        )
        .await?;
        if !receipt_inserted {
            tx.rollback().await?;
            return Err(DbError::InvalidData(
                "ledger receipt event was already stored".to_owned(),
            ));
        }

        tx.commit().await?;
        Ok(LedgerActionApply::Applied {
            action,
            head: head_result.event,
            receipt,
        })
    }

    /// The durable claim for one party action's retry key, if it already won.
    pub async fn find_party_action_claim(
        &self,
        community: CommunityId,
        idempotency_key: Uuid,
    ) -> Result<Option<PartyActionClaim>> {
        type ClaimRow = (Vec<u8>, Option<Vec<u8>>, Option<Vec<u8>>, Vec<u8>);
        let row: Option<ClaimRow> = sqlx::query_as(
            r#"
            SELECT action_event_id, head_event_id, alias_event_id, receipt_event_id
            FROM party_action_claims
            WHERE community_id = $1 AND idempotency_key = $2
            "#,
        )
        .bind(community.as_uuid())
        .bind(idempotency_key)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(
            |(action_event_id, head_event_id, alias_event_id, receipt_event_id)| PartyActionClaim {
                action_event_id,
                head_event_id,
                alias_event_id,
                receipt_event_id,
            },
        ))
    }

    /// Commit one owner-signed party action with its heads and receipt.
    ///
    /// A merge passes `alias`, and both heads land in the same transaction or
    /// neither does. Half a merge is worse than no merge: a survivor without
    /// its alias strands every reference to the retired handle, and an alias
    /// without its survivor points at a record that never absorbed anything.
    #[allow(clippy::too_many_arguments)]
    pub async fn apply_party_action_once(
        &self,
        community: CommunityId,
        action_event: &nostr::Event,
        head_event: &nostr::Event,
        head_d_tag: &str,
        alias: Option<(&nostr::Event, &str)>,
        relationship_heads: &[(&nostr::Event, &str)],
        receipt_event: &nostr::Event,
        idempotency_key: Uuid,
        actor_pubkey_hex: &str,
        expected_head_event_id: Option<&[u8]>,
    ) -> Result<PartyActionApply> {
        for (event, expected_kind, label) in [
            (
                action_event,
                buzz_core::kind::KIND_PARTY_ACTION,
                "party action",
            ),
            (
                receipt_event,
                buzz_core::kind::KIND_PARTY_RECEIPT,
                "party receipt",
            ),
        ] {
            if event.kind.as_u16() as u32 != expected_kind {
                return Err(DbError::InvalidData(format!(
                    "{label} has kind {}, expected {expected_kind}",
                    event.kind.as_u16()
                )));
            }
        }

        let head_kind = head_event.kind.as_u16() as u32;
        if !matches!(
            head_kind,
            buzz_core::kind::KIND_PARTY | buzz_core::kind::KIND_PARTY_RELATIONSHIP
        ) {
            return Err(DbError::InvalidData(format!(
                "party head has kind {head_kind}, expected a Party or relationship head"
            )));
        }
        // An alias only ever lives at a party coordinate; one written at a
        // relationship coordinate would be unreachable by any resolver.
        if let Some((alias_event, _)) = alias {
            let alias_kind = alias_event.kind.as_u16() as u32;
            if alias_kind != buzz_core::kind::KIND_PARTY {
                return Err(DbError::InvalidData(format!(
                    "party alias has kind {alias_kind}, expected a Party head"
                )));
            }
        }
        // Re-pointed views ride along with a merge. Anything else arriving here
        // would be a second party head written under a coordinate this call
        // never compare-and-set against.
        for (relationship_event, _) in relationship_heads {
            let relationship_kind = relationship_event.kind.as_u16() as u32;
            if relationship_kind != buzz_core::kind::KIND_PARTY_RELATIONSHIP {
                return Err(DbError::InvalidData(format!(
                    "party relationship head has kind {relationship_kind}, \
                     expected a relationship head"
                )));
            }
        }

        for (event, d_tag, label) in std::iter::once((head_event, head_d_tag, "party head"))
            .chain(alias.map(|(event, d_tag)| (event, d_tag, "party alias")))
            .chain(
                relationship_heads
                    .iter()
                    .map(|(event, d_tag)| (*event, *d_tag, "party relationship head")),
            )
        {
            if d_tag.len() > event::D_TAG_MAX_LEN {
                return Err(DbError::InvalidData(format!(
                    "{label} d tag exceeds {} bytes",
                    event::D_TAG_MAX_LEN
                )));
            }
            let tags = event
                .tags
                .iter()
                .filter_map(|tag| {
                    let parts = tag.as_slice();
                    (parts.first().is_some_and(|part| part == "d")).then_some(parts)
                })
                .collect::<Vec<_>>();
            if tags.len() != 1 || tags[0].len() != 2 || tags[0][1] != d_tag {
                return Err(DbError::InvalidData(format!(
                    "{label} must contain exactly one matching d tag"
                )));
            }
        }

        let mut tx = self.pool.begin().await?;

        // Authority first, under the same `FOR UPDATE` that ownership transfer
        // takes, so the two serialize instead of racing.
        let owners: Vec<String> = sqlx::query_scalar(
            "SELECT pubkey FROM relay_members \
             WHERE community_id = $1 AND role = 'owner' \
             FOR UPDATE",
        )
        .bind(community.as_uuid())
        .fetch_all(&mut *tx)
        .await?;
        let actor = actor_pubkey_hex.to_ascii_lowercase();
        if !owners.iter().any(|owner| owner == &actor) {
            tx.rollback().await?;
            return Ok(PartyActionApply::NotOwner);
        }

        // An owner row alone is not enough: nothing structurally stops an agent
        // pubkey occupying one. Party state decides who the company bills, so
        // the transaction enforces humanity itself.
        let actor_is_agent: Option<bool> = sqlx::query_scalar(
            "SELECT agent_owner_pubkey IS NOT NULL FROM users \
             WHERE community_id = $1 AND pubkey = $2",
        )
        .bind(community.as_uuid())
        .bind(hex::decode(&actor).unwrap_or_default())
        .fetch_optional(&mut *tx)
        .await?;
        if actor_is_agent.unwrap_or(true) {
            tx.rollback().await?;
            return Ok(PartyActionApply::NotOwner);
        }

        let claimed: Option<Vec<u8>> = sqlx::query_scalar(
            r#"
            INSERT INTO party_action_claims
                (community_id, idempotency_key, action_event_id, head_event_id,
                 alias_event_id, receipt_event_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT DO NOTHING
            RETURNING action_event_id
            "#,
        )
        .bind(community.as_uuid())
        .bind(idempotency_key)
        .bind(action_event.id.as_bytes().as_slice())
        .bind(head_event.id.as_bytes().as_slice())
        .bind(alias.map(|(event, _)| event.id.as_bytes().to_vec()))
        .bind(receipt_event.id.as_bytes().as_slice())
        .fetch_optional(&mut *tx)
        .await?;

        if claimed.is_none() {
            let original: Option<Vec<u8>> = sqlx::query_scalar(
                r#"
                SELECT action_event_id
                FROM party_action_claims
                WHERE community_id = $1 AND idempotency_key = $2
                "#,
            )
            .bind(community.as_uuid())
            .bind(idempotency_key)
            .fetch_optional(&mut *tx)
            .await?;
            tx.rollback().await?;
            return original
                .map(|original_action_event_id| PartyActionApply::Duplicate {
                    original_action_event_id,
                })
                .ok_or_else(|| {
                    DbError::InvalidData(
                        "party action claim conflict had no durable winning row".to_owned(),
                    )
                });
        }

        // Compare-and-set against the head stored right now, read with the same
        // ordering the replacement uses so the row checked is the row that
        // would be superseded.
        let current_head_event_id: Option<Vec<u8>> = sqlx::query_scalar(
            "SELECT id FROM events \
             WHERE community_id = $1 AND kind = $2 AND pubkey = $3 AND d_tag = $4 \
               AND deleted_at IS NULL \
             ORDER BY created_at DESC, id ASC LIMIT 1",
        )
        .bind(community.as_uuid())
        .bind(head_kind as i32)
        .bind(head_event.pubkey.to_bytes().as_slice())
        .bind(head_d_tag)
        .fetch_optional(&mut *tx)
        .await?;
        if current_head_event_id.as_deref() != expected_head_event_id {
            tx.rollback().await?;
            return Ok(PartyActionApply::StaleHead {
                current_head_event_id,
            });
        }

        let (action, action_inserted) = event::insert_event_with_thread_metadata_tx(
            &mut tx,
            community,
            action_event,
            None,
            None,
        )
        .await?;
        if !action_inserted {
            tx.rollback().await?;
            return Ok(PartyActionApply::ActionAlreadyStored);
        }

        let head_result = replaceable::replace_parameterized_event_in_transaction_impl(
            &mut tx,
            community,
            head_event,
            head_d_tag,
            None,
            ParameterizedReplacePrecondition::Unconditional,
        )
        .await?;
        if !matches!(head_result.status, ParameterizedReplaceStatus::Inserted) {
            tx.rollback().await?;
            return Err(DbError::InvalidData(
                "party head lost NIP-33 replacement ordering".to_owned(),
            ));
        }

        let mut stored_alias = None;
        if let Some((alias_event, alias_d_tag)) = alias {
            let result = replaceable::replace_parameterized_event_in_transaction_impl(
                &mut tx,
                community,
                alias_event,
                alias_d_tag,
                None,
                ParameterizedReplacePrecondition::Unconditional,
            )
            .await?;
            if !matches!(result.status, ParameterizedReplaceStatus::Inserted) {
                tx.rollback().await?;
                return Err(DbError::InvalidData(
                    "party alias lost NIP-33 replacement ordering".to_owned(),
                ));
            }
            stored_alias = Some(result.event);
        }

        // Same transaction as the survivor and the alias. A merge that moved
        // the identity but not its views would leave a Lead pointing at a
        // retired handle, and no later write is guaranteed to arrive.
        let mut stored_relationships = Vec::with_capacity(relationship_heads.len());
        for (relationship_event, relationship_d_tag) in relationship_heads {
            let result = replaceable::replace_parameterized_event_in_transaction_impl(
                &mut tx,
                community,
                relationship_event,
                relationship_d_tag,
                None,
                ParameterizedReplacePrecondition::Unconditional,
            )
            .await?;
            if !matches!(result.status, ParameterizedReplaceStatus::Inserted) {
                tx.rollback().await?;
                return Err(DbError::InvalidData(
                    "party relationship head lost NIP-33 replacement ordering".to_owned(),
                ));
            }
            stored_relationships.push(result.event);
        }

        let (receipt, receipt_inserted) = event::insert_event_with_thread_metadata_tx(
            &mut tx,
            community,
            receipt_event,
            None,
            None,
        )
        .await?;
        if !receipt_inserted {
            tx.rollback().await?;
            return Err(DbError::InvalidData(
                "party receipt event was already stored".to_owned(),
            ));
        }

        tx.commit().await?;
        Ok(PartyActionApply::Applied {
            action,
            head: head_result.event,
            alias: stored_alias,
            relationships: stored_relationships,
            receipt,
        })
    }

    /// Store one owner-signed party action beside its relay-signed failure
    /// receipt, touching no head.
    ///
    /// Returns `None` when the action was already stored, so a replay is a
    /// no-op rather than a duplicate receipt.
    pub async fn store_party_failure_receipt(
        &self,
        community: CommunityId,
        action_event: &nostr::Event,
        receipt_event: &nostr::Event,
    ) -> Result<Option<(StoredEvent, StoredEvent)>> {
        for (event, expected_kind, label) in [
            (
                action_event,
                buzz_core::kind::KIND_PARTY_ACTION,
                "party action",
            ),
            (
                receipt_event,
                buzz_core::kind::KIND_PARTY_RECEIPT,
                "party receipt",
            ),
        ] {
            if event.kind.as_u16() as u32 != expected_kind {
                return Err(DbError::InvalidData(format!(
                    "{label} has kind {}, expected {expected_kind}",
                    event.kind.as_u16()
                )));
            }
        }

        let mut tx = self.pool.begin().await?;
        let (action, action_inserted) = event::insert_event_with_thread_metadata_tx(
            &mut tx,
            community,
            action_event,
            None,
            None,
        )
        .await?;
        if !action_inserted {
            tx.rollback().await?;
            return Ok(None);
        }
        let (receipt, _) = event::insert_event_with_thread_metadata_tx(
            &mut tx,
            community,
            receipt_event,
            None,
            None,
        )
        .await?;
        tx.commit().await?;
        Ok(Some((action, receipt)))
    }

    /// Store one owner-signed ledger action beside its relay-signed failure
    /// receipt, touching no book head.
    ///
    /// Only reached for a request that was well-formed and genuinely from the
    /// owner but lost on validation or compare-and-set. The owner still needs
    /// a durable, auditable answer for a refusal.
    ///
    /// Returns `None` when the action was already stored, so a replay is a
    /// no-op rather than a duplicate receipt.
    pub async fn store_ledger_failure_receipt(
        &self,
        community: CommunityId,
        action_event: &nostr::Event,
        receipt_event: &nostr::Event,
    ) -> Result<Option<(StoredEvent, StoredEvent)>> {
        for (event, expected_kind, label) in [
            (
                action_event,
                buzz_core::kind::KIND_LEDGER_ACTION,
                "ledger action",
            ),
            (
                receipt_event,
                buzz_core::kind::KIND_LEDGER_RECEIPT,
                "ledger receipt",
            ),
        ] {
            if event.kind.as_u16() as u32 != expected_kind {
                return Err(DbError::InvalidData(format!(
                    "{label} has kind {}, expected {expected_kind}",
                    event.kind.as_u16()
                )));
            }
        }

        let mut tx = self.pool.begin().await?;
        let (action, action_inserted) = event::insert_event_with_thread_metadata_tx(
            &mut tx,
            community,
            action_event,
            None,
            None,
        )
        .await?;
        if !action_inserted {
            tx.rollback().await?;
            return Ok(None);
        }
        let (receipt, _) = event::insert_event_with_thread_metadata_tx(
            &mut tx,
            community,
            receipt_event,
            None,
            None,
        )
        .await?;
        tx.commit().await?;
        Ok(Some((action, receipt)))
    }

    /// Store one owner-signed Company Action together with its relay-signed
    /// failure receipt, without touching any canonical head.
    ///
    /// Only reached for a request that was well-formed and genuinely from the
    /// owner but lost on validation or compare-and-set. Malformed and
    /// unauthorized requests are refused upstream and stored nowhere, so this
    /// path cannot be used to fill the store with junk.
    ///
    /// Returns `None` when the action was already stored, which makes a replay
    /// a no-op rather than a duplicate receipt.
    pub async fn store_company_failure_receipt(
        &self,
        community: CommunityId,
        action_event: &nostr::Event,
        receipt_event: &nostr::Event,
    ) -> Result<Option<(StoredEvent, StoredEvent)>> {
        for (event, expected_kind, label) in [
            (
                action_event,
                buzz_core::kind::KIND_COMPANY_ACTION,
                "company action",
            ),
            (
                receipt_event,
                buzz_core::kind::KIND_COMPANY_RECEIPT,
                "company receipt",
            ),
        ] {
            if event.kind.as_u16() as u32 != expected_kind {
                return Err(DbError::InvalidData(format!(
                    "{label} has kind {}, expected {expected_kind}",
                    event.kind.as_u16()
                )));
            }
        }

        let mut tx = self.pool.begin().await?;
        let (action, action_inserted) = event::insert_event_with_thread_metadata_tx(
            &mut tx,
            community,
            action_event,
            None,
            None,
        )
        .await?;
        if !action_inserted {
            tx.rollback().await?;
            return Ok(None);
        }
        let (receipt, receipt_inserted) = event::insert_event_with_thread_metadata_tx(
            &mut tx,
            community,
            receipt_event,
            None,
            None,
        )
        .await?;
        if !receipt_inserted {
            tx.rollback().await?;
            return Err(DbError::InvalidData(
                "company failure receipt was already stored".to_owned(),
            ));
        }
        tx.commit().await?;
        Ok(Some((action, receipt)))
    }

    /// Query the latest in-progress task heads across every non-archived
    /// community, for the Colony stall-detection sweep. See
    /// [`event::query_in_progress_task_heads`].
    pub async fn query_in_progress_task_heads(
        &self,
        batch_limit: i64,
    ) -> Result<Vec<event::StallCandidateTask>> {
        event::query_in_progress_task_heads(&self.pool, batch_limit).await
    }

    /// Query the latest snoozed task heads due to wake, across every
    /// non-archived community. See [`event::query_due_snoozed_task_heads`].
    pub async fn query_due_snoozed_task_heads(
        &self,
        now: i64,
        batch_limit: i64,
    ) -> Result<Vec<event::SnoozedCandidateTask>> {
        event::query_due_snoozed_task_heads(&self.pool, now, batch_limit).await
    }

    /// Atomically claim one task's wake at one specific `wake_at` (cross-relay
    /// dedup for the snooze-wake sweep). See [`event::claim_task_wake`].
    pub async fn claim_task_wake(
        &self,
        community_id: CommunityId,
        task_id: &str,
        wake_at: i64,
    ) -> Result<bool> {
        event::claim_task_wake(&self.pool, community_id, task_id, wake_at).await
    }

    /// Returns up to `limit` hex pubkeys currently holding the `owner` role in
    /// `community`, oldest first. See [`relay_members::list_relay_owners`].
    pub async fn list_relay_owners(
        &self,
        community: CommunityId,
        limit: i64,
    ) -> Result<Vec<String>> {
        relay_members::list_relay_owners(&self.pool, community, limit).await
    }

    /// Record a newly hired employee. `None` when this hire request already
    /// produced one or the role is filled (see [`employees::insert_employee`]).
    pub async fn insert_employee(
        &self,
        community: CommunityId,
        employee: employees::NewEmployee<'_>,
    ) -> Result<Option<employees::EmployeeRow>> {
        employees::insert_employee(&self.pool, community, employee).await
    }

    /// The employee a hire request already produced, if any
    /// (see [`employees::find_employee_by_hire_event`]).
    pub async fn find_employee_by_hire_event(
        &self,
        community: CommunityId,
        hire_event: &[u8],
    ) -> Result<Option<employees::EmployeeRow>> {
        employees::find_employee_by_hire_event(&self.pool, community, hire_event).await
    }

    /// Look an employee up by identity (see [`employees::find_employee`]).
    pub async fn find_employee(
        &self,
        community: CommunityId,
        pubkey: &[u8],
    ) -> Result<Option<employees::EmployeeRow>> {
        employees::find_employee(&self.pool, community, pubkey).await
    }

    /// The employee currently filling a role (see
    /// [`employees::find_active_employee_by_role`]).
    pub async fn find_active_employee_by_role(
        &self,
        community: CommunityId,
        role_id: &str,
    ) -> Result<Option<employees::EmployeeRow>> {
        employees::find_active_employee_by_role(&self.pool, community, role_id).await
    }

    /// Every active employee of a community (see [`employees::list_active_employees`]).
    pub async fn list_active_employees(
        &self,
        community: CommunityId,
    ) -> Result<Vec<employees::EmployeeRow>> {
        employees::list_active_employees(&self.pool, community).await
    }

    /// Retire an employee, freeing its role (see [`employees::retire_employee`]).
    pub async fn retire_employee(&self, community: CommunityId, pubkey: &[u8]) -> Result<bool> {
        employees::retire_employee(&self.pool, community, pubkey).await
    }

    /// Apply an owner-validated rank/manager/status change to an employee
    /// (see [`employees::update_employee`]). `None` when no active row
    /// matches, so a repeat retire settles instead of erroring.
    pub async fn update_employee(
        &self,
        community: CommunityId,
        pubkey: &[u8],
        rank: Option<&str>,
        manager: Option<Option<&[u8]>>,
        status: Option<&str>,
    ) -> Result<Option<employees::EmployeeRow>> {
        employees::update_employee(&self.pool, community, pubkey, rank, manager, status).await
    }

    /// Seed one provisioned employee. `None` when the handle is already
    /// seeded or a user's own employee holds the role
    /// (see [`employees::insert_provisioned_employee`]).
    pub async fn insert_provisioned_employee(
        &self,
        community: CommunityId,
        employee: employees::NewProvisionedEmployee<'_>,
    ) -> Result<Option<employees::EmployeeRow>> {
        employees::insert_provisioned_employee(&self.pool, community, employee).await
    }

    /// The employee seeded from `handle`, if any
    /// (see [`employees::find_provisioned_employee`]).
    pub async fn find_provisioned_employee(
        &self,
        community: CommunityId,
        handle: &str,
    ) -> Result<Option<employees::EmployeeRow>> {
        employees::find_provisioned_employee(&self.pool, community, handle).await
    }

    /// Apply a newer bundled version to an already-seeded employee
    /// (see [`employees::update_provisioned_employee`]).
    pub async fn update_provisioned_employee(
        &self,
        community: CommunityId,
        update: employees::ProvisionedEmployeeUpdate<'_>,
    ) -> Result<Option<employees::EmployeeRow>> {
        employees::update_provisioned_employee(&self.pool, community, update).await
    }

    /// File a job. `None` when this filing already produced one
    /// (see [`jobs::insert_job`]).
    pub async fn insert_job(
        &self,
        community: CommunityId,
        job: jobs::NewJob<'_>,
    ) -> Result<Option<jobs::JobRow>> {
        jobs::insert_job(&self.pool, community, job).await
    }

    /// Look a job up by id (see [`jobs::find_job`]).
    pub async fn find_job(
        &self,
        community: CommunityId,
        job_id: &[u8],
    ) -> Result<Option<jobs::JobRow>> {
        jobs::find_job(&self.pool, community, job_id).await
    }

    /// Take the lease on a job. `None` when somebody else holds it
    /// (see [`jobs::claim_job`]).
    pub async fn claim_job(
        &self,
        community: CommunityId,
        job_id: &[u8],
        holder: &[u8],
        max_attempts: i32,
        now: i64,
        lease_expires_at: i64,
    ) -> Result<Option<jobs::JobRow>> {
        jobs::claim_job(
            &self.pool,
            community,
            job_id,
            holder,
            max_attempts,
            now,
            lease_expires_at,
        )
        .await
    }

    /// Push a lease's deadline out. `None` when no longer the holder
    /// (see [`jobs::heartbeat_job`]).
    pub async fn heartbeat_job(
        &self,
        community: CommunityId,
        job_id: &[u8],
        holder: &[u8],
        attempt: i32,
        now: i64,
        lease_expires_at: i64,
    ) -> Result<Option<jobs::JobRow>> {
        jobs::heartbeat_job(
            &self.pool,
            community,
            job_id,
            holder,
            attempt,
            now,
            lease_expires_at,
        )
        .await
    }

    /// Persist a fenced checkpoint and extend its live lease
    /// (see [`jobs::checkpoint_job`]).
    pub async fn checkpoint_job(
        &self,
        community: CommunityId,
        checkpoint: jobs::JobCheckpoint<'_>,
    ) -> Result<Option<jobs::JobRow>> {
        jobs::checkpoint_job(&self.pool, community, checkpoint).await
    }

    /// Record how a job ended (see [`jobs::finish_job`]).
    pub async fn finish_job(
        &self,
        community: CommunityId,
        outcome: jobs::FinishedJob<'_>,
    ) -> Result<Option<jobs::JobRow>> {
        jobs::finish_job(&self.pool, community, outcome).await
    }

    /// Take every lapsed lease away, across every community
    /// (see [`jobs::expire_due_leases`]).
    pub async fn expire_due_leases(
        &self,
        now: i64,
        max_attempts: i32,
        limit: i64,
    ) -> Result<Vec<jobs::TenantJobRow>> {
        jobs::expire_due_leases(&self.pool, now, max_attempts, limit).await
    }

    /// Jobs that need a human told about them, across every community
    /// (see [`jobs::list_jobs_needing_escalation`]).
    pub async fn list_jobs_needing_escalation(
        &self,
        unclaimed_before: i64,
        limit: i64,
    ) -> Result<Vec<jobs::TenantJobRow>> {
        jobs::list_jobs_needing_escalation(&self.pool, unclaimed_before, limit).await
    }

    /// Stamp this job's next head and read the job in one statement
    /// (see [`jobs::stamp_head`]).
    pub async fn stamp_job_head(
        &self,
        community: CommunityId,
        job_id: &[u8],
        now: i64,
    ) -> Result<Option<(i64, jobs::JobRow)>> {
        jobs::stamp_head(&self.pool, community, job_id, now).await
    }

    /// Remember that a human has been asked about this job
    /// (see [`jobs::record_escalation`]).
    pub async fn record_escalation(
        &self,
        community: CommunityId,
        job_id: &[u8],
        ask_event: &[u8],
    ) -> Result<bool> {
        jobs::record_escalation(&self.pool, community, job_id, ask_event).await
    }

    /// Give back an escalation slot whose ask never got filed
    /// (see [`jobs::clear_escalation`]).
    pub async fn clear_escalation(&self, community: CommunityId, job_id: &[u8]) -> Result<()> {
        jobs::clear_escalation(&self.pool, community, job_id).await
    }

    /// Files a new open ask. See [`asks::insert_ask`] for the dedupe
    /// guarantee (fails on a Postgres unique violation if an open ask
    /// already exists for this need).
    pub async fn insert_ask(&self, community: CommunityId, row: asks::NewAskRow<'_>) -> Result<()> {
        asks::insert_ask(&self.pool, community, row).await
    }

    /// Returns the currently open ask whose filing event is `ask_event_id`,
    /// or `None`. See [`asks::find_open_ask_by_event_id`].
    pub async fn find_open_ask_by_event_id(
        &self,
        community: CommunityId,
        ask_event_id: &[u8],
    ) -> Result<Option<asks::AskRow>> {
        asks::find_open_ask_by_event_id(&self.pool, community, ask_event_id).await
    }

    /// Returns the ask whose filing event is `ask_event_id`, regardless of
    /// status, or `None`. See [`asks::find_ask_by_event_id`].
    pub async fn find_ask_by_event_id(
        &self,
        community: CommunityId,
        ask_event_id: &[u8],
    ) -> Result<Option<asks::AskRow>> {
        asks::find_ask_by_event_id(&self.pool, community, ask_event_id).await
    }

    /// Returns the currently open ask for `(community, initiative_id,
    /// need_key)`, or `None` if there isn't one.
    pub async fn find_open_ask_by_need(
        &self,
        community: CommunityId,
        initiative_id: &str,
        need_key: &str,
    ) -> Result<Option<asks::AskRow>> {
        asks::find_open_ask_by_need(&self.pool, community, initiative_id, need_key).await
    }

    /// Returns the most recently filed `resolved` or `withdrawn` ask for
    /// `(community, initiative_id, need_key)`, or `None`. See
    /// [`asks::find_latest_closed_ask_by_need`].
    pub async fn find_latest_closed_ask_by_need(
        &self,
        community: CommunityId,
        initiative_id: &str,
        need_key: &str,
    ) -> Result<Option<asks::AskRow>> {
        asks::find_latest_closed_ask_by_need(&self.pool, community, initiative_id, need_key).await
    }

    /// Marks an open ask resolved. Returns `false` if no open ask with this
    /// `ask_event_id` existed in `community`.
    pub async fn resolve_ask(
        &self,
        community: CommunityId,
        ask_event_id: &[u8],
        resolution_event_id: &[u8],
        resolved_by: &[u8],
        default_executed: bool,
    ) -> Result<bool> {
        asks::resolve_ask(
            &self.pool,
            community,
            ask_event_id,
            resolution_event_id,
            resolved_by,
            default_executed,
        )
        .await
    }

    /// Marks an open ask withdrawn. Returns `false` if no open ask with this
    /// `ask_event_id` existed in `community`.
    pub async fn withdraw_ask(
        &self,
        community: CommunityId,
        ask_event_id: &[u8],
        withdrawal_event_id: &[u8],
    ) -> Result<bool> {
        asks::withdraw_ask(&self.pool, community, ask_event_id, withdrawal_event_id).await
    }

    /// Marks an open ask promoted to a new ask further up the agent
    /// hierarchy. Returns `false` if no open ask with this `ask_event_id`
    /// existed in `community`.
    pub async fn mark_ask_promoted(
        &self,
        community: CommunityId,
        ask_event_id: &[u8],
        promoted_to_event_id: &[u8],
    ) -> Result<bool> {
        asks::mark_ask_promoted(&self.pool, community, ask_event_id, promoted_to_event_id).await
    }

    /// Reverts a `promoted` row back to `open`, clearing the promotion
    /// pointer, but ONLY when it is still promoted toward exactly
    /// `expected_promoted_to`. Returns `false` if it no longer matches. See
    /// [`asks::reopen_promoted_ask`].
    pub async fn reopen_promoted_ask(
        &self,
        community: CommunityId,
        ask_event_id: &[u8],
        expected_promoted_to: &[u8],
    ) -> Result<bool> {
        asks::reopen_promoted_ask(&self.pool, community, ask_event_id, expected_promoted_to).await
    }

    /// Returns open asks whose deadline has passed, across every community,
    /// capped at `limit` rows. Mirrors [`Db::query_due_reminders`].
    pub async fn query_due_asks(&self, now_secs: i64, limit: i64) -> Result<Vec<asks::AskRow>> {
        asks::query_due_asks(&self.pool, now_secs, limit).await
    }

    /// Returns `promoted` asks whose named successor was never actually
    /// created (a process crash between the claim and the successor being
    /// filed), across every community, capped at `limit` rows. See
    /// [`asks::query_orphaned_promoted_asks`].
    pub async fn query_orphaned_promoted_asks(
        &self,
        cutoff_secs: i64,
        limit: i64,
    ) -> Result<Vec<asks::AskRow>> {
        asks::query_orphaned_promoted_asks(&self.pool, cutoff_secs, limit).await
    }

    /// Pushes an open ask's deadline forward without otherwise touching it.
    /// Returns `false` if no open ask with this `ask_event_id` existed in
    /// `community`. See [`asks::extend_ask_deadline`].
    pub async fn extend_ask_deadline(
        &self,
        community: CommunityId,
        ask_event_id: &[u8],
        new_deadline_at: i64,
    ) -> Result<bool> {
        asks::extend_ask_deadline(&self.pool, community, ask_event_id, new_deadline_at).await
    }

    /// Returns every open ask rooted at `thread_root`. Backs owner
    /// thread-reply auto-resolution. See [`asks::find_open_asks_by_thread`].
    pub async fn find_open_asks_by_thread(
        &self,
        community: CommunityId,
        thread_root: &[u8],
    ) -> Result<Vec<asks::AskRow>> {
        asks::find_open_asks_by_thread(&self.pool, community, thread_root).await
    }

    /// Returns every open ask in `community` with this `category`
    /// (case-insensitive) addressed to `audience_pubkey`. Backs hiring
    /// wake-up receipts. See [`asks::find_open_asks_by_category_and_audience`].
    pub async fn find_open_asks_by_category_and_audience(
        &self,
        community: CommunityId,
        category: &str,
        audience_pubkey: &[u8],
    ) -> Result<Vec<asks::AskRow>> {
        asks::find_open_asks_by_category_and_audience(
            &self.pool,
            community,
            category,
            audience_pubkey,
        )
        .await
    }
}
