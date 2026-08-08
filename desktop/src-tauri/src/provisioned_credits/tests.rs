use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Barrier;

#[test]
fn gateway_upstream_uses_http_origin_and_path() {
    assert_eq!(
        normalized_gateway_upstream("wss://Relay.Example:443/").unwrap(),
        "https://relay.example/gateway/openai"
    );
    assert_eq!(
        normalized_gateway_upstream("http://relay.example///").unwrap(),
        "http://relay.example/gateway/openai"
    );
    assert!(normalized_gateway_upstream("wss://user:pass@relay.example/path?x=1").is_err());
}

#[test]
fn balance_parser_is_signed_integer_safe() {
    assert_eq!(parse_balance_nanousd("123456789"), Ok(123_456_789));
    assert_eq!(parse_balance_nanousd("-1"), Ok(-1));
    assert!(parse_balance_nanousd("1.25").is_err());
    assert!(parse_balance_nanousd("999999999999999999999999999999999999999999999999").is_err());
}

#[test]
fn lease_ttl_is_bounded_to_one_day() {
    assert_eq!(GATEWAY_TOKEN_TTL_SECS, 86_400);
    assert!(validate_lease_expiry(Utc::now() + ChronoDuration::hours(24)).is_ok());
    assert!(validate_lease_expiry(
        Utc::now() + ChronoDuration::hours(24) + ChronoDuration::minutes(1)
    )
    .is_err());
    assert!(validate_lease_expiry(Utc::now() - ChronoDuration::seconds(1)).is_err());
    let body = serde_json::json!({"ttl_secs": GATEWAY_TOKEN_TTL_SECS});
    assert_eq!(body["ttl_secs"], serde_json::json!(86_400));
}

#[test]
fn one_day_lease_refreshes_before_expiry_without_an_immediate_loop() {
    let issued = Utc::now();
    let expires = issued + ChronoDuration::hours(24);
    let refresh_at = lease_refresh_at(issued, expires);
    assert!(refresh_at > issued + ChronoDuration::hours(11));
    assert!(refresh_at < expires);
    assert_eq!((refresh_at - issued).num_hours(), 12);
}

#[test]
fn account_requires_usd_and_matching_status() {
    let account: GatewayAccount = serde_json::from_value(serde_json::json!({
        "balance_nanousd": "-1",
        "currency": "USD",
        "status": "depleted"
    }))
    .expect("account wire shape");
    assert_eq!(account.balance_nanousd_i128(), Ok(-1));

    let mismatch = GatewayAccount {
        balance_nanousd: "0".to_string(),
        currency: "USD".to_string(),
        status: GatewayAccountStatus::Active,
    };
    assert!(mismatch.balance_nanousd_i128().is_err());
}

#[test]
fn token_debug_is_redacted_and_cache_keys_are_isolated() {
    let token = RedactedToken::new("colony-gw-secret".to_string()).expect("token");
    assert!(!format!("{token:?}").contains("colony-gw-secret"));
    let first = GatewayLeaseKey::new("wss://relay.example/", &"aa".repeat(32)).unwrap();
    let other_relay = GatewayLeaseKey::new("wss://other.example/", &"aa".repeat(32)).unwrap();
    let other_owner = GatewayLeaseKey::new("wss://relay.example/", &"bb".repeat(32)).unwrap();
    assert_ne!(first, other_relay);
    assert_ne!(first, other_owner);
    let mut manager = ProvisionedCreditsManager::default();
    manager.replace_primary(
        GatewayLease {
            key: first.clone(),
            token,
            generation: 1,
            expires_at: Utc::now() + ChronoDuration::days(30),
            refresh_at: Utc::now() + ChronoDuration::days(15),
        },
        None,
    );
    assert!(manager.contains(&first));
}

fn test_key(owner_byte: char) -> ManagedAgentRuntimeKey {
    ManagedAgentRuntimeKey::new(owner_byte.to_string().repeat(64), "wss://relay.example")
        .expect("test runtime key")
}

fn test_lease(key: &GatewayLeaseKey, token: &str) -> GatewayLease {
    GatewayLease {
        key: key.clone(),
        token: RedactedToken::new(token.to_string()).expect("test token"),
        generation: 1,
        expires_at: Utc::now() + ChronoDuration::days(30),
        refresh_at: Utc::now() + ChronoDuration::days(15),
    }
}

#[test]
fn partial_handoff_keeps_replacement_primary_and_old_for_failed_pair() {
    let cache_key =
        GatewayLeaseKey::new("wss://relay.example", &"aa".repeat(32)).expect("cache key");
    let old_pair = test_key('b');
    let successful_pair = test_key('c');
    let old = test_lease(&cache_key, "old-generation");
    let replacement = test_lease(&cache_key, "replacement-generation");
    let mut manager = ProvisionedCreditsManager::default();
    manager.replace_primary(
        replacement.clone(),
        Some(RetainedLease {
            lease: old.clone(),
            pair_keys: vec![old_pair.clone()],
        }),
    );

    assert_eq!(
        manager
            .cached(&cache_key, false)
            .expect("primary lease")
            .token
            .as_str(),
        replacement.token.as_str()
    );
    assert_eq!(manager.retained_pair_keys(&cache_key), vec![old_pair]);
    assert_eq!(
        manager
            .retained_snapshot(&cache_key)
            .expect("retained generation")
            .1
            .token
            .as_str(),
        old.token.as_str()
    );
    assert!(!manager
        .retained_pair_keys(&cache_key)
        .contains(&successful_pair));
}

