//! Which agent definitions belong to the community you are looking at.
//!
//! A definition carries no relay pin — `AgentDefinition` has no relay or
//! community field at all — so without this it is global by construction.
//! Creating an agent writes a keyless definition record milliseconds before
//! the relay-pinned agent record, and only the second one was ever scoped.
//! The result was that every community's Agents page listed every agent ever
//! created anywhere: Horizon showed all of Colony's agents and vice versa.
//!
//! Scoping definitions by "has an agent here" alone is too blunt, and CI
//! caught it: it also hides a definition with no agents *anywhere*, which
//! strands a template you created but never started (you cannot even delete
//! it), and it hides the built-ins that ship with the app before they are
//! first started, which is most of the first-run surface.

use crate::{managed_agents::ManagedAgentRecord, relay::agent_belongs_to_workspace};

/// The only three things about an agent this rule needs.
///
/// Projected out of `ManagedAgentRecord` so the rule can be tested without
/// building a fifty-field record, and so it cannot quietly start depending on
/// anything else.
pub(in crate::commands) struct AgentRow<'a> {
    pub persona_id: Option<&'a str>,
    pub pubkey: &'a str,
    pub relay_url: &'a str,
}

impl<'a> AgentRow<'a> {
    pub fn of(record: &'a ManagedAgentRecord) -> Self {
        Self {
            persona_id: record.persona_id.as_deref(),
            pubkey: &record.pubkey,
            relay_url: &record.relay_url,
        }
    }
}

