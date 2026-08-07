//! Real-relay proof for the private Discovery command and receipt plane.
//!
//! Run against the isolated harness:
//! `RELAY_URL=ws://localhost:3030 DATABASE_URL=postgres://buzz:buzz_dev@localhost:5471/buzz cargo test -p buzz-test-client --test e2e_discovery -- --ignored --nocapture`

use std::time::Duration;

use buzz_core::{
    discovery::{
        DiscoveryRunRequest, DiscoveryRunState, DiscoverySource, DiscoverySourceConfig,
        DiscoverySourceMode, DiscoveryStartRequest,
    },
    discovery_worker::{
        DiscoveryCheckpointKind, DiscoveryProvider, DiscoveryRunSourceStatus,
        DiscoveryWorkerCheckpoint, DiscoveryWorkerCheckpointRequest, DiscoveryWorkerClaimRequest,
        DiscoveryWorkerLeaseRequest, DiscoveryWorkerReceiptOutcome,
        DiscoveryWorkerSourceProgressRequest,
    },
    discovery_workspace::{
        DiscoveryCampaignInput, DiscoveryLeadListRequest, DiscoveryLeadStatus,
        DiscoveryLeadUpdateInput, DiscoveryWorkspaceActionPayload, DiscoveryWorkspaceRequest,
        DiscoveryWorkspaceResult,
    },
    kind::{
        KIND_DISCOVERY_RECEIPT, KIND_DISCOVERY_WORKER_RECEIPT, KIND_DISCOVERY_WORKSPACE_ACTION,
        KIND_DISCOVERY_WORKSPACE_RECEIPT,
    },
};
use buzz_sdk::{
    discovery::{
        build_discovery_cancel_action, build_discovery_start_action, parse_discovery_receipt,
    },
    discovery_worker::{
        build_discovery_worker_checkpoint_action, build_discovery_worker_claim_action,
        build_discovery_worker_complete_action, build_discovery_worker_heartbeat_action,
        build_discovery_worker_source_progress_action, parse_discovery_worker_receipt,
        ParsedDiscoveryWorkerReceipt,
    },
    discovery_workspace::{build_discovery_workspace_action, parse_discovery_workspace_receipt},
};
use buzz_test_client::{BuzzTestClient, RelayMessage};
use nostr::{Alphabet, EventId, Filter, Keys, Kind, SingleLetterTag};
use serde_json::Value;
use sqlx::Row;
use uuid::Uuid;

static DISCOVERY_E2E_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn relay_url() -> String {
    std::env::var("RELAY_URL").unwrap_or_else(|_| "ws://localhost:3030".to_owned())
}

fn relay_http_url() -> String {
    relay_url()
        .replacen("ws://", "http://", 1)
        .replacen("wss://", "https://", 1)
}

async fn relay_pubkey() -> nostr::PublicKey {
    let info: Value = reqwest::Client::new()
        .get(relay_http_url())
        .header("Accept", "application/nostr+json")
        .send()
        .await
        .expect("fetch NIP-11")
        .json()
        .await
        .expect("parse NIP-11");
    nostr::PublicKey::parse(
        info.get("self")
            .and_then(Value::as_str)
            .expect("NIP-11 self key"),
    )
    .expect("valid relay pubkey")
}

async fn submit_worker_action(
    client: &mut BuzzTestClient,
    actor: &Keys,
    relay: nostr::PublicKey,
    builder: nostr::EventBuilder,
) -> ParsedDiscoveryWorkerReceipt {
    let event = builder.sign_with_keys(actor).expect("sign worker action");
    let action_id = event.id;
    let ok = client
        .send_event(event)
        .await
        .expect("publish worker action");
    assert!(ok.accepted, "worker action rejected: {}", ok.message);
    let answer: Value = serde_json::from_str(&ok.message).expect("structured worker response");
    let receipt_id = EventId::from_hex(
        answer
            .get("receipt_event_id")
            .and_then(Value::as_str)
            .expect("worker receipt event id"),
    )
    .expect("valid worker receipt id");
    let p_tag = SingleLetterTag::lowercase(Alphabet::P);
    let filter = Filter::new()
        .kind(Kind::Custom(KIND_DISCOVERY_WORKER_RECEIPT as u16))
        .id(receipt_id)
        .event(action_id)
        .custom_tags(p_tag, [actor.public_key().to_hex()]);
    let subscription_id = format!("worker-receipt-{receipt_id}");
    client
        .subscribe(&subscription_id, vec![filter])
        .await
        .expect("subscribe to worker receipt");
    let receipts = client
        .collect_until_eose(&subscription_id, Duration::from_secs(5))
        .await
        .expect("collect worker receipt");
    assert!(!receipts.is_empty(), "worker receipt must be delivered");
    assert!(
        receipts.iter().all(|receipt| receipt.id == receipt_id),
        "subscription may replay the live receipt, but must not return another event"
    );
    receipts[0].verify().expect("worker receipt signature");
    assert_eq!(receipts[0].pubkey, relay);
    let parsed =
        parse_discovery_worker_receipt(&receipts[0]).expect("strict worker receipt envelope");
    assert_eq!(parsed.actor_pubkey, actor.public_key());
    assert_eq!(parsed.action_event_id, action_id);
    parsed
}

