//! Publish-time freshness of queued events.
//!
//! Split out of `tests.rs` rather than appended to it: that file is at the
//! desktop file-size ratchet, and these cases are about when a retained row
//! must be re-signed before it goes to the relay, not about how persona
//! events are shaped.

use super::*;

/// A row queued during a relay outage longer than the relay's drift window must
/// be re-signed at publish time, not sent with its original timestamp.
///
/// The relay refuses anything outside ±15 minutes
/// (`MAX_TIMESTAMP_DRIFT_SECS`), and this queue exists because the relay was
/// unreachable. Without re-signing, an outage longer than that window strands
/// every row queued during it permanently: the sweep re-sends the same stale
/// `created_at` every 30 seconds and the relay refuses it every time. A 1h45m
/// canary outage on 2026-08-30 left a coordination team unpublishable exactly
/// this way, which then failed every chat Task in that community with
/// "missing reference in task.owningTeamId".
#[test]
fn a_row_stranded_by_a_long_outage_is_republished_with_a_fresh_timestamp() {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    // The real observed case: retained at 18:38, still pending at 20:23.
    let stranded = now - (105 * 60);
    assert!(
        is_outside_publish_freshness_window(stranded),
        "a row queued 1h45m ago must be re-signed, not sent stale"
    );

    // Just-published rows must NOT churn their ids on every sweep.
    assert!(!is_outside_publish_freshness_window(now));
    assert!(!is_outside_publish_freshness_window(now - 60));
}

/// The window is absolute, because a retained row can sit AHEAD of the clock.
///
/// `monotonic_created_at` bumps past a future-dated head, so a device that once
/// saw a future timestamp carries it forward. The relay rejects both directions
/// with the same message, so measuring elapsed time alone would miss half of it.
#[test]
fn the_freshness_window_catches_future_timestamps_too() {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    assert!(is_outside_publish_freshness_window(now + 105 * 60));
    assert!(!is_outside_publish_freshness_window(now + 60));
}
