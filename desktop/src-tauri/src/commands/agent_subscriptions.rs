//! Tauri command surfacing which coding-agent subscriptions the user already has.
//!
//! Onboarding calls this once, before the user has agreed to anything, to
//! decide whether to lead with a subscription they already pay for rather than
//! with OpenRouter or Colony credits. See
//! [`crate::managed_agents::subscriptions`] for the detection rules and why
//! ranking is on remaining percentage.
//!
//! Everything here is filesystem work — a `PATH` lookup per harness plus one
//! config read — so it runs on the blocking pool and never touches the network.

use serde::Serialize;

use crate::managed_agents::find_command;
use crate::managed_agents::subscriptions::{
    claude_config_path, claude_state_from_path, recommended, DetectedHarness, HarnessState,
};

/// Harnesses probed, in the order onboarding lists them.
///
/// Only `claude` currently exposes a plan and usage. `codex` and `copilot` were
/// probed on 2026-08-30 and reported neither, so they appear as installed or
/// not and nothing more — the honest answer rather than a fabricated full quota.
const PROBED: &[&str] = &["claude", "codex", "opencode", "goose"];

/// What onboarding renders.
#[derive(Debug, Clone, Serialize)]
pub struct SubscriptionScan {
    /// Every probed harness with its detected state, in `PROBED` order.
    pub harnesses: Vec<DetectedHarness>,
    /// Id of the harness to mark as recommended, when one earns it. `None`
    /// means onboarding leads with OpenRouter instead.
    pub recommended_id: Option<String>,
}

/// Detect installed harnesses and any subscriptions behind them.
///
/// Never fails: a harness that cannot be read degrades to
/// [`HarnessState::NotInstalled`] or
/// [`HarnessState::InstalledNotSignedIn`] rather than erroring, because
/// onboarding has to render either way. The `Result` exists only so the
/// blocking-pool join can surface a panic.
#[tauri::command]
pub async fn scan_agent_subscriptions() -> Result<SubscriptionScan, String> {
    tokio::task::spawn_blocking(|| {
        let claude_installed = find_command("claude").is_some();
        let claude_state = match claude_config_path() {
            Some(path) => claude_state_from_path(&path, claude_installed),
            None if claude_installed => HarnessState::InstalledNotSignedIn,
            None => HarnessState::NotInstalled,
        };

        let harnesses: Vec<DetectedHarness> = PROBED
            .iter()
            .map(|id| DetectedHarness {
                id: (*id).to_string(),
                state: if *id == "claude" {
                    claude_state.clone()
                } else if find_command(id).is_some() {
                    // Installed, but this harness exposes no readable account
                    // state. Claiming a signed-in plan here would invent a
                    // subscription; claiming absence would hide a real one.
                    HarnessState::InstalledNotSignedIn
                } else {
                    HarnessState::NotInstalled
                },
            })
            .collect();

        let recommended_id = recommended(&harnesses).map(|h| h.id.clone());
        SubscriptionScan {
            harnesses,
            recommended_id,
        }
    })
    .await
    .map_err(|error| format!("subscription scan task failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The scan reports every probed harness, so onboarding can render a
    /// complete "what we found" list rather than only the hits.
    #[tokio::test]
    async fn scan_reports_every_probed_harness() {
        let scan = scan_agent_subscriptions()
            .await
            .expect("scan must not fail");
        assert_eq!(scan.harnesses.len(), PROBED.len());
        for (probed, detected) in PROBED.iter().zip(&scan.harnesses) {
            assert_eq!(&detected.id, probed, "order must match PROBED");
        }
    }

    /// A recommendation, when present, always names a harness in the list —
    /// never a stale or invented id.
    #[tokio::test]
    async fn recommendation_refers_to_a_scanned_harness() {
        let scan = scan_agent_subscriptions().await.unwrap();
        if let Some(id) = &scan.recommended_id {
            assert!(
                scan.harnesses.iter().any(|h| &h.id == id && h.is_usable()),
                "recommended id {id} must be a usable harness in the scan"
            );
        }
    }
}
