//! Private campaign and Lead persistence for Colony Discovery.

use buzz_core::{
    discovery::{
        DiscoveryBusinessSearchSpec, DiscoveryRunProjection, DiscoveryRunState,
        DiscoveryTerminalReason,
    },
    discovery_workspace::{
        DiscoveryBusinessLeadProjection, DiscoveryCampaignInput, DiscoveryCampaignListRequest,
        DiscoveryCampaignPage, DiscoveryCampaignProjection, DiscoveryLeadListRequest,
        DiscoveryLeadPage, DiscoveryWorkspaceActionPayload, DiscoveryWorkspaceOperation,
        DiscoveryWorkspaceRequest, DiscoveryWorkspaceResult,
    },
    CommunityId, StoredEvent,
};
use nostr::Event;
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

use crate::{Db, DbError, Result};

/// Require a run search to exactly match its persisted immutable campaign.
pub(crate) async fn require_campaign_search_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    campaign_id: Uuid,
    requested: &DiscoveryBusinessSearchSpec,
) -> Result<()> {
    let row = sqlx::query(
        "SELECT query,location,target,language,region FROM discovery_campaigns \
         WHERE community_id=$1 AND id=$2",
    )
    .bind(community_id.as_uuid())
    .bind(campaign_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| DbError::NotFound("Discovery campaign".into()))?;
    let target: i16 = row.try_get("target")?;
    let stored = DiscoveryBusinessSearchSpec {
        query: row.try_get("query")?,
        location: row.try_get("location")?,
        limit: u16::try_from(target)
            .map_err(|_| DbError::InvalidData("Discovery campaign target is invalid".into()))?,
        language: row.try_get("language")?,
        region: row.try_get("region")?,
    };
    if stored != *requested {
        return Err(DbError::AccessDenied(
            "Discovery run search does not match its campaign".into(),
        ));
    }
    Ok(())
}

/// Atomic result of a signed Discovery workspace action.
#[derive(Debug, Clone)]
pub enum DiscoveryWorkspaceCommandApply {
    /// The action, receipt, and workspace operation committed together.
    Applied {
        /// Stored actor-signed action.
        action: Box<StoredEvent>,
        /// Stored relay-signed private receipt.
        receipt: Box<StoredEvent>,
        /// Strict private result signed into the receipt.
        result: Box<DiscoveryWorkspaceResult>,
    },
    /// The same logical operation already committed.
    Duplicate {
        /// Original actor-signed action event ID.
        original_action_event_id: Vec<u8>,
        /// Original relay-signed receipt event ID.
        receipt_event_id: Vec<u8>,
    },
}

impl Db {
    /// Atomically apply one private campaign/Lead operation and its audit events.
    pub async fn apply_discovery_workspace_command_once<F>(
        &self,
        community_id: CommunityId,
        actor_pubkey: &[u8; 32],
        request: &DiscoveryWorkspaceRequest,
        action_event: &Event,
        build_receipt: F,
    ) -> Result<DiscoveryWorkspaceCommandApply>
    where
        F: FnOnce(&DiscoveryWorkspaceResult) -> Result<Event>,
    {
        request
            .validate()
            .map_err(|error| DbError::InvalidData(error.to_string()))?;
        if action_event.pubkey.to_bytes() != *actor_pubkey {
            return Err(DbError::AccessDenied(
                "Discovery workspace action signer does not match authenticated actor".into(),
            ));
        }

        let mut tx = self.pool.begin().await?;
        match request.payload {
            DiscoveryWorkspaceActionPayload::Access => {
                require_discovery_member_tx(&mut tx, community_id, actor_pubkey).await?;
            }
            _ => {
                super::discovery::require_discovery_authorized_tx(
                    &mut tx,
                    community_id,
                    actor_pubkey,
                )
                .await?;
            }
        }

        let operation = request.payload.operation();
        let fingerprint = workspace_request_fingerprint(request)?;
        if let Some(row) = sqlx::query(
            "SELECT operation, request_fingerprint, action_event_id, receipt_event_id \
             FROM discovery_workspace_action_claims \
             WHERE community_id=$1 AND idempotency_key=$2",
        )
        .bind(community_id.as_uuid())
        .bind(request.idempotency_key)
        .fetch_optional(&mut *tx)
        .await?
        {
            let claimed_operation: String = row.try_get("operation")?;
            let claimed_fingerprint: Vec<u8> = row.try_get("request_fingerprint")?;
            if claimed_operation != operation_text(operation)
                || claimed_fingerprint != fingerprint.as_slice()
            {
                return Err(DbError::AccessDenied(
                    "Discovery workspace idempotency key conflicts with an existing command".into(),
                ));
            }
            tx.commit().await?;
            return Ok(DiscoveryWorkspaceCommandApply::Duplicate {
                original_action_event_id: row.try_get("action_event_id")?,
                receipt_event_id: row.try_get("receipt_event_id")?,
            });
        }

        let result =
            apply_workspace_operation_tx(&mut tx, community_id, actor_pubkey, &request.payload)
                .await?;
        let receipt_event = build_receipt(&result)?;
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
                "Discovery workspace action exists without its command claim".into(),
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
                "Discovery workspace receipt exists without its command claim".into(),
            ));
        }
        crate::insert_mentions_tx(&mut tx, community_id, &receipt_event, None).await?;
        sqlx::query(
            "INSERT INTO discovery_workspace_action_claims \
             (community_id, idempotency_key, operation, request_fingerprint, \
              action_event_id, receipt_event_id) VALUES ($1,$2,$3,$4,$5,$6)",
        )
        .bind(community_id.as_uuid())
        .bind(request.idempotency_key)
        .bind(operation_text(operation))
        .bind(fingerprint.as_slice())
        .bind(action_event.id.as_bytes())
        .bind(receipt_event.id.as_bytes())
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(DiscoveryWorkspaceCommandApply::Applied {
            action: Box::new(stored_action),
            receipt: Box::new(stored_receipt),
            result: Box::new(result),
        })
    }
}