async fn submit_workspace_action(
    client: &mut BuzzTestClient,
    actor: &Keys,
    relay: nostr::PublicKey,
    payload: DiscoveryWorkspaceActionPayload,
) -> DiscoveryWorkspaceResult {
    let request = DiscoveryWorkspaceRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        payload,
    };
    let event = build_discovery_workspace_action(relay, &request)
        .expect("valid workspace action")
        .sign_with_keys(actor)
        .expect("sign workspace action");
    let action_id = event.id;
    let ok = client
        .send_event(event)
        .await
        .expect("publish workspace action");
    assert!(ok.accepted, "workspace action rejected: {}", ok.message);
    let answer: Value = serde_json::from_str(&ok.message).expect("structured workspace response");
    let receipt_id = EventId::from_hex(
        answer
            .get("receipt_event_id")
            .and_then(Value::as_str)
            .expect("workspace receipt event id"),
    )
    .expect("valid workspace receipt id");
    let p_tag = SingleLetterTag::lowercase(Alphabet::P);
    let filter = Filter::new()
        .kind(Kind::Custom(KIND_DISCOVERY_WORKSPACE_RECEIPT as u16))
        .id(receipt_id)
        .event(action_id)
        .custom_tags(p_tag, [actor.public_key().to_hex()]);
    let subscription_id = format!("workspace-receipt-{}", request.request_id);
    client
        .subscribe(&subscription_id, vec![filter])
        .await
        .expect("subscribe to workspace receipt");
    let receipts = client
        .collect_until_eose(&subscription_id, Duration::from_secs(5))
        .await
        .expect("collect workspace receipt");
    let receipt = receipts
        .first()
        .expect("workspace receipt must be delivered");
    receipt.verify().expect("workspace receipt signature");
    assert_eq!(receipt.pubkey, relay);
    let parsed = parse_discovery_workspace_receipt(receipt).expect("strict workspace receipt");
    assert_eq!(parsed.actor_pubkey, actor.public_key());
    assert_eq!(parsed.action_event_id, action_id);
    parsed.receipt.result
}

async fn create_campaign(
    client: &mut BuzzTestClient,
    actor: &Keys,
    relay: nostr::PublicKey,
) -> Uuid {
    let campaign_id = Uuid::new_v4();
    let result = submit_workspace_action(
        client,
        actor,
        relay,
        DiscoveryWorkspaceActionPayload::CreateCampaign {
            campaign: Box::new(DiscoveryCampaignInput {
                campaign_id,
                name: "Sandton Dentists".to_owned(),
                industry_id: "healthcare".to_owned(),
                industry_name: "Healthcare".to_owned(),
                vertical_id: "dentists".to_owned(),
                vertical_name: "Dentists".to_owned(),
                query: "dentists".to_owned(),
                location: "Sandton, Johannesburg, South Africa".to_owned(),
                target: 3,
                description: Some("Dental practices serving Sandton".to_owned()),
                language: "en".to_owned(),
                region: Some("ZA".to_owned()),
                source_config: buzz_core::discovery::DiscoverySourceConfig::default(),
            }),
        },
    )
    .await;
    let DiscoveryWorkspaceResult::Campaign { campaign } = result else {
        panic!("campaign create must return the campaign projection");
    };
    assert_eq!(campaign.campaign_id, campaign_id);
    campaign_id
}

async fn start_campaign_run(
    client: &mut BuzzTestClient,
    actor: &Keys,
    relay: nostr::PublicKey,
    campaign_id: Uuid,
) -> Uuid {
    let request = DiscoveryStartRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        campaign_id,
        business_search: buzz_core::discovery::DiscoveryBusinessSearchSpec {
            query: "dentists".to_owned(),
            location: "Sandton, Johannesburg, South Africa".to_owned(),
            limit: 3,
            language: "en".to_owned(),
            region: Some("ZA".to_owned()),
        },
    };
    let event = build_discovery_start_action(relay, &request)
        .expect("valid start action")
        .sign_with_keys(actor)
        .expect("sign start action");
    let ok = client.send_event(event).await.expect("publish start");
    assert!(ok.accepted, "Discovery start rejected: {}", ok.message);
    let answer: Value = serde_json::from_str(&ok.message).expect("structured start response");
    Uuid::parse_str(
        answer
            .get("run")
            .and_then(|run| run.get("run_id"))
            .and_then(Value::as_str)
            .expect("start run id"),
    )
    .expect("valid start run id")
}

async fn start_run(client: &mut BuzzTestClient, actor: &Keys, relay: nostr::PublicKey) -> Uuid {
    let campaign_id = create_campaign(client, actor, relay).await;
    start_campaign_run(client, actor, relay, campaign_id).await
}

