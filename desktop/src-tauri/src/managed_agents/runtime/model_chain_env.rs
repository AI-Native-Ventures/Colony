//! Which model chain an agent starts with, and who owns it.
//!
//! Two variables decide this for the harness: `OPENROUTER_FALLBACK_MODELS` is
//! the chain itself, and `BUZZ_MODEL_CHAIN_SOURCE=relay` says the chain is the
//! relay's opinion rather than a person's. The harness refreshes the chain from
//! the relay only while that flag is present (see `refresh_enabled` in
//! `crates/buzz-agent/src/relay_chain.rs`), so the flag is what makes a chain
//! live rather than frozen at spawn.
//!
//! The user's own env is layered on after everything this module writes, which
//! is why the decision is made from that env rather than from what is already
//! on the command.

use std::collections::BTreeMap;
use std::process::Command;

/// Chain env key the harness reads.
const CHAIN_KEY: &str = "OPENROUTER_FALLBACK_MODELS";

/// Flag naming the relay as the chain's owner.
const SOURCE_KEY: &str = "BUZZ_MODEL_CHAIN_SOURCE";

/// The hand-authored chain the layered env carries, if any.
///
/// Env keys are matched without case on every platform here, because a person
/// who typed `openrouter_fallback_models` still meant the chain, and on Windows
/// the child process would resolve it to the same variable.
fn authored_env_chain(spawn_env: &BTreeMap<String, String>) -> Option<String> {
    spawn_env
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(CHAIN_KEY))
        .map(|(_, value)| value.clone())
}

