//! Agent-first commands for the shared Discovery primitive.

use buzz_core::{
    discovery::{
        DiscoveryRunRequest, DiscoveryStartRequest, DISCOVERY_HOSTED_GATEWAY_PROTOCOL_VERSION,
    },
    discovery_workspace::{
        DiscoveryCampaignBudgetApproval, DiscoveryCampaignCreateInput, DiscoveryCampaignInputV2,
        DiscoveryCampaignListRequest, DiscoveryLeadListRequest, DiscoveryLeadUpdateInput,
        DiscoveryWorkspaceActionPayload, DiscoveryWorkspaceRequest,
    },
    kind::{KIND_DISCOVERY_RECEIPT, KIND_DISCOVERY_WORKSPACE_RECEIPT},
};
use buzz_sdk::discovery::{
    build_discovery_cancel_action, build_discovery_start_action, build_discovery_status_action,
    parse_discovery_receipt,
};
use buzz_sdk::discovery_workspace::{
    build_discovery_workspace_action, parse_discovery_workspace_receipt,
};
use nostr::{Event, JsonUtil, PublicKey};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{client::BuzzClient, error::CliError, DiscoveryCmd};

/// Route `buzz discovery ...`.
pub async fn dispatch(command: DiscoveryCmd, client: &BuzzClient) -> Result<(), CliError> {
    match command {
        DiscoveryCmd::Access { idempotency_key } => {
            publish_workspace_payload(
                client,
                DiscoveryWorkspaceActionPayload::Access,
                idempotency_key,
            )
            .await
        }
        DiscoveryCmd::CampaignCreate {
            campaign,
            name,
            industry,
            industry_name,
            vertical,
            vertical_name,
            query,
            location,
            target,
            description,
            language,
            region,
            idempotency_key,
        } => {
            publish_workspace_payload(
                client,
                DiscoveryWorkspaceActionPayload::CreateCampaign {
                    campaign: Box::new(DiscoveryCampaignCreateInput::Current(
                        DiscoveryCampaignInputV2 {
                            campaign_id: campaign.unwrap_or_else(Uuid::new_v4),
                            name: name.trim().to_owned(),
                            industry_id: industry.trim().to_owned(),
                            industry_name: industry_name.trim().to_owned(),
                            vertical_id: vertical.trim().to_owned(),
                            vertical_name: vertical_name.trim().to_owned(),
                            query: query.trim().to_owned(),
                            location: location.trim().to_owned(),
                            target,
                            description: description.map(|value| value.trim().to_owned()),
                            language: language.trim().to_ascii_lowercase(),
                            region: region.map(|value| value.trim().to_ascii_uppercase()),
                        },
                    )),
                    budget_approval: None,
                },
                idempotency_key,
            )
            .await
        }
        DiscoveryCmd::CampaignBudgetApprove {
            file,
            idempotency_key,
        } => {
            let raw = std::fs::read_to_string(&file)
                .map_err(|error| CliError::Usage(format!("cannot read `{file}`: {error}")))?;
            let approval: DiscoveryCampaignBudgetApproval =
                serde_json::from_str(&raw).map_err(|error| {
                    CliError::Usage(format!("invalid Campaign budget JSON: {error}"))
                })?;
            publish_workspace_payload(
                client,
                DiscoveryWorkspaceActionPayload::ApproveCampaignBudget { approval },
                idempotency_key,
            )
            .await
        }
        DiscoveryCmd::CampaignBudgetPause {
            campaign,
            idempotency_key,
        } => {
            publish_workspace_payload(
                client,
                DiscoveryWorkspaceActionPayload::PauseCampaignBudget {
                    campaign_id: campaign,
                },
                idempotency_key,
            )
            .await
        }
        DiscoveryCmd::CampaignBudgetRevoke {
            campaign,
            idempotency_key,
        } => {
            publish_workspace_payload(
                client,
                DiscoveryWorkspaceActionPayload::RevokeCampaignBudget {
                    campaign_id: campaign,
                },
                idempotency_key,
            )
            .await
        }
        DiscoveryCmd::CampaignBudgetGet {
            campaign,
            idempotency_key,
        } => {
            publish_workspace_payload(
                client,
                DiscoveryWorkspaceActionPayload::GetCampaignBudget {
                    campaign_id: campaign,
                },
                idempotency_key,
            )
            .await
        }
        DiscoveryCmd::CampaignGet {
            campaign,
            idempotency_key,
        } => {
            publish_workspace_payload(
                client,
                DiscoveryWorkspaceActionPayload::GetCampaign {
                    campaign_id: campaign,
                },
                idempotency_key,
            )
            .await
        }
        DiscoveryCmd::CampaignList {
            industry,
            vertical,
            offset,
            limit,
            idempotency_key,
        } => {
            publish_workspace_payload(
                client,
                DiscoveryWorkspaceActionPayload::ListCampaigns {
                    request: DiscoveryCampaignListRequest {
                        industry_id: industry.map(|value| value.trim().to_owned()),
                        vertical_id: vertical.map(|value| value.trim().to_owned()),
                        offset,
                        limit,
                    },
                },
                idempotency_key,
            )
            .await
        }
        DiscoveryCmd::LeadsList {
            campaign,
            industry,
            vertical,
            offset,
            limit,
            idempotency_key,
        } => {
            publish_workspace_payload(
                client,
                DiscoveryWorkspaceActionPayload::ListLeads {
                    request: DiscoveryLeadListRequest {
                        campaign_id: campaign,
                        industry_id: industry.map(|value| value.trim().to_owned()),
                        vertical_id: vertical.map(|value| value.trim().to_owned()),
                        status: None,
                        offset,
                        limit,
                    },
                },
                idempotency_key,
            )
            .await
        }
        DiscoveryCmd::LeadsCounts { idempotency_key } => {
            publish_workspace_payload(
                client,
                DiscoveryWorkspaceActionPayload::ListLeadCounts,
                idempotency_key,
            )
            .await
        }
        DiscoveryCmd::LeadGet {
            lead,
            idempotency_key,
        } => {
            publish_workspace_payload(
                client,
                DiscoveryWorkspaceActionPayload::GetLead { lead_id: lead },
                idempotency_key,
            )
            .await
        }
        DiscoveryCmd::LeadUpdate {
            lead,
            website,
            email,
            phone,
            linkedin_url,
            contact_name,
            contact_title,
            notes,
            score,
            owner,
            status,
            idempotency_key,
        } => {
            publish_workspace_payload(
                client,
                DiscoveryWorkspaceActionPayload::UpdateLead {
                    lead_id: lead,
                    input: DiscoveryLeadUpdateInput {
                        website: website.map(|value| value.trim().to_owned()),
                        email: email.map(|value| value.trim().to_owned()),
                        phone: phone.map(|value| value.trim().to_owned()),
                        linkedin_url: linkedin_url.map(|value| value.trim().to_owned()),
                        contact_name: contact_name.map(|value| value.trim().to_owned()),
                        contact_title: contact_title.map(|value| value.trim().to_owned()),
                        notes: notes.map(|value| value.trim().to_owned()),
                        score,
                        owner_persona_id: owner.map(|value| value.trim().to_owned()),
                        status: status.map(Into::into),
                    },
                },
                idempotency_key,
            )
            .await
        }
        DiscoveryCmd::Start {
            campaign,
            idempotency_key,
        } => {
            let relay = relay_self(client).await?;
            let request = DiscoveryStartRequest {
                request_id: Uuid::new_v4(),
                idempotency_key: idempotency_key.unwrap_or_else(Uuid::new_v4),
                campaign_id: campaign,
                protocol_version: DISCOVERY_HOSTED_GATEWAY_PROTOCOL_VERSION,
                business_search: None,
            };
            let builder = build_discovery_start_action(relay, &request)
                .map_err(|error| CliError::Usage(error.to_string()))?;
            publish(
                client,
                relay,
                request.request_id,
                request.idempotency_key,
                builder,
            )
            .await
        }
        DiscoveryCmd::Status {
            run,
            idempotency_key,
        } => {
            let relay = relay_self(client).await?;
            let request = DiscoveryRunRequest {
                request_id: Uuid::new_v4(),
                idempotency_key: idempotency_key.unwrap_or_else(Uuid::new_v4),
                run_id: run,
            };
            let builder = build_discovery_status_action(relay, &request)
                .map_err(|error| CliError::Usage(error.to_string()))?;
            publish(
                client,
                relay,
                request.request_id,
                request.idempotency_key,
                builder,
            )
            .await
        }
        DiscoveryCmd::Cancel {
            run,
            idempotency_key,
        } => {
            let relay = relay_self(client).await?;
            let request = DiscoveryRunRequest {
                request_id: Uuid::new_v4(),
                idempotency_key: idempotency_key.unwrap_or_else(Uuid::new_v4),
                run_id: run,
            };
            let builder = build_discovery_cancel_action(relay, &request)
                .map_err(|error| CliError::Usage(error.to_string()))?;
            publish(
                client,
                relay,
                request.request_id,
                request.idempotency_key,
                builder,
            )
            .await
        }
    }
}

