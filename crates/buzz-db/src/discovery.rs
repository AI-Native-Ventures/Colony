//! Private entitlement, authorization, and durable run persistence for Discovery.

use buzz_core::{
    discovery::{
        DiscoveryBusinessSearchSpec, DiscoveryNanoUsd, DiscoveryOperation,
        DiscoveryRunBillingProjection, DiscoveryRunProjection, DiscoveryRunState,
        DiscoveryTerminalReason, DISCOVERY_HOSTED_GATEWAY_PROTOCOL_VERSION,
    },
    discovery_worker::{
        canonical_business_domain_digest, normalized_business_name_locality_digest,
        normalized_business_phone_digest, DiscoveryBusinessObservationInput,
        DiscoveryBusinessStatus, DiscoveryCheckpointKind, DiscoveryProvider,
        DiscoveryRunSourceFailureClass, DiscoveryRunSourceProjection, DiscoveryRunSourceStatus,
        DiscoveryWorkerAction, DiscoveryWorkerCheckpoint, DiscoveryWorkerLeaseProjection,
        DiscoveryWorkerOperation, DiscoveryWorkerReceiptOutcome,
        DiscoveryWorkerSalvagedObservationsProjection, DiscoveryWorkerStoredObservationsProjection,
    },
    discovery_workspace::{campaign_budget_fingerprint, DiscoveryCampaignInputV2},
    CommunityId, StoredEvent,
};
use chrono::{DateTime, Duration, Utc};
use nostr::{Event, PublicKey};
use sha2::{Digest, Sha256};
use sqlx::{types::Json, PgPool, Postgres, Row, Transaction};
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
    /// Durable worker and billing protocol.
    pub protocol_version: u16,
    /// Human account funding a paid run.
    pub payer_pubkey: Option<[u8; 32]>,
    /// Price snapshotted when a paid run starts.
    pub price_per_retained_lead_nanousd: Option<DiscoveryNanoUsd>,
    /// Maximum newly retained Leads this run may bill.
    pub billable_lead_limit: Option<u16>,
    /// Campaign and account amount reserved before provider work.
    pub reserved_nanousd: Option<DiscoveryNanoUsd>,
    /// Final charged amount.
    pub settled_nanousd: Option<DiscoveryNanoUsd>,
    /// Unused reservation released at settlement.
    pub released_nanousd: Option<DiscoveryNanoUsd>,
    /// Newly retained unique Lead count billed by this run.
    pub billed_retained_lead_count: Option<u16>,
    /// Exactly-once settlement reference.
    pub settlement_ref: Option<String>,
    /// Time the reservation reached terminal settlement.
    pub settled_at: Option<DateTime<Utc>>,
    /// Creation time.
    pub created_at: DateTime<Utc>,
    /// Last durable update time.
    pub updated_at: DateTime<Utc>,
}

/// Relay-only inputs for one Colony-hosted provider request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveryGatewayRunContext {
    /// Search snapshotted from the approved Campaign.
    pub business_search: DiscoveryBusinessSearchSpec,
    /// Maximum additional observations the provider may return.
    pub remaining_target: u16,
    /// Provider request identifier already fenced into the source row.
    pub request_cursor: Option<String>,
}

/// Durable outcome of one Colony-funded provider attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoveryGatewayStoredResponse {
    /// The provider accepted the request and has not returned results yet.
    Pending {
        /// Opaque provider request identifier.
        provider_request_id: String,
    },
    /// The relay retained and stored the bounded normalized result.
    Ready {
        /// Opaque provider request identifier.
        provider_request_id: String,
        /// Exact normalized observations already committed by the relay.
        observations: Vec<DiscoveryBusinessObservationInput>,
    },
    /// Colony fenced spend but cannot prove whether the provider accepted it.
    OutcomeUnknown,
}

impl DiscoveryRunRecord {
    /// Convert private persistence into the non-confidential receipt projection.
    pub fn projection(&self) -> DiscoveryRunProjection {
        let billing = self
            .payer_pubkey
            .map(|payer_pubkey| DiscoveryRunBillingProjection {
                payer_pubkey: nostr::PublicKey::from_slice(&payer_pubkey)
                    .expect("persisted Discovery payer is exactly 32 bytes"),
                price_per_retained_lead_nanousd: self
                    .price_per_retained_lead_nanousd
                    .expect("paid Discovery run has a price"),
                billable_lead_limit: self
                    .billable_lead_limit
                    .expect("paid Discovery run has a billable Lead limit"),
                reserved_nanousd: self
                    .reserved_nanousd
                    .expect("paid Discovery run has a reservation"),
                settled_nanousd: self.settled_nanousd,
                released_nanousd: self.released_nanousd,
                billed_retained_lead_count: self.billed_retained_lead_count,
                settlement_ref: self.settlement_ref.clone(),
                settled_at: self.settled_at,
            });
        DiscoveryRunProjection {
            run_id: self.id,
            campaign_id: self.campaign_id,
            protocol_version: self.protocol_version,
            state: self.state,
            completed_steps: self.completed_steps,
            total_steps: self.total_steps,
            cancel_requested: self.cancel_requested,
            terminal_reason: self.terminal_reason,
            billing,
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
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoveryCommandMutation {
    /// Insert a deterministic queued run.
    Start {
        /// Campaign reference copied from the action.
        campaign_id: Uuid,
        /// Validated immutable provider input copied from the action.
        business_search: Option<DiscoveryBusinessSearchSpec>,
        /// Server-configured fake executor step count.
        total_steps: u32,
        /// Exact signed run and worker protocol.
        protocol_version: u16,
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
    pub const fn operation(&self) -> DiscoveryOperation {
        match self {
            Self::Start { .. } => DiscoveryOperation::Start,
            Self::Status { .. } => DiscoveryOperation::Status,
            Self::Cancel { .. } => DiscoveryOperation::Cancel,
        }
    }

    fn target_id(&self, community_id: CommunityId, idempotency_key: Uuid) -> Uuid {
        match self {
            Self::Start { .. } => deterministic_run_id(community_id, idempotency_key),
            Self::Status { run_id } | Self::Cancel { run_id } => *run_id,
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
        outcome: Box<DiscoveryWorkerReceiptOutcome>,
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

struct PaidDiscoveryRunReservation {
    business_search: DiscoveryBusinessSearchSpec,
    source_config: buzz_core::discovery::DiscoverySourceConfig,
    payer_pubkey: [u8; 32],
    price_nanousd: i64,
    billable_lead_limit: i16,
    reserved_nanousd: i64,
}

async fn reserve_paid_discovery_run_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    campaign_id: Uuid,
    actor_pubkey: &[u8; 32],
) -> Result<PaidDiscoveryRunReservation> {
    let payer: Vec<u8> = sqlx::query_scalar(
        "SELECT budget_payer_pubkey FROM discovery_campaigns \
         WHERE community_id=$1 AND id=$2",
    )
    .bind(community_id.as_uuid())
    .bind(campaign_id)
    .fetch_optional(&mut **tx)
    .await?
    .flatten()
    .ok_or_else(|| DbError::AccessDenied("Campaign has no approved Credits budget".into()))?;
    let payer_pubkey: [u8; 32] = payer
        .try_into()
        .map_err(|_| DbError::InvalidData("Campaign budget payer is invalid".into()))?;
    if actor_pubkey != &payer_pubkey {
        let owned_agent: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM users WHERE community_id=$1 AND pubkey=$2 \
             AND agent_owner_pubkey=$3)",
        )
        .bind(community_id.as_uuid())
        .bind(actor_pubkey.as_slice())
        .bind(payer_pubkey.as_slice())
        .fetch_one(&mut **tx)
        .await?;
        if !owned_agent {
            return Err(DbError::AccessDenied(
                "Only the Campaign payer or their owned agent can start paid Discovery".into(),
            ));
        }
    }

    sqlx::query("INSERT INTO accounts (pubkey) VALUES ($1) ON CONFLICT (pubkey) DO NOTHING")
        .bind(payer_pubkey.as_slice())
        .execute(&mut **tx)
        .await?;
    let account_balance: i64 =
        sqlx::query_scalar("SELECT balance FROM accounts WHERE pubkey=$1 FOR UPDATE")
            .bind(payer_pubkey.as_slice())
            .fetch_one(&mut **tx)
            .await?;

    let row = sqlx::query(
        "SELECT id,name,industry_id,industry_name,vertical_id,vertical_name,query,location,target,\
         description,language,region,source_mode,source_keys,budget_state,budget_payer_pubkey,\
         budget_approved_nanousd,budget_spent_nanousd,budget_reserved_nanousd,budget_fingerprint,\
         price_per_retained_lead_nanousd FROM discovery_campaigns \
         WHERE community_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(community_id.as_uuid())
    .bind(campaign_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| DbError::NotFound("Discovery campaign".into()))?;
    let state: String = row.try_get("budget_state")?;
    if state != "active" {
        return Err(DbError::AccessDenied(
            "Campaign Credits budget is not active".into(),
        ));
    }
    let locked_payer: Vec<u8> = row.try_get("budget_payer_pubkey")?;
    if locked_payer != payer_pubkey {
        return Err(DbError::AccessDenied(
            "Campaign budget payer changed during reservation".into(),
        ));
    }
    let target_i16: i16 = row.try_get("target")?;
    let target = u16::try_from(target_i16)
        .map_err(|_| DbError::InvalidData("Discovery Campaign target is invalid".into()))?;
    let campaign = DiscoveryCampaignInputV2 {
        campaign_id,
        name: row.try_get("name")?,
        industry_id: row.try_get("industry_id")?,
        industry_name: row.try_get("industry_name")?,
        vertical_id: row.try_get("vertical_id")?,
        vertical_name: row.try_get("vertical_name")?,
        query: row.try_get("query")?,
        location: row.try_get("location")?,
        target,
        description: row.try_get("description")?,
        language: row.try_get("language")?,
        region: row.try_get("region")?,
    };
    let price_nanousd: i64 = row.try_get("price_per_retained_lead_nanousd")?;
    let price = DiscoveryNanoUsd::new(price_nanousd)
        .map_err(|error| DbError::InvalidData(error.to_string()))?;
    let expected_fingerprint = campaign_budget_fingerprint(
        &campaign,
        &PublicKey::from_slice(&payer_pubkey)
            .map_err(|_| DbError::InvalidData("Campaign budget payer is invalid".into()))?,
        price,
    )
    .map_err(|error| DbError::InvalidData(error.to_string()))?;
    let stored_fingerprint: Vec<u8> = row.try_get("budget_fingerprint")?;
    if stored_fingerprint != expected_fingerprint {
        return Err(DbError::AccessDenied(
            "Campaign changed after its Credits budget was approved".into(),
        ));
    }
    let already_searched: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM discovery_gateway_attempts \
         WHERE community_id=$1 AND campaign_id=$2)",
    )
    .bind(community_id.as_uuid())
    .bind(campaign_id)
    .fetch_one(&mut **tx)
    .await?;
    if already_searched {
        return Err(DbError::AccessDenied(
            "campaign_search_already_executed".into(),
        ));
    }

    let retained_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM discovery_campaign_leads \
         WHERE community_id=$1 AND campaign_id=$2",
    )
    .bind(community_id.as_uuid())
    .bind(campaign_id)
    .fetch_one(&mut **tx)
    .await?;
    let retained_count = u16::try_from(retained_count.min(i64::from(u16::MAX)))
        .map_err(|_| DbError::InvalidData("Discovery retained Lead count is invalid".into()))?;
    let target_capacity = target.saturating_sub(retained_count);
    if target_capacity == 0 {
        return Err(DbError::InvalidData(
            "Campaign already contains its target number of retained Leads".into(),
        ));
    }
    let approved: i64 = row.try_get("budget_approved_nanousd")?;
    let spent: i64 = row.try_get("budget_spent_nanousd")?;
    let campaign_reserved: i64 = row.try_get("budget_reserved_nanousd")?;
    let campaign_used = spent
        .checked_add(campaign_reserved)
        .ok_or_else(|| DbError::InvalidData("Campaign budget amount overflow".into()))?;
    let campaign_available = approved
        .checked_sub(campaign_used)
        .ok_or_else(|| DbError::InvalidData("Campaign budget state is invalid".into()))?;
    let payer_reserved: i64 = sqlx::query_scalar(
        "SELECT COALESCE(sum(budget_reserved_nanousd),0)::BIGINT \
         FROM discovery_campaigns WHERE budget_payer_pubkey=$1",
    )
    .bind(payer_pubkey.as_slice())
    .fetch_one(&mut **tx)
    .await?;
    let account_available = account_balance.saturating_sub(payer_reserved).max(0);
    let price_value = price.get();
    let required_nanousd = price_value
        .checked_mul(i64::from(target_capacity))
        .ok_or_else(|| DbError::InvalidData("Discovery reservation amount overflow".into()))?;
    if campaign_available < required_nanousd {
        return Err(DbError::AccessDenied("budget_exhausted".into()));
    }
    if account_available < required_nanousd {
        return Err(DbError::AccessDenied("balance_depleted".into()));
    }
    let billable_lead_limit = target_capacity;
    let reserved_nanousd = price
        .checked_mul(billable_lead_limit)
        .map_err(|error| DbError::InvalidData(error.to_string()))?
        .get();
    let campaign_after = campaign_used
        .checked_add(reserved_nanousd)
        .ok_or_else(|| DbError::InvalidData("Campaign budget amount overflow".into()))?;
    let next_state = if campaign_after == approved {
        "exhausted"
    } else {
        "active"
    };
    sqlx::query(
        "UPDATE discovery_campaigns SET \
         budget_reserved_nanousd=budget_reserved_nanousd+$3,budget_state=$4,updated_at=now() \
         WHERE community_id=$1 AND id=$2",
    )
    .bind(community_id.as_uuid())
    .bind(campaign_id)
    .bind(reserved_nanousd)
    .bind(next_state)
    .execute(&mut **tx)
    .await?;
    let source_config =
        super::discovery_workspace::load_campaign_source_config_tx(tx, community_id, campaign_id)
            .await?;
    Ok(PaidDiscoveryRunReservation {
        business_search: campaign.business_search(),
        source_config,
        payer_pubkey,
        price_nanousd,
        billable_lead_limit: i16::try_from(billable_lead_limit)
            .map_err(|_| DbError::InvalidData("Discovery billable Lead limit is invalid".into()))?,
        reserved_nanousd,
    })
}

async fn require_paid_run_owner_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    run_id: Uuid,
    actor_pubkey: &[u8; 32],
) -> Result<()> {
    let row = sqlx::query(
        "SELECT discovery_protocol_version,payer_pubkey FROM discovery_runs \
         WHERE community_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(community_id.as_uuid())
    .bind(run_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| DbError::NotFound("Discovery run".into()))?;
    let protocol_version: i16 = row.try_get("discovery_protocol_version")?;
    if protocol_version
        != i16::try_from(DISCOVERY_HOSTED_GATEWAY_PROTOCOL_VERSION)
            .expect("hosted protocol fits SMALLINT")
    {
        return Ok(());
    }
    let payer: Vec<u8> = row.try_get("payer_pubkey")?;
    if payer.as_slice() == actor_pubkey {
        return Ok(());
    }
    let owned_agent: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM users WHERE community_id=$1 AND pubkey=$2 \
         AND agent_owner_pubkey=$3)",
    )
    .bind(community_id.as_uuid())
    .bind(actor_pubkey.as_slice())
    .bind(payer.as_slice())
    .fetch_one(&mut **tx)
    .await?;
    if !owned_agent {
        return Err(DbError::AccessDenied(
            "Only the Campaign payer or their owned agent can cancel paid Discovery".into(),
        ));
    }
    Ok(())
}

async fn settle_paid_run_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    run_id: Uuid,
    lease_guard: Option<(&[u8; 32], Uuid, Uuid)>,
    state: DiscoveryRunState,
    reason: Option<DiscoveryTerminalReason>,
) -> Result<Option<DiscoveryRunRecord>> {
    let row = sqlx::query(
        "SELECT discovery_protocol_version,payer_pubkey,campaign_id FROM discovery_runs \
         WHERE community_id=$1 AND id=$2",
    )
    .bind(community_id.as_uuid())
    .bind(run_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| DbError::NotFound("Discovery run".into()))?;
    let protocol_version: i16 = row.try_get("discovery_protocol_version")?;
    if protocol_version != 3 {
        return Ok(None);
    }
    let payer: Vec<u8> = row.try_get("payer_pubkey")?;
    let campaign_id: Uuid = row.try_get("campaign_id")?;
    sqlx::query("SELECT balance FROM accounts WHERE pubkey=$1 FOR UPDATE")
        .bind(&payer)
        .fetch_one(&mut **tx)
        .await?;
    sqlx::query("SELECT id FROM discovery_campaigns WHERE community_id=$1 AND id=$2 FOR UPDATE")
        .bind(community_id.as_uuid())
        .bind(campaign_id)
        .fetch_one(&mut **tx)
        .await?;
    let current = load_run_tx(tx, community_id, run_id, true).await?;
    if current.settled_at.is_some() {
        return Ok(Some(current));
    }
    if let Some((actor_pubkey, worker_id, lease_id)) = lease_guard {
        if !worker_lease_matches(&current, actor_pubkey, worker_id, lease_id) {
            return Ok(None);
        }
    } else if !matches!(
        current.state,
        DiscoveryRunState::Queued | DiscoveryRunState::Running
    ) {
        return Ok(Some(current));
    }
    let all_sources_terminal: bool = sqlx::query_scalar(
        "SELECT NOT EXISTS (SELECT 1 FROM discovery_run_sources \
         WHERE community_id=$1 AND run_id=$2 AND status IN ('pending','active'))",
    )
    .bind(community_id.as_uuid())
    .bind(run_id)
    .fetch_one(&mut **tx)
    .await?;
    if !all_sources_terminal {
        return Err(DbError::InvalidData(
            "All Discovery sources must be terminal before settlement".into(),
        ));
    }
    let retained_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM discovery_business_observations \
         WHERE community_id=$1 AND first_run_id=$2",
    )
    .bind(community_id.as_uuid())
    .bind(run_id)
    .fetch_one(&mut **tx)
    .await?;
    let retained_count = u16::try_from(retained_count)
        .map_err(|_| DbError::InvalidData("Discovery retained Lead count is invalid".into()))?;
    let billable_limit = current
        .billable_lead_limit
        .ok_or_else(|| DbError::InvalidData("Paid run has no billable Lead limit".into()))?;
    if retained_count > billable_limit {
        return Err(DbError::InvalidData(
            "Paid run retained more Leads than its reserved limit".into(),
        ));
    }
    let price = current
        .price_per_retained_lead_nanousd
        .ok_or_else(|| DbError::InvalidData("Paid run has no price".into()))?;
    let settled = price
        .checked_mul(retained_count)
        .map_err(|error| DbError::InvalidData(error.to_string()))?
        .get();
    let reserved = current
        .reserved_nanousd
        .ok_or_else(|| DbError::InvalidData("Paid run has no reservation".into()))?
        .get();
    let released = reserved
        .checked_sub(settled)
        .ok_or_else(|| DbError::InvalidData("Paid run settlement exceeds reservation".into()))?;
    let settlement_ref = format!("discovery:{}:{}", community_id.as_uuid(), run_id);
    if retained_count > 0 {
        let inserted = sqlx::query(
            "INSERT INTO credit_ledger \
             (pubkey,delta,kind,ref,service,quantity,unit_price_nanousd,\
              discovery_community_id,discovery_campaign_id,discovery_run_id) \
             VALUES ($1,$2,'debit',$3,'discovery',$4,$5,$6,$7,$8) \
             ON CONFLICT (pubkey,ref) DO NOTHING RETURNING id",
        )
        .bind(&payer)
        .bind(-settled)
        .bind(&settlement_ref)
        .bind(i64::from(retained_count))
        .bind(price.get())
        .bind(community_id.as_uuid())
        .bind(campaign_id)
        .bind(run_id)
        .fetch_optional(&mut **tx)
        .await?;
        if inserted.is_some() {
            sqlx::query("UPDATE accounts SET balance=balance-$1,updated_at=now() WHERE pubkey=$2")
                .bind(settled)
                .bind(&payer)
                .execute(&mut **tx)
                .await?;
        } else {
            let exact: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM credit_ledger WHERE pubkey=$1 AND ref=$2 \
                 AND service='discovery' AND delta=$3 AND quantity=$4 \
                 AND unit_price_nanousd=$5 AND discovery_community_id=$6 \
                 AND discovery_campaign_id=$7 AND discovery_run_id=$8)",
            )
            .bind(&payer)
            .bind(&settlement_ref)
            .bind(-settled)
            .bind(i64::from(retained_count))
            .bind(price.get())
            .bind(community_id.as_uuid())
            .bind(campaign_id)
            .bind(run_id)
            .fetch_one(&mut **tx)
            .await?;
            if !exact {
                return Err(DbError::AccessDenied(
                    "Discovery settlement reference conflicts with another charge".into(),
                ));
            }
        }
    }
    sqlx::query(
        "UPDATE discovery_campaigns SET \
         budget_reserved_nanousd=budget_reserved_nanousd-$3,\
         budget_spent_nanousd=budget_spent_nanousd+$4,\
         budget_state=CASE WHEN budget_state IN ('paused','revoked') THEN budget_state \
             WHEN budget_spent_nanousd+$4+budget_reserved_nanousd-$3=budget_approved_nanousd \
             THEN 'exhausted' ELSE 'active' END,updated_at=now() \
         WHERE community_id=$1 AND id=$2",
    )
    .bind(community_id.as_uuid())
    .bind(campaign_id)
    .bind(reserved)
    .bind(settled)
    .execute(&mut **tx)
    .await?;
    let state_text = match state {
        DiscoveryRunState::Succeeded => "succeeded",
        DiscoveryRunState::Failed => "failed",
        DiscoveryRunState::Cancelled => "cancelled",
        _ => {
            return Err(DbError::InvalidData(
                "Paid Discovery settlement requires a terminal state".into(),
            ))
        }
    };
    let terminal_reason = reason.map(terminal_reason_text);
    let row = sqlx::query(
        "UPDATE discovery_runs SET state=$3,\
         completed_steps=CASE WHEN $3='succeeded' THEN total_steps ELSE completed_steps END,\
         cancel_requested=CASE WHEN $3='cancelled' THEN TRUE ELSE cancel_requested END,\
         terminal_reason=$4,claim_id=NULL,lease_until=NULL,worker_id=NULL,lease_owner_pubkey=NULL,\
         settled_nanousd=$5,released_nanousd=$6,billed_retained_lead_count=$7,\
         settlement_ref=$8,settled_at=now(),updated_at=now() \
         WHERE community_id=$1 AND id=$2 \
         RETURNING id,community_id,campaign_id,requested_by,start_idempotency_key,state,\
         completed_steps,total_steps,cancel_requested,claim_id,lease_until,worker_id,\
         lease_owner_pubkey,last_checkpoint_sequence,attempt,terminal_reason,\
         discovery_protocol_version,payer_pubkey,price_per_retained_lead_nanousd,\
         billable_lead_limit,reserved_nanousd,settled_nanousd,released_nanousd,\
         billed_retained_lead_count,settlement_ref,settled_at,created_at,updated_at",
    )
    .bind(community_id.as_uuid())
    .bind(run_id)
    .bind(state_text)
    .bind(terminal_reason)
    .bind(settled)
    .bind(released)
    .bind(
        i16::try_from(retained_count)
            .map_err(|_| DbError::InvalidData("Discovery retained Lead count is invalid".into()))?,
    )
    .bind(&settlement_ref)
    .fetch_one(&mut **tx)
    .await?;
    Ok(Some(run_from_row(&row)?))
}

