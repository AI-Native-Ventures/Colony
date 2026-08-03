use super::*;

#[ignore = "requires isolated Postgres, Redis, and relay with external workers enabled"]
#[tokio::test]
async fn native_host_real_relay_completes_and_recovers_after_restart() {
    use buzz_core_pkg::discovery::{DiscoveryBusinessSearchSpec, DiscoveryStartRequest};
    use buzz_core_pkg::discovery_workspace::{
        DiscoveryCampaignInput, DiscoveryLeadListRequest, DiscoveryWorkspaceActionPayload,
        DiscoveryWorkspaceRequest,
    };
    use buzz_sdk_pkg::{
        discovery::build_discovery_start_action,
        discovery_workspace::build_discovery_workspace_action,
    };
    use sqlx::Row as _;

    const FIXTURE_SECRET: &str = "native-host-secret-never-crosses-relay";
    let relay_url =
        std::env::var("RELAY_URL").unwrap_or_else(|_| "ws://localhost:3030".to_string());
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://buzz:buzz_dev@localhost:5471/buzz".to_string());
    let pool = sqlx::PgPool::connect(&database_url)
        .await
        .expect("connect isolated Postgres");
    let host = buzz_core_pkg::tenant::relay_url_authority(&relay_url);
    let community_id: Uuid = sqlx::query("SELECT id FROM communities WHERE lower(host)=lower($1)")
        .bind(&host)
        .fetch_one(&pool)
        .await
        .expect("isolated community")
        .try_get("id")
        .expect("community id");
    let actor = nostr::Keys::generate();
    let actor_bytes = actor.public_key().to_bytes();
    let actor_hex = actor.public_key().to_hex();
    sqlx::query(
        "INSERT INTO users (community_id,pubkey,display_name) \
             VALUES ($1,$2,'Native Discovery Host') \
             ON CONFLICT (community_id,pubkey) DO NOTHING",
    )
    .bind(community_id)
    .bind(actor_bytes.as_slice())
    .execute(&pool)
    .await
    .expect("provision native host user");
    sqlx::query(
        "INSERT INTO relay_members (community_id,pubkey,role) VALUES ($1,$2,'member') \
             ON CONFLICT (community_id,pubkey) DO NOTHING",
    )
    .bind(community_id)
    .bind(&actor_hex)
    .execute(&pool)
    .await
    .expect("provision native host member");
    sqlx::query(
        "INSERT INTO discovery_entitlements (community_id,active,updated_at) \
             VALUES ($1,TRUE,now()) ON CONFLICT (community_id) \
             DO UPDATE SET active=TRUE,updated_at=now()",
    )
    .bind(community_id)
    .execute(&pool)
    .await
    .expect("enable Discovery entitlement");

    let state = crate::app_state::build_app_state();
    *state.keys.lock().expect("state keys") = actor.clone();
    *state.relay_url_override.lock().expect("workspace relay") = Some(relay_url.clone());
    crate::discovery_worker::workspace_changed();
    let generation = crate::discovery_worker::workspace_generation();
    let api_base_url = relay::relay_http_base_url(&relay_url);
    let relay_pubkey = super::super::super::protocol::fetch_relay_pubkey(&state, &api_base_url)
        .await
        .expect("relay signing identity");
    let worker_id = Uuid::new_v4();
    let credential = Zeroizing::new(FIXTURE_SECRET.to_string());
    let (provider, provider_state, provider_handle) = start_local_outscraper().await;

    let actions_before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM events WHERE community_id=$1 AND kind=40019")
            .bind(community_id)
            .fetch_one(&pool)
            .await
            .expect("count worker actions before missing credential");
    let no_credential_protocol = RelayWorkerProtocol::connect(
        &state,
        actor.clone(),
        api_base_url.clone(),
        worker_id,
        generation,
    )
    .await
    .expect("missing-credential protocol");
    assert_eq!(
        run_once_with_loader(&no_credential_protocol, worker_id, Duration::ZERO, || Ok(
            None
        ),)
        .await
        .expect("missing credential outcome"),
        HostRunOutcome::NoCredential
    );
    let actions_after: i64 =
        sqlx::query_scalar("SELECT count(*) FROM events WHERE community_id=$1 AND kind=40019")
            .bind(community_id)
            .fetch_one(&pool)
            .await
            .expect("count worker actions after missing credential");
    assert_eq!(actions_before, actions_after);

    async fn start_run(
        state: &AppState,
        actor: &nostr::Keys,
        relay_pubkey: nostr::PublicKey,
        api_base_url: &str,
    ) -> (Uuid, Uuid) {
        let campaign_id = Uuid::new_v4();
        let campaign_request = DiscoveryWorkspaceRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            payload: DiscoveryWorkspaceActionPayload::CreateCampaign {
                campaign: Box::new(DiscoveryCampaignInput {
                    campaign_id,
                    name: "Sandton dentists".to_owned(),
                    industry_id: "healthcare".to_owned(),
                    industry_name: "Healthcare".to_owned(),
                    vertical_id: "dentists".to_owned(),
                    vertical_name: "Dentists".to_owned(),
                    query: "dentists".to_owned(),
                    location: "Sandton, Johannesburg, South Africa".to_owned(),
                    target: 3,
                    description: None,
                    language: "en".to_owned(),
                    region: Some("ZA".to_owned()),
                    source_config: buzz_core_pkg::discovery::DiscoverySourceConfig::default(),
                }),
            },
        };
        let campaign_response = relay::submit_event_at_with_keys(
            build_discovery_workspace_action(relay_pubkey, &campaign_request)
                .expect("Discovery campaign builder"),
            state,
            api_base_url,
            actor,
        )
        .await
        .expect("create Discovery campaign");
        assert!(campaign_response.accepted, "campaign action must commit");
        let request = DiscoveryStartRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            campaign_id,
            business_search: DiscoveryBusinessSearchSpec {
                query: "dentists".to_owned(),
                location: "Sandton, Johannesburg, South Africa".to_owned(),
                limit: 3,
                language: "en".to_owned(),
                region: Some("ZA".to_owned()),
            },
        };
        let response = relay::submit_event_at_with_keys(
            build_discovery_start_action(relay_pubkey, &request).expect("Discovery start builder"),
            state,
            api_base_url,
            actor,
        )
        .await
        .expect("start Discovery run");
        let message: serde_json::Value =
            serde_json::from_str(&response.message).expect("start response");
        let run_id = Uuid::parse_str(
            message
                .get("run")
                .and_then(|run| run.get("run_id"))
                .and_then(serde_json::Value::as_str)
                .expect("started run id"),
        )
        .expect("valid started run id");
        (run_id, campaign_id)
    }

    let (first_run, campaign_id) = start_run(&state, &actor, relay_pubkey, &api_base_url).await;
    let first_protocol = RelayWorkerProtocol::connect(
        &state,
        actor.clone(),
        api_base_url.clone(),
        worker_id,
        generation,
    )
    .await
    .expect("first native host protocol");
    let mut first_host = Box::pin(run_production_once_with_credential(
        &first_protocol,
        &provider,
        worker_id,
        &credential,
    ));
    loop {
        tokio::select! {
            result = &mut first_host => panic!("first host exited before restart point: {result:?}"),
            () = tokio::time::sleep(Duration::from_millis(50)) => {
                let submitted: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM discovery_run_checkpoints \
                     WHERE community_id=$1 AND run_id=$2 AND sequence=1",
                )
                .bind(community_id)
                .bind(first_run)
                .fetch_one(&pool)
                .await
                .expect("poll provider-submitted checkpoint");
                if submitted == 1 {
                    break;
                }
            }
        }
    }
    drop(first_host);
    provider_state
        .allow_success
        .store(true, AtomicOrdering::SeqCst);
    tokio::time::sleep(Duration::from_secs(6)).await;

    let restarted_protocol = RelayWorkerProtocol::connect(
        &state,
        actor.clone(),
        api_base_url.clone(),
        worker_id,
        generation,
    )
    .await
    .expect("restarted native host protocol");
    assert_eq!(
        run_production_once_with_credential(
            &restarted_protocol,
            &provider,
            worker_id,
            &credential,
        )
        .await
        .expect("restarted native host outcome"),
        HostRunOutcome::Completed
    );
    let run_row = sqlx::query(
        "SELECT state,attempt,completed_steps FROM discovery_runs \
             WHERE community_id=$1 AND id=$2",
    )
    .bind(community_id)
    .bind(first_run)
    .fetch_one(&pool)
    .await
    .expect("completed native run");
    assert_eq!(run_row.get::<String, _>("state"), "succeeded");
    assert_eq!(run_row.get::<i32, _>("attempt"), 2);
    assert_eq!(run_row.get::<i32, _>("completed_steps"), 1);
    let checkpoints: Vec<(i32, Option<i32>)> = sqlx::query_as(
        "SELECT sequence,item_count FROM discovery_run_checkpoints \
             WHERE community_id=$1 AND run_id=$2 ORDER BY sequence",
    )
    .bind(community_id)
    .bind(first_run)
    .fetch_all(&pool)
    .await
    .expect("native checkpoints");
    assert_eq!(checkpoints, vec![(1, None), (2, Some(3))]);
    let retained_observations: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM discovery_business_observations \
             WHERE community_id=$1 AND first_run_id=$2",
    )
    .bind(community_id)
    .bind(first_run)
    .fetch_one(&pool)
    .await
    .expect("retained local provider observations");
    assert_eq!(retained_observations, 3);
    let leads_request = DiscoveryWorkspaceRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        payload: DiscoveryWorkspaceActionPayload::ListLeads {
            request: DiscoveryLeadListRequest {
                campaign_id: Some(campaign_id),
                industry_id: None,
                vertical_id: None,
                offset: 0,
                limit: 100,
            },
        },
    };
    let leads_response = relay::submit_event_at_with_keys(
        build_discovery_workspace_action(relay_pubkey, &leads_request)
            .expect("Discovery Leads builder"),
        &state,
        &api_base_url,
        &actor,
    )
    .await
    .expect("list retained Discovery Leads");
    let leads_message: serde_json::Value =
        serde_json::from_str(&leads_response.message).expect("Leads response");
    let lead_result = leads_message.get("result").expect("private Leads result");
    assert_eq!(
        lead_result
            .get("result")
            .and_then(serde_json::Value::as_str),
        Some("leads")
    );
    assert_eq!(
        lead_result
            .get("page")
            .and_then(|page| page.get("total"))
            .and_then(serde_json::Value::as_u64),
        Some(3)
    );
    assert_eq!(
        lead_result
            .get("page")
            .and_then(|page| page.get("leads"))
            .and_then(serde_json::Value::as_array)
            .map(Vec::len),
        Some(3)
    );
    assert_eq!(
        provider_state.submit_count.load(AtomicOrdering::SeqCst),
        1,
        "restart must not submit the paid provider job twice"
    );
    assert!(provider_state.poll_count.load(AtomicOrdering::SeqCst) >= 1);
    assert!(provider_state.header_seen.load(AtomicOrdering::SeqCst));
    {
        let request_shapes = provider_state
            .request_shapes
            .lock()
            .expect("request shapes");
        assert_eq!(request_shapes.len(), 1);
        let search_request = &request_shapes[0];
        for expected in [
            "query=dentists%2C+Sandton%2C+Johannesburg%2C+South+Africa",
            "limit=3",
            "language=en",
            "region=ZA",
            "async=true",
            "fields=",
        ] {
            assert!(
                search_request.contains(expected),
                "provider request missing {expected}: {search_request}"
            );
        }
    }
    let leaked_events: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM events WHERE community_id=$1 AND content LIKE '%' || $2 || '%'",
    )
    .bind(community_id)
    .bind(FIXTURE_SECRET)
    .fetch_one(&pool)
    .await
    .expect("scan native event contents");
    let leaked_checkpoints: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM discovery_run_checkpoints WHERE community_id=$1 \
             AND coalesce(provider_request_id,'') LIKE '%' || $2 || '%'",
    )
    .bind(community_id)
    .bind(FIXTURE_SECRET)
    .fetch_one(&pool)
    .await
    .expect("scan native checkpoints");
    assert_eq!((leaked_events, leaked_checkpoints), (0, 0));
    assert!(provider_state
        .request_shapes
        .lock()
        .expect("request shapes")
        .iter()
        .all(|shape| !shape.contains(FIXTURE_SECRET)));
    provider_handle.abort();
}
