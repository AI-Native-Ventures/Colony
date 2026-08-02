//! Private entitlement, authorization, and durable run persistence for Discovery.

use buzz_core::{
    discovery::{
        DiscoveryOperation, DiscoveryRunProjection, DiscoveryRunState, DiscoveryTerminalReason,
    },
    discovery_worker::{
        DiscoveryCheckpointKind, DiscoveryProvider, DiscoveryWorkerAction,
        DiscoveryWorkerCheckpoint, DiscoveryWorkerLeaseProjection, DiscoveryWorkerOperation,
        DiscoveryWorkerReceiptOutcome,
    },
    CommunityId, StoredEvent,
};
use chrono::{DateTime, Duration, Utc};
use nostr::Event;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

use crate::{Db, DbError, Result};

const DISCOVERY_CAPABILITY: &str = "discovery.run";

/// Result of checking an actor against membership, entitlement, and agent grant state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscoveryAuthorization {
    /// An entitled relay member represented by a human pubkey.
    AuthorizedHuman,
    /// An entitled relay member represented by an agent with a server grant.
    AuthorizedAgent,
    /// The workspace does not currently have Discovery access.
    EntitlementInactive,
    /// The actor is not a relay member in this community.
    MembershipRequired,
    /// The actor is an agent without an active server-side Discovery grant.
    AgentGrantRequired,
}

impl DiscoveryAuthorization {
    /// Whether this result permits a Discovery operation.
    pub const fn is_authorized(self) -> bool {
        matches!(self, Self::AuthorizedHuman | Self::AuthorizedAgent)
    }
}

/// Durable private representation of a Discovery run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveryRunRecord {
    /// Durable run identifier.
    pub id: Uuid,
    /// Tenant read from the persisted row.
    pub community_id: CommunityId,
    /// Opaque campaign reference.
    pub campaign_id: Uuid,
    /// Pubkey that started the run.
    pub requested_by: [u8; 32],
    /// Workspace-scoped retry key used at start.
    pub start_idempotency_key: Uuid,
    /// Durable lifecycle state.
    pub state: DiscoveryRunState,
    /// Number of committed executor steps.
    pub completed_steps: u32,
    /// Fixed number of executor steps.
    pub total_steps: u32,
    /// Whether an authorized actor requested cancellation.
    pub cancel_requested: bool,
    /// Current worker fencing token.
    pub claim_id: Option<Uuid>,
    /// Expiry of the current claim.
    pub lease_until: Option<DateTime<Utc>>,
    /// Stable installation that owns an external-worker lease.
    pub worker_id: Option<Uuid>,
    /// Pubkey that signed the current external-worker lease action.
    pub lease_owner_pubkey: Option<[u8; 32]>,
    /// Latest durable checkpoint sequence committed for this run.
    pub last_checkpoint_sequence: u32,
    /// Number of successful claims or reclaims.
    pub attempt: u32,
    /// Stable terminal reason.
    pub terminal_reason: Option<DiscoveryTerminalReason>,
    /// Creation time.
    pub created_at: DateTime<Utc>,
    /// Last durable update time.
    pub updated_at: DateTime<Utc>,
}

impl DiscoveryRunRecord {
    /// Convert private persistence into the non-confidential receipt projection.
    pub fn projection(&self) -> DiscoveryRunProjection {
        DiscoveryRunProjection {
            run_id: self.id,
            campaign_id: self.campaign_id,
            state: self.state,
            completed_steps: self.completed_steps,
            total_steps: self.total_steps,
            cancel_requested: self.cancel_requested,
            terminal_reason: self.terminal_reason,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

/// Result of an idempotent start attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoveryRunCreate {
    /// This call inserted the run.
    Created(DiscoveryRunRecord),
    /// The retry key already identified the same logical run.
    Existing(DiscoveryRunRecord),
}

/// A run exclusively claimed by one worker token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimedDiscoveryRun {
    /// Durable row at claim time.
    pub run: DiscoveryRunRecord,
    /// Fencing token required by every subsequent write.
    pub claim_id: Uuid,
}

/// Result of one fenced progress transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoveryAdvance {
    /// Exactly one step committed and more work remains.
    Advanced(DiscoveryRunRecord),
    /// The final step committed.
    Completed(DiscoveryRunRecord),
    /// Progress stopped before incrementing because cancellation became effective.
    Cancelled(DiscoveryRunRecord),
    /// The caller no longer owns a valid lease.
    LostLease,
}

/// State mutation associated with one validated signed Discovery command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscoveryCommandMutation {
    /// Insert a deterministic queued run.
    Start {
        /// Campaign reference copied from the action.
        campaign_id: Uuid,
        /// Server-configured fake executor step count.
        total_steps: u32,
        /// Timestamp already embedded in the relay-signed queued receipt.
        accepted_at: DateTime<Utc>,
    },
    /// Read an existing run without mutating it.
    Status {
        /// Run referenced by the action.
        run_id: Uuid,
    },
    /// Set the cancellation request on an existing run.
    Cancel {
        /// Run referenced by the action.
        run_id: Uuid,
    },
}

impl DiscoveryCommandMutation {
    /// Operation represented by this mutation.
    pub const fn operation(self) -> DiscoveryOperation {
        match self {
            Self::Start { .. } => DiscoveryOperation::Start,
            Self::Status { .. } => DiscoveryOperation::Status,
            Self::Cancel { .. } => DiscoveryOperation::Cancel,
        }
    }

    fn target_id(self, community_id: CommunityId, idempotency_key: Uuid) -> Uuid {
        match self {
            Self::Start { .. } => deterministic_run_id(community_id, idempotency_key),
            Self::Status { run_id } | Self::Cancel { run_id } => run_id,
        }
    }
}

/// Atomic result of storing a command, its safe receipt, and its run mutation.
#[derive(Debug, Clone)]
pub enum DiscoveryCommandApply {
    /// This action won the retry key and committed all records.
    Applied {
        /// Stored actor-signed action.
        action: Box<StoredEvent>,
        /// Stored relay-signed receipt.
        receipt: Box<StoredEvent>,
        /// Resulting private run state.
        run: DiscoveryRunRecord,
    },
    /// The same logical command already committed.
    Duplicate {
        /// Original actor-signed action event ID.
        original_action_event_id: Vec<u8>,
        /// Original relay-signed receipt event ID.
        receipt_event_id: Vec<u8>,
        /// Current private run state.
        run: DiscoveryRunRecord,
    },
}

/// Atomic result of storing one local-worker action, receipt, and mutation.
#[derive(Debug, Clone)]
pub enum DiscoveryWorkerCommandApply {
    /// This action won the retry key and committed all records.
    Applied {
        /// Stored actor-signed action.
        action: Box<StoredEvent>,
        /// Stored relay-signed private receipt.
        receipt: Box<StoredEvent>,
        /// Safe result signed into the receipt.
        outcome: DiscoveryWorkerReceiptOutcome,
    },
    /// The same logical worker command already committed.
    Duplicate {
        /// Original actor-signed action event ID.
        original_action_event_id: Vec<u8>,
        /// Original relay-signed receipt event ID.
        receipt_event_id: Vec<u8>,
    },
}

/// Derive a stable run ID from the server-resolved tenant and retry key.
pub fn deterministic_run_id(community_id: CommunityId, idempotency_key: Uuid) -> Uuid {
    let namespace = Uuid::new_v5(&Uuid::NAMESPACE_OID, community_id.as_uuid().as_bytes());
    Uuid::new_v5(&namespace, idempotency_key.as_bytes())
}

