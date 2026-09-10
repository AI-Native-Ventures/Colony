//! Deterministic Gmail compose-and-send journey.
//!
//! Drives a fixed sequence through Gmail's compose form using only
//! accessible-name prefixes (no CSS selectors). Used by the `mail_send`
//! MCP tool.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cdp::CdpClient;
use crate::contracts::BrowserError;
use crate::input::type_text;

/// Result of the `mail_send` journey.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MailSendResult {
    /// `"sent"` when the journey completed; `"failed"` otherwise.
    pub status: String,
    /// Human-readable reason when `status` is `"failed"`; `None` on success.
    pub failure_reason: Option<String>,
    /// Unix seconds at which the journey finished.
    pub sent_at: u64,
    /// The recipient email (echoed from input).
    pub to: String,
    /// The subject line (echoed from input).
    pub subject: String,
    /// Base64 PNG screenshot, when a screenshot was captured; `None` on failure.
    pub screenshot_png_base64: Option<String>,
}

/// Small helper so the journey reads as the five steps it is.
fn failed_result(
    to: &str,
    subject: &str,
    reason: String,
    screenshot: Option<String>,
) -> MailSendResult {
    MailSendResult {
        status: "failed".to_string(),
        failure_reason: Some(reason),
        sent_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        to: to.to_string(),
        subject: subject.to_string(),
        screenshot_png_base64: screenshot,
    }
}

/// A practical flat-tree search: the AX `nodes` array is flat.
fn collect_nodes_flat(ax_tree: &Value) -> Vec<Value> {
    ax_tree["nodes"].as_array().cloned().unwrap_or_default()
}

/// Find controls by accessible-name prefix in the flat AX nodes array.
/// Matches `name` exactly (starting with `prefix`) against `node["name"]["value"]`.
fn find_controls(
    ax_tree: &Value,
    to_prefix: &str,
    sub_prefix: &str,
    body_prefix: &str,
    send_prefix: &str,
) -> Option<(i64, i64, i64, i64)> {
    let nodes = collect_nodes_flat(ax_tree);
    let mut to_id: Option<i64> = None;
    let mut sub_id: Option<i64> = None;
    let mut body_id: Option<i64> = None;
    let mut send_id: Option<i64> = None;
    for n in &nodes {
        let name = n["name"]["value"].as_str().unwrap_or_default();
        let Some(id) = n["backendDOMNodeId"].as_i64() else {
            continue;
        };
        let role = n["role"]["value"].as_str().unwrap_or_default();
        if name.starts_with(to_prefix)
            && (role == "textbox" || role == "combobox")
            && to_id.is_none()
        {
            to_id = Some(id);
        }
        if name.starts_with(sub_prefix) && role == "textbox" && sub_id.is_none() {
            sub_id = Some(id);
        }
        if name.starts_with(body_prefix) && role == "textbox" && body_id.is_none() {
            body_id = Some(id);
        }
        if name.starts_with(send_prefix) && role == "button" && send_id.is_none() {
            send_id = Some(id);
        }
    }
    Some((to_id?, sub_id?, body_id?, send_id?))
}

/// Click a backend node by moving the mouse to its box center and sending
/// press/release events.
async fn click_by_backend(client: &mut CdpClient, backend_id: i64) -> Result<(), BrowserError> {
    if let Some((x, y)) = client.get_box_center(backend_id).await? {
        client
            .send_command(
                "Input.dispatchMouseEvent",
                serde_json::json!({
                    "type": "mouseMoved",
                    "x": x,
                    "y": y,
                    "button": "none"
                }),
            )
            .await?;
        tokio::time::sleep(Duration::from_millis(20)).await;
        client
            .send_command(
                "Input.dispatchMouseEvent",
                serde_json::json!({
                    "type": "mousePressed",
                    "x": x,
                    "y": y,
                    "button": "left",
                    "clickCount": 1
                }),
            )
            .await?;
        tokio::time::sleep(Duration::from_millis(60)).await;
        client
            .send_command(
                "Input.dispatchMouseEvent",
                serde_json::json!({
                    "type": "mouseReleased",
                    "x": x,
                    "y": y,
                    "button": "left",
                    "clickCount": 1
                }),
            )
            .await?;
    } else {
        return Err(BrowserError::Input(format!(
            "click_by_backend: no box for backend node {backend_id}"
        )));
    }
    Ok(())
}

