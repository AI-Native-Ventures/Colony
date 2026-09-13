//! Explicit platform boundary for subscriptions that require Unix process isolation.
use anyhow::{Result, bail};

const REASON: &str = "Subscription process isolation is unavailable on this platform";

/// Report the same unsupported isolation contract as the execution entry point.
pub(crate) fn check_capability() -> Result<()> {
    println!(
        "{}",
        serde_json::json!({"supported": false, "reason": REASON})
    );
    Ok(())
}

/// Reject execution before launching any vendor or descendant process.
pub(crate) fn run() -> Result<()> {
    bail!(REASON)
}