impl Db {
    /// Manually provision or revoke a workspace Discovery entitlement.
    pub async fn set_discovery_entitlement(
        &self,
        community_id: CommunityId,
        active: bool,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        lock_discovery_authority_tx(&mut tx, community_id).await?;
        sqlx::query(
            "INSERT INTO discovery_entitlements (community_id, active, updated_at) \
             VALUES ($1, $2, now()) \
             ON CONFLICT (community_id) DO UPDATE SET active=EXCLUDED.active, updated_at=now()",
        )
        .bind(community_id.as_uuid())
        .bind(active)
        .execute(&mut *tx)
        .await?;
        if !active {
            sqlx::query(
                "UPDATE discovery_runs \
                 SET state='cancelled', cancel_requested=TRUE, \
                     terminal_reason='entitlement_revoked', claim_id=NULL, lease_until=NULL, \
                     worker_id=NULL, lease_owner_pubkey=NULL, updated_at=now() \
                 WHERE community_id=$1 AND state IN ('queued','running')",
            )
            .bind(community_id.as_uuid())
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// Grant or revoke the server-enforced Discovery capability for one agent.
    pub async fn set_discovery_actor_grant(
        &self,
        community_id: CommunityId,
        actor_pubkey: &[u8; 32],
        granted_by: &[u8; 32],
        active: bool,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        lock_discovery_authority_tx(&mut tx, community_id).await?;
        sqlx::query(
            "INSERT INTO discovery_actor_grants \
             (community_id, actor_pubkey, capability, granted_by, active, updated_at) \
             VALUES ($1, $2, $3, $4, $5, now()) \
             ON CONFLICT (community_id, actor_pubkey, capability) DO UPDATE \
             SET granted_by=EXCLUDED.granted_by, active=EXCLUDED.active, updated_at=now()",
        )
        .bind(community_id.as_uuid())
        .bind(actor_pubkey.as_slice())
        .bind(DISCOVERY_CAPABILITY)
        .bind(granted_by.as_slice())
        .bind(active)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Check authoritative workspace and actor state for a Discovery operation.
    pub async fn discovery_authorization(
        &self,
        community_id: CommunityId,
        actor_pubkey: &[u8; 32],
    ) -> Result<DiscoveryAuthorization> {
        discovery_authorization_pool(&self.pool, community_id, actor_pubkey).await
    }

    /// Create a run once for a workspace-scoped start retry key.
    pub async fn create_discovery_run_once(
        &self,
        community_id: CommunityId,
        actor_pubkey: &[u8; 32],
        campaign_id: Uuid,
        idempotency_key: Uuid,
        total_steps: u32,
    ) -> Result<DiscoveryRunCreate> {
        if total_steps == 0 || total_steps > i32::MAX as u32 {
            return Err(DbError::InvalidData(
                "Discovery total steps must be between 1 and i32::MAX".into(),
            ));
        }
        let mut tx = self.pool.begin().await?;
        require_discovery_authorized_tx(&mut tx, community_id, actor_pubkey).await?;
        let run_id = deterministic_run_id(community_id, idempotency_key);
        let inserted = sqlx::query(
            "INSERT INTO discovery_runs \
             (id, community_id, campaign_id, requested_by, start_idempotency_key, total_steps) \
             VALUES ($1, $2, $3, $4, $5, $6) \
             ON CONFLICT (community_id, start_idempotency_key) DO NOTHING \
             RETURNING id",
        )
        .bind(run_id)
        .bind(community_id.as_uuid())
        .bind(campaign_id)
        .bind(actor_pubkey.as_slice())
        .bind(idempotency_key)
        .bind(total_steps as i32)
        .fetch_optional(&mut *tx)
        .await?
        .is_some();
        let row = sqlx::query(DISCOVERY_RUN_SELECT_BY_IDEMPOTENCY)
            .bind(community_id.as_uuid())
            .bind(idempotency_key)
            .fetch_one(&mut *tx)
            .await?;
        let run = run_from_row(&row)?;
        if run.campaign_id != campaign_id || run.total_steps != total_steps {
            return Err(DbError::AccessDenied(
                "Discovery idempotency key conflicts with an existing start".into(),
            ));
        }
        tx.commit().await?;
        Ok(if inserted {
            DiscoveryRunCreate::Created(run)
        } else {
            DiscoveryRunCreate::Existing(run)
        })
    }

    /// Atomically apply one validated command and persist its signed audit events.
    pub async fn apply_discovery_command_once<F>(
        &self,
        community_id: CommunityId,
        actor_pubkey: &[u8; 32],
        idempotency_key: Uuid,
        mutation: DiscoveryCommandMutation,
        action_event: &Event,
        build_receipt: F,
    ) -> Result<DiscoveryCommandApply>
    where
        F: FnOnce(&DiscoveryRunRecord) -> Result<Event>,
    {
        if action_event.pubkey.to_bytes() != *actor_pubkey {
            return Err(DbError::AccessDenied(
                "Discovery action signer does not match authenticated actor".into(),
            ));
        }
        let mut tx = self.pool.begin().await?;
        require_discovery_authorized_tx(&mut tx, community_id, actor_pubkey).await?;
        let operation = mutation.operation();
        let target_id = mutation.target_id(community_id, idempotency_key);
        let fingerprint = command_fingerprint(operation, target_id);
        if let Some(row) = sqlx::query(
            "SELECT operation, request_fingerprint, action_event_id, receipt_event_id, run_id \
             FROM discovery_action_claims WHERE community_id=$1 AND idempotency_key=$2",
        )
        .bind(community_id.as_uuid())
        .bind(idempotency_key)
        .fetch_optional(&mut *tx)
        .await?
        {
            let claimed_operation: String = row.try_get("operation")?;
            let claimed_fingerprint: Vec<u8> = row.try_get("request_fingerprint")?;
            if claimed_operation != operation_text(operation)
                || claimed_fingerprint != fingerprint.as_slice()
            {
                return Err(DbError::AccessDenied(
                    "Discovery idempotency key conflicts with an existing command".into(),
                ));
            }
            let run_id: Uuid = row.try_get("run_id")?;
            let run = load_run_tx(&mut tx, community_id, run_id, false).await?;
            tx.commit().await?;
            return Ok(DiscoveryCommandApply::Duplicate {
                original_action_event_id: row.try_get("action_event_id")?,
                receipt_event_id: row.try_get("receipt_event_id")?,
                run,
            });
        }

        let run = match mutation {
            DiscoveryCommandMutation::Start {
                campaign_id,
                total_steps,
                accepted_at,
            } => {
                if total_steps == 0 || total_steps > i32::MAX as u32 {
                    return Err(DbError::InvalidData(
                        "Discovery total steps must be between 1 and i32::MAX".into(),
                    ));
                }
                let row = sqlx::query(
                    "INSERT INTO discovery_runs \
                     (community_id, id, campaign_id, requested_by, start_idempotency_key, \
                      total_steps, created_at, updated_at) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $7) \
                     RETURNING id, community_id, campaign_id, requested_by, start_idempotency_key, \
                     state, completed_steps, total_steps, cancel_requested, claim_id, lease_until, \
                     worker_id, lease_owner_pubkey, last_checkpoint_sequence, attempt, \
                     terminal_reason, created_at, updated_at",
                )
                .bind(community_id.as_uuid())
                .bind(target_id)
                .bind(campaign_id)
                .bind(actor_pubkey.as_slice())
                .bind(idempotency_key)
                .bind(total_steps as i32)
                .bind(accepted_at)
                .fetch_one(&mut *tx)
                .await?;
                run_from_row(&row)?
            }
            DiscoveryCommandMutation::Status { run_id } => {
                load_run_tx(&mut tx, community_id, run_id, false).await?
            }
            DiscoveryCommandMutation::Cancel { run_id } => {
                let row = sqlx::query(
                    "UPDATE discovery_runs \
                     SET state=CASE WHEN state IN ('queued','running') THEN 'cancelled' ELSE state END, \
                         cancel_requested=CASE WHEN state IN ('queued','running') THEN TRUE \
                                               ELSE cancel_requested END, \
                         terminal_reason=CASE WHEN state IN ('queued','running') \
                                              THEN 'cancelled_by_actor' ELSE terminal_reason END, \
                         claim_id=CASE WHEN state IN ('queued','running') THEN NULL ELSE claim_id END, \
                         lease_until=CASE WHEN state IN ('queued','running') THEN NULL ELSE lease_until END, \
                         worker_id=CASE WHEN state IN ('queued','running') THEN NULL ELSE worker_id END, \
                         lease_owner_pubkey=CASE WHEN state IN ('queued','running') \
                                                 THEN NULL ELSE lease_owner_pubkey END, \
                         updated_at=CASE WHEN state IN ('queued','running') THEN now() \
                                         ELSE updated_at END \
                     WHERE community_id=$1 AND id=$2 \
                     RETURNING id, community_id, campaign_id, requested_by, start_idempotency_key, \
                     state, completed_steps, total_steps, cancel_requested, claim_id, lease_until, \
                     worker_id, lease_owner_pubkey, last_checkpoint_sequence, attempt, \
                     terminal_reason, created_at, updated_at",
                )
                .bind(community_id.as_uuid())
                .bind(run_id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(|| DbError::NotFound("Discovery run".into()))?;
                run_from_row(&row)?
            }
        };

        // Build the receipt from the exact row produced while the community
        // authority lock is held. Loading a projection in the broker before
        // this transaction would let a concurrent cancel/status command make
        // the signed receipt disagree with the committed result.
        let receipt_event = build_receipt(&run)?;

        let (stored_action, action_inserted) = crate::event::insert_event_with_thread_metadata_tx(
            &mut tx,
            community_id,
            action_event,
            None,
            None,
        )
        .await?;
        if !action_inserted {
            return Err(DbError::InvalidData(
                "Discovery action event already exists without its command claim".into(),
            ));
        }
        let (stored_receipt, receipt_inserted) =
            crate::event::insert_event_with_thread_metadata_tx(
                &mut tx,
                community_id,
                &receipt_event,
                None,
                None,
            )
            .await?;
        if !receipt_inserted {
            return Err(DbError::InvalidData(
                "Discovery receipt event already exists without its command claim".into(),
            ));
        }
        crate::insert_mentions_tx(&mut tx, community_id, &receipt_event, None).await?;
        sqlx::query(
            "INSERT INTO discovery_action_claims \
             (community_id, idempotency_key, operation, request_fingerprint, \
              action_event_id, receipt_event_id, run_id) \
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(community_id.as_uuid())
        .bind(idempotency_key)
        .bind(operation_text(operation))
        .bind(fingerprint.as_slice())
        .bind(action_event.id.as_bytes())
        .bind(receipt_event.id.as_bytes())
        .bind(run.id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(DiscoveryCommandApply::Applied {
            action: Box::new(stored_action),
            receipt: Box::new(stored_receipt),
            run,
        })
    }

    /// Atomically apply one fenced local-worker command and persist its private receipt.
    pub async fn apply_discovery_worker_command_once<F>(
        &self,
        community_id: CommunityId,
        actor_pubkey: &[u8; 32],
        action: &DiscoveryWorkerAction,
        action_event: &Event,
        lease_duration: Duration,
        build_receipt: F,
    ) -> Result<DiscoveryWorkerCommandApply>
    where
        F: FnOnce(&DiscoveryWorkerReceiptOutcome) -> Result<Event>,
    {
        if lease_duration <= Duration::zero() {
            return Err(DbError::InvalidData(
                "Discovery lease duration must be positive".into(),
            ));
        }
        if action_event.pubkey.to_bytes() != *actor_pubkey {
            return Err(DbError::AccessDenied(
                "Discovery worker action signer does not match authenticated actor".into(),
            ));
        }

        let mut tx = self.pool.begin().await?;
        require_discovery_authorized_tx(&mut tx, community_id, actor_pubkey).await?;
        let operation = action.operation();
        let fingerprint = worker_action_fingerprint(action);
        if let Some(row) = sqlx::query(
            "SELECT operation, request_fingerprint, action_event_id, receipt_event_id \
             FROM discovery_worker_action_claims \
             WHERE community_id=$1 AND idempotency_key=$2",
        )
        .bind(community_id.as_uuid())
        .bind(action.idempotency_key())
        .fetch_optional(&mut *tx)
        .await?
        {
            let claimed_operation: String = row.try_get("operation")?;
            let claimed_fingerprint: Vec<u8> = row.try_get("request_fingerprint")?;
            if claimed_operation != worker_operation_text(operation)
                || claimed_fingerprint != fingerprint.as_slice()
            {
                return Err(DbError::AccessDenied(
                    "Discovery worker idempotency key conflicts with an existing command".into(),
                ));
            }
            tx.commit().await?;
            return Ok(DiscoveryWorkerCommandApply::Duplicate {
                original_action_event_id: row.try_get("action_event_id")?,
                receipt_event_id: row.try_get("receipt_event_id")?,
            });
        }

        let outcome = apply_worker_action_tx(
            &mut tx,
            community_id,
            actor_pubkey,
            action,
            lease_duration,
            action_event,
        )
        .await?;
        let receipt_event = build_receipt(&outcome)?;
        let (stored_action, action_inserted) = crate::event::insert_event_with_thread_metadata_tx(
            &mut tx,
            community_id,
            action_event,
            None,
            None,
        )
        .await?;
        if !action_inserted {
            return Err(DbError::InvalidData(
                "Discovery worker action exists without its command claim".into(),
            ));
        }
        let (stored_receipt, receipt_inserted) =
            crate::event::insert_event_with_thread_metadata_tx(
                &mut tx,
                community_id,
                &receipt_event,
                None,
                None,
            )
            .await?;
        if !receipt_inserted {
            return Err(DbError::InvalidData(
                "Discovery worker receipt exists without its command claim".into(),
            ));
        }
        crate::insert_mentions_tx(&mut tx, community_id, &receipt_event, None).await?;
        let run_id = worker_outcome_run_id(&outcome);
        sqlx::query(
            "INSERT INTO discovery_worker_action_claims \
             (community_id, idempotency_key, operation, request_fingerprint, \
              action_event_id, receipt_event_id, run_id) \
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(community_id.as_uuid())
        .bind(action.idempotency_key())
        .bind(worker_operation_text(operation))
        .bind(fingerprint.as_slice())
        .bind(action_event.id.as_bytes())
        .bind(receipt_event.id.as_bytes())
        .bind(run_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(DiscoveryWorkerCommandApply::Applied {
            action: Box::new(stored_action),
            receipt: Box::new(stored_receipt),
            outcome,
        })
    }

    /// Load a run after rechecking entitlement and actor authorization.
    pub async fn get_discovery_run_authorized(
        &self,
        community_id: CommunityId,
        actor_pubkey: &[u8; 32],
        run_id: Uuid,
    ) -> Result<DiscoveryRunRecord> {
        require_authorization(
            self.discovery_authorization(community_id, actor_pubkey)
                .await?,
        )?;
        let row = sqlx::query(DISCOVERY_RUN_SELECT_BY_ID)
            .bind(community_id.as_uuid())
            .bind(run_id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| DbError::NotFound("Discovery run".into()))?;
        run_from_row(&row)
    }

    /// Request cancellation after rechecking entitlement and actor authorization.
    pub async fn request_discovery_cancel(
        &self,
        community_id: CommunityId,
        actor_pubkey: &[u8; 32],
        run_id: Uuid,
    ) -> Result<DiscoveryRunRecord> {
        let mut tx = self.pool.begin().await?;
        require_discovery_authorized_tx(&mut tx, community_id, actor_pubkey).await?;
        let row = sqlx::query(
            "UPDATE discovery_runs \
             SET state=CASE WHEN state IN ('queued','running') THEN 'cancelled' ELSE state END, \
                 cancel_requested=CASE WHEN state IN ('queued','running') THEN TRUE \
                                       ELSE cancel_requested END, \
                 terminal_reason=CASE WHEN state IN ('queued','running') \
                                      THEN 'cancelled_by_actor' ELSE terminal_reason END, \
                 claim_id=CASE WHEN state IN ('queued','running') THEN NULL ELSE claim_id END, \
                 lease_until=CASE WHEN state IN ('queued','running') THEN NULL ELSE lease_until END, \
                 worker_id=CASE WHEN state IN ('queued','running') THEN NULL ELSE worker_id END, \
                 lease_owner_pubkey=CASE WHEN state IN ('queued','running') \
                                         THEN NULL ELSE lease_owner_pubkey END, \
                 updated_at=CASE WHEN state IN ('queued','running') THEN now() \
                                 ELSE updated_at END \
             WHERE community_id=$1 AND id=$2 \
             RETURNING id, community_id, campaign_id, requested_by, start_idempotency_key, \
             state, completed_steps, total_steps, cancel_requested, claim_id, lease_until, \
             worker_id, lease_owner_pubkey, last_checkpoint_sequence, attempt, terminal_reason, \
             created_at, updated_at",
        )
        .bind(community_id.as_uuid())
        .bind(run_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| DbError::NotFound("Discovery run".into()))?;
        let run = run_from_row(&row)?;
        tx.commit().await?;
        Ok(run)
    }

    /// Claim or reclaim one non-terminal run from the relay-wide queue.
    pub async fn claim_discovery_run(
        &self,
        lease_duration: Duration,
    ) -> Result<Option<ClaimedDiscoveryRun>> {
        if lease_duration <= Duration::zero() {
            return Err(DbError::InvalidData(
                "Discovery lease duration must be positive".into(),
            ));
        }
        let claim_id = Uuid::new_v4();
        let lease_until = Utc::now() + lease_duration;
        let row = sqlx::query(
            "WITH candidate AS ( \
                 SELECT community_id, id FROM discovery_runs \
                 WHERE state IN ('queued', 'running') \
                   AND (claim_id IS NULL OR lease_until < now()) \
                 ORDER BY created_at, id \
                 FOR UPDATE SKIP LOCKED LIMIT 1 \
             ) \
             UPDATE discovery_runs r \
             SET state='running', claim_id=$1, lease_until=$2, worker_id=NULL, \
                 lease_owner_pubkey=NULL, attempt=r.attempt+1, updated_at=now() \
             FROM candidate c WHERE r.community_id=c.community_id AND r.id=c.id \
             RETURNING r.id, r.community_id, r.campaign_id, r.requested_by, \
             r.start_idempotency_key, r.state, r.completed_steps, r.total_steps, \
             r.cancel_requested, r.claim_id, r.lease_until, r.worker_id, r.lease_owner_pubkey, \
             r.last_checkpoint_sequence, r.attempt, r.terminal_reason, r.created_at, r.updated_at",
        )
        .bind(claim_id)
        .bind(lease_until)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| {
            Ok(ClaimedDiscoveryRun {
                run: run_from_row(&row)?,
                claim_id,
            })
        })
        .transpose()
    }

    /// Extend a currently owned Discovery lease.
    pub async fn renew_discovery_lease(
        &self,
        community_id: CommunityId,
        run_id: Uuid,
        claim_id: Uuid,
        lease_duration: Duration,
    ) -> Result<bool> {
        if lease_duration <= Duration::zero() {
            return Err(DbError::InvalidData(
                "Discovery lease duration must be positive".into(),
            ));
        }
        let result = sqlx::query(
            "UPDATE discovery_runs SET lease_until=$4, updated_at=now() \
             WHERE community_id=$1 AND id=$2 AND claim_id=$3 \
               AND state='running' AND lease_until >= now()",
        )
        .bind(community_id.as_uuid())
        .bind(run_id)
        .bind(claim_id)
        .bind(Utc::now() + lease_duration)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Commit one progress step while checking lease, entitlement, and cancellation atomically.
    pub async fn advance_discovery_step(
        &self,
        community_id: CommunityId,
        run_id: Uuid,
        claim_id: Uuid,
    ) -> Result<DiscoveryAdvance> {
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT id, community_id, campaign_id, requested_by, start_idempotency_key, state, \
             completed_steps, total_steps, cancel_requested, claim_id, lease_until, worker_id, \
             lease_owner_pubkey, last_checkpoint_sequence, attempt, terminal_reason, created_at, \
             updated_at FROM discovery_runs \
             WHERE community_id=$1 AND id=$2 FOR UPDATE",
        )
        .bind(community_id.as_uuid())
        .bind(run_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(row) = row else {
            tx.rollback().await?;
            return Ok(DiscoveryAdvance::LostLease);
        };
        let current = run_from_row(&row)?;
        if current.state != DiscoveryRunState::Running
            || current.claim_id != Some(claim_id)
            || current.lease_until.is_none_or(|lease| lease < Utc::now())
        {
            tx.rollback().await?;
            return Ok(DiscoveryAdvance::LostLease);
        }

        let entitled: bool = sqlx::query_scalar(
            "SELECT active FROM discovery_entitlements WHERE community_id=$1 FOR UPDATE",
        )
        .bind(community_id.as_uuid())
        .fetch_optional(&mut *tx)
        .await?
        .unwrap_or(false);
        if !entitled {
            let stopped = stop_run_tx(
                &mut tx,
                community_id,
                run_id,
                claim_id,
                DiscoveryTerminalReason::EntitlementRevoked,
            )
            .await?;
            tx.commit().await?;
            return Ok(DiscoveryAdvance::Cancelled(stopped));
        }
        if current.cancel_requested {
            let stopped = stop_run_tx(
                &mut tx,
                community_id,
                run_id,
                claim_id,
                DiscoveryTerminalReason::CancelledByActor,
            )
            .await?;
            tx.commit().await?;
            return Ok(DiscoveryAdvance::Cancelled(stopped));
        }

        let completes = current.completed_steps + 1 == current.total_steps;
        let row = sqlx::query(
            "UPDATE discovery_runs \
             SET completed_steps=completed_steps+1, \
                 state=CASE WHEN completed_steps+1=total_steps THEN 'succeeded' ELSE 'running' END, \
                 claim_id=CASE WHEN completed_steps+1=total_steps THEN NULL ELSE claim_id END, \
                 lease_until=CASE WHEN completed_steps+1=total_steps THEN NULL ELSE lease_until END, \
                 worker_id=CASE WHEN completed_steps+1=total_steps THEN NULL ELSE worker_id END, \
                 lease_owner_pubkey=CASE WHEN completed_steps+1=total_steps \
                                         THEN NULL ELSE lease_owner_pubkey END, \
                 updated_at=now() \
             WHERE community_id=$1 AND id=$2 AND claim_id=$3 \
             RETURNING id, community_id, campaign_id, requested_by, start_idempotency_key, \
             state, completed_steps, total_steps, cancel_requested, claim_id, lease_until, \
             worker_id, lease_owner_pubkey, last_checkpoint_sequence, attempt, terminal_reason, \
             created_at, updated_at",
        )
        .bind(community_id.as_uuid())
        .bind(run_id)
        .bind(claim_id)
        .fetch_one(&mut *tx)
        .await?;
        let advanced = run_from_row(&row)?;
        tx.commit().await?;
        Ok(if completes {
            DiscoveryAdvance::Completed(advanced)
        } else {
            DiscoveryAdvance::Advanced(advanced)
        })
    }

    /// Mark a currently leased run failed because its executor cannot continue.
    pub async fn fail_discovery_run(
        &self,
        community_id: CommunityId,
        run_id: Uuid,
        claim_id: Uuid,
    ) -> Result<bool> {
        let result = sqlx::query(
            "UPDATE discovery_runs SET state='failed', terminal_reason='executor_failed', \
             claim_id=NULL, lease_until=NULL, worker_id=NULL, lease_owner_pubkey=NULL, \
             updated_at=now() \
             WHERE community_id=$1 AND id=$2 AND claim_id=$3 \
               AND state='running' AND lease_until >= now()",
        )
        .bind(community_id.as_uuid())
        .bind(run_id)
        .bind(claim_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }
}

async fn apply_worker_action_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    actor_pubkey: &[u8; 32],
    action: &DiscoveryWorkerAction,
    lease_duration: Duration,
    action_event: &Event,
) -> Result<DiscoveryWorkerReceiptOutcome> {
    let lease_until = Utc::now() + lease_duration;
    match action {
        DiscoveryWorkerAction::Claim(request) => {
            let lease_id = Uuid::new_v4();
            let row = sqlx::query(
                "WITH candidate AS ( \
                     SELECT id FROM discovery_runs \
                     WHERE community_id=$1 AND state IN ('queued','running') \
                       AND (claim_id IS NULL OR lease_until < now()) \
                     ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1 \
                 ) \
                 UPDATE discovery_runs r \
                 SET state='running', claim_id=$2, lease_until=$3, worker_id=$4, \
                     lease_owner_pubkey=$5, attempt=r.attempt+1, updated_at=now() \
                 FROM candidate c WHERE r.community_id=$1 AND r.id=c.id \
                 RETURNING r.id, r.community_id, r.campaign_id, r.requested_by, \
                 r.start_idempotency_key, r.state, r.completed_steps, r.total_steps, \
                 r.cancel_requested, r.claim_id, r.lease_until, r.worker_id, \
                 r.lease_owner_pubkey, r.last_checkpoint_sequence, r.attempt, \
                 r.terminal_reason, r.created_at, r.updated_at",
            )
            .bind(community_id.as_uuid())
            .bind(lease_id)
            .bind(lease_until)
            .bind(request.worker_id)
            .bind(actor_pubkey.as_slice())
            .fetch_optional(&mut **tx)
            .await?;
            let Some(row) = row else {
                return Ok(DiscoveryWorkerReceiptOutcome::Idle);
            };
            worker_lease_outcome_tx(tx, run_from_row(&row)?).await
        }
        DiscoveryWorkerAction::Heartbeat(request) => {
            let current = load_run_tx(tx, community_id, request.run_id, true).await?;
            if !worker_lease_matches(&current, actor_pubkey, request.worker_id, request.lease_id) {
                return Ok(DiscoveryWorkerReceiptOutcome::LostLease(
                    current.projection(),
                ));
            }
            let row = sqlx::query(
                "UPDATE discovery_runs SET lease_until=$5, updated_at=now() \
                 WHERE community_id=$1 AND id=$2 AND claim_id=$3 AND worker_id=$4 \
                   AND lease_owner_pubkey=$6 AND state='running' AND lease_until >= now() \
                 RETURNING id, community_id, campaign_id, requested_by, start_idempotency_key, \
                 state, completed_steps, total_steps, cancel_requested, claim_id, lease_until, \
                 worker_id, lease_owner_pubkey, last_checkpoint_sequence, attempt, \
                 terminal_reason, created_at, updated_at",
            )
            .bind(community_id.as_uuid())
            .bind(request.run_id)
            .bind(request.lease_id)
            .bind(request.worker_id)
            .bind(lease_until)
            .bind(actor_pubkey.as_slice())
            .fetch_optional(&mut **tx)
            .await?;
            match row {
                Some(row) => worker_lease_outcome_tx(tx, run_from_row(&row)?).await,
                None => Ok(DiscoveryWorkerReceiptOutcome::LostLease(
                    current.projection(),
                )),
            }
        }
        DiscoveryWorkerAction::Checkpoint(request) => {
            let current = load_run_tx(tx, community_id, request.lease.run_id, true).await?;
            if !worker_lease_matches(
                &current,
                actor_pubkey,
                request.lease.worker_id,
                request.lease.lease_id,
            ) {
                return Ok(DiscoveryWorkerReceiptOutcome::LostLease(
                    current.projection(),
                ));
            }
            let sequence = i32::try_from(request.checkpoint.sequence).map_err(|_| {
                DbError::InvalidData("Discovery checkpoint sequence exceeds i32::MAX".into())
            })?;
            let fingerprint = checkpoint_fingerprint(&request.checkpoint);
            if request.checkpoint.sequence <= current.last_checkpoint_sequence {
                let existing: Option<Vec<u8>> = sqlx::query_scalar(
                    "SELECT request_fingerprint FROM discovery_run_checkpoints \
                     WHERE community_id=$1 AND run_id=$2 AND sequence=$3",
                )
                .bind(community_id.as_uuid())
                .bind(request.lease.run_id)
                .bind(sequence)
                .fetch_optional(&mut **tx)
                .await?;
                if existing.as_deref() != Some(fingerprint.as_slice()) {
                    return Err(DbError::AccessDenied(
                        "Discovery checkpoint sequence conflicts with committed progress".into(),
                    ));
                }
                return worker_lease_outcome_tx(tx, current).await;
            }
            let expected_sequence =
                current
                    .last_checkpoint_sequence
                    .checked_add(1)
                    .ok_or_else(|| {
                        DbError::InvalidData("Discovery checkpoint sequence overflow".into())
                    })?;
            if request.checkpoint.sequence != expected_sequence {
                return Err(DbError::InvalidData(
                    "Discovery checkpoints must be committed in sequence".into(),
                ));
            }
            let item_count = request
                .checkpoint
                .item_count
                .map(i32::try_from)
                .transpose()
                .map_err(|_| {
                    DbError::InvalidData("Discovery checkpoint item count exceeds i32::MAX".into())
                })?;
            sqlx::query(
                "INSERT INTO discovery_run_checkpoints \
                 (community_id, run_id, sequence, checkpoint_kind, provider, \
                  provider_request_id, item_count, request_fingerprint, action_event_id) \
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            )
            .bind(community_id.as_uuid())
            .bind(request.lease.run_id)
            .bind(sequence)
            .bind(checkpoint_kind_text(request.checkpoint.kind))
            .bind(provider_text(request.checkpoint.provider))
            .bind(request.checkpoint.provider_request_id.as_deref())
            .bind(item_count)
            .bind(fingerprint.as_slice())
            .bind(action_event.id.as_bytes())
            .execute(&mut **tx)
            .await?;
            let row = sqlx::query(
                "UPDATE discovery_runs SET last_checkpoint_sequence=$5, lease_until=$6, \
                     updated_at=now() \
                 WHERE community_id=$1 AND id=$2 AND claim_id=$3 AND worker_id=$4 \
                   AND lease_owner_pubkey=$7 AND state='running' AND lease_until >= now() \
                 RETURNING id, community_id, campaign_id, requested_by, start_idempotency_key, \
                 state, completed_steps, total_steps, cancel_requested, claim_id, lease_until, \
                 worker_id, lease_owner_pubkey, last_checkpoint_sequence, attempt, \
                 terminal_reason, created_at, updated_at",
            )
            .bind(community_id.as_uuid())
            .bind(request.lease.run_id)
            .bind(request.lease.lease_id)
            .bind(request.lease.worker_id)
            .bind(sequence)
            .bind(lease_until)
            .bind(actor_pubkey.as_slice())
            .fetch_one(&mut **tx)
            .await?;
            worker_lease_outcome_tx(tx, run_from_row(&row)?).await
        }
        DiscoveryWorkerAction::Complete(request) => {
            let current = load_run_tx(tx, community_id, request.run_id, true).await?;
            if !worker_lease_matches(&current, actor_pubkey, request.worker_id, request.lease_id) {
                return Ok(DiscoveryWorkerReceiptOutcome::LostLease(
                    current.projection(),
                ));
            }
            let row = sqlx::query(
                "UPDATE discovery_runs SET state='succeeded', completed_steps=total_steps, \
                     claim_id=NULL, lease_until=NULL, worker_id=NULL, lease_owner_pubkey=NULL, \
                     updated_at=now() \
                 WHERE community_id=$1 AND id=$2 AND claim_id=$3 AND worker_id=$4 \
                   AND lease_owner_pubkey=$5 AND state='running' AND lease_until >= now() \
                 RETURNING id, community_id, campaign_id, requested_by, start_idempotency_key, \
                 state, completed_steps, total_steps, cancel_requested, claim_id, lease_until, \
                 worker_id, lease_owner_pubkey, last_checkpoint_sequence, attempt, \
                 terminal_reason, created_at, updated_at",
            )
            .bind(community_id.as_uuid())
            .bind(request.run_id)
            .bind(request.lease_id)
            .bind(request.worker_id)
            .bind(actor_pubkey.as_slice())
            .fetch_optional(&mut **tx)
            .await?;
            Ok(match row {
                Some(row) => {
                    DiscoveryWorkerReceiptOutcome::Completed(run_from_row(&row)?.projection())
                }
                None => DiscoveryWorkerReceiptOutcome::LostLease(current.projection()),
            })
        }
    }
}

fn worker_lease_matches(
    run: &DiscoveryRunRecord,
    actor_pubkey: &[u8; 32],
    worker_id: Uuid,
    lease_id: Uuid,
) -> bool {
    run.state == DiscoveryRunState::Running
        && run.claim_id == Some(lease_id)
        && run.worker_id == Some(worker_id)
        && run.lease_owner_pubkey == Some(*actor_pubkey)
        && run.lease_until.is_some_and(|lease| lease >= Utc::now())
}

async fn worker_lease_outcome_tx(
    tx: &mut Transaction<'_, Postgres>,
    run: DiscoveryRunRecord,
) -> Result<DiscoveryWorkerReceiptOutcome> {
    let worker_id = run.worker_id.ok_or_else(|| {
        DbError::InvalidData("external Discovery lease is missing worker identity".into())
    })?;
    let lease_id = run.claim_id.ok_or_else(|| {
        DbError::InvalidData("external Discovery lease is missing fencing token".into())
    })?;
    let lease_until = run
        .lease_until
        .ok_or_else(|| DbError::InvalidData("external Discovery lease is missing expiry".into()))?;
    let last_checkpoint = load_last_checkpoint_tx(tx, run.community_id, run.id).await?;
    Ok(DiscoveryWorkerReceiptOutcome::Lease(
        DiscoveryWorkerLeaseProjection {
            worker_id,
            lease_id,
            attempt: run.attempt,
            lease_until,
            run: run.projection(),
            last_checkpoint,
        },
    ))
}

async fn load_last_checkpoint_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    run_id: Uuid,
) -> Result<Option<DiscoveryWorkerCheckpoint>> {
    let row = sqlx::query(
        "SELECT sequence, checkpoint_kind, provider, provider_request_id, item_count \
         FROM discovery_run_checkpoints WHERE community_id=$1 AND run_id=$2 \
         ORDER BY sequence DESC LIMIT 1",
    )
    .bind(community_id.as_uuid())
    .bind(run_id)
    .fetch_optional(&mut **tx)
    .await?;
    row.as_ref().map(checkpoint_from_row).transpose()
}

fn checkpoint_from_row(row: &sqlx::postgres::PgRow) -> Result<DiscoveryWorkerCheckpoint> {
    let sequence: i32 = row.try_get("sequence")?;
    let item_count: Option<i32> = row.try_get("item_count")?;
    Ok(DiscoveryWorkerCheckpoint {
        sequence: u32::try_from(sequence).map_err(|_| {
            DbError::InvalidData("Discovery checkpoint sequence must be positive".into())
        })?,
        kind: parse_checkpoint_kind(row.try_get("checkpoint_kind")?)?,
        provider: parse_provider(row.try_get("provider")?)?,
        provider_request_id: row.try_get("provider_request_id")?,
        item_count: item_count
            .map(|value| {
                u32::try_from(value).map_err(|_| {
                    DbError::InvalidData(
                        "Discovery checkpoint item count cannot be negative".into(),
                    )
                })
            })
            .transpose()?,
    })
}

fn worker_outcome_run_id(outcome: &DiscoveryWorkerReceiptOutcome) -> Option<Uuid> {
    match outcome {
        DiscoveryWorkerReceiptOutcome::Idle => None,
        DiscoveryWorkerReceiptOutcome::Lease(lease) => Some(lease.run.run_id),
        DiscoveryWorkerReceiptOutcome::LostLease(run)
        | DiscoveryWorkerReceiptOutcome::Completed(run) => Some(run.run_id),
    }
}

fn worker_action_fingerprint(action: &DiscoveryWorkerAction) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"colony.discovery-worker-command/v1\0");
    hasher.update(worker_operation_text(action.operation()).as_bytes());
    hasher.update([0]);
    hasher.update(action.worker_id().as_bytes());
    match action {
        DiscoveryWorkerAction::Claim(_) => {}
        DiscoveryWorkerAction::Heartbeat(request) | DiscoveryWorkerAction::Complete(request) => {
            hasher.update(request.run_id.as_bytes());
            hasher.update(request.lease_id.as_bytes());
        }
        DiscoveryWorkerAction::Checkpoint(request) => {
            hasher.update(request.lease.run_id.as_bytes());
            hasher.update(request.lease.lease_id.as_bytes());
            hasher.update(checkpoint_fingerprint(&request.checkpoint));
        }
    }
    hasher.finalize().into()
}

fn checkpoint_fingerprint(checkpoint: &DiscoveryWorkerCheckpoint) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"colony.discovery-checkpoint/v1\0");
    hasher.update(checkpoint.sequence.to_be_bytes());
    hasher.update(checkpoint_kind_text(checkpoint.kind).as_bytes());
    hasher.update([0]);
    hasher.update(provider_text(checkpoint.provider).as_bytes());
    hasher.update([0]);
    if let Some(provider_request_id) = &checkpoint.provider_request_id {
        hasher.update(provider_request_id.as_bytes());
    }
    hasher.update([0]);
    if let Some(item_count) = checkpoint.item_count {
        hasher.update(item_count.to_be_bytes());
    }
    hasher.finalize().into()
}

fn worker_operation_text(operation: DiscoveryWorkerOperation) -> &'static str {
    match operation {
        DiscoveryWorkerOperation::Claim => "claim",
        DiscoveryWorkerOperation::Heartbeat => "heartbeat",
        DiscoveryWorkerOperation::Checkpoint => "checkpoint",
        DiscoveryWorkerOperation::Complete => "complete",
    }
}

fn checkpoint_kind_text(kind: DiscoveryCheckpointKind) -> &'static str {
    match kind {
        DiscoveryCheckpointKind::ProviderSubmitted => "provider_submitted",
        DiscoveryCheckpointKind::ProviderResultsReady => "provider_results_ready",
    }
}

fn parse_checkpoint_kind(value: &str) -> Result<DiscoveryCheckpointKind> {
    match value {
        "provider_submitted" => Ok(DiscoveryCheckpointKind::ProviderSubmitted),
        "provider_results_ready" => Ok(DiscoveryCheckpointKind::ProviderResultsReady),
        other => Err(DbError::InvalidData(format!(
            "unknown Discovery checkpoint kind `{other}`"
        ))),
    }
}

fn provider_text(provider: DiscoveryProvider) -> &'static str {
    match provider {
        DiscoveryProvider::Outscraper => "outscraper",
    }
}

fn parse_provider(value: &str) -> Result<DiscoveryProvider> {
    match value {
        "outscraper" => Ok(DiscoveryProvider::Outscraper),
        other => Err(DbError::InvalidData(format!(
            "unknown Discovery provider `{other}`"
        ))),
    }
}

fn command_fingerprint(operation: DiscoveryOperation, target_id: Uuid) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"colony.discovery-command/v1\0");
    hasher.update(operation_text(operation).as_bytes());
    hasher.update([0]);
    hasher.update(target_id.as_bytes());
    hasher.finalize().into()
}