async fn apply_workspace_operation_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    actor_pubkey: &[u8; 32],
    payload: &DiscoveryWorkspaceActionPayload,
) -> Result<DiscoveryWorkspaceResult> {
    match payload {
        DiscoveryWorkspaceActionPayload::Access => {
            let active: bool = sqlx::query_scalar(
                "SELECT COALESCE((SELECT active FROM discovery_entitlements \
                 WHERE community_id=$1), FALSE)",
            )
            .bind(community_id.as_uuid())
            .fetch_one(&mut **tx)
            .await?;
            Ok(DiscoveryWorkspaceResult::Access { active })
        }
        DiscoveryWorkspaceActionPayload::CreateCampaign { campaign } => {
            insert_campaign_tx(tx, community_id, actor_pubkey, campaign).await?;
            Ok(DiscoveryWorkspaceResult::Campaign {
                campaign: Box::new(load_campaign_tx(tx, community_id, campaign.campaign_id).await?),
            })
        }
        DiscoveryWorkspaceActionPayload::GetCampaign { campaign_id } => {
            Ok(DiscoveryWorkspaceResult::Campaign {
                campaign: Box::new(load_campaign_tx(tx, community_id, *campaign_id).await?),
            })
        }
        DiscoveryWorkspaceActionPayload::ListCampaigns { request } => {
            Ok(DiscoveryWorkspaceResult::Campaigns {
                page: list_campaigns_tx(tx, community_id, request).await?,
            })
        }
        DiscoveryWorkspaceActionPayload::ListLeads { request } => {
            Ok(DiscoveryWorkspaceResult::Leads {
                page: list_leads_tx(tx, community_id, request).await?,
            })
        }
    }
}

async fn insert_campaign_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    actor_pubkey: &[u8; 32],
    campaign: &DiscoveryCampaignInput,
) -> Result<()> {
    campaign
        .validate()
        .map_err(|error| DbError::InvalidData(error.to_string()))?;
    let inserted =
        sqlx::query(
            "INSERT INTO discovery_campaigns \
         (community_id,id,created_by,name,industry_id,industry_name,vertical_id,vertical_name,\
          query,location,target,description,language,region) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) \
         ON CONFLICT (community_id,id) DO NOTHING RETURNING id",
        )
        .bind(community_id.as_uuid())
        .bind(campaign.campaign_id)
        .bind(actor_pubkey.as_slice())
        .bind(&campaign.name)
        .bind(&campaign.industry_id)
        .bind(&campaign.industry_name)
        .bind(&campaign.vertical_id)
        .bind(&campaign.vertical_name)
        .bind(&campaign.query)
        .bind(&campaign.location)
        .bind(i16::try_from(campaign.target).map_err(|_| {
            DbError::InvalidData("Discovery campaign target exceeds SMALLINT".into())
        })?)
        .bind(campaign.description.as_deref())
        .bind(&campaign.language)
        .bind(campaign.region.as_deref())
        .fetch_optional(&mut **tx)
        .await?;
    if inserted.is_none() {
        return Err(DbError::AccessDenied(
            "Discovery campaign identifier already exists".into(),
        ));
    }
    Ok(())
}

