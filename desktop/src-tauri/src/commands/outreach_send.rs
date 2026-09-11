//! Owner-side send for an approved `@outreach-email` card.
//!
//! The agent that wrote the card holds no send tool. When the owner presses
//! Approve, the desktop runs the deterministic Gmail journey inside the tab
//! the owner already has open in the shared Web session, so the mail leaves
//! the owner's own mailbox with the owner watching it happen.
//!
//! This module refuses rather than improvises: no shared Web session, a tab
//! that is not Gmail, or an action event id that already ran are all failures
//! with an owner-readable reason, never a second send.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::State;
use url::Url;

use crate::app_state::AppState;

use buzz_browser_pkg::{
    cdp::CdpClient, host::attach, host::TargetInfo, mail::run_mail_send_journey,
};

/// The Gmail host the shared tab must already be on. The journey clicks the
/// Compose button in place and never navigates, so the owner keeps their
/// session, their signature, and their sent-mail record.
const GMAIL_HOST: &str = "mail.google.com";

const HEX_64: usize = 64;

/// Owner-readable refusal when no single shared Web tab is live.
const NO_SHARED_TAB: &str = "Open your Gmail in the Web tab and try Approve again.";
/// Owner-readable refusal when the shared tab is on some other site.
const NOT_GMAIL: &str = "The Web tab is not on Gmail. Open mail.google.com and try Approve again.";
/// Owner-readable refusal when this approval already ran in this session.
const ALREADY_RAN: &str = "This card was already sent from this desktop session.";

/// The slice of an `outreach-email` instance the send actually needs.
///
/// Unknown fields are tolerated on purpose: the card carries lead ids, an
/// expiry, and a status this module has no business interpreting.
#[derive(Debug, Clone, Deserialize)]
pub struct OutreachEmailData {
    /// The exact recipient mailbox, sent verbatim.
    pub destination: String,
    /// The exact subject and body, sent verbatim.
    pub content: OutreachEmailContent,
}

/// The approved subject and body, sent exactly as the owner read them.
#[derive(Debug, Clone, Deserialize)]
pub struct OutreachEmailContent {
    /// Subject line of the approved email.
    pub subject: String,
    /// Plain-text body of the approved email.
    pub body: String,
}

/// What the send did, in the shape the owner-side broker receipts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum OutreachSendOutcome {
    /// Gmail confirmed the send.
    Sent {
        /// Unix seconds at which the journey finished.
        sent_at: u64,
        /// Recipient the journey typed.
        to: String,
        /// Subject the journey typed.
        subject: String,
    },
    /// The send did not happen, with a reason fit to show the owner.
    Failed {
        /// Why the send did not happen.
        failure_reason: String,
    },
}

fn failed(reason: impl Into<String>) -> OutreachSendOutcome {
    OutreachSendOutcome::Failed {
        failure_reason: reason.into(),
    }
}

/// Action event ids this process has already begun a send for.
///
/// Claimed before the journey runs and never released: a journey that fails
/// after clicking Send has still sent, so a retry must not run the form again.
fn attempted_actions() -> &'static Mutex<HashSet<String>> {
    static ATTEMPTED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    ATTEMPTED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Claim an action event id for exactly one send attempt.
///
/// Returns `true` for the first caller and `false` for every caller after it.
/// A poisoned registry claims nothing, which refuses the send rather than
/// risking a duplicate.
pub(crate) fn claim_attempt(registry: &Mutex<HashSet<String>>, action_event_id: &str) -> bool {
    match registry.lock() {
        Ok(mut claimed) => claimed.insert(action_event_id.to_string()),
        Err(_) => false,
    }
}

fn is_event_id(value: &str) -> bool {
    value.len() == HEX_64 && value.chars().all(|c| c.is_ascii_hexdigit())
}

/// The shared tab, when it exists and is on Gmail.
///
/// Errors carry the owner-readable refusal, not a diagnostic: the owner's
/// only useful next move is to open Gmail in the Web tab.
pub(crate) fn gmail_target<'a>(
    targets: &'a [TargetInfo],
    target_id: &str,
) -> Result<&'a TargetInfo, String> {
    let target = targets
        .iter()
        .find(|candidate| candidate.id == target_id)
        .ok_or_else(|| NO_SHARED_TAB.to_string())?;
    let host = Url::parse(&target.url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase));
    match host.as_deref() {
        Some(GMAIL_HOST) => Ok(target),
        _ => Err(NOT_GMAIL.to_string()),
    }
}

