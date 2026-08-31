//! Flush-loop behavior against a stub relay: the mid-sweep tombstone
//! barrier, publish-time re-signing, and the stuck-row failure signal.
//!
//! Split out of `tests.rs` rather than appended to it: that file is at the
//! desktop file-size ratchet, and these cases are about what happens when a
//! retained row actually goes over the wire, not about how persona events
//! are shaped.
//!
//! Gated off Windows for the same reason as `archive::real_relay`:
//! `build_app_state()` pulls native DLLs unavailable in the Windows CI
//! runner. This stub-relay test is hermetic (localhost axum) otherwise.
#![cfg(not(target_os = "windows"))]

use super::*;
use crate::app_state::build_app_state;
use crate::managed_agents::retention::{
    get_retained_event, open_retention_db, retain_event, tombstone_retention_d_tag, RetainedEvent,
};
use buzz_core_pkg::kind::KIND_TEAM;
use nostr::JsonUtil;

/// Stub relay: `POST /events` rejects kind:5 with HTTP 500, accepts
/// everything else. Returns the HTTP base URL.
async fn spawn_stub_relay() -> String {
    use axum::{http::StatusCode, routing::post, Router};

    let app = Router::new().route(
        "/events",
        post(|body: String| async move {
            let event: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
            if event.get("kind").and_then(serde_json::Value::as_u64) == Some(5) {
                return (StatusCode::INTERNAL_SERVER_ERROR, String::new());
            }
            (
                StatusCode::OK,
                serde_json::json!({
                    "event_id": event.get("id").and_then(serde_json::Value::as_str).unwrap_or(""),
                    "accepted": true,
                    "message": ""
                })
                .to_string(),
            )
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind stub relay");
    let addr = listener.local_addr().expect("stub relay addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });
    format!("http://{addr}")
}

fn retain_signed(
    conn: &rusqlite::Connection,
    keys: &nostr::Keys,
    kind: u32,
    retention_d_tag: &str,
    builder: nostr::EventBuilder,
    created_at: i64,
) {
    let event = builder.sign_with_keys(keys).expect("sign test event");
    retain_event(
        conn,
        &RetainedEvent {
            kind,
            pubkey: keys.public_key().to_hex(),
            d_tag: retention_d_tag.to_string(),
            content: event.content.to_string(),
            created_at,
            raw_event: event.as_json(),
            pending_sync: true,
        },
    )
    .expect("retain test event");
}

#[test]
fn archive_request_resign_refreshes_timestamp_and_preserves_payload() {
    use nostr::JsonUtil;

    let keys = nostr::Keys::generate();
    let target = nostr::Keys::generate().public_key().to_hex();
    let stale = crate::events::build_archive_identity_request(
        &target,
        "agent deleted",
        Some("retired"),
        None,
        None,
    )
    .unwrap()
    .custom_created_at(nostr::Timestamp::from(1))
    .sign_with_keys(&keys)
    .unwrap();
    let state = build_app_state();
    *state.keys.lock().unwrap() = keys;

    let fresh = resign_with_fresh_timestamp(&stale, &state).unwrap();

    assert!(fresh.created_at.as_secs() > stale.created_at.as_secs());
    assert_eq!(fresh.kind, stale.kind);
    assert_eq!(fresh.content, stale.content);
    assert_eq!(fresh.tags, stale.tags);
    assert!(fresh.verify_id());
    assert!(fresh.verify_signature());
    assert_ne!(fresh.as_json(), stale.as_json());
}

/// The mid-sweep barrier: a tombstone the relay rejects must defer its
/// own replacement to the next sweep (still pending, not counted as
/// flushed) while unrelated rows in the same sweep publish normally.
/// Failing toward stay-deleted is the safe direction — the deferred
/// replacement can never be wiped by its own late tombstone.
#[tokio::test]
async fn failed_tombstone_defers_replacement_within_sweep() {
    let keys = nostr::Keys::generate();
    let pubkey = keys.public_key().to_hex();
    let dir = tempfile::tempdir().expect("tempdir");
    let db_path = dir.path().join("retention.db");

    {
        let conn = open_retention_db(&db_path).expect("open db");
        // Tombstone (publishes first, relay rejects it).
        retain_signed(
            &conn,
            &keys,
            5,
            &tombstone_retention_d_tag(KIND_PERSONA, "covered"),
            build_persona_delete("covered", &pubkey).unwrap(),
            1000,
        );
        // Its replacement at the same coordinate (must defer).
        retain_signed(
            &conn,
            &keys,
            KIND_PERSONA,
            "covered",
            EventBuilder::new(Kind::Custom(KIND_PERSONA as u16), "{}")
                .tags(vec![Tag::parse(["d", "covered"]).unwrap()]),
            2000,
        );
        // Unrelated coordinate (must publish despite the barrier).
        retain_signed(
            &conn,
            &keys,
            KIND_PERSONA,
            "unrelated",
            EventBuilder::new(Kind::Custom(KIND_PERSONA as u16), "{}").tags(vec![Tag::parse([
                "d",
                "unrelated",
            ])
            .unwrap()]),
            1500,
        );
    }

    let state = build_app_state();
    *state.keys.lock().unwrap() = keys;
    *state.relay_url_override.lock().unwrap() = Some(spawn_stub_relay().await);

    let flushed = flush_pending_events(&db_path, &state).await.expect("flush");
    assert_eq!(flushed, 1, "only the unrelated row publishes");

    let conn = open_retention_db(&db_path).expect("reopen db");
    let row = |kind: u32, d_tag: &str| {
        get_retained_event(&conn, kind, &pubkey, d_tag)
            .unwrap()
            .unwrap()
    };
    assert!(
        row(5, &tombstone_retention_d_tag(KIND_PERSONA, "covered")).pending_sync,
        "failed tombstone stays pending"
    );
    assert!(
        row(KIND_PERSONA, "covered").pending_sync,
        "deferred replacement stays pending"
    );
    assert!(
        !row(KIND_PERSONA, "unrelated").pending_sync,
        "unrelated row marked synced"
    );
}

/// Stub relay mirroring the real relay's `MAX_TIMESTAMP_DRIFT_SECS`
/// check: rejects any event whose `created_at` is more than 900s from
/// "now", accepts everything inside that window. Used to prove a row
/// queued during a long outage is republished with a fresh timestamp —
/// not just that the pure predicate says so (`freshness_tests.rs`), but
/// that the full flush path actually gets it past a relay that enforces
/// it.
async fn spawn_freshness_checking_stub_relay() -> String {
    use axum::{http::StatusCode, routing::post, Router};

    let app = Router::new().route(
        "/events",
        post(|body: String| async move {
            let event: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64;
            let created_at = event
                .get("created_at")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(now);
            if (created_at - now).abs() > 900 {
                return (
                    StatusCode::BAD_REQUEST,
                    serde_json::json!({
                        "event_id": "",
                        "accepted": false,
                        "message": "event timestamp too far from server time"
                    })
                    .to_string(),
                );
            }
            (
                StatusCode::OK,
                serde_json::json!({
                    "event_id": event.get("id").and_then(serde_json::Value::as_str).unwrap_or(""),
                    "accepted": true,
                    "message": ""
                })
                .to_string(),
            )
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind stub relay");
    let addr = listener.local_addr().expect("stub relay addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });
    format!("http://{addr}")
}

/// Reproduces the reported failure directly: a kind:30176 (team) row
/// queued during a relay outage (real observed shape: retained at 18:38,
/// still pending at 20:23, ~105 minutes) must still reach a relay that
/// enforces the timestamp drift window, because the flush re-signs any
/// row outside the freshness margin before publishing — regardless of
/// kind. Before that re-sign existed, this exact row would have been
/// refused on every sweep forever with "event timestamp too far from
/// server time", which is what produced "conflict: missing reference in
/// task.owningTeamId" for every chat Task in the community.
#[tokio::test]
async fn a_stale_team_event_still_reaches_a_relay_that_enforces_drift() {
    let keys = nostr::Keys::generate();
    let pubkey = keys.public_key().to_hex();
    let dir = tempfile::tempdir().expect("tempdir");
    let db_path = dir.path().join("retention.db");

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let stranded = now - (105 * 60);

    {
        let conn = open_retention_db(&db_path).expect("open db");
        retain_signed(
            &conn,
            &keys,
            KIND_TEAM,
            "builtin-team:company-coordination",
            EventBuilder::new(
                Kind::Custom(KIND_TEAM as u16),
                r#"{"name":"Company Coordination"}"#,
            )
            .tags(vec![
                Tag::parse(["d", "builtin-team:company-coordination"]).unwrap()
            ])
            .custom_created_at(nostr::Timestamp::from(stranded as u64)),
            stranded,
        );
    }

    let state = build_app_state();
    *state.keys.lock().unwrap() = keys;
    *state.relay_url_override.lock().unwrap() = Some(spawn_freshness_checking_stub_relay().await);

    let flushed = flush_pending_events(&db_path, &state).await.expect("flush");
    assert_eq!(
        flushed, 1,
        "a stale team row must be re-signed and accepted, not refused forever"
    );

    let conn = open_retention_db(&db_path).expect("reopen db");
    let row = get_retained_event(
        &conn,
        KIND_TEAM,
        &pubkey,
        "builtin-team:company-coordination",
    )
    .unwrap()
    .unwrap();
    assert!(!row.pending_sync, "the row must be marked synced");
}

/// A row the relay keeps refusing must surface to the user after 3
/// consecutive sweeps rather than failing silently forever, and must stop
/// counting the moment it succeeds. Before `record_sync_failure` existed,
/// the only trace of a stuck row was an `eprintln!` nobody reading the
/// packaged app ever sees — the owner hit this bug ~10 times with nothing
/// on screen to explain why.
#[test]
fn three_consecutive_failures_cross_the_stuck_threshold_then_reset_on_success() {
    let pubkey = nostr::Keys::generate().public_key().to_hex();

    assert_eq!(
        record_sync_failure(None, KIND_TEAM, &pubkey, "coord", "refused"),
        1
    );
    assert_eq!(
        record_sync_failure(None, KIND_TEAM, &pubkey, "coord", "refused"),
        2
    );
    assert_eq!(
        record_sync_failure(None, KIND_TEAM, &pubkey, "coord", "refused"),
        STUCK_ROW_FAILURE_THRESHOLD,
        "the 3rd consecutive failure must cross the threshold"
    );

    clear_sync_failure(KIND_TEAM, &pubkey, "coord");

    assert_eq!(
        record_sync_failure(None, KIND_TEAM, &pubkey, "coord", "refused"),
        1,
        "a success must reset the streak so the next failure starts from zero"
    );
}
