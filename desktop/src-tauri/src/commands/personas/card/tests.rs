//! Unit tests for `card.rs` — split into a child module file so the parent
//! stays under the 1000-line gate (same layout as `snapshot/tests.rs`).

use super::*;
use std::collections::BTreeMap;

#[test]
fn archive_file_name_validation_rejects_escapes() {
    assert!(validate_archive_file_name("eva-1234.agent.png").is_ok());
    for bad in [
        "../escape.agent.png",
        "sub/dir.agent.png",
        "sub\\dir.agent.png",
        "not-a-card.png",
        "plain.json",
        "",
    ] {
        assert!(
            validate_archive_file_name(bad).is_err(),
            "expected rejection: {bad:?}"
        );
    }
}

#[test]
fn card_template_decodes_with_expected_shape() {
    // The embedded template is generation input only, but a corrupt or
    // accidentally swapped asset should fail the build's test gate, not a
    // user's first mint.
    let img = image::load_from_memory(CARD_TEMPLATE_PNG).expect("template must decode");
    // 2:3-ish portrait frame.
    assert!(img.height() > img.width(), "template must be portrait");
    assert!(img.width() >= 512, "template unexpectedly small");
}

#[test]
fn key_resolution_layering_record_wins() {
    let mut global = BTreeMap::new();
    global.insert("OPENAI_API_KEY".to_string(), "global".to_string());
    let mut persona = BTreeMap::new();
    persona.insert("OPENAI_API_KEY".to_string(), "persona".to_string());
    let mut record = BTreeMap::new();
    record.insert("OPENAI_API_KEY".to_string(), "record".to_string());

    assert_eq!(
        resolve_env_from_layers("OPENAI_API_KEY", &global, &persona, &record, None).as_deref(),
        Some("record")
    );
    record.clear();
    assert_eq!(
        resolve_env_from_layers("OPENAI_API_KEY", &global, &persona, &record, None).as_deref(),
        Some("persona")
    );
    persona.clear();
    assert_eq!(
        resolve_env_from_layers("OPENAI_API_KEY", &global, &persona, &record, None).as_deref(),
        Some("global")
    );
    global.clear();
    assert_eq!(
        resolve_env_from_layers(
            "OPENAI_API_KEY",
            &global,
            &persona,
            &record,
            Some("process".to_string())
        )
        .as_deref(),
        Some("process")
    );
    assert!(resolve_env_from_layers("OPENAI_API_KEY", &global, &persona, &record, None).is_none());
}

#[test]
fn key_resolution_skips_blank_values() {
    let mut record = BTreeMap::new();
    record.insert("OPENAI_API_KEY".to_string(), "   ".to_string());
    let mut persona = BTreeMap::new();
    persona.insert("OPENAI_API_KEY".to_string(), "persona".to_string());
    assert_eq!(
        resolve_env_from_layers("OPENAI_API_KEY", &BTreeMap::new(), &persona, &record, None)
            .as_deref(),
        Some("persona")
    );
}

#[test]
fn responses_url_default_and_override() {
    assert_eq!(responses_url(None), "https://api.openai.com/v1/responses");
    // Trailing slashes must not produce a double-slash path.
    assert_eq!(
        responses_url(Some("https://proxy.example/v1/".to_string())),
        "https://proxy.example/v1/responses"
    );
    assert_eq!(
        responses_url(Some("https://proxy.example/v1".to_string())),
        "https://proxy.example/v1/responses"
    );
}

#[test]
fn instructions_pin_style_match_default_and_owner_primacy() {
    let base = build_card_instructions("Eva", "leads the team", "");
    assert!(base.contains("match input image 2's art style EXACTLY"));
    assert!(base.contains("\"Eva\""));
    assert!(!base.contains("OWNER'S DIRECTIONS"));

    let directed = build_card_instructions("Eva", "leads the team", "make it stormy");
    // Owner directions take primacy over style defaults...
    assert!(directed.contains("OWNER'S DIRECTIONS"));
    assert!(directed.contains("make it stormy"));
    assert!(directed.contains("override the default art-style and copy guidance"));
    // ...but the fixed contract survives: frame, style anchor (as an
    // overridable default), and text-fidelity requirements stay present.
    assert!(directed.contains("match input image 2's art style EXACTLY"));
    assert!(directed.contains("cannot change the frame, layout, or"));
    assert!(directed.contains("Render all text with perfect fidelity"));
    // Card-text direction is an explicitly named capability, and the
    // owner-wording rule acknowledges the fixed 220-char text-box limit
    // (no mutually impossible "verbatim" vs "under 220 chars" pair).
    assert!(directed.contains("card text"));
    assert!(directed.contains("use their wording within the 220-character text-box limit"));
}