#[tokio::test]
#[ignore = "requires isolated Postgres, Redis, and relay with external Discovery workers enabled"]
async fn generic_agent_and_desktop_worker_share_the_discovery_primitive() {
    let _test_guard = DISCOVERY_E2E_LOCK.lock().await;
    const LOCAL_CREDENTIAL_SENTINEL: &str = "agent-local-provider-key-never-signed";
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://buzz:buzz_dev@localhost:5471/buzz".to_owned());
    let pool = sqlx::PgPool::connect(&database_url)
        .await
        .expect("connect isolated Postgres");
    let host = buzz_core::tenant::relay_url_authority(&relay_url());
    let community_id: Uuid = sqlx::query("SELECT id FROM communities WHERE lower(host)=lower($1)")
        .bind(&host)
        .fetch_one(&pool)
        .await
        .expect("isolated community exists")
        .try_get("id")
        .expect("community UUID");
    let agent = Keys::generate();
    let desktop_worker = Keys::generate();
    provision_member(&pool, community_id, &agent).await;
    provision_member(&pool, community_id, &desktop_worker).await;
    sqlx::query(
        "UPDATE users SET agent_owner_pubkey=$3 \
         WHERE community_id=$1 AND pubkey=$2",
    )
    .bind(community_id)
    .bind(agent.public_key().to_bytes().as_slice())
    .bind(desktop_worker.public_key().to_bytes().as_slice())
    .execute(&pool)
    .await
    .expect("link generic agent to its desktop owner");
    sqlx::query(
        "INSERT INTO discovery_actor_grants \
         (community_id,actor_pubkey,capability,granted_by,active) \
         VALUES ($1,$2,'discovery.run',$3,TRUE)",
    )
    .bind(community_id)
    .bind(agent.public_key().to_bytes().as_slice())
    .bind(desktop_worker.public_key().to_bytes().as_slice())
    .execute(&pool)
    .await
    .expect("grant generic agent Discovery capability");
    sqlx::query(
        "INSERT INTO discovery_entitlements (community_id,active,updated_at) \
         VALUES ($1,TRUE,now()) ON CONFLICT (community_id) \
         DO UPDATE SET active=TRUE,updated_at=now()",
    )
    .bind(community_id)
    .execute(&pool)
    .await
    .expect("enable entitlement");
    let relay = relay_pubkey().await;
    let mut agent_client = BuzzTestClient::connect(&relay_url(), &agent)
        .await
        .expect("authenticate generic agent");
    let mut worker_client = BuzzTestClient::connect(&relay_url(), &desktop_worker)
        .await
        .expect("authenticate desktop worker");

    let campaign_id = create_campaign(&mut agent_client, &agent, relay).await;
    let source_config = DiscoverySourceConfig {
        mode: DiscoverySourceMode::Concurrent,
        sources: vec![
            DiscoverySource::BraveSearch,
            DiscoverySource::ExaSearch,
            DiscoverySource::GoogleMaps,
        ],
    };
    let updated = submit_workspace_action(
        &mut agent_client,
        &agent,
        relay,
        DiscoveryWorkspaceActionPayload::UpdateCampaignSources {
            campaign_id,
            source_config: source_config.clone(),
        },
    )
    .await;
    let DiscoveryWorkspaceResult::Campaign { campaign } = updated else {
        panic!("source update must return the campaign projection");
    };
    assert_eq!(campaign.source_config, source_config);

    let run_id = start_campaign_run(&mut agent_client, &agent, relay, campaign_id).await;
    let incompatible = submit_worker_action(
        &mut worker_client,
        &desktop_worker,
        relay,
        build_discovery_worker_claim_action(
            relay,
            &DiscoveryWorkerClaimRequest {
                request_id: Uuid::new_v4(),
                idempotency_key: Uuid::new_v4(),
                worker_id: Uuid::new_v4(),
                available_providers: vec![
                    DiscoveryProvider::BraveSearch,
                    DiscoveryProvider::ExaSearch,
                ],
            },
        )
        .expect("incompatible worker claim builder"),
    )
    .await;
    assert!(matches!(
        incompatible.receipt.outcome,
        DiscoveryWorkerReceiptOutcome::Idle
    ));

    let capable_worker_id = Uuid::new_v4();
    let capable = submit_worker_action(
        &mut worker_client,
        &desktop_worker,
        relay,
        build_discovery_worker_claim_action(
            relay,
            &DiscoveryWorkerClaimRequest {
                request_id: Uuid::new_v4(),
                idempotency_key: Uuid::new_v4(),
                worker_id: capable_worker_id,
                available_providers: vec![
                    DiscoveryProvider::Outscraper,
                    DiscoveryProvider::BraveSearch,
                    DiscoveryProvider::ExaSearch,
                ],
            },
        )
        .expect("capable worker claim builder"),
    )
    .await;
    let DiscoveryWorkerReceiptOutcome::Lease(lease) = capable.receipt.outcome else {
        panic!("worker with every selected provider must receive the agent-started run");
    };
    assert_eq!(lease.worker_id, capable_worker_id);
    assert_eq!(lease.run.run_id, run_id);
    assert_eq!(lease.source_config, source_config);
    assert_eq!(
        lease
            .source_states
            .iter()
            .map(|source| source.source)
            .collect::<Vec<_>>(),
        source_config.sources
    );

    let projected = submit_workspace_action(
        &mut agent_client,
        &agent,
        relay,
        DiscoveryWorkspaceActionPayload::GetCampaign { campaign_id },
    )
    .await;
    let DiscoveryWorkspaceResult::Campaign { campaign } = projected else {
        panic!("campaign read must return the UI projection");
    };
    assert_eq!(
        campaign.latest_run.as_ref().map(|run| run.run_id),
        Some(run_id)
    );
    assert_eq!(
        campaign
            .latest_run_sources
            .iter()
            .map(|source| source.source)
            .collect::<Vec<_>>(),
        source_config.sources
    );

    let cancel = DiscoveryRunRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        run_id,
    };
    let cancelled = agent_client
        .send_event(
            build_discovery_cancel_action(relay, &cancel)
                .expect("cancel builder")
                .sign_with_keys(&agent)
                .expect("sign cancel"),
        )
        .await
        .expect("cancel agent-started run");
    assert!(cancelled.accepted, "cancel rejected: {}", cancelled.message);
    let after_cancel = submit_workspace_action(
        &mut agent_client,
        &agent,
        relay,
        DiscoveryWorkspaceActionPayload::GetCampaign { campaign_id },
    )
    .await;
    let DiscoveryWorkspaceResult::Campaign { campaign } = after_cancel else {
        panic!("campaign read after cancel must return the UI projection");
    };
    assert_eq!(
        campaign.latest_run.as_ref().map(|run| run.state),
        Some(DiscoveryRunState::Cancelled)
    );
    assert!(campaign.latest_run_sources.iter().all(|source| {
        source.status == buzz_core::discovery_worker::DiscoveryRunSourceStatus::Cancelled
    }));

    let leaked_credentials: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM events WHERE community_id=$1 AND pubkey=$2 AND kind=$3 \
         AND (content LIKE '%' || $4 || '%' OR content ILIKE '%api_key%' \
              OR content ILIKE '%authorization%')",
    )
    .bind(community_id)
    .bind(agent.public_key().to_bytes().as_slice())
    .bind(i64::from(KIND_DISCOVERY_WORKSPACE_ACTION))
    .bind(LOCAL_CREDENTIAL_SENTINEL)
    .fetch_one(&pool)
    .await
    .expect("scan signed agent actions for provider credentials");
    assert_eq!(leaked_credentials, 0);
}

