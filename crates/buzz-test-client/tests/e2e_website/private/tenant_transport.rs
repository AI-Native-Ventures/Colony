/// Dedicated relay configuration for the private-artifact proof.
///
/// The relay listens on the local HTTP address, but its configured origin is
/// HTTPS/WSS. That combination is intentional: Blossom descriptors keep the
/// public-shaped tenant origin that passes the shared preview validator, while
/// the relay's website broker resolves its own media path directly through the
/// tenant-scoped storage reader. The test must run against a relay whose
/// `WEBSITE_TENANT_HOST` community was created before relay startup so the
/// bundled website-job manifest exists for that tenant.
#[derive(Clone)]
struct PrivateWebsiteTenant {
    host: String,
    http_url: String,
    community: Uuid,
    relay_pubkey: String,
}

#[derive(Clone)]
struct PrivateWebsiteArtifact {
    url: String,
    sha256: String,
    bytes: Vec<u8>,
}

struct PrivateWebsiteFixture {
    tenant: PrivateWebsiteTenant,
    channel: String,
    task_id: String,
    thread_root: String,
    instance_id: Uuid,
    instance_event_id: String,
    manifest_event_id: String,
    coordinator: Keys,
    builder: Keys,
    reviewer: Keys,
    personas: TeamPersonas,
}

fn private_website_host() -> String {
    std::env::var("WEBSITE_TENANT_HOST")
        .unwrap_or_else(|_| "website-owner.example.com".to_owned())
}

fn private_website_http_url() -> String {
    std::env::var("WEBSITE_RELAY_HTTP_URL").unwrap_or_else(|_| http_url())
}

async fn private_website_tenant() -> PrivateWebsiteTenant {
    let host = private_website_host();
    let http_url = private_website_http_url();
    let configured_origin = relay_url();
    assert!(
        configured_origin.starts_with("wss://") || configured_origin.starts_with("https://"),
        "private website proof requires RELAY_URL with an HTTPS/WSS origin so descriptors are public-shaped HTTPS URLs; configure the dedicated relay before running this test"
    );
    let community = with_e2e_db(|pool| {
        let host = host.clone();
        async move {
            sqlx::query_scalar("SELECT id FROM communities WHERE lower(host) = lower($1)")
                .bind(&host)
                .fetch_optional(&pool)
                .await
                .expect("query private website tenant")
                .unwrap_or_else(|| {
                    panic!(
                        "private website tenant {host} must be seeded before relay startup; the bundled website-job manifest depends on that startup order"
                    )
                })
        }
    })
    .await;
    let relay_pubkey = private_website_relay_self(&http_url, &host).await;
    PrivateWebsiteTenant {
        host,
        http_url,
        community,
        relay_pubkey,
    }
}

async fn private_website_relay_self(http_url: &str, host: &str) -> String {
    let response = reqwest::Client::new()
        .get(http_url)
        .header(reqwest::header::HOST, host)
        .header("Accept", "application/nostr+json")
        .send()
        .await
        .expect("private tenant NIP-11 request");
    assert!(
        response.status().is_success(),
        "private tenant NIP-11 request failed: {}",
        response.status()
    );
    let document: serde_json::Value = response.json().await.expect("private NIP-11 JSON");
    document["self"]
        .as_str()
        .expect("private relay advertises its own pubkey")
        .to_owned()
}

