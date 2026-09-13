fn private_create_action(fixture: &PrivateWebsiteFixture, owner: &Keys) -> WebsiteAction {
    WebsiteAction {
        channel_id: Uuid::parse_str(&fixture.channel).expect("private action channel"),
        task_id: fixture.task_id.clone(),
        thread_root: fixture.thread_root.clone(),
        instance_event_id: Some(fixture.instance_event_id.clone()),
        manifest_event_id: Some(fixture.manifest_event_id.clone()),
        request_id: Uuid::new_v4(),
        generation: None,
        actor: owner.public_key(),
        target_pubkey: None,
        op: WebsiteActionOp::Create {
            coordinator: fixture.coordinator.public_key().to_hex(),
            source_url: "https://source.colony.test/sites/horizon-labs".to_owned(),
            research_personas: vec![fixture.personas.research.clone()],
            build_personas: vec![fixture.personas.build.clone()],
            review_personas: vec![fixture.personas.review.clone()],
        },
    }
}

fn private_update_action(
    fixture: &PrivateWebsiteFixture,
    actor: &Keys,
    generation: u64,
    op: WebsiteActionOp,
) -> WebsiteAction {
    let target_pubkey = matches!(&op, WebsiteActionOp::BeginWork)
        .then(|| fixture.coordinator.public_key().to_hex());
    WebsiteAction {
        channel_id: Uuid::parse_str(&fixture.channel).expect("private action channel"),
        task_id: fixture.task_id.clone(),
        thread_root: fixture.thread_root.clone(),
        instance_event_id: None,
        manifest_event_id: None,
        request_id: Uuid::new_v4(),
        generation: Some(generation),
        actor: actor.public_key(),
        target_pubkey,
        op,
    }
}

async fn private_send_action(
    fixture: &PrivateWebsiteFixture,
    signer: &Keys,
    action: &WebsiteAction,
) -> (u16, serde_json::Value) {
    let event = build_website_action(action)
        .expect("private website action builds")
        .sign_with_keys(signer)
        .expect("private website action signs");
    private_submit_event(&fixture.tenant, signer, &event).await
}

async fn private_website_head_from_response(
    fixture: &PrivateWebsiteFixture,
    reader: &Keys,
    response: (u16, serde_json::Value),
) -> (Event, buzz_core::website::WebsiteReview) {
    let (status, body) = response;
    assert_eq!(status, 200, "private website transition HTTP {status}: {body}");
    assert_eq!(body["accepted"].as_bool(), Some(true), "private transition: {body}");
    let message = body["message"]
        .as_str()
        .unwrap_or_else(|| panic!("private transition has no result message: {body}"));
    let result: serde_json::Value =
        serde_json::from_str(message).expect("private transition result JSON");
    let head_event_id = result["head_event_id"]
        .as_str()
        .expect("private transition names its head");
    let head = private_event_by_id(&fixture.tenant, reader, head_event_id)
        .await
        .expect("private website head stored");
    assert_eq!(head.kind.as_u16() as u32, KIND_WEBSITE_HEAD);
    let review = buzz_sdk::website::parse_website_head(&head).expect("private head parses");
    (head, review)
}

fn private_block_decision_event(
    fixture: &PrivateWebsiteFixture,
    owner: &Keys,
    manifest: &BlockManifest,
    action_id: &str,
    data: serde_json::Value,
) -> Event {
    build_block_action(&BlockActionInput {
        channel_id: Uuid::parse_str(&fixture.channel).expect("private decision channel"),
        processor: fixture.coordinator.public_key(),
        instance_event_id: EventId::from_hex(&fixture.instance_event_id)
            .expect("private instance event"),
        manifest_id: EventId::from_hex(&fixture.manifest_event_id)
            .expect("private manifest event"),
        instance_id: fixture.instance_id,
        manifest,
        action_id: action_id.to_owned(),
        data,
        idempotency_key: Some(Uuid::new_v4()),
    })
    .expect("private website Block decision builds")
    .builder
    .sign_with_keys(owner)
    .expect("private website Block decision signs")
}

