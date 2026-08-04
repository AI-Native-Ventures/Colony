//! Colony interrupt primitives: typed Asks, agent tiers, delegation policy.
//!
//! Pure event/tag/JSON logic only. No IO. See docs/nips/NIP-IQ.md.

/// Escalation categories that must always reach a human owner and may never
/// carry a default-on-timeout (spec: the hard list).
pub const HARD_LIST_CATEGORIES: &[&str] = &[
    "spend",
    "external_send",
    "hiring",
    "legal",
    "pricing",
    "deletion",
    "vendor",
];

/// Returns `true` if `category` is on the immutable hard list.
pub fn is_hard_list_category(category: &str) -> bool {
    HARD_LIST_CATEGORIES.contains(&category)
}

/// The type of a Colony Ask event (tag `ask-type`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AskType {
    /// Pick an option; each option states its exact external effect.
    Decision,
    /// Something only the audience knows.
    Question,
    /// A key or account secret; payload never carries the secret itself.
    Credential,
    /// A real-world action only a human owner can perform.
    Blocker,
    /// Relay-generated: a task went event-silent (crashed or hung agent).
    Stall,
}

impl AskType {
    /// Canonical tag value.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Decision => "decision",
            Self::Question => "question",
            Self::Credential => "credential",
            Self::Blocker => "blocker",
            Self::Stall => "stall",
        }
    }
    /// Parse a tag value; `None` for anything not in the pinned vocabulary.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "decision" => Some(Self::Decision),
            "question" => Some(Self::Question),
            "credential" => Some(Self::Credential),
            "blocker" => Some(Self::Blocker),
            "stall" => Some(Self::Stall),
            _ => None,
        }
    }
    /// Credential and blocker asks forward mechanically (spec: fast path).
    pub fn is_fast_path(&self) -> bool {
        matches!(self, Self::Credential | Self::Blocker)
    }
}

/// An agent's rank in the interrupt hierarchy (managed-agent head field `tier`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentTier {
    /// Produces work; raises to its own leader; may never address owners.
    Worker,
    /// Runs a team; escalates to the executive; may never address owners.
    Leader,
    /// Chief of Staff: the only agent that may address owners.
    Executive,
}

impl AgentTier {
    /// Canonical string, matching the managed-agent head JSON field.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Worker => "worker",
            Self::Leader => "leader",
            Self::Executive => "executive",
        }
    }
    /// Parse the head field; `None` for unknown values (fail closed as worker
    /// is the CALLER's decision, not this parser's).
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "worker" => Some(Self::Worker),
            "leader" => Some(Self::Leader),
            "executive" => Some(Self::Executive),
            _ => None,
        }
    }
    /// The tier an unhandled ask at this altitude promotes toward.
    pub fn escalation_target(&self) -> Self {
        match self {
            Self::Worker => Self::Leader,
            Self::Leader => Self::Executive,
            Self::Executive => Self::Executive,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ask_type_round_trips() {
        for (s, t) in [
            ("decision", AskType::Decision),
            ("question", AskType::Question),
            ("credential", AskType::Credential),
            ("blocker", AskType::Blocker),
            ("stall", AskType::Stall),
        ] {
            assert_eq!(AskType::parse(s), Some(t));
            assert_eq!(t.as_str(), s);
        }
        assert_eq!(AskType::parse("prose"), None);
    }

    #[test]
    fn tier_round_trips_and_orders() {
        assert_eq!(AgentTier::parse("worker"), Some(AgentTier::Worker));
        assert_eq!(AgentTier::parse("leader"), Some(AgentTier::Leader));
        assert_eq!(AgentTier::parse("executive"), Some(AgentTier::Executive));
        assert_eq!(AgentTier::parse("owner"), None); // humans are not agent tiers
        assert!(AgentTier::Worker.escalation_target() == AgentTier::Leader);
        assert!(AgentTier::Leader.escalation_target() == AgentTier::Executive);
    }

    #[test]
    fn hard_list_is_exact() {
        assert_eq!(
            HARD_LIST_CATEGORIES,
            &[
                "spend",
                "external_send",
                "hiring",
                "legal",
                "pricing",
                "deletion",
                "vendor"
            ]
        );
        assert!(is_hard_list_category("spend"));
        assert!(!is_hard_list_category("copy_change"));
    }
}
