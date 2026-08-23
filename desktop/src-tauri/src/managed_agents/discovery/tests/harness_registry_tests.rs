//! Resolver tests that depend on the process-global loaded-harness registry.
//!
//! Lives as a child module of `tests` because `tests.rs` is pinned by the
//! file-size ratchet and cannot grow. As a descendant of `tests` it can use
//! this module's private fixtures (`record_with`, `persona_with_runtime`)
//! directly.

/// Pre-migration record: persona_id set, no runtime — resolves through
/// the legacy persona path unchanged.
///
/// "omp" is a preset id, not a tier-1 builtin: it only resolves through
/// the global loaded-harness registry, so seed it with the static preset
/// list and hold the test guard until after the assert. Without this the
/// result depended on which parallel test had warmed or cleared the
/// registry first (fails standalone with "buzz-agent" instead of "omp").
#[test]
fn record_agent_command_legacy_persona_fallback() {
    use crate::managed_agents::custom_harnesses::{
        registry_test_lock, warm_harness_registry_from_dir,
    };
    let _lock = registry_test_lock();
    warm_harness_registry_from_dir(None);
    let personas = vec![super::persona_with_runtime("p1", Some("omp"))];
    let record = super::record_with(None, Some("p1"), None);
    assert_eq!(
        crate::managed_agents::discovery::record_agent_command(&record, &personas),
        "omp"
    );
}