fn operation_text(operation: DiscoveryOperation) -> &'static str {
    match operation {
        DiscoveryOperation::Start => "start",
        DiscoveryOperation::Status => "status",
        DiscoveryOperation::Cancel => "cancel",
    }
}

async fn load_run_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    run_id: Uuid,
    for_update: bool,
) -> Result<DiscoveryRunRecord> {
    let row = if for_update {
        sqlx::query(
            "SELECT id, community_id, campaign_id, requested_by, start_idempotency_key, state, \
             completed_steps, total_steps, cancel_requested, claim_id, lease_until, worker_id, \
             lease_owner_pubkey, last_checkpoint_sequence, attempt, terminal_reason, created_at, \
             updated_at FROM discovery_runs \
             WHERE community_id=$1 AND id=$2 FOR UPDATE",
        )
        .bind(community_id.as_uuid())
        .bind(run_id)
        .fetch_optional(&mut **tx)
        .await?
    } else {
        sqlx::query(DISCOVERY_RUN_SELECT_BY_ID)
            .bind(community_id.as_uuid())
            .bind(run_id)
            .fetch_optional(&mut **tx)
            .await?
    }
    .ok_or_else(|| DbError::NotFound("Discovery run".into()))?;
    run_from_row(&row)
}

const DISCOVERY_RUN_SELECT_BY_ID: &str =
    "SELECT id, community_id, campaign_id, requested_by, start_idempotency_key, state, \
     completed_steps, total_steps, cancel_requested, claim_id, lease_until, worker_id, \
     lease_owner_pubkey, last_checkpoint_sequence, attempt, terminal_reason, created_at, \
     updated_at FROM discovery_runs \
     WHERE community_id=$1 AND id=$2";
