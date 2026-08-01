//! Private entitlement, authorization, and durable run persistence for Discovery.

use buzz_core::{
    discovery::{DiscoveryRunProjection, DiscoveryRunState, DiscoveryTerminalReason},
    CommunityId,
};
use chrono::{DateTime, Duration, Utc};
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
            "UPDATE discovery_runs SET cancel_requested=TRUE, updated_at=now() \
             WHERE community_id=$1 AND id=$2 \
             RETURNING id, community_id, campaign_id, requested_by, start_idempotency_key, \
             state, completed_steps, total_steps, cancel_requested, claim_id, lease_until, \
             attempt, terminal_reason, created_at, updated_at",
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
                 SELECT id FROM discovery_runs \
                 WHERE state IN ('queued', 'running') \
                   AND (claim_id IS NULL OR lease_until < now()) \
                 ORDER BY created_at, id \
                 FOR UPDATE SKIP LOCKED LIMIT 1 \
             ) \
             UPDATE discovery_runs r \
             SET state='running', claim_id=$1, lease_until=$2, attempt=r.attempt+1, updated_at=now() \
             FROM candidate c WHERE r.id=c.id \
             RETURNING r.id, r.community_id, r.campaign_id, r.requested_by, \
             r.start_idempotency_key, r.state, r.completed_steps, r.total_steps, \
             r.cancel_requested, r.claim_id, r.lease_until, r.attempt, r.terminal_reason, \
             r.created_at, r.updated_at",
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
             completed_steps, total_steps, cancel_requested, claim_id, lease_until, attempt, \
             terminal_reason, created_at, updated_at FROM discovery_runs \
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
                 updated_at=now() \
             WHERE community_id=$1 AND id=$2 AND claim_id=$3 \
             RETURNING id, community_id, campaign_id, requested_by, start_idempotency_key, \
             state, completed_steps, total_steps, cancel_requested, claim_id, lease_until, \
             attempt, terminal_reason, created_at, updated_at",
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
             claim_id=NULL, lease_until=NULL, updated_at=now() \
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

const DISCOVERY_RUN_SELECT_BY_ID: &str =
    "SELECT id, community_id, campaign_id, requested_by, start_idempotency_key, state, \
     completed_steps, total_steps, cancel_requested, claim_id, lease_until, attempt, \
     terminal_reason, created_at, updated_at FROM discovery_runs \
     WHERE community_id=$1 AND id=$2";
const DISCOVERY_RUN_SELECT_BY_IDEMPOTENCY: &str =
    "SELECT id, community_id, campaign_id, requested_by, start_idempotency_key, state, \
     completed_steps, total_steps, cancel_requested, claim_id, lease_until, attempt, \
     terminal_reason, created_at, updated_at FROM discovery_runs \
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
         claim_id=NULL, lease_until=NULL, updated_at=now() \
         WHERE community_id=$1 AND id=$2 AND claim_id=$3 \
         RETURNING id, community_id, campaign_id, requested_by, start_idempotency_key, \
         state, completed_steps, total_steps, cancel_requested, claim_id, lease_until, \
         attempt, terminal_reason, created_at, updated_at",
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
    use buzz_core::CommunityId;
    use nostr::Keys;
    use uuid::Uuid;

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
        for table in ["users", "relay_members"] {
            let sql = format!(
                "DELETE FROM {table} WHERE community_id IN \
                 (SELECT id FROM communities WHERE host LIKE 'discovery-%.test')"
            );
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .execute(&db.pool)
                .await
                .expect("clean abandoned Discovery test identity rows");
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

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn database_enforces_entitlement_grants_idempotency_and_fenced_stops() {
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
            .advance_discovery_step(community, claimed.run.id, claimed.claim_id)
            .await
            .expect("apply cancel");
        let DiscoveryAdvance::Cancelled(cancelled) = cancelled else {
            panic!("cancel must stop the run");
        };
        assert_eq!(cancelled.completed_steps, 1);
        assert_eq!(
            cancelled.terminal_reason,
            Some(DiscoveryTerminalReason::CancelledByActor)
        );

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
        let stopped = db
            .advance_discovery_step(community, revoke_id, revoke_claim.claim_id)
            .await
            .expect("apply entitlement stop");
        let DiscoveryAdvance::Cancelled(stopped) = stopped else {
            panic!("revocation must stop the run");
        };
        assert_eq!(stopped.completed_steps, 0);
        assert_eq!(
            stopped.terminal_reason,
            Some(DiscoveryTerminalReason::EntitlementRevoked)
        );

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