fn private_sign_blossom_auth(
    keys: &Keys,
    sha256: &str,
    operation: &str,
    server_host: &str,
) -> Event {
    let expires = (Timestamp::now().as_secs() + 300).to_string();
    EventBuilder::new(Kind::from(24242), "Website artifact proof")
        .tags([
            Tag::parse(["t", operation]).expect("Blossom operation tag"),
            Tag::parse(["x", sha256]).expect("Blossom hash tag"),
            Tag::parse(["server", server_host]).expect("Blossom server tag"),
            Tag::parse(["expiration", expires.as_str()]).expect("Blossom expiration tag"),
        ])
        .sign_with_keys(keys)
        .expect("Blossom auth signs")
}

fn private_blossom_auth_header(event: &Event) -> String {
    format!(
        "Nostr {}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(event).expect("Blossom auth JSON"))
    )
}

async fn private_upload_artifact(
    tenant: &PrivateWebsiteTenant,
    uploader: &Keys,
    content_type: &str,
    bytes: &[u8],
) -> PrivateWebsiteArtifact {
    let sha256 = hex::encode(Sha256::digest(bytes));
    let auth = private_sign_blossom_auth(uploader, &sha256, "upload", &tenant.host);
    let response = reqwest::Client::new()
        .put(format!("{}/upload", tenant.http_url.trim_end_matches('/')))
        .header(reqwest::header::HOST, &tenant.host)
        .header("Authorization", private_blossom_auth_header(&auth))
        .header("Content-Type", content_type)
        .header("X-SHA-256", &sha256)
        .body(bytes.to_vec())
        .send()
        .await
        .expect("upload private Blossom artifact");
    let status = response.status();
    let body = response
        .text()
        .await
        .expect("read private Blossom upload response");
    assert!(
        status.is_success(),
        "private Blossom upload failed with {status}: {body}"
    );
    let descriptor: serde_json::Value =
        serde_json::from_str(&body).expect("private Blossom descriptor JSON");
    assert_eq!(descriptor["sha256"].as_str(), Some(sha256.as_str()));
    let url = descriptor["url"]
        .as_str()
        .expect("private Blossom descriptor URL")
        .to_owned();
    assert!(
        url.starts_with(&format!("https://{}/media/", tenant.host)),
        "private descriptor must retain the canonical HTTPS tenant origin: {url}"
    );
    PrivateWebsiteArtifact {
        url,
        sha256,
        bytes: bytes.to_vec(),
    }
}

async fn private_read_artifact_as(
    tenant: &PrivateWebsiteTenant,
    request_host: &str,
    reader: &Keys,
    artifact_url: &str,
    expected: Option<&[u8]>,
) -> u16 {
    let parsed = url::Url::parse(artifact_url).expect("private artifact URL");
    let path = parsed.path();
    let auth = private_sign_blossom_auth(
        reader,
        path.trim_start_matches("/media/")
            .split('.')
            .next()
            .expect("private media hash"),
        "get",
        request_host,
    );
    let response = reqwest::Client::new()
        .get(format!("{}{}", tenant.http_url.trim_end_matches('/'), path))
        .header(reqwest::header::HOST, request_host)
        .header("Authorization", private_blossom_auth_header(&auth))
        .send()
        .await
        .expect("read private Blossom artifact");
    let status = response.status().as_u16();
    if status == 200 {
        let bytes = response
            .bytes()
            .await
            .expect("read private Blossom bytes");
        if let Some(expected) = expected {
            assert_eq!(bytes.as_ref(), expected, "private artifact bytes must be exact");
        }
    }
    status
}

fn private_capture_png() -> Vec<u8> {
    // Metadata-free 2x2 PNG: this is a structural fixture for the capture
    // refs. Pixel-render QA is a separate browser/native proof stage.
    vec![
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02, 0x08, 0x02, 0x00, 0x00, 0x00, 0xfd,
        0xd4, 0x9a, 0x73, 0x00, 0x00, 0x00, 0x10, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xfc,
        0xc3, 0x00, 0x02, 0x2c, 0x60, 0x92, 0x01, 0x00, 0x0d, 0x04, 0x01, 0x02, 0xbf, 0x50, 0x15,
        0xb3, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]
}