/// Write the model chain env for a spawn.
///
/// `authored` is the chain the owner chose, resolved through the config tiers
/// (`EffectiveAgentConfig::fallback_models`). `Some(list)` is theirs and is
/// written verbatim, including `Some(vec![])`, which sets the variable to the
/// empty string: an agent deliberately running with no fallbacks still has to
/// say so, or an ambient value in the launching shell would speak for it. The
/// source flag is removed in both cases, so the harness treats the chain as the
/// person's and never replaces it on a refresh.
///
/// `cached` is the relay's recommendation for this community, absent on a cold
/// cache or against a relay that does not rank. It is consulted only when
/// nothing was authored.
///
/// A legacy `OPENROUTER_FALLBACK_MODELS` in `spawn_env` is authored too. The
/// key is config-owned now, so `apply_user_env` will not write it and this
/// function has to: harness definitions carry env the user-env filter never
/// sees, and a chain in one of those must keep working.
///
/// With nothing authored anywhere, the flag is set even when nothing is
/// cached. A cold cache is the common case for the first agents of a session,
/// and the flag is the only thing that lets such an agent pick the chain up
/// later: without it the agent runs its whole life on one model. The chain
/// variable is cleared in that case rather than left alone, for the same reason
/// the empty authored chain is written explicitly.
pub(crate) fn apply_model_chain_env(
    command: &mut Command,
    spawn_env: &BTreeMap<String, String>,
    cached: Option<Vec<String>>,
    authored: Option<Vec<String>>,
) {
    if let Some(chain) = authored {
        command.env_remove(SOURCE_KEY);
        command.env(CHAIN_KEY, chain.join(","));
        return;
    }
    if let Some(value) = authored_env_chain(spawn_env) {
        command.env_remove(SOURCE_KEY);
        command.env(CHAIN_KEY, value);
        return;
    }
    command.env(SOURCE_KEY, "relay");
    match cached {
        Some(chain) => {
            command.env(CHAIN_KEY, chain.join(","));
        }
        None => {
            command.env_remove(CHAIN_KEY);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What the command would hand the child for `key`: `Some(value)` when it
    /// is set, `None` when it is explicitly cleared, and absent from the map
    /// when the spawn never mentioned it.
    fn env_override(command: &Command, key: &str) -> Option<Option<String>> {
        command.get_envs().find_map(|(k, v)| {
            if k == std::ffi::OsStr::new(key) {
                Some(v.map(|v| v.to_string_lossy().into_owned()))
            } else {
                None
            }
        })
    }

    fn authored_env() -> BTreeMap<String, String> {
        let mut env = BTreeMap::new();
        env.insert(
            "OPENROUTER_FALLBACK_MODELS".to_string(),
            "mine/one:free,mine/two:free".to_string(),
        );
        env
    }

    /// The outage this fixes. A cold cache used to write neither variable, so
    /// the harness never refreshed and the agent kept one model for its whole
    /// life. The flag goes out regardless of whether a chain is ready.
    #[test]
    fn a_cold_cache_still_names_the_relay_as_the_source() {
        let mut command = Command::new("true");
        apply_model_chain_env(&mut command, &BTreeMap::new(), None, None);
        assert_eq!(
            env_override(&command, "BUZZ_MODEL_CHAIN_SOURCE"),
            Some(Some("relay".to_string()))
        );
        // Cleared, not merely unset: an ambient shell value must not pass
        // itself off as the relay's recommendation.
        assert_eq!(
            env_override(&command, "OPENROUTER_FALLBACK_MODELS"),
            Some(None)
        );
    }

    /// A warm cache writes the chain and the flag together.
    #[test]
    fn a_warm_cache_writes_the_chain_and_the_flag() {
        let mut command = Command::new("true");
        apply_model_chain_env(
            &mut command,
            &BTreeMap::new(),
            Some(vec!["a/one:free".to_string(), "b/two:free".to_string()]),
            None,
        );
        assert_eq!(
            env_override(&command, "OPENROUTER_FALLBACK_MODELS"),
            Some(Some("a/one:free,b/two:free".to_string()))
        );
        assert_eq!(
            env_override(&command, "BUZZ_MODEL_CHAIN_SOURCE"),
            Some(Some("relay".to_string()))
        );
    }

    /// A hand-typed chain is the person's, so no relay chain is injected over
    /// it and no flag invites the harness to replace it on the next refresh.
    /// The key is config-owned, so `apply_user_env` no longer lands the value
    /// and this function writes it instead.
    #[test]
    fn an_authored_chain_gets_neither_the_flag_nor_a_relay_chain() {
        let mut command = Command::new("true");
        apply_model_chain_env(
            &mut command,
            &authored_env(),
            Some(vec!["relay/one:free".to_string()]),
            None,
        );
        assert_eq!(
            env_override(&command, "BUZZ_MODEL_CHAIN_SOURCE"),
            Some(None)
        );
        assert_eq!(
            env_override(&command, "OPENROUTER_FALLBACK_MODELS"),
            Some(Some("mine/one:free,mine/two:free".to_string()))
        );
    }

    /// Same, with the key typed in another case.
    #[test]
    fn an_authored_chain_is_recognised_whatever_its_case() {
        let mut env = BTreeMap::new();
        env.insert(
            "openrouter_fallback_models".to_string(),
            "mine/one:free".to_string(),
        );
        let mut command = Command::new("true");
        apply_model_chain_env(&mut command, &env, None, None);
        assert_eq!(
            env_override(&command, "BUZZ_MODEL_CHAIN_SOURCE"),
            Some(None)
        );
        assert_eq!(
            env_override(&command, "OPENROUTER_FALLBACK_MODELS"),
            Some(Some("mine/one:free".to_string()))
        );
    }

    /// The Agent defaults chain, or a per-agent one, beats both the relay's
    /// recommendation and a leftover env copy.
    #[test]
    fn an_authored_chain_beats_the_relay_and_the_env() {
        let mut command = Command::new("true");
        apply_model_chain_env(
            &mut command,
            &authored_env(),
            Some(vec!["relay/one:free".to_string()]),
            Some(vec![
                "field/one:free".to_string(),
                "field/two:free".to_string(),
            ]),
        );
        assert_eq!(
            env_override(&command, "OPENROUTER_FALLBACK_MODELS"),
            Some(Some("field/one:free,field/two:free".to_string()))
        );
        assert_eq!(
            env_override(&command, "BUZZ_MODEL_CHAIN_SOURCE"),
            Some(None)
        );
    }

    /// "This agent has no fallbacks" is a choice, and it has to be written as
    /// the empty string: clearing the variable would let the relay chain take
    /// the agent back on the harness's next refresh.
    #[test]
    fn an_empty_authored_chain_spawns_with_an_empty_value_and_no_flag() {
        let mut command = Command::new("true");
        apply_model_chain_env(
            &mut command,
            &BTreeMap::new(),
            Some(vec!["relay/one:free".to_string()]),
            Some(Vec::new()),
        );
        assert_eq!(
            env_override(&command, "OPENROUTER_FALLBACK_MODELS"),
            Some(Some(String::new()))
        );
        assert_eq!(
            env_override(&command, "BUZZ_MODEL_CHAIN_SOURCE"),
            Some(None)
        );
    }
}
