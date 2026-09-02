use super::*;
use nostr::Keys;

#[test]
fn block_reference_channel_accepts_only_the_closed_safe_shapes() {
    let publisher = "a".repeat(64);
    let manifest = "b".repeat(64);
    let instance = "11111111-1111-4111-8111-111111111111";
    let references = vec![
        vec![
            "a".to_owned(),
            format!("30178:{publisher}:question"),
            String::new(),
            "block".to_owned(),
        ],
        vec![
            "block".to_owned(),
            "1".to_owned(),
            "question".to_owned(),
            manifest.clone(),
            instance.to_owned(),
        ],
        vec!["block-data".to_owned(), r#"{"answer":"yes"}"#.to_owned()],
        vec![
            "block-data-ref".to_owned(),
            "https://example.com/data.json".to_owned(),
            "application/json".to_owned(),
            "c".repeat(64),
            "1024".to_owned(),
        ],
        vec![
            "block-attention".to_owned(),
            "1".to_owned(),
            "required".to_owned(),
        ],
        vec!["e".to_owned(), manifest, String::new(), "block".to_owned()],
    ];
    let event = build_message_with_reference_tags(
        Uuid::new_v4(),
        "Readable fallback",
        None,
        &[],
        &[],
        &[],
        &[],
        &references,
    )
    .expect("safe Block references")
    .sign_with_keys(&Keys::generate())
    .expect("signed");

    for expected in references {
        assert!(event
            .tags
            .iter()
            .any(|tag| tag.as_slice() == expected.as_slice()));
    }
}

#[test]
fn block_reference_channel_rejects_arbitrary_and_noncanonical_tags() {
    for invalid in [
        vec!["p".to_owned(), "a".repeat(64)],
        vec!["block-data".to_owned(), r#"{"z":1,"a":2}"#.to_owned()],
        vec![
            "block-data-ref".to_owned(),
            "javascript:alert(1)".to_owned(),
            "application/json".to_owned(),
            "a".repeat(64),
            "100".to_owned(),
        ],
    ] {
        let error = build_message_with_reference_tags(
            Uuid::new_v4(),
            "Fallback",
            None,
            &[],
            &[],
            &[],
            &[],
            &[invalid],
        )
        .expect_err("unsafe reference must fail");
        assert!(error.contains("invalid Block reference tag"));
    }
}

/// Onboarding's first-task marker, end to end through the real builder.
///
/// `completeFirstRunIo` sends this marker so `welcomeKickoff` and
/// `has_managed_agent_channel_message_marker` can find the message again. On
/// 2026-08-27 it travelled through the Blocks-only reference channel, which
/// rejects it, so first-run completion failed for every new user with
/// "invalid Block reference tag". Both directions are pinned here: the marker
/// is accepted where it belongs, and refused where it does not with a message
/// that names the right channel.
#[test]
fn onboarding_first_task_marker_rides_the_client_tag_channel() {
    let marker = "colony-onboarding-v2:first-task:7b171fd3-0772-4ab9-a7f4-b369b07fc8b8";
    let client_tags = vec![vec!["client".to_owned(), marker.to_owned()]];

    let event = build_message_with_client_tags(
        Uuid::new_v4(),
        "Scout, here is the company context I confirmed during onboarding.",
        None,
        &[],
        &[],
        &[],
        &[],
        &[],
        None,
        "https://relay.example",
        &client_tags,
    )
    .expect("client marker is accepted on its own channel")
    .sign_with_keys(&Keys::generate())
    .expect("signed");

    assert!(event
        .tags
        .iter()
        .any(|tag| tag.as_slice() == ["client".to_owned(), marker.to_owned()]));

    let error = build_message_with_reference_tags(
        Uuid::new_v4(),
        "Scout, here is the company context I confirmed during onboarding.",
        None,
        &[],
        &[],
        &[],
        &[],
        &client_tags,
    )
    .expect_err("a client marker is not a Block reference");
    assert!(
        error.contains("belong in clientTags"),
        "the rejection must name the channel that accepts it, got: {error}"
    );
}

#[test]
fn channel_builders_reject_hash_only_names() {
    let channel_id = Uuid::new_v4();
    assert!(build_create_channel(channel_id, "###", "open", "stream", None, None).is_err());
    assert!(build_update_channel(channel_id, Some("###"), None, None, None).is_err());
}

/// Builder layout regression for the NIP-IA owner-of-agent archive flow.
/// Compares against `docs/nips/NIP-IA.md` §Vector 1.
#[test]
fn archive_identity_request_matches_spec_vector_1_layout() {
    const OWNER_HEX: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const TARGET_HEX: &str = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
    const CONDITIONS: &str = "kind=1&created_at<1713957000";
    const SIG: &str = "8b7df2575caf0a108374f8471722b233c53f9ff827a8b0f91861966c3b9dd5cb2e189eae9f49d72187674c2f5bd244145e10ff86c9f257ffe65a1ee5f108b369";

    let auth: [String; 4] = [
        "auth".into(),
        OWNER_HEX.into(),
        CONDITIONS.into(),
        SIG.into(),
    ];
    let builder = build_archive_identity_request(
        TARGET_HEX,
        "Archiving zombie agent after rebuild.",
        Some("bot-rebuilt"),
        None,
        Some(&auth),
    )
    .expect("build_archive_identity_request");

    let owner_secret = nostr::SecretKey::from_hex(
        "0000000000000000000000000000000000000000000000000000000000000001",
    )
    .unwrap();
    let owner_keys = Keys::new(owner_secret);
    let event = builder.sign_with_keys(&owner_keys).unwrap();

    let tags: Vec<Vec<String>> = event.tags.iter().map(|t| t.as_slice().to_vec()).collect();

    assert_eq!(event.kind, Kind::Custom(KIND_IA_ARCHIVE_REQUEST as u16));
    assert_eq!(tags[0], vec!["-"]);
    assert_eq!(tags[1], vec!["p", TARGET_HEX]);
    assert_eq!(tags[2], vec!["reason", "bot-rebuilt"]);
    assert_eq!(tags[3], vec!["auth", OWNER_HEX, CONDITIONS, SIG]);
}

#[test]
fn archive_request_rejects_replaced_by_equal_target() {
    const TARGET_HEX: &str = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
    let err =
        build_archive_identity_request(TARGET_HEX, "", None, Some(TARGET_HEX), None).unwrap_err();
    assert!(err.contains("replaced-by"));
}

#[test]
fn unarchive_request_layout_self_path() {
    const TARGET_HEX: &str = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
    let builder =
        build_unarchive_identity_request(TARGET_HEX, "I am active again.", Some("returned"), None)
            .unwrap();
    let target_secret = nostr::SecretKey::from_hex(
        "0000000000000000000000000000000000000000000000000000000000000002",
    )
    .unwrap();
    let event = builder.sign_with_keys(&Keys::new(target_secret)).unwrap();
    let tags: Vec<Vec<String>> = event.tags.iter().map(|t| t.as_slice().to_vec()).collect();
    assert_eq!(event.kind, Kind::Custom(KIND_IA_UNARCHIVE_REQUEST as u16));
    assert_eq!(tags[0], vec!["-"]);
    assert_eq!(tags[1], vec!["p", TARGET_HEX]);
    assert_eq!(tags[2], vec!["reason", "returned"]);
    assert_eq!(tags.len(), 3, "self unarchive must not carry auth tag");
    assert_eq!(event.pubkey.to_hex(), TARGET_HEX);
}

const CH_ID: &str = "11111111-1111-4111-8111-111111111111";
const ALICE_HEX: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const BOB_HEX: &str = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";

fn edit_tags(mentions: &[&str]) -> Vec<Vec<String>> {
    let channel = Uuid::parse_str(CH_ID).unwrap();
    let target =
        EventId::from_hex("d24da132115ca0a46233cf4c2ad8338fbf914250cbcaa9181a6dd59533cb5ac1")
            .unwrap();
    let builder = build_message_edit(
        channel,
        target,
        "hi @alice",
        MessageEditTags {
            media: &[],
            custom_emoji: &[],
            mentions,
            mention_refs: None,
        },
        false,
    )
    .unwrap();
    let secret = nostr::SecretKey::from_hex(
        "0000000000000000000000000000000000000000000000000000000000000003",
    )
    .unwrap();
    let event = builder.sign_with_keys(&Keys::new(secret)).unwrap();
    event.tags.iter().map(|t| t.as_slice().to_vec()).collect()
}

#[test]
fn edit_with_added_mention_emits_p_tag() {
    let tags = edit_tags(&[ALICE_HEX]);
    assert_eq!(tags[0][0], "h");
    assert_eq!(tags[1][0], "e");
    assert_eq!(tags[2], vec!["p".to_string(), ALICE_HEX.to_string()]);
}

#[test]
fn edit_with_no_added_mentions_emits_no_p_tag() {
    let tags = edit_tags(&[]);
    assert!(
        !tags
            .iter()
            .any(|t| t.first().map(String::as_str) == Some("p")),
        "unchanged-mention edit must not emit any `p` tag, got {tags:?}"
    );
}

#[test]
fn edit_mentions_are_deduped_and_lowercased() {
    let alice_upper = ALICE_HEX.to_ascii_uppercase();
    let tags = edit_tags(&[ALICE_HEX, &alice_upper, BOB_HEX]);
    let p_tags: Vec<&Vec<String>> = tags
        .iter()
        .filter(|t| t.first().map(String::as_str) == Some("p"))
        .collect();
    assert_eq!(
        p_tags.len(),
        2,
        "duplicate mention must collapse, got {p_tags:?}"
    );
    assert_eq!(p_tags[0], &vec!["p".to_string(), ALICE_HEX.to_string()]);
    assert_eq!(p_tags[1], &vec!["p".to_string(), BOB_HEX.to_string()]);
}

/// Work-context tags ride their own validated channel.
///
/// The composer attaches `["task", ...]` and `["team", ...]` to an
/// agent-directed message whose text implies work. They used to arrive in the
/// imeta-only media argument, where `imeta_tags` rejected the first one and
/// the whole send failed before anything was signed. A Task was created and
/// paid for on the relay and the message never posted.
#[test]
fn work_context_tags_ride_their_own_channel_not_the_imeta_one() {
    let task = vec![
        "task".to_owned(),
        "chat:eecf0442-ac20-5939-a95a-0306f5441260".to_owned(),
    ];
    let team = vec![
        "team".to_owned(),
        "builtin-team:company-coordination".to_owned(),
    ];
    let work_tags = vec![task.clone(), team.clone()];

    let event = build_message_with_reference_and_client_tags(
        Uuid::new_v4(),
        "@Christine - Graphic Designer okay?",
        None,
        &[],
        &[],
        &[],
        &[],
        &[],
        None,
        "https://relay.example",
        &[],
        &[],
        &work_tags,
    )
    .expect("work tags are accepted on their own channel")
    .sign_with_keys(&Keys::generate())
    .expect("signed");

    for expected in [&task, &team] {
        assert!(
            event
                .tags
                .iter()
                .any(|tag| tag.as_slice() == expected.as_slice()),
            "the built event must carry {expected:?}"
        );
    }

    // The media channel stays imeta-only: that guard is the injection defense,
    // and moving work tags off it must not weaken it.
    let error = build_message_with_reference_and_client_tags(
        Uuid::new_v4(),
        "@Christine - Graphic Designer okay?",
        None,
        &[],
        &work_tags,
        &[],
        &[],
        &[],
        None,
        "https://relay.example",
        &[],
        &[],
        &[],
    )
    .expect_err("a work tag is still not an imeta tag");
    assert!(
        error.contains("imeta"),
        "the rejection must name the imeta channel, got: {error}"
    );
}

/// The work channel is an allowlist, not a hole for arbitrary tags.
#[test]
fn work_context_channel_rejects_anything_outside_its_allowlist() {
    let cases: Vec<(Vec<Vec<String>>, &str)> = vec![
        (
            vec![vec!["h".to_owned(), Uuid::new_v4().to_string()]],
            "a forged channel tag",
        ),
        (
            vec![vec!["p".to_owned(), "a".repeat(64)]],
            "a forged mention tag",
        ),
        (vec![vec!["task".to_owned()]], "a task tag with no value"),
        (
            vec![vec![
                "team".to_owned(),
                "builtin-team:x".to_owned(),
                "extra".to_owned(),
            ]],
            "a team tag with a smuggled third element",
        ),
        (
            vec![vec!["initiative".to_owned(), "   ".to_owned()]],
            "an initiative tag with a blank value",
        ),
    ];

    for (work_tags, description) in cases {
        build_message_with_reference_and_client_tags(
            Uuid::new_v4(),
            "Readable fallback",
            None,
            &[],
            &[],
            &[],
            &[],
            &[],
            None,
            "https://relay.example",
            &[],
            &[],
            &work_tags,
        )
        .expect_err(description);
    }

    // And the three names it does accept are accepted.
    let allowed = vec![
        vec!["task".to_owned(), "chat:abc".to_owned()],
        vec!["team".to_owned(), "builtin-team:abc".to_owned()],
        vec!["initiative".to_owned(), "initiative:abc".to_owned()],
    ];
    build_message_with_reference_and_client_tags(
        Uuid::new_v4(),
        "Readable fallback",
        None,
        &[],
        &[],
        &[],
        &[],
        &[],
        None,
        "https://relay.example",
        &[],
        &[],
        &allowed,
    )
    .expect("task, team and initiative are the work channel");
}