impl Db {
    /// Authorize and derive one hosted provider request without trusting client targeting.
    pub async fn discovery_gateway_run_context(
        &self,
        community_id: CommunityId,
        actor_pubkey: &[u8; 32],
        run_id: Uuid,
        lease_id: Uuid,
        provider: DiscoveryProvider,
    ) -> Result<DiscoveryGatewayRunContext> {
        let row = sqlx::query(
            "SELECT r.state,r.discovery_protocol_version,r.claim_id,r.lease_until,\
                    r.lease_owner_pubkey,r.billable_lead_limit,r.reserved_nanousd,c.budget_state,\
                    c.query,c.location,c.language,c.region,s.status,s.request_cursor,s.position,\
                    EXISTS (SELECT 1 FROM discovery_run_sources earlier \
                            WHERE earlier.community_id=s.community_id \
                              AND earlier.run_id=s.run_id AND earlier.position<s.position \
                              AND earlier.status NOT IN \
                                  ('completed','exhausted','skipped_target_met','failed','cancelled')) \
                        AS earlier_source_open,\
                    COALESCE((SELECT sum(retained_count) FROM discovery_run_sources totals \
                              WHERE totals.community_id=r.community_id AND totals.run_id=r.id),0) \
                        AS retained_count \
             FROM discovery_runs r \
             JOIN discovery_campaigns c ON c.community_id=r.community_id AND c.id=r.campaign_id \
             JOIN discovery_run_sources s ON s.community_id=r.community_id AND s.run_id=r.id \
             WHERE r.community_id=$1 AND r.id=$2 AND s.provider=$3",
        )
        .bind(community_id.as_uuid())
        .bind(run_id)
        .bind(provider_text(provider))
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| DbError::NotFound("Discovery hosted provider source".into()))?;
        let state: String = row.try_get("state")?;
        let protocol_version: i16 = row.try_get("discovery_protocol_version")?;
        let claim_id: Option<Uuid> = row.try_get("claim_id")?;
        let lease_until: Option<DateTime<Utc>> = row.try_get("lease_until")?;
        let lease_owner: Option<Vec<u8>> = row.try_get("lease_owner_pubkey")?;
        let reserved_nanousd: Option<i64> = row.try_get("reserved_nanousd")?;
        let budget_state: String = row.try_get("budget_state")?;
        let source_state: String = row.try_get("status")?;
        let earlier_source_open: bool = row.try_get("earlier_source_open")?;
        if state != "running"
            || protocol_version
                != i16::try_from(DISCOVERY_HOSTED_GATEWAY_PROTOCOL_VERSION)
                    .expect("hosted protocol fits SMALLINT")
            || claim_id != Some(lease_id)
            || lease_until.is_none_or(|deadline| deadline <= Utc::now())
            || lease_owner.as_deref() != Some(actor_pubkey.as_slice())
            || reserved_nanousd.is_none_or(|reserved| reserved <= 0)
            || !matches!(budget_state.as_str(), "active" | "paused" | "exhausted")
            || !matches!(source_state.as_str(), "pending" | "active")
            || earlier_source_open
        {
            return Err(DbError::AccessDenied(
                "Discovery hosted provider lease is not active".into(),
            ));
        }
        let actor_is_authorized_human: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM users u \
             JOIN relay_members m ON m.community_id=u.community_id \
                  AND m.pubkey=encode(u.pubkey,'hex') \
             JOIN discovery_entitlements d ON d.community_id=u.community_id \
             WHERE u.community_id=$1 AND u.pubkey=$2 AND u.agent_owner_pubkey IS NULL \
               AND d.active AND (d.expires_at IS NULL OR d.expires_at > now()))",
        )
        .bind(community_id.as_uuid())
        .bind(actor_pubkey.as_slice())
        .fetch_one(&self.pool)
        .await?;
        if !actor_is_authorized_human {
            return Err(DbError::AccessDenied(
                "Discovery hosted provider requests require an entitled human member".into(),
            ));
        }
        let billable_limit: i16 = row.try_get("billable_lead_limit")?;
        let retained_count: i64 = row.try_get("retained_count")?;
        let remaining = i64::from(billable_limit).saturating_sub(retained_count);
        let remaining_target = u16::try_from(remaining).map_err(|_| {
            DbError::InvalidData("Discovery hosted provider capacity is invalid".into())
        })?;
        if remaining_target == 0 {
            return Err(DbError::AccessDenied(
                "Discovery hosted provider capacity is exhausted".into(),
            ));
        }
        let business_search = DiscoveryBusinessSearchSpec {
            query: row.try_get("query")?,
            location: row.try_get("location")?,
            limit: remaining_target,
            language: row.try_get("language")?,
            region: row.try_get("region")?,
        };
        business_search
            .validate()
            .map_err(|error| DbError::InvalidData(error.to_string()))?;
        Ok(DiscoveryGatewayRunContext {
            business_search,
            remaining_target,
            request_cursor: row.try_get("request_cursor")?,
        })
    }

    /// Fence one hosted provider submission before the paid request leaves Colony.
    pub async fn fence_discovery_gateway_submission(
        &self,
        community_id: CommunityId,
        actor_pubkey: &[u8; 32],
        run_id: Uuid,
        lease_id: Uuid,
        provider: DiscoveryProvider,
        fence: &str,
    ) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT balance FROM accounts WHERE pubkey=$1 FOR UPDATE")
            .bind(actor_pubkey.as_slice())
            .fetch_optional(&mut *tx)
            .await?;
        let inserted = sqlx::query(
            "INSERT INTO discovery_gateway_attempts \
             (community_id,campaign_id,run_id,payer_pubkey,provider,intent_id,status) \
             SELECT r.community_id,r.campaign_id,r.id,r.payer_pubkey,s.provider,$6,'intent' \
             FROM discovery_runs r \
             JOIN discovery_campaigns c ON c.community_id=r.community_id AND c.id=r.campaign_id \
             JOIN discovery_run_sources s ON s.community_id=r.community_id AND s.run_id=r.id \
             WHERE r.community_id=$1 AND r.id=$2 AND s.provider=$3 \
               AND s.request_cursor IS NULL AND s.status IN ('pending','active') \
               AND r.state='running' AND r.discovery_protocol_version=$4 \
               AND r.claim_id=$5 AND r.lease_until > now() \
               AND r.lease_owner_pubkey=$7 AND r.reserved_nanousd > 0 \
               AND c.budget_state IN ('active','paused','exhausted') \
               AND NOT EXISTS (SELECT 1 FROM discovery_run_sources earlier \
                               WHERE earlier.community_id=s.community_id \
                                 AND earlier.run_id=s.run_id AND earlier.position<s.position \
                                 AND earlier.status NOT IN \
                                     ('completed','exhausted','skipped_target_met','failed','cancelled')) \
               AND EXISTS (SELECT 1 FROM users u WHERE u.community_id=$1 \
                           AND u.pubkey=$7 AND u.agent_owner_pubkey IS NULL) \
               AND EXISTS (SELECT 1 FROM relay_members m WHERE m.community_id=$1 \
                           AND m.pubkey=encode($7::bytea,'hex')) \
               AND EXISTS (SELECT 1 FROM discovery_entitlements d WHERE d.community_id=$1 \
                           AND d.active AND (d.expires_at IS NULL OR d.expires_at > now())) \
               AND (SELECT count(*) FROM discovery_gateway_attempts recent \
                    WHERE recent.payer_pubkey=r.payer_pubkey \
                      AND recent.created_at > now()-INTERVAL '24 hours') < 60 \
             ON CONFLICT (community_id,campaign_id,provider) DO NOTHING \
             RETURNING run_id",
        )
        .bind(community_id.as_uuid())
        .bind(run_id)
        .bind(provider_text(provider))
        .bind(
            i16::try_from(DISCOVERY_HOSTED_GATEWAY_PROTOCOL_VERSION)
                .expect("hosted protocol fits SMALLINT"),
        )
        .bind(lease_id)
        .bind(fence)
        .bind(actor_pubkey.as_slice())
        .fetch_optional(&mut *tx)
        .await?;
        if inserted.is_none() {
            tx.rollback().await?;
            return Ok(false);
        }
        let updated = sqlx::query(
            "UPDATE discovery_run_sources SET status='active',request_cursor=$4,\
                 request_count=GREATEST(request_count,1),\
                 started_at=COALESCE(started_at,now()),failure_class=NULL,updated_at=now() \
             WHERE community_id=$1 AND run_id=$2 AND provider=$3 AND request_cursor IS NULL \
               AND status IN ('pending','active')",
        )
        .bind(community_id.as_uuid())
        .bind(run_id)
        .bind(provider_text(provider))
        .bind(fence)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(false);
        }
        tx.commit().await?;
        Ok(true)
    }

    /// Atomically replace a pre-spend fence with the provider response and
    /// retain every billable observation before it is returned to a client.
    pub async fn record_discovery_gateway_response(
        &self,
        community_id: CommunityId,
        actor_pubkey: &[u8; 32],
        run_id: Uuid,
        lease_id: Uuid,
        provider: DiscoveryProvider,
        expected_cursor: &str,
        provider_request_id: &str,
        observations: Option<&[DiscoveryBusinessObservationInput]>,
    ) -> Result<DiscoveryGatewayStoredResponse> {
        let mut tx = self.pool.begin().await?;
        let attempt = sqlx::query(
            "SELECT status,intent_id,provider_request_id,observations \
             FROM discovery_gateway_attempts \
             WHERE community_id=$1 AND run_id=$2 AND provider=$3 FOR UPDATE",
        )
        .bind(community_id.as_uuid())
        .bind(run_id)
        .bind(provider_text(provider))
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| DbError::AccessDenied("Discovery provider request is not fenced".into()))?;
        let prior_status: String = attempt.try_get("status")?;
        let stored_intent: String = attempt.try_get("intent_id")?;
        let prior_request_id: Option<String> = attempt.try_get("provider_request_id")?;
        if prior_status == "ready" {
            let stored: Json<Vec<DiscoveryBusinessObservationInput>> =
                attempt.try_get("observations")?;
            tx.commit().await?;
            return Ok(DiscoveryGatewayStoredResponse::Ready {
                provider_request_id: prior_request_id.ok_or_else(|| {
                    DbError::InvalidData("Stored Discovery response has no provider ID".into())
                })?,
                observations: stored.0,
            });
        }
        if prior_status == "pending"
            && prior_request_id.as_deref() == Some(provider_request_id)
            && observations.is_none()
        {
            tx.commit().await?;
            return Ok(DiscoveryGatewayStoredResponse::Pending {
                provider_request_id: provider_request_id.to_owned(),
            });
        }
        let source_cursor: Option<String> = sqlx::query_scalar(
            "SELECT request_cursor FROM discovery_run_sources \
             WHERE community_id=$1 AND run_id=$2 AND provider=$3 FOR UPDATE",
        )
        .bind(community_id.as_uuid())
        .bind(run_id)
        .bind(provider_text(provider))
        .fetch_optional(&mut *tx)
        .await?
        .flatten();
        let expected_matches = source_cursor.as_deref() == Some(expected_cursor)
            && ((prior_status == "intent" && stored_intent == expected_cursor)
                || (prior_status == "pending"
                    && prior_request_id.as_deref() == Some(expected_cursor)));
        if !expected_matches {
            return Err(DbError::AccessDenied(
                "Discovery provider response conflicts with committed state".into(),
            ));
        }

        let Some(observations) = observations else {
            sqlx::query(
                "UPDATE discovery_run_sources SET request_cursor=$4,updated_at=now() \
                 WHERE community_id=$1 AND run_id=$2 AND provider=$3",
            )
            .bind(community_id.as_uuid())
            .bind(run_id)
            .bind(provider_text(provider))
            .bind(provider_request_id)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "UPDATE discovery_gateway_attempts \
                 SET provider_request_id=$4,status='pending',updated_at=now() \
                 WHERE community_id=$1 AND run_id=$2 AND provider=$3",
            )
            .bind(community_id.as_uuid())
            .bind(run_id)
            .bind(provider_text(provider))
            .bind(provider_request_id)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            return Ok(DiscoveryGatewayStoredResponse::Pending {
                provider_request_id: provider_request_id.to_owned(),
            });
        };

        let capacity_row = sqlx::query(
            "SELECT r.billable_lead_limit,\
                    r.state,r.discovery_protocol_version,r.claim_id,r.lease_until,\
                    r.lease_owner_pubkey,r.reserved_nanousd,r.settled_at,\
                    c.budget_state,c.budget_reserved_nanousd,\
                    c.budget_payer_pubkey,r.payer_pubkey,\
                    EXISTS (SELECT 1 FROM discovery_entitlements d \
                            WHERE d.community_id=r.community_id AND d.active \
                              AND (d.expires_at IS NULL OR d.expires_at > now())) \
                        AS entitlement_active,\
                    COALESCE((SELECT sum(retained_count) FROM discovery_run_sources totals \
                              WHERE totals.community_id=r.community_id \
                                AND totals.run_id=r.id),0) AS retained_count \
             FROM discovery_runs r \
             JOIN discovery_campaigns c ON c.community_id=r.community_id AND c.id=r.campaign_id \
             WHERE r.community_id=$1 AND r.id=$2 FOR UPDATE OF r,c",
        )
        .bind(community_id.as_uuid())
        .bind(run_id)
        .fetch_one(&mut *tx)
        .await?;
        let state: String = capacity_row.try_get("state")?;
        let protocol_version: i16 = capacity_row.try_get("discovery_protocol_version")?;
        let claim_id: Option<Uuid> = capacity_row.try_get("claim_id")?;
        let lease_until: Option<DateTime<Utc>> = capacity_row.try_get("lease_until")?;
        let lease_owner: Option<Vec<u8>> = capacity_row.try_get("lease_owner_pubkey")?;
        let reserved_nanousd: Option<i64> = capacity_row.try_get("reserved_nanousd")?;
        let settled_at: Option<DateTime<Utc>> = capacity_row.try_get("settled_at")?;
        let budget_state: String = capacity_row.try_get("budget_state")?;
        let campaign_reserved: i64 = capacity_row.try_get("budget_reserved_nanousd")?;
        let campaign_payer: Option<Vec<u8>> = capacity_row.try_get("budget_payer_pubkey")?;
        let run_payer: Option<Vec<u8>> = capacity_row.try_get("payer_pubkey")?;
        let entitlement_active: bool = capacity_row.try_get("entitlement_active")?;
        if state != "running"
            || protocol_version
                != i16::try_from(DISCOVERY_HOSTED_GATEWAY_PROTOCOL_VERSION)
                    .expect("hosted protocol fits SMALLINT")
            || claim_id != Some(lease_id)
            || lease_until.is_none_or(|deadline| deadline <= Utc::now())
            || lease_owner.as_deref() != Some(actor_pubkey.as_slice())
            || reserved_nanousd.is_none_or(|reserved| reserved <= 0)
            || settled_at.is_some()
            || !matches!(budget_state.as_str(), "active" | "paused" | "exhausted")
            || campaign_reserved < reserved_nanousd.unwrap_or_default()
            || campaign_payer.is_none()
            || campaign_payer != run_payer
            || !entitlement_active
        {
            return Err(DbError::AccessDenied(
                "Discovery hosted provider response lease is no longer active".into(),
            ));
        }
        let billable_limit: i16 = capacity_row.try_get("billable_lead_limit")?;
        let already_retained: i64 = capacity_row.try_get("retained_count")?;
        let remaining = i64::from(billable_limit).saturating_sub(already_retained);
        let remaining = u16::try_from(remaining).map_err(|_| {
            DbError::InvalidData("Discovery hosted provider capacity is invalid".into())
        })?;
        let mut accepted_count = 0_u16;
        let mut existing_count = 0_u16;
        let mut stored_observations = Vec::new();
        for observation in observations {
            if accepted_count == remaining || stored_observations.len() == 500 {
                break;
            }
            if observation.provider != provider {
                return Err(DbError::AccessDenied(
                    "Discovery provider response contains another provider".into(),
                ));
            }
            observation
                .validate()
                .map_err(|error| DbError::InvalidData(error.to_string()))?;
            let fingerprint = observation_fingerprint(observation)?;
            let inserted = insert_business_observation_tx(
                &mut tx,
                community_id,
                run_id,
                observation,
                &fingerprint,
            )
            .await?;
            if inserted {
                accepted_count = accepted_count.checked_add(1).ok_or_else(|| {
                    DbError::InvalidData("Discovery accepted count overflow".into())
                })?;
            } else {
                existing_count = existing_count.checked_add(1).ok_or_else(|| {
                    DbError::InvalidData("Discovery existing count overflow".into())
                })?;
            }
            stored_observations.push(observation.clone());
        }
        let returned_count = i32::try_from(stored_observations.len()).map_err(|_| {
            DbError::InvalidData("Discovery provider result count is invalid".into())
        })?;
        sqlx::query(
            "UPDATE discovery_run_sources SET request_cursor=$4,\
                 retained_count=retained_count+$5,duplicate_count=duplicate_count+$6,\
                 updated_at=now() \
             WHERE community_id=$1 AND run_id=$2 AND provider=$3",
        )
        .bind(community_id.as_uuid())
        .bind(run_id)
        .bind(provider_text(provider))
        .bind(provider_request_id)
        .bind(i32::from(accepted_count))
        .bind(i32::from(existing_count))
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO discovery_source_usage \
             (community_id,run_id,provider,provider_request_id,stored_count,existing_count,returned_count) \
             VALUES ($1,$2,$3,$4,$5,$6,$7) \
             ON CONFLICT (community_id,run_id,provider) DO UPDATE SET \
               provider_request_id=EXCLUDED.provider_request_id,\
               stored_count=EXCLUDED.stored_count,existing_count=EXCLUDED.existing_count,\
               returned_count=EXCLUDED.returned_count,updated_at=now()",
        )
        .bind(community_id.as_uuid())
        .bind(run_id)
        .bind(provider_text(provider))
        .bind(provider_request_id)
        .bind(i32::from(accepted_count))
        .bind(i32::from(existing_count))
        .bind(returned_count)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE discovery_gateway_attempts SET provider_request_id=$4,status='ready',\
                 observations=$5,returned_count=$6,retained_count=$7,duplicate_count=$8,\
                 updated_at=now() WHERE community_id=$1 AND run_id=$2 AND provider=$3",
        )
        .bind(community_id.as_uuid())
        .bind(run_id)
        .bind(provider_text(provider))
        .bind(provider_request_id)
        .bind(Json(&stored_observations))
        .bind(returned_count)
        .bind(i32::from(accepted_count))
        .bind(i32::from(existing_count))
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(DiscoveryGatewayStoredResponse::Ready {
            provider_request_id: provider_request_id.to_owned(),
            observations: stored_observations,
        })
    }

    /// Load a previously fenced provider response for idempotent client replay.
    pub async fn discovery_gateway_stored_response(
        &self,
        community_id: CommunityId,
        run_id: Uuid,
        provider: DiscoveryProvider,
    ) -> Result<Option<DiscoveryGatewayStoredResponse>> {
        let row = sqlx::query(
            "SELECT status,provider_request_id,observations \
             FROM discovery_gateway_attempts \
             WHERE community_id=$1 AND run_id=$2 AND provider=$3",
        )
        .bind(community_id.as_uuid())
        .bind(run_id)
        .bind(provider_text(provider))
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let status: String = row.try_get("status")?;
        Ok(Some(match status.as_str() {
            "intent" => DiscoveryGatewayStoredResponse::OutcomeUnknown,
            "pending" => DiscoveryGatewayStoredResponse::Pending {
                provider_request_id: row.try_get("provider_request_id")?,
            },
            "ready" => {
                let observations: Json<Vec<DiscoveryBusinessObservationInput>> =
                    row.try_get("observations")?;
                DiscoveryGatewayStoredResponse::Ready {
                    provider_request_id: row.try_get("provider_request_id")?,
                    observations: observations.0,
                }
            }
            _ => {
                return Err(DbError::InvalidData(
                    "Discovery provider response state is invalid".into(),
                ))
            }
        }))
    }

    /// Admit one hosted provider poll with a durable per-source cadence fence.
    pub async fn admit_discovery_gateway_poll(
        &self,
        community_id: CommunityId,
        actor_pubkey: &[u8; 32],
        run_id: Uuid,
        lease_id: Uuid,
        provider: DiscoveryProvider,
        provider_request_id: &str,
    ) -> Result<bool> {
        let updated = sqlx::query(
            "UPDATE discovery_run_sources s \
             SET provider_poll_after=now()+INTERVAL '1 second',updated_at=now() \
             FROM discovery_runs r \
             WHERE s.community_id=$1 AND s.run_id=$2 AND s.provider=$3 \
               AND s.request_cursor=$4 AND s.request_cursor NOT LIKE 'colony_pending_%' \
               AND (s.provider_poll_after IS NULL OR s.provider_poll_after <= now()) \
               AND r.community_id=s.community_id AND r.id=s.run_id \
               AND r.state='running' AND r.discovery_protocol_version=$5 \
               AND r.claim_id=$6 AND r.lease_until > now() AND r.lease_owner_pubkey=$7",
        )
        .bind(community_id.as_uuid())
        .bind(run_id)
        .bind(provider_text(provider))
        .bind(provider_request_id)
        .bind(
            i16::try_from(DISCOVERY_HOSTED_GATEWAY_PROTOCOL_VERSION)
                .expect("hosted protocol fits SMALLINT"),
        )
        .bind(lease_id)
        .bind(actor_pubkey.as_slice())
        .execute(&self.pool)
        .await?;
        Ok(updated.rows_affected() == 1)
    }

    /// Manually provision or revoke a workspace Discovery entitlement.
    pub async fn set_discovery_entitlement(
        &self,
        community_id: CommunityId,
        active: bool,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        lock_discovery_authority_tx(&mut tx, community_id).await?;
        sqlx::query(
            "INSERT INTO discovery_entitlements (community_id, active, expires_at, updated_at) \
             VALUES ($1, $2, NULL, now()) \
             ON CONFLICT (community_id) DO UPDATE \
             SET active=EXCLUDED.active, expires_at=NULL, updated_at=now()",
        )
        .bind(community_id.as_uuid())
        .bind(active)
        .execute(&mut *tx)
        .await?;
        if !active {
            sqlx::query(
                "UPDATE discovery_run_sources SET status='cancelled', failure_class='cancelled', \
                     started_at=COALESCE(started_at,now()), finished_at=COALESCE(finished_at,now()), \
                     updated_at=now() \
                 WHERE community_id=$1 AND status IN ('pending','active') \
                   AND EXISTS (SELECT 1 FROM discovery_runs r \
                               WHERE r.community_id=$1 AND r.id=discovery_run_sources.run_id \
                                 AND r.state IN ('queued','running'))",
            )
            .bind(community_id.as_uuid())
            .execute(&mut *tx)
            .await?;
            let paid_run_ids: Vec<Uuid> = sqlx::query_scalar(
                "SELECT id FROM discovery_runs WHERE community_id=$1 \
                 AND discovery_protocol_version=3 AND state IN ('queued','running') \
                 ORDER BY id",
            )
            .bind(community_id.as_uuid())
            .fetch_all(&mut *tx)
            .await?;
            for run_id in paid_run_ids {
                settle_paid_run_tx(
                    &mut tx,
                    community_id,
                    run_id,
                    None,
                    DiscoveryRunState::Cancelled,
                    Some(DiscoveryTerminalReason::EntitlementRevoked),
                )
                .await?;
            }
            sqlx::query(
                "UPDATE discovery_runs \
                 SET state='cancelled', cancel_requested=TRUE, \
                     terminal_reason='entitlement_revoked', claim_id=NULL, lease_until=NULL, \
                     worker_id=NULL, lease_owner_pubkey=NULL, updated_at=now() \
                 WHERE community_id=$1 AND discovery_protocol_version<3 \
                   AND state IN ('queued','running')",
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
        business_search: &DiscoveryBusinessSearchSpec,
    ) -> Result<DiscoveryRunCreate> {
        if total_steps == 0 || total_steps > i32::MAX as u32 {
            return Err(DbError::InvalidData(
                "Discovery total steps must be between 1 and i32::MAX".into(),
            ));
        }
        business_search
            .validate()
            .map_err(|error| DbError::InvalidData(error.to_string()))?;
        let mut tx = self.pool.begin().await?;
        require_discovery_authorized_tx(&mut tx, community_id, actor_pubkey).await?;
        super::discovery_workspace::require_campaign_search_tx(
            &mut tx,
            community_id,
            campaign_id,
            business_search,
        )
        .await?;
        let source_config = super::discovery_workspace::load_campaign_source_config_tx(
            &mut tx,
            community_id,
            campaign_id,
        )
        .await?;
        let run_id = deterministic_run_id(community_id, idempotency_key);
        require_no_other_active_campaign_run_tx(&mut tx, community_id, campaign_id, run_id).await?;
        let inserted = sqlx::query(
            "INSERT INTO discovery_runs \
             (id, community_id, campaign_id, requested_by, start_idempotency_key, total_steps, \
              discovery_protocol_version) \
             VALUES ($1, $2, $3, $4, $5, $6, 2) \
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
        if inserted {
            sqlx::query(
                "INSERT INTO discovery_run_business_searches \
                 (community_id, run_id, query, location, result_limit, language, region) \
                 VALUES ($1,$2,$3,$4,$5,$6,$7)",
            )
            .bind(community_id.as_uuid())
            .bind(run_id)
            .bind(&business_search.query)
            .bind(&business_search.location)
            .bind(i16::try_from(business_search.limit).map_err(|_| {
                DbError::InvalidData("Discovery result limit exceeds SMALLINT".into())
            })?)
            .bind(&business_search.language)
            .bind(business_search.region.as_deref())
            .execute(&mut *tx)
            .await?;
            super::discovery_workspace::insert_run_source_plan_tx(
                &mut tx,
                community_id,
                run_id,
                &source_config,
            )
            .await?;
        }
        let row = sqlx::query(DISCOVERY_RUN_SELECT_BY_IDEMPOTENCY)
            .bind(community_id.as_uuid())
            .bind(idempotency_key)
            .fetch_one(&mut *tx)
            .await?;
        let run = run_from_row(&row)?;
        let stored_search = load_business_search_tx(&mut tx, community_id, run.id).await?;
        let stored_sources =
            super::discovery_workspace::load_run_source_config_tx(&mut tx, community_id, run.id)
                .await?;
        if run.campaign_id != campaign_id
            || run.total_steps != total_steps
            || stored_search != *business_search
            || stored_sources != source_config
        {
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
        let fingerprint = command_fingerprint(&mutation, target_id);
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
                business_search,
                total_steps,
                protocol_version,
                accepted_at,
            } => {
                if total_steps == 0 || total_steps > i32::MAX as u32 {
                    return Err(DbError::InvalidData(
                        "Discovery total steps must be between 1 and i32::MAX".into(),
                    ));
                }
                let (business_search, source_config, paid) = if protocol_version == 3 {
                    let paid = reserve_paid_discovery_run_tx(
                        &mut tx,
                        community_id,
                        campaign_id,
                        actor_pubkey,
                    )
                    .await?;
                    (
                        paid.business_search.clone(),
                        paid.source_config.clone(),
                        Some(paid),
                    )
                } else {
                    let business_search = business_search.ok_or_else(|| {
                        DbError::InvalidData(
                            "Released Discovery runs require an explicit Campaign search".into(),
                        )
                    })?;
                    business_search
                        .validate()
                        .map_err(|error| DbError::InvalidData(error.to_string()))?;
                    super::discovery_workspace::require_campaign_search_tx(
                        &mut tx,
                        community_id,
                        campaign_id,
                        &business_search,
                    )
                    .await?;
                    let source_config = super::discovery_workspace::load_campaign_source_config_tx(
                        &mut tx,
                        community_id,
                        campaign_id,
                    )
                    .await?;
                    if protocol_version == 1 && !source_config.is_default() {
                        return Err(DbError::InvalidData(
                            "This Discovery client does not support this Campaign source plan"
                                .into(),
                        ));
                    }
                    (business_search, source_config, None)
                };
                require_no_other_active_campaign_run_tx(
                    &mut tx,
                    community_id,
                    campaign_id,
                    target_id,
                )
                .await?;
                let row = sqlx::query(
                    "INSERT INTO discovery_runs \
                     (community_id, id, campaign_id, requested_by, start_idempotency_key, \
                      total_steps, discovery_protocol_version,payer_pubkey,\
                      price_per_retained_lead_nanousd,billable_lead_limit,reserved_nanousd,\
                      created_at, updated_at) \
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) \
                     RETURNING id, community_id, campaign_id, requested_by, start_idempotency_key, \
                     state, completed_steps, total_steps, cancel_requested, claim_id, lease_until, \
                     worker_id, lease_owner_pubkey, last_checkpoint_sequence, attempt, \
                     terminal_reason,discovery_protocol_version,payer_pubkey,\
                     price_per_retained_lead_nanousd,billable_lead_limit,reserved_nanousd,\
                     settled_nanousd,released_nanousd,billed_retained_lead_count,settlement_ref,\
                     settled_at,created_at,updated_at",
                )
                .bind(community_id.as_uuid())
                .bind(target_id)
                .bind(campaign_id)
                .bind(actor_pubkey.as_slice())
                .bind(idempotency_key)
                .bind(total_steps as i32)
                .bind(i16::try_from(protocol_version).map_err(|_| {
                    DbError::InvalidData("Discovery protocol version is invalid".into())
                })?)
                .bind(paid.as_ref().map(|value| value.payer_pubkey.as_slice()))
                .bind(paid.as_ref().map(|value| value.price_nanousd))
                .bind(paid.as_ref().map(|value| value.billable_lead_limit))
                .bind(paid.as_ref().map(|value| value.reserved_nanousd))
                .bind(accepted_at)
                .fetch_one(&mut *tx)
                .await?;
                let run = run_from_row(&row)?;
                sqlx::query(
                    "INSERT INTO discovery_run_business_searches \
                     (community_id, run_id, query, location, result_limit, language, region) \
                     VALUES ($1,$2,$3,$4,$5,$6,$7)",
                )
                .bind(community_id.as_uuid())
                .bind(run.id)
                .bind(&business_search.query)
                .bind(&business_search.location)
                .bind(i16::try_from(business_search.limit).map_err(|_| {
                    DbError::InvalidData("Discovery result limit exceeds SMALLINT".into())
                })?)
                .bind(&business_search.language)
                .bind(business_search.region.as_deref())
                .execute(&mut *tx)
                .await?;
                if protocol_version >= 2 {
                    super::discovery_workspace::insert_run_source_plan_tx(
                        &mut tx,
                        community_id,
                        run.id,
                        &source_config,
                    )
                    .await?;
                }
                run
            }
            DiscoveryCommandMutation::Status { run_id } => {
                load_run_tx(&mut tx, community_id, run_id, false).await?
            }
            DiscoveryCommandMutation::Cancel { run_id } => {
                require_paid_run_owner_tx(&mut tx, community_id, run_id, actor_pubkey).await?;
                sqlx::query(
                    "UPDATE discovery_run_sources SET status='cancelled', failure_class='cancelled', \
                         started_at=COALESCE(started_at,now()), \
                         finished_at=COALESCE(finished_at,now()), updated_at=now() \
                     WHERE community_id=$1 AND run_id=$2 AND status IN ('pending','active') \
                       AND EXISTS (SELECT 1 FROM discovery_runs r \
                                   WHERE r.community_id=$1 AND r.id=$2 \
                                     AND r.state IN ('queued','running'))",
                )
                .bind(community_id.as_uuid())
                .bind(run_id)
                .execute(&mut *tx)
                .await?;
                if let Some(run) = settle_paid_run_tx(
                    &mut tx,
                    community_id,
                    run_id,
                    None,
                    DiscoveryRunState::Cancelled,
                    Some(DiscoveryTerminalReason::CancelledByActor),
                )
                .await?
                {
                    run
                } else {
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
                     terminal_reason,discovery_protocol_version,payer_pubkey,\
                     price_per_retained_lead_nanousd,billable_lead_limit,reserved_nanousd,\
                     settled_nanousd,released_nanousd,billed_retained_lead_count,settlement_ref,\
                     settled_at,created_at,updated_at",
                )
                .bind(community_id.as_uuid())
                .bind(run_id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(|| DbError::NotFound("Discovery run".into()))?;
                    run_from_row(&row)?
                }
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
        if let DiscoveryWorkerAction::Claim(request) = action {
            request
                .validate()
                .map_err(|error| DbError::InvalidData(error.to_string()))?;
        }

        let mut tx = self.pool.begin().await?;
        require_discovery_worker_authorized_tx(&mut tx, community_id, actor_pubkey).await?;
        let operation = action.operation();
        let fingerprint = worker_action_fingerprint(action)?;
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
            outcome: Box::new(outcome),
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
        require_paid_run_owner_tx(&mut tx, community_id, run_id, actor_pubkey).await?;
        sqlx::query(
            "UPDATE discovery_run_sources SET status='cancelled', failure_class='cancelled', \
                 started_at=COALESCE(started_at,now()), finished_at=COALESCE(finished_at,now()), \
                 updated_at=now() \
             WHERE community_id=$1 AND run_id=$2 AND status IN ('pending','active') \
               AND EXISTS (SELECT 1 FROM discovery_runs r \
                           WHERE r.community_id=$1 AND r.id=$2 \
                             AND r.state IN ('queued','running'))",
        )
        .bind(community_id.as_uuid())
        .bind(run_id)
        .execute(&mut *tx)
        .await?;
        if let Some(run) = settle_paid_run_tx(
            &mut tx,
            community_id,
            run_id,
            None,
            DiscoveryRunState::Cancelled,
            Some(DiscoveryTerminalReason::CancelledByActor),
        )
        .await?
        {
            tx.commit().await?;
            return Ok(run);
        }
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
             worker_id,lease_owner_pubkey,last_checkpoint_sequence,attempt,terminal_reason,\
             discovery_protocol_version,payer_pubkey,price_per_retained_lead_nanousd,\
             billable_lead_limit,reserved_nanousd,settled_nanousd,released_nanousd,\
             billed_retained_lead_count,settlement_ref,settled_at,created_at,updated_at",
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
                   AND discovery_protocol_version=1 \
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
             r.last_checkpoint_sequence,r.attempt,r.terminal_reason,r.discovery_protocol_version,\
             r.payer_pubkey,r.price_per_retained_lead_nanousd,r.billable_lead_limit,\
             r.reserved_nanousd,r.settled_nanousd,r.released_nanousd,\
             r.billed_retained_lead_count,r.settlement_ref,r.settled_at,r.created_at,r.updated_at",
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
             lease_owner_pubkey, last_checkpoint_sequence, attempt, terminal_reason, \
             discovery_protocol_version,payer_pubkey,price_per_retained_lead_nanousd,\
             billable_lead_limit,reserved_nanousd,settled_nanousd,released_nanousd,\
             billed_retained_lead_count,settlement_ref,settled_at,created_at,updated_at \
             FROM discovery_runs \
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
            "SELECT active AND (expires_at IS NULL OR expires_at > now()) \
             FROM discovery_entitlements WHERE community_id=$1 FOR UPDATE",
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
             worker_id,lease_owner_pubkey,last_checkpoint_sequence,attempt,terminal_reason,\
             discovery_protocol_version,payer_pubkey,price_per_retained_lead_nanousd,\
             billable_lead_limit,reserved_nanousd,settled_nanousd,released_nanousd,\
             billed_retained_lead_count,settlement_ref,settled_at,created_at,updated_at",
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
            let worker_protocol_version =
                i16::try_from(request.protocol_version).map_err(|_| {
                    DbError::InvalidData("Discovery worker protocol version is invalid".into())
                })?;
            let available_providers = request
                .available_providers
                .iter()
                .copied()
                .map(provider_text)
                .map(str::to_owned)
                .collect::<Vec<_>>();
            let row = sqlx::query(
                "WITH candidate AS ( \
                     SELECT id FROM discovery_runs \
                     WHERE community_id=$1 AND state IN ('queued','running') \
                       AND discovery_protocol_version=$7 \
                       AND (claim_id IS NULL OR lease_until < now()) \
                       AND (requested_by=$5 OR EXISTS ( \
                           SELECT 1 FROM users requester \
                           WHERE requester.community_id=$1 \
                             AND requester.pubkey=discovery_runs.requested_by \
                             AND requester.agent_owner_pubkey=$5)) \
                       AND EXISTS (SELECT 1 FROM discovery_run_business_searches s \
                                   WHERE s.community_id=$1 AND s.run_id=discovery_runs.id) \
                       AND EXISTS (SELECT 1 FROM discovery_run_sources rs \
                                   WHERE rs.community_id=$1 AND rs.run_id=discovery_runs.id) \
                       AND ($7=3 OR NOT EXISTS (SELECT 1 FROM discovery_run_sources rs \
                                       WHERE rs.community_id=$1 \
                                         AND rs.run_id=discovery_runs.id \
                                         AND NOT (rs.provider = ANY($6::text[])))) \
                     ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1 \
                 ) \
                 UPDATE discovery_runs r \
                 SET state='running', claim_id=$2, lease_until=$3, worker_id=$4, \
                     lease_owner_pubkey=$5, lease_worker_protocol_version=$7, \
                     lease_worker_protocol_claim_id=$2, \
                     attempt=r.attempt+1, updated_at=now() \
                 FROM candidate c WHERE r.community_id=$1 AND r.id=c.id \
                 RETURNING r.id, r.community_id, r.campaign_id, r.requested_by, \
                 r.start_idempotency_key, r.state, r.completed_steps, r.total_steps, \
                 r.cancel_requested, r.claim_id, r.lease_until, r.worker_id, \
                 r.lease_owner_pubkey, r.last_checkpoint_sequence, r.attempt, \
                 r.terminal_reason,r.discovery_protocol_version,r.payer_pubkey,\
                 r.price_per_retained_lead_nanousd,r.billable_lead_limit,r.reserved_nanousd,\
                 r.settled_nanousd,r.released_nanousd,r.billed_retained_lead_count,\
                 r.settlement_ref,r.settled_at,r.created_at,r.updated_at",
            )
            .bind(community_id.as_uuid())
            .bind(lease_id)
            .bind(lease_until)
            .bind(request.worker_id)
            .bind(actor_pubkey.as_slice())
            .bind(&available_providers)
            .bind(worker_protocol_version)
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
            require_worker_lease_protocol_tx(
                tx,
                community_id,
                request.run_id,
                request.lease_id,
                action_event,
            )
            .await?;
            let row = sqlx::query(
                "UPDATE discovery_runs SET lease_until=$5, updated_at=now() \
                 WHERE community_id=$1 AND id=$2 AND claim_id=$3 AND worker_id=$4 \
                   AND lease_owner_pubkey=$6 AND state='running' AND lease_until >= now() \
                 RETURNING id, community_id, campaign_id, requested_by, start_idempotency_key, \
                 state, completed_steps, total_steps, cancel_requested, claim_id, lease_until, \
                 worker_id, lease_owner_pubkey, last_checkpoint_sequence, attempt, \
                 terminal_reason,discovery_protocol_version,payer_pubkey,\
                 price_per_retained_lead_nanousd,billable_lead_limit,reserved_nanousd,\
                 settled_nanousd,released_nanousd,billed_retained_lead_count,settlement_ref,\
                 settled_at,created_at,updated_at",
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
            let lease_protocol_version = require_worker_lease_protocol_tx(
                tx,
                community_id,
                request.lease.run_id,
                request.lease.lease_id,
                action_event,
            )
            .await?;
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
            if request.checkpoint.kind == DiscoveryCheckpointKind::ProviderSubmitted {
                let provider_request_id = request
                    .checkpoint
                    .provider_request_id
                    .as_deref()
                    .ok_or_else(|| {
                        DbError::InvalidData(
                            "Discovery submitted checkpoint is missing a provider reference".into(),
                        )
                    })?;
                let source_updated = if lease_protocol_version
                    == i16::try_from(DISCOVERY_HOSTED_GATEWAY_PROTOCOL_VERSION)
                        .expect("hosted protocol fits SMALLINT")
                {
                    sqlx::query(
                        "UPDATE discovery_run_sources SET status='active', \
                             request_count=GREATEST(request_count,1), \
                             started_at=COALESCE(started_at,now()), finished_at=NULL, \
                             failure_class=NULL, updated_at=now() \
                         WHERE community_id=$1 AND run_id=$2 AND provider=$3 \
                           AND request_cursor=$4 AND request_cursor NOT LIKE 'colony_pending_%' \
                           AND status IN ('pending','active')",
                    )
                } else {
                    sqlx::query(
                        "UPDATE discovery_run_sources SET status='active', request_cursor=$4, \
                             request_count=GREATEST(request_count,1), \
                             started_at=COALESCE(started_at,now()), finished_at=NULL, \
                             failure_class=NULL, updated_at=now() \
                         WHERE community_id=$1 AND run_id=$2 AND provider=$3 \
                           AND status IN ('pending','active')",
                    )
                }
                .bind(community_id.as_uuid())
                .bind(request.lease.run_id)
                .bind(provider_text(request.checkpoint.provider))
                .bind(provider_request_id)
                .execute(&mut **tx)
                .await?;
                if source_updated.rows_affected() != 1 {
                    return Err(DbError::InvalidData(
                        "Discovery submitted provider is not active in the run plan".into(),
                    ));
                }
            }
            if request.checkpoint.kind == DiscoveryCheckpointKind::ProviderResultsReady {
                let provider_request_id: String = sqlx::query_scalar(
                    "SELECT provider_request_id FROM discovery_run_checkpoints \
                     WHERE community_id=$1 AND run_id=$2 \
                       AND checkpoint_kind='provider_submitted' AND provider=$3 \
                     ORDER BY sequence LIMIT 1",
                )
                .bind(community_id.as_uuid())
                .bind(request.lease.run_id)
                .bind(provider_text(request.checkpoint.provider))
                .fetch_optional(&mut **tx)
                .await?
                .ok_or_else(|| {
                    DbError::InvalidData(
                        "Discovery results require a submitted provider checkpoint".into(),
                    )
                })?;
                let returned_count = item_count.ok_or_else(|| {
                    DbError::InvalidData("Discovery results checkpoint is missing a count".into())
                })?;
                let usage_row = sqlx::query(
                    "INSERT INTO discovery_source_usage \
                     (community_id, run_id, provider, provider_request_id, returned_count) \
                     VALUES ($1,$2,$3,$4,$5) \
                     ON CONFLICT (community_id, run_id, provider) DO UPDATE SET \
                       returned_count=EXCLUDED.returned_count, updated_at=now() \
                     WHERE discovery_source_usage.provider=EXCLUDED.provider \
                       AND discovery_source_usage.provider_request_id=EXCLUDED.provider_request_id \
                       AND (discovery_source_usage.returned_count IS NULL \
                            OR discovery_source_usage.returned_count=EXCLUDED.returned_count) \
                     RETURNING run_id",
                )
                .bind(community_id.as_uuid())
                .bind(request.lease.run_id)
                .bind(provider_text(request.checkpoint.provider))
                .bind(provider_request_id)
                .bind(returned_count)
                .fetch_optional(&mut **tx)
                .await?;
                if usage_row.is_none() {
                    return Err(DbError::AccessDenied(
                        "Discovery returned usage conflicts with committed results".into(),
                    ));
                }
            }
            let row = sqlx::query(
                "UPDATE discovery_runs SET last_checkpoint_sequence=$5, lease_until=$6, \
                     updated_at=now() \
                 WHERE community_id=$1 AND id=$2 AND claim_id=$3 AND worker_id=$4 \
                   AND lease_owner_pubkey=$7 AND state='running' AND lease_until >= now() \
                 RETURNING id, community_id, campaign_id, requested_by, start_idempotency_key, \
                 state, completed_steps, total_steps, cancel_requested, claim_id, lease_until, \
                 worker_id, lease_owner_pubkey, last_checkpoint_sequence, attempt, \
                 terminal_reason,discovery_protocol_version,payer_pubkey,\
                 price_per_retained_lead_nanousd,billable_lead_limit,reserved_nanousd,\
                 settled_nanousd,released_nanousd,billed_retained_lead_count,settlement_ref,\
                 settled_at,created_at,updated_at",
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
        DiscoveryWorkerAction::SourceProgress(request) => {
            request
                .validate()
                .map_err(|error| DbError::InvalidData(error.to_string()))?;
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
            let lease_protocol_version = require_worker_lease_protocol_tx(
                tx,
                community_id,
                request.lease.run_id,
                request.lease.lease_id,
                action_event,
            )
            .await?;
            if request.provider != DiscoveryProvider::Outscraper
                && request.status == DiscoveryRunSourceStatus::Active
            {
                adopt_multi_source_tx(tx, community_id).await?;
            }
            let source_row = sqlx::query(
                "SELECT status,request_cursor,request_count,returned_count,failure_class \
                 FROM discovery_run_sources \
                 WHERE community_id=$1 AND run_id=$2 AND provider=$3 FOR UPDATE",
            )
            .bind(community_id.as_uuid())
            .bind(request.lease.run_id)
            .bind(provider_text(request.provider))
            .fetch_optional(&mut **tx)
            .await?
            .ok_or_else(|| {
                DbError::InvalidData("Discovery progress provider is not in the run plan".into())
            })?;
            let current_status = parse_run_source_status(source_row.try_get("status")?)?;
            let current_cursor: Option<String> = source_row.try_get("request_cursor")?;
            let current_request_count: i32 = source_row.try_get("request_count")?;
            let current_returned_count: i32 = source_row.try_get("returned_count")?;
            let current_failure =
                parse_run_source_failure_class(source_row.try_get("failure_class")?)?;
            let hosted_protocol = lease_protocol_version
                == i16::try_from(DISCOVERY_HOSTED_GATEWAY_PROTOCOL_VERSION)
                    .expect("hosted protocol fits SMALLINT");
            let unresolved_hosted_attempt = hosted_protocol
                && current_cursor
                    .as_deref()
                    .is_some_and(|cursor| cursor.starts_with("colony_pending_"));
            let safely_terminalizes_unknown = unresolved_hosted_attempt
                && request.status == DiscoveryRunSourceStatus::Failed
                && request.request_cursor.is_none()
                && request.failure_class == Some(DiscoveryRunSourceFailureClass::OutcomeUnknown);
            if hosted_protocol
                && !safely_terminalizes_unknown
                && (current_cursor.as_ref() != request.request_cursor.as_ref()
                    || current_cursor.is_none()
                    || unresolved_hosted_attempt)
            {
                return Err(DbError::AccessDenied(
                    "Hosted Discovery progress requires the relay-issued provider reference".into(),
                ));
            }
            if !source_transition_allowed(current_status, request.status)
                || request.request_count < nonnegative_source_count(current_request_count)?
                || request.returned_count < nonnegative_source_count(current_returned_count)?
                || current_cursor
                    .as_ref()
                    .zip(request.request_cursor.as_ref())
                    .is_some_and(|(current, next)| current != next)
            {
                return Err(DbError::AccessDenied(
                    "Discovery source progress conflicts with committed progress".into(),
                ));
            }
            if is_terminal_source_status(current_status)
                && (request.status != current_status
                    || request.request_count != nonnegative_source_count(current_request_count)?
                    || request.returned_count != nonnegative_source_count(current_returned_count)?
                    || request.failure_class != current_failure)
            {
                return Err(DbError::AccessDenied(
                    "Discovery source terminal progress conflicts with committed progress".into(),
                ));
            }
            let request_count = i32::try_from(request.request_count).map_err(|_| {
                DbError::InvalidData("Discovery source request count exceeds i32::MAX".into())
            })?;
            let returned_count = i32::try_from(request.returned_count).map_err(|_| {
                DbError::InvalidData("Discovery source returned count exceeds i32::MAX".into())
            })?;
            let terminal = is_terminal_source_status(request.status);
            let updated = sqlx::query(
                "UPDATE discovery_run_sources SET status=$4, \
                     request_cursor=COALESCE($5,request_cursor), request_count=$6, \
                     returned_count=$7, failure_class=$8, \
                     started_at=COALESCE(started_at,now()), \
                     finished_at=CASE WHEN $9 THEN COALESCE(finished_at,now()) ELSE NULL END, \
                     updated_at=now() \
                 WHERE community_id=$1 AND run_id=$2 AND provider=$3",
            )
            .bind(community_id.as_uuid())
            .bind(request.lease.run_id)
            .bind(provider_text(request.provider))
            .bind(run_source_status_text(request.status))
            .bind(request.request_cursor.as_deref())
            .bind(request_count)
            .bind(returned_count)
            .bind(request.failure_class.map(run_source_failure_class_text))
            .bind(terminal)
            .execute(&mut **tx)
            .await?;
            if updated.rows_affected() != 1 {
                return Err(DbError::InvalidData(
                    "Discovery progress provider is not in the run plan".into(),
                ));
            }
            let row = sqlx::query(
                "UPDATE discovery_runs SET lease_until=$5, updated_at=now() \
                 WHERE community_id=$1 AND id=$2 AND claim_id=$3 AND worker_id=$4 \
                   AND lease_owner_pubkey=$6 AND state='running' AND lease_until >= now() \
                 RETURNING id, community_id, campaign_id, requested_by, start_idempotency_key, \
                 state, completed_steps, total_steps, cancel_requested, claim_id, lease_until, \
                 worker_id, lease_owner_pubkey, last_checkpoint_sequence, attempt, \
                 terminal_reason,discovery_protocol_version,payer_pubkey,\
                 price_per_retained_lead_nanousd,billable_lead_limit,reserved_nanousd,\
                 settled_nanousd,released_nanousd,billed_retained_lead_count,settlement_ref,\
                 settled_at,created_at,updated_at",
            )
            .bind(community_id.as_uuid())
            .bind(request.lease.run_id)
            .bind(request.lease.lease_id)
            .bind(request.lease.worker_id)
            .bind(lease_until)
            .bind(actor_pubkey.as_slice())
            .fetch_optional(&mut **tx)
            .await?;
            let Some(row) = row else {
                return Ok(DiscoveryWorkerReceiptOutcome::LostLease(
                    current.projection(),
                ));
            };
            worker_lease_outcome_tx(tx, run_from_row(&row)?).await
        }
        DiscoveryWorkerAction::StoreObservations(request) => {
            request
                .validate()
                .map_err(|error| DbError::InvalidData(error.to_string()))?;
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
            let lease_protocol_version = require_worker_lease_protocol_tx(
                tx,
                community_id,
                request.lease.run_id,
                request.lease.lease_id,
                action_event,
            )
            .await?;
            let hosted_protocol = lease_protocol_version
                == i16::try_from(DISCOVERY_HOSTED_GATEWAY_PROTOCOL_VERSION)
                    .expect("hosted protocol fits SMALLINT");
            if hosted_protocol {
                return Err(DbError::AccessDenied(
                    "Hosted Discovery observations are committed by the relay".into(),
                ));
            }
            let submitted: bool = sqlx::query_scalar(if hosted_protocol {
                "SELECT EXISTS (SELECT 1 FROM discovery_run_checkpoints cp \
                 JOIN discovery_run_sources s ON s.community_id=cp.community_id \
                      AND s.run_id=cp.run_id AND s.provider=cp.provider \
                 WHERE cp.community_id=$1 AND cp.run_id=$2 \
                   AND cp.checkpoint_kind='provider_submitted' AND cp.provider=$3 \
                   AND cp.provider_request_id=$4 AND s.request_cursor=$4 \
                   AND s.request_cursor NOT LIKE 'colony_pending_%')"
            } else {
                "SELECT EXISTS (SELECT 1 FROM discovery_run_checkpoints \
                 WHERE community_id=$1 AND run_id=$2 \
                   AND checkpoint_kind='provider_submitted' AND provider=$3 \
                   AND provider_request_id=$4)"
            })
            .bind(community_id.as_uuid())
            .bind(request.lease.run_id)
            .bind(provider_text(request.provider))
            .bind(&request.provider_request_id)
            .fetch_one(&mut **tx)
            .await?;
            if !submitted {
                return Err(DbError::InvalidData(
                    "Discovery observations require the matching submitted provider checkpoint"
                        .into(),
                ));
            }

            let batch_index = i16::try_from(request.batch_index).map_err(|_| {
                DbError::InvalidData("Discovery observation batch index exceeds SMALLINT".into())
            })?;
            let batch_fingerprint = observation_batch_fingerprint(&request.observations)?;
            let prior_batch = sqlx::query(
                "SELECT batch_fingerprint, accepted_count, existing_count \
                 FROM discovery_source_observation_batches \
                 WHERE community_id=$1 AND run_id=$2 AND provider=$3 \
                   AND provider_request_id=$4 \
                   AND batch_index=$5",
            )
            .bind(community_id.as_uuid())
            .bind(request.lease.run_id)
            .bind(provider_text(request.provider))
            .bind(&request.provider_request_id)
            .bind(batch_index)
            .fetch_optional(&mut **tx)
            .await?;

            let (accepted_count, existing_count) = if let Some(row) = prior_batch {
                let prior_fingerprint: Vec<u8> = row.try_get("batch_fingerprint")?;
                if prior_fingerprint != batch_fingerprint.as_slice() {
                    return Err(DbError::AccessDenied(
                        "Discovery observation batch conflicts with committed results".into(),
                    ));
                }
                let accepted: i16 = row.try_get("accepted_count")?;
                let existing: i16 = row.try_get("existing_count")?;
                (
                    u16::try_from(accepted).map_err(|_| {
                        DbError::InvalidData("Discovery accepted count cannot be negative".into())
                    })?,
                    u16::try_from(existing).map_err(|_| {
                        DbError::InvalidData("Discovery existing count cannot be negative".into())
                    })?,
                )
            } else {
                let mut accepted_count = 0u16;
                let mut existing_count = 0u16;
                for observation in &request.observations {
                    let fingerprint = observation_fingerprint(observation)?;
                    let inserted = insert_business_observation_tx(
                        tx,
                        community_id,
                        request.lease.run_id,
                        observation,
                        &fingerprint,
                    )
                    .await?;
                    if inserted {
                        accepted_count = accepted_count.checked_add(1).ok_or_else(|| {
                            DbError::InvalidData("Discovery accepted count overflow".into())
                        })?;
                    } else {
                        existing_count = existing_count.checked_add(1).ok_or_else(|| {
                            DbError::InvalidData("Discovery existing count overflow".into())
                        })?;
                    }
                }

                let usage_row = sqlx::query(
                    "INSERT INTO discovery_source_usage \
                     (community_id, run_id, provider, provider_request_id, stored_count, existing_count) \
                     VALUES ($1,$2,$3,$4,$5,$6) \
                     ON CONFLICT (community_id, run_id, provider) DO UPDATE SET \
                       stored_count=discovery_source_usage.stored_count + EXCLUDED.stored_count, \
                       existing_count=discovery_source_usage.existing_count + EXCLUDED.existing_count, \
                       updated_at=now() \
                     WHERE discovery_source_usage.provider=EXCLUDED.provider \
                       AND discovery_source_usage.provider_request_id=EXCLUDED.provider_request_id \
                     RETURNING run_id",
                )
                .bind(community_id.as_uuid())
                .bind(request.lease.run_id)
                .bind(provider_text(request.provider))
                .bind(&request.provider_request_id)
                .bind(i32::from(accepted_count))
                .bind(i32::from(existing_count))
                .fetch_optional(&mut **tx)
                .await?;
                if usage_row.is_none() {
                    return Err(DbError::AccessDenied(
                        "Discovery usage conflicts with a different provider request".into(),
                    ));
                }
                sqlx::query(
                    "INSERT INTO discovery_source_observation_batches \
                     (community_id, run_id, provider, provider_request_id, batch_index, \
                      batch_fingerprint, accepted_count, existing_count) \
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
                )
                .bind(community_id.as_uuid())
                .bind(request.lease.run_id)
                .bind(provider_text(request.provider))
                .bind(&request.provider_request_id)
                .bind(batch_index)
                .bind(batch_fingerprint.as_slice())
                .bind(i16::try_from(accepted_count).map_err(|_| {
                    DbError::InvalidData("Discovery accepted count exceeds SMALLINT".into())
                })?)
                .bind(i16::try_from(existing_count).map_err(|_| {
                    DbError::InvalidData("Discovery existing count exceeds SMALLINT".into())
                })?)
                .execute(&mut **tx)
                .await?;
                let source_updated = sqlx::query(
                    "UPDATE discovery_run_sources SET \
                         retained_count=retained_count+$4, \
                         duplicate_count=duplicate_count+$5,updated_at=now() \
                     WHERE community_id=$1 AND run_id=$2 AND provider=$3",
                )
                .bind(community_id.as_uuid())
                .bind(request.lease.run_id)
                .bind(provider_text(request.provider))
                .bind(i32::from(accepted_count))
                .bind(i32::from(existing_count))
                .execute(&mut **tx)
                .await?;
                if source_updated.rows_affected() != 1 {
                    return Err(DbError::InvalidData(
                        "Discovery observation provider is not in the run plan".into(),
                    ));
                }
                (accepted_count, existing_count)
            };

            let row = sqlx::query(
                "UPDATE discovery_runs SET lease_until=$5, updated_at=now() \
                 WHERE community_id=$1 AND id=$2 AND claim_id=$3 AND worker_id=$4 \
                   AND lease_owner_pubkey=$6 AND state='running' AND lease_until >= now() \
                 RETURNING id, community_id, campaign_id, requested_by, start_idempotency_key, \
                 state, completed_steps, total_steps, cancel_requested, claim_id, lease_until, \
                 worker_id, lease_owner_pubkey, last_checkpoint_sequence, attempt, \
                 terminal_reason,discovery_protocol_version,payer_pubkey,\
                 price_per_retained_lead_nanousd,billable_lead_limit,reserved_nanousd,\
                 settled_nanousd,released_nanousd,billed_retained_lead_count,settlement_ref,\
                 settled_at,created_at,updated_at",
            )
            .bind(community_id.as_uuid())
            .bind(request.lease.run_id)
            .bind(request.lease.lease_id)
            .bind(request.lease.worker_id)
            .bind(lease_until)
            .bind(actor_pubkey.as_slice())
            .fetch_optional(&mut **tx)
            .await?;
            let Some(row) = row else {
                return Ok(DiscoveryWorkerReceiptOutcome::LostLease(
                    current.projection(),
                ));
            };
            let lease = worker_lease_projection_tx(tx, run_from_row(&row)?).await?;
            Ok(DiscoveryWorkerReceiptOutcome::ObservationsStored(
                DiscoveryWorkerStoredObservationsProjection {
                    lease,
                    accepted_count,
                    existing_count,
                },
            ))
        }
        DiscoveryWorkerAction::SalvageObservations(request) => {
            request
                .validate()
                .map_err(|error| DbError::InvalidData(error.to_string()))?;
            let run = load_run_tx(tx, community_id, request.run_id, true).await?;
            if run.protocol_version == DISCOVERY_HOSTED_GATEWAY_PROTOCOL_VERSION {
                return Err(DbError::AccessDenied(
                    "Hosted Discovery results are already durable in the relay".into(),
                ));
            }
            if !run.state.is_terminal() {
                return Err(DbError::InvalidData(
                    "Discovery paid-result recovery requires a terminal run".into(),
                ));
            }
            if run.requested_by != *actor_pubkey {
                let owns_requesting_agent: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM users \
                     WHERE community_id=$1 AND pubkey=$2 AND agent_owner_pubkey=$3)",
                )
                .bind(community_id.as_uuid())
                .bind(run.requested_by.as_slice())
                .bind(actor_pubkey.as_slice())
                .fetch_one(&mut **tx)
                .await?;
                if !owns_requesting_agent {
                    return Err(DbError::AccessDenied(
                        "Discovery paid-result recovery requires the original run owner".into(),
                    ));
                }
            }
            let source_terminal: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM discovery_run_sources \
                 WHERE community_id=$1 AND run_id=$2 AND provider=$3 \
                   AND status NOT IN ('pending','active'))",
            )
            .bind(community_id.as_uuid())
            .bind(request.run_id)
            .bind(provider_text(request.provider))
            .fetch_one(&mut **tx)
            .await?;
            if !source_terminal {
                return Err(DbError::InvalidData(
                    "Discovery paid-result recovery provider is not terminal in the run plan"
                        .into(),
                ));
            }
            let (accepted_count, existing_count) = salvage_observation_batch_tx(
                tx,
                community_id,
                request.run_id,
                request.provider,
                &request.provider_request_id,
                request.batch_index,
                &request.observations,
            )
            .await?;
            Ok(DiscoveryWorkerReceiptOutcome::ObservationsSalvaged(
                DiscoveryWorkerSalvagedObservationsProjection {
                    run: run.projection(),
                    accepted_count,
                    existing_count,
                },
            ))
        }
        DiscoveryWorkerAction::Fail(request) => {
            require_worker_lease_protocol_tx(
                tx,
                community_id,
                request.run_id,
                request.lease_id,
                action_event,
            )
            .await?;
            if let Some(run) = settle_paid_run_tx(
                tx,
                community_id,
                request.run_id,
                Some((actor_pubkey, request.worker_id, request.lease_id)),
                DiscoveryRunState::Failed,
                Some(DiscoveryTerminalReason::ExecutorFailed),
            )
            .await?
            {
                return Ok(DiscoveryWorkerReceiptOutcome::Failed(run.projection()));
            }
            let current = load_run_tx(tx, community_id, request.run_id, true).await?;
            if !worker_lease_matches(&current, actor_pubkey, request.worker_id, request.lease_id) {
                return Ok(DiscoveryWorkerReceiptOutcome::LostLease(
                    current.projection(),
                ));
            }
            let lease_protocol_version = require_worker_lease_protocol_tx(
                tx,
                community_id,
                request.run_id,
                request.lease_id,
                action_event,
            )
            .await?;
            if lease_protocol_version != 1 {
                let all_sources_terminal: bool = sqlx::query_scalar(
                    "SELECT NOT EXISTS (SELECT 1 FROM discovery_run_sources \
                     WHERE community_id=$1 AND run_id=$2 AND status IN ('pending','active'))",
                )
                .bind(community_id.as_uuid())
                .bind(request.run_id)
                .fetch_one(&mut **tx)
                .await?;
                if !all_sources_terminal {
                    return Err(DbError::InvalidData(
                        "all Discovery sources must be terminal before failure".into(),
                    ));
                }
            }
            let row = sqlx::query(
                "UPDATE discovery_runs SET state='failed', terminal_reason='executor_failed', \
                     claim_id=NULL, lease_until=NULL, worker_id=NULL, lease_owner_pubkey=NULL, \
                     updated_at=now() \
                 WHERE community_id=$1 AND id=$2 AND claim_id=$3 AND worker_id=$4 \
                   AND lease_owner_pubkey=$5 AND state='running' AND lease_until >= now() \
                 RETURNING id, community_id, campaign_id, requested_by, start_idempotency_key, \
                 state, completed_steps, total_steps, cancel_requested, claim_id, lease_until, \
                 worker_id, lease_owner_pubkey, last_checkpoint_sequence, attempt, \
                 terminal_reason,discovery_protocol_version,payer_pubkey,\
                 price_per_retained_lead_nanousd,billable_lead_limit,reserved_nanousd,\
                 settled_nanousd,released_nanousd,billed_retained_lead_count,settlement_ref,\
                 settled_at,created_at,updated_at",
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
                    DiscoveryWorkerReceiptOutcome::Failed(run_from_row(&row)?.projection())
                }
                None => DiscoveryWorkerReceiptOutcome::LostLease(current.projection()),
            })
        }
        DiscoveryWorkerAction::Complete(request) => {
            require_worker_lease_protocol_tx(
                tx,
                community_id,
                request.run_id,
                request.lease_id,
                action_event,
            )
            .await?;
            if let Some(run) = settle_paid_run_tx(
                tx,
                community_id,
                request.run_id,
                Some((actor_pubkey, request.worker_id, request.lease_id)),
                DiscoveryRunState::Succeeded,
                None,
            )
            .await?
            {
                return Ok(DiscoveryWorkerReceiptOutcome::Completed(run.projection()));
            }
            let current = load_run_tx(tx, community_id, request.run_id, true).await?;
            if !worker_lease_matches(&current, actor_pubkey, request.worker_id, request.lease_id) {
                return Ok(DiscoveryWorkerReceiptOutcome::LostLease(
                    current.projection(),
                ));
            }
            let lease_protocol_version = require_worker_lease_protocol_tx(
                tx,
                community_id,
                request.run_id,
                request.lease_id,
                action_event,
            )
            .await?;
            if lease_protocol_version != 1 {
                let all_sources_terminal: bool = sqlx::query_scalar(
                    "SELECT NOT EXISTS (SELECT 1 FROM discovery_run_sources \
                     WHERE community_id=$1 AND run_id=$2 AND status IN ('pending','active'))",
                )
                .bind(community_id.as_uuid())
                .bind(request.run_id)
                .fetch_one(&mut **tx)
                .await?;
                if !all_sources_terminal {
                    return Err(DbError::InvalidData(
                        "all Discovery sources must be terminal before completion".into(),
                    ));
                }
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
                 terminal_reason,discovery_protocol_version,payer_pubkey,\
                 price_per_retained_lead_nanousd,billable_lead_limit,reserved_nanousd,\
                 settled_nanousd,released_nanousd,billed_retained_lead_count,settlement_ref,\
                 settled_at,created_at,updated_at",
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

async fn adopt_multi_source_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
) -> Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))")
        .bind(community_id.as_uuid())
        .execute(&mut **tx)
        .await?;
    let legacy_run_active: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM discovery_runs \
         WHERE community_id=$1 AND discovery_protocol_version=1 \
           AND state IN ('queued','running'))",
    )
    .bind(community_id.as_uuid())
    .fetch_one(&mut **tx)
    .await?;
    if legacy_run_active {
        return Err(DbError::InvalidData(
            "Discovery protocol V1 runs must finish before multi-source adoption".into(),
        ));
    }
    sqlx::query(
        "INSERT INTO discovery_workspace_protocols (community_id) VALUES ($1) \
         ON CONFLICT (community_id) DO NOTHING",
    )
    .bind(community_id.as_uuid())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn worker_action_protocol_version(event: &Event) -> Option<i16> {
    event.tags.iter().find_map(|tag| {
        let parts = tag.as_slice();
        if parts
            .first()
            .is_some_and(|value| value == "discovery-worker-action")
        {
            parts.get(1)?.parse::<i16>().ok()
        } else {
            None
        }
    })
}