const DISCOVERY_RUN_SELECT_BY_IDEMPOTENCY: &str =
    "SELECT id, community_id, campaign_id, requested_by, start_idempotency_key, state, \
     completed_steps, total_steps, cancel_requested, claim_id, lease_until, worker_id, \
     lease_owner_pubkey, last_checkpoint_sequence, attempt, terminal_reason, created_at, \
     updated_at FROM discovery_runs \
     WHERE community_id=$1 AND start_idempotency_key=$2";

async fn discovery_authorization_pool(
    pool: &PgPool,
    community_id: CommunityId,
    actor_pubkey: &[u8; 32],
) -> Result<DiscoveryAuthorization> {
    let actor_hex = hex::encode(actor_pubkey);
    let row = sqlx::query(
        "SELECT COALESCE(e.active, FALSE) AS entitled, \
                rm.pubkey IS NOT NULL AS member, \
                u.agent_owner_pubkey IS NOT NULL AS is_agent, \
                COALESCE(g.active, FALSE) AS granted \
         FROM communities c \
         LEFT JOIN discovery_entitlements e ON e.community_id=c.id \
         LEFT JOIN relay_members rm ON rm.community_id=c.id AND rm.pubkey=$2 \
         LEFT JOIN users u ON u.community_id=c.id AND u.pubkey=$3 \
         LEFT JOIN discovery_actor_grants g ON g.community_id=c.id \
             AND g.actor_pubkey=$3 AND g.capability=$4 \
         WHERE c.id=$1",
    )
    .bind(community_id.as_uuid())
    .bind(actor_hex)
    .bind(actor_pubkey.as_slice())
    .bind(DISCOVERY_CAPABILITY)
    .fetch_optional(pool)
    .await?;
    authorization_from_row(row.as_ref())
}

