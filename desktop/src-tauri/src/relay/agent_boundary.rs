//! Which community a managed agent belongs to.
//!
//! A community is a hard boundary: an agent created in one community must
//! never run, publish, or appear in another. Every agent relay resolution in
//! the app funnels through `effective_agent_relay_url`, so this file is the
//! single place that decision is made.

/// Selects the relay a managed agent should use for a relay operation.
///
/// The per-record `relay_url` pin wins whenever it is set. The community an
/// agent was created in is the community it belongs to for the rest of its
/// life. This is the one choke point every agent relay resolution flows
/// through (reconcile, spawn, and profile sync all land here), so honoring the
/// pin here is what makes the boundary hold.
///
/// This deliberately reverses upstream Buzz's "agents everywhere" behavior
/// (#2122), which ignored the pin and substituted the active workspace relay
/// so that every agent was eligible on every community.
///
/// A blank pin means "not yet assigned to a community": records created before
/// the pin was load-bearing have nothing on disk that says where they belong,
/// and pair logs show they genuinely ran in several communities, so there is
/// no honest value to infer. Those fall back to the workspace relay (the
/// pre-existing behavior) rather than silently refusing to run. Assigning one
/// is an explicit user action; see `assign_managed_agent_community`.
///
/// Uniform for both Local and Provider backends.
pub fn effective_agent_relay_url(record_relay: &str, workspace_relay: &str) -> String {
    let pinned = record_relay.trim();
    if pinned.is_empty() {
        return workspace_relay.to_string();
    }
    // Normalize so a pin stored in a different-but-equivalent spelling still
    // matches the workspace relay comparisons callers make against it. An
    // unparseable pin is returned verbatim: refusing to resolve it would
    // strand the agent, and the connection attempt reports a better error.
    canonical(pinned)
}

/// Whether an agent pinned to `record_relay` belongs to `workspace_relay`.
///
/// Blank pins are unassigned and belong to whichever community is asking, so
/// they keep working until the user assigns them. Both sides are normalized so
/// equivalent spellings of one relay compare equal.
pub fn agent_belongs_to_workspace(record_relay: &str, workspace_relay: &str) -> bool {
    let pinned = record_relay.trim();
    if pinned.is_empty() {
        return true;
    }
    canonical(pinned) == canonical(workspace_relay)
}

fn canonical(url: &str) -> String {
    buzz_core_pkg::relay::normalize_relay_url(url).unwrap_or_else(|_| url.to_string())
}

#[cfg(test)]
mod tests {
    use super::{agent_belongs_to_workspace, effective_agent_relay_url};

    // ── effective_agent_relay_url: community boundary ────────────────────────

    #[test]
    fn stored_relay_pin_wins_over_workspace() {
        // The community an agent was created in is the community it runs in,
        // whatever community happens to be open. Reverses #2122.
        assert_eq!(
            effective_agent_relay_url("wss://relay.other.com", "wss://staging.example.com"),
            "wss://relay.other.com"
        );
    }

    #[test]
    fn pin_is_normalized_before_use() {
        // A pin stored in an equivalent spelling still has to compare equal to
        // the workspace relay, or the boundary check would reject its own home.
        assert_eq!(
            effective_agent_relay_url("wss://relay.other.com/", "wss://staging.example.com"),
            effective_agent_relay_url("wss://relay.other.com", "wss://staging.example.com"),
        );
    }

    #[test]
    fn empty_relay_resolves_to_workspace() {
        // Unassigned: nothing on disk says where this agent belongs, so it
        // keeps working in whichever community is asking until assigned.
        assert_eq!(
            effective_agent_relay_url("", "wss://staging.example.com"),
            "wss://staging.example.com"
        );
    }

    #[test]
    fn whitespace_only_relay_resolves_to_workspace() {
        // Whitespace-only is blank, not a pin.
        assert_eq!(
            effective_agent_relay_url("   ", "wss://staging.example.com"),
            "wss://staging.example.com"
        );
    }

    // ── agent_belongs_to_workspace ───────────────────────────────────────────

    #[test]
    fn pinned_agent_belongs_only_to_its_own_community() {
        assert!(agent_belongs_to_workspace(
            "wss://one.example.com",
            "wss://one.example.com"
        ));
        assert!(!agent_belongs_to_workspace(
            "wss://one.example.com",
            "wss://two.example.com"
        ));
    }

    #[test]
    fn membership_ignores_equivalent_url_spellings() {
        assert!(agent_belongs_to_workspace(
            "wss://one.example.com/",
            "wss://one.example.com"
        ));
    }

    #[test]
    fn unassigned_agent_belongs_to_every_community() {
        // Until the user assigns it, an unpinned agent keeps its old behavior.
        assert!(agent_belongs_to_workspace("", "wss://one.example.com"));
        assert!(agent_belongs_to_workspace("  ", "wss://two.example.com"));
    }
}