#[tokio::test]
#[ignore = "requires the isolated Postgres, Redis, and relay harness with fake Discovery enabled"]
async fn entitled_human_gets_private_relay_signed_receipt() {
    let _test_guard = DISCOVERY_E2E_LOCK.lock().await;
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://buzz:buzz_dev@localhost:5471/buzz".to_owned());
    let pool = sqlx::PgPool::connect(&database_url)
        .await
        .expect("connect isolated Postgres");
    let host = buzz_core::tenant::relay_url_authority(&relay_url());
    let community_id: Uuid = sqlx::query("SELECT id FROM communities WHERE lower(host)=lower($1)")
        .bind(&host)
        .fetch_one(&pool)
        .await
        .expect("isolated community exists")
        .try_get("id")
        .expect("community UUID");

    let actor = Keys::generate();
    let foreign = Keys::generate();
    provision_member(&pool, community_id, &actor).await;
    provision_member(&pool, community_id, &foreign).await;
    sqlx::query(
        "INSERT INTO discovery_entitlements (community_id,active,updated_at) \
         VALUES ($1,TRUE,now()) ON CONFLICT (community_id) \
         DO UPDATE SET active=TRUE,updated_at=now()",
    )
    .bind(community_id)
    .execute(&pool)
    .await
    .expect("enable isolated entitlement");

    let info: Value = reqwest::Client::new()
        .get(relay_http_url())
        .header("Accept", "application/nostr+json")
        .send()
        .await
        .expect("fetch NIP-11")
        .json()
        .await
        .expect("parse NIP-11");
    let relay = nostr::PublicKey::parse(
        info.get("self")
            .and_then(Value::as_str)
            .expect("NIP-11 self key"),
    )
    .expect("valid relay pubkey");

    let mut actor_client = BuzzTestClient::connect(&relay_url(), &actor)
        .await
        .expect("authenticate actor");
    sqlx::query(
        "UPDATE discovery_entitlements \
         SET active=TRUE,expires_at=now() - interval '1 second',updated_at=now() \
         WHERE community_id=$1",
    )
    .bind(community_id)
    .execute(&pool)
    .await
    .expect("begin with expired trial");
    let access_request = DiscoveryWorkspaceRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        payload: DiscoveryWorkspaceActionPayload::Access,
    };
    let access_event = build_discovery_workspace_action(relay, &access_request)
        .expect("access action")
        .sign_with_keys(&actor)
        .expect("sign access action");
    let access_action_id = access_event.id;
    let access_ok = actor_client
        .send_event(access_event)
        .await
        .expect("publish inactive access read");
    assert!(
        access_ok.accepted,
        "access read rejected: {}",
        access_ok.message
    );
    let access_answer: Value =
        serde_json::from_str(&access_ok.message).expect("structured access response");
    let access_receipt_id = EventId::from_hex(
        access_answer
            .get("receipt_event_id")
            .and_then(Value::as_str)
            .expect("access receipt id"),
    )
    .expect("valid access receipt id");
    let p_tag = SingleLetterTag::lowercase(Alphabet::P);
    actor_client
        .subscribe(
            "inactive-access-receipt",
            vec![Filter::new()
                .kind(Kind::Custom(KIND_DISCOVERY_WORKSPACE_RECEIPT as u16))
                .id(access_receipt_id)
                .event(access_action_id)
                .custom_tags(p_tag, [actor.public_key().to_hex()])],
        )
        .await
        .expect("subscribe to inactive access receipt");
    let access_receipts = actor_client
        .collect_until_eose("inactive-access-receipt", Duration::from_secs(5))
        .await
        .expect("collect inactive access receipt");
    let parsed_access = parse_discovery_workspace_receipt(
        access_receipts
            .first()
            .expect("inactive access receipt exists"),
    )
    .expect("strict inactive access receipt");
    assert!(matches!(
        parsed_access.receipt.result,
        DiscoveryWorkspaceResult::Access { active: false }
    ));
    sqlx::query(
        "UPDATE discovery_entitlements SET active=TRUE,expires_at=NULL,updated_at=now() \
         WHERE community_id=$1",
    )
    .bind(community_id)
    .execute(&pool)
    .await
    .expect("activate entitlement after access proof");
    let campaign_id = create_campaign(&mut actor_client, &actor, relay).await;
    let request = DiscoveryStartRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        campaign_id,
        business_search: buzz_core::discovery::DiscoveryBusinessSearchSpec {
            query: "dentists".to_owned(),
            location: "Sandton, Johannesburg, South Africa".to_owned(),
            limit: 3,
            language: "en".to_owned(),
            region: Some("ZA".to_owned()),
        },
    };
    let event = build_discovery_start_action(relay, &request)
        .expect("valid start action")
        .sign_with_keys(&actor)
        .expect("sign start action");
    let ok = actor_client
        .send_event(event)
        .await
        .expect("publish Discovery start");
    assert!(ok.accepted, "Discovery start rejected: {}", ok.message);
    let answer: Value = serde_json::from_str(&ok.message).expect("structured OK message");
    let receipt_id = EventId::from_hex(
        answer
            .get("receipt_event_id")
            .and_then(Value::as_str)
            .expect("receipt event id"),
    )
    .expect("valid receipt event id");

    let p_tag = SingleLetterTag::lowercase(Alphabet::P);
    let own_filter = Filter::new()
        .kind(Kind::Custom(KIND_DISCOVERY_RECEIPT as u16))
        .id(receipt_id)
        .custom_tags(p_tag, [actor.public_key().to_hex()]);
    actor_client
        .subscribe("own-discovery-receipt", vec![own_filter])
        .await
        .expect("subscribe to own receipt");
    let receipts = actor_client
        .collect_until_eose("own-discovery-receipt", Duration::from_secs(5))
        .await
        .expect("collect own receipt");
    assert_eq!(receipts.len(), 1);
    receipts[0].verify().expect("receipt signature");
    assert_eq!(receipts[0].pubkey, relay);
    let parsed = parse_discovery_receipt(&receipts[0]).expect("strict Discovery receipt");
    assert_eq!(parsed.actor_pubkey, actor.public_key());
    let run_id = parsed.receipt.run.run_id;
    assert!(matches!(
        parsed.receipt.run.state,
        DiscoveryRunState::Queued | DiscoveryRunState::Running | DiscoveryRunState::Succeeded
    ));

    let mut foreign_client = BuzzTestClient::connect(&relay_url(), &foreign)
        .await
        .expect("authenticate foreign member");
    let foreign_filter = Filter::new()
        .kind(Kind::Custom(KIND_DISCOVERY_RECEIPT as u16))
        .id(receipt_id)
        .custom_tags(p_tag, [actor.public_key().to_hex()]);
    foreign_client
        .subscribe("foreign-discovery-receipt", vec![foreign_filter])
        .await
        .expect("send foreign subscription");
    match foreign_client
        .recv_event(Duration::from_secs(5))
        .await
        .expect("relay answers foreign receipt query")
    {
        RelayMessage::Closed { message, .. } => {
            assert!(
                message.starts_with("restricted:"),
                "unexpected close: {message}"
            );
        }
        other => panic!("foreign receipt query must close, got {other:?}"),
    }

    let cancel = DiscoveryRunRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        run_id,
    };
    let event = build_discovery_cancel_action(relay, &cancel)
        .expect("cancel builder")
        .sign_with_keys(&actor)
        .expect("sign cleanup cancel");
    let cleanup = actor_client
        .send_event(event)
        .await
        .expect("cleanup Discovery run");
    assert!(
        cleanup.accepted,
        "cleanup cancel rejected: {}",
        cleanup.message
    );

    sqlx::query(
        "UPDATE discovery_entitlements SET active=FALSE,updated_at=now() WHERE community_id=$1",
    )
    .bind(community_id)
    .execute(&pool)
    .await
    .expect("revoke entitlement before retained-record read");
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
                limit: 25,
            },
        },
    };
    let list_event = build_discovery_workspace_action(relay, &list_request)
        .expect("list Leads action")
        .sign_with_keys(&actor)
        .expect("sign list Leads action");
    match actor_client.send_event(list_event).await {
        Ok(answer) => assert!(
            !answer.accepted,
            "inactive workspace must not read retained Leads"
        ),
        Err(error) => assert!(
            error.to_string().contains("restricted") || error.to_string().contains("subscription"),
            "unexpected inactive list error: {error}"
        ),
    }
}