#[test]
fn retry_converges_retained_pairs_and_takes_old_once() {
    let cache_key =
        GatewayLeaseKey::new("wss://relay.example", &"aa".repeat(32)).expect("cache key");
    let old = test_lease(&cache_key, "old-generation");
    let replacement = test_lease(&cache_key, "replacement-generation");
    let mut manager = ProvisionedCreditsManager::default();
    manager.replace_primary(
        replacement,
        Some(RetainedLease {
            lease: old.clone(),
            pair_keys: vec![test_key('b')],
        }),
    );

    let old_to_revoke = manager.update_retained_old(&cache_key, vec![]);
    assert_eq!(
        old_to_revoke.as_ref().map(|lease| lease.token.as_str()),
        Some(old.token.as_str())
    );
    assert!(manager.retained_pair_keys(&cache_key).is_empty());
    assert!(manager.take_retained_old(&cache_key).is_none());
}

#[test]
fn new_spawn_after_partial_handoff_reads_replacement_primary() {
    let cache_key =
        GatewayLeaseKey::new("wss://relay.example", &"aa".repeat(32)).expect("cache key");
    let replacement = test_lease(&cache_key, "replacement-generation");
    let mut manager = ProvisionedCreditsManager::default();
    manager.replace_primary(
        replacement.clone(),
        Some(RetainedLease {
            lease: test_lease(&cache_key, "old-generation"),
            pair_keys: vec![test_key('b')],
        }),
    );

    let spawn_lease = manager.cached(&cache_key, false).expect("spawn lease");
    assert_eq!(spawn_lease.token.as_str(), replacement.token.as_str());
}

#[test]
fn shutdown_deduplicates_old_token_references() {
    let cache_key =
        GatewayLeaseKey::new("wss://relay.example", &"aa".repeat(32)).expect("cache key");
    let old = test_lease(&cache_key, "old-generation");
    let replacement = test_lease(&cache_key, "replacement-generation");
    let mut manager = ProvisionedCreditsManager::default();
    manager.replace_primary(
        replacement.clone(),
        Some(RetainedLease {
            lease: old.clone(),
            pair_keys: vec![test_key('b')],
        }),
    );
    manager.enqueue_revocation(old.clone());
    manager.enqueue_revocation(old);

    let leases = manager.take_all_leases();
    assert_eq!(
        leases
            .iter()
            .filter(|lease| lease.token.as_str() == "old-generation")
            .count(),
        1,
        "the old generation must be revoked exactly once"
    );
    assert_eq!(
        leases
            .iter()
            .filter(|lease| lease.token.as_str() == "replacement-generation")
            .count(),
        1,
        "the primary replacement must be revoked exactly once"
    );
}

#[test]
fn per_key_rotation_gate_singleflights_without_manager_lock() {
    let key = GatewayLeaseKey::new("wss://relay.example", &"aa".repeat(32)).expect("cache key");
    let gate = {
        let mut manager = ProvisionedCreditsManager::default();
        manager.rotation_gate(&key)
    };
    let barrier = Arc::new(Barrier::new(3));
    let active = Arc::new(AtomicUsize::new(0));
    let max_active = Arc::new(AtomicUsize::new(0));
    let mut workers = Vec::new();
    for _ in 0..2 {
        let gate = Arc::clone(&gate);
        let barrier = Arc::clone(&barrier);
        let active = Arc::clone(&active);
        let max_active = Arc::clone(&max_active);
        workers.push(std::thread::spawn(move || {
            barrier.wait();
            let _guard = gate.lock().expect("singleflight gate");
            let now = active.fetch_add(1, Ordering::SeqCst) + 1;
            max_active.fetch_max(now, Ordering::SeqCst);
            std::thread::yield_now();
            active.fetch_sub(1, Ordering::SeqCst);
        }));
    }
    barrier.wait();
    for worker in workers {
        worker.join().expect("rotation worker completed");
    }
    assert_eq!(max_active.load(Ordering::SeqCst), 1);
}

#[test]
fn replaced_primary_invalidates_the_prior_refresh_generation() {
    let cache_key =
        GatewayLeaseKey::new("wss://relay.example", &"aa".repeat(32)).expect("cache key");
    let old = test_lease(&cache_key, "old-generation");
    let mut replacement = test_lease(&cache_key, "replacement-generation");
    replacement.generation = 2;
    let mut manager = ProvisionedCreditsManager::default();
    manager.replace_primary(old.clone(), None);
    manager.replace_primary(replacement.clone(), None);

    assert!(!manager.is_current_generation(&cache_key, old.generation));
    assert!(manager.is_current_generation(&cache_key, replacement.generation));
}