async fn require_discovery_authorized_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    actor_pubkey: &[u8; 32],
) -> Result<()> {
    lock_discovery_authority_tx(tx, community_id).await?;
    let actor_hex = hex::encode(actor_pubkey);
    let row = sqlx::query(
        "SELECT COALESCE(e.active, FALSE) AS entitled, \
                rm.pubkey IS NOT NULL AS member, \
                u.agent_owner_pubkey IS NOT NULL AS is_agent, \
                COALESCE(g.active, FALSE) AS granted \
         FROM communities c \
         LEFT JOIN discovery_entitlements e ON e.community_id=c.id \
         LEFT JOIN relay_members rm ON rm.community_id=c.id AND rm.pubkey=$2 \
         LEFT JOIN users u ON u.community_id=c.id AND u.pubkey=$3 \
         LEFT JOIN discovery_actor_grants g ON g.community_id=c.id \
             AND g.actor_pubkey=$3 AND g.capability=$4 \
         WHERE c.id=$1",
    )
    .bind(community_id.as_uuid())
    .bind(actor_hex)
    .bind(actor_pubkey.as_slice())
    .bind(DISCOVERY_CAPABILITY)
    .fetch_optional(&mut **tx)
    .await?;
    require_authorization(authorization_from_row(row.as_ref())?)
}