#[tokio::test]
#[ignore = "requires the isolated Postgres, Redis, and relay harness with fake Discovery enabled"]
async fn lead_counts_aggregate_retained_businesses() {
    let _test_guard = DISCOVERY_E2E_LOCK.lock().await;
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://buzz:buzz_dev@localhost:5471/buzz".to_owned());
    let pool = sqlx::PgPool::connect(&database_url)
        .await
        .expect("connect isolated Postgres");
    let host = buzz_core::tenant::relay_url_authority(&relay_url());
    let community_id: Uuid = sqlx::query("SELECT id FROM communities WHERE lower(host)=lower($1)")
        .bind(&host)
        .fetch_one(&pool)
        .await
        .expect("isolated community exists")
        .try_get("id")
        .expect("community UUID");
    let actor = Keys::generate();
    provision_member(&pool, community_id, &actor).await;
    sqlx::query(
        "INSERT INTO discovery_entitlements (community_id,active,updated_at) \
         VALUES ($1,TRUE,now()) ON CONFLICT (community_id) \
         DO UPDATE SET active=TRUE,updated_at=now()",
    )
    .bind(community_id)
    .execute(&pool)
    .await
    .expect("enable entitlement");
    let relay = relay_pubkey().await;
    let mut client = BuzzTestClient::connect(&relay_url(), &actor)
        .await
        .expect("authenticate actor");
    let campaign_id = create_campaign(&mut client, &actor, relay).await;
    let run_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO discovery_runs \
         (community_id,id,campaign_id,requested_by,start_idempotency_key,state,total_steps) \
         VALUES ($1,$2,$3,$4,$5,'succeeded',4)",
    )
    .bind(community_id)
    .bind(run_id)
    .bind(campaign_id)
    .bind(actor.public_key().to_bytes().as_slice())
    .bind(Uuid::new_v4())
    .execute(&pool)
    .await
    .expect("insert succeeded run");
    for (name, provider_record_id) in [
        ("Sandton Dental One", "maps:dentist-1"),
        ("Sandton Dental Two", "maps:dentist-2"),
    ] {
        sqlx::query(
            "INSERT INTO discovery_business_observations \
             (community_id,id,first_run_id,provider,provider_record_id,name,observation_fingerprint) \
             VALUES ($1,$2,$3,'outscraper',$4,$5,decode(repeat('ab',32),'hex'))",
        )
        .bind(community_id)
        .bind(Uuid::new_v4())
        .bind(run_id)
        .bind(provider_record_id)
        .bind(name)
        .execute(&pool)
        .await
        .expect("insert retained observation");
    }
    let result = submit_workspace_action(
        &mut client,
        &actor,
        relay,
        DiscoveryWorkspaceActionPayload::ListLeadCounts,
    )
    .await;
    let DiscoveryWorkspaceResult::LeadCounts { counts } = result else {
        panic!("lead counts must return the counts projection");
    };
    assert_eq!(counts.total, 2);
    let healthcare = counts
        .industries
        .iter()
        .find(|row| row.industry_id == "healthcare")
        .expect("healthcare industry count");
    assert_eq!(healthcare.count, 2);
    let dentists = counts
        .verticals
        .iter()
        .find(|row| row.vertical_id.as_deref() == Some("dentists"))
        .expect("dentists vertical count");
    assert_eq!(dentists.count, 2);
}