async fn relay_self(client: &BuzzClient) -> Result<PublicKey, CliError> {
    let raw = client.get_public("/").await?;
    let document: Value = serde_json::from_str(&raw)
        .map_err(|error| CliError::Other(format!("relay info is malformed: {error}")))?;
    let value = document
        .get("self")
        .and_then(Value::as_str)
        .ok_or_else(|| CliError::Other("relay info is missing self pubkey".to_owned()))?;
    PublicKey::parse(value)
        .map_err(|error| CliError::Other(format!("relay self pubkey is invalid: {error}")))
}

async fn publish_workspace_payload(
    client: &BuzzClient,
    payload: DiscoveryWorkspaceActionPayload,
    idempotency_key: Option<Uuid>,
) -> Result<(), CliError> {
    let relay = relay_self(client).await?;
    let request = DiscoveryWorkspaceRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: idempotency_key.unwrap_or_else(Uuid::new_v4),
        payload,
    };
    let event = build_discovery_workspace_action(relay, &request)
        .map_err(|error| CliError::Usage(error.to_string()))?
        .sign_with_keys(client.keys())
        .map_err(|error| CliError::Other(format!("signing failed: {error}")))?;
    let submitted_event_id = event.id.to_hex();
    let response = client.submit_event(event).await?;
    let response_value: Value = serde_json::from_str(&response)
        .map_err(|error| CliError::Other(format!("relay response is malformed: {error}")))?;
    let accepted = response_value
        .get("accepted")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let message_text = response_value
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message: Value = serde_json::from_str(message_text).unwrap_or_else(|_| json!({}));
    let receipt_id = message
        .get("receipt_event_id")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let receipt = fetch_and_verify_workspace_receipt(
        client,
        relay,
        &submitted_event_id,
        receipt_id.as_deref(),
    )
    .await?;
    let duplicate = message
        .get("duplicate")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    println!(
        "{}",
        json!({
            "event_id": submitted_event_id,
            "accepted": accepted,
            "duplicate": duplicate,
            "request_id": request.request_id,
            "idempotency_key": request.idempotency_key,
            "receipt_event_id": receipt_id,
            "receipt": receipt.receipt,
        })
    );
    if accepted || duplicate {
        Ok(())
    } else {
        Err(CliError::Conflict(if message_text.is_empty() {
            "Discovery workspace command was refused".to_owned()
        } else {
            message_text.to_owned()
        }))
    }
}