async fn load_campaign_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    campaign_id: Uuid,
) -> Result<DiscoveryCampaignProjection> {
    let row = sqlx::query(CAMPAIGN_PROJECTION_SELECT)
        .bind(community_id.as_uuid())
        .bind(campaign_id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| DbError::NotFound("Discovery campaign".into()))?;
    campaign_from_row(&row)
}

async fn list_campaigns_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    request: &DiscoveryCampaignListRequest,
) -> Result<DiscoveryCampaignPage> {
    request
        .validate()
        .map_err(|error| DbError::InvalidData(error.to_string()))?;
    let total: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM discovery_campaigns \
         WHERE community_id=$1 AND ($2::text IS NULL OR industry_id=$2) \
           AND ($3::text IS NULL OR vertical_id=$3)",
    )
    .bind(community_id.as_uuid())
    .bind(request.industry_id.as_deref())
    .bind(request.vertical_id.as_deref())
    .fetch_one(&mut **tx)
    .await?;
    let rows = sqlx::query(CAMPAIGN_PROJECTION_SELECT_FILTERED)
        .bind(community_id.as_uuid())
        .bind(request.industry_id.as_deref())
        .bind(request.vertical_id.as_deref())
        .bind(i64::from(request.limit))
        .bind(i64::from(request.offset))
        .fetch_all(&mut **tx)
        .await?;
    let campaigns = rows
        .iter()
        .map(campaign_from_row)
        .collect::<Result<Vec<_>>>()?;
    Ok(DiscoveryCampaignPage {
        campaigns,
        total: count_to_u32(total, "campaign")?,
        offset: request.offset,
        limit: request.limit,
    })
}

async fn list_leads_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    request: &DiscoveryLeadListRequest,
) -> Result<DiscoveryLeadPage> {
    request
        .validate()
        .map_err(|error| DbError::InvalidData(error.to_string()))?;
    let total: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM discovery_business_observations o \
         JOIN discovery_runs r ON r.community_id=o.community_id AND r.id=o.first_run_id \
         JOIN discovery_campaigns c ON c.community_id=r.community_id AND c.id=r.campaign_id \
         WHERE o.community_id=$1 AND ($2::uuid IS NULL OR c.id=$2) \
           AND ($3::text IS NULL OR c.industry_id=$3) \
           AND ($4::text IS NULL OR c.vertical_id=$4)",
    )
    .bind(community_id.as_uuid())
    .bind(request.campaign_id)
    .bind(request.industry_id.as_deref())
    .bind(request.vertical_id.as_deref())
    .fetch_one(&mut **tx)
    .await?;
    let rows = sqlx::query(
        "SELECT o.id AS lead_id,c.id AS campaign_id,c.industry_id,c.vertical_id,o.name,\
                o.website,o.phone,o.full_address,o.city,o.state,o.country,o.category,o.subtypes,\
                o.rating_hundredths,o.reviews_count,o.source_url,o.image_url,o.first_observed_at \
         FROM discovery_business_observations o \
         JOIN discovery_runs r ON r.community_id=o.community_id AND r.id=o.first_run_id \
         JOIN discovery_campaigns c ON c.community_id=r.community_id AND c.id=r.campaign_id \
         WHERE o.community_id=$1 AND ($2::uuid IS NULL OR c.id=$2) \
           AND ($3::text IS NULL OR c.industry_id=$3) \
           AND ($4::text IS NULL OR c.vertical_id=$4) \
         ORDER BY o.first_observed_at DESC,o.id DESC LIMIT $5 OFFSET $6",
    )
    .bind(community_id.as_uuid())
    .bind(request.campaign_id)
    .bind(request.industry_id.as_deref())
    .bind(request.vertical_id.as_deref())
    .bind(i64::from(request.limit))
    .bind(i64::from(request.offset))
    .fetch_all(&mut **tx)
    .await?;
    let leads = rows.iter().map(lead_from_row).collect::<Result<Vec<_>>>()?;
    Ok(DiscoveryLeadPage {
        leads,
        total: count_to_u32(total, "Lead")?,
        offset: request.offset,
        limit: request.limit,
    })
}

