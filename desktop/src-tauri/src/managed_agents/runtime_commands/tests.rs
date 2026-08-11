use super::*;

fn payload(
    relay_url: &str,
    lifecycle: ManagedAgentRuntimeLifecycle,
    error: Option<&str>,
) -> super::super::ManagedAgentRuntimeLifecycleObserverPayload {
    super::super::ManagedAgentRuntimeLifecycleObserverPayload {
        pubkey: "aa".repeat(32),
        relay_url: relay_url.into(),
        start_nonce: "test-generation".into(),
        lifecycle,
        error: error.map(str::to_owned),
    }
}

fn record_with_relay(relay_url: &str) -> super::super::ManagedAgentRecord {
    serde_json::from_str(&format!(
        r#"{{
            "pubkey": "{}",
            "name": "pin-test",
            "relay_url": "{relay_url}",
            "acp_command": "buzz-acp",
            "agent_command": "goose",
            "agent_args": [],
            "mcp_command": "",
            "turn_timeout_seconds": 320,
            "system_prompt": "",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z"
        }}"#,
        "aa".repeat(32)
    ))
    .unwrap()
}

#[test]
fn legacy_relay_pin_is_ignored_for_fan_out() {
    // Zero-touch cutover (#2122): a record carrying a creation-era
    // `relay_url` pin must fan out exactly like an unpinned one — the
    // stored field is parsed but never consulted. See
    // `effective_agent_relay_url`.
    let unpinned = record_with_relay("");
    let pinned = record_with_relay("wss://one.example");
    for record in [&unpinned, &pinned] {
        assert_eq!(
            crate::relay::effective_agent_relay_url(&record.relay_url, "wss://two.example"),
            "wss://two.example"
        );
    }
}

#[test]
fn empty_relay_pin_must_be_resolved_before_it_becomes_a_runtime_key() {
    // The failure a start path hits when it passes a record's raw pin instead
    // of the resolved workspace relay. Records written before #2122 carry an
    // empty pin, and an empty string is not a relative URL with any base, so
    // the key constructor rejects it with a message that blames the relay
    // rather than the stale record. Resolving first is what makes it work, so
    // pin both halves: the raw pin fails, the resolved value succeeds.
    let record = record_with_relay("");
    let pubkey = "aa".repeat(32);

    let raw = ManagedAgentRuntimeKey::new(pubkey.clone(), &record.relay_url);
    let message = raw.expect_err("an empty relay pin cannot form a runtime key");
    assert!(
        message.contains("relative URL without a base"),
        "expected the url-parse failure users see, got {message:?}"
    );

    let resolved = crate::relay::effective_agent_relay_url(&record.relay_url, "wss://two.example");
    let key = ManagedAgentRuntimeKey::new(pubkey, &resolved)
        .expect("the resolved workspace relay forms a key");
    assert_eq!(key.relay_url, "wss://two.example");
}

#[test]
fn start_path_resolves_the_relay_instead_of_reading_the_record_pin() {
    // `effective_agent_relay_url` is documented as the one choke point all
    // agent relay resolution flows through, but nothing enforced that, and
    // `start_local_agent_with_preflight` bound the raw pin instead. That is
    // unreachable from a unit test (it needs a live AppHandle), and the
    // symptom only appears on a pre-#2122 record, so the invariant is pinned
    // at the source. If a start path legitimately needs the raw field, widen
    // this check deliberately rather than deleting it.
    const START_COMMANDS: &str = include_str!("../../commands/agents.rs");
    assert!(
        !START_COMMANDS.contains("let relay_url = record.relay_url.clone();"),
        "a start path is binding the record's relay pin directly; resolve it \
         through effective_agent_relay_url so an empty pin on a legacy record \
         cannot fail the start with \"invalid relay URL\""
    );
    assert!(
        START_COMMANDS.contains("effective_agent_relay_url(&record_relay_pin"),
        "the single-agent start path no longer resolves its relay pin; it must \
         pass the pin through effective_agent_relay_url before the value can \
         reach ManagedAgentRuntimeKey"
    );
}

#[test]
fn unkeyable_relay_degrades_to_failed_row() {
    // A requested URL that cannot form a pair key must still yield a
    // Failed row keyed by the raw requested string, so one bad community
    // never aborts the rest of the reconcile batch.
    let record = record_with_relay("");
    let status = unkeyable_failed_status(
        &record,
        "not a url".to_string(),
        "relay access probe timed out".to_string(),
        &[],
        &super::super::GlobalAgentConfig::default(),
    );
    assert!(matches!(
        status.lifecycle,
        ManagedAgentRuntimeLifecycle::Failed
    ));
    assert_eq!(status.relay_url, "not a url");
    assert_eq!(status.requested_relay_url.as_deref(), Some("not a url"));
    assert_eq!(status.pubkey, record.pubkey);
    assert_eq!(
        status.error.as_deref(),
        Some("relay access probe timed out")
    );
    assert!(status.pid.is_none());
}

#[test]
fn runtime_key_rejects_non_hex_pubkeys() {
    assert!(ManagedAgentRuntimeKey::new("../not-a-key", "wss://relay.example").is_err());
    assert!(ManagedAgentRuntimeKey::new("gg".repeat(32), "wss://relay.example").is_err());
}

#[test]
fn runtime_key_canonicalizes_hex_pubkeys() {
    let key = ManagedAgentRuntimeKey::new("AA".repeat(32), "wss://relay.example").unwrap();
    assert_eq!(key.pubkey, "aa".repeat(32));
}

#[test]
fn observer_lifecycle_key_preserves_exact_canonical_pair() {
    let first = payload(
        "WSS://Relay.Example:443/",
        ManagedAgentRuntimeLifecycle::Ready,
        None,
    );
    let key = observer_lifecycle_key(&first.pubkey, &first).unwrap();
    assert_eq!(key.pubkey, first.pubkey);
    assert_eq!(key.relay_url, "wss://relay.example");

    let other = payload(
        "wss://other.example",
        ManagedAgentRuntimeLifecycle::Ready,
        None,
    );
    assert_ne!(key, observer_lifecycle_key(&other.pubkey, &other).unwrap());
}

#[test]
fn observer_lifecycle_rejects_cross_agent_and_desktop_states() {
    let ready = payload(
        "wss://relay.example",
        ManagedAgentRuntimeLifecycle::Ready,
        None,
    );
    assert!(observer_lifecycle_key(&"bb".repeat(32), &ready).is_err());

    let stopped = payload(
        "wss://relay.example",
        ManagedAgentRuntimeLifecycle::Stopped,
        None,
    );
    assert!(observer_lifecycle_key(&stopped.pubkey, &stopped).is_err());
}

#[test]
fn observer_lifecycle_enforces_failed_error_contract() {
    let failed = payload(
        "wss://relay.example",
        ManagedAgentRuntimeLifecycle::Failed,
        None,
    );
    assert!(observer_lifecycle_key(&failed.pubkey, &failed).is_err());

    let ready_with_error = payload(
        "wss://relay.example",
        ManagedAgentRuntimeLifecycle::Ready,
        Some("unexpected"),
    );
    assert!(observer_lifecycle_key(&ready_with_error.pubkey, &ready_with_error).is_err());
}