async fn fetch_and_verify_workspace_receipt(
    client: &BuzzClient,
    relay: PublicKey,
    submitted_action_id: &str,
    receipt_id: Option<&str>,
) -> Result<buzz_sdk::discovery_workspace::ParsedDiscoveryWorkspaceReceipt, CliError> {
    let actor = client.keys().public_key().to_hex();
    let filter = if let Some(receipt_id) = receipt_id {
        json!({
            "ids": [receipt_id],
            "kinds": [KIND_DISCOVERY_WORKSPACE_RECEIPT],
            "authors": [relay.to_hex()],
            "#p": [actor],
            "limit": 1
        })
    } else {
        json!({
            "kinds": [KIND_DISCOVERY_WORKSPACE_RECEIPT],
            "authors": [relay.to_hex()],
            "#e": [submitted_action_id],
            "#p": [actor],
            "limit": 1
        })
    };
    let raw = client
        .query_paginated(filter, 1)
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| CliError::NotFound("Discovery workspace receipt not found".to_owned()))?;
    let event = Event::from_json(raw.to_string()).map_err(|error| {
        CliError::Other(format!("Discovery workspace receipt is malformed: {error}"))
    })?;
    event.verify().map_err(|error| {
        CliError::Other(format!(
            "Discovery workspace receipt signature is invalid: {error}"
        ))
    })?;
    if event.pubkey != relay {
        return Err(CliError::Other(
            "Discovery workspace receipt was not signed by this relay".to_owned(),
        ));
    }
    let parsed = parse_discovery_workspace_receipt(&event).map_err(|error| {
        CliError::Other(format!("Discovery workspace receipt is invalid: {error}"))
    })?;
    if parsed.actor_pubkey != client.keys().public_key() {
        return Err(CliError::Other(
            "Discovery workspace receipt is addressed to a different actor".to_owned(),
        ));
    }
    Ok(parsed)
}

