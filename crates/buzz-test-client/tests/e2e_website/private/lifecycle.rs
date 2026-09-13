#[tokio::test]
#[ignore = "requires a dedicated WSS-configured relay and tenant seeded before startup"]
// CI runs this case separately from the ordinary `ws://localhost` website
// suite, for example with `RELAY_URL=wss://website-owner.example.com`,
// `WEBSITE_RELAY_HTTP_URL=http://127.0.0.1:3000`, and a pre-seeded
// `WEBSITE_TENANT_HOST=website-owner.example.com` community.
async fn private_blossom_website_lifecycle_is_tenant_scoped() {
    let tenant = private_website_tenant().await;
    let owner = owner_keys();
    let fixture = private_setup(&tenant, &owner).await;

    let html_bytes = br#"<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><main><h1>Horizon Labs</h1><p>Services that keep growing teams moving.</p></main></body></html>"#.to_vec();
    let css_bytes = br#"body{margin:0;background:#f6f4ef;color:#14211b;font:16px system-ui,sans-serif}main{max-width:58rem;margin:12vh auto;padding:2rem}h1{font-size:clamp(2.5rem,8vw,6rem);letter-spacing:-.06em}"#.to_vec();
    let capture_bytes = private_capture_png();
    let archive_bytes = private_source_archive(&html_bytes, &css_bytes);

    let html = private_upload_artifact(&tenant, &fixture.builder, "text/html", &html_bytes).await;
    let css = private_upload_artifact(&tenant, &fixture.builder, "text/css", &css_bytes).await;
    let capture =
        private_upload_artifact(&tenant, &fixture.builder, "image/png", &capture_bytes).await;
    let archive =
        private_upload_artifact(&tenant, &fixture.builder, "application/zip", &archive_bytes).await;
    let manifest_bytes = serde_json::to_vec(&serde_json::json!({
        "schema": "colony.website-preview/1",
        "entrypoint": "index.html",
        "files": [
            {
                "path": "index.html",
                "url": html.url.clone(),
                "sha256": html.sha256.clone(),
                "mime": "text/html",
                "size": html.bytes.len()
            },
            {
                "path": "styles.css",
                "url": css.url.clone(),
                "sha256": css.sha256.clone(),
                "mime": "text/css",
                "size": css.bytes.len()
            }
        ]
    }))
    .expect("private preview manifest JSON");
    let manifest =
        private_upload_artifact(&tenant, &fixture.builder, "application/json", &manifest_bytes)
            .await;
    let report_bytes = serde_json::to_vec(&serde_json::json!({
        "schema": "colony.website-qa-report/1",
        "reviewer": fixture.reviewer.public_key().to_hex(),
        "revision": 1,
        "manifestSha256": manifest.sha256.clone(),
        "checks": [
            {
                "id": "capture-refs",
                "label": "Capture refs are present and bound to the revision",
                "result": "pass",
                "detail": "The fixture carries metadata-free capture bytes for the approved viewports; rendered viewport QA is proven separately.",
                "evidence": []
            },
            {
                "id": "asset-integrity",
                "label": "Manifest assets match their declared hashes",
                "result": "pass",
                "evidence": []
            }
        ]
    }))
    .expect("private QA report JSON");
    let report = private_upload_artifact(
        &tenant,
        &fixture.reviewer,
        "application/json",
        &report_bytes,
    )
    .await;

    for artifact in [&html, &css, &capture, &archive, &manifest, &report] {
        assert_eq!(
            private_read_artifact_as(
                &tenant,
                &tenant.host,
                &fixture.builder,
                &artifact.url,
                Some(&artifact.bytes),
            )
            .await,
            200,
            "same-tenant private Blossom reads must succeed"
        );
    }

    let foreign_host = private_foreign_host();
    assert_ne!(foreign_host, tenant.host, "foreign host must differ from primary tenant");
    let foreign_community = private_foreign_community(&foreign_host).await;
    let foreign_owner = agent_keys(0x75);
    private_seed_member(
        &PrivateWebsiteTenant {
            host: foreign_host.clone(),
            http_url: tenant.http_url.clone(),
            community: foreign_community,
            relay_pubkey: tenant.relay_pubkey.clone(),
        },
        &foreign_owner,
        "owner",
        None,
    )
    .await;
    let foreign_tenant = PrivateWebsiteTenant {
        host: foreign_host.clone(),
        http_url: tenant.http_url.clone(),
        community: foreign_community,
        relay_pubkey: tenant.relay_pubkey.clone(),
    };

    let foreign_manifest_url = format!("https://{foreign_host}/media/{}.json", manifest.sha256);
    assert_ne!(
        private_read_artifact_as(
            &tenant,
            &foreign_host,
            &owner,
            &foreign_manifest_url,
            None,
        )
        .await,
        200,
        "a primary-tenant owner must not read a mapped foreign tenant blob"
    );
    assert_eq!(
        private_read_artifact_as(
            &foreign_tenant,
            &foreign_host,
            &foreign_owner,
            &manifest.url,
            None,
        )
        .await,
        404,
        "a foreign-tenant member must not read the primary tenant blob"
    );
    assert_ne!(
        private_read_artifact_as(&tenant, &tenant.host, &Keys::generate(), &manifest.url, None)
            .await,
        200,
        "a same-tenant nonmember must not read the private blob"
    );

    let manifest_event = private_event_by_id(&tenant, &owner, &fixture.manifest_event_id)
        .await
        .expect("private website manifest event");
    let block_manifest = buzz_core::block::parse_manifest(&manifest_event.content)
        .expect("private website manifest parses");

    let create = private_create_action(&fixture, &owner);
    let (head, review) = private_website_head_from_response(
        &fixture,
        &owner,
        private_send_action(&fixture, &owner, &create).await,
    )
    .await;
    assert_head_generation(&head, 1);
    assert_eq!(review.status, buzz_core::website::WebsiteStatus::Draft);

    let begin = private_update_action(&fixture, &owner, 1, WebsiteActionOp::BeginWork);
    let (head, review) = private_website_head_from_response(
        &fixture,
        &owner,
        private_send_action(&fixture, &owner, &begin).await,
    )
    .await;
    assert_head_generation(&head, 2);
    assert_eq!(review.status, buzz_core::website::WebsiteStatus::Working);

    // The mapped foreign host must fail in the broker before it can fall
    // through to the unauthenticated public fetcher.
    let foreign_revision = private_update_action(
        &fixture,
        &fixture.builder,
        2,
        WebsiteActionOp::AddRevision {
            revision: 1,
            manifest: artifact_ref(foreign_manifest_url, &manifest.sha256),
            source_url: "https://source.colony.test/sites/horizon-labs".to_owned(),
            archive: artifact_ref(archive.url.clone(), &archive.sha256),
            captures: WebsiteCaptures {
                before: artifact_ref(capture.url.clone(), &capture.sha256),
                desktop: artifact_ref(capture.url.clone(), &capture.sha256),
                mobile: artifact_ref(capture.url.clone(), &capture.sha256),
            },
        },
    );
    let (status, body) = private_send_action(&fixture, &fixture.builder, &foreign_revision).await;
    assert_ne!(status, 200, "mapped foreign manifest must be rejected");
    let error = body["error"]
        .as_str()
        .or_else(|| body["message"].as_str())
        .unwrap_or("");
    assert!(
        error.contains("website artifact unavailable"),
        "mapped foreign artifact rejection must be generic and fail closed: HTTP {status}: {body}"
    );

    let add_revision = private_update_action(
        &fixture,
        &fixture.builder,
        2,
        WebsiteActionOp::AddRevision {
            revision: 1,
            manifest: artifact_ref(manifest.url.clone(), &manifest.sha256),
            source_url: "https://source.colony.test/sites/horizon-labs".to_owned(),
            archive: artifact_ref(archive.url.clone(), &archive.sha256),
            captures: WebsiteCaptures {
                before: artifact_ref(capture.url.clone(), &capture.sha256),
                desktop: artifact_ref(capture.url.clone(), &capture.sha256),
                mobile: artifact_ref(capture.url.clone(), &capture.sha256),
            },
        },
    );
    let (head, review) = private_website_head_from_response(
        &fixture,
        &fixture.builder,
        private_send_action(&fixture, &fixture.builder, &add_revision).await,
    )
    .await;
    assert_head_generation(&head, 3);
    assert_eq!(review.current_revision, 1);
    assert_eq!(review.revisions[0].built_by, fixture.builder.public_key().to_hex());

    let report_event = build_website_qa_task_report(
        &fixture.task_id,
        1,
        &manifest.sha256,
        &report.url,
        &report.sha256,
        "independent QA checked the tenant-scoped manifest and capture refs; viewport rendering is proven separately",
    )
    .expect("private QA task report builds")
    .sign_with_keys(&fixture.reviewer)
    .expect("private QA task report signs");
    let report_event_id = report_event.id.to_hex();
    private_assert_accepted(
        private_submit_event(&tenant, &fixture.reviewer, &report_event).await,
        "private QA task report",
    );
    let record_qa = private_update_action(
        &fixture,
        &fixture.reviewer,
        3,
        WebsiteActionOp::RecordQa {
            revision: 1,
            passed: true,
            report_event_id,
            report: artifact_ref(report.url.clone(), &report.sha256),
        },
    );
    let (head, review) = private_website_head_from_response(
        &fixture,
        &fixture.reviewer,
        private_send_action(&fixture, &fixture.reviewer, &record_qa).await,
    )
    .await;
    assert_head_generation(&head, 4);
    assert_eq!(
        review.revisions[0].qa.as_ref().map(|qa| qa.passed),
        Some(true)
    );

    let ready = private_update_action(&fixture, &fixture.coordinator, 4, WebsiteActionOp::Ready);
    let (head, review) = private_website_head_from_response(
        &fixture,
        &fixture.coordinator,
        private_send_action(&fixture, &fixture.coordinator, &ready).await,
    )
    .await;
    assert_head_generation(&head, 5);
    assert_eq!(
        review.status,
        buzz_core::website::WebsiteStatus::ReadyForReview
    );

    let job_id = WebsiteAction::derive_job_id(
        tenant.community,
        &fixture.task_id,
        &fixture.thread_root,
    );
    let approval_data = decision_data(
        job_id,
        &fixture.task_id,
        5,
        1,
        &manifest.sha256,
        Some("Approve the exact tenant-scoped revision."),
    );
    let approval_event = private_block_decision_event(
        &fixture,
        &owner,
        &block_manifest,
        WEBSITE_APPROVE_ACTION_ID,
        approval_data,
    );
    let (head, review) = private_website_head_from_response(
        &fixture,
        &owner,
        private_submit_event(&tenant, &owner, &approval_event).await,
    )
    .await;
    assert_head_generation(&head, 6);
    assert_eq!(review.status, buzz_core::website::WebsiteStatus::Approved);
    assert_eq!(review.current_revision, 1);

    let work = builder_work_event(
        &fixture.builder,
        &fixture.channel,
        &fixture.thread_root,
        1,
        &manifest.sha256,
    );
    private_submit_event(&tenant, &fixture.builder, &work).await;
    let evidence = private_update_action(
        &fixture,
        &fixture.builder,
        6,
        WebsiteActionOp::StageEvidence {
            stage: buzz_core::website::Stage::DesignBuild,
            revision: Some(1),
            kind: buzz_core::website::StageEvidenceKind::WorkEvent,
            event_id: work.id.to_hex(),
        },
    );
    let (head, _) = private_website_head_from_response(
        &fixture,
        &fixture.builder,
        private_send_action(&fixture, &fixture.builder, &evidence).await,
    )
    .await;
    assert_head_generation(&head, 7);

    let handover = private_update_action(
        &fixture,
        &fixture.coordinator,
        7,
        WebsiteActionOp::Handover {
            approved_revision: 1,
            approved_manifest_sha256: manifest.sha256.clone(),
            source_url: "https://source.colony.test/sites/horizon-labs".to_owned(),
            source_archive: artifact_ref(archive.url, &archive.sha256),
            assets: vec![HandoverAsset {
                path: "index.html".to_owned(),
                artifact: artifact_ref(html.url, &html.sha256),
            }],
            access_request: None,
        },
    );
    let (head, review) = private_website_head_from_response(
        &fixture,
        &fixture.coordinator,
        private_send_action(&fixture, &fixture.coordinator, &handover).await,
    )
    .await;
    assert_head_generation(&head, 8);
    assert_eq!(review.status, buzz_core::website::WebsiteStatus::HandedOver);
    assert_eq!(review.current_revision, 1);
    assert_eq!(
        review
            .handover
            .as_ref()
            .expect("private handover persisted")
            .approved_manifest_sha256,
        manifest.sha256
    );
}