const CAMPAIGN_PROJECTION_SELECT: &str = concat!(
    "SELECT ",
    "c.id AS campaign_record_id,c.name,c.industry_id,c.industry_name,c.vertical_id,c.vertical_name,\
     c.query,c.location,c.target,c.description,c.language,c.region,c.created_at,\
     GREATEST(c.updated_at,COALESCE(r.updated_at,c.updated_at)) AS campaign_updated_at,\
     COALESCE(l.lead_count,0) AS lead_count,r.id AS run_id,r.campaign_id AS run_campaign_id,\
     r.state AS run_state,r.completed_steps,r.total_steps,r.cancel_requested,r.terminal_reason,\
     r.created_at AS run_created_at,r.updated_at AS run_updated_at ",
    "FROM discovery_campaigns c ",
    "LEFT JOIN LATERAL (SELECT id,campaign_id,state,completed_steps,total_steps,cancel_requested,\
      terminal_reason,created_at,updated_at FROM discovery_runs \
      WHERE community_id=c.community_id AND campaign_id=c.id \
      ORDER BY created_at DESC,id DESC LIMIT 1) r ON TRUE ",
    "LEFT JOIN LATERAL (SELECT count(*) AS lead_count FROM discovery_business_observations o \
      JOIN discovery_runs lr ON lr.community_id=o.community_id AND lr.id=o.first_run_id \
      WHERE o.community_id=c.community_id AND lr.campaign_id=c.id) l ON TRUE ",
    "WHERE c.community_id=$1 AND c.id=$2"
);

const CAMPAIGN_PROJECTION_SELECT_FILTERED: &str = concat!(
    "SELECT ",
    "c.id AS campaign_record_id,c.name,c.industry_id,c.industry_name,c.vertical_id,c.vertical_name,\
     c.query,c.location,c.target,c.description,c.language,c.region,c.created_at,\
     GREATEST(c.updated_at,COALESCE(r.updated_at,c.updated_at)) AS campaign_updated_at,\
     COALESCE(l.lead_count,0) AS lead_count,r.id AS run_id,r.campaign_id AS run_campaign_id,\
     r.state AS run_state,r.completed_steps,r.total_steps,r.cancel_requested,r.terminal_reason,\
     r.created_at AS run_created_at,r.updated_at AS run_updated_at ",
    "FROM discovery_campaigns c ",
    "LEFT JOIN LATERAL (SELECT id,campaign_id,state,completed_steps,total_steps,cancel_requested,\
      terminal_reason,created_at,updated_at FROM discovery_runs \
      WHERE community_id=c.community_id AND campaign_id=c.id \
      ORDER BY created_at DESC,id DESC LIMIT 1) r ON TRUE ",
    "LEFT JOIN LATERAL (SELECT count(*) AS lead_count FROM discovery_business_observations o \
      JOIN discovery_runs lr ON lr.community_id=o.community_id AND lr.id=o.first_run_id \
      WHERE o.community_id=c.community_id AND lr.campaign_id=c.id) l ON TRUE ",
    "WHERE c.community_id=$1 AND ($2::text IS NULL OR c.industry_id=$2) \
      AND ($3::text IS NULL OR c.vertical_id=$3) \
      ORDER BY c.created_at DESC,c.id DESC LIMIT $4 OFFSET $5"
);

fn campaign_from_row(row: &sqlx::postgres::PgRow) -> Result<DiscoveryCampaignProjection> {
    let target: i16 = row.try_get("target")?;
    let lead_count: i64 = row.try_get("lead_count")?;
    let latest_run = row
        .try_get::<Option<Uuid>, _>("run_id")?
        .map(|run_id| run_projection_from_row(row, run_id))
        .transpose()?;
    Ok(DiscoveryCampaignProjection {
        campaign_id: row.try_get("campaign_record_id")?,
        name: row.try_get("name")?,
        industry_id: row.try_get("industry_id")?,
        industry_name: row.try_get("industry_name")?,
        vertical_id: row.try_get("vertical_id")?,
        vertical_name: row.try_get("vertical_name")?,
        query: row.try_get("query")?,
        location: row.try_get("location")?,
        target: u16::try_from(target)
            .map_err(|_| DbError::InvalidData("Discovery campaign target is invalid".into()))?,
        description: row.try_get("description")?,
        language: row.try_get("language")?,
        region: row.try_get("region")?,
        lead_count: count_to_u32(lead_count, "Lead")?,
        latest_run,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("campaign_updated_at")?,
    })
}

fn run_projection_from_row(
    row: &sqlx::postgres::PgRow,
    run_id: Uuid,
) -> Result<DiscoveryRunProjection> {
    let completed: i32 = row.try_get("completed_steps")?;
    let total: i32 = row.try_get("total_steps")?;
    Ok(DiscoveryRunProjection {
        run_id,
        campaign_id: row.try_get("run_campaign_id")?,
        state: parse_run_state(row.try_get("run_state")?)?,
        completed_steps: u32::try_from(completed)
            .map_err(|_| DbError::InvalidData("Discovery completed steps are invalid".into()))?,
        total_steps: u32::try_from(total)
            .map_err(|_| DbError::InvalidData("Discovery total steps are invalid".into()))?,
        cancel_requested: row.try_get("cancel_requested")?,
        terminal_reason: parse_terminal_reason(row.try_get("terminal_reason")?)?,
        created_at: row.try_get("run_created_at")?,
        updated_at: row.try_get("run_updated_at")?,
    })
}