async fn require_worker_lease_protocol_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    run_id: Uuid,
    lease_id: Uuid,
    action_event: &Event,
) -> Result<i16> {
    let marker: Option<(Option<i16>, Option<Uuid>)> = sqlx::query_as(
        "SELECT lease_worker_protocol_version,lease_worker_protocol_claim_id \
         FROM discovery_runs WHERE community_id=$1 AND id=$2 AND claim_id=$3",
    )
    .bind(community_id.as_uuid())
    .bind(run_id)
    .bind(lease_id)
    .fetch_optional(&mut **tx)
    .await?;
    let action_protocol_version = worker_action_protocol_version(action_event)
        .ok_or_else(|| DbError::AccessDenied("Discovery worker action has no protocol".into()))?;
    let Some((Some(lease_protocol_version), Some(protocol_claim_id))) = marker else {
        return Err(DbError::AccessDenied(
            "Discovery worker lease is missing its protocol fence".into(),
        ));
    };
    let compatible = lease_protocol_version == action_protocol_version
        || (lease_protocol_version == 3 && action_protocol_version == 2);
    if protocol_claim_id != lease_id || !compatible {
        return Err(DbError::AccessDenied(
            "Discovery worker action protocol does not match the current lease".into(),
        ));
    }
    Ok(lease_protocol_version)
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
    Ok(DiscoveryWorkerReceiptOutcome::Lease(
        worker_lease_projection_tx(tx, run).await?,
    ))
}