fn private_crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffff;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn private_push_u16(bytes: &mut Vec<u8>, value: u16) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn private_push_u32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

/// Build a small, valid uncompressed ZIP containing the source files used by
/// the fixture. Keeping the archive bytes in this test makes the handover
/// exercise a real source bundle rather than a magic-byte placeholder.
fn private_source_archive(html: &[u8], css: &[u8]) -> Vec<u8> {
    let entries = [("index.html", html), ("styles.css", css)];
    let mut archive = Vec::new();
    let mut central = Vec::new();

    for (name, contents) in entries {
        let name = name.as_bytes();
        let crc = private_crc32(contents);
        let size = u32::try_from(contents.len()).expect("fixture source file fits ZIP32");
        let offset = u32::try_from(archive.len()).expect("fixture archive fits ZIP32");

        private_push_u32(&mut archive, 0x0403_4b50);
        private_push_u16(&mut archive, 20);
        private_push_u16(&mut archive, 0);
        private_push_u16(&mut archive, 0);
        private_push_u16(&mut archive, 0);
        private_push_u16(&mut archive, 0);
        private_push_u32(&mut archive, crc);
        private_push_u32(&mut archive, size);
        private_push_u32(&mut archive, size);
        private_push_u16(
            &mut archive,
            u16::try_from(name.len()).expect("fixture name fits ZIP16"),
        );
        private_push_u16(&mut archive, 0);
        archive.extend_from_slice(name);
        archive.extend_from_slice(contents);

        private_push_u32(&mut central, 0x0201_4b50);
        private_push_u16(&mut central, 20);
        private_push_u16(&mut central, 20);
        private_push_u16(&mut central, 0);
        private_push_u16(&mut central, 0);
        private_push_u16(&mut central, 0);
        private_push_u16(&mut central, 0);
        private_push_u32(&mut central, crc);
        private_push_u32(&mut central, size);
        private_push_u32(&mut central, size);
        private_push_u16(
            &mut central,
            u16::try_from(name.len()).expect("fixture name fits ZIP16"),
        );
        private_push_u16(&mut central, 0);
        private_push_u16(&mut central, 0);
        private_push_u16(&mut central, 0);
        private_push_u16(&mut central, 0);
        private_push_u32(&mut central, 0);
        private_push_u32(&mut central, offset);
        central.extend_from_slice(name);
    }

    let central_offset = u32::try_from(archive.len()).expect("fixture archive fits ZIP32");
    let central_size = u32::try_from(central.len()).expect("fixture central directory fits ZIP32");
    archive.extend_from_slice(&central);
    private_push_u32(&mut archive, 0x0605_4b50);
    private_push_u16(&mut archive, 0);
    private_push_u16(&mut archive, 0);
    private_push_u16(&mut archive, 2);
    private_push_u16(&mut archive, 2);
    private_push_u32(&mut archive, central_size);
    private_push_u32(&mut archive, central_offset);
    private_push_u16(&mut archive, 0);
    archive
}

async fn private_foreign_community(host: &str) -> Uuid {
    with_e2e_db(|pool| {
        let host = host.to_owned();
        async move {
            sqlx::query(
                "INSERT INTO communities (id, host) VALUES ($1, $2) \
                 ON CONFLICT (lower(host)) DO NOTHING",
            )
            .bind(Uuid::new_v4())
            .bind(&host)
            .execute(&pool)
            .await
            .expect("seed private foreign tenant");
            sqlx::query_scalar("SELECT id FROM communities WHERE lower(host) = lower($1)")
                .bind(&host)
                .fetch_one(&pool)
                .await
                .expect("lookup private foreign tenant")
        }
    })
    .await
}

fn private_foreign_host() -> String {
    std::env::var("WEBSITE_FOREIGN_TENANT_HOST")
        .unwrap_or_else(|_| "website-foreign.example.com".to_owned())
}
