//! Environment handed to a metered agent subprocess.
//!
//! Two things have to be true for an agent's spend to be countable:
//! its provider traffic must go through the checkpoint, and it must not
//! possess a credential that lets it go anywhere else. So the harness both
//! points the agent at the checkpoint and overwrites every provider key
//! variable with the agent's virtual key.
//!
//! The overwrite is deliberate and unconditional. Everywhere else in
//! [`crate::acp::AcpClient::spawn`] an inherited parent value wins, which is
//! the right default for configuration. It is the wrong default for a
//! credential: a real key sitting in the operator's shell would be inherited
//! by the agent, and that agent could then bill the company from outside the
//! ledger's view.

/// Where the checkpoint is listening and which key this agent authenticates
/// with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeterEnv {
    /// Loopback port the checkpoint bound.
    pub port: u16,
    /// Per-agent virtual key minted by the checkpoint.
    pub virtual_key: String,
}

/// Provider credential variables the harness overwrites when metering is on.
///
/// An agent must not be able to read a real provider credential from its
/// environment, whether the operator exported one or a persona supplied it.
pub const METERED_CREDENTIAL_VARS: &[&str] =
    &["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];

/// Base-URL variables pointing agents at the checkpoint.
///
/// Several names for the same two endpoints, because SDKs and harnesses
/// disagree about which one they read. Setting one an agent ignores costs
/// nothing; missing the one it reads means its spend is never counted.
fn base_url_vars(port: u16) -> Vec<(String, String)> {
    let anthropic = format!("http://127.0.0.1:{port}/anthropic");
    let openai_root = format!("http://127.0.0.1:{port}/openai");
    let openai_v1 = format!("{openai_root}/v1");
    vec![
        ("ANTHROPIC_BASE_URL".to_string(), anthropic.clone()),
        ("ANTHROPIC_HOST".to_string(), anthropic),
        ("OPENAI_BASE_URL".to_string(), openai_v1.clone()),
        ("OPENAI_API_BASE".to_string(), openai_v1),
        ("OPENAI_HOST".to_string(), openai_root),
    ]
}

/// Every variable a metered agent receives, in a fixed order.
///
/// These are applied last and unconditionally by `spawn`, so they override
/// both persona `extra_env` and anything inherited from the parent process.
pub fn meter_env_vars(meter: &MeterEnv) -> Vec<(String, String)> {
    let mut vars = base_url_vars(meter.port);
    for name in METERED_CREDENTIAL_VARS {
        vars.push(((*name).to_string(), meter.virtual_key.clone()));
    }
    vars
}

/// The process-wide checkpoint, when metering is enabled.
///
/// There is exactly one checkpoint per harness process, so it lives here
/// rather than being threaded through every respawn and refill path. Set once
/// at startup; absent means metering is off and agents spawn as they always
/// did.
static ACTIVE_METER: std::sync::OnceLock<ActiveMeter> = std::sync::OnceLock::new();

/// A running checkpoint plus the means to mint per-agent keys.
pub struct ActiveMeter {
    /// Loopback port the checkpoint bound.
    pub port: u16,
    /// Mints and revokes virtual keys.
    pub handle: buzz_meter::MeterHandle,
}

/// Install the process-wide checkpoint. Returns `Err` if one is already set.
pub fn set_active_meter(meter: ActiveMeter) -> Result<(), ActiveMeter> {
    ACTIVE_METER.set(meter)
}

/// The process-wide checkpoint, if metering is on.
pub fn active_meter() -> Option<&'static ActiveMeter> {
    ACTIVE_METER.get()
}

/// Mint the environment for one agent, or `None` when metering is off.
///
/// `label` is the agent's hex pubkey. The checkpoint binds it to the issued
/// key, so every observed call carries a caller identity the agent did not
/// choose for itself.
pub fn issue_for_agent(label: &str) -> Option<MeterEnv> {
    let meter = active_meter()?;
    Some(MeterEnv {
        port: meter.port,
        virtual_key: meter.handle.issue_virtual_key(label),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> MeterEnv {
        MeterEnv {
            port: 51234,
            virtual_key: "colony-vk-abc123".to_string(),
        }
    }

    #[test]
    fn every_credential_variable_carries_the_virtual_key() {
        let vars = meter_env_vars(&sample());
        for name in METERED_CREDENTIAL_VARS {
            let value = vars
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.as_str());
            assert_eq!(
                value,
                Some("colony-vk-abc123"),
                "{name} must carry the virtual key, never a real credential"
            );
        }
    }

    #[test]
    fn base_urls_point_at_the_loopback_checkpoint() {
        let vars = meter_env_vars(&sample());
        let get = |name: &str| {
            vars.iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
                .unwrap_or_else(|| panic!("{name} must be set"))
        };
        assert_eq!(
            get("ANTHROPIC_BASE_URL"),
            "http://127.0.0.1:51234/anthropic"
        );
        assert_eq!(get("ANTHROPIC_HOST"), "http://127.0.0.1:51234/anthropic");
        assert_eq!(get("OPENAI_BASE_URL"), "http://127.0.0.1:51234/openai/v1");
        assert_eq!(get("OPENAI_API_BASE"), "http://127.0.0.1:51234/openai/v1");
        assert_eq!(get("OPENAI_HOST"), "http://127.0.0.1:51234/openai");

        // Loopback only. A checkpoint reachable off-box would be a provider
        // credential exposed to the network.
        for (name, value) in &vars {
            if name.ends_with("_BASE_URL") || name.ends_with("_HOST") || name.ends_with("_API_BASE")
            {
                assert!(
                    value.starts_with("http://127.0.0.1:"),
                    "{name} must stay on loopback, got {value}"
                );
            }
        }
    }

    #[test]
    fn no_variable_is_listed_twice() {
        let vars = meter_env_vars(&sample());
        let mut names: Vec<&str> = vars.iter().map(|(key, _)| key.as_str()).collect();
        names.sort_unstable();
        let count = names.len();
        names.dedup();
        assert_eq!(count, names.len(), "a duplicated key would be ambiguous");
    }
}