async fn worker_lease_projection_tx(
    tx: &mut Transaction<'_, Postgres>,
    run: DiscoveryRunRecord,
) -> Result<DiscoveryWorkerLeaseProjection> {
    let worker_id = run.worker_id.ok_or_else(|| {
        DbError::InvalidData("external Discovery lease is missing worker identity".into())
    })?;
    let lease_id = run.claim_id.ok_or_else(|| {
        DbError::InvalidData("external Discovery lease is missing fencing token".into())
    })?;
    let lease_until = run
        .lease_until
        .ok_or_else(|| DbError::InvalidData("external Discovery lease is missing expiry".into()))?;
    let business_search = load_business_search_tx(tx, run.community_id, run.id).await?;
    let source_config =
        super::discovery_workspace::load_run_source_config_tx(tx, run.community_id, run.id).await?;
    let source_states = load_run_source_states_tx(tx, run.community_id, run.id).await?;
    let last_checkpoint = load_last_checkpoint_tx(tx, run.community_id, run.id).await?;
    Ok(DiscoveryWorkerLeaseProjection {
        worker_id,
        lease_id,
        attempt: run.attempt,
        lease_until,
        run: run.projection(),
        business_search,
        source_config,
        source_states,
        last_checkpoint,
    })
}

async fn load_run_source_states_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    run_id: Uuid,
) -> Result<Vec<DiscoveryRunSourceProjection>> {
    let rows = sqlx::query(
        "SELECT source_key,provider,position,status,request_cursor,request_count, \
                returned_count,retained_count,duplicate_count,failure_class, \
                started_at,finished_at,updated_at \
         FROM discovery_run_sources WHERE community_id=$1 AND run_id=$2 \
         ORDER BY position",
    )
    .bind(community_id.as_uuid())
    .bind(run_id)
    .fetch_all(&mut **tx)
    .await?;
    if rows.is_empty() {
        return Err(DbError::InvalidData(
            "Discovery run is missing source progress".into(),
        ));
    }
    rows.iter().map(run_source_from_row).collect()
}

fn run_source_from_row(row: &sqlx::postgres::PgRow) -> Result<DiscoveryRunSourceProjection> {
    let source = super::discovery_workspace::parse_source(row.try_get("source_key")?)?;
    let provider = parse_provider(row.try_get("provider")?)?;
    if provider != source.provider() {
        return Err(DbError::InvalidData(
            "Discovery run source provider does not match its source".into(),
        ));
    }
    let position: i16 = row.try_get("position")?;
    let request_count: i32 = row.try_get("request_count")?;
    let returned_count: i32 = row.try_get("returned_count")?;
    let retained_count: i32 = row.try_get("retained_count")?;
    let duplicate_count: i32 = row.try_get("duplicate_count")?;
    Ok(DiscoveryRunSourceProjection {
        source,
        provider,
        position: u8::try_from(position)
            .map_err(|_| DbError::InvalidData("Discovery source position is invalid".into()))?,
        status: parse_run_source_status(row.try_get("status")?)?,
        request_cursor: row.try_get("request_cursor")?,
        request_count: nonnegative_source_count(request_count)?,
        returned_count: nonnegative_source_count(returned_count)?,
        retained_count: nonnegative_source_count(retained_count)?,
        duplicate_count: nonnegative_source_count(duplicate_count)?,
        failure_class: parse_run_source_failure_class(row.try_get("failure_class")?)?,
        started_at: row.try_get("started_at")?,
        finished_at: row.try_get("finished_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn nonnegative_source_count(value: i32) -> Result<u32> {
    u32::try_from(value)
        .map_err(|_| DbError::InvalidData("Discovery source count cannot be negative".into()))
}

fn parse_run_source_status(value: &str) -> Result<DiscoveryRunSourceStatus> {
    match value {
        "pending" => Ok(DiscoveryRunSourceStatus::Pending),
        "active" => Ok(DiscoveryRunSourceStatus::Active),
        "completed" => Ok(DiscoveryRunSourceStatus::Completed),
        "exhausted" => Ok(DiscoveryRunSourceStatus::Exhausted),
        "failed" => Ok(DiscoveryRunSourceStatus::Failed),
        "cancelled" => Ok(DiscoveryRunSourceStatus::Cancelled),
        "outcome_unknown" => Ok(DiscoveryRunSourceStatus::OutcomeUnknown),
        "skipped_target_met" => Ok(DiscoveryRunSourceStatus::SkippedTargetMet),
        other => Err(DbError::InvalidData(format!(
            "unknown Discovery source status `{other}`"
        ))),
    }
}

fn run_source_status_text(status: DiscoveryRunSourceStatus) -> &'static str {
    match status {
        DiscoveryRunSourceStatus::Pending => "pending",
        DiscoveryRunSourceStatus::Active => "active",
        DiscoveryRunSourceStatus::Completed => "completed",
        DiscoveryRunSourceStatus::Exhausted => "exhausted",
        DiscoveryRunSourceStatus::Failed => "failed",
        DiscoveryRunSourceStatus::Cancelled => "cancelled",
        DiscoveryRunSourceStatus::OutcomeUnknown => "outcome_unknown",
        DiscoveryRunSourceStatus::SkippedTargetMet => "skipped_target_met",
    }
}

const fn is_terminal_source_status(status: DiscoveryRunSourceStatus) -> bool {
    !matches!(
        status,
        DiscoveryRunSourceStatus::Pending | DiscoveryRunSourceStatus::Active
    )
}

fn source_transition_allowed(
    current: DiscoveryRunSourceStatus,
    next: DiscoveryRunSourceStatus,
) -> bool {
    match current {
        DiscoveryRunSourceStatus::Pending => matches!(
            next,
            DiscoveryRunSourceStatus::Active
                | DiscoveryRunSourceStatus::Cancelled
                | DiscoveryRunSourceStatus::SkippedTargetMet
        ),
        DiscoveryRunSourceStatus::Active => next != DiscoveryRunSourceStatus::Pending,
        _ => current == next,
    }
}

fn parse_run_source_failure_class(
    value: Option<String>,
) -> Result<Option<DiscoveryRunSourceFailureClass>> {
    value
        .map(|value| match value.as_str() {
            "credential_rejected" => Ok(DiscoveryRunSourceFailureClass::CredentialRejected),
            "billing_required" => Ok(DiscoveryRunSourceFailureClass::BillingRequired),
            "invalid_request" => Ok(DiscoveryRunSourceFailureClass::InvalidRequest),
            "rate_limited" => Ok(DiscoveryRunSourceFailureClass::RateLimited),
            "provider_unavailable" => Ok(DiscoveryRunSourceFailureClass::ProviderUnavailable),
            "response_too_large" => Ok(DiscoveryRunSourceFailureClass::ResponseTooLarge),
            "request_timed_out" => Ok(DiscoveryRunSourceFailureClass::RequestTimedOut),
            "malformed_response" => Ok(DiscoveryRunSourceFailureClass::MalformedResponse),
            "outcome_unknown" => Ok(DiscoveryRunSourceFailureClass::OutcomeUnknown),
            "cancelled" => Ok(DiscoveryRunSourceFailureClass::Cancelled),
            other => Err(DbError::InvalidData(format!(
                "unknown Discovery source failure class `{other}`"
            ))),
        })
        .transpose()
}

fn run_source_failure_class_text(failure: DiscoveryRunSourceFailureClass) -> &'static str {
    match failure {
        DiscoveryRunSourceFailureClass::CredentialRejected => "credential_rejected",
        DiscoveryRunSourceFailureClass::BillingRequired => "billing_required",
        DiscoveryRunSourceFailureClass::InvalidRequest => "invalid_request",
        DiscoveryRunSourceFailureClass::RateLimited => "rate_limited",
        DiscoveryRunSourceFailureClass::ProviderUnavailable => "provider_unavailable",
        DiscoveryRunSourceFailureClass::ResponseTooLarge => "response_too_large",
        DiscoveryRunSourceFailureClass::RequestTimedOut => "request_timed_out",
        DiscoveryRunSourceFailureClass::MalformedResponse => "malformed_response",
        DiscoveryRunSourceFailureClass::OutcomeUnknown => "outcome_unknown",
        DiscoveryRunSourceFailureClass::Cancelled => "cancelled",
    }
}

async fn load_business_search_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    run_id: Uuid,
) -> Result<DiscoveryBusinessSearchSpec> {
    let row = sqlx::query(
        "SELECT query, location, result_limit, language, region \
         FROM discovery_run_business_searches WHERE community_id=$1 AND run_id=$2",
    )
    .bind(community_id.as_uuid())
    .bind(run_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| DbError::InvalidData("Discovery run is missing business search input".into()))?;
    let result_limit: i16 = row.try_get("result_limit")?;
    let search = DiscoveryBusinessSearchSpec {
        query: row.try_get("query")?,
        location: row.try_get("location")?,
        limit: u16::try_from(result_limit).map_err(|_| {
            DbError::InvalidData("Discovery result limit cannot be negative".into())
        })?,
        language: row.try_get("language")?,
        region: row.try_get("region")?,
    };
    search
        .validate()
        .map_err(|error| DbError::InvalidData(error.to_string()))?;
    Ok(search)
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
        DiscoveryWorkerReceiptOutcome::ObservationsStored(stored) => Some(stored.lease.run.run_id),
        DiscoveryWorkerReceiptOutcome::ObservationsSalvaged(salvaged) => Some(salvaged.run.run_id),
        DiscoveryWorkerReceiptOutcome::LostLease(run)
        | DiscoveryWorkerReceiptOutcome::Completed(run)
        | DiscoveryWorkerReceiptOutcome::Failed(run) => Some(run.run_id),
    }
}

async fn salvage_observation_batch_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    run_id: Uuid,
    provider: DiscoveryProvider,
    provider_request_id: &str,
    batch_index: u32,
    observations: &[DiscoveryBusinessObservationInput],
) -> Result<(u16, u16)> {
    let batch_index = i16::try_from(batch_index).map_err(|_| {
        DbError::InvalidData("Discovery observation batch index exceeds SMALLINT".into())
    })?;
    let batch_fingerprint = observation_batch_fingerprint(observations)?;
    if let Some(row) = sqlx::query(
        "SELECT batch_fingerprint,accepted_count,existing_count \
         FROM discovery_source_observation_batches \
         WHERE community_id=$1 AND run_id=$2 AND provider=$3 \
           AND provider_request_id=$4 AND batch_index=$5",
    )
    .bind(community_id.as_uuid())
    .bind(run_id)
    .bind(provider_text(provider))
    .bind(provider_request_id)
    .bind(batch_index)
    .fetch_optional(&mut **tx)
    .await?
    {
        let prior_fingerprint: Vec<u8> = row.try_get("batch_fingerprint")?;
        if prior_fingerprint != batch_fingerprint.as_slice() {
            return Err(DbError::AccessDenied(
                "Discovery salvage batch conflicts with committed results".into(),
            ));
        }
        let accepted: i16 = row.try_get("accepted_count")?;
        let existing: i16 = row.try_get("existing_count")?;
        return Ok((
            u16::try_from(accepted).map_err(|_| {
                DbError::InvalidData("Discovery accepted count cannot be negative".into())
            })?,
            u16::try_from(existing).map_err(|_| {
                DbError::InvalidData("Discovery existing count cannot be negative".into())
            })?,
        ));
    }

    let mut accepted_count = 0_u16;
    let mut existing_count = 0_u16;
    for observation in observations {
        let fingerprint = observation_fingerprint(observation)?;
        if insert_business_observation_tx(tx, community_id, run_id, observation, &fingerprint)
            .await?
        {
            accepted_count = accepted_count
                .checked_add(1)
                .ok_or_else(|| DbError::InvalidData("Discovery accepted count overflow".into()))?;
        } else {
            existing_count = existing_count
                .checked_add(1)
                .ok_or_else(|| DbError::InvalidData("Discovery existing count overflow".into()))?;
        }
    }

    let usage_row = sqlx::query(
        "INSERT INTO discovery_source_usage \
         (community_id,run_id,provider,provider_request_id,stored_count,existing_count,returned_count) \
         VALUES ($1,$2,$3,$4,$5,$6,$7) \
         ON CONFLICT (community_id,run_id,provider) DO UPDATE SET \
           stored_count=discovery_source_usage.stored_count+EXCLUDED.stored_count, \
           existing_count=discovery_source_usage.existing_count+EXCLUDED.existing_count, \
           returned_count=COALESCE(discovery_source_usage.returned_count,0)+EXCLUDED.returned_count, \
           updated_at=now() \
         WHERE discovery_source_usage.provider_request_id=EXCLUDED.provider_request_id \
         RETURNING run_id",
    )
    .bind(community_id.as_uuid())
    .bind(run_id)
    .bind(provider_text(provider))
    .bind(provider_request_id)
    .bind(i32::from(accepted_count))
    .bind(i32::from(existing_count))
    .bind(i32::from(accepted_count) + i32::from(existing_count))
    .fetch_optional(&mut **tx)
    .await?;
    if usage_row.is_none() {
        return Err(DbError::AccessDenied(
            "Discovery salvage usage conflicts with a different provider request".into(),
        ));
    }
    sqlx::query(
        "INSERT INTO discovery_source_observation_batches \
         (community_id,run_id,provider,provider_request_id,batch_index,batch_fingerprint, \
          accepted_count,existing_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    )
    .bind(community_id.as_uuid())
    .bind(run_id)
    .bind(provider_text(provider))
    .bind(provider_request_id)
    .bind(batch_index)
    .bind(batch_fingerprint.as_slice())
    .bind(
        i16::try_from(accepted_count).map_err(|_| {
            DbError::InvalidData("Discovery accepted count exceeds SMALLINT".into())
        })?,
    )
    .bind(
        i16::try_from(existing_count).map_err(|_| {
            DbError::InvalidData("Discovery existing count exceeds SMALLINT".into())
        })?,
    )
    .execute(&mut **tx)
    .await?;
    let source_updated = sqlx::query(
        "UPDATE discovery_run_sources SET \
           retained_count=retained_count+$4, duplicate_count=duplicate_count+$5, \
           returned_count=GREATEST(returned_count,retained_count+duplicate_count+$4+$5), \
           updated_at=now() \
         WHERE community_id=$1 AND run_id=$2 AND provider=$3 \
           AND status NOT IN ('pending','active')",
    )
    .bind(community_id.as_uuid())
    .bind(run_id)
    .bind(provider_text(provider))
    .bind(i32::from(accepted_count))
    .bind(i32::from(existing_count))
    .execute(&mut **tx)
    .await?;
    if source_updated.rows_affected() != 1 {
        return Err(DbError::InvalidData(
            "Discovery salvage provider is not terminal in the run plan".into(),
        ));
    }
    Ok((accepted_count, existing_count))
}

async fn insert_business_observation_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    run_id: Uuid,
    observation: &DiscoveryBusinessObservationInput,
    fingerprint: &[u8; 32],
) -> Result<bool> {
    let rating_hundredths = observation
        .rating_hundredths
        .map(i16::try_from)
        .transpose()
        .map_err(|_| DbError::InvalidData("Discovery rating exceeds SMALLINT".into()))?;
    let reviews_count = observation.reviews_count.map(i64::from);
    let canonical_domain_digest = observation
        .website
        .as_deref()
        .and_then(canonical_business_domain_digest);
    let normalized_phone_digest = observation
        .phone
        .as_deref()
        .and_then(normalized_business_phone_digest);
    let normalized_name_locality_digest = normalized_business_name_locality_digest(
        &observation.name,
        observation.city.as_deref(),
        observation.state.as_deref(),
        observation.country.as_deref(),
    );
    // Serialize identity selection within a workspace so two providers cannot
    // concurrently create separate canonical Leads for the same business.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))")
        .bind(community_id.as_uuid())
        .execute(&mut **tx)
        .await?;
    backfill_legacy_observation_digests_tx(tx, community_id).await?;
    let exact_identity: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM discovery_business_observations \
         WHERE community_id=$1 AND provider=$2 AND provider_record_id=$3",
    )
    .bind(community_id.as_uuid())
    .bind(provider_text(observation.provider))
    .bind(&observation.provider_record_id)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(lead_id) = exact_identity {
        associate_campaign_lead_tx(tx, community_id, run_id, lead_id).await?;
        return Ok(false);
    }
    let cross_provider_duplicate: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM discovery_business_observations \
         WHERE community_id=$1 AND ( \
           ($2::bytea IS NOT NULL AND canonical_domain_digest=$2) OR \
           ($3::bytea IS NOT NULL AND normalized_phone_digest=$3) OR \
           ($4::bytea IS NOT NULL AND normalized_name_locality_digest=$4)) \
         ORDER BY first_observed_at,id LIMIT 1",
    )
    .bind(community_id.as_uuid())
    .bind(
        canonical_domain_digest
            .as_ref()
            .map(|digest| digest.as_slice()),
    )
    .bind(
        normalized_phone_digest
            .as_ref()
            .map(|digest| digest.as_slice()),
    )
    .bind(
        normalized_name_locality_digest
            .as_ref()
            .map(|digest| digest.as_slice()),
    )
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(lead_id) = cross_provider_duplicate {
        associate_campaign_lead_tx(tx, community_id, run_id, lead_id).await?;
        return Ok(false);
    }
    let inserted = sqlx::query(
        "INSERT INTO discovery_business_observations (\
         community_id, id, first_run_id, provider, provider_record_id, place_id, google_id, \
         name, website, phone, full_address, city, state, postal_code, country, country_code, \
         latitude_micros, longitude_micros, category, subtypes, rating_hundredths, reviews_count, \
         business_status, verified, source_url, image_url, description, canonical_domain_digest, \
         normalized_phone_digest, normalized_name_locality_digest, dedupe_digest_version, \
         observation_fingerprint) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,\
                 $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,1,$31) \
         ON CONFLICT DO NOTHING",
    )
    .bind(community_id.as_uuid())
    .bind(observation.observation_id)
    .bind(run_id)
    .bind(provider_text(observation.provider))
    .bind(&observation.provider_record_id)
    .bind(observation.place_id.as_deref())
    .bind(observation.google_id.as_deref())
    .bind(&observation.name)
    .bind(observation.website.as_deref())
    .bind(observation.phone.as_deref())
    .bind(observation.full_address.as_deref())
    .bind(observation.city.as_deref())
    .bind(observation.state.as_deref())
    .bind(observation.postal_code.as_deref())
    .bind(observation.country.as_deref())
    .bind(observation.country_code.as_deref())
    .bind(observation.latitude_micros)
    .bind(observation.longitude_micros)
    .bind(observation.category.as_deref())
    .bind(&observation.subtypes)
    .bind(rating_hundredths)
    .bind(reviews_count)
    .bind(observation.business_status.map(business_status_text))
    .bind(observation.verified)
    .bind(observation.source_url.as_deref())
    .bind(observation.image_url.as_deref())
    .bind(observation.description.as_deref())
    .bind(
        canonical_domain_digest
            .as_ref()
            .map(|digest| digest.as_slice()),
    )
    .bind(
        normalized_phone_digest
            .as_ref()
            .map(|digest| digest.as_slice()),
    )
    .bind(
        normalized_name_locality_digest
            .as_ref()
            .map(|digest| digest.as_slice()),
    )
    .bind(fingerprint.as_slice())
    .execute(&mut **tx)
    .await?
    .rows_affected()
        == 1;
    if inserted {
        associate_campaign_lead_tx(tx, community_id, run_id, observation.observation_id).await?;
        return Ok(true);
    }

    let row = sqlx::query(
        "SELECT id FROM discovery_business_observations \
         WHERE community_id=$1 AND provider=$2 AND provider_record_id=$3",
    )
    .bind(community_id.as_uuid())
    .bind(provider_text(observation.provider))
    .bind(&observation.provider_record_id)
    .fetch_optional(&mut **tx)
    .await?;
    if row.is_some() {
        return Ok(false);
    }

    let conflicting_identity: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM discovery_business_observations \
         WHERE community_id=$1 AND id=$2)",
    )
    .bind(community_id.as_uuid())
    .bind(observation.observation_id)
    .fetch_one(&mut **tx)
    .await?;
    if conflicting_identity {
        return Err(DbError::AccessDenied(
            "Discovery observation identity conflicts with an existing business".into(),
        ));
    }
    // A different provider identity matched a stronger workspace dedupe key.
    // The first retained row remains the canonical Lead and provenance source.
    Ok(false)
}

async fn associate_campaign_lead_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    run_id: Uuid,
    lead_id: Uuid,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO discovery_campaign_leads \
         (community_id,campaign_id,lead_id,discovered_run_id) \
         SELECT r.community_id,r.campaign_id,$3,r.id FROM discovery_runs r \
         WHERE r.community_id=$1 AND r.id=$2 ON CONFLICT DO NOTHING",
    )
    .bind(community_id.as_uuid())
    .bind(run_id)
    .bind(lead_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn backfill_legacy_observation_digests_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
) -> Result<()> {
    const BATCH_SIZE: i64 = 500;
    loop {
        let rows = sqlx::query(
            "SELECT id,name,website,phone,city,state,country \
             FROM discovery_business_observations \
             WHERE community_id=$1 AND dedupe_digest_version=0 \
             ORDER BY id FOR UPDATE LIMIT $2",
        )
        .bind(community_id.as_uuid())
        .bind(BATCH_SIZE)
        .fetch_all(&mut **tx)
        .await?;
        if rows.is_empty() {
            return Ok(());
        }

        let mut observation_ids = Vec::with_capacity(rows.len());
        let mut domain_digests = Vec::with_capacity(rows.len());
        let mut phone_digests = Vec::with_capacity(rows.len());
        let mut name_locality_digests = Vec::with_capacity(rows.len());
        for row in rows {
            let observation_id: Uuid = row.try_get("id")?;
            let name: String = row.try_get("name")?;
            let website: Option<String> = row.try_get("website")?;
            let phone: Option<String> = row.try_get("phone")?;
            let city: Option<String> = row.try_get("city")?;
            let state: Option<String> = row.try_get("state")?;
            let country: Option<String> = row.try_get("country")?;
            observation_ids.push(observation_id);
            domain_digests.push(
                website
                    .as_deref()
                    .and_then(canonical_business_domain_digest)
                    .map(Vec::from),
            );
            phone_digests.push(
                phone
                    .as_deref()
                    .and_then(normalized_business_phone_digest)
                    .map(Vec::from),
            );
            name_locality_digests.push(
                normalized_business_name_locality_digest(
                    &name,
                    city.as_deref(),
                    state.as_deref(),
                    country.as_deref(),
                )
                .map(Vec::from),
            );
        }
        sqlx::query(
            "UPDATE discovery_business_observations observation \
             SET canonical_domain_digest=batch.domain_digest, \
                 normalized_phone_digest=batch.phone_digest, \
                 normalized_name_locality_digest=batch.name_locality_digest, \
                 dedupe_digest_version=1 \
             FROM UNNEST($2::uuid[],$3::bytea[],$4::bytea[],$5::bytea[]) \
                  AS batch(id,domain_digest,phone_digest,name_locality_digest) \
             WHERE observation.community_id=$1 AND observation.id=batch.id \
               AND observation.dedupe_digest_version=0",
        )
        .bind(community_id.as_uuid())
        .bind(&observation_ids)
        .bind(&domain_digests)
        .bind(&phone_digests)
        .bind(&name_locality_digests)
        .execute(&mut **tx)
        .await?;
    }
}

fn observation_fingerprint(observation: &DiscoveryBusinessObservationInput) -> Result<[u8; 32]> {
    let encoded = serde_json::to_vec(observation).map_err(|error| {
        DbError::InvalidData(format!(
            "Discovery observation could not be encoded: {error}"
        ))
    })?;
    let mut hasher = Sha256::new();
    if is_legacy_observation(observation) {
        hasher.update(b"colony.discovery-business-observation/v1\0");
    } else {
        hasher.update(b"colony.discovery-business-observation/v2\0");
    }
    hasher.update(encoded);
    Ok(hasher.finalize().into())
}

fn observation_batch_fingerprint(
    observations: &[DiscoveryBusinessObservationInput],
) -> Result<[u8; 32]> {
    let mut hasher = Sha256::new();
    if observations.iter().all(is_legacy_observation) {
        hasher.update(b"colony.discovery-observation-batch/v1\0");
    } else {
        hasher.update(b"colony.discovery-observation-batch/v2\0");
    }
    for observation in observations {
        hasher.update(observation_fingerprint(observation)?);
    }
    Ok(hasher.finalize().into())
}

fn worker_action_fingerprint(action: &DiscoveryWorkerAction) -> Result<[u8; 32]> {
    let mut hasher = Sha256::new();
    let legacy_compatible = match action {
        DiscoveryWorkerAction::Claim(request) => {
            request.available_providers == [DiscoveryProvider::Outscraper]
        }
        DiscoveryWorkerAction::Heartbeat(_)
        | DiscoveryWorkerAction::Fail(_)
        | DiscoveryWorkerAction::Complete(_) => true,
        DiscoveryWorkerAction::Checkpoint(request) => {
            request.checkpoint.provider == DiscoveryProvider::Outscraper
        }
        DiscoveryWorkerAction::SourceProgress(_) => false,
        DiscoveryWorkerAction::StoreObservations(request) => {
            request.provider == DiscoveryProvider::Outscraper
                && request.observations.iter().all(is_legacy_observation)
        }
        DiscoveryWorkerAction::SalvageObservations(_) => false,
    };
    if legacy_compatible {
        hasher.update(b"colony.discovery-worker-command/v1\0");
    } else {
        hasher.update(b"colony.discovery-worker-command/v2\0");
    }
    hasher.update(worker_operation_text(action.operation()).as_bytes());
    hasher.update([0]);
    hasher.update(action.worker_id().as_bytes());
    match action {
        DiscoveryWorkerAction::Claim(request) => {
            if !legacy_compatible {
                for provider in &request.available_providers {
                    hasher.update(provider_text(*provider).as_bytes());
                    hasher.update([0]);
                }
            }
        }
        DiscoveryWorkerAction::Heartbeat(request)
        | DiscoveryWorkerAction::Fail(request)
        | DiscoveryWorkerAction::Complete(request) => {
            hasher.update(request.run_id.as_bytes());
            hasher.update(request.lease_id.as_bytes());
        }
        DiscoveryWorkerAction::Checkpoint(request) => {
            hasher.update(request.lease.run_id.as_bytes());
            hasher.update(request.lease.lease_id.as_bytes());
            hasher.update(checkpoint_fingerprint(&request.checkpoint));
        }
        DiscoveryWorkerAction::SourceProgress(request) => {
            hasher.update(request.lease.run_id.as_bytes());
            hasher.update(request.lease.lease_id.as_bytes());
            hasher.update(provider_text(request.provider).as_bytes());
            hasher.update([0]);
            hasher.update(run_source_status_text(request.status).as_bytes());
            hasher.update([0]);
            if let Some(cursor) = &request.request_cursor {
                hasher.update(cursor.as_bytes());
            }
            hasher.update([0]);
            hasher.update(request.request_count.to_be_bytes());
            hasher.update(request.returned_count.to_be_bytes());
            if let Some(failure) = request.failure_class {
                hasher.update(run_source_failure_class_text(failure).as_bytes());
            }
        }
        DiscoveryWorkerAction::StoreObservations(request) => {
            hasher.update(request.lease.run_id.as_bytes());
            hasher.update(request.lease.lease_id.as_bytes());
            if !legacy_compatible {
                hasher.update(provider_text(request.provider).as_bytes());
                hasher.update([0]);
            }
            hasher.update(request.provider_request_id.as_bytes());
            hasher.update([0]);
            hasher.update(request.batch_index.to_be_bytes());
            for observation in &request.observations {
                hasher.update(observation_fingerprint(observation)?);
            }
        }
        DiscoveryWorkerAction::SalvageObservations(request) => {
            hasher.update(request.run_id.as_bytes());
            hasher.update(provider_text(request.provider).as_bytes());
            hasher.update([0]);
            hasher.update(request.provider_request_id.as_bytes());
            hasher.update([0]);
            hasher.update(request.batch_index.to_be_bytes());
            for observation in &request.observations {
                hasher.update(observation_fingerprint(observation)?);
            }
        }
    }
    Ok(hasher.finalize().into())
}

fn is_legacy_observation(observation: &DiscoveryBusinessObservationInput) -> bool {
    observation.provider == DiscoveryProvider::Outscraper && observation.description.is_none()
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
        DiscoveryWorkerOperation::SourceProgress => "source_progress",
        DiscoveryWorkerOperation::StoreObservations => "store_observations",
        DiscoveryWorkerOperation::SalvageObservations => "salvage_observations",
        DiscoveryWorkerOperation::Fail => "fail",
        DiscoveryWorkerOperation::Complete => "complete",
    }
}

fn business_status_text(status: DiscoveryBusinessStatus) -> &'static str {
    match status {
        DiscoveryBusinessStatus::Operational => "operational",
        DiscoveryBusinessStatus::TemporarilyClosed => "temporarily_closed",
        DiscoveryBusinessStatus::PermanentlyClosed => "permanently_closed",
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

pub(crate) fn provider_text(provider: DiscoveryProvider) -> &'static str {
    match provider {
        DiscoveryProvider::Outscraper => "outscraper",
        DiscoveryProvider::BraveSearch => "brave_search",
        DiscoveryProvider::ExaSearch => "exa_search",
    }
}

