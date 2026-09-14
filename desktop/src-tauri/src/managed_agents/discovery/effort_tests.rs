//! `apply_agent_command_update` regressions: the effort pin, and the sentinel
//! case that shares its fixtures.
//!
//! A child of `tests.rs` rather than a sibling: that file sits on the desktop
//! size ratchet, and nesting keeps its fixtures private while moving the bulk
//! out. Splitting is the repo's answer there, not a raised limit.

use super::{apply_agent_command_update, persona_with_runtime, record_agent_command, record_with};

#[test]
fn apply_agent_command_update_clears_effort_when_the_harness_changes() {
    // A persisted effort pins one adapter's advertised thought_level options.
    // Switching harness must drop it rather than assert a value the new
    // adapter never offered.
    let personas = vec![persona_with_runtime("p1", Some("claude"))];
    let mut record = record_with(Some("codex"), Some("p1"), Some("codex-acp"));
    record.effort_level = Some("high".to_string());

    apply_agent_command_update(&mut record, &personas, "", false);

    assert_eq!(record_agent_command(&record, &personas), "claude-agent-acp");
    assert_eq!(record.effort_level, None);
}

#[test]
fn apply_agent_command_update_keeps_effort_when_the_harness_is_unchanged() {
    // An edit that re-picks the same harness is not a harness change, so the
    // effort the user chose for it survives.
    let personas = vec![persona_with_runtime("p1", Some("codex"))];
    let mut record = record_with(Some("codex"), Some("p1"), Some("codex-acp"));
    record.effort_level = Some("high".to_string());

    apply_agent_command_update(&mut record, &personas, "codex-acp", true);

    assert_eq!(record.effort_level, Some("high".to_string()));
}

#[test]
fn apply_agent_command_update_sentinel_keeps_runtime_for_definition_less_record() {
    // For a record with no persona link the materialized runtime is the only
    // harness source left once the pin is cleared — a stray empty
    // agent_command must not change what the agent runs.
    let mut record = record_with(Some("claude"), None, Some("codex-acp"));

    apply_agent_command_update(&mut record, &[], "", false);

    assert_eq!(record.agent_command_override, None);
    assert_eq!(record.runtime.as_deref(), Some("claude"));
    assert_eq!(record_agent_command(&record, &[]), "claude-agent-acp");
}