fn lead_from_row(row: &sqlx::postgres::PgRow) -> Result<DiscoveryBusinessLeadProjection> {
    let rating: Option<i16> = row.try_get("rating_hundredths")?;
    let reviews: Option<i64> = row.try_get("reviews_count")?;
    Ok(DiscoveryBusinessLeadProjection {
        lead_id: row.try_get("lead_id")?,
        campaign_id: row.try_get("campaign_id")?,
        industry_id: row.try_get("industry_id")?,
        vertical_id: row.try_get("vertical_id")?,
        name: row.try_get("name")?,
        website: row.try_get("website")?,
        phone: row.try_get("phone")?,
        full_address: row.try_get("full_address")?,
        city: row.try_get("city")?,
        state: row.try_get("state")?,
        country: row.try_get("country")?,
        category: row.try_get("category")?,
        subtypes: row.try_get("subtypes")?,
        rating_hundredths: rating
            .map(u16::try_from)
            .transpose()
            .map_err(|_| DbError::InvalidData("Discovery rating is invalid".into()))?,
        reviews_count: reviews
            .map(u64::try_from)
            .transpose()
            .map_err(|_| DbError::InvalidData("Discovery review count is invalid".into()))?,
        source_url: row.try_get("source_url")?,
        image_url: row.try_get("image_url")?,
        added_at: row.try_get("first_observed_at")?,
    })
}

async fn require_discovery_member_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    actor_pubkey: &[u8; 32],
) -> Result<()> {
    super::discovery::lock_discovery_authority_tx(tx, community_id).await?;
    let member: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM relay_members WHERE community_id=$1 AND pubkey=$2)",
    )
    .bind(community_id.as_uuid())
    .bind(hex::encode(actor_pubkey))
    .fetch_one(&mut **tx)
    .await?;
    if member {
        Ok(())
    } else {
        Err(DbError::AccessDenied(
            "Discovery requires relay membership".into(),
        ))
    }
}

fn workspace_request_fingerprint(request: &DiscoveryWorkspaceRequest) -> Result<[u8; 32]> {
    let encoded = serde_json::to_vec(request).map_err(|error| {
        DbError::InvalidData(format!(
            "Discovery workspace request cannot be encoded: {error}"
        ))
    })?;
    Ok(Sha256::digest(encoded).into())
}

fn operation_text(operation: DiscoveryWorkspaceOperation) -> &'static str {
    match operation {
        DiscoveryWorkspaceOperation::Access => "access",
        DiscoveryWorkspaceOperation::CreateCampaign => "create_campaign",
        DiscoveryWorkspaceOperation::GetCampaign => "get_campaign",
        DiscoveryWorkspaceOperation::ListCampaigns => "list_campaigns",
        DiscoveryWorkspaceOperation::ListLeads => "list_leads",
    }
}

fn parse_run_state(value: String) -> Result<DiscoveryRunState> {
    match value.as_str() {
        "queued" => Ok(DiscoveryRunState::Queued),
        "running" => Ok(DiscoveryRunState::Running),
        "succeeded" => Ok(DiscoveryRunState::Succeeded),
        "cancelled" => Ok(DiscoveryRunState::Cancelled),
        "failed" => Ok(DiscoveryRunState::Failed),
        _ => Err(DbError::InvalidData("invalid Discovery run state".into())),
    }
}

fn parse_terminal_reason(value: Option<String>) -> Result<Option<DiscoveryTerminalReason>> {
    value
        .map(|reason| match reason.as_str() {
            "cancelled_by_actor" => Ok(DiscoveryTerminalReason::CancelledByActor),
            "entitlement_revoked" => Ok(DiscoveryTerminalReason::EntitlementRevoked),
            "executor_failed" => Ok(DiscoveryTerminalReason::ExecutorFailed),
            _ => Err(DbError::InvalidData(
                "invalid Discovery terminal reason".into(),
            )),
        })
        .transpose()
}

fn count_to_u32(value: i64, entity: &str) -> Result<u32> {
    u32::try_from(value)
        .map_err(|_| DbError::InvalidData(format!("Discovery {entity} count is invalid")))
}