/// The fixed Gmail compose journey.
///
/// 1. Navigate to `compose_url`.
/// 2. Wait (bounded, 30 s) for the AX tree to expose the four controls.
/// 3. Click recipient, type `to`; click subject, type `subject`; click body,
///    type `body`; click Send.
/// 4. Wait (bounded, 30 s) for the text "Message sent".
/// 5. Capture screenshot and return structured result.
///
/// Any missing control produces `failure_reason: "recipient control missing: ..."`
/// (or the equivalent for the other three controls) and `status: "failed"`.
pub async fn run_mail_send_journey(
    client: &mut CdpClient,
    to: &str,
    subject: &str,
    body: &str,
    compose_url: &str,
) -> MailSendResult {
    // Step 1: navigate.
    if let Err(e) = client.navigate(compose_url).await {
        return failed_result(to, subject, format!("navigation failed: {e}"), None);
    }

    // Step 2: bounded wait for controls (up to 30 s, bounded snapshot count).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut found: Option<(i64, i64, i64, i64)> = None;
    let mut attempts = 0usize;
    while tokio::time::Instant::now() < deadline && attempts < 30 {
        attempts += 1;
        if let Ok(ax) = client.get_ax_tree().await {
            found = find_controls(&ax, "To", "Subject", "Message Body", "Send");
        }
        if found.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }

    let (to_id, sub_id, body_id, send_id) = match found {
        Some(ids) => ids,
        None => {
            // Determine which control is missing for a precise failure reason.
            let reason = if attempts >= 30 || tokio::time::Instant::now() >= deadline {
                "timeout waiting for compose controls"
            } else {
                "compose controls missing"
            };
            // Try to get a partial diagnosis from the last AX snapshot.
            let diag = if let Ok(ax) = client.get_ax_tree().await {
                let nodes = collect_nodes_flat(&ax);
                let names: Vec<String> = nodes
                    .iter()
                    .filter_map(|n| n["name"]["value"].as_str())
                    .map(String::from)
                    .filter(|n| {
                        n.starts_with("To")
                            || n.starts_with("Subject")
                            || n.starts_with("Message Body")
                            || n.starts_with("Send")
                    })
                    .collect();
                if names.is_empty() {
                    "missing: To, Subject, Message Body, Send (none found in AX tree)".to_string()
                } else if !names.iter().any(|n| n.starts_with("To")) {
                    format!(
                        "missing recipient control (expected name starting with 'To', found: {})",
                        names.join(", ")
                    )
                } else if !names.iter().any(|n| n.starts_with("Subject")) {
                    format!("missing subject control (expected name starting with 'Subject', found: {})", names.join(", "))
                } else if !names.iter().any(|n| n.starts_with("Message Body")) {
                    format!("missing body control (expected name starting with 'Message Body', found: {})", names.join(", "))
                } else if !names.iter().any(|n| n.starts_with("Send")) {
                    format!(
                        "missing send control (expected name starting with 'Send', found: {})",
                        names.join(", ")
                    )
                } else {
                    format!("compose control mismatch (names: {})", names.join(", "))
                }
            } else {
                reason.to_string()
            };
            return failed_result(to, subject, diag, None);
        }
    };

    // Click recipient and type.
    if let Err(e) = click_by_backend(client, to_id).await {
        return failed_result(to, subject, format!("recipient click failed: {e}"), None);
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    if let Err(e) = type_text(client, to).await {
        return failed_result(to, subject, format!("recipient type failed: {e}"), None);
    }

    // Click subject and type.
    if let Err(e) = click_by_backend(client, sub_id).await {
        return failed_result(to, subject, format!("subject click failed: {e}"), None);
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    if let Err(e) = type_text(client, subject).await {
        return failed_result(to, subject, format!("subject type failed: {e}"), None);
    }

    // Click body and type.
    if let Err(e) = click_by_backend(client, body_id).await {
        return failed_result(to, subject, format!("body click failed: {e}"), None);
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    if let Err(e) = type_text(client, body).await {
        return failed_result(to, subject, format!("body type failed: {e}"), None);
    }

    // Click Send.
    if let Err(e) = click_by_backend(client, send_id).await {
        return failed_result(to, subject, format!("send click failed: {e}"), None);
    }

    // Step 3: bounded wait for "Message sent" (up to 30 s, bounded snapshot count).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut message_sent = false;
    let mut snapshot_attempts = 0usize;
    while tokio::time::Instant::now() < deadline && snapshot_attempts < 30 {
        snapshot_attempts += 1;
        if let Ok(ax) = client.get_ax_tree().await {
            let nodes = collect_nodes_flat(&ax);
            for n in &nodes {
                let name = n["name"]["value"].as_str().unwrap_or_default();
                if name.contains("Message sent") {
                    message_sent = true;
                    break;
                }
            }
        }
        if message_sent {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    // Capture screenshot regardless of message outcome (required output field).
    let screenshot_png = client.capture_screenshot().await.ok();

    if !message_sent {
        return failed_result(
            to,
            subject,
            "timeout: 'Message sent' did not appear within 30 s".to_string(),
            screenshot_png,
        );
    }

    MailSendResult {
        status: "sent".to_string(),
        failure_reason: None,
        sent_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        to: to.to_string(),
        subject: subject.to_string(),
        screenshot_png_base64: screenshot_png,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Accessible-name prefix matching runs without any browser.
    /// It proves the AX-tree scan logic used by the journey.
    fn sample_ax_for_match() -> Value {
        serde_json::json!({
            "nodes": [
                {
                    "nodeId": "n1",
                    "ignored": false,
                    "role": { "value": "combobox" },
                    "name": { "value": "To recipients" },
                    "value": { "value": "" },
                    "childIds": [],
                    "backendDOMNodeId": 101
                },
                {
                    "nodeId": "n2",
                    "ignored": false,
                    "role": { "value": "textbox" },
                    "name": { "value": "Subject" },
                    "value": { "value": "" },
                    "childIds": [],
                    "backendDOMNodeId": 102
                },
                {
                    "nodeId": "n3",
                    "ignored": false,
                    "role": { "value": "textbox" },
                    "name": { "value": "Message Body" },
                    "value": { "value": "hello" },
                    "childIds": [],
                    "backendDOMNodeId": 103
                },
                {
                    "nodeId": "n4",
                    "ignored": false,
                    "role": { "value": "button" },
                    "name": { "value": "Send \u{200e}(\u{2318}Enter)" },
                    "value": { "value": "" },
                    "childIds": [],
                    "backendDOMNodeId": 104
                }
            ]
        })
    }

    #[test]
    fn accessible_name_prefix_matching_finds_all_four_controls() {
        let ax = sample_ax_for_match();
        let ids = find_controls(&ax, "To", "Subject", "Message Body", "Send");
        assert!(ids.is_some(), "expected all four controls found");
        let (to, sub, body, send) = ids.unwrap();
        assert_eq!(to, 101, "recipient control should match 'To' prefix");
        assert_eq!(sub, 102, "subject control should match 'Subject' prefix");
        assert_eq!(body, 103, "body control should match 'Message Body' prefix");
        assert_eq!(
            send, 104,
            "send control should match 'Send' prefix (with bidi chars)"
        );
    }

    #[test]
    fn accessible_name_prefix_fails_when_send_is_missing() {
        let mut ax = sample_ax_for_match();
        // Remove the send button node.
        ax["nodes"]
            .as_array_mut()
            .unwrap()
            .retain(|n| n["name"]["value"].as_str() != Some("Send \u{200e}(\u{2318}Enter)"));
        let ids = find_controls(&ax, "To", "Subject", "Message Body", "Send");
        assert!(
            ids.is_none(),
            "expected failure when send control is missing"
        );
    }

    #[test]
    fn bidi_characters_in_send_name_do_not_break_prefix_match() {
        // The real name contains LTR-mark bidi characters: "Send \u{200e}(\u{2318}Enter)"
        // The prefix "Send" should still match.
        let ax = sample_ax_for_match();
        let ids = find_controls(&ax, "To", "Subject", "Message Body", "Send");
        assert!(ids.is_some(), "prefix 'Send' must survive bidi characters");
    }

    /// Real browser test: opens the fixture, runs the journey, and verifies
    /// both the sent result and the fixture's recorded JSON match.
    #[tokio::test]
    #[ignore = "requires a real browser; run with BUZZ_BROWSER_REAL=1"]
    async fn real_mail_send_journey_sends_email_from_fixture() {
        if std::env::var("BUZZ_BROWSER_REAL").is_err() {
            return;
        }
        use crate::host::{launch, HostConfig};
        let host = launch(&HostConfig::default()).await.unwrap();
        let target = host
            .list_targets()
            .await
            .unwrap()
            .into_iter()
            .next()
            .expect("expected at least one page target");
        let mut client = crate::cdp::CdpClient::connect(&target.ws_url)
            .await
            .unwrap();

        let fixture_url = "file://".to_string()
            + std::env::current_dir().unwrap().to_string_lossy().as_ref()
            + "/test-fixtures/gmail-compose.html";

        let result = run_mail_send_journey(
            &mut client,
            "lead@example.com",
            "Winter boiler special",
            "Hi team, our winter special is live.",
            &fixture_url,
        )
        .await;

        assert_eq!(
            result.status, "sent",
            "expected sent status: failure_reason={:?}",
            result.failure_reason
        );
        assert!(
            result.screenshot_png_base64.is_some(),
            "expected a screenshot in the result"
        );
        assert_eq!(result.to, "lead@example.com");
        assert_eq!(result.subject, "Winter boiler special");

        // Verify the fixture's recorded JSON equals the inputs.
        let recorded_json_str = client
            .evaluate("document.getElementById('sent').textContent")
            .await
            .unwrap();
        let recorded_json = recorded_json_str.as_str().unwrap_or("{}");
        assert!(
            recorded_json.contains("lead@example.com"),
            "fixture JSON should contain the recipient: {recorded_json}"
        );
        assert!(
            recorded_json.contains("Winter boiler special"),
            "fixture JSON should contain the subject: {recorded_json}"
        );
        assert!(
            recorded_json.contains("Hi team, our winter special is live."),
            "fixture JSON should contain the body: {recorded_json}"
        );
    }

    /// Prove the failure path: a fixture page with no Send button must return
    /// `failed` naming the send control.
    #[tokio::test]
    #[ignore = "requires a real browser; run with BUZZ_BROWSER_REAL=1"]
    async fn real_mail_send_journey_fails_when_send_is_missing() {
        if std::env::var("BUZZ_BROWSER_REAL").is_err() {
            return;
        }
        use crate::host::{launch, HostConfig};
        let host = launch(&HostConfig::default()).await.unwrap();
        let target = host
            .list_targets()
            .await
            .unwrap()
            .into_iter()
            .next()
            .expect("expected at least one page target");
        let mut client = crate::cdp::CdpClient::connect(&target.ws_url)
            .await
            .unwrap();

        let fixture_url = "file://".to_string()
            + std::env::current_dir().unwrap().to_string_lossy().as_ref()
            + "/test-fixtures/gmail-compose-no-send.html";

        let result = run_mail_send_journey(
            &mut client,
            "lead@example.com",
            "Winter boiler special",
            "Hello.",
            &fixture_url,
        )
        .await;

        assert_eq!(
            result.status, "failed",
            "expected failed status when send control is missing"
        );
        assert!(
            result.failure_reason.as_ref().unwrap().contains("Send"),
            "failure reason should name the missing send control: {:?}",
            result.failure_reason
        );
    }
}
