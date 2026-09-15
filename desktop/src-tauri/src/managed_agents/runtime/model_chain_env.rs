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

/// Whether the layered user env carries a hand-authored chain.
///
/// Env keys are matched without case on every platform here, because a person
/// who typed `openrouter_fallback_models` still meant the chain, and on Windows
/// the child process would resolve it to the same variable.
fn chain_is_authored(spawn_env: &BTreeMap<String, String>) -> bool {
    spawn_env
        .keys()
        .any(|key| key.eq_ignore_ascii_case(CHAIN_KEY))
}

/// Write the model chain env for a spawn.
///
/// `cached` is the relay's recommendation for this community, absent on a cold
/// cache or against a relay that does not rank.
///
/// Authored wins outright: the person's value is applied later by
/// `apply_user_env`, and the flag is removed so the harness treats that chain as
/// theirs and never overwrites it on a refresh.
///
/// Otherwise the flag is set even when nothing is cached. A cold cache is the
/// common case for the first agents of a session, and the flag is the only
/// thing that lets such an agent pick the chain up later: without it the agent
/// runs its whole life on one model. The chain variable is cleared in that case
/// rather than left alone, so an ambient value in the launching shell cannot
/// pose as a relay chain.
pub(crate) fn apply_model_chain_env(
    command: &mut Command,
    spawn_env: &BTreeMap<String, String>,
    cached: Option<Vec<String>>,
) {
    if chain_is_authored(spawn_env) {
        command.env_remove(SOURCE_KEY);
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
        apply_model_chain_env(&mut command, &BTreeMap::new(), None);
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
    #[test]
    fn an_authored_chain_gets_neither_the_flag_nor_a_relay_chain() {
        let mut command = Command::new("true");
        apply_model_chain_env(
            &mut command,
            &authored_env(),
            Some(vec!["relay/one:free".to_string()]),
        );
        assert_eq!(
            env_override(&command, "BUZZ_MODEL_CHAIN_SOURCE"),
            Some(None)
        );
        // Nothing written here, so apply_user_env lands the person's own value.
        assert_eq!(env_override(&command, "OPENROUTER_FALLBACK_MODELS"), None);
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
        apply_model_chain_env(&mut command, &env, None);
        assert_eq!(
            env_override(&command, "BUZZ_MODEL_CHAIN_SOURCE"),
            Some(None)
        );
        assert_eq!(env_override(&command, "OPENROUTER_FALLBACK_MODELS"), None);
    }
}