async fn lock_discovery_authority_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
) -> Result<()> {
    let found = sqlx::query("SELECT id FROM communities WHERE id=$1 FOR UPDATE")
        .bind(community_id.as_uuid())
        .fetch_optional(&mut **tx)
        .await?;
    if found.is_none() {
        return Err(DbError::NotFound("community".into()));
    }
    Ok(())
}

fn authorization_from_row(row: Option<&sqlx::postgres::PgRow>) -> Result<DiscoveryAuthorization> {
    let Some(row) = row else {
        return Ok(DiscoveryAuthorization::MembershipRequired);
    };
    let entitled: bool = row.try_get("entitled")?;
    let member: bool = row.try_get("member")?;
    let is_agent: bool = row.try_get("is_agent")?;
    let granted: bool = row.try_get("granted")?;
    Ok(if !entitled {
        DiscoveryAuthorization::EntitlementInactive
    } else if !member {
        DiscoveryAuthorization::MembershipRequired
    } else if is_agent && !granted {
        DiscoveryAuthorization::AgentGrantRequired
    } else if is_agent {
        DiscoveryAuthorization::AuthorizedAgent
    } else {
        DiscoveryAuthorization::AuthorizedHuman
    })
}

fn require_authorization(authorization: DiscoveryAuthorization) -> Result<()> {
    match authorization {
        DiscoveryAuthorization::AuthorizedHuman | DiscoveryAuthorization::AuthorizedAgent => Ok(()),
        DiscoveryAuthorization::EntitlementInactive => Err(DbError::AccessDenied(
            "Discovery entitlement is inactive".into(),
        )),
        DiscoveryAuthorization::MembershipRequired => Err(DbError::AccessDenied(
            "Discovery requires relay membership".into(),
        )),
        DiscoveryAuthorization::AgentGrantRequired => Err(DbError::AccessDenied(
            "Discovery agent capability is required".into(),
        )),
    }
}

async fn stop_run_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    run_id: Uuid,
    claim_id: Uuid,
    reason: DiscoveryTerminalReason,
) -> Result<DiscoveryRunRecord> {
    let reason = terminal_reason_text(reason);
    let row = sqlx::query(
        "UPDATE discovery_runs SET state='cancelled', terminal_reason=$4, \
         claim_id=NULL, lease_until=NULL, worker_id=NULL, lease_owner_pubkey=NULL, updated_at=now() \
         WHERE community_id=$1 AND id=$2 AND claim_id=$3 \
         RETURNING id, community_id, campaign_id, requested_by, start_idempotency_key, \
         state, completed_steps, total_steps, cancel_requested, claim_id, lease_until, \
         worker_id, lease_owner_pubkey, last_checkpoint_sequence, attempt, terminal_reason, \
         created_at, updated_at",
    )
    .bind(community_id.as_uuid())
    .bind(run_id)
    .bind(claim_id)
    .bind(reason)
    .fetch_one(&mut **tx)
    .await?;
    run_from_row(&row)
}

