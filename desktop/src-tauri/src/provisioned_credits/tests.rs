use super::*;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Duration as ChronoDuration;
use nostr::Keys;
use nostr::{Event, JsonUtil};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::sync::Barrier;
use std::thread;
use std::time::Duration;

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
        "total_balance_nanousd": "9",
        "discovery_reserved_nanousd": "10",
        "gateway_reserved_nanousd": "0",
        "available_balance_nanousd": "-1",
        "currency": "USD",
        "status": "depleted"
    }))
    .expect("account wire shape");
    assert_eq!(account.balance_nanousd_i128(), Ok(-1));

    let mismatch = GatewayAccount {
        balance_nanousd: "0".to_string(),
        total_balance_nanousd: "1".to_string(),
        discovery_reserved_nanousd: "0".to_string(),
        gateway_reserved_nanousd: "0".to_string(),
        available_balance_nanousd: "0".to_string(),
        currency: "USD".to_string(),
        status: GatewayAccountStatus::Active,
    };
    assert!(mismatch.balance_nanousd_i128().is_err());
}

#[test]
fn legacy_account_response_defaults_to_an_available_balance() {
    let account: GatewayAccount = serde_json::from_value(serde_json::json!({
        "balance_nanousd": "125000000",
        "currency": "USD",
        "status": "active"
    }))
    .expect("legacy account wire shape");

    assert_eq!(account.balance_nanousd_i128(), Ok(125_000_000));
    assert_eq!(account.total_balance_nanousd, "");
    assert_eq!(account.discovery_reserved_nanousd, "");
    assert_eq!(account.gateway_reserved_nanousd, "");
    assert_eq!(account.available_balance_nanousd, "");
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
            signer: Arc::new(Keys::generate()),
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
        signer: Arc::new(Keys::generate()),
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
fn shutdown_waits_for_an_inflight_rotation_gate_before_drain_snapshot() {
    let key = GatewayLeaseKey::new("wss://relay.example", &"aa".repeat(32)).unwrap();
    let gate = {
        let mut manager = ProvisionedCreditsManager::default();
        manager.rotation_gate(&key)
    };
    let entered = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let worker_gate = Arc::clone(&gate);
    let worker = thread::spawn(move || {
        let _rotation = worker_gate.lock().expect("rotation gate");
        entered.0.send(()).expect("signal rotation entry");
        release_rx.recv().expect("shutdown releases rotation");
    });
    entered
        .1
        .recv_timeout(Duration::from_secs(1))
        .expect("rotation entered before shutdown");

    let mut manager = ProvisionedCreditsManager::default();
    manager.rotation_gates.insert(key, gate);
    let gates = manager.begin_shutdown();
    assert!(manager.is_closed(), "shutdown closes new rotations first");
    let (drained_tx, drained_rx) = std::sync::mpsc::channel();
    let drainer = thread::spawn(move || {
        for gate in gates {
            let _rotation = gate.lock().expect("drain gate");
        }
        drained_tx.send(()).expect("signal drain completion");
    });
    assert!(
        drained_rx.recv_timeout(Duration::from_millis(50)).is_err(),
        "the drain snapshot must wait for the in-flight rotation"
    );
    release_tx.send(()).expect("release rotation");
    drained_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("drain proceeds after rotation");
    worker.join().expect("rotation worker exits");
    drainer.join().expect("drainer exits");
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

#[test]
fn stale_refresh_rechecks_generation_after_waiting_for_the_singleflight_gate() {
    let cache_key =
        GatewayLeaseKey::new("wss://relay.example", &"aa".repeat(32)).expect("cache key");
    let old = test_lease(&cache_key, "old-generation");
    let mut replacement = test_lease(&cache_key, "replacement-generation");
    replacement.generation = 2;
    let manager = Arc::new(Mutex::new(ProvisionedCreditsManager::default()));
    manager.lock().expect("manager").replace_primary(old, None);
    let gate = manager.lock().expect("manager").rotation_gate(&cache_key);
    let held = gate.lock().expect("hold generation gate");
    let waiting_manager = Arc::clone(&manager);
    let waiting_gate = Arc::clone(&gate);
    let stale = thread::spawn(move || {
        let _singleflight = waiting_gate.lock().expect("stale refresh gate");
        waiting_manager
            .lock()
            .expect("manager after gate")
            .is_current_generation(&cache_key, 1)
    });

    manager
        .lock()
        .expect("manager")
        .replace_primary(replacement, None);
    drop(held);
    assert!(
        !stale.join().expect("stale refresh exits"),
        "a callback that waited behind manual rotation must not mint a third generation"
    );
}

#[test]
fn identity_transition_removes_old_owner_generations_and_shutdown_closes_rotations() {
    let old_key = GatewayLeaseKey::new("wss://relay.example", &"aa".repeat(32)).unwrap();
    let new_key = GatewayLeaseKey::new("wss://relay.example", &"bb".repeat(32)).unwrap();
    let mut manager = ProvisionedCreditsManager::default();
    manager.replace_primary(test_lease(&old_key, "old"), None);
    manager.replace_primary(test_lease(&new_key, "new"), None);
    manager.enqueue_revocation(test_lease(&old_key, "old-pending"));

    let _gates = manager.begin_identity_transition();
    assert!(manager.is_identity_transitioning());
    let removed = manager.remove_owner_entries(&new_key.owner_pubkey);
    assert!(removed
        .iter()
        .all(|lease| lease.key.owner_pubkey == old_key.owner_pubkey));
    assert!(!manager.contains(&old_key));
    assert!(manager.contains(&new_key));
    manager.finish_identity_transition();
    assert!(!manager.is_identity_transitioning());

    let _shutdown_gates = manager.begin_shutdown();
    assert!(manager.is_closed());
}

#[test]
fn stale_generation_is_rejected_after_identity_cache_drain() {
    let key = GatewayLeaseKey::new("wss://relay.example", &"aa".repeat(32)).unwrap();
    let mut manager = ProvisionedCreditsManager::default();
    manager.replace_primary(test_lease(&key, "old"), None);
    let generation = manager.leases.get(&key).expect("lease").lease.generation;
    manager.begin_identity_transition();
    let _ = manager.remove_owner_entries(&"bb".repeat(32));
    assert!(!manager.is_current_generation(&key, generation));
}

fn test_http_server(status: &str, body: &str) -> (String, thread::JoinHandle<Vec<u8>>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind test gateway");
    let address = listener.local_addr().expect("gateway address");
    let status = status.to_string();
    let body = body.as_bytes().to_vec();
    let thread = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept gateway request");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("read timeout");
        let mut request = Vec::new();
        let mut chunk = [0_u8; 4096];
        let header_end = loop {
            let count = stream.read(&mut chunk).expect("read gateway request");
            if count == 0 {
                break None;
            }
            request.extend_from_slice(&chunk[..count]);
            if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                break Some(index + 4);
            }
        };
        if let Some(header_end) = header_end {
            let header = String::from_utf8_lossy(&request[..header_end]);
            let content_length = header
                .lines()
                .find_map(|line| {
                    line.strip_prefix("Content-Length:")?
                        .trim()
                        .parse::<usize>()
                        .ok()
                })
                .unwrap_or(0);
            while request.len() < header_end + content_length {
                let count = stream.read(&mut chunk).expect("read gateway body");
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..count]);
            }
        }
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(response.as_bytes()).expect("write status");
        stream.write_all(&body).expect("write body");
        request
    });
    (format!("http://{address}"), thread)
}