async fn private_seed_member(
    tenant: &PrivateWebsiteTenant,
    keys: &Keys,
    role: &str,
    agent_owner: Option<&Keys>,
) {
    let pubkey_bytes = keys.public_key().to_bytes().to_vec();
    let pubkey_hex = keys.public_key().to_hex();
    let agent_owner = agent_owner.map(|owner| owner.public_key().to_bytes().to_vec());
    let community = tenant.community;
    with_e2e_db(|pool| async move {
        sqlx::query(
            "INSERT INTO users (community_id, pubkey, agent_owner_pubkey) VALUES ($1, $2, $3) \
             ON CONFLICT (community_id, pubkey) DO UPDATE SET agent_owner_pubkey = EXCLUDED.agent_owner_pubkey",
        )
        .bind(community)
        .bind(pubkey_bytes)
        .bind(agent_owner)
        .execute(&pool)
        .await
        .expect("seed private website user");
        sqlx::query(
            "INSERT INTO relay_members (community_id, pubkey, role, added_by) \
             VALUES ($1, $2, $3, NULL) \
             ON CONFLICT (community_id, pubkey) DO UPDATE SET role = EXCLUDED.role",
        )
        .bind(community)
        .bind(&pubkey_hex)
        .bind(role)
        .execute(&pool)
        .await
        .expect("seed private website relay member");
    })
    .await;
}

async fn private_seed_channel_member(
    tenant: &PrivateWebsiteTenant,
    channel: &str,
    keys: &Keys,
) {
    let channel_id = Uuid::parse_str(channel).expect("private channel UUID");
    let pubkey = keys.public_key().to_bytes().to_vec();
    let community = tenant.community;
    with_e2e_db(|pool| async move {
        sqlx::query(
            "INSERT INTO channel_members (community_id, channel_id, pubkey) VALUES ($1, $2, $3) \
             ON CONFLICT (community_id, channel_id, pubkey) DO NOTHING",
        )
        .bind(community)
        .bind(channel_id)
        .bind(pubkey)
        .execute(&pool)
        .await
        .expect("seed private website channel member");
    })
    .await;
}

/// Submit to the host-bound HTTP bridge. `X-Pubkey` is the existing dev/test
/// bridge authentication mode; the event remains fully signed and every
/// website transition is still authorized by the relay's Nostr actor.
async fn private_submit_event(
    tenant: &PrivateWebsiteTenant,
    signer: &Keys,
    event: &Event,
) -> (u16, serde_json::Value) {
    let response = reqwest::Client::new()
        .post(format!("{}/events", tenant.http_url.trim_end_matches('/')))
        .header(reqwest::header::HOST, &tenant.host)
        .header("X-Pubkey", signer.public_key().to_hex())
        .header("Content-Type", "application/json")
        .body(serde_json::to_vec(event).expect("private event JSON"))
        .send()
        .await
        .expect("submit private website event");
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .expect("read private website event response");
    let value = serde_json::from_str(&body)
        .unwrap_or_else(|error| panic!("parse private website response: {error}; body={body}"));
    (status, value)
}

fn private_assert_accepted((status, body): (u16, serde_json::Value), what: &str) -> String {
    assert_eq!(status, 200, "{what} returned HTTP {status}: {body}");
    assert_eq!(
        body["accepted"].as_bool(),
        Some(true),
        "{what} was rejected: {body}"
    );
    body["event_id"]
        .as_str()
        .unwrap_or_else(|| panic!("{what} did not return an event id: {body}"))
        .to_owned()
}

async fn private_query_events(
    tenant: &PrivateWebsiteTenant,
    reader: &Keys,
    filters: Vec<Filter>,
) -> Vec<Event> {
    let response = reqwest::Client::new()
        .post(format!("{}/query", tenant.http_url.trim_end_matches('/')))
        .header(reqwest::header::HOST, &tenant.host)
        .header("X-Pubkey", reader.public_key().to_hex())
        .header("Content-Type", "application/json")
        .body(serde_json::to_vec(&filters).expect("private filters JSON"))
        .send()
        .await
        .expect("query private website events");
    let status = response.status();
    let body = response
        .text()
        .await
        .expect("read private website query response");
    assert!(
        status.is_success(),
        "private website query failed with {status}: {body}"
    );
    let values: Vec<serde_json::Value> = serde_json::from_str(&body)
        .unwrap_or_else(|error| panic!("parse private website query: {error}; body={body}"));
    values
        .into_iter()
        .map(|value| {
            serde_json::from_value(value).expect("private query returns complete signed events")
        })
        .collect()
}

