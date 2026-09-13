//! OpenRouter readiness cases split out of `readiness.rs` for the desktop
//! file-size ratchet.

use super::*;

#[cfg(test)]
mod tests {
    use super::super::tests::{env_with, make_env};
    use super::*;

    #[test]
    fn buzz_agent_openrouter_with_provider_model_fallback_is_ready() {
        let env = make_env(
            "buzz-agent",
            env_with(&[
                ("BUZZ_AGENT_PROVIDER", "openrouter"),
                ("OPENROUTER_MODEL", "google/gemini-2.5-flash"),
                ("OPENROUTER_API_KEY", "sk-or-test-key"),
            ]),
        );
        let result = agent_readiness(&env);
        assert!(
            result.is_ready(),
            "OPENROUTER_MODEL fallback should satisfy model requirement"
        );
    }
}