pub(crate) fn parse_provider(value: &str) -> Result<DiscoveryProvider> {
    match value {
        "outscraper" => Ok(DiscoveryProvider::Outscraper),
        "brave_search" => Ok(DiscoveryProvider::BraveSearch),
        "exa_search" => Ok(DiscoveryProvider::ExaSearch),
        other => Err(DbError::InvalidData(format!(
            "unknown Discovery provider `{other}`"
        ))),
    }
}

fn command_fingerprint(mutation: &DiscoveryCommandMutation, target_id: Uuid) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"colony.discovery-command/v1\0");
    let operation = mutation.operation();
    hasher.update(operation_text(operation).as_bytes());
    hasher.update([0]);
    hasher.update(target_id.as_bytes());
    if let DiscoveryCommandMutation::Start {
        campaign_id,
        business_search,
        protocol_version,
        ..
    } = mutation
    {
        hasher.update(campaign_id.as_bytes());
        hasher.update(protocol_version.to_be_bytes());
        if let Some(business_search) = business_search {
            for value in [
                business_search.query.as_str(),
                business_search.location.as_str(),
                business_search.language.as_str(),
                business_search.region.as_deref().unwrap_or(""),
            ] {
                hasher.update([0]);
                hasher.update(value.as_bytes());
            }
            hasher.update([0]);
            hasher.update(business_search.limit.to_be_bytes());
        }
    }
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
             lease_owner_pubkey,last_checkpoint_sequence,attempt,terminal_reason,\
             discovery_protocol_version,payer_pubkey,price_per_retained_lead_nanousd,\
             billable_lead_limit,reserved_nanousd,settled_nanousd,released_nanousd,\
             billed_retained_lead_count,settlement_ref,settled_at,created_at,updated_at \
             FROM discovery_runs \
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
     lease_owner_pubkey,last_checkpoint_sequence,attempt,terminal_reason,\
     discovery_protocol_version,payer_pubkey,price_per_retained_lead_nanousd,\
     billable_lead_limit,reserved_nanousd,settled_nanousd,released_nanousd,\
     billed_retained_lead_count,settlement_ref,settled_at,created_at,updated_at FROM discovery_runs \
     WHERE community_id=$1 AND id=$2";
const DISCOVERY_RUN_SELECT_BY_IDEMPOTENCY: &str =
    "SELECT id, community_id, campaign_id, requested_by, start_idempotency_key, state, \
     completed_steps, total_steps, cancel_requested, claim_id, lease_until, worker_id, \
     lease_owner_pubkey,last_checkpoint_sequence,attempt,terminal_reason,\
     discovery_protocol_version,payer_pubkey,price_per_retained_lead_nanousd,\
     billable_lead_limit,reserved_nanousd,settled_nanousd,released_nanousd,\
     billed_retained_lead_count,settlement_ref,settled_at,created_at,updated_at FROM discovery_runs \
     WHERE community_id=$1 AND start_idempotency_key=$2";

async fn discovery_authorization_pool(
    pool: &PgPool,
    community_id: CommunityId,
    actor_pubkey: &[u8; 32],
) -> Result<DiscoveryAuthorization> {
    let actor_hex = hex::encode(actor_pubkey);
    let row = sqlx::query(
        "SELECT COALESCE( \
                    e.active AND (e.expires_at IS NULL OR e.expires_at > now()), \
                    FALSE \
                ) AS entitled, \
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

pub(crate) async fn require_discovery_authorized_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    actor_pubkey: &[u8; 32],
) -> Result<()> {
    lock_discovery_authority_tx(tx, community_id).await?;
    let actor_hex = hex::encode(actor_pubkey);
    let row = sqlx::query(
        "SELECT COALESCE( \
                    e.active AND (e.expires_at IS NULL OR e.expires_at > now()), \
                    FALSE \
                ) AS entitled, \
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

async fn require_discovery_worker_authorized_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    actor_pubkey: &[u8; 32],
) -> Result<()> {
    require_discovery_authorized_tx(tx, community_id, actor_pubkey).await?;
    let is_agent: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM users \
         WHERE community_id=$1 AND pubkey=$2 AND agent_owner_pubkey IS NOT NULL)",
    )
    .bind(community_id.as_uuid())
    .bind(actor_pubkey.as_slice())
    .fetch_one(&mut **tx)
    .await?;
    if is_agent {
        return Err(DbError::AccessDenied(
            "Discovery local worker requires a human member identity".into(),
        ));
    }
    Ok(())
}

async fn require_no_other_active_campaign_run_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    campaign_id: Uuid,
    requested_run_id: Uuid,
) -> Result<()> {
    let campaign_exists = sqlx::query(
        "SELECT id FROM discovery_campaigns \
         WHERE community_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(community_id.as_uuid())
    .bind(campaign_id)
    .fetch_optional(&mut **tx)
    .await?
    .is_some();
    if !campaign_exists {
        return Err(DbError::NotFound("Discovery campaign".into()));
    }
    let active_run: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM discovery_runs \
         WHERE community_id=$1 AND campaign_id=$2 \
           AND state IN ('queued','running') LIMIT 1",
    )
    .bind(community_id.as_uuid())
    .bind(campaign_id)
    .fetch_optional(&mut **tx)
    .await?;
    if active_run.is_some_and(|run_id| run_id != requested_run_id) {
        return Err(DbError::AccessDenied(
            "Discovery campaign already has an active run".into(),
        ));
    }
    Ok(())
}