#[test]
fn extract_card_output_happy_path_and_missing_image() {
    let ok = serde_json::json!({
        "output": [
            {"type": "reasoning"},
            {"type": "image_generation_call", "result": "aW1n"},
            {"type": "message", "content": [
                {"type": "output_text", "text": "notes here"}
            ]}
        ]
    });
    let (img, notes) = extract_card_output(&ok).unwrap();
    assert_eq!(img, "aW1n");
    assert_eq!(notes, "notes here");

    let missing = serde_json::json!({"output": [{"type": "message", "content": []}]});
    let err = extract_card_output(&missing).unwrap_err();
    assert!(err.contains("No image"), "{err}");

    let no_output = serde_json::json!({});
    assert!(extract_card_output(&no_output).is_err());
}

#[test]
fn avatar_cap_rejects_before_appending_crossing_chunk() {
    // The streaming accumulator must reject a chunk that would cross the
    // cap BEFORE buffering it — this is what bounds memory when
    // Content-Length is missing or dishonest.
    let mut buf = vec![0u8; MAX_AVATAR_FETCH_BYTES - 1];
    assert!(append_within_avatar_cap(&mut buf, &[0u8]).is_ok());
    assert_eq!(buf.len(), MAX_AVATAR_FETCH_BYTES);
    // Exactly at the cap: one more byte must fail and not grow the buffer.
    assert!(append_within_avatar_cap(&mut buf, &[0u8]).is_err());
    assert_eq!(buf.len(), MAX_AVATAR_FETCH_BYTES);

    // A single oversized chunk is rejected outright.
    let mut fresh = Vec::new();
    let oversized = vec![0u8; MAX_AVATAR_FETCH_BYTES + 1];
    assert!(append_within_avatar_cap(&mut fresh, &oversized).is_err());
    assert!(fresh.is_empty());
}

#[test]
fn save_rejects_plain_png_without_snapshot_chunk() {
    // A plain PNG (no buzz_agent_snapshot chunk) must not be saveable as
    // a card. Exercise the same validation the command runs.
    let img = image::DynamicImage::new_rgba8(4, 4);
    let mut png = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .unwrap();
    assert!(decode_snapshot_png(&png).is_err());
}

#[test]
fn archived_sidecar_without_memory_level_defaults_to_none() {
    // Every mint before the memory option existed embedded MemoryLevel::None
    // structurally, so old sidecars (no memoryLevel field) must deserialize
    // to None — the gallery's disclosure depends on this being honest.
    let legacy = r#"{
        "storedFileName": "eva-1234.agent.png",
        "fileName": "eva.agent.png",
        "agentId": "abc",
        "agentName": "Eva",
        "designerNotes": "",
        "locked": false,
        "mintedAt": "2026-07-28T00:00:00Z"
    }"#;
    let meta: ArchivedCardMeta = serde_json::from_str(legacy).unwrap();
    assert_eq!(meta.memory_level, MemoryLevel::None);

    let with_level = legacy.replace(
        "\"locked\": false,",
        "\"locked\": false, \"memoryLevel\": \"everything\",",
    );
    let meta: ArchivedCardMeta = serde_json::from_str(&with_level).unwrap();
    assert_eq!(meta.memory_level, MemoryLevel::Everything);
}

#[test]
fn minted_card_serializes_memory_level_snake_case_value() {
    // The TS layer narrows on the exact wire strings "none"/"core"/
    // "everything" — pin the serde representation the frontend will see.
    let minted = MintedCard {
        card_png_base64: String::new(),
        file_name: "eva.agent.png".to_string(),
        designer_notes: String::new(),
        locked: false,
        memory_level: MemoryLevel::Core,
    };
    let json = serde_json::to_value(&minted).unwrap();
    assert_eq!(json["memoryLevel"], "core");
}