async fn private_event_by_id(
    tenant: &PrivateWebsiteTenant,
    reader: &Keys,
    event_id: &str,
) -> Option<Event> {
    for _ in 0..40 {
        let events = private_query_events(
            tenant,
            reader,
            vec![
                Filter::new()
                    .id(EventId::from_hex(event_id).expect("private event id"))
                    .kinds(vec![
                        Kind::Custom(KIND_BLOCK_MANIFEST as u16),
                        Kind::Custom(KIND_TASK as u16),
                        Kind::Custom(KIND_WEBSITE_HEAD as u16),
                    ])
                    .limit(1),
            ],
        )
        .await;
        if let Some(event) = events.into_iter().next() {
            return Some(event);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    None
}

async fn private_await_receipt_task(
    tenant: &PrivateWebsiteTenant,
    reader: &Keys,
    action_id: &str,
) -> String {
    let relay = nostr::PublicKey::from_hex(&tenant.relay_pubkey).expect("private relay key");
    let action = EventId::from_hex(action_id).expect("private action id");
    for _ in 0..40 {
        let events = private_query_events(
            tenant,
            reader,
            vec![Filter::new()
                .kind(Kind::Custom(KIND_COMPANY_RECEIPT as u16))
                .author(relay)
                .event(action)
                .limit(1)],
        )
        .await;
        if let Some(event) = events.into_iter().next() {
            let receipt = buzz_sdk::company::parse_company_receipt(&event)
                .expect("private company receipt parses");
            assert_eq!(
                receipt.outcome,
                buzz_sdk::company::CompanyReceiptOutcome::Applied
            );
            let head_id = receipt
                .head_event_id
                .expect("private attach receipt names task head");
            let head = private_event_by_id(tenant, reader, &head_id)
                .await
                .expect("private task head stored");
            return parse_task_event(&head)
                .expect("private task head parses")
                .id;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("private relay never answered the thread attach");
}

async fn private_await_task_root(
    tenant: &PrivateWebsiteTenant,
    reader: &Keys,
    task_id: &str,
    thread_root: &str,
) -> Event {
    for _ in 0..40 {
        let events = private_query_events(
            tenant,
            reader,
            vec![Filter::new()
                .kind(Kind::Custom(KIND_TASK as u16))
                .limit(200)],
        )
        .await;
        for event in events {
            let Ok(task) = parse_task_event(&event) else {
                continue;
            };
            if task.id == task_id && task.thread_root.as_deref() == Some(thread_root) {
                return event;
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("private task head never learned its thread root");
}

async fn private_create_channel(tenant: &PrivateWebsiteTenant, owner: &Keys) -> String {
    let channel_uuid = Uuid::new_v4();
    let channel = channel_uuid.to_string();
    let name = format!("website-private-{channel}");
    let event = EventBuilder::new(Kind::Custom(9007), "")
        .tags(vec![
            Tag::parse(["h", channel.as_str()]).expect("private h tag"),
            Tag::parse(["name", name.as_str()]).expect("private name tag"),
            Tag::parse(["channel_type", "stream"]).expect("private type tag"),
            Tag::parse(["visibility", "open"]).expect("private visibility tag"),
        ])
        .sign_with_keys(owner)
        .expect("private channel signs");
    private_assert_accepted(
        private_submit_event(tenant, owner, &event).await,
        "private channel creation",
    );
    channel
}

async fn private_publish_team(
    tenant: &PrivateWebsiteTenant,
    owner: &Keys,
    team: &CompanyTeamRef,
) {
    let content = serde_json::json!({
        "id": team.id,
        "lead_persona_id": team.lead_persona_id,
        "persona_ids": team.persona_ids,
    });
    let event = EventBuilder::new(
        Kind::Custom(KIND_TEAM as u16),
        serde_json::to_string(&content).expect("private team JSON"),
    )
    .tags([Tag::parse(["d", team.id.as_str()]).expect("private team d tag")])
    .sign_with_keys(owner)
    .expect("private team signs");
    private_assert_accepted(
        private_submit_event(tenant, owner, &event).await,
        "private team head",
    );
}

async fn private_publish_managed_agent(
    tenant: &PrivateWebsiteTenant,
    owner: &Keys,
    agent: &Keys,
    persona_id: &str,
) {
    let content = serde_json::json!({ "persona_id": persona_id });
    let event = EventBuilder::new(
        Kind::Custom(KIND_MANAGED_AGENT as u16),
        serde_json::to_string(&content).expect("private managed-agent JSON"),
    )
    .tags([Tag::parse(["d", agent.public_key().to_hex().as_str()])
        .expect("private managed-agent d tag")])
    .sign_with_keys(owner)
    .expect("private managed-agent signs");
    let (status, body) = private_submit_event(tenant, owner, &event).await;
    if status == 200 {
        assert_eq!(
            body["accepted"].as_bool(),
            Some(true),
            "private managed-agent head was rejected: {body}"
        );
    } else if !body["error"]
        .as_str()
        .is_some_and(|message| message.contains("superseded"))
        && !body["message"]
            .as_str()
            .is_some_and(|message| message.contains("superseded"))
    {
        panic!("private managed-agent head rejected: HTTP {status}: {body}");
    }
}

async fn private_bundled_website_job_manifest(
    tenant: &PrivateWebsiteTenant,
    reader: &Keys,
) -> String {
    let relay = nostr::PublicKey::from_hex(&tenant.relay_pubkey).expect("private relay key");
    let events = private_query_events(
        tenant,
        reader,
        vec![Filter::new()
            .kind(Kind::Custom(KIND_BLOCK_MANIFEST as u16))
            .author(relay)
            .limit(100)],
    )
    .await;
    events
        .into_iter()
        .find(|event| event.content.contains("\"handle\":\"website-job\""))
        .map(|event| event.id.to_hex())
        .unwrap_or_else(|| {
            panic!(
                "private tenant must have a startup-seeded bundled website-job manifest; check that the community existed before relay startup"
            )
        })
}

async fn private_setup(
    tenant: &PrivateWebsiteTenant,
    owner: &Keys,
) -> PrivateWebsiteFixture {
    private_seed_member(tenant, owner, "owner", None).await;
    let suffix = Uuid::new_v4().simple().to_string();
    let coordinator = agent_keys(0x71);
    let builder = agent_keys(0x72);
    let reviewer = agent_keys(0x73);
    let research = agent_keys(0x74);
    for agent in [&coordinator, &builder, &reviewer, &research] {
        private_seed_member(tenant, agent, "member", Some(owner)).await;
    }
    let personas = TeamPersonas {
        research: format!("private-research-{}", &suffix[..12]),
        build: format!("private-build-{}", &suffix[..12]),
        review: format!("private-review-{}", &suffix[..12]),
    };
    let coordinator_persona = format!("private-coordinator-{}", &suffix[..12]);
    let team = CompanyTeamRef {
        id: format!("private-team-{}-company-coordination", &suffix[..12]),
        lead_persona_id: coordinator_persona.clone(),
        persona_ids: vec![
            coordinator_persona.clone(),
            personas.research.clone(),
            personas.build.clone(),
            personas.review.clone(),
        ],
    };
    private_publish_team(tenant, owner, &team).await;
    private_publish_managed_agent(tenant, owner, &coordinator, &coordinator_persona).await;
    private_publish_managed_agent(tenant, owner, &builder, &personas.build).await;
    private_publish_managed_agent(tenant, owner, &reviewer, &personas.review).await;
    private_publish_managed_agent(tenant, owner, &research, &personas.research).await;

    let channel = private_create_channel(tenant, owner).await;
    for keys in [owner, &coordinator, &builder, &reviewer, &research] {
        private_seed_channel_member(tenant, &channel, keys).await;
    }

    let send_id = format!("private-send-{}", &suffix[..12]);
    let attach = plan_thread_attach(ThreadAttachRequest {
        channel_id: &channel,
        thread_root: None,
        conversation_scope: false,
        send_id: &send_id,
        mode: ThreadAttachMode::Open,
        title: "Improve our website",
        agent_persona_id: Some(coordinator_persona.as_str()),
        client_organization_id: None,
        parent_task_id: None,
        owner_pubkey: &owner.public_key().to_hex(),
        relay_pubkey: &tenant.relay_pubkey,
        now: now(),
    })
    .expect("private attach plans");
    let attach_event = buzz_sdk::company::build_company_action(&attach)
        .expect("private attach builds")
        .sign_with_keys(owner)
        .expect("private attach signs");
    let attach_id = attach_event.id.to_hex();
    private_assert_accepted(
        private_submit_event(tenant, owner, &attach_event).await,
        "private thread attach",
    );
    let task_id = private_await_receipt_task(tenant, owner, &attach_id).await;

    let root_event = EventBuilder::new(
        Kind::Custom(KIND_STREAM_MESSAGE_V2 as u16),
        "@Website Manager please improve our website",
    )
    .tags([
        Tag::parse(["h", channel.as_str()]).expect("private root h tag"),
        Tag::parse(["task", task_id.as_str()]).expect("private root task tag"),
    ])
    .sign_with_keys(owner)
    .expect("private root signs");
    let thread_root = root_event.id.to_hex();
    private_assert_accepted(
        private_submit_event(tenant, owner, &root_event).await,
        "private thread root",
    );
    private_await_task_root(tenant, owner, &task_id, &thread_root).await;

    let manifest_event_id = private_bundled_website_job_manifest(tenant, owner).await;
    let instance_id = Uuid::new_v4();
    let data = serde_json::json!({
        "taskId": task_id,
        "threadRoot": thread_root,
        "sourceUrl": "https://source.colony.test/sites/horizon-labs",
        "brief": {
            "summary": "Improve the Horizon Labs site while keeping the brand",
            "preserve": ["wordmark"],
            "redesign": ["hero", "services"],
            "deliverables": ["preview", "source archive"]
        }
    });
    let canonical = buzz_core::block::canonical_json(&data).expect("private instance data");
    let instance_event = EventBuilder::new(Kind::Custom(KIND_STREAM_MESSAGE as u16), "Website job")
        .tags([
            Tag::parse(["h", channel.as_str()]).expect("private instance h tag"),
            Tag::parse([
                "block",
                "1",
                WEBSITE_JOB_BLOCK_HANDLE,
                manifest_event_id.as_str(),
                instance_id.to_string().as_str(),
            ])
            .expect("private instance block tag"),
            Tag::parse(["e", manifest_event_id.as_str(), "", "block"])
                .expect("private instance manifest tag"),
            Tag::parse(["block-data", canonical.as_str()]).expect("private instance data tag"),
            Tag::parse([
                "block-processor",
                "1",
                coordinator.public_key().to_hex().as_str(),
            ])
            .expect("private instance processor tag"),
            Tag::parse(["block-attention", "1", "required"])
                .expect("private instance attention declaration"),
            Tag::parse(["p", owner.public_key().to_hex().as_str()])
                .expect("private instance attention tag"),
            Tag::parse(["e", thread_root.as_str(), "", "reply"])
                .expect("private instance reply tag"),
        ])
        .sign_with_keys(&coordinator)
        .expect("private instance signs");
    let instance_event_id = instance_event.id.to_hex();
    private_assert_accepted(
        private_submit_event(tenant, &coordinator, &instance_event).await,
        "private website instance",
    );

    PrivateWebsiteFixture {
        tenant: tenant.clone(),
        channel,
        task_id,
        thread_root,
        instance_id,
        instance_event_id,
        manifest_event_id,
        coordinator,
        builder,
        reviewer,
        personas,
    }
}
