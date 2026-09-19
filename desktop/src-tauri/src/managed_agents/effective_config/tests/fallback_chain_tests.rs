//! Where an agent's fallback chain comes from: its definition, the global
//! Agent defaults, or the relay's own recommendation.

use super::super::*;
use super::{definition, global, record};
fn chain(entries: &[&str]) -> Vec<String> {
    entries.iter().map(|e| (*e).to_string()).collect()
}

fn resolved_chain(
    rec: &ManagedAgentRecord,
    definitions: &[AgentDefinition],
    global: &GlobalAgentConfig,
) -> ResolvedField<Vec<String>> {
    match resolve_effective_config(rec, definitions, global) {
        EffectiveConfigResult::Resolved(cfg) => cfg.fallback_models,
        EffectiveConfigResult::OrphanedInstance { .. } => panic!("expected a resolved config"),
    }
}

/// Nobody authored a chain, so the relay's recommendation decides and the
/// desktop records only that fact: it does not resolve the relay's chain here.
#[test]
fn an_unauthored_chain_resolves_to_the_relay_tier() {
    let rec = record(Some("d1"), None, None, None);
    let definitions = vec![definition("d1", None, None, "prompt")];
    let resolved = resolved_chain(&rec, &definitions, &global(None, None));
    assert_eq!(resolved.value, None);
    assert_eq!(resolved.source, ConfigSource::Relay);
}

#[test]
fn a_definition_chain_wins_over_the_global_one() {
    let rec = record(Some("d1"), None, None, None);
    let mut def = definition("d1", None, None, "prompt");
    def.fallback_models = Some(chain(&["def/one:free"]));
    let mut global = global(None, None);
    global.fallback_models = chain(&["global/one:free"]);
    let resolved = resolved_chain(&rec, &[def], &global);
    assert_eq!(resolved.value, Some(chain(&["def/one:free"])));
    assert_eq!(resolved.source, ConfigSource::Definition);
}

/// The distinction the whole tri-state exists for: an empty list is authored,
/// so it must not fall through to the global chain the way `None` does.
#[test]
fn an_empty_definition_chain_means_no_fallbacks_at_all() {
    let rec = record(Some("d1"), None, None, None);
    let mut def = definition("d1", None, None, "prompt");
    def.fallback_models = Some(Vec::new());
    let mut global = global(None, None);
    global.fallback_models = chain(&["global/one:free"]);
    let resolved = resolved_chain(&rec, &[def], &global);
    assert_eq!(resolved.value, Some(Vec::new()));
    assert_eq!(resolved.source, ConfigSource::Definition);
}

#[test]
fn a_definition_without_a_chain_inherits_the_global_one() {
    let rec = record(Some("d1"), None, None, None);
    let definitions = vec![definition("d1", None, None, "prompt")];
    let mut global = global(None, None);
    global.fallback_models = chain(&["global/one:free", "global/two:free"]);
    let resolved = resolved_chain(&rec, &definitions, &global);
    assert_eq!(
        resolved.value,
        Some(chain(&["global/one:free", "global/two:free"]))
    );
    assert_eq!(resolved.source, ConfigSource::Global);
}

/// A record carries no chain field, so a definition-less instance has only the
/// global tier and the relay below it.
#[test]
fn a_definition_less_instance_resolves_global_then_relay() {
    let rec = record(None, Some("own/model"), None, None);
    let empty = global(None, None);
    let resolved = resolved_chain(&rec, &[], &empty);
    assert_eq!(resolved.value, None);
    assert_eq!(resolved.source, ConfigSource::Relay);

    let mut global = global(None, None);
    global.fallback_models = chain(&["global/one:free"]);
    let resolved = resolved_chain(&rec, &[], &global);
    assert_eq!(resolved.value, Some(chain(&["global/one:free"])));
    assert_eq!(resolved.source, ConfigSource::Global);
}
