//! Kind:0 role publication — the field that lets one member's client
//! recognise another member's instance of the same workspace role.

use super::build_profile_event;

#[test]
fn profile_event_publishes_the_workspace_role() {
    let agent_keys = nostr::Keys::generate();
    let event = build_profile_event(&agent_keys, "TestBot", None, None, Some("chief-of-staff"))
        .expect("should succeed with a role");
    let content: serde_json::Value =
        serde_json::from_str(&event.content).expect("kind:0 content is JSON");
    assert_eq!(
        content.get("role").and_then(serde_json::Value::as_str),
        Some("chief-of-staff"),
        "the role is what lets another member's client group instances"
    );
}

#[test]
fn profile_event_omits_role_when_the_agent_fills_none() {
    let agent_keys = nostr::Keys::generate();
    let event = build_profile_event(&agent_keys, "TestBot", None, None, None)
        .expect("should succeed without a role");
    let content: serde_json::Value =
        serde_json::from_str(&event.content).expect("kind:0 content is JSON");
    assert!(content.get("role").is_none());
}
