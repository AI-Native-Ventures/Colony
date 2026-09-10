//! Bounded publishing for the company and thread-task integration fixtures.

use std::time::Duration;

use buzz_test_client::{BuzzTestClient, TestClientError};
use buzz_ws_client::{connection::PUBLISH_OK_TIMEOUT_SECS, OkResponse};
use nostr::Event;

/// Retry a missing transport answer or an explicit rate-limit rejection.
///
/// Every attempt reuses the identical signed event, and `send_event` only
/// returns acknowledgements matching that event's ID. All other answers return
/// untouched, including domain conflicts and claim replays resolved through a
/// receipt. Permission-negative tests continue to call `send_event` directly.
pub(super) async fn send_past_transport_stall(
    client: &mut BuzzTestClient,
    event: Event,
    what: &str,
) -> OkResponse {
    const MAX_ATTEMPTS: u64 = 8;
    // Preserve the fixtures' prior eight transport windows plus timeout backoff.
    let deadline = tokio::time::Instant::now()
        + Duration::from_secs(MAX_ATTEMPTS * PUBLISH_OK_TIMEOUT_SECS + 2);
    for attempt in 0..MAX_ATTEMPTS {
        assert!(
            tokio::time::Instant::now() < deadline,
            "{what}: publish retry deadline exceeded before sending"
        );
        let response = tokio::time::timeout_at(deadline, client.send_event(event.clone()))
            .await
            .unwrap_or_else(|_| panic!("{what}: publish retry deadline exceeded"));
        match response {
            Ok(ok) if !ok.accepted && ok.message.starts_with("rate-limited:") => {
                let hinted_seconds = ok
                    .message
                    .split_once("retry in ")
                    .and_then(|(_, hint)| hint.split_whitespace().next())
                    .and_then(|hint| hint.strip_suffix('s'))
                    .and_then(|seconds| seconds.parse::<u64>().ok())
                    .unwrap_or(10)
                    .max(1);
                let delay =
                    Duration::from_secs(hinted_seconds).saturating_add(Duration::from_millis(100));
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                assert!(
                    attempt + 1 < MAX_ATTEMPTS && delay < remaining,
                    "{what}: rate-limit retry exceeds the bounded publish budget"
                );
                eprintln!(
                    "{what} send attempt {attempt} rate limited; retrying the identical event after {delay:?}"
                );
                tokio::time::sleep(delay).await;
            }
            Ok(ok) => return ok,
            Err(TestClientError::Timeout) => {
                eprintln!("{what} send attempt {attempt} timed out, retrying");
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            Err(error) => panic!("{what}: {error}"),
        }
    }
    panic!("{what}: the relay never answered eight send attempts");
}