#[tokio::test]
#[ignore = "requires the isolated Postgres, Redis, and relay harness"]
async fn lead_update_persists_and_rejects_illegal_transitions() {
    let _test_guard = DISCOVERY_E2E_LOCK.lock().await;
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://buzz:buzz_dev@localhost:5471/buzz".to_owned());
    let pool = sqlx::PgPool::connect(&database_url)
        .await
        .expect("connect isolated Postgres");
    let host = buzz_core::tenant::relay_url_authority(&relay_url());
    let community_id: Uuid = sqlx::query("SELECT id FROM communities WHERE lower(host)=lower($1)")
        .bind(&host)
        .fetch_one(&pool)
        .await
        .expect("isolated community exists")
        .try_get("id")
        .expect("community UUID");
    let actor = Keys::generate();
    provision_member(&pool, community_id, &actor).await;
    sqlx::query(
        "INSERT INTO discovery_entitlements (community_id,active,updated_at) \
         VALUES ($1,TRUE,now()) ON CONFLICT (community_id) \
         DO UPDATE SET active=TRUE,updated_at=now()",
    )
    .bind(community_id)
    .execute(&pool)
    .await
    .expect("enable entitlement");
    let relay = relay_pubkey().await;
    let mut client = BuzzTestClient::connect(&relay_url(), &actor)
        .await
        .expect("authenticate actor");
    let campaign_id = create_campaign(&mut client, &actor, relay).await;
    let run_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO discovery_runs \
         (community_id,id,campaign_id,requested_by,start_idempotency_key,state,total_steps) \
         VALUES ($1,$2,$3,$4,$5,'succeeded',4)",
    )
    .bind(community_id)
    .bind(run_id)
    .bind(campaign_id)
    .bind(actor.public_key().to_bytes().as_slice())
    .bind(Uuid::new_v4())
    .execute(&pool)
    .await
    .expect("insert succeeded run");
    let lead_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO discovery_business_observations \
         (community_id,id,first_run_id,provider,provider_record_id,name,observation_fingerprint) \
         VALUES ($1,$2,$3,'outscraper','maps:dentist-update',\
                 'Sandton Dental Update',decode(repeat('cd',32),'hex'))",
    )
    .bind(community_id)
    .bind(lead_id)
    .bind(run_id)
    .execute(&pool)
    .await
    .expect("insert retained observation");

    let result = submit_workspace_action(
        &mut client,
        &actor,
        relay,
        DiscoveryWorkspaceActionPayload::GetLead { lead_id },
    )
    .await;
    let DiscoveryWorkspaceResult::Lead { lead } = result else {
        panic!("get lead must return the detail projection");
    };
    assert_eq!(lead.status, DiscoveryLeadStatus::Candidate);

    let result = submit_workspace_action(
        &mut client,
        &actor,
        relay,
        DiscoveryWorkspaceActionPayload::UpdateLead {
            lead_id,
            input: DiscoveryLeadUpdateInput {
                website: Some("https://update.example".into()),
                email: None,
                phone: None,
                linkedin_url: None,
                contact_name: None,
                contact_title: None,
                notes: Some("Warm intro".into()),
                score: Some(82),
                owner_persona_id: Some("chief-of-staff".into()),
                status: Some(DiscoveryLeadStatus::Accepted),
            },
        },
    )
    .await;
    let DiscoveryWorkspaceResult::Lead { lead } = result else {
        panic!("update lead must return the detail projection");
    };
    assert_eq!(lead.status, DiscoveryLeadStatus::Accepted);
    assert_eq!(lead.notes.as_deref(), Some("Warm intro"));
    assert_eq!(lead.score, Some(82));
    assert_eq!(
        lead.website_override.as_deref(),
        Some("https://update.example")
    );

    let result = submit_workspace_action(
        &mut client,
        &actor,
        relay,
        DiscoveryWorkspaceActionPayload::ListLeads {
            request: DiscoveryLeadListRequest {
                campaign_id: None,
                industry_id: None,
                vertical_id: None,
                status: Some(DiscoveryLeadStatus::Accepted),
                offset: 0,
                limit: 25,
            },
        },
    )
    .await;
    let DiscoveryWorkspaceResult::Leads { page } = result else {
        panic!("list leads must return the page projection");
    };
    assert_eq!(page.total, 1);
    assert_eq!(page.leads[0].lead_id, lead_id);

    let result = submit_workspace_action(
        &mut client,
        &actor,
        relay,
        DiscoveryWorkspaceActionPayload::UpdateLead {
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
                status: Some(DiscoveryLeadStatus::Disqualified),
            },
        },
    )
    .await;
    let DiscoveryWorkspaceResult::Lead { lead } = result else {
        panic!("disqualify must return the detail projection");
    };
    assert_eq!(lead.status, DiscoveryLeadStatus::Disqualified);

    let refused = DiscoveryWorkspaceRequest {
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
                status: Some(DiscoveryLeadStatus::Accepted),
            },
        },
    };
    let refused_event = build_discovery_workspace_action(relay, &refused)
        .expect("build illegal transition")
        .sign_with_keys(&actor)
        .expect("sign illegal transition");
    match client.send_event(refused_event).await {
        Ok(answer) => assert!(!answer.accepted, "disqualified -> accepted must be refused"),
        Err(error) => assert!(
            error.to_string().contains("not allowed") || error.to_string().contains("restricted"),
            "unexpected illegal transition error: {error}"
        ),
    }
}

