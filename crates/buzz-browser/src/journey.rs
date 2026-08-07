//! Reference and naive baseline browser journeys.

use std::path::PathBuf;

use crate::budget::BudgetLedger;
use crate::cdp::CdpClient;
use crate::contracts::{BrowserError, SnapshotCaps};
use crate::host::{launch, HostConfig};
use crate::input::{click_ref, press_enter, type_text, wait_for_selector};
use crate::snapshot::take_snapshot;

pub struct JourneyConfig {
    pub binary: Option<PathBuf>,
    pub base_url: String,
    pub naive: bool,
}

/// Run the reference journey and return the budget report.
pub async fn run_reference_journey(
    cfg: &JourneyConfig,
) -> Result<crate::contracts::BudgetReport, BrowserError> {
    let host_cfg = HostConfig {
        binary: cfg.binary.clone(),
        ..HostConfig::default()
    };
    let host = launch(&host_cfg).await?;
    let target = host
        .list_targets()
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| BrowserError::Host("no page target".into()))?;
    let mut client = CdpClient::connect(&target.ws_url).await?;
    let mut ledger = BudgetLedger::default();
    let caps = SnapshotCaps::default();

    let url = format!("{}/interaction.html", cfg.base_url);
    client.navigate(&url).await?;
    let mut snap = take_snapshot(&mut client, &caps).await?;
    ledger.record("browser_navigate", snap.chars);

    if cfg.naive {
        // Naive baseline: full DOM dump every step (context blow-up).
        let dom = client
            .evaluate("document.documentElement.outerHTML")
            .await?
            .as_str()
            .unwrap_or_default()
            .to_string();
        ledger.record("dom_dump", dom.len());
    }

    // Focus the input by clicking its ref, then type and submit.
    let input_ref = snap
        .refs
        .keys()
        .find(|_| snap.outline.contains("textbox"))
        .cloned()
        .ok_or_else(|| BrowserError::Input("no textbox ref".into()))?;
    click_ref(&mut client, &snap, &input_ref).await?;
    type_text(&mut client, "colony-agent").await?;
    press_enter(&mut client).await?;
    wait_for_selector(&mut client, "#result", 5_000).await?;

    snap = take_snapshot(&mut client, &caps).await?;
    ledger.record("browser_submit", snap.chars);
    if !snap.outline.contains("PASS") {
        return Err(BrowserError::Snapshot(format!(
            "journey did not reach PASS:\n{}",
            snap.outline
        )));
    }
    Ok(ledger.report())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "requires fixture servers; run explicitly in Task 9 Step 4"]
    async fn journey_budget_meets_gate() {
        let report = run_reference_journey(&JourneyConfig {
            binary: std::env::var("BUZZ_BROWSER_BINARY").ok().map(PathBuf::from),
            base_url: "http://127.0.0.1:8777".into(),
            naive: false,
        })
        .await;
        let report = report.unwrap();
        assert!(report.total_calls <= 25, "calls {}", report.total_calls);
        assert!(
            report.total_tokens <= 40_000,
            "tokens {}",
            report.total_tokens
        );
    }

    #[test]
    fn module_loads() {}
}