pub(crate) async fn lock_discovery_authority_tx(
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
    sqlx::query(
        "UPDATE discovery_run_sources SET status='cancelled', failure_class='cancelled', \
             started_at=COALESCE(started_at,now()), finished_at=COALESCE(finished_at,now()), \
             updated_at=now() \
         WHERE community_id=$1 AND run_id=$2 AND status IN ('pending','active')",
    )
    .bind(community_id.as_uuid())
    .bind(run_id)
    .execute(&mut **tx)
    .await?;
    let row = sqlx::query(
        "UPDATE discovery_runs SET state='cancelled', terminal_reason=$4, \
         claim_id=NULL, lease_until=NULL, worker_id=NULL, lease_owner_pubkey=NULL, updated_at=now() \
         WHERE community_id=$1 AND id=$2 AND claim_id=$3 \
         RETURNING id, community_id, campaign_id, requested_by, start_idempotency_key, \
         state, completed_steps, total_steps, cancel_requested, claim_id, lease_until, \
         worker_id,lease_owner_pubkey,last_checkpoint_sequence,attempt,terminal_reason,\
         discovery_protocol_version,payer_pubkey,price_per_retained_lead_nanousd,\
         billable_lead_limit,reserved_nanousd,settled_nanousd,released_nanousd,\
         billed_retained_lead_count,settlement_ref,settled_at,created_at,updated_at",
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
    let protocol_version: i16 = row.try_get("discovery_protocol_version")?;
    let last_checkpoint_sequence: i32 = row.try_get("last_checkpoint_sequence")?;
    let lease_owner_pubkey: Option<Vec<u8>> = row.try_get("lease_owner_pubkey")?;
    let lease_owner_pubkey = lease_owner_pubkey
        .map(|value| {
            value.try_into().map_err(|_| {
                DbError::InvalidData("Discovery lease_owner_pubkey must be a 32-byte pubkey".into())
            })
        })
        .transpose()?;
    let payer_pubkey: Option<Vec<u8>> = row.try_get("payer_pubkey")?;
    let payer_pubkey = payer_pubkey
        .map(|value| {
            value.try_into().map_err(|_| {
                DbError::InvalidData("Discovery payer_pubkey must be a 32-byte pubkey".into())
            })
        })
        .transpose()?;
    let money = |value: Option<i64>| -> Result<Option<DiscoveryNanoUsd>> {
        value
            .map(DiscoveryNanoUsd::new)
            .transpose()
            .map_err(|error| DbError::InvalidData(error.to_string()))
    };
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
        protocol_version: u16::try_from(protocol_version)
            .map_err(|_| DbError::InvalidData("Discovery protocol is invalid".into()))?,
        payer_pubkey,
        price_per_retained_lead_nanousd: money(row.try_get("price_per_retained_lead_nanousd")?)?,
        billable_lead_limit: row
            .try_get::<Option<i16>, _>("billable_lead_limit")?
            .map(u16::try_from)
            .transpose()
            .map_err(|_| DbError::InvalidData("Discovery billable Lead limit is invalid".into()))?,
        reserved_nanousd: money(row.try_get("reserved_nanousd")?)?,
        settled_nanousd: money(row.try_get("settled_nanousd")?)?,
        released_nanousd: money(row.try_get("released_nanousd")?)?,
        billed_retained_lead_count: row
            .try_get::<Option<i16>, _>("billed_retained_lead_count")?
            .map(u16::try_from)
            .transpose()
            .map_err(|_| DbError::InvalidData("Discovery billed Lead count is invalid".into()))?,
        settlement_ref: row.try_get("settlement_ref")?,
        settled_at: row.try_get("settled_at")?,
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
        discovery::{
            DiscoveryReceipt, DiscoverySource, DiscoverySourceConfig, DiscoverySourceMode,
            DiscoveryStartRequest, DISCOVERY_HOSTED_GATEWAY_PROTOCOL_VERSION,
            DISCOVERY_RETAINED_LEAD_PRICE_NANOUSD,
        },
        discovery_worker::{
            deterministic_business_observation_id, DiscoveryWorkerCheckpointRequest,
            DiscoveryWorkerClaimRequest, DiscoveryWorkerLeaseRequest,
            DiscoveryWorkerObservationBatchRequest, DiscoveryWorkerReceipt,
            DiscoveryWorkerSalvageBatchRequest, DiscoveryWorkerSourceProgressRequest,
        },
        discovery_workspace::{
            campaign_budget_fingerprint, DiscoveryCampaignBudgetApproval, DiscoveryCampaignInput,
            DiscoveryCampaignInputV2, DiscoveryLeadListRequest, DiscoveryLeadStatus,
            DiscoveryLeadUpdateInput, DiscoveryWorkspaceActionPayload, DiscoveryWorkspaceReceipt,
            DiscoveryWorkspaceRequest, DiscoveryWorkspaceResult,
        },
        CommunityId,
    };
    use buzz_sdk::discovery::{
        build_discovery_receipt_for_version, build_discovery_start_action, DiscoveryWireVersion,
    };
    use buzz_sdk::discovery_worker::{
        build_discovery_worker_checkpoint_action, build_discovery_worker_claim_action,
        build_discovery_worker_complete_action, build_discovery_worker_fail_action,
        build_discovery_worker_heartbeat_action, build_discovery_worker_receipt,
        build_discovery_worker_salvage_observations_action,
        build_discovery_worker_source_progress_action,
        build_discovery_worker_store_observations_action, parse_discovery_worker_action,
    };
    use buzz_sdk::discovery_workspace::{
        build_discovery_workspace_action, build_discovery_workspace_receipt,
    };
    use nostr::{EventBuilder, Keys, Kind, Tag};
    use uuid::Uuid;

    static DISCOVERY_DB_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn business_search() -> DiscoveryBusinessSearchSpec {
        DiscoveryBusinessSearchSpec {
            query: "dentists".to_owned(),
            location: "Sandton, Johannesburg, South Africa".to_owned(),
            limit: 3,
            language: "en".to_owned(),
            region: Some("ZA".to_owned()),
        }
    }

    async fn insert_test_campaign(
        db: &Db,
        community: CommunityId,
        actor: &[u8; 32],
        campaign_id: Uuid,
        search: &DiscoveryBusinessSearchSpec,
    ) {
        sqlx::query(
            "INSERT INTO discovery_campaigns \
             (community_id,id,created_by,name,industry_id,industry_name,vertical_id,vertical_name,\
              query,location,target,description,language,region) \
             VALUES ($1,$2,$3,$4,'healthcare','Healthcare','dentists','Dentists',\
                     $5,$6,$7,NULL,$8,$9)",
        )
        .bind(community.as_uuid())
        .bind(campaign_id)
        .bind(actor.as_slice())
        .bind(format!("Discovery test {campaign_id}"))
        .bind(&search.query)
        .bind(&search.location)
        .bind(i16::try_from(search.limit).expect("test target fits SMALLINT"))
        .bind(&search.language)
        .bind(search.region.as_deref())
        .execute(&db.pool)
        .await
        .expect("insert persisted campaign fixture");
    }

    fn business_observation(name: &str) -> DiscoveryBusinessObservationInput {
        business_observation_for(
            DiscoveryProvider::Outscraper,
            "0xabc:0xdef",
            name,
            "https://example.test",
        )
    }

    #[test]
    fn released_outscraper_worker_fingerprints_survive_the_multi_source_upgrade() {
        let claim = DiscoveryWorkerAction::Claim(DiscoveryWorkerClaimRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            worker_id: Uuid::new_v4(),
            protocol_version: buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION,
            available_providers: vec![DiscoveryProvider::Outscraper],
        });
        let actual = worker_action_fingerprint(&claim).expect("fingerprint claim");
        let mut expected = Sha256::new();
        expected.update(b"colony.discovery-worker-command/v1\0");
        expected.update(b"claim");
        expected.update([0]);
        expected.update(claim.worker_id().as_bytes());
        assert_eq!(actual, <[u8; 32]>::from(expected.finalize()));

        let observation = business_observation("Legacy Dental");
        let encoded = serde_json::to_vec(&observation).expect("encode released observation");
        assert!(!String::from_utf8_lossy(&encoded).contains("\"provider\""));
        assert!(!String::from_utf8_lossy(&encoded).contains("\"description\""));
        let mut expected = Sha256::new();
        expected.update(b"colony.discovery-business-observation/v1\0");
        expected.update(encoded);
        assert_eq!(
            observation_fingerprint(&observation).expect("fingerprint observation"),
            <[u8; 32]>::from(expected.finalize())
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn released_v1_run_start_refuses_a_multi_source_campaign() {
        let _test_guard = DISCOVERY_DB_TEST_LOCK.lock().await;
        let (db, community, _, _) = database_fixture().await;
        db.set_discovery_entitlement(community, true)
            .await
            .expect("entitle workspace");
        let actor = Keys::generate();
        sqlx::query("INSERT INTO relay_members (community_id,pubkey,role) VALUES ($1,$2,'member')")
            .bind(community.as_uuid())
            .bind(actor.public_key().to_hex())
            .execute(&db.pool)
            .await
            .expect("insert member");
        let search = business_search();
        let campaign_id = Uuid::new_v4();
        insert_test_campaign(
            &db,
            community,
            &actor.public_key().to_bytes(),
            campaign_id,
            &search,
        )
        .await;
        sqlx::query(
            "UPDATE discovery_campaigns SET source_mode='concurrent', \
             source_keys=ARRAY['brave_search','exa_search']::TEXT[] \
             WHERE community_id=$1 AND id=$2",
        )
        .bind(community.as_uuid())
        .bind(campaign_id)
        .execute(&db.pool)
        .await
        .expect("configure multi-source campaign");
        let action = EventBuilder::new(
            Kind::Custom(buzz_core::kind::KIND_DISCOVERY_ACTION as u16),
            "{}",
        )
        .sign_with_keys(&actor)
        .expect("sign released action fixture");
        let result = db
            .apply_discovery_command_once(
                community,
                &actor.public_key().to_bytes(),
                Uuid::new_v4(),
                DiscoveryCommandMutation::Start {
                    campaign_id,
                    business_search: Some(search),
                    total_steps: 1,
                    protocol_version: 1,
                    accepted_at: Utc::now(),
                },
                &action,
                |_| panic!("a refused V1 start must not build a receipt"),
            )
            .await;
        assert!(matches!(
            result,
            Err(DbError::InvalidData(message))
                if message == "This Discovery client does not support this Campaign source plan"
        ));
        let run_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM discovery_runs WHERE community_id=$1 AND campaign_id=$2",
        )
        .bind(community.as_uuid())
        .bind(campaign_id)
        .fetch_one(&db.pool)
        .await
        .expect("count refused runs");
        assert_eq!(run_count, 0);
    }

    fn business_observation_for(
        provider: DiscoveryProvider,
        provider_record_id: &str,
        name: &str,
        website: &str,
    ) -> DiscoveryBusinessObservationInput {
        let provider_record_id = provider_record_id.to_owned();
        DiscoveryBusinessObservationInput {
            observation_id: deterministic_business_observation_id(provider, &provider_record_id),
            provider,
            provider_record_id,
            place_id: (provider == DiscoveryProvider::Outscraper).then(|| "ChIJ_test".to_owned()),
            google_id: (provider == DiscoveryProvider::Outscraper)
                .then(|| "0xabc:0xdef".to_owned()),
            name: name.to_owned(),
            website: Some(website.to_owned()),
            phone: Some("+27 11 555 0100".to_owned()),
            full_address: Some("1 Example Road, Sandton".to_owned()),
            city: Some("Sandton".to_owned()),
            state: Some("Gauteng".to_owned()),
            postal_code: Some("2196".to_owned()),
            country: Some("South Africa".to_owned()),
            country_code: Some("ZA".to_owned()),
            latitude_micros: Some(-26_107_600),
            longitude_micros: Some(28_056_700),
            category: Some("Dentist".to_owned()),
            subtypes: vec!["Dental clinic".to_owned()],
            rating_hundredths: Some(470),
            reviews_count: Some(52),
            business_status: Some(DiscoveryBusinessStatus::Operational),
            verified: Some(true),
            source_url: Some("https://maps.google.com/example".to_owned()),
            image_url: Some("https://images.example.test/place.jpg".to_owned()),
            description: None,
        }
    }

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

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn paid_run_reserves_and_settles_new_leads_exactly_once() {
        let _test_guard = DISCOVERY_DB_TEST_LOCK.lock().await;
        let (db, community, _, _) = database_fixture().await;
        db.set_discovery_entitlement(community, true)
            .await
            .expect("entitle workspace");
        let actor = Keys::generate();
        let relay = Keys::generate();
        let actor_bytes = actor.public_key().to_bytes();
        sqlx::query("INSERT INTO relay_members (community_id,pubkey,role) VALUES ($1,$2,'member')")
            .bind(community.as_uuid())
            .bind(actor.public_key().to_hex())
            .execute(&db.pool)
            .await
            .expect("insert paid Discovery member");
        sqlx::query("INSERT INTO users (community_id,pubkey) VALUES ($1,$2)")
            .bind(community.as_uuid())
            .bind(actor_bytes.as_slice())
            .execute(&db.pool)
            .await
            .expect("insert paid Discovery human");
        sqlx::query(
            "INSERT INTO accounts (pubkey,balance) VALUES ($1,1000000000) \
             ON CONFLICT (pubkey) DO UPDATE SET balance=EXCLUDED.balance",
        )
        .bind(actor_bytes.as_slice())
        .execute(&db.pool)
        .await
        .expect("seed paid Discovery Credits");

        let search = business_search();
        let campaign_id = Uuid::new_v4();
        insert_test_campaign(&db, community, &actor_bytes, campaign_id, &search).await;
        sqlx::query(
            "UPDATE discovery_campaigns SET source_mode='waterfall',\
             source_keys=ARRAY['google_maps','brave_search','exa_search']::TEXT[] \
             WHERE community_id=$1 AND id=$2",
        )
        .bind(community.as_uuid())
        .bind(campaign_id)
        .execute(&db.pool)
        .await
        .expect("configure hosted source plan");
        let campaign = DiscoveryCampaignInputV2 {
            campaign_id,
            name: format!("Discovery test {campaign_id}"),
            industry_id: "healthcare".into(),
            industry_name: "Healthcare".into(),
            vertical_id: "dentists".into(),
            vertical_name: "Dentists".into(),
            query: search.query.clone(),
            location: search.location.clone(),
            target: search.limit,
            description: None,
            language: search.language.clone(),
            region: search.region.clone(),
        };
        let price = DiscoveryNanoUsd::new(DISCOVERY_RETAINED_LEAD_PRICE_NANOUSD)
            .expect("valid fixed price");
        let approval = DiscoveryWorkspaceRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            payload: DiscoveryWorkspaceActionPayload::ApproveCampaignBudget {
                approval: DiscoveryCampaignBudgetApproval {
                    campaign_id,
                    payer_pubkey: actor.public_key(),
                    approved_nanousd: price.checked_mul(search.limit).expect("approved budget"),
                    price_per_retained_lead_nanousd: price,
                    campaign_fingerprint: hex::encode(
                        campaign_budget_fingerprint(&campaign, &actor.public_key(), price)
                            .expect("Campaign fingerprint"),
                    ),
                    approval_action_event_id: None,
                    approval_expires_at: None,
                },
            },
        };
        let approval_result =
            apply_workspace_result(&db, community, &actor, &relay, &approval).await;
        let DiscoveryWorkspaceResult::Budget { budget } = approval_result else {
            panic!("approval returns a Campaign budget");
        };
        assert_eq!(budget.approved_nanousd.get(), 150_000_000);

        let start = DiscoveryStartRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            campaign_id,
            protocol_version: DISCOVERY_HOSTED_GATEWAY_PROTOCOL_VERSION,
            business_search: None,
        };
        let start_event = build_discovery_start_action(relay.public_key(), &start)
            .expect("build paid start")
            .sign_with_keys(&actor)
            .expect("sign paid start");
        let actor_pubkey = actor.public_key();
        let start_event_id = start_event.id;
        let relay_for_receipt = relay.clone();
        let applied = db
            .apply_discovery_command_once(
                community,
                &actor_bytes,
                start.idempotency_key,
                DiscoveryCommandMutation::Start {
                    campaign_id,
                    business_search: None,
                    total_steps: 1,
                    protocol_version: DISCOVERY_HOSTED_GATEWAY_PROTOCOL_VERSION,
                    accepted_at: Utc::now(),
                },
                &start_event,
                move |run| {
                    build_discovery_receipt_for_version(
                        DiscoveryWireVersion::V3,
                        actor_pubkey,
                        start_event_id,
                        &DiscoveryReceipt {
                            operation: DiscoveryOperation::Start,
                            request_id: start.request_id,
                            idempotency_key: start.idempotency_key,
                            run: run.projection(),
                        },
                    )
                    .map_err(|error| DbError::InvalidData(error.to_string()))?
                    .sign_with_keys(&relay_for_receipt)
                    .map_err(|error| DbError::InvalidData(error.to_string()))
                },
            )
            .await
            .expect("reserve paid run");
        let run = match applied {
            DiscoveryCommandApply::Applied { run, .. } => run,
            DiscoveryCommandApply::Duplicate { .. } => panic!("fresh paid start"),
        };
        assert_eq!(
            run.reserved_nanousd.expect("reservation").get(),
            150_000_000
        );
        let source_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM discovery_run_sources WHERE community_id=$1 AND run_id=$2",
        )
        .bind(community.as_uuid())
        .bind(run.id)
        .fetch_one(&db.pool)
        .await
        .expect("count hosted run sources");
        assert_eq!(source_count, 3);

        let worker_id = Uuid::new_v4();
        let claim = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::Claim(DiscoveryWorkerClaimRequest {
                    request_id: Uuid::new_v4(),
                    idempotency_key: Uuid::new_v4(),
                    worker_id,
                    protocol_version: DISCOVERY_HOSTED_GATEWAY_PROTOCOL_VERSION,
                    available_providers: Vec::new(),
                }),
                Duration::seconds(30),
            )
            .await
            .expect("claim paid run"),
        );
        let DiscoveryWorkerReceiptOutcome::Lease(lease) = claim else {
            panic!("paid run is claimable only by protocol V3");
        };
        assert_eq!(lease.run.run_id, run.id);
        let context = db
            .discovery_gateway_run_context(
                community,
                &actor_bytes,
                run.id,
                lease.lease_id,
                DiscoveryProvider::Outscraper,
            )
            .await
            .expect("derive hosted request context");
        assert_eq!(context.request_cursor, None);
        let fence = format!("colony_pending_{}", Uuid::new_v4().simple());
        assert!(db
            .fence_discovery_gateway_submission(
                community,
                &actor_bytes,
                run.id,
                lease.lease_id,
                DiscoveryProvider::Outscraper,
                &fence,
            )
            .await
            .expect("fence provider spend"));
        assert!(matches!(
            db.discovery_gateway_run_context(
                community,
                &actor_bytes,
                run.id,
                lease.lease_id,
                DiscoveryProvider::BraveSearch,
            )
            .await,
            Err(DbError::AccessDenied(_))
        ));
        assert!(!db
            .fence_discovery_gateway_submission(
                community,
                &actor_bytes,
                run.id,
                lease.lease_id,
                DiscoveryProvider::Outscraper,
                "colony_pending_competing",
            )
            .await
            .expect("refuse competing provider spend"));
        assert!(db
            .record_discovery_gateway_response(
                community,
                &actor_bytes,
                run.id,
                lease.lease_id,
                DiscoveryProvider::Outscraper,
                "colony_pending_wrong",
                "provider-job-paid",
                None,
            )
            .await
            .is_err());
        let stored = db
            .record_discovery_gateway_response(
                community,
                &actor_bytes,
                run.id,
                lease.lease_id,
                DiscoveryProvider::Outscraper,
                &fence,
                "provider-job-paid",
                None,
            )
            .await
            .expect("finalize provider fence");
        assert!(matches!(
            stored,
            DiscoveryGatewayStoredResponse::Pending { provider_request_id }
                if provider_request_id == "provider-job-paid"
        ));
        sqlx::query(
            "UPDATE discovery_runs SET lease_until=now()-INTERVAL '1 second' \
             WHERE community_id=$1 AND id=$2",
        )
        .bind(community.as_uuid())
        .bind(run.id)
        .execute(&db.pool)
        .await
        .expect("expire hosted provider lease");
        assert!(matches!(
            db.record_discovery_gateway_response(
                community,
                &actor_bytes,
                run.id,
                lease.lease_id,
                DiscoveryProvider::Outscraper,
                "provider-job-paid",
                "provider-job-paid",
                Some(&[]),
            )
            .await,
            Err(DbError::AccessDenied(_))
        ));
        sqlx::query(
            "UPDATE discovery_runs SET lease_until=now()+INTERVAL '1 minute' \
             WHERE community_id=$1 AND id=$2",
        )
        .bind(community.as_uuid())
        .bind(run.id)
        .execute(&db.pool)
        .await
        .expect("restore hosted provider lease");
        let provider_observations = (0..4)
            .map(|index| {
                let mut observation = business_observation_for(
                    DiscoveryProvider::Outscraper,
                    &format!("paid-provider-lead-{index}"),
                    &format!("Paid Dental Lead {index}"),
                    &format!("https://paid-dental-{index}.test"),
                );
                observation.phone = Some(format!("+27 11 555 01{index:02}"));
                observation
            })
            .collect::<Vec<_>>();
        let stored = db
            .record_discovery_gateway_response(
                community,
                &actor_bytes,
                run.id,
                lease.lease_id,
                DiscoveryProvider::Outscraper,
                "provider-job-paid",
                "provider-job-paid",
                Some(&provider_observations),
            )
            .await
            .expect("store provider result before client acknowledgement");
        assert!(matches!(
            stored,
            DiscoveryGatewayStoredResponse::Ready { observations, .. }
                if observations == provider_observations[..3]
        ));
        assert!(matches!(
            db.discovery_gateway_stored_response(
                community,
                run.id,
                DiscoveryProvider::Outscraper,
            )
            .await
            .expect("replay stored provider result"),
            Some(DiscoveryGatewayStoredResponse::Ready { observations, .. })
                if observations == provider_observations[..3]
        ));
        sqlx::query(
            "UPDATE discovery_run_sources SET status='completed',started_at=now(),\
             finished_at=now(),updated_at=now() WHERE community_id=$1 AND run_id=$2",
        )
        .bind(community.as_uuid())
        .bind(run.id)
        .execute(&db.pool)
        .await
        .expect("finish paid run sources");
        let complete =
            DiscoveryWorkerAction::Complete(lease_request(worker_id, run.id, lease.lease_id));
        let completed = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                complete.clone(),
                Duration::seconds(30),
            )
            .await
            .expect("settle paid run"),
        );
        let DiscoveryWorkerReceiptOutcome::Completed(completed) = completed else {
            panic!("paid run completes");
        };
        assert_eq!(
            completed
                .billing
                .as_ref()
                .and_then(|billing| billing.billed_retained_lead_count),
            Some(3)
        );
        assert!(matches!(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                complete,
                Duration::seconds(30),
            )
            .await
            .expect("replay paid completion"),
            DiscoveryWorkerCommandApply::Duplicate { .. }
        ));
        let ledger_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM credit_ledger WHERE pubkey=$1 AND service='discovery' \
             AND discovery_run_id=$2",
        )
        .bind(actor_bytes.as_slice())
        .bind(run.id)
        .fetch_one(&db.pool)
        .await
        .expect("count paid Discovery ledger rows");
        let balance: i64 = sqlx::query_scalar("SELECT balance FROM accounts WHERE pubkey=$1")
            .bind(actor_bytes.as_slice())
            .fetch_one(&db.pool)
            .await
            .expect("load paid Discovery balance");
        let campaign_amounts: (i64, i64) = sqlx::query_as(
            "SELECT budget_spent_nanousd,budget_reserved_nanousd FROM discovery_campaigns \
             WHERE community_id=$1 AND id=$2",
        )
        .bind(community.as_uuid())
        .bind(campaign_id)
        .fetch_one(&db.pool)
        .await
        .expect("load settled Campaign budget");
        assert_eq!(ledger_count, 1);
        assert_eq!(balance, 850_000_000);
        assert_eq!(campaign_amounts, (150_000_000, 0));
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn campaign_source_changes_do_not_mutate_existing_run_snapshots() {
        let _test_guard = DISCOVERY_DB_TEST_LOCK.lock().await;
        let (db, community, human, _) = database_fixture().await;
        db.set_discovery_entitlement(community, true)
            .await
            .expect("entitle workspace");
        let search = business_search();
        let campaign_id = Uuid::new_v4();
        insert_test_campaign(&db, community, &human, campaign_id, &search).await;
        sqlx::query(
            "UPDATE discovery_campaigns \
             SET source_mode='concurrent',source_keys=ARRAY['brave_search','exa_search']::TEXT[] \
             WHERE community_id=$1 AND id=$2",
        )
        .bind(community.as_uuid())
        .bind(campaign_id)
        .execute(&db.pool)
        .await
        .expect("save concurrent Campaign sources");

        let run_id = match db
            .create_discovery_run_once(community, &human, campaign_id, Uuid::new_v4(), 2, &search)
            .await
            .expect("create run with immutable source plan")
        {
            DiscoveryRunCreate::Created(run) | DiscoveryRunCreate::Existing(run) => run.id,
        };

        sqlx::query(
            "UPDATE discovery_campaigns \
             SET source_mode='waterfall',source_keys=ARRAY['google_maps']::TEXT[] \
             WHERE community_id=$1 AND id=$2",
        )
        .bind(community.as_uuid())
        .bind(campaign_id)
        .execute(&db.pool)
        .await
        .expect("change future Campaign sources");

        let campaign_plan: (String, Vec<String>) = sqlx::query_as(
            "SELECT source_mode,source_keys FROM discovery_campaigns \
             WHERE community_id=$1 AND id=$2",
        )
        .bind(community.as_uuid())
        .bind(campaign_id)
        .fetch_one(&db.pool)
        .await
        .expect("load current Campaign plan");
        let run_plan: (String, Vec<String>) = sqlx::query_as(
            "SELECT source_mode,source_keys FROM discovery_run_source_plans \
             WHERE community_id=$1 AND run_id=$2",
        )
        .bind(community.as_uuid())
        .bind(run_id)
        .fetch_one(&db.pool)
        .await
        .expect("load immutable run plan");
        let run_sources: Vec<(String, String, i16)> = sqlx::query_as(
            "SELECT source_key,provider,position FROM discovery_run_sources \
             WHERE community_id=$1 AND run_id=$2 ORDER BY position",
        )
        .bind(community.as_uuid())
        .bind(run_id)
        .fetch_all(&db.pool)
        .await
        .expect("load per-source run rows");

        assert_eq!(
            campaign_plan,
            ("waterfall".into(), vec!["google_maps".into()])
        );
        assert_eq!(
            run_plan,
            (
                "concurrent".into(),
                vec!["brave_search".into(), "exa_search".into()]
            )
        );
        assert_eq!(
            run_sources,
            vec![
                ("brave_search".into(), "brave_search".into(), 0),
                ("exa_search".into(), "exa_search".into(), 1),
            ]
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn new_campaign_ignores_legacy_sources_and_rejects_source_updates() {
        use crate::discovery_workspace::DiscoveryWorkspaceCommandApply;

        let _test_guard = DISCOVERY_DB_TEST_LOCK.lock().await;
        let (db, community, _, _) = database_fixture().await;
        db.set_discovery_entitlement(community, true)
            .await
            .expect("entitle workspace");
        let actor = Keys::generate();
        let relay = Keys::generate();
        sqlx::query("INSERT INTO relay_members (community_id,pubkey,role) VALUES ($1,$2,'member')")
            .bind(community.as_uuid())
            .bind(actor.public_key().to_hex())
            .execute(&db.pool)
            .await
            .expect("insert workspace actor member");
        sqlx::query("INSERT INTO users (community_id,pubkey) VALUES ($1,$2)")
            .bind(community.as_uuid())
            .bind(actor.public_key().to_bytes().as_slice())
            .execute(&db.pool)
            .await
            .expect("insert workspace actor identity");

        let campaign_id = Uuid::new_v4();
        let create = DiscoveryWorkspaceRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            payload: DiscoveryWorkspaceActionPayload::CreateCampaign {
                campaign: Box::new(
                    buzz_core::discovery_workspace::DiscoveryCampaignCreateInput::Legacy(
                        DiscoveryCampaignInput {
                            campaign_id,
                            name: "Sandton dentists".into(),
                            industry_id: "healthcare".into(),
                            industry_name: "Healthcare".into(),
                            vertical_id: "dentists".into(),
                            vertical_name: "Dentists".into(),
                            query: "dentists".into(),
                            location: "Sandton, Johannesburg, South Africa".into(),
                            target: 50,
                            description: None,
                            language: "en".into(),
                            region: Some("ZA".into()),
                            source_config: DiscoverySourceConfig {
                                mode: DiscoverySourceMode::Concurrent,
                                sources: vec![
                                    DiscoverySource::BraveSearch,
                                    DiscoverySource::ExaSearch,
                                ],
                            },
                        },
                    ),
                ),
                budget_approval: None,
            },
        };
        let create_event = build_discovery_workspace_action(relay.public_key(), &create)
            .expect("build Campaign create")
            .sign_with_keys(&actor)
            .expect("sign Campaign create");
        let created =
            apply_workspace_request(&db, community, &actor, &relay, &create, &create_event)
                .await
                .expect("create Campaign");
        let DiscoveryWorkspaceCommandApply::Applied { result, .. } = created else {
            panic!("first Campaign create must apply");
        };
        let DiscoveryWorkspaceResult::Campaign { campaign } = *result else {
            panic!("Campaign create must return Campaign");
        };
        assert_eq!(
            campaign.source_config,
            DiscoverySourceConfig {
                mode: DiscoverySourceMode::Waterfall,
                sources: vec![
                    DiscoverySource::GoogleMaps,
                    DiscoverySource::BraveSearch,
                    DiscoverySource::ExaSearch,
                ],
            }
        );

        let update = DiscoveryWorkspaceRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            payload: DiscoveryWorkspaceActionPayload::UpdateCampaignSources {
                campaign_id,
                source_config: DiscoverySourceConfig {
                    mode: DiscoverySourceMode::Waterfall,
                    sources: vec![DiscoverySource::ExaSearch, DiscoverySource::GoogleMaps],
                },
            },
        };
        assert!(matches!(
            build_discovery_workspace_action(relay.public_key(), &update),
            Err(
                buzz_sdk::discovery_workspace::DiscoveryWorkspaceSdkError::InvalidEnvelope(
                    "workspace action"
                )
            )
        ));
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
        for table in crate::deletion::PURGE_SCOPED_TABLES {
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

    async fn purge_test_community(db: &Db, community: CommunityId) {
        for table in crate::deletion::PURGE_SCOPED_TABLES {
            let sql = format!("DELETE FROM {table} WHERE community_id=$1");
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(community.as_uuid())
                .execute(&db.pool)
                .await
                .unwrap_or_else(|error| panic!("clean {table} fixture: {error}"));
        }
        sqlx::query("DELETE FROM communities WHERE id=$1")
            .bind(community.as_uuid())
            .execute(&db.pool)
            .await
            .expect("clean community fixture");
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
            DiscoveryWorkerAction::SourceProgress(request) => {
                build_discovery_worker_source_progress_action(relay.public_key(), request)
            }
            DiscoveryWorkerAction::StoreObservations(request) => {
                build_discovery_worker_store_observations_action(relay.public_key(), request)
            }
            DiscoveryWorkerAction::SalvageObservations(request) => {
                build_discovery_worker_salvage_observations_action(relay.public_key(), request)
            }
            DiscoveryWorkerAction::Fail(request) => {
                build_discovery_worker_fail_action(relay.public_key(), request)
            }
            DiscoveryWorkerAction::Complete(request) => {
                build_discovery_worker_complete_action(relay.public_key(), request)
            }
        }
        .map_err(|error| DbError::InvalidData(error.to_string()))?;
        let event = builder
            .sign_with_keys(actor)
            .map_err(|error| DbError::InvalidData(error.to_string()))?;
        apply_worker_action_event(db, community, actor, relay, action, event, lease_duration).await
    }

    async fn apply_v1_worker_action(
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
            DiscoveryWorkerAction::Fail(request) => {
                build_discovery_worker_fail_action(relay.public_key(), request)
            }
            DiscoveryWorkerAction::Complete(request) => {
                build_discovery_worker_complete_action(relay.public_key(), request)
            }
            _ => {
                return Err(DbError::InvalidData(
                    "test v1 helper only supports terminal worker actions".into(),
                ))
            }
        }
        .map_err(|error| DbError::InvalidData(error.to_string()))?
        .sign_with_keys(actor)
        .map_err(|error| DbError::InvalidData(error.to_string()))?;
        let tags = builder
            .tags
            .iter()
            .map(|tag| {
                let mut parts = tag.as_slice().to_vec();
                if parts
                    .first()
                    .is_some_and(|value| value == "discovery-worker-action")
                {
                    parts[1] = "1".to_owned();
                }
                Tag::parse(parts).map_err(|error| DbError::InvalidData(error.to_string()))
            })
            .collect::<Result<Vec<_>>>()?;
        let mut content = builder.content.replace(
            "colony.discovery-worker-action/v2",
            "colony.discovery-worker-action/v1",
        );
        if matches!(&action, DiscoveryWorkerAction::Claim(_)) {
            let v2_capabilities = "\"available_providers\":[\"outscraper\"],";
            if !content.contains(v2_capabilities) {
                return Err(DbError::InvalidData(
                    "test V1 claim fixture did not contain V2 capabilities".into(),
                ));
            }
            content = content.replacen(v2_capabilities, "", 1);
        }
        let event = EventBuilder::new(builder.kind, content)
            .tags(tags)
            .sign_with_keys(actor)
            .map_err(|error| DbError::InvalidData(error.to_string()))?;
        let parsed = parse_discovery_worker_action(&event)
            .map_err(|error| DbError::InvalidData(error.to_string()))?;
        let mut expected_action = action;
        if let DiscoveryWorkerAction::Claim(request) = &mut expected_action {
            request.protocol_version = 1;
            request.available_providers = vec![DiscoveryProvider::Outscraper];
        }
        if parsed.action != expected_action {
            return Err(DbError::InvalidData(
                "test V1 action fixture changed the parsed action".into(),
            ));
        }
        apply_worker_action_event(
            db,
            community,
            actor,
            relay,
            parsed.action,
            event,
            lease_duration,
        )
        .await
    }

    async fn apply_worker_action_event(
        db: &Db,
        community: CommunityId,
        actor: &Keys,
        relay: &Keys,
        action: DiscoveryWorkerAction,
        event: Event,
        lease_duration: Duration,
    ) -> Result<DiscoveryWorkerCommandApply> {
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

    async fn apply_workspace_request(
        db: &Db,
        community: CommunityId,
        actor: &Keys,
        relay: &Keys,
        request: &DiscoveryWorkspaceRequest,
        action: &Event,
    ) -> Result<super::super::discovery_workspace::DiscoveryWorkspaceCommandApply> {
        let operation = request.payload.operation();
        let request_id = request.request_id;
        let idempotency_key = request.idempotency_key;
        let actor_pubkey = actor.public_key();
        let action_event_id = action.id;
        db.apply_discovery_workspace_command_once(
            community,
            &actor.public_key().to_bytes(),
            None,
            request,
            action,
            |result| {
                let receipt = DiscoveryWorkspaceReceipt {
                    operation,
                    request_id,
                    idempotency_key,
                    result: result.clone(),
                };
                build_discovery_workspace_receipt(actor_pubkey, action_event_id, &receipt)
                    .map_err(|error| DbError::InvalidData(error.to_string()))?
                    .sign_with_keys(relay)
                    .map_err(|error| DbError::InvalidData(error.to_string()))
            },
        )
        .await
    }

    async fn apply_workspace_result(
        db: &Db,
        community: CommunityId,
        actor: &Keys,
        relay: &Keys,
        request: &DiscoveryWorkspaceRequest,
    ) -> DiscoveryWorkspaceResult {
        use crate::discovery_workspace::DiscoveryWorkspaceCommandApply;

        let action = build_discovery_workspace_action(relay.public_key(), request)
            .expect("build workspace action")
            .sign_with_keys(actor)
            .expect("sign workspace action");
        match apply_workspace_request(db, community, actor, relay, request, &action)
            .await
            .expect("apply workspace action")
        {
            DiscoveryWorkspaceCommandApply::Applied { result, .. } => *result,
            DiscoveryWorkspaceCommandApply::Duplicate { .. } => {
                panic!("test action unexpectedly reused an idempotency key")
            }
        }
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
            DiscoveryWorkerCommandApply::Applied { outcome, .. } => *outcome,
            DiscoveryWorkerCommandApply::Duplicate { .. } => {
                panic!("test action unexpectedly reused an idempotency key")
            }
        }
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn v2_worker_replay_matches_a_persisted_released_v1_claim() {
        let _test_guard = DISCOVERY_DB_TEST_LOCK.lock().await;
        let (db, community, _, _) = database_fixture().await;
        db.set_discovery_entitlement(community, true)
            .await
            .expect("entitle workspace");
        let actor = Keys::generate();
        sqlx::query("INSERT INTO relay_members (community_id,pubkey,role) VALUES ($1,$2,'member')")
            .bind(community.as_uuid())
            .bind(actor.public_key().to_hex())
            .execute(&db.pool)
            .await
            .expect("insert worker member");
        sqlx::query("INSERT INTO users (community_id,pubkey) VALUES ($1,$2)")
            .bind(community.as_uuid())
            .bind(actor.public_key().to_bytes().as_slice())
            .execute(&db.pool)
            .await
            .expect("insert worker identity");

        let request = DiscoveryWorkerClaimRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            worker_id: Uuid::new_v4(),
            protocol_version: buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION,
            available_providers: vec![DiscoveryProvider::Outscraper],
        };
        let mut legacy_fingerprint = Sha256::new();
        legacy_fingerprint.update(b"colony.discovery-worker-command/v1\0");
        legacy_fingerprint.update(b"claim");
        legacy_fingerprint.update([0]);
        legacy_fingerprint.update(request.worker_id.as_bytes());
        let original_action_event_id = vec![41_u8; 32];
        let original_receipt_event_id = vec![42_u8; 32];
        sqlx::query(
            "INSERT INTO discovery_worker_action_claims \
             (community_id,idempotency_key,operation,request_fingerprint,action_event_id,receipt_event_id) \
             VALUES ($1,$2,'claim',$3,$4,$5)",
        )
        .bind(community.as_uuid())
        .bind(request.idempotency_key)
        .bind(<[u8; 32]>::from(legacy_fingerprint.finalize()).as_slice())
        .bind(&original_action_event_id)
        .bind(&original_receipt_event_id)
        .execute(&db.pool)
        .await
        .expect("seed released v1 claim");

        let relay = Keys::generate();
        let event = build_discovery_worker_claim_action(relay.public_key(), &request)
            .expect("build v2 claim")
            .sign_with_keys(&actor)
            .expect("sign v2 claim");
        let replay = db
            .apply_discovery_worker_command_once(
                community,
                &actor.public_key().to_bytes(),
                &DiscoveryWorkerAction::Claim(request),
                &event,
                Duration::seconds(30),
                |_| panic!("duplicate claim must not build another receipt"),
            )
            .await
            .expect("match released claim fingerprint");
        assert!(matches!(
            replay,
            DiscoveryWorkerCommandApply::Duplicate {
                original_action_event_id: action,
                receipt_event_id: receipt,
            } if action == original_action_event_id && receipt == original_receipt_event_id
        ));
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn released_v1_worker_cannot_claim_protocol_v2_run() {
        let _test_guard = DISCOVERY_DB_TEST_LOCK.lock().await;
        let (db, community, human, _) = database_fixture().await;
        db.set_discovery_entitlement(community, true)
            .await
            .expect("entitle workspace");

        let search = business_search();
        let campaign_id = Uuid::new_v4();
        insert_test_campaign(&db, community, &human, campaign_id, &search).await;
        sqlx::query(
            "UPDATE discovery_campaigns \
             SET source_mode='concurrent',source_keys=ARRAY['brave_search','exa_search']::TEXT[] \
             WHERE community_id=$1 AND id=$2",
        )
        .bind(community.as_uuid())
        .bind(campaign_id)
        .execute(&db.pool)
        .await
        .expect("configure protocol V2 Campaign");
        let run_id = match db
            .create_discovery_run_once(community, &human, campaign_id, Uuid::new_v4(), 1, &search)
            .await
            .expect("create protocol V2 run")
        {
            DiscoveryRunCreate::Created(run) | DiscoveryRunCreate::Existing(run) => run.id,
        };

        // Keep this query byte-for-byte aligned with origin/develop's released
        // in-process worker claim. A rollback must be refused before it can
        // return a lease and make an Outscraper call for a Brave/Exa run.
        let legacy_claim = sqlx::query(
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
             RETURNING r.id",
        )
        .bind(Uuid::new_v4())
        .bind(Utc::now() + Duration::seconds(30))
        .fetch_optional(&db.pool)
        .await;
        assert!(matches!(
            legacy_claim,
            Err(sqlx::Error::Database(error)) if error.code().as_deref() == Some("23514")
        ));

        let unchanged: (String, Option<Uuid>) = sqlx::query_as(
            "SELECT state,claim_id FROM discovery_runs WHERE community_id=$1 AND id=$2",
        )
        .bind(community.as_uuid())
        .bind(run_id)
        .fetch_one(&db.pool)
        .await
        .expect("read rollback-fenced run");
        assert_eq!(unchanged, ("queued".to_owned(), None));

        let current_claim_id = Uuid::new_v4();
        let current_claim: (Uuid, i16, Option<Uuid>) = sqlx::query_as(
            "UPDATE discovery_runs \
             SET state='running',claim_id=$3,lease_until=$4,worker_id=$5, \
                 lease_owner_pubkey=$6,lease_worker_protocol_version=2, \
                 lease_worker_protocol_claim_id=$3,updated_at=now() \
             WHERE community_id=$1 AND id=$2 \
             RETURNING id,lease_worker_protocol_version,lease_worker_protocol_claim_id",
        )
        .bind(community.as_uuid())
        .bind(run_id)
        .bind(current_claim_id)
        .bind(Utc::now() + Duration::seconds(30))
        .bind(Uuid::new_v4())
        .bind(human.as_slice())
        .fetch_one(&db.pool)
        .await
        .expect("protocol V2 worker may claim protocol V2 run");
        assert_eq!(current_claim, (run_id, 2, Some(current_claim_id)));

        sqlx::query(
            "UPDATE discovery_runs SET lease_until=now() - interval '1 second' \
             WHERE community_id=$1 AND id=$2",
        )
        .bind(community.as_uuid())
        .bind(run_id)
        .execute(&db.pool)
        .await
        .expect("expire protocol V2 lease");

        let stale_reclaim_id = Uuid::new_v4();
        let stale_legacy_reclaim = sqlx::query(
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
             RETURNING r.id",
        )
        .bind(stale_reclaim_id)
        .bind(Utc::now() + Duration::seconds(30))
        .fetch_optional(&db.pool)
        .await;
        assert!(matches!(
            stale_legacy_reclaim,
            Err(sqlx::Error::Database(error)) if error.code().as_deref() == Some("23514")
        ));

        let preserved_claim: (Uuid, i16, Option<Uuid>) = sqlx::query_as(
            "SELECT claim_id,lease_worker_protocol_version,lease_worker_protocol_claim_id \
             FROM discovery_runs WHERE community_id=$1 AND id=$2",
        )
        .bind(community.as_uuid())
        .bind(run_id)
        .fetch_one(&db.pool)
        .await
        .expect("protocol V2 lease claim remains fenced");
        assert_eq!(
            preserved_claim,
            (current_claim_id, 2, Some(current_claim_id))
        );

        let cleared: (Option<i16>, Option<Uuid>) = sqlx::query_as(
            "UPDATE discovery_runs SET state='cancelled',claim_id=NULL,lease_until=NULL, \
             worker_id=NULL,lease_owner_pubkey=NULL WHERE community_id=$1 AND id=$2 \
             RETURNING lease_worker_protocol_version,lease_worker_protocol_claim_id",
        )
        .bind(community.as_uuid())
        .bind(run_id)
        .fetch_one(&db.pool)
        .await
        .expect("terminal transition clears worker protocol marker");
        assert_eq!(cleared, (None, None));
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn released_v1_external_worker_cannot_claim_default_protocol_v2_run() {
        let _test_guard = DISCOVERY_DB_TEST_LOCK.lock().await;
        let (db, community, _, _) = database_fixture().await;
        db.set_discovery_entitlement(community, true)
            .await
            .expect("entitle workspace");
        let actor = Keys::generate();
        let actor_bytes = actor.public_key().to_bytes();
        sqlx::query("INSERT INTO relay_members (community_id,pubkey,role) VALUES ($1,$2,'member')")
            .bind(community.as_uuid())
            .bind(actor.public_key().to_hex())
            .execute(&db.pool)
            .await
            .expect("insert worker member");
        sqlx::query("INSERT INTO users (community_id,pubkey) VALUES ($1,$2)")
            .bind(community.as_uuid())
            .bind(actor_bytes.as_slice())
            .execute(&db.pool)
            .await
            .expect("insert worker identity");

        let search = business_search();
        let campaign_id = Uuid::new_v4();
        insert_test_campaign(&db, community, &actor_bytes, campaign_id, &search).await;
        let run_id = match db
            .create_discovery_run_once(
                community,
                &actor_bytes,
                campaign_id,
                Uuid::new_v4(),
                1,
                &search,
            )
            .await
            .expect("create default-source protocol V2 run")
        {
            DiscoveryRunCreate::Created(run) | DiscoveryRunCreate::Existing(run) => run.id,
        };

        let relay = Keys::generate();
        let legacy_claim = applied_worker_outcome(
            apply_v1_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::Claim(DiscoveryWorkerClaimRequest {
                    request_id: Uuid::new_v4(),
                    idempotency_key: Uuid::new_v4(),
                    worker_id: Uuid::new_v4(),
                    protocol_version: buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION,
                    available_providers: vec![DiscoveryProvider::Outscraper],
                }),
                Duration::seconds(30),
            )
            .await
            .expect("legacy worker claim is safely answered"),
        );
        assert!(matches!(legacy_claim, DiscoveryWorkerReceiptOutcome::Idle));

        let unchanged: (String, i32, Option<Uuid>, Option<i16>, Option<Uuid>) = sqlx::query_as(
            "SELECT state,attempt,claim_id,lease_worker_protocol_version, \
                 lease_worker_protocol_claim_id FROM discovery_runs \
                 WHERE community_id=$1 AND id=$2",
        )
        .bind(community.as_uuid())
        .bind(run_id)
        .fetch_one(&db.pool)
        .await
        .expect("read rollback-fenced external-worker run");
        assert_eq!(unchanged, ("queued".to_owned(), 0, None, None, None));
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn protocol_v2_lease_rejects_a_signed_v1_terminal_downgrade() {
        let _test_guard = DISCOVERY_DB_TEST_LOCK.lock().await;
        let (db, community, _, _) = database_fixture().await;
        db.set_discovery_entitlement(community, true)
            .await
            .expect("entitle workspace");
        let actor = Keys::generate();
        let actor_bytes = actor.public_key().to_bytes();
        sqlx::query("INSERT INTO relay_members (community_id,pubkey,role) VALUES ($1,$2,'member')")
            .bind(community.as_uuid())
            .bind(actor.public_key().to_hex())
            .execute(&db.pool)
            .await
            .expect("insert worker member");
        sqlx::query("INSERT INTO users (community_id,pubkey) VALUES ($1,$2)")
            .bind(community.as_uuid())
            .bind(actor_bytes.as_slice())
            .execute(&db.pool)
            .await
            .expect("insert worker identity");

        let search = business_search();
        let campaign_id = Uuid::new_v4();
        insert_test_campaign(&db, community, &actor_bytes, campaign_id, &search).await;
        let run_id = match db
            .create_discovery_run_once(
                community,
                &actor_bytes,
                campaign_id,
                Uuid::new_v4(),
                1,
                &search,
            )
            .await
            .expect("create default-source protocol V2 run")
        {
            DiscoveryRunCreate::Created(run) | DiscoveryRunCreate::Existing(run) => run.id,
        };

        let relay = Keys::generate();
        let worker_id = Uuid::new_v4();
        let claim = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::Claim(DiscoveryWorkerClaimRequest {
                    request_id: Uuid::new_v4(),
                    idempotency_key: Uuid::new_v4(),
                    worker_id,
                    protocol_version: buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION,
                    available_providers: vec![DiscoveryProvider::Outscraper],
                }),
                Duration::seconds(30),
            )
            .await
            .expect("protocol V2 worker claims default-source run"),
        );
        let DiscoveryWorkerReceiptOutcome::Lease(lease) = claim else {
            panic!("protocol V2 worker must receive the run");
        };
        assert_eq!(lease.run.run_id, run_id);

        let downgraded = apply_v1_worker_action(
            &db,
            community,
            &actor,
            &relay,
            DiscoveryWorkerAction::Complete(lease_request(worker_id, run_id, lease.lease_id)),
            Duration::seconds(30),
        )
        .await;
        assert!(matches!(
            downgraded,
            Err(DbError::AccessDenied(message))
                if message.contains("protocol does not match the current lease")
        ));

        let unchanged_run: String =
            sqlx::query_scalar("SELECT state FROM discovery_runs WHERE community_id=$1 AND id=$2")
                .bind(community.as_uuid())
                .bind(run_id)
                .fetch_one(&db.pool)
                .await
                .expect("read downgrade-fenced run");
        let unchanged_source: String = sqlx::query_scalar(
            "SELECT status FROM discovery_run_sources \
             WHERE community_id=$1 AND run_id=$2 AND provider='outscraper'",
        )
        .bind(community.as_uuid())
        .bind(run_id)
        .fetch_one(&db.pool)
        .await
        .expect("read downgrade-fenced source");
        assert_eq!(unchanged_run, "running");
        assert_eq!(unchanged_source, "pending");
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn worker_claim_requires_every_provider_in_the_run_snapshot() {
        let _test_guard = DISCOVERY_DB_TEST_LOCK.lock().await;
        let (db, community, _, _) = database_fixture().await;
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
            .bind(actor.public_key().to_bytes().as_slice())
            .execute(&db.pool)
            .await
            .expect("insert worker identity");

        let search = business_search();
        let campaign_id = Uuid::new_v4();
        insert_test_campaign(&db, community, &actor_bytes, campaign_id, &search).await;
        sqlx::query(
            "UPDATE discovery_campaigns \
             SET source_mode='concurrent',source_keys=ARRAY['brave_search','exa_search']::TEXT[] \
             WHERE community_id=$1 AND id=$2",
        )
        .bind(community.as_uuid())
        .bind(campaign_id)
        .execute(&db.pool)
        .await
        .expect("configure multi-source Campaign");
        let run_id = match db
            .create_discovery_run_once(
                community,
                &actor_bytes,
                campaign_id,
                Uuid::new_v4(),
                1,
                &search,
            )
            .await
            .expect("create capability-matched run")
        {
            DiscoveryRunCreate::Created(run) | DiscoveryRunCreate::Existing(run) => run.id,
        };

        let incompatible = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::Claim(DiscoveryWorkerClaimRequest {
                    request_id: Uuid::new_v4(),
                    idempotency_key: Uuid::new_v4(),
                    worker_id: Uuid::new_v4(),
                    protocol_version: buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION,
                    available_providers: vec![DiscoveryProvider::Outscraper],
                }),
                Duration::seconds(30),
            )
            .await
            .expect("incompatible claim is safely idle"),
        );
        assert_eq!(incompatible, DiscoveryWorkerReceiptOutcome::Idle);
        let untouched: (String, i32, Option<Uuid>) = sqlx::query_as(
            "SELECT state,attempt,claim_id FROM discovery_runs WHERE community_id=$1 AND id=$2",
        )
        .bind(community.as_uuid())
        .bind(run_id)
        .fetch_one(&db.pool)
        .await
        .expect("load untouched run");
        assert_eq!(untouched, ("queued".to_owned(), 0, None));

        let compatible_worker = Uuid::new_v4();
        let compatible = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::Claim(DiscoveryWorkerClaimRequest {
                    request_id: Uuid::new_v4(),
                    idempotency_key: Uuid::new_v4(),
                    worker_id: compatible_worker,
                    protocol_version: buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION,
                    available_providers: vec![
                        DiscoveryProvider::BraveSearch,
                        DiscoveryProvider::ExaSearch,
                    ],
                }),
                Duration::seconds(30),
            )
            .await
            .expect("compatible claim leases run"),
        );
        let DiscoveryWorkerReceiptOutcome::Lease(lease) = compatible else {
            panic!("compatible worker must receive the queued run");
        };
        assert_eq!(lease.run.run_id, run_id);
        assert_eq!(lease.attempt, 1);
        assert_eq!(
            lease.source_config,
            DiscoverySourceConfig {
                mode: DiscoverySourceMode::Concurrent,
                sources: vec![DiscoverySource::BraveSearch, DiscoverySource::ExaSearch],
            }
        );
        assert_eq!(lease.source_states.len(), 2);
        assert_eq!(lease.source_states[0].source, DiscoverySource::BraveSearch);
        assert_eq!(lease.source_states[1].source, DiscoverySource::ExaSearch);
        assert!(lease
            .source_states
            .iter()
            .all(|source| source.status == DiscoveryRunSourceStatus::Pending));

        let read_request = DiscoveryWorkspaceRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            payload: DiscoveryWorkspaceActionPayload::GetCampaign { campaign_id },
        };
        let read_event = build_discovery_workspace_action(relay.public_key(), &read_request)
            .expect("build Campaign read")
            .sign_with_keys(&actor)
            .expect("sign Campaign read");
        let read =
            apply_workspace_request(&db, community, &actor, &relay, &read_request, &read_event)
                .await
                .expect("read Campaign source projection");
        let crate::discovery_workspace::DiscoveryWorkspaceCommandApply::Applied { result, .. } =
            read
        else {
            panic!("Campaign read must apply");
        };
        let DiscoveryWorkspaceResult::Campaign { campaign } = *result else {
            panic!("Campaign read must return Campaign");
        };
        assert_eq!(campaign.latest_run_sources, lease.source_states);

        purge_test_community(&db, community).await;
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn local_worker_claims_only_its_human_or_owned_agent_runs() {
        let _test_guard = DISCOVERY_DB_TEST_LOCK.lock().await;
        let (db, community, _, _) = database_fixture().await;
        db.set_discovery_entitlement(community, true)
            .await
            .expect("entitle workspace");
        let requester = Keys::generate();
        let other_member = Keys::generate();
        let owned_agent = Keys::generate();
        let relay = Keys::generate();
        let requester_pubkey = requester.public_key().to_bytes();
        let other_pubkey = other_member.public_key().to_bytes();
        let agent_pubkey = owned_agent.public_key().to_bytes();

        for keys in [&requester, &other_member, &owned_agent] {
            sqlx::query(
                "INSERT INTO relay_members (community_id,pubkey,role) VALUES ($1,$2,'member')",
            )
            .bind(community.as_uuid())
            .bind(keys.public_key().to_hex())
            .execute(&db.pool)
            .await
            .expect("insert worker-bound member");
        }
        for pubkey in [requester_pubkey, other_pubkey] {
            sqlx::query("INSERT INTO users (community_id,pubkey) VALUES ($1,$2)")
                .bind(community.as_uuid())
                .bind(pubkey.as_slice())
                .execute(&db.pool)
                .await
                .expect("insert human worker identity");
        }
        sqlx::query("INSERT INTO users (community_id,pubkey,agent_owner_pubkey) VALUES ($1,$2,$3)")
            .bind(community.as_uuid())
            .bind(agent_pubkey.as_slice())
            .bind(requester_pubkey.as_slice())
            .execute(&db.pool)
            .await
            .expect("insert owned agent identity");
        db.set_discovery_actor_grant(community, &agent_pubkey, &requester_pubkey, true)
            .await
            .expect("grant owned agent Discovery");

        let search = business_search();
        let human_campaign = Uuid::new_v4();
        insert_test_campaign(&db, community, &requester_pubkey, human_campaign, &search).await;
        let human_run = match db
            .create_discovery_run_once(
                community,
                &requester_pubkey,
                human_campaign,
                Uuid::new_v4(),
                1,
                &search,
            )
            .await
            .expect("create requester's run")
        {
            DiscoveryRunCreate::Created(run) | DiscoveryRunCreate::Existing(run) => run.id,
        };
        let provider_set = vec![DiscoveryProvider::Outscraper];
        let unrelated_claim = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &other_member,
                &relay,
                DiscoveryWorkerAction::Claim(DiscoveryWorkerClaimRequest {
                    request_id: Uuid::new_v4(),
                    idempotency_key: Uuid::new_v4(),
                    worker_id: Uuid::new_v4(),
                    protocol_version: buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION,
                    available_providers: provider_set.clone(),
                }),
                Duration::seconds(30),
            )
            .await
            .expect("unrelated worker is safely idle"),
        );
        assert_eq!(unrelated_claim, DiscoveryWorkerReceiptOutcome::Idle);

        let owner_worker_id = Uuid::new_v4();
        let owner_claim = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &requester,
                &relay,
                DiscoveryWorkerAction::Claim(DiscoveryWorkerClaimRequest {
                    request_id: Uuid::new_v4(),
                    idempotency_key: Uuid::new_v4(),
                    worker_id: owner_worker_id,
                    protocol_version: buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION,
                    available_providers: provider_set.clone(),
                }),
                Duration::seconds(30),
            )
            .await
            .expect("requester worker claims its run"),
        );
        let DiscoveryWorkerReceiptOutcome::Lease(owner_lease) = owner_claim else {
            panic!("requester worker must receive its own run");
        };
        assert_eq!(owner_lease.run.run_id, human_run);
        let active_source = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &requester,
                &relay,
                DiscoveryWorkerAction::SourceProgress(DiscoveryWorkerSourceProgressRequest {
                    lease: lease_request(owner_worker_id, human_run, owner_lease.lease_id),
                    provider: DiscoveryProvider::Outscraper,
                    status: DiscoveryRunSourceStatus::Active,
                    request_cursor: None,
                    request_count: 0,
                    returned_count: 0,
                    failure_class: None,
                }),
                Duration::seconds(30),
            )
            .await
            .expect("activate requester source"),
        );
        let DiscoveryWorkerReceiptOutcome::Lease(active_lease) = active_source else {
            panic!("source activation must preserve the lease");
        };
        let terminal_source = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &requester,
                &relay,
                DiscoveryWorkerAction::SourceProgress(DiscoveryWorkerSourceProgressRequest {
                    lease: lease_request(owner_worker_id, human_run, active_lease.lease_id),
                    provider: DiscoveryProvider::Outscraper,
                    status: DiscoveryRunSourceStatus::Failed,
                    request_cursor: None,
                    request_count: 0,
                    returned_count: 0,
                    failure_class: Some(DiscoveryRunSourceFailureClass::InvalidRequest),
                }),
                Duration::seconds(30),
            )
            .await
            .expect("terminalize requester source"),
        );
        let DiscoveryWorkerReceiptOutcome::Lease(terminal_lease) = terminal_source else {
            panic!("source failure must preserve the lease");
        };
        let failed = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &requester,
                &relay,
                DiscoveryWorkerAction::Fail(lease_request(
                    owner_worker_id,
                    human_run,
                    terminal_lease.lease_id,
                )),
                Duration::seconds(30),
            )
            .await
            .expect("finish requester run"),
        );
        assert!(matches!(failed, DiscoveryWorkerReceiptOutcome::Failed(_)));

        let agent_campaign = Uuid::new_v4();
        insert_test_campaign(&db, community, &agent_pubkey, agent_campaign, &search).await;
        let agent_run = match db
            .create_discovery_run_once(
                community,
                &agent_pubkey,
                agent_campaign,
                Uuid::new_v4(),
                1,
                &search,
            )
            .await
            .expect("create owned agent run")
        {
            DiscoveryRunCreate::Created(run) | DiscoveryRunCreate::Existing(run) => run.id,
        };
        let agent_worker_attempt = apply_worker_action(
            &db,
            community,
            &owned_agent,
            &relay,
            DiscoveryWorkerAction::Claim(DiscoveryWorkerClaimRequest {
                request_id: Uuid::new_v4(),
                idempotency_key: Uuid::new_v4(),
                worker_id: Uuid::new_v4(),
                protocol_version: buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION,
                available_providers: vec![DiscoveryProvider::Outscraper],
            }),
            Duration::seconds(30),
        )
        .await;
        assert!(matches!(
            agent_worker_attempt,
            Err(DbError::AccessDenied(message)) if message.contains("human member identity")
        ));
        let agent_owner_claim = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &requester,
                &relay,
                DiscoveryWorkerAction::Claim(DiscoveryWorkerClaimRequest {
                    request_id: Uuid::new_v4(),
                    idempotency_key: Uuid::new_v4(),
                    worker_id: Uuid::new_v4(),
                    protocol_version: buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION,
                    available_providers: provider_set,
                }),
                Duration::seconds(30),
            )
            .await
            .expect("owner worker claims its agent's run"),
        );
        let DiscoveryWorkerReceiptOutcome::Lease(agent_lease) = agent_owner_claim else {
            panic!("owner worker must receive its agent's run");
        };
        assert_eq!(agent_lease.run.run_id, agent_run);
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn campaign_allows_only_one_active_run_and_reopens_after_terminal_state() {
        let _test_guard = DISCOVERY_DB_TEST_LOCK.lock().await;
        let (db, community, human, _) = database_fixture().await;
        db.set_discovery_entitlement(community, true)
            .await
            .expect("entitle workspace");
        let search = business_search();
        let campaign_id = Uuid::new_v4();
        insert_test_campaign(&db, community, &human, campaign_id, &search).await;

        let first_key = Uuid::new_v4();
        let second_key = Uuid::new_v4();
        let (first, second) = tokio::join!(
            db.create_discovery_run_once(community, &human, campaign_id, first_key, 1, &search,),
            db.create_discovery_run_once(community, &human, campaign_id, second_key, 1, &search,),
        );
        let results = [first, second];
        let created = results
            .iter()
            .filter_map(|result| match result {
                Ok(DiscoveryRunCreate::Created(run)) => Some(run.id),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(created.len(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(
                    result,
                    Err(DbError::AccessDenied(message)) if message.contains("already has an active run")
                ))
                .count(),
            1
        );

        db.request_discovery_cancel(community, &human, created[0])
            .await
            .expect("terminalize first run");
        let next = db
            .create_discovery_run_once(community, &human, campaign_id, Uuid::new_v4(), 1, &search)
            .await
            .expect("campaign accepts a new run after terminal state");
        assert!(matches!(next, DiscoveryRunCreate::Created(_)));
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn terminal_paid_results_salvage_is_owner_scoped_and_batch_idempotent() {
        let _test_guard = DISCOVERY_DB_TEST_LOCK.lock().await;
        let (db, community, _, _) = database_fixture().await;
        db.set_discovery_entitlement(community, true)
            .await
            .expect("entitle workspace");
        let owner = Keys::generate();
        let foreign_member = Keys::generate();
        let relay = Keys::generate();
        for actor in [&owner, &foreign_member] {
            sqlx::query(
                "INSERT INTO relay_members (community_id,pubkey,role) VALUES ($1,$2,'member')",
            )
            .bind(community.as_uuid())
            .bind(actor.public_key().to_hex())
            .execute(&db.pool)
            .await
            .expect("insert salvage member");
            sqlx::query("INSERT INTO users (community_id,pubkey) VALUES ($1,$2)")
                .bind(community.as_uuid())
                .bind(actor.public_key().to_bytes().as_slice())
                .execute(&db.pool)
                .await
                .expect("insert salvage human identity");
        }
        let owner_pubkey = owner.public_key().to_bytes();
        let search = business_search();
        let campaign_id = Uuid::new_v4();
        insert_test_campaign(&db, community, &owner_pubkey, campaign_id, &search).await;
        sqlx::query(
            "UPDATE discovery_campaigns SET source_keys=ARRAY['brave_search']::TEXT[] \
             WHERE community_id=$1 AND id=$2",
        )
        .bind(community.as_uuid())
        .bind(campaign_id)
        .execute(&db.pool)
        .await
        .expect("configure salvage source");
        let run_id = match db
            .create_discovery_run_once(
                community,
                &owner_pubkey,
                campaign_id,
                Uuid::new_v4(),
                1,
                &search,
            )
            .await
            .expect("create salvage run")
        {
            DiscoveryRunCreate::Created(run) | DiscoveryRunCreate::Existing(run) => run.id,
        };
        let worker_id = Uuid::new_v4();
        let claimed = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &owner,
                &relay,
                DiscoveryWorkerAction::Claim(DiscoveryWorkerClaimRequest {
                    request_id: Uuid::new_v4(),
                    idempotency_key: Uuid::new_v4(),
                    worker_id,
                    protocol_version: buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION,
                    available_providers: vec![DiscoveryProvider::BraveSearch],
                }),
                Duration::seconds(30),
            )
            .await
            .expect("claim salvage run"),
        );
        let DiscoveryWorkerReceiptOutcome::Lease(lease) = claimed else {
            panic!("salvage run must be leased");
        };
        let active = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &owner,
                &relay,
                DiscoveryWorkerAction::SourceProgress(DiscoveryWorkerSourceProgressRequest {
                    lease: lease_request(worker_id, run_id, lease.lease_id),
                    provider: DiscoveryProvider::BraveSearch,
                    status: DiscoveryRunSourceStatus::Active,
                    request_cursor: Some("brave-paid-request".to_owned()),
                    request_count: 1,
                    returned_count: 0,
                    failure_class: None,
                }),
                Duration::seconds(30),
            )
            .await
            .expect("activate paid source"),
        );
        assert!(matches!(active, DiscoveryWorkerReceiptOutcome::Lease(_)));
        db.request_discovery_cancel(community, &owner_pubkey, run_id)
            .await
            .expect("cancel after paid provider response");

        let observation = business_observation_for(
            DiscoveryProvider::BraveSearch,
            "brave-result-1",
            "Recovered Brave Dental",
            "https://recovered-brave.example",
        );
        let salvage = DiscoveryWorkerSalvageBatchRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            worker_id,
            run_id,
            provider: DiscoveryProvider::BraveSearch,
            provider_request_id: "brave-paid-request".to_owned(),
            batch_index: 0,
            observations: vec![observation.clone()],
        };
        assert!(matches!(
            apply_worker_action(
                &db,
                community,
                &foreign_member,
                &relay,
                DiscoveryWorkerAction::SalvageObservations(salvage.clone()),
                Duration::seconds(30),
            )
            .await,
            Err(DbError::AccessDenied(message)) if message.contains("original run owner")
        ));

        let applied = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &owner,
                &relay,
                DiscoveryWorkerAction::SalvageObservations(salvage.clone()),
                Duration::seconds(30),
            )
            .await
            .expect("salvage paid result"),
        );
        let DiscoveryWorkerReceiptOutcome::ObservationsSalvaged(applied) = applied else {
            panic!("salvage must return stored counts");
        };
        assert_eq!((applied.accepted_count, applied.existing_count), (1, 0));

        let duplicate = apply_worker_action(
            &db,
            community,
            &owner,
            &relay,
            DiscoveryWorkerAction::SalvageObservations(salvage.clone()),
            Duration::seconds(30),
        )
        .await
        .expect("command retry is idempotent");
        assert!(matches!(
            duplicate,
            DiscoveryWorkerCommandApply::Duplicate { .. }
        ));

        let replay = DiscoveryWorkerSalvageBatchRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            ..salvage.clone()
        };
        let replayed = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &owner,
                &relay,
                DiscoveryWorkerAction::SalvageObservations(replay),
                Duration::seconds(30),
            )
            .await
            .expect("batch retry is idempotent"),
        );
        let DiscoveryWorkerReceiptOutcome::ObservationsSalvaged(replayed) = replayed else {
            panic!("batch replay must return original counts");
        };
        assert_eq!((replayed.accepted_count, replayed.existing_count), (1, 0));

        let mut conflicting_observation = observation;
        conflicting_observation.name = "Conflicting recovered business".to_owned();
        let conflicting = DiscoveryWorkerSalvageBatchRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            observations: vec![conflicting_observation],
            ..salvage
        };
        assert!(matches!(
            apply_worker_action(
                &db,
                community,
                &owner,
                &relay,
                DiscoveryWorkerAction::SalvageObservations(conflicting),
                Duration::seconds(30),
            )
            .await,
            Err(DbError::AccessDenied(message)) if message.contains("conflicts with committed results")
        ));
        let source_counts: (i32, i32) = sqlx::query_as(
            "SELECT retained_count,duplicate_count FROM discovery_run_sources \
             WHERE community_id=$1 AND run_id=$2 AND provider='brave_search'",
        )
        .bind(community.as_uuid())
        .bind(run_id)
        .fetch_one(&db.pool)
        .await
        .expect("load salvaged source counts");
        assert_eq!(source_counts, (1, 0));
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn worker_source_progress_is_monotonic_idempotent_and_lease_fenced() {
        let _test_guard = DISCOVERY_DB_TEST_LOCK.lock().await;
        let (db, community, _, _) = database_fixture().await;
        db.set_discovery_entitlement(community, true)
            .await
            .expect("entitle workspace");
        let actor = Keys::generate();
        let other_member = Keys::generate();
        let relay = Keys::generate();
        let actor_bytes = actor.public_key().to_bytes();
        for keys in [&actor, &other_member] {
            sqlx::query(
                "INSERT INTO relay_members (community_id,pubkey,role) VALUES ($1,$2,'member')",
            )
            .bind(community.as_uuid())
            .bind(keys.public_key().to_hex())
            .execute(&db.pool)
            .await
            .expect("insert worker member");
            sqlx::query("INSERT INTO users (community_id,pubkey) VALUES ($1,$2)")
                .bind(community.as_uuid())
                .bind(keys.public_key().to_bytes().as_slice())
                .execute(&db.pool)
                .await
                .expect("insert worker identity");
        }

        let search = business_search();
        let campaign_id = Uuid::new_v4();
        insert_test_campaign(&db, community, &actor_bytes, campaign_id, &search).await;
        let run_id = match db
            .create_discovery_run_once(
                community,
                &actor_bytes,
                campaign_id,
                Uuid::new_v4(),
                2,
                &search,
            )
            .await
            .expect("create run")
        {
            DiscoveryRunCreate::Created(run) | DiscoveryRunCreate::Existing(run) => run.id,
        };
        let worker_id = Uuid::new_v4();
        let claimed = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::Claim(DiscoveryWorkerClaimRequest {
                    request_id: Uuid::new_v4(),
                    idempotency_key: Uuid::new_v4(),
                    worker_id,
                    protocol_version: buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION,
                    available_providers: vec![DiscoveryProvider::Outscraper],
                }),
                Duration::seconds(30),
            )
            .await
            .expect("claim run"),
        );
        let DiscoveryWorkerReceiptOutcome::Lease(mut lease) = claimed else {
            panic!("worker must receive lease");
        };

        let active = DiscoveryWorkerSourceProgressRequest {
            lease: lease_request(worker_id, run_id, lease.lease_id),
            provider: DiscoveryProvider::Outscraper,
            status: DiscoveryRunSourceStatus::Active,
            request_cursor: None,
            request_count: 0,
            returned_count: 0,
            failure_class: None,
        };
        let active_outcome = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::SourceProgress(active),
                Duration::seconds(30),
            )
            .await
            .expect("activate source"),
        );
        let DiscoveryWorkerReceiptOutcome::Lease(updated) = active_outcome else {
            panic!("source progress must renew lease");
        };
        lease = updated;
        assert_eq!(
            lease.source_states[0].status,
            DiscoveryRunSourceStatus::Active
        );
        assert!(lease.source_states[0].started_at.is_some());
        assert!(lease.source_states[0].finished_at.is_none());

        let cross_actor = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &other_member,
                &relay,
                DiscoveryWorkerAction::SourceProgress(DiscoveryWorkerSourceProgressRequest {
                    lease: lease_request(worker_id, run_id, lease.lease_id),
                    provider: DiscoveryProvider::Outscraper,
                    status: DiscoveryRunSourceStatus::Active,
                    request_cursor: None,
                    request_count: 0,
                    returned_count: 0,
                    failure_class: None,
                }),
                Duration::seconds(30),
            )
            .await
            .expect("cross-actor progress is safely fenced"),
        );
        assert!(matches!(
            cross_actor,
            DiscoveryWorkerReceiptOutcome::LostLease(_)
        ));
        let unchanged: (String, i32, i32) = sqlx::query_as(
            "SELECT status,request_count,returned_count FROM discovery_run_sources \
             WHERE community_id=$1 AND run_id=$2 AND provider='outscraper'",
        )
        .bind(community.as_uuid())
        .bind(run_id)
        .fetch_one(&db.pool)
        .await
        .expect("load source after cross-actor progress");
        assert_eq!(unchanged, ("active".to_owned(), 0, 0));

        for action in [
            DiscoveryWorkerAction::Complete(lease_request(worker_id, run_id, lease.lease_id)),
            DiscoveryWorkerAction::Fail(lease_request(worker_id, run_id, lease.lease_id)),
        ] {
            assert!(matches!(
                apply_worker_action(
                    &db,
                    community,
                    &actor,
                    &relay,
                    action,
                    Duration::seconds(30),
                )
                .await,
                Err(DbError::InvalidData(message))
                    if message.contains("all Discovery sources must be terminal")
            ));
        }

        let completed = DiscoveryWorkerSourceProgressRequest {
            lease: lease_request(worker_id, run_id, lease.lease_id),
            provider: DiscoveryProvider::Outscraper,
            status: DiscoveryRunSourceStatus::Completed,
            request_cursor: Some("provider-job-1".to_owned()),
            request_count: 2,
            returned_count: 3,
            failure_class: None,
        };
        let completed_outcome = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::SourceProgress(completed.clone()),
                Duration::seconds(30),
            )
            .await
            .expect("complete source"),
        );
        let DiscoveryWorkerReceiptOutcome::Lease(completed_lease) = completed_outcome else {
            panic!("terminal source progress must keep run lease");
        };
        let source = &completed_lease.source_states[0];
        assert_eq!(source.status, DiscoveryRunSourceStatus::Completed);
        assert_eq!(source.request_cursor.as_deref(), Some("provider-job-1"));
        assert_eq!(source.request_count, 2);
        assert_eq!(source.returned_count, 3);
        assert!(source.finished_at.is_some());

        let replay = apply_worker_action(
            &db,
            community,
            &actor,
            &relay,
            DiscoveryWorkerAction::SourceProgress(completed.clone()),
            Duration::seconds(30),
        )
        .await
        .expect("replay terminal progress");
        assert!(matches!(
            replay,
            DiscoveryWorkerCommandApply::Duplicate { .. }
        ));

        let mut conflicting = completed;
        conflicting.lease.request_id = Uuid::new_v4();
        conflicting.lease.idempotency_key = Uuid::new_v4();
        conflicting.returned_count = 2;
        assert!(apply_worker_action(
            &db,
            community,
            &actor,
            &relay,
            DiscoveryWorkerAction::SourceProgress(conflicting),
            Duration::seconds(30),
        )
        .await
        .is_err());

        let completed_run = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::Complete(lease_request(
                    worker_id,
                    run_id,
                    completed_lease.lease_id,
                )),
                Duration::seconds(30),
            )
            .await
            .expect("complete after every source is terminal"),
        );
        assert!(matches!(
            completed_run,
            DiscoveryWorkerReceiptOutcome::Completed(_)
        ));
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn local_worker_recovers_checkpoints_and_rejects_stale_fences() {
        let _test_guard = DISCOVERY_DB_TEST_LOCK.lock().await;
        let (db, community, _, _) = database_fixture().await;
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

        let expected_search = business_search();
        let campaign_id = Uuid::new_v4();
        insert_test_campaign(&db, community, &actor_bytes, campaign_id, &expected_search).await;
        let created = db
            .create_discovery_run_once(
                community,
                &actor_bytes,
                campaign_id,
                Uuid::new_v4(),
                1,
                &expected_search,
            )
            .await
            .expect("create external-worker run");
        let run_id = match created {
            DiscoveryRunCreate::Created(run) | DiscoveryRunCreate::Existing(run) => run.id,
        };
        sqlx::query(
            "UPDATE discovery_runs SET discovery_protocol_version=1 \
             WHERE community_id=$1 AND id=$2",
        )
        .bind(community.as_uuid())
        .bind(run_id)
        .execute(&db.pool)
        .await
        .expect("mark released-worker run as protocol V1");
        let first_worker = Uuid::new_v4();
        let first_claim = DiscoveryWorkerAction::Claim(DiscoveryWorkerClaimRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            worker_id: first_worker,
            protocol_version: buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION,
            available_providers: vec![DiscoveryProvider::Outscraper],
        });
        let first = applied_worker_outcome(
            apply_v1_worker_action(
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
        assert_eq!(first_lease.business_search, expected_search);
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
            apply_v1_worker_action(
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
            apply_v1_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::Claim(DiscoveryWorkerClaimRequest {
                    request_id: Uuid::new_v4(),
                    idempotency_key: Uuid::new_v4(),
                    worker_id: second_worker,
                    protocol_version: buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION,
                    available_providers: vec![DiscoveryProvider::Outscraper],
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
            apply_v1_worker_action(
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
            apply_v1_worker_action(
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
            apply_v1_worker_action(
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
        let completed_source: (String, i32) = sqlx::query_as(
            "SELECT status,returned_count FROM discovery_run_sources \
             WHERE community_id=$1 AND run_id=$2 AND provider='outscraper'",
        )
        .bind(community.as_uuid())
        .bind(run_id)
        .fetch_one(&db.pool)
        .await
        .expect("load source finalized by v1 completion");
        assert_eq!(completed_source, ("completed".to_owned(), 37));

        let failed_campaign_id = Uuid::new_v4();
        let failed_search = business_search();
        insert_test_campaign(
            &db,
            community,
            &actor_bytes,
            failed_campaign_id,
            &failed_search,
        )
        .await;
        let failed_run_id = match db
            .create_discovery_run_once(
                community,
                &actor_bytes,
                failed_campaign_id,
                Uuid::new_v4(),
                1,
                &failed_search,
            )
            .await
            .expect("create failure fixture run")
        {
            DiscoveryRunCreate::Created(run) | DiscoveryRunCreate::Existing(run) => run.id,
        };
        sqlx::query(
            "UPDATE discovery_runs SET discovery_protocol_version=1 \
             WHERE community_id=$1 AND id=$2",
        )
        .bind(community.as_uuid())
        .bind(failed_run_id)
        .execute(&db.pool)
        .await
        .expect("mark released-worker failure run as protocol V1");
        let failure_worker = Uuid::new_v4();
        let failure_claim = applied_worker_outcome(
            apply_v1_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::Claim(DiscoveryWorkerClaimRequest {
                    request_id: Uuid::new_v4(),
                    idempotency_key: Uuid::new_v4(),
                    worker_id: failure_worker,
                    protocol_version: buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION,
                    available_providers: vec![DiscoveryProvider::Outscraper],
                }),
                Duration::seconds(5),
            )
            .await
            .expect("claim failure fixture run"),
        );
        let DiscoveryWorkerReceiptOutcome::Lease(failure_lease) = failure_claim else {
            panic!("failure fixture must be leased");
        };
        assert_eq!(failure_lease.run.run_id, failed_run_id);
        let failed = applied_worker_outcome(
            apply_v1_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::Fail(lease_request(
                    failure_worker,
                    failed_run_id,
                    failure_lease.lease_id,
                )),
                Duration::seconds(5),
            )
            .await
            .expect("fail current lease"),
        );
        let DiscoveryWorkerReceiptOutcome::Failed(failed) = failed else {
            panic!("current failure must succeed");
        };
        assert_eq!(failed.state, DiscoveryRunState::Failed);
        assert_eq!(
            failed.terminal_reason,
            Some(DiscoveryTerminalReason::ExecutorFailed)
        );
        let failed_source: String = sqlx::query_scalar(
            "SELECT status FROM discovery_run_sources \
             WHERE community_id=$1 AND run_id=$2 AND provider='outscraper'",
        )
        .bind(community.as_uuid())
        .bind(failed_run_id)
        .fetch_one(&db.pool)
        .await
        .expect("load source finalized by v1 failure");
        assert_eq!(failed_source, "failed");

        purge_test_community(&db, community).await;
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn observation_batches_replay_and_deduplicate_across_campaigns() {
        let _test_guard = DISCOVERY_DB_TEST_LOCK.lock().await;
        let (db, community, _, _) = database_fixture().await;
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
            .bind(actor.public_key().to_bytes().as_slice())
            .execute(&db.pool)
            .await
            .expect("insert worker identity");
        let other_community_uuid = Uuid::new_v4();
        let other_community = CommunityId::from_uuid(other_community_uuid);
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(other_community_uuid)
            .bind(format!("discovery-{}.test", Uuid::new_v4()))
            .execute(&db.pool)
            .await
            .expect("insert second community");
        sqlx::query(
            "INSERT INTO relay_members (community_id, pubkey, role) VALUES ($1, $2, 'member')",
        )
        .bind(other_community_uuid)
        .bind(actor.public_key().to_hex())
        .execute(&db.pool)
        .await
        .expect("insert second-community worker membership");
        sqlx::query("INSERT INTO users (community_id, pubkey) VALUES ($1, $2)")
            .bind(other_community_uuid)
            .bind(actor.public_key().to_bytes().as_slice())
            .execute(&db.pool)
            .await
            .expect("insert second-community worker identity");
        db.set_discovery_entitlement(other_community, true)
            .await
            .expect("entitle second community");

        let first_campaign_id = Uuid::new_v4();
        let first_search = business_search();
        insert_test_campaign(
            &db,
            community,
            &actor_bytes,
            first_campaign_id,
            &first_search,
        )
        .await;
        let first_run = match db
            .create_discovery_run_once(
                community,
                &actor_bytes,
                first_campaign_id,
                Uuid::new_v4(),
                1,
                &first_search,
            )
            .await
            .expect("create first run")
        {
            DiscoveryRunCreate::Created(run) | DiscoveryRunCreate::Existing(run) => run.id,
        };
        let worker_id = Uuid::new_v4();
        let first_lease = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::Claim(DiscoveryWorkerClaimRequest {
                    request_id: Uuid::new_v4(),
                    idempotency_key: Uuid::new_v4(),
                    worker_id,
                    protocol_version: buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION,
                    available_providers: vec![DiscoveryProvider::Outscraper],
                }),
                Duration::seconds(30),
            )
            .await
            .expect("claim first run"),
        );
        let DiscoveryWorkerReceiptOutcome::Lease(first_lease) = first_lease else {
            panic!("first run must lease");
        };
        let provider_request_id = "provider-job-observations".to_owned();
        applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::Checkpoint(DiscoveryWorkerCheckpointRequest {
                    lease: lease_request(worker_id, first_run, first_lease.lease_id),
                    checkpoint: DiscoveryWorkerCheckpoint {
                        sequence: 1,
                        kind: DiscoveryCheckpointKind::ProviderSubmitted,
                        provider: DiscoveryProvider::Outscraper,
                        provider_request_id: Some(provider_request_id.clone()),
                        item_count: None,
                    },
                }),
                Duration::seconds(30),
            )
            .await
            .expect("checkpoint first provider request"),
        );

        let first_batch = DiscoveryWorkerObservationBatchRequest {
            lease: lease_request(worker_id, first_run, first_lease.lease_id),
            provider: DiscoveryProvider::Outscraper,
            provider_request_id: provider_request_id.clone(),
            batch_index: 0,
            observations: vec![business_observation("Sandton Dental Studio")],
        };
        let stored = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::StoreObservations(first_batch.clone()),
                Duration::seconds(30),
            )
            .await
            .expect("store first observation batch"),
        );
        let DiscoveryWorkerReceiptOutcome::ObservationsStored(stored) = stored else {
            panic!("observation batch must return counts");
        };
        assert_eq!((stored.accepted_count, stored.existing_count), (1, 0));

        let mut cross_community = first_batch.clone();
        cross_community.lease.request_id = Uuid::new_v4();
        cross_community.lease.idempotency_key = Uuid::new_v4();
        assert!(matches!(
            apply_worker_action(
                &db,
                other_community,
                &actor,
                &relay,
                DiscoveryWorkerAction::StoreObservations(cross_community),
                Duration::seconds(30),
            )
            .await,
            Err(DbError::NotFound(_))
        ));

        let other_search = business_search();
        let other_campaign = Uuid::new_v4();
        insert_test_campaign(
            &db,
            other_community,
            &actor_bytes,
            other_campaign,
            &other_search,
        )
        .await;
        let other_run = match db
            .create_discovery_run_once(
                other_community,
                &actor_bytes,
                other_campaign,
                Uuid::new_v4(),
                1,
                &other_search,
            )
            .await
            .expect("create same business in another workspace")
        {
            DiscoveryRunCreate::Created(run) | DiscoveryRunCreate::Existing(run) => run.id,
        };
        let other_worker = Uuid::new_v4();
        let other_claim = applied_worker_outcome(
            apply_worker_action(
                &db,
                other_community,
                &actor,
                &relay,
                DiscoveryWorkerAction::Claim(DiscoveryWorkerClaimRequest {
                    request_id: Uuid::new_v4(),
                    idempotency_key: Uuid::new_v4(),
                    worker_id: other_worker,
                    protocol_version: buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION,
                    available_providers: vec![DiscoveryProvider::Outscraper],
                }),
                Duration::seconds(30),
            )
            .await
            .expect("claim other-workspace run"),
        );
        let DiscoveryWorkerReceiptOutcome::Lease(other_lease) = other_claim else {
            panic!("other-workspace run must lease");
        };
        let other_request_id = "provider-job-other-workspace".to_owned();
        applied_worker_outcome(
            apply_worker_action(
                &db,
                other_community,
                &actor,
                &relay,
                DiscoveryWorkerAction::Checkpoint(DiscoveryWorkerCheckpointRequest {
                    lease: lease_request(other_worker, other_run, other_lease.lease_id),
                    checkpoint: DiscoveryWorkerCheckpoint {
                        sequence: 1,
                        kind: DiscoveryCheckpointKind::ProviderSubmitted,
                        provider: DiscoveryProvider::Outscraper,
                        provider_request_id: Some(other_request_id.clone()),
                        item_count: None,
                    },
                }),
                Duration::seconds(30),
            )
            .await
            .expect("checkpoint other-workspace request"),
        );
        let other_stored = applied_worker_outcome(
            apply_worker_action(
                &db,
                other_community,
                &actor,
                &relay,
                DiscoveryWorkerAction::StoreObservations(DiscoveryWorkerObservationBatchRequest {
                    lease: lease_request(other_worker, other_run, other_lease.lease_id),
                    provider: DiscoveryProvider::Outscraper,
                    provider_request_id: other_request_id,
                    batch_index: 0,
                    observations: vec![business_observation("Sandton Dental Studio")],
                }),
                Duration::seconds(30),
            )
            .await
            .expect("store same business in another workspace"),
        );
        let DiscoveryWorkerReceiptOutcome::ObservationsStored(other_stored) = other_stored else {
            panic!("other-workspace observation must store");
        };
        assert_eq!(
            (other_stored.accepted_count, other_stored.existing_count),
            (1, 0)
        );

        let replay = DiscoveryWorkerObservationBatchRequest {
            lease: DiscoveryWorkerLeaseRequest {
                request_id: Uuid::new_v4(),
                idempotency_key: Uuid::new_v4(),
                ..first_batch.lease.clone()
            },
            ..first_batch.clone()
        };
        let replayed = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::StoreObservations(replay),
                Duration::seconds(30),
            )
            .await
            .expect("replay committed batch with a new command key"),
        );
        let DiscoveryWorkerReceiptOutcome::ObservationsStored(replayed) = replayed else {
            panic!("batch replay must return original counts");
        };
        assert_eq!((replayed.accepted_count, replayed.existing_count), (1, 0));

        let mut conflicting = first_batch.clone();
        conflicting.lease.request_id = Uuid::new_v4();
        conflicting.lease.idempotency_key = Uuid::new_v4();
        conflicting.observations = vec![business_observation("Conflicting Dental Name")];
        assert!(matches!(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::StoreObservations(conflicting),
                Duration::seconds(30),
            )
            .await,
            Err(DbError::AccessDenied(_))
        ));

        applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::SourceProgress(DiscoveryWorkerSourceProgressRequest {
                    lease: lease_request(worker_id, first_run, first_lease.lease_id),
                    provider: DiscoveryProvider::Outscraper,
                    status: DiscoveryRunSourceStatus::Completed,
                    request_cursor: Some(provider_request_id),
                    request_count: 1,
                    returned_count: 1,
                    failure_class: None,
                }),
                Duration::seconds(30),
            )
            .await
            .expect("terminalize first observation source"),
        );

        applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::Complete(lease_request(
                    worker_id,
                    first_run,
                    first_lease.lease_id,
                )),
                Duration::seconds(30),
            )
            .await
            .expect("complete first run"),
        );

        let second_campaign_id = Uuid::new_v4();
        let second_search = business_search();
        insert_test_campaign(
            &db,
            community,
            &actor_bytes,
            second_campaign_id,
            &second_search,
        )
        .await;
        sqlx::query(
            "UPDATE discovery_campaigns SET source_keys=ARRAY['brave_search']::TEXT[] \
             WHERE community_id=$1 AND id=$2",
        )
        .bind(community.as_uuid())
        .bind(second_campaign_id)
        .execute(&db.pool)
        .await
        .expect("configure second Campaign for Brave");
        let second_run = match db
            .create_discovery_run_once(
                community,
                &actor_bytes,
                second_campaign_id,
                Uuid::new_v4(),
                1,
                &second_search,
            )
            .await
            .expect("create second campaign run")
        {
            DiscoveryRunCreate::Created(run) | DiscoveryRunCreate::Existing(run) => run.id,
        };
        let second_lease = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::Claim(DiscoveryWorkerClaimRequest {
                    request_id: Uuid::new_v4(),
                    idempotency_key: Uuid::new_v4(),
                    worker_id,
                    protocol_version: buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION,
                    available_providers: vec![DiscoveryProvider::BraveSearch],
                }),
                Duration::seconds(30),
            )
            .await
            .expect("claim second run"),
        );
        let DiscoveryWorkerReceiptOutcome::Lease(second_lease) = second_lease else {
            panic!("second run must lease");
        };
        let second_provider_request = "provider-job-second".to_owned();
        applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::Checkpoint(DiscoveryWorkerCheckpointRequest {
                    lease: lease_request(worker_id, second_run, second_lease.lease_id),
                    checkpoint: DiscoveryWorkerCheckpoint {
                        sequence: 1,
                        kind: DiscoveryCheckpointKind::ProviderSubmitted,
                        provider: DiscoveryProvider::BraveSearch,
                        provider_request_id: Some(second_provider_request.clone()),
                        item_count: None,
                    },
                }),
                Duration::seconds(30),
            )
            .await
            .expect("checkpoint second provider request"),
        );
        let deduplicated = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::StoreObservations(DiscoveryWorkerObservationBatchRequest {
                    lease: lease_request(worker_id, second_run, second_lease.lease_id),
                    provider: DiscoveryProvider::BraveSearch,
                    provider_request_id: second_provider_request,
                    batch_index: 0,
                    observations: vec![{
                        let mut observation = business_observation_for(
                            DiscoveryProvider::BraveSearch,
                            "brave-result-42",
                            "Fresh Provider Name Ignored",
                            "https://WWW.EXAMPLE.TEST/company/about",
                        );
                        observation.phone = None;
                        observation.city = None;
                        observation.state = None;
                        observation.country = None;
                        observation
                    }],
                }),
                Duration::seconds(30),
            )
            .await
            .expect("deduplicate across campaign runs"),
        );
        let DiscoveryWorkerReceiptOutcome::ObservationsStored(deduplicated) = deduplicated else {
            panic!("deduplicated batch must return counts");
        };
        assert_eq!(
            (deduplicated.accepted_count, deduplicated.existing_count),
            (0, 1)
        );
        let second_campaign_leads: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM discovery_campaign_leads \
             WHERE community_id=$1 AND campaign_id=$2",
        )
        .bind(community.as_uuid())
        .bind(second_campaign_id)
        .fetch_one(&db.pool)
        .await
        .expect("count deduplicated Campaign membership");
        assert_eq!(second_campaign_leads, 1);

        let third_campaign_id = Uuid::new_v4();
        let third_search = business_search();
        insert_test_campaign(
            &db,
            community,
            &actor_bytes,
            third_campaign_id,
            &third_search,
        )
        .await;
        sqlx::query(
            "UPDATE discovery_campaigns SET source_keys=ARRAY['exa_search']::TEXT[] \
             WHERE community_id=$1 AND id=$2",
        )
        .bind(community.as_uuid())
        .bind(third_campaign_id)
        .execute(&db.pool)
        .await
        .expect("configure third Campaign for Exa");
        let third_run = match db
            .create_discovery_run_once(
                community,
                &actor_bytes,
                third_campaign_id,
                Uuid::new_v4(),
                1,
                &third_search,
            )
            .await
            .expect("create third campaign run")
        {
            DiscoveryRunCreate::Created(run) | DiscoveryRunCreate::Existing(run) => run.id,
        };
        let third_worker = Uuid::new_v4();
        let third_claim = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::Claim(DiscoveryWorkerClaimRequest {
                    request_id: Uuid::new_v4(),
                    idempotency_key: Uuid::new_v4(),
                    worker_id: third_worker,
                    protocol_version: buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION,
                    available_providers: vec![DiscoveryProvider::ExaSearch],
                }),
                Duration::seconds(30),
            )
            .await
            .expect("claim Exa run"),
        );
        let DiscoveryWorkerReceiptOutcome::Lease(third_lease) = third_claim else {
            panic!("Exa run must lease");
        };
        let third_provider_request = "provider-job-third".to_owned();
        applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::Checkpoint(DiscoveryWorkerCheckpointRequest {
                    lease: lease_request(third_worker, third_run, third_lease.lease_id),
                    checkpoint: DiscoveryWorkerCheckpoint {
                        sequence: 1,
                        kind: DiscoveryCheckpointKind::ProviderSubmitted,
                        provider: DiscoveryProvider::ExaSearch,
                        provider_request_id: Some(third_provider_request.clone()),
                        item_count: None,
                    },
                }),
                Duration::seconds(30),
            )
            .await
            .expect("checkpoint Exa request"),
        );
        let exa_duplicate = applied_worker_outcome(
            apply_worker_action(
                &db,
                community,
                &actor,
                &relay,
                DiscoveryWorkerAction::StoreObservations(DiscoveryWorkerObservationBatchRequest {
                    lease: lease_request(third_worker, third_run, third_lease.lease_id),
                    provider: DiscoveryProvider::ExaSearch,
                    provider_request_id: third_provider_request,
                    batch_index: 0,
                    observations: vec![{
                        let mut observation = business_observation_for(
                            DiscoveryProvider::ExaSearch,
                            "exa-result-99",
                            "Another Provider Name Ignored",
                            "https://example.test/research",
                        );
                        observation.phone = None;
                        observation.city = None;
                        observation.state = None;
                        observation.country = None;
                        observation.description = Some("Public Exa snippet".to_owned());
                        observation
                    }],
                }),
                Duration::seconds(30),
            )
            .await
            .expect("deduplicate Exa business"),
        );
        let DiscoveryWorkerReceiptOutcome::ObservationsStored(exa_duplicate) = exa_duplicate else {
            panic!("Exa duplicate batch must return counts");
        };
        assert_eq!(
            (exa_duplicate.accepted_count, exa_duplicate.existing_count),
            (0, 1)
        );

        let observation_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM discovery_business_observations WHERE community_id=$1",
        )
        .bind(community.as_uuid())
        .fetch_one(&db.pool)
        .await
        .expect("count retained businesses");
        assert_eq!(observation_count, 1);
        let retained_name: String = sqlx::query_scalar(
            "SELECT name FROM discovery_business_observations WHERE community_id=$1",
        )
        .bind(community.as_uuid())
        .fetch_one(&db.pool)
        .await
        .expect("load retained business name");
        assert_eq!(retained_name, "Sandton Dental Studio");
        let retained_provider: String = sqlx::query_scalar(
            "SELECT provider FROM discovery_business_observations WHERE community_id=$1",
        )
        .bind(community.as_uuid())
        .fetch_one(&db.pool)
        .await
        .expect("load first-source provenance");
        assert_eq!(retained_provider, "outscraper");
        let list_request = DiscoveryWorkspaceRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            payload: DiscoveryWorkspaceActionPayload::ListLeads {
                request: DiscoveryLeadListRequest {
                    campaign_id: None,
                    industry_id: None,
                    vertical_id: None,
                    status: None,
                    offset: 0,
                    limit: 100,
                },
            },
        };
        let list_event = build_discovery_workspace_action(relay.public_key(), &list_request)
            .expect("build Lead list")
            .sign_with_keys(&actor)
            .expect("sign Lead list");
        let listed =
            apply_workspace_request(&db, community, &actor, &relay, &list_request, &list_event)
                .await
                .expect("list retained Leads");
        let crate::discovery_workspace::DiscoveryWorkspaceCommandApply::Applied { result, .. } =
            listed
        else {
            panic!("Lead list must apply");
        };
        let DiscoveryWorkspaceResult::Leads { page } = *result else {
            panic!("Lead list must return Leads");
        };
        assert_eq!(page.leads.len(), 1);
        assert_eq!(page.leads[0].provider, DiscoveryProvider::Outscraper);
        let usage: Vec<(Uuid, i32, i32)> = sqlx::query_as(
            "SELECT run_id, stored_count, existing_count FROM discovery_source_usage \
             WHERE community_id=$1 ORDER BY run_id",
        )
        .bind(community.as_uuid())
        .fetch_all(&db.pool)
        .await
        .expect("load source accounting");
        assert_eq!(usage.len(), 3);
        assert!(usage.contains(&(first_run, 1, 0)));
        assert!(usage.contains(&(second_run, 0, 1)));
        assert!(usage.contains(&(third_run, 0, 1)));
        let legacy_usage: Vec<(Uuid, i32, i32)> = sqlx::query_as(
            "SELECT run_id, stored_count, existing_count FROM discovery_usage \
             WHERE community_id=$1 ORDER BY run_id",
        )
        .bind(community.as_uuid())
        .fetch_all(&db.pool)
        .await
        .expect("load rollback-compatible Outscraper accounting");
        assert_eq!(legacy_usage, vec![(first_run, 1, 0)]);
        let source_counts: Vec<(Uuid, String, i32, i32)> = sqlx::query_as(
            "SELECT run_id,provider,retained_count,duplicate_count \
             FROM discovery_run_sources WHERE community_id=$1 ORDER BY run_id",
        )
        .bind(community.as_uuid())
        .fetch_all(&db.pool)
        .await
        .expect("load durable per-source counts");
        assert!(source_counts.contains(&(first_run, "outscraper".to_owned(), 1, 0)));
        assert!(source_counts.contains(&(second_run, "brave_search".to_owned(), 0, 1)));
        assert!(source_counts.contains(&(third_run, "exa_search".to_owned(), 0, 1)));
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn list_leads_status_matches_get_lead_and_filters_by_candidate() {
        let _test_guard = DISCOVERY_DB_TEST_LOCK.lock().await;
        let (db, community, human, _) = database_fixture().await;
        db.set_discovery_entitlement(community, true)
            .await
            .expect("entitle workspace");
        let search = business_search();
        let campaign_id = Uuid::new_v4();
        insert_test_campaign(&db, community, &human, campaign_id, &search).await;
        let run_id = match db
            .create_discovery_run_once(community, &human, campaign_id, Uuid::new_v4(), 1, &search)
            .await
            .expect("create run")
        {
            DiscoveryRunCreate::Created(run) | DiscoveryRunCreate::Existing(run) => run.id,
        };
        let mut lead_ids = Vec::new();
        for index in 0..3 {
            let lead_id = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO discovery_business_observations \
                 (community_id,id,first_run_id,provider,provider_record_id,name,\
                  observation_fingerprint) \
                 VALUES ($1,$2,$3,'outscraper',$4,$5,decode(repeat('ef',32),'hex'))",
            )
            .bind(community.as_uuid())
            .bind(lead_id)
            .bind(run_id)
            .bind(format!("maps:status-default-{index}"))
            .bind(format!("Sandton Status {index}"))
            .execute(&db.pool)
            .await
            .expect("insert retained observation");
            sqlx::query(
                "INSERT INTO discovery_campaign_leads \
                 (community_id,campaign_id,lead_id,discovered_run_id) VALUES ($1,$2,$3,$4)",
            )
            .bind(community.as_uuid())
            .bind(campaign_id)
            .bind(lead_id)
            .bind(run_id)
            .execute(&db.pool)
            .await
            .expect("associate retained observation with Campaign");
            lead_ids.push(lead_id);
        }

        let actor = Keys::generate();
        sqlx::query("INSERT INTO relay_members (community_id,pubkey,role) VALUES ($1,$2,'member')")
            .bind(community.as_uuid())
            .bind(actor.public_key().to_hex())
            .execute(&db.pool)
            .await
            .expect("insert workspace member");
        sqlx::query("INSERT INTO users (community_id,pubkey) VALUES ($1,$2)")
            .bind(community.as_uuid())
            .bind(actor.public_key().to_bytes().as_slice())
            .execute(&db.pool)
            .await
            .expect("insert workspace identity");
        let relay = Keys::generate();

        let db_ref = &db;
        let actor_ref = &actor;
        let relay_ref = &relay;
        let list_page = |status: Option<DiscoveryLeadStatus>| async move {
            let result = apply_workspace_result(
                db_ref,
                community,
                actor_ref,
                relay_ref,
                &DiscoveryWorkspaceRequest {
                    request_id: Uuid::new_v4(),
                    idempotency_key: Uuid::new_v4(),
                    payload: DiscoveryWorkspaceActionPayload::ListLeads {
                        request: DiscoveryLeadListRequest {
                            campaign_id: Some(campaign_id),
                            industry_id: None,
                            vertical_id: None,
                            status,
                            offset: 0,
                            limit: 25,
                        },
                    },
                },
            )
            .await;
            match result {
                DiscoveryWorkspaceResult::Leads { page } => page,
                other => panic!("list leads must return the page projection, got {other:?}"),
            }
        };
        let get_detail = |lead_id: Uuid| async move {
            let result = apply_workspace_result(
                db_ref,
                community,
                actor_ref,
                relay_ref,
                &DiscoveryWorkspaceRequest {
                    request_id: Uuid::new_v4(),
                    idempotency_key: Uuid::new_v4(),
                    payload: DiscoveryWorkspaceActionPayload::GetLead { lead_id },
                },
            )
            .await;
            match result {
                DiscoveryWorkspaceResult::Lead { lead } => *lead,
                other => panic!("get lead must return the detail projection, got {other:?}"),
            }
        };
        let update_status = |lead_id: Uuid, status: DiscoveryLeadStatus| async move {
            let result = apply_workspace_result(
                db_ref,
                community,
                actor_ref,
                relay_ref,
                &DiscoveryWorkspaceRequest {
                    request_id: Uuid::new_v4(),
                    idempotency_key: Uuid::new_v4(),
                    payload: DiscoveryWorkspaceActionPayload::UpdateLead {
                        lead_id,
                        input: DiscoveryLeadUpdateInput {
                            website: None,
                            email: None,
                            phone: None,
                            linkedin_url: None,
                            contact_name: None,
                            contact_title: None,
                            notes: None,
                            score: None,
                            owner_persona_id: None,
                            status: Some(status),
                        },
                    },
                },
            )
            .await;
            match result {
                DiscoveryWorkspaceResult::Lead { lead } => *lead,
                other => panic!("update lead must return the detail projection, got {other:?}"),
            }
        };

        let page = list_page(Some(DiscoveryLeadStatus::Candidate)).await;
        assert_eq!(
            page.total, 3,
            "unedited leads must match the candidate filter"
        );
        assert_eq!(
            page.leads.len(),
            3,
            "candidate filter must return the matching rows"
        );
        assert!(page.leads.iter().all(|lead| {
            lead.status == DiscoveryLeadStatus::Candidate && lead_ids.contains(&lead.lead_id)
        }));

        let page = list_page(None).await;
        assert_eq!(page.total, 3, "unfiltered list returns every lead");
        assert!(page
            .leads
            .iter()
            .all(|lead| { lead.status == DiscoveryLeadStatus::Candidate }));

        let detail = get_detail(lead_ids[0]).await;
        assert_eq!(
            detail.lead.status,
            DiscoveryLeadStatus::Candidate,
            "get_lead must agree with the list row before any edit"
        );

        let updated = update_status(lead_ids[0], DiscoveryLeadStatus::Accepted).await;
        assert_eq!(updated.lead.status, DiscoveryLeadStatus::Accepted);

        let page = list_page(Some(DiscoveryLeadStatus::Accepted)).await;
        assert_eq!(page.total, 1, "edited lead must match the accepted filter");
        assert_eq!(page.leads[0].lead_id, lead_ids[0]);
        assert_eq!(page.leads[0].status, DiscoveryLeadStatus::Accepted);
        let detail = get_detail(lead_ids[0]).await;
        assert_eq!(
            detail.lead.status, page.leads[0].status,
            "get_lead must agree with the list row after the edit"
        );

        let page = list_page(Some(DiscoveryLeadStatus::Candidate)).await;
        assert_eq!(page.total, 2, "remaining unedited leads stay candidates");

        for (status, expected) in [
            (DiscoveryLeadStatus::Candidate, 2),
            (DiscoveryLeadStatus::Accepted, 1),
            (DiscoveryLeadStatus::Qualified, 0),
            (DiscoveryLeadStatus::Dormant, 0),
            (DiscoveryLeadStatus::Disqualified, 0),
            (DiscoveryLeadStatus::ClientActive, 0),
        ] {
            let page = list_page(Some(status)).await;
            assert_eq!(page.total, expected, "count for {status:?}");
            assert_eq!(
                page.leads.len() as u32,
                page.total,
                "filtered rows must equal the filtered count for {status:?}"
            );
        }
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn list_leads_candidate_filter_returns_unedited_leads() {
        let _test_guard = DISCOVERY_DB_TEST_LOCK.lock().await;
        let (db, community, human, _) = database_fixture().await;
        db.set_discovery_entitlement(community, true)
            .await
            .expect("entitle workspace");
        let search = business_search();
        let campaign_id = Uuid::new_v4();
        insert_test_campaign(&db, community, &human, campaign_id, &search).await;
        let run_id = match db
            .create_discovery_run_once(community, &human, campaign_id, Uuid::new_v4(), 1, &search)
            .await
            .expect("create run")
        {
            DiscoveryRunCreate::Created(run) | DiscoveryRunCreate::Existing(run) => run.id,
        };
        for index in 0..3 {
            let lead_id = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO discovery_business_observations \
                 (community_id,id,first_run_id,provider,provider_record_id,name,\
                  observation_fingerprint) \
                 VALUES ($1,$2,$3,'outscraper',$4,$5,decode(repeat('ef',32),'hex'))",
            )
            .bind(community.as_uuid())
            .bind(lead_id)
            .bind(run_id)
            .bind(format!("maps:status-default-{index}"))
            .bind(format!("Sandton Status {index}"))
            .execute(&db.pool)
            .await
            .expect("insert retained observation");
            sqlx::query(
                "INSERT INTO discovery_campaign_leads \
                 (community_id,campaign_id,lead_id,discovered_run_id) VALUES ($1,$2,$3,$4)",
            )
            .bind(community.as_uuid())
            .bind(campaign_id)
            .bind(lead_id)
            .bind(run_id)
            .execute(&db.pool)
            .await
            .expect("associate retained observation with Campaign");
        }

        let actor = Keys::generate();
        sqlx::query("INSERT INTO relay_members (community_id,pubkey,role) VALUES ($1,$2,'member')")
            .bind(community.as_uuid())
            .bind(actor.public_key().to_hex())
            .execute(&db.pool)
            .await
            .expect("insert workspace member");
        sqlx::query("INSERT INTO users (community_id,pubkey) VALUES ($1,$2)")
            .bind(community.as_uuid())
            .bind(actor.public_key().to_bytes().as_slice())
            .execute(&db.pool)
            .await
            .expect("insert workspace identity");
        let relay = Keys::generate();

        let result = apply_workspace_result(
            &db,
            community,
            &actor,
            &relay,
            &DiscoveryWorkspaceRequest {
                request_id: Uuid::new_v4(),
                idempotency_key: Uuid::new_v4(),
                payload: DiscoveryWorkspaceActionPayload::ListLeads {
                    request: DiscoveryLeadListRequest {
                        campaign_id: Some(campaign_id),
                        industry_id: None,
                        vertical_id: None,
                        status: Some(DiscoveryLeadStatus::Candidate),
                        offset: 0,
                        limit: 25,
                    },
                },
            },
        )
        .await;
        let DiscoveryWorkspaceResult::Leads { page } = result else {
            panic!("list leads must return the page projection");
        };
        assert_eq!(
            page.total, 3,
            "unedited leads must match the candidate filter"
        );
        assert_eq!(
            page.leads.len(),
            3,
            "candidate filter must return the matching rows"
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn database_enforces_trial_expiry_and_permanent_access() {
        let _test_guard = DISCOVERY_DB_TEST_LOCK.lock().await;
        let (db, community, human, _) = database_fixture().await;

        let (active, expires_at): (bool, Option<chrono::DateTime<chrono::Utc>>) = sqlx::query_as(
            "SELECT active, expires_at FROM discovery_entitlements WHERE community_id=$1",
        )
        .bind(community.as_uuid())
        .fetch_one(&db.pool)
        .await
        .expect("load automatically provisioned trial");
        assert!(active);
        let expires_at = expires_at.expect("trial must expire");
        let remaining = expires_at - chrono::Utc::now();
        assert!(remaining > Duration::days(29));
        assert!(remaining <= Duration::days(30));
        assert_eq!(
            db.discovery_authorization(community, &human)
                .await
                .expect("trial authorization"),
            DiscoveryAuthorization::AuthorizedHuman
        );

        sqlx::query(
            "UPDATE discovery_entitlements SET expires_at=now() - interval '1 second' \
             WHERE community_id=$1",
        )
        .bind(community.as_uuid())
        .execute(&db.pool)
        .await
        .expect("expire trial");
        assert_eq!(
            db.discovery_authorization(community, &human)
                .await
                .expect("expired authorization"),
            DiscoveryAuthorization::EntitlementInactive
        );

        db.set_discovery_entitlement(community, true)
            .await
            .expect("activate permanent access");
        let expires_at: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar(
            "SELECT expires_at FROM discovery_entitlements WHERE community_id=$1",
        )
        .bind(community.as_uuid())
        .fetch_one(&db.pool)
        .await
        .expect("load permanent entitlement");
        assert_eq!(expires_at, None);
        assert_eq!(
            db.discovery_authorization(community, &human)
                .await
                .expect("permanent authorization"),
            DiscoveryAuthorization::AuthorizedHuman
        );
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
            DiscoveryAuthorization::AuthorizedHuman
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
        let campaign_search = business_search();
        insert_test_campaign(&db, community, &human, campaign, &campaign_search).await;
        let first = db
            .create_discovery_run_once(community, &human, campaign, key, 3, &campaign_search)
            .await
            .expect("create run");
        let first_run_id = match first {
            DiscoveryRunCreate::Created(run) => run.id,
            DiscoveryRunCreate::Existing(_) => panic!("first run must be newly created"),
        };
        sqlx::query(
            "UPDATE discovery_runs SET discovery_protocol_version=1 \
             WHERE community_id=$1 AND id=$2",
        )
        .bind(community.as_uuid())
        .bind(first_run_id)
        .execute(&db.pool)
        .await
        .expect("mark in-process worker fixture as protocol V1");
        let duplicate = db
            .create_discovery_run_once(community, &agent, campaign, key, 3, &campaign_search)
            .await
            .expect("retry run");
        assert!(matches!(duplicate, DiscoveryRunCreate::Existing(_)));
        let mut conflicting_search = business_search();
        conflicting_search.query = "orthodontists".to_owned();
        assert!(matches!(
            db.create_discovery_run_once(community, &human, campaign, key, 3, &conflicting_search,)
                .await,
            Err(DbError::AccessDenied(_))
        ));

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
        let cancelled_sources: Vec<(String, String)> = sqlx::query_as(
            "SELECT status,failure_class FROM discovery_run_sources \
             WHERE community_id=$1 AND run_id=$2 ORDER BY position",
        )
        .bind(community.as_uuid())
        .bind(claimed.run.id)
        .fetch_all(&db.pool)
        .await
        .expect("read actor-cancelled source states");
        assert!(!cancelled_sources.is_empty());
        assert!(cancelled_sources
            .iter()
            .all(|(status, failure)| status == "cancelled" && failure == "cancelled"));

        let revoke_campaign_id = Uuid::new_v4();
        let revoke_search = business_search();
        insert_test_campaign(&db, community, &human, revoke_campaign_id, &revoke_search).await;
        let revoke = db
            .create_discovery_run_once(
                community,
                &human,
                revoke_campaign_id,
                Uuid::new_v4(),
                2,
                &revoke_search,
            )
            .await
            .expect("create revocation run");
        let revoke_id = match revoke {
            DiscoveryRunCreate::Created(run) | DiscoveryRunCreate::Existing(run) => run.id,
        };
        sqlx::query(
            "UPDATE discovery_runs SET discovery_protocol_version=1 \
             WHERE community_id=$1 AND id=$2",
        )
        .bind(community.as_uuid())
        .bind(revoke_id)
        .execute(&db.pool)
        .await
        .expect("mark revocation fixture as protocol V1");
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
        let revoked_sources: Vec<(String, String)> = sqlx::query_as(
            "SELECT status,failure_class FROM discovery_run_sources \
             WHERE community_id=$1 AND run_id=$2 ORDER BY position",
        )
        .bind(community.as_uuid())
        .bind(revoke_id)
        .fetch_all(&db.pool)
        .await
        .expect("read entitlement-revoked source states");
        assert!(!revoked_sources.is_empty());
        assert!(revoked_sources
            .iter()
            .all(|(status, failure)| status == "cancelled" && failure == "cancelled"));

        db.set_discovery_entitlement(community, true)
            .await
            .expect("restore entitlement");
        let lease_campaign_id = Uuid::new_v4();
        let lease_search = business_search();
        insert_test_campaign(&db, community, &human, lease_campaign_id, &lease_search).await;
        let lease = db
            .create_discovery_run_once(
                community,
                &human,
                lease_campaign_id,
                Uuid::new_v4(),
                2,
                &lease_search,
            )
            .await
            .expect("create lease run");
        let lease_id = match lease {
            DiscoveryRunCreate::Created(run) | DiscoveryRunCreate::Existing(run) => run.id,
        };
        sqlx::query(
            "UPDATE discovery_runs SET discovery_protocol_version=1 \
             WHERE community_id=$1 AND id=$2",
        )
        .bind(community.as_uuid())
        .bind(lease_id)
        .execute(&db.pool)
        .await
        .expect("mark lease fixture as protocol V1");
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

        purge_test_community(&db, community).await;
    }
}