#[tokio::test]
#[ignore = "requires isolated Postgres, Redis, and relay with external Discovery workers enabled"]
async fn local_worker_is_restart_safe_private_and_fenced() {
    let _test_guard = DISCOVERY_E2E_LOCK.lock().await;
    const LOCAL_SECRET: &str = "outscraper-secret-never-crosses-relay";
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://buzz:buzz_dev@localhost:5471/buzz".to_owned());
    let pool = sqlx::PgPool::connect(&database_url)
        .await
        .expect("connect isolated Postgres");
    let host = buzz_core::tenant::relay_url_authority(&relay_url());
    let community_id: Uuid = sqlx::query("SELECT id FROM communities WHERE lower(host)=lower($1)")
        .bind(&host)
        .fetch_one(&pool)
        .await
        .expect("isolated community exists")
        .try_get("id")
        .expect("community UUID");
    let actor = Keys::generate();
    let foreign = Keys::generate();
    provision_member(&pool, community_id, &actor).await;
    provision_member(&pool, community_id, &foreign).await;
    sqlx::query(
        "INSERT INTO discovery_entitlements (community_id,active,updated_at) \
         VALUES ($1,TRUE,now()) ON CONFLICT (community_id) \
         DO UPDATE SET active=TRUE,updated_at=now()",
    )
    .bind(community_id)
    .execute(&pool)
    .await
    .expect("enable entitlement");
    let relay = relay_pubkey().await;
    let mut actor_client = BuzzTestClient::connect(&relay_url(), &actor)
        .await
        .expect("authenticate actor");

    let first_run = start_run(&mut actor_client, &actor, relay).await;
    let worker_a = Uuid::new_v4();
    let claim_a = DiscoveryWorkerClaimRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        worker_id: worker_a,
        available_providers: vec![DiscoveryProvider::Outscraper],
    };
    let claimed_a = submit_worker_action(
        &mut actor_client,
        &actor,
        relay,
        build_discovery_worker_claim_action(relay, &claim_a).expect("claim builder"),
    )
    .await;
    let DiscoveryWorkerReceiptOutcome::Lease(lease_a) = claimed_a.receipt.outcome else {
        panic!("worker A must receive a lease");
    };
    assert_eq!(lease_a.run.run_id, first_run);
    assert_eq!(lease_a.attempt, 1);
    let provider_request_id = format!("outscraper_req_{}", Uuid::new_v4().simple());

    let submitted = DiscoveryWorkerCheckpointRequest {
        lease: DiscoveryWorkerLeaseRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            worker_id: worker_a,
            run_id: first_run,
            lease_id: lease_a.lease_id,
        },
        checkpoint: DiscoveryWorkerCheckpoint {
            sequence: 1,
            kind: DiscoveryCheckpointKind::ProviderSubmitted,
            provider: DiscoveryProvider::Outscraper,
            provider_request_id: Some(provider_request_id.clone()),
            item_count: None,
        },
    };
    let checkpoint_a = submit_worker_action(
        &mut actor_client,
        &actor,
        relay,
        build_discovery_worker_checkpoint_action(relay, &submitted).expect("checkpoint builder"),
    )
    .await;
    assert!(matches!(
        checkpoint_a.receipt.outcome,
        DiscoveryWorkerReceiptOutcome::Lease(_)
    ));

    tokio::time::sleep(Duration::from_secs(6)).await;
    let worker_b = Uuid::new_v4();
    let claim_b = DiscoveryWorkerClaimRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        worker_id: worker_b,
        available_providers: vec![DiscoveryProvider::Outscraper],
    };
    let claimed_b = submit_worker_action(
        &mut actor_client,
        &actor,
        relay,
        build_discovery_worker_claim_action(relay, &claim_b).expect("reclaim builder"),
    )
    .await;
    let DiscoveryWorkerReceiptOutcome::Lease(lease_b) = claimed_b.receipt.outcome else {
        panic!("worker B must reclaim the run");
    };
    assert_eq!(lease_b.run.run_id, first_run);
    assert_eq!(lease_b.attempt, 2);
    assert_eq!(
        lease_b
            .last_checkpoint
            .as_ref()
            .and_then(|value| value.provider_request_id.as_deref()),
        Some(provider_request_id.as_str())
    );

    let stale = DiscoveryWorkerCheckpointRequest {
        lease: DiscoveryWorkerLeaseRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            worker_id: worker_a,
            run_id: first_run,
            lease_id: lease_a.lease_id,
        },
        checkpoint: DiscoveryWorkerCheckpoint {
            sequence: 2,
            kind: DiscoveryCheckpointKind::ProviderResultsReady,
            provider: DiscoveryProvider::Outscraper,
            provider_request_id: None,
            item_count: Some(10),
        },
    };
    let stale_result = submit_worker_action(
        &mut actor_client,
        &actor,
        relay,
        build_discovery_worker_checkpoint_action(relay, &stale).expect("stale builder"),
    )
    .await;
    assert!(matches!(
        stale_result.receipt.outcome,
        DiscoveryWorkerReceiptOutcome::LostLease(_)
    ));

    let cancel = DiscoveryRunRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        run_id: first_run,
    };
    let cancel_event = build_discovery_cancel_action(relay, &cancel)
        .expect("cancel builder")
        .sign_with_keys(&actor)
        .expect("sign cancel");
    let cancelled = actor_client
        .send_event(cancel_event)
        .await
        .expect("cancel run");
    assert!(cancelled.accepted, "cancel rejected: {}", cancelled.message);
    let heartbeat_after_cancel = DiscoveryWorkerLeaseRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        worker_id: worker_b,
        run_id: first_run,
        lease_id: lease_b.lease_id,
    };
    let cancelled_heartbeat = submit_worker_action(
        &mut actor_client,
        &actor,
        relay,
        build_discovery_worker_heartbeat_action(relay, &heartbeat_after_cancel)
            .expect("cancelled heartbeat builder"),
    )
    .await;
    assert!(matches!(
        cancelled_heartbeat.receipt.outcome,
        DiscoveryWorkerReceiptOutcome::LostLease(_)
    ));

    let second_run = start_run(&mut actor_client, &actor, relay).await;
    let claimed_c = submit_worker_action(
        &mut actor_client,
        &actor,
        relay,
        build_discovery_worker_claim_action(
            relay,
            &DiscoveryWorkerClaimRequest {
                request_id: Uuid::new_v4(),
                idempotency_key: Uuid::new_v4(),
                worker_id: worker_b,
                available_providers: vec![DiscoveryProvider::Outscraper],
            },
        )
        .expect("second claim builder"),
    )
    .await;
    let DiscoveryWorkerReceiptOutcome::Lease(lease_c) = claimed_c.receipt.outcome else {
        panic!("second run must be leased");
    };
    assert_eq!(lease_c.run.run_id, second_run);
    sqlx::query(
        "UPDATE discovery_entitlements SET active=FALSE,updated_at=now() WHERE community_id=$1",
    )
    .bind(community_id)
    .execute(&pool)
    .await
    .expect("revoke entitlement");
    sqlx::query(
        "UPDATE discovery_runs SET state='cancelled',cancel_requested=TRUE, \
         terminal_reason='entitlement_revoked',claim_id=NULL,lease_until=NULL, \
         worker_id=NULL,lease_owner_pubkey=NULL,updated_at=now() \
         WHERE community_id=$1 AND state IN ('queued','running')",
    )
    .bind(community_id)
    .execute(&pool)
    .await
    .expect("apply revocation stop as entitlement authority");
    let revoked_event = build_discovery_worker_heartbeat_action(
        relay,
        &DiscoveryWorkerLeaseRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            worker_id: worker_b,
            run_id: second_run,
            lease_id: lease_c.lease_id,
        },
    )
    .expect("revoked heartbeat builder")
    .sign_with_keys(&actor)
    .expect("sign revoked heartbeat");
    match actor_client.send_event(revoked_event).await {
        Ok(answer) => assert!(!answer.accepted, "revoked worker action must be rejected"),
        Err(error) => assert!(
            error.to_string().contains("subscription") || error.to_string().contains("restricted"),
            "unexpected revoke error: {error}"
        ),
    }

    sqlx::query(
        "UPDATE discovery_entitlements SET active=TRUE,updated_at=now() WHERE community_id=$1",
    )
    .bind(community_id)
    .execute(&pool)
    .await
    .expect("restore entitlement");
    let third_run = start_run(&mut actor_client, &actor, relay).await;
    let claimed_d = submit_worker_action(
        &mut actor_client,
        &actor,
        relay,
        build_discovery_worker_claim_action(
            relay,
            &DiscoveryWorkerClaimRequest {
                request_id: Uuid::new_v4(),
                idempotency_key: Uuid::new_v4(),
                worker_id: worker_b,
                available_providers: vec![DiscoveryProvider::Outscraper],
            },
        )
        .expect("third claim builder"),
    )
    .await;
    let private_receipt_id = claimed_d.event_id;
    let DiscoveryWorkerReceiptOutcome::Lease(lease_d) = claimed_d.receipt.outcome else {
        panic!("third run must be leased");
    };
    assert_eq!(lease_d.run.run_id, third_run);
    let live_lease = DiscoveryWorkerLeaseRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        worker_id: worker_b,
        run_id: third_run,
        lease_id: lease_d.lease_id,
    };
    let heartbeat = submit_worker_action(
        &mut actor_client,
        &actor,
        relay,
        build_discovery_worker_heartbeat_action(relay, &live_lease).expect("heartbeat builder"),
    )
    .await;
    assert!(matches!(
        heartbeat.receipt.outcome,
        DiscoveryWorkerReceiptOutcome::Lease(_)
    ));
    let source_started = submit_worker_action(
        &mut actor_client,
        &actor,
        relay,
        build_discovery_worker_source_progress_action(
            relay,
            &DiscoveryWorkerSourceProgressRequest {
                lease: DiscoveryWorkerLeaseRequest {
                    request_id: Uuid::new_v4(),
                    idempotency_key: Uuid::new_v4(),
                    ..live_lease.clone()
                },
                provider: DiscoveryProvider::Outscraper,
                status: DiscoveryRunSourceStatus::Active,
                request_cursor: None,
                request_count: 0,
                returned_count: 0,
                failure_class: None,
            },
        )
        .expect("source start builder"),
    )
    .await;
    assert!(matches!(
        source_started.receipt.outcome,
        DiscoveryWorkerReceiptOutcome::Lease(_)
    ));
    let source_finished = submit_worker_action(
        &mut actor_client,
        &actor,
        relay,
        build_discovery_worker_source_progress_action(
            relay,
            &DiscoveryWorkerSourceProgressRequest {
                lease: DiscoveryWorkerLeaseRequest {
                    request_id: Uuid::new_v4(),
                    idempotency_key: Uuid::new_v4(),
                    ..live_lease.clone()
                },
                provider: DiscoveryProvider::Outscraper,
                status: DiscoveryRunSourceStatus::Exhausted,
                request_cursor: None,
                request_count: 1,
                returned_count: 0,
                failure_class: None,
            },
        )
        .expect("source progress builder"),
    )
    .await;
    assert!(matches!(
        source_finished.receipt.outcome,
        DiscoveryWorkerReceiptOutcome::Lease(_)
    ));
    let completed = submit_worker_action(
        &mut actor_client,
        &actor,
        relay,
        build_discovery_worker_complete_action(
            relay,
            &DiscoveryWorkerLeaseRequest {
                request_id: Uuid::new_v4(),
                idempotency_key: Uuid::new_v4(),
                ..live_lease
            },
        )
        .expect("complete builder"),
    )
    .await;
    assert!(matches!(
        completed.receipt.outcome,
        DiscoveryWorkerReceiptOutcome::Completed(_)
    ));

    let leaked_events: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM events WHERE community_id=$1 AND content LIKE '%' || $2 || '%'",
    )
    .bind(community_id)
    .bind(LOCAL_SECRET)
    .fetch_one(&pool)
    .await
    .expect("scan event content");
    let leaked_checkpoints: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM discovery_run_checkpoints \
         WHERE community_id=$1 AND provider_request_id LIKE '%' || $2 || '%'",
    )
    .bind(community_id)
    .bind(LOCAL_SECRET)
    .fetch_one(&pool)
    .await
    .expect("scan checkpoint content");
    assert_eq!((leaked_events, leaked_checkpoints), (0, 0));

    let mut foreign_client = BuzzTestClient::connect(&relay_url(), &foreign)
        .await
        .expect("authenticate foreign member");
    let p_tag = SingleLetterTag::lowercase(Alphabet::P);
    let foreign_filter = Filter::new()
        .kind(Kind::Custom(KIND_DISCOVERY_WORKER_RECEIPT as u16))
        .id(private_receipt_id)
        .custom_tags(p_tag, [actor.public_key().to_hex()]);
    foreign_client
        .subscribe("foreign-worker-receipt", vec![foreign_filter])
        .await
        .expect("send foreign worker receipt query");
    assert!(matches!(
        foreign_client
            .recv_event(Duration::from_secs(5))
            .await
            .expect("foreign query response"),
        RelayMessage::Closed { .. }
    ));
}

async fn provision_member(pool: &sqlx::PgPool, community_id: Uuid, keys: &Keys) {
    let pubkey = keys.public_key().to_bytes();
    let pubkey_hex = keys.public_key().to_hex();
    sqlx::query(
        "INSERT INTO users (community_id,pubkey,display_name) VALUES ($1,$2,'Discovery E2E') \
         ON CONFLICT (community_id,pubkey) DO NOTHING",
    )
    .bind(community_id)
    .bind(pubkey.as_slice())
    .execute(pool)
    .await
    .expect("provision test user");
    sqlx::query(
        "INSERT INTO relay_members (community_id,pubkey,role) VALUES ($1,$2,'member') \
         ON CONFLICT (community_id,pubkey) DO NOTHING",
    )
    .bind(community_id)
    .bind(pubkey_hex)
    .execute(pool)
    .await
    .expect("provision test member");
}