async fn publish(
    client: &BuzzClient,
    relay: PublicKey,
    request_id: Uuid,
    idempotency_key: Uuid,
    builder: nostr::EventBuilder,
) -> Result<(), CliError> {
    // The Discovery action protocol has an exact three-tag envelope. Managed
    // agent delegation is already sent as the x-auth-tag HTTP header, while
    // durable Discovery authority comes from the server-side capability grant.
    let event = builder
        .sign_with_keys(client.keys())
        .map_err(|error| CliError::Other(format!("signing failed: {error}")))?;
    let submitted_event_id = event.id.to_hex();
    let response = client.submit_event(event).await?;
    let response_value: Value = serde_json::from_str(&response)
        .map_err(|error| CliError::Other(format!("relay response is malformed: {error}")))?;
    let accepted = response_value
        .get("accepted")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let message_text = response_value
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message: Value = serde_json::from_str(message_text).unwrap_or_else(|_| json!({}));
    let receipt_id = message
        .get("receipt_event_id")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let receipt =
        fetch_and_verify_receipt(client, relay, &submitted_event_id, receipt_id.as_deref()).await?;
    let duplicate = message
        .get("duplicate")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    println!(
        "{}",
        json!({
            "event_id": submitted_event_id,
            "accepted": accepted,
            "duplicate": duplicate,
            "request_id": request_id,
            "idempotency_key": idempotency_key,
            "receipt_event_id": receipt_id,
            "receipt": receipt.receipt,
        })
    );

    if accepted || duplicate {
        Ok(())
    } else {
        Err(CliError::Conflict(if message_text.is_empty() {
            "Discovery command was refused".to_owned()
        } else {
            message_text.to_owned()
        }))
    }
}

async fn fetch_and_verify_receipt(
    client: &BuzzClient,
    relay: PublicKey,
    submitted_action_id: &str,
    receipt_id: Option<&str>,
) -> Result<buzz_sdk::discovery::ParsedDiscoveryReceipt, CliError> {
    let actor = client.keys().public_key().to_hex();
    let filter = if let Some(receipt_id) = receipt_id {
        json!({
            "ids": [receipt_id],
            "kinds": [KIND_DISCOVERY_RECEIPT],
            "authors": [relay.to_hex()],
            "#p": [actor],
            "limit": 1
        })
    } else {
        json!({
            "kinds": [KIND_DISCOVERY_RECEIPT],
            "authors": [relay.to_hex()],
            "#e": [submitted_action_id],
            "#p": [actor],
            "limit": 1
        })
    };
    let raw = client
        .query_paginated(filter, 1)
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| CliError::NotFound("Discovery receipt not found".to_owned()))?;
    let event = Event::from_json(raw.to_string())
        .map_err(|error| CliError::Other(format!("Discovery receipt is malformed: {error}")))?;
    event.verify().map_err(|error| {
        CliError::Other(format!("Discovery receipt signature is invalid: {error}"))
    })?;
    if event.pubkey != relay {
        return Err(CliError::Other(
            "Discovery receipt was not signed by this relay".to_owned(),
        ));
    }
    let parsed = parse_discovery_receipt(&event)
        .map_err(|error| CliError::Other(format!("Discovery receipt is invalid: {error}")))?;
    if parsed.actor_pubkey != client.keys().public_key() {
        return Err(CliError::Other(
            "Discovery receipt is addressed to a different actor".to_owned(),
        ));
    }
    Ok(parsed)
}
