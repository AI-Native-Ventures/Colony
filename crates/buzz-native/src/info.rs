//! Application identity metadata.
//!
//! Separate from [`AppPaths`](crate::AppPaths) on purpose. `app.config()`
//! looks like a settings lookup and one of its two used fields is load-bearing
//! for process reaping.

/// Values read from the shell's application config.
///
/// Both fields come from `app.config()`, which has 4 call sites in the tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostInfo {
    /// The bundle identifier, and **this is the managed-agent instance id**.
    ///
    /// `managed_agents::runtime::process::current_instance_id` returns exactly
    /// this, and it is stamped into `BUZZ_MANAGED_AGENT=<id>` on every agent
    /// process we spawn. The sweep only reaps processes carrying *this* id.
    ///
    /// It differs between builds on purpose: `xyz.block.buzz.app` for release,
    /// `xyz.block.buzz.app.dev` under `just dev`. That difference is what stops
    /// a dev build from reaping a DMG build's agents, and it is why this is not
    /// a path and must never be folded into a directory bundle. Change what
    /// this resolves to and two coexisting installs start killing each other's
    /// agents. See R7.
    pub bundle_identifier: String,

    /// Used for the native notification title (`commands/notifications.rs`).
    /// Optional because `app.config().product_name` is optional upstream.
    pub product_name: Option<String>,
}

impl HostInfo {
    pub fn new(bundle_identifier: impl Into<String>, product_name: Option<String>) -> Self {
        Self {
            bundle_identifier: bundle_identifier.into(),
            product_name,
        }
    }

    /// The value stamped into spawned agents' `BUZZ_MANAGED_AGENT` env var.
    ///
    /// Named for what it is used for rather than where it comes from, so a
    /// reader at the reaper does not have to know it is a bundle id.
    pub fn instance_id(&self) -> &str {
        &self.bundle_identifier
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_id_is_the_bundle_identifier() {
        let info = HostInfo::new("xyz.block.buzz.app", Some("Buzz".into()));
        assert_eq!(info.instance_id(), "xyz.block.buzz.app");
    }

    #[test]
    fn dev_and_release_instance_ids_differ() {
        // The whole point of R7: these must not compare equal, or a dev build
        // reaps a release build's agents.
        let release = HostInfo::new("xyz.block.buzz.app", None);
        let dev = HostInfo::new("xyz.block.buzz.app.dev", None);
        assert_ne!(release.instance_id(), dev.instance_id());
    }
}