fn request_author_pubkey(request: &[u8]) -> String {
    let text = String::from_utf8_lossy(request);
    let auth = text
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            (name.eq_ignore_ascii_case("authorization"))
                .then(|| value.trim().strip_prefix("Nostr "))
                .flatten()
        })
        .expect("NIP-98 authorization");
    let event_json =
        String::from_utf8(BASE64.decode(auth).expect("NIP-98 base64")).expect("NIP-98 JSON");
    let event = Event::from_json(event_json).expect("NIP-98 event");
    assert!(event.verify_signature(), "NIP-98 event signature");
    event.pubkey.to_hex()
}

#[test]
fn production_http_helpers_mint_and_revoke_with_captured_owner_signer() {
    let signer = Arc::new(Keys::generate());
    let owner = signer.public_key().to_hex();
    let (origin, mint_thread) = test_http_server(
        "200 OK",
        &format!(
            "{{\"token\":\"test-gateway-token\",\"expires_at\":\"{}\"}}",
            (Utc::now() + ChronoDuration::hours(1)).to_rfc3339()
        ),
    );
    let key = GatewayLeaseKey::new(&origin, &owner).expect("lease key");
    let client = blocking_client().expect("blocking client");
    let lease =
        mint_lease_with_client(&client, key.clone(), 1, Arc::clone(&signer)).expect("mint lease");
    let mint_request = mint_thread.join().expect("mint server");
    assert_eq!(request_author_pubkey(&mint_request), owner);
    assert!(String::from_utf8_lossy(&mint_request).contains("\"ttl_secs\":86400"));

    let (revoke_origin, revoke_thread) = test_http_server("204 No Content", "");
    let revoke_key = GatewayLeaseKey::new(&revoke_origin, &owner).expect("revoke key");
    let revoke_lease = GatewayLease {
        key: revoke_key,
        token: lease.token,
        generation: lease.generation,
        expires_at: lease.expires_at,
        refresh_at: lease.refresh_at,
        signer,
    };
    revoke_lease_with_client(&client, &revoke_lease).expect("revoke lease");
    let revoke_request = revoke_thread.join().expect("revoke server");
    assert_eq!(request_author_pubkey(&revoke_request), owner);
    assert!(String::from_utf8_lossy(&revoke_request).contains("test-gateway-token"));
}