/// Send one approved outreach email from the owner's own open Gmail tab.
///
/// Refuses unless the owner has exactly one shared Web session open on Gmail,
/// and runs at most once per `action_event_id` for the life of the process.
#[tauri::command]
pub async fn execute_outreach_send(
    instance_event_id: String,
    action_event_id: String,
    data: OutreachEmailData,
    state: State<'_, AppState>,
) -> Result<OutreachSendOutcome, String> {
    if !is_event_id(&instance_event_id) || !is_event_id(&action_event_id) {
        return Ok(failed(
            "This approval is malformed. Reopen the card and try again.",
        ));
    }
    let Some((endpoint, target_id)) = state.web_sessions.shared_endpoint() else {
        return Ok(failed(NO_SHARED_TAB));
    };
    let host = match attach(&endpoint).await {
        Ok(host) => host,
        Err(_) => return Ok(failed(NO_SHARED_TAB)),
    };
    let targets = match host.list_targets().await {
        Ok(targets) => targets,
        Err(_) => return Ok(failed(NO_SHARED_TAB)),
    };
    let ws_url = match gmail_target(&targets, &target_id) {
        Ok(target) => target.ws_url.clone(),
        Err(reason) => return Ok(failed(reason)),
    };
    if !claim_attempt(attempted_actions(), &action_event_id) {
        return Ok(failed(ALREADY_RAN));
    }
    let mut client = match CdpClient::connect(&ws_url).await {
        Ok(client) => client,
        Err(_) => return Ok(failed(NO_SHARED_TAB)),
    };
    // No `compose_url`: the journey must start from the Compose button in the
    // tab the owner is looking at, never by navigating it somewhere else.
    let result = run_mail_send_journey(
        &mut client,
        &data.destination,
        &data.content.subject,
        &data.content.body,
        "",
    )
    .await;
    Ok(if result.status == "sent" {
        OutreachSendOutcome::Sent {
            sent_at: result.sent_at,
            to: result.to,
            subject: result.subject,
        }
    } else {
        failed(
            result
                .failure_reason
                .unwrap_or_else(|| "Gmail did not confirm the send.".to_string()),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(id: &str, url: &str) -> TargetInfo {
        TargetInfo {
            id: id.to_string(),
            url: url.to_string(),
            title: String::new(),
            ws_url: format!("ws://127.0.0.1:9222/devtools/page/{id}"),
        }
    }

    #[test]
    fn a_missing_shared_tab_tells_the_owner_to_open_gmail() {
        let targets = vec![target("tab-a", "https://mail.google.com/mail/u/0/#inbox")];
        assert_eq!(
            gmail_target(&targets, "tab-gone").unwrap_err(),
            NO_SHARED_TAB,
            "a target id the browser no longer has is the same problem as no tab at all"
        );
        assert_eq!(
            gmail_target(&[], "tab-a").unwrap_err(),
            NO_SHARED_TAB,
            "no live targets refuses instead of sending"
        );
    }

    #[test]
    fn a_tab_on_another_site_is_refused_by_host() {
        for url in [
            "https://example.com/mail.google.com",
            "https://mail.google.com.evil.example/inbox",
            "about:blank",
        ] {
            let targets = vec![target("tab-a", url)];
            assert_eq!(
                gmail_target(&targets, "tab-a").unwrap_err(),
                NOT_GMAIL,
                "expected {url} to be refused as not Gmail"
            );
        }
    }

    #[test]
    fn the_owners_open_gmail_tab_is_accepted() {
        let targets = vec![
            target("tab-a", "https://news.example/story"),
            target("tab-b", "https://mail.google.com/mail/u/0/#inbox"),
        ];
        let chosen = gmail_target(&targets, "tab-b").expect("the Gmail tab should be usable");
        assert_eq!(chosen.id, "tab-b", "the shared target id picks the tab");
    }

    #[test]
    fn an_action_event_id_can_only_be_claimed_once() {
        let registry = Mutex::new(HashSet::new());
        let action = "c".repeat(64);
        assert!(
            claim_attempt(&registry, &action),
            "the first approval must be allowed to send"
        );
        assert!(
            !claim_attempt(&registry, &action),
            "a replayed approval must never send the same email twice"
        );
        assert!(
            claim_attempt(&registry, &"d".repeat(64)),
            "a different approval is a different send"
        );
    }

    #[test]
    fn malformed_event_ids_are_rejected() {
        assert!(is_event_id(&"a".repeat(64)));
        assert!(!is_event_id(&"a".repeat(63)));
        assert!(!is_event_id(&"z".repeat(64)));
        assert!(!is_event_id(""));
    }
}