/// Whether a definition should be listed for `workspace_relay`.
///
/// Three ways to qualify, and a definition needs only one:
///
/// 1. It is built-in. Built-ins regenerate from code for every community and
///    have no agent until someone starts one.
/// 2. It has no agent in any community. An unused template belongs to whoever
///    is looking, because no community has a better claim on it and hiding it
///    everywhere would leave it undeletable.
/// 3. At least one of its agents belongs to this workspace.
///
/// So the only definitions hidden are the ones whose agents all live in some
/// other community, which is exactly the leak.
pub(in crate::commands) fn definition_in_workspace(
    definition_id: &str,
    is_builtin: bool,
    agents: &[AgentRow<'_>],
    workspace_relay: &str,
) -> bool {
    if is_builtin {
        return true;
    }

    // Only agents count here. A definition is itself persisted as a keyless
    // record, and counting that as its own agent would make every definition
    // qualify under rule 3 and scope nothing.
    let mut has_any_agent = false;
    for agent in agents {
        if agent.pubkey.trim().is_empty() {
            continue;
        }
        if agent.persona_id != Some(definition_id) {
            continue;
        }
        has_any_agent = true;
        if agent_belongs_to_workspace(agent.relay_url, workspace_relay) {
            return true;
        }
    }

    !has_any_agent
}

/// Whether a team should be listed for `workspace_relay`.
///
/// Teams carry no relay pin either, so a team assembled on one community
/// showed up on every other one with all of its members flagged as "no
/// longer in your agents". They were not gone; they were scoped out by the
/// rule above while the team itself was not.
///
/// A team lists unless one of its members is a definition that exists but
/// lives only in another community. Built-in teams always list. A member
/// that exists nowhere is a real gap, so the team stays visible and the
/// card's warning is for once telling the truth.
pub(in crate::commands) fn team_in_workspace(
    member_ids: &[String],
    is_builtin: bool,
    definitions: &[(&str, bool)],
    agents: &[AgentRow<'_>],
    workspace_relay: &str,
) -> bool {
    if is_builtin {
        return true;
    }
    member_ids.iter().all(|member| {
        match definitions.iter().find(|(id, _)| *id == member.as_str()) {
            None => true,
            Some((id, builtin)) => definition_in_workspace(id, *builtin, agents, workspace_relay),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const HERE: &str = "wss://colony.colony.ainative.ventures";
    const ELSEWHERE: &str = "wss://horizon.colony.ainative.ventures";

    fn agent<'a>(persona_id: &'a str, relay: &'a str) -> AgentRow<'a> {
        AgentRow {
            persona_id: Some(persona_id),
            pubkey: "aa11",
            relay_url: relay,
        }
    }

    /// The definition's own key-less record, which every definition has.
    fn definition_row(persona_id: &str) -> AgentRow<'_> {
        AgentRow {
            persona_id: Some(persona_id),
            pubkey: "",
            relay_url: "",
        }
    }

    #[test]
    fn a_definition_whose_agents_all_live_elsewhere_is_hidden() {
        let rows = vec![definition_row("weaver"), agent("weaver", ELSEWHERE)];
        assert!(!definition_in_workspace("weaver", false, &rows, HERE));
    }

    #[test]
    fn a_definition_with_an_agent_here_is_listed() {
        let rows = vec![
            definition_row("weaver"),
            agent("weaver", HERE),
            agent("weaver", ELSEWHERE),
        ];
        assert!(definition_in_workspace("weaver", false, &rows, HERE));
    }

    // Otherwise a template you created but never started vanishes from every
    // community at once, and there is no surface left to delete it from.
    #[test]
    fn a_definition_with_no_agents_anywhere_is_listed() {
        let rows = vec![definition_row("draft")];
        assert!(definition_in_workspace("draft", false, &rows, HERE));
    }

    // Built-ins ship with the app and have no agent until first start, so
    // scoping them by their agents would empty the first-run Agents page.
    #[test]
    fn a_builtin_is_listed_even_when_its_agents_are_elsewhere() {
        let rows = vec![agent("chief-of-staff", ELSEWHERE)];
        assert!(definition_in_workspace("chief-of-staff", true, &rows, HERE));
    }

    // An unassigned agent belongs to whichever community is asking, which is
    // what `agent_belongs_to_workspace` already says for a blank pin.
    #[test]
    fn an_unassigned_agent_keeps_its_definition_listed() {
        let rows = vec![agent("weaver", "")];
        assert!(definition_in_workspace("weaver", false, &rows, HERE));
    }

    #[test]
    fn another_definitions_agents_do_not_qualify_this_one() {
        let rows = vec![agent("jake", HERE), agent("weaver", ELSEWHERE)];
        assert!(!definition_in_workspace("weaver", false, &rows, HERE));
    }

    fn members(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn a_team_whose_members_all_live_elsewhere_is_hidden() {
        let rows = vec![
            definition_row("emelia"),
            agent("emelia", ELSEWHERE),
            definition_row("jake"),
            agent("jake", ELSEWHERE),
        ];
        let defs = [("emelia", false), ("jake", false)];
        assert!(!team_in_workspace(
            &members(&["emelia", "jake"]),
            false,
            &defs,
            &rows,
            HERE
        ));
    }

    #[test]
    fn a_team_with_one_member_elsewhere_is_hidden_here() {
        let rows = vec![
            definition_row("weaver"),
            agent("weaver", HERE),
            definition_row("jake"),
            agent("jake", ELSEWHERE),
        ];
        let defs = [("weaver", false), ("jake", false)];
        assert!(!team_in_workspace(
            &members(&["weaver", "jake"]),
            false,
            &defs,
            &rows,
            HERE
        ));
    }

    #[test]
    fn a_team_whose_members_are_here_is_listed() {
        let rows = vec![definition_row("weaver"), agent("weaver", HERE)];
        let defs = [("weaver", false)];
        assert!(team_in_workspace(
            &members(&["weaver"]),
            false,
            &defs,
            &rows,
            HERE
        ));
    }

    #[test]
    fn a_member_deleted_everywhere_keeps_the_team_visible() {
        let rows = vec![definition_row("weaver"), agent("weaver", HERE)];
        let defs = [("weaver", false)];
        assert!(team_in_workspace(
            &members(&["weaver", "gone"]),
            false,
            &defs,
            &rows,
            HERE
        ));
    }

    #[test]
    fn an_unstarted_member_keeps_the_team_visible() {
        let rows = vec![definition_row("draft")];
        let defs = [("draft", false)];
        assert!(team_in_workspace(
            &members(&["draft"]),
            false,
            &defs,
            &rows,
            HERE
        ));
    }

    #[test]
    fn a_builtin_team_always_lists() {
        let rows = vec![definition_row("jake"), agent("jake", ELSEWHERE)];
        let defs = [("jake", false)];
        assert!(team_in_workspace(
            &members(&["jake"]),
            true,
            &defs,
            &rows,
            HERE
        ));
    }
}