fn run_from_row(row: &sqlx::postgres::PgRow) -> Result<DiscoveryRunRecord> {
    let requested_by: Vec<u8> = row.try_get("requested_by")?;
    let requested_by = requested_by.try_into().map_err(|_| {
        DbError::InvalidData("Discovery requested_by must be a 32-byte pubkey".into())
    })?;
    let completed_steps: i32 = row.try_get("completed_steps")?;
    let total_steps: i32 = row.try_get("total_steps")?;
    let attempt: i32 = row.try_get("attempt")?;
    let last_checkpoint_sequence: i32 = row.try_get("last_checkpoint_sequence")?;
    let lease_owner_pubkey: Option<Vec<u8>> = row.try_get("lease_owner_pubkey")?;
    let lease_owner_pubkey = lease_owner_pubkey
        .map(|value| {
            value.try_into().map_err(|_| {
                DbError::InvalidData("Discovery lease_owner_pubkey must be a 32-byte pubkey".into())
            })
        })
        .transpose()?;
    Ok(DiscoveryRunRecord {
        id: row.try_get("id")?,
        community_id: CommunityId::from_uuid(row.try_get("community_id")?),
        campaign_id: row.try_get("campaign_id")?,
        requested_by,
        start_idempotency_key: row.try_get("start_idempotency_key")?,
        state: parse_state(row.try_get("state")?)?,
        completed_steps: u32::try_from(completed_steps).map_err(|_| {
            DbError::InvalidData("Discovery completed_steps cannot be negative".into())
        })?,
        total_steps: u32::try_from(total_steps)
            .map_err(|_| DbError::InvalidData("Discovery total_steps must be positive".into()))?,
        cancel_requested: row.try_get("cancel_requested")?,
        claim_id: row.try_get("claim_id")?,
        lease_until: row.try_get("lease_until")?,
        worker_id: row.try_get("worker_id")?,
        lease_owner_pubkey,
        last_checkpoint_sequence: u32::try_from(last_checkpoint_sequence).map_err(|_| {
            DbError::InvalidData("Discovery checkpoint sequence cannot be negative".into())
        })?,
        attempt: u32::try_from(attempt)
            .map_err(|_| DbError::InvalidData("Discovery attempt cannot be negative".into()))?,
        terminal_reason: parse_terminal_reason(row.try_get("terminal_reason")?)?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn parse_state(value: &str) -> Result<DiscoveryRunState> {
    match value {
        "queued" => Ok(DiscoveryRunState::Queued),
        "running" => Ok(DiscoveryRunState::Running),
        "succeeded" => Ok(DiscoveryRunState::Succeeded),
        "cancelled" => Ok(DiscoveryRunState::Cancelled),
        "failed" => Ok(DiscoveryRunState::Failed),
        other => Err(DbError::InvalidData(format!(
            "unknown Discovery run state `{other}`"
        ))),
    }
}

fn parse_terminal_reason(value: Option<&str>) -> Result<Option<DiscoveryTerminalReason>> {
    value
        .map(|value| match value {
            "cancelled_by_actor" => Ok(DiscoveryTerminalReason::CancelledByActor),
            "entitlement_revoked" => Ok(DiscoveryTerminalReason::EntitlementRevoked),
            "executor_failed" => Ok(DiscoveryTerminalReason::ExecutorFailed),
            other => Err(DbError::InvalidData(format!(
                "unknown Discovery terminal reason `{other}`"
            ))),
        })
        .transpose()
}

fn terminal_reason_text(reason: DiscoveryTerminalReason) -> &'static str {
    match reason {
        DiscoveryTerminalReason::CancelledByActor => "cancelled_by_actor",
        DiscoveryTerminalReason::EntitlementRevoked => "entitlement_revoked",
        DiscoveryTerminalReason::ExecutorFailed => "executor_failed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DbConfig;
    use buzz_core::{
        discovery_worker::{
            DiscoveryWorkerCheckpointRequest, DiscoveryWorkerClaimRequest,
            DiscoveryWorkerLeaseRequest, DiscoveryWorkerReceipt,
        },
        CommunityId,
    };
    use buzz_sdk::discovery_worker::{
        build_discovery_worker_checkpoint_action, build_discovery_worker_claim_action,
        build_discovery_worker_complete_action, build_discovery_worker_heartbeat_action,
        build_discovery_worker_receipt,
    };
    use nostr::Keys;
    use uuid::Uuid;

    static DISCOVERY_DB_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[test]
    fn deterministic_run_ids_are_tenant_scoped() {
        let key = Uuid::from_u128(42);
        let a = CommunityId::from_uuid(Uuid::from_u128(1));
        let b = CommunityId::from_uuid(Uuid::from_u128(2));
        assert_eq!(deterministic_run_id(a, key), deterministic_run_id(a, key));
        assert_ne!(deterministic_run_id(a, key), deterministic_run_id(b, key));
    }

    #[test]
    fn persisted_state_vocabulary_is_strict() {
        assert_eq!(
            parse_state("queued").expect("queued"),
            DiscoveryRunState::Queued
        );
        assert!(parse_state("paused").is_err());
        assert_eq!(
            parse_terminal_reason(Some("entitlement_revoked")).expect("reason"),
            Some(DiscoveryTerminalReason::EntitlementRevoked)
        );
        assert!(parse_terminal_reason(Some("unknown")).is_err());
    }

    async fn database_fixture() -> (Db, CommunityId, [u8; 32], [u8; 32]) {
        let database_url = std::env::var("BUZZ_TEST_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .unwrap_or_else(|_| "postgres://buzz:buzz_dev@localhost:5432/buzz".to_owned());
        let db = Db::new(&DbConfig {
            database_url,
            max_connections: 4,
            min_connections: 0,
            ..DbConfig::default()
        })
        .await
        .expect("connect test database");
        crate::migration::run_migrations(&db.pool)
            .await
            .expect("apply migrations");
        for table in ["event_mentions", "events", "users", "relay_members"] {
            let sql = format!(
                "DELETE FROM {table} WHERE community_id IN \
                 (SELECT id FROM communities WHERE host LIKE 'discovery-%.test')"
            );
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .execute(&db.pool)
                .await
                .expect("clean abandoned Discovery test rows");
        }
        sqlx::query("DELETE FROM communities WHERE host LIKE 'discovery-%.test'")
            .execute(&db.pool)
            .await
            .expect("clean abandoned Discovery test communities");
        let community_uuid = Uuid::new_v4();
        let community = CommunityId::from_uuid(community_uuid);
        let human = Keys::generate().public_key().to_bytes();
        let agent = Keys::generate().public_key().to_bytes();
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(community_uuid)
            .bind(format!("discovery-{}.test", Uuid::new_v4()))
            .execute(&db.pool)
            .await
            .expect("insert community");
        for pubkey in [human, agent] {
            sqlx::query(
                "INSERT INTO relay_members (community_id, pubkey, role) VALUES ($1, $2, 'member')",
            )
            .bind(community_uuid)
            .bind(hex::encode(pubkey))
            .execute(&db.pool)
            .await
            .expect("insert relay member");
        }
        sqlx::query("INSERT INTO users (community_id, pubkey) VALUES ($1, $2)")
            .bind(community_uuid)
            .bind(human.as_slice())
            .execute(&db.pool)
            .await
            .expect("insert human identity");
        sqlx::query(
            "INSERT INTO users (community_id, pubkey, agent_owner_pubkey) VALUES ($1, $2, $3)",
        )
        .bind(community_uuid)
        .bind(agent.as_slice())
        .bind(human.as_slice())
        .execute(&db.pool)
        .await
        .expect("insert agent identity");
        (db, community, human, agent)
    }

    async fn apply_worker_action(
        db: &Db,
        community: CommunityId,
        actor: &Keys,
        relay: &Keys,
        action: DiscoveryWorkerAction,
        lease_duration: Duration,
    ) -> Result<DiscoveryWorkerCommandApply> {
        let builder = match &action {
            DiscoveryWorkerAction::Claim(request) => {
                build_discovery_worker_claim_action(relay.public_key(), request)
            }
            DiscoveryWorkerAction::Heartbeat(request) => {
                build_discovery_worker_heartbeat_action(relay.public_key(), request)
            }
            DiscoveryWorkerAction::Checkpoint(request) => {
                build_discovery_worker_checkpoint_action(relay.public_key(), request)
            }
            DiscoveryWorkerAction::Complete(request) => {
                build_discovery_worker_complete_action(relay.public_key(), request)
            }
        }
        .map_err(|error| DbError::InvalidData(error.to_string()))?;
        let event = builder
            .sign_with_keys(actor)
            .map_err(|error| DbError::InvalidData(error.to_string()))?;
        let operation = action.operation();
        let request_id = action.request_id();
        let idempotency_key = action.idempotency_key();
        let worker_id = action.worker_id();
        let actor_pubkey = actor.public_key();
        let action_event_id = event.id;
        db.apply_discovery_worker_command_once(
            community,
            &actor.public_key().to_bytes(),
            &action,
            &event,
            lease_duration,
            |outcome| {
                let receipt = DiscoveryWorkerReceipt {
                    operation,
                    request_id,
                    idempotency_key,
                    worker_id,
                    outcome: outcome.clone(),
                };
                build_discovery_worker_receipt(actor_pubkey, action_event_id, &receipt)
                    .map_err(|error| DbError::InvalidData(error.to_string()))?
                    .sign_with_keys(relay)
                    .map_err(|error| DbError::InvalidData(error.to_string()))
            },
        )
        .await
    }

    fn lease_request(worker_id: Uuid, run_id: Uuid, lease_id: Uuid) -> DiscoveryWorkerLeaseRequest {
        DiscoveryWorkerLeaseRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            worker_id,
            run_id,
            lease_id,
        }
    }

    fn applied_worker_outcome(
        result: DiscoveryWorkerCommandApply,
    ) -> DiscoveryWorkerReceiptOutcome {
        match result {
            DiscoveryWorkerCommandApply::Applied { outcome, .. } => outcome,
            DiscoveryWorkerCommandApply::Duplicate { .. } => {
                panic!("test action unexpectedly reused an idempotency key")
            }
        }
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn local_worker_recovers_checkpoints_and_rejects_stale_fences() {
        let _test_guard = DISCOVERY_DB_TEST_LOCK.lock().await;
        let (db, community, human, _) = database_fixture().await;
        db.set_discovery_entitlement(community, true)
            .await
            .expect("entitle workspace");
        let actor = Keys::generate();
        let relay = Keys::generate();
        let actor_bytes = actor.public_key().to_bytes();
        sqlx::query(
            "INSERT INTO relay_members (community_id, pubkey, role) VALUES ($1, $2, 'member')",
        )
        .bind(community.as_uuid())
        .bind(actor.public_key().to_hex())
        .execute(&db.pool)
        .await
        .expect("insert worker member");
        sqlx::query("INSERT INTO users (community_id, pubkey) VALUES ($1, $2)")
            .bind(community.as_uuid())
            .bind(actor_bytes.as_slice())
            .execute(&db.pool)
            .await
            .expect("insert worker identity");

        let created = db
            .create_discovery_run_once(community, &human, Uuid::new_v4(), Uuid::new_v4(), 1)
            .await
            .expect("create external-worker run");
        let run_id = match created {
            DiscoveryRunCreate::Created(run) | DiscoveryRunCreate::Existing(run) => run.id,
        };
        let first_worker = Uuid::new_v4();
        let first_claim = DiscoveryWorkerAction::Claim(DiscoveryWorkerClaimRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            worker_id: first_worker,
        });
        let first = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                first_claim,
                Duration::seconds(1),
            )
            .await
            .expect("first worker claim"),
        );
        let DiscoveryWorkerReceiptOutcome::Lease(first_lease) = first else {
            panic!("queued run must return a lease");
        };
        assert_eq!(first_lease.run.run_id, run_id);
        assert_eq!(first_lease.attempt, 1);
        assert_eq!(first_lease.last_checkpoint, None);

        let submitted = DiscoveryWorkerCheckpoint {
            sequence: 1,
            kind: DiscoveryCheckpointKind::ProviderSubmitted,
            provider: DiscoveryProvider::Outscraper,
            provider_request_id: Some("provider-job-123".into()),
            item_count: None,
        };
        let checkpoint = DiscoveryWorkerAction::Checkpoint(DiscoveryWorkerCheckpointRequest {
            lease: lease_request(first_worker, run_id, first_lease.lease_id),
            checkpoint: submitted.clone(),
        });
        let checkpointed = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                checkpoint,
                Duration::seconds(1),
            )
            .await
            .expect("commit provider reference"),
        );
        let DiscoveryWorkerReceiptOutcome::Lease(checkpointed) = checkpointed else {
            panic!("checkpoint must preserve lease");
        };
        assert_eq!(checkpointed.last_checkpoint, Some(submitted.clone()));

        tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;
        let second_worker = Uuid::new_v4();
        let second = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::Claim(DiscoveryWorkerClaimRequest {
                    request_id: Uuid::new_v4(),
                    idempotency_key: Uuid::new_v4(),
                    worker_id: second_worker,
                }),
                Duration::seconds(5),
            )
            .await
            .expect("reclaim expired lease"),
        );
        let DiscoveryWorkerReceiptOutcome::Lease(second_lease) = second else {
            panic!("expired run must be reclaimable");
        };
        assert_eq!(second_lease.run.run_id, run_id);
        assert_eq!(second_lease.attempt, 2);
        assert_eq!(second_lease.last_checkpoint, Some(submitted));

        let stale = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::Heartbeat(lease_request(
                    first_worker,
                    run_id,
                    first_lease.lease_id,
                )),
                Duration::seconds(5),
            )
            .await
            .expect("stale heartbeat is a safe lost-lease result"),
        );
        assert!(matches!(stale, DiscoveryWorkerReceiptOutcome::LostLease(_)));

        let ready = DiscoveryWorkerCheckpoint {
            sequence: 2,
            kind: DiscoveryCheckpointKind::ProviderResultsReady,
            provider: DiscoveryProvider::Outscraper,
            provider_request_id: None,
            item_count: Some(37),
        };
        let current_checkpoint = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::Checkpoint(DiscoveryWorkerCheckpointRequest {
                    lease: lease_request(second_worker, run_id, second_lease.lease_id),
                    checkpoint: ready.clone(),
                }),
                Duration::seconds(5),
            )
            .await
            .expect("current worker commits result checkpoint"),
        );
        let DiscoveryWorkerReceiptOutcome::Lease(current_checkpoint) = current_checkpoint else {
            panic!("current checkpoint must keep the lease");
        };
        assert_eq!(current_checkpoint.last_checkpoint, Some(ready));

        let completed = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::Complete(lease_request(
                    second_worker,
                    run_id,
                    second_lease.lease_id,
                )),
                Duration::seconds(5),
            )
            .await
            .expect("complete current lease"),
        );
        let DiscoveryWorkerReceiptOutcome::Completed(completed) = completed else {
            panic!("current completion must succeed");
        };
        assert_eq!(completed.state, DiscoveryRunState::Succeeded);
        assert_eq!(completed.completed_steps, completed.total_steps);

        sqlx::query("DELETE FROM event_mentions WHERE community_id=$1")
            .bind(community.as_uuid())
            .execute(&db.pool)
            .await
            .expect("clean worker receipt mentions");
        sqlx::query("DELETE FROM events WHERE community_id=$1")
            .bind(community.as_uuid())
            .execute(&db.pool)
            .await
            .expect("clean worker events");
        sqlx::query("DELETE FROM users WHERE community_id=$1")
            .bind(community.as_uuid())
            .execute(&db.pool)
            .await
            .expect("clean user fixture");
        sqlx::query("DELETE FROM relay_members WHERE community_id=$1")
            .bind(community.as_uuid())
            .execute(&db.pool)
            .await
            .expect("clean member fixture");
        sqlx::query("DELETE FROM communities WHERE id=$1")
            .bind(community.as_uuid())
            .execute(&db.pool)
            .await
            .expect("clean community fixture");
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn database_enforces_entitlement_grants_idempotency_and_fenced_stops() {
        let _test_guard = DISCOVERY_DB_TEST_LOCK.lock().await;
        let (db, community, human, agent) = database_fixture().await;
        assert_eq!(
            db.discovery_authorization(community, &human)
                .await
                .expect("authorization"),
            DiscoveryAuthorization::EntitlementInactive
        );
        db.set_discovery_entitlement(community, true)
            .await
            .expect("entitle workspace");
        assert_eq!(
            db.discovery_authorization(community, &human)
                .await
                .expect("human authorization"),
            DiscoveryAuthorization::AuthorizedHuman
        );
        assert_eq!(
            db.discovery_authorization(community, &agent)
                .await
                .expect("agent authorization"),
            DiscoveryAuthorization::AgentGrantRequired
        );
        db.set_discovery_actor_grant(community, &agent, &human, true)
            .await
            .expect("grant agent");
        assert_eq!(
            db.discovery_authorization(community, &agent)
                .await
                .expect("granted agent authorization"),
            DiscoveryAuthorization::AuthorizedAgent
        );

        let key = Uuid::new_v4();
        let campaign = Uuid::new_v4();
        let first = db
            .create_discovery_run_once(community, &human, campaign, key, 3)
            .await
            .expect("create run");
        assert!(matches!(first, DiscoveryRunCreate::Created(_)));
        let duplicate = db
            .create_discovery_run_once(community, &agent, campaign, key, 3)
            .await
            .expect("retry run");
        assert!(matches!(duplicate, DiscoveryRunCreate::Existing(_)));

        let claimed = db
            .claim_discovery_run(Duration::seconds(5))
            .await
            .expect("claim")
            .expect("run claimable");
        let advanced = db
            .advance_discovery_step(community, claimed.run.id, claimed.claim_id)
            .await
            .expect("advance");
        let DiscoveryAdvance::Advanced(progress) = advanced else {
            panic!("first step must advance");
        };
        assert_eq!(progress.completed_steps, 1);
        db.request_discovery_cancel(community, &agent, claimed.run.id)
            .await
            .expect("request cancel");
        let cancelled = db
            .get_discovery_run_authorized(community, &human, claimed.run.id)
            .await
            .expect("read immediately cancelled run");
        assert_eq!(cancelled.state, DiscoveryRunState::Cancelled);
        assert_eq!(cancelled.completed_steps, 1);
        assert_eq!(cancelled.claim_id, None);
        assert_eq!(
            cancelled.terminal_reason,
            Some(DiscoveryTerminalReason::CancelledByActor)
        );
        let stale_after_cancel = db
            .advance_discovery_step(community, claimed.run.id, claimed.claim_id)
            .await
            .expect("cancel fences the old worker immediately");
        assert!(matches!(stale_after_cancel, DiscoveryAdvance::LostLease));

        let revoke = db
            .create_discovery_run_once(community, &human, Uuid::new_v4(), Uuid::new_v4(), 2)
            .await
            .expect("create revocation run");
        let revoke_id = match revoke {
            DiscoveryRunCreate::Created(run) | DiscoveryRunCreate::Existing(run) => run.id,
        };
        let revoke_claim = db
            .claim_discovery_run(Duration::seconds(5))
            .await
            .expect("claim revocation run")
            .expect("revocation run claimable");
        assert_eq!(revoke_claim.run.id, revoke_id);
        db.set_discovery_entitlement(community, false)
            .await
            .expect("revoke entitlement");
        let row = sqlx::query(DISCOVERY_RUN_SELECT_BY_ID)
            .bind(community.as_uuid())
            .bind(revoke_id)
            .fetch_one(&db.pool)
            .await
            .expect("read immediately revoked run");
        let stopped = run_from_row(&row).expect("parse revoked run");
        assert_eq!(stopped.state, DiscoveryRunState::Cancelled);
        assert_eq!(stopped.completed_steps, 0);
        assert_eq!(stopped.claim_id, None);
        assert_eq!(
            stopped.terminal_reason,
            Some(DiscoveryTerminalReason::EntitlementRevoked)
        );
        assert!(matches!(
            db.advance_discovery_step(community, revoke_id, revoke_claim.claim_id)
                .await
                .expect("revocation fences the old worker immediately"),
            DiscoveryAdvance::LostLease
        ));

        db.set_discovery_entitlement(community, true)
            .await
            .expect("restore entitlement");
        let lease = db
            .create_discovery_run_once(community, &human, Uuid::new_v4(), Uuid::new_v4(), 2)
            .await
            .expect("create lease run");
        let lease_id = match lease {
            DiscoveryRunCreate::Created(run) | DiscoveryRunCreate::Existing(run) => run.id,
        };
        let stale = db
            .claim_discovery_run(Duration::milliseconds(50))
            .await
            .expect("first lease")
            .expect("lease run claimable");
        assert_eq!(stale.run.id, lease_id);
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
        let current = db
            .claim_discovery_run(Duration::seconds(5))
            .await
            .expect("reclaim")
            .expect("expired lease reclaimable");
        assert_eq!(current.run.completed_steps, 0);
        assert!(matches!(
            db.advance_discovery_step(community, lease_id, stale.claim_id)
                .await
                .expect("stale advance"),
            DiscoveryAdvance::LostLease
        ));
        let current_advance = db
            .advance_discovery_step(community, lease_id, current.claim_id)
            .await
            .expect("current advance");
        let DiscoveryAdvance::Advanced(current_progress) = current_advance else {
            panic!("current lease must advance");
        };
        assert_eq!(current_progress.completed_steps, 1);

        sqlx::query("DELETE FROM users WHERE community_id=$1")
            .bind(community.as_uuid())
            .execute(&db.pool)
            .await
            .expect("clean user fixture");
        sqlx::query("DELETE FROM relay_members WHERE community_id=$1")
            .bind(community.as_uuid())
            .execute(&db.pool)
            .await
            .expect("clean relay member fixture");
        sqlx::query("DELETE FROM communities WHERE id=$1")
            .bind(community.as_uuid())
            .execute(&db.pool)
            .await
            .expect("clean community fixture");
    }
}
