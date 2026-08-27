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

/// Which providers the checkpoint holds a real credential for.
///
/// Only these have the agent's own credential taken away. For the rest the
/// agent keeps whatever it was logged in with (typically a CLI subscription),
/// and the checkpoint counts the tokens without paying for them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MeteredProviders {
    /// A real Anthropic key is configured.
    pub anthropic: bool,
    /// A real OpenAI key is configured.
    pub openai: bool,
}

impl MeteredProviders {
    /// True when the checkpoint pays for nothing, so every agent keeps its own
    /// login and every observed call is subscription-backed.
    pub fn none_configured(self) -> bool {
        !self.anthropic && !self.openai
    }
}

/// Where the checkpoint is listening and which key this agent authenticates
/// with.
#[derive(Clone, PartialEq, Eq)]
pub struct MeterEnv {
    /// Loopback port the checkpoint bound.
    pub port: u16,
    /// Per-agent virtual key minted by the checkpoint.
    pub virtual_key: String,
    /// Providers whose credential the checkpoint owns.
    pub metered: MeteredProviders,
}

impl std::fmt::Debug for MeterEnv {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MeterEnv")
            .field("port", &self.port)
            .field("virtual_key", &"<redacted>")
            .field("metered", &self.metered)
            .finish()
    }
}

/// Provider credential variables the harness overwrites, per provider.
///
/// When the checkpoint holds that provider's key, an agent must not be able to
/// read a real credential from its environment, whether the operator exported
/// one or a persona supplied it. When the checkpoint holds no key, the
/// opposite is true: taking the agent's credential away would leave nothing
/// able to authenticate the call, which is exactly how a subscription login
/// used to fail with "no provider credential configured".
pub const ANTHROPIC_CREDENTIAL_VARS: &[&str] = &["ANTHROPIC_API_KEY"];
pub const OPENAI_CREDENTIAL_VARS: &[&str] = &[
    "OPENAI_API_KEY",
    "OPENAI_COMPAT_API_KEY",
    "OPENROUTER_API_KEY",
];

/// Base-URL variables pointing agents at the checkpoint.
///
/// Several names for the same two endpoints, because SDKs and harnesses
/// disagree about which one they read. Setting one an agent ignores costs
/// nothing; missing the one it reads means its spend is never counted.
fn base_url_vars(port: u16, virtual_key: &str) -> Vec<(String, String)> {
    let anthropic = format!("http://127.0.0.1:{port}/anthropic/k/{virtual_key}");
    let openai_root = format!("http://127.0.0.1:{port}/openai/k/{virtual_key}");
    let openai_v1 = openai_v1_url(port, virtual_key);
    vec![
        ("ANTHROPIC_BASE_URL".to_string(), anthropic.clone()),
        ("ANTHROPIC_HOST".to_string(), anthropic),
        ("OPENAI_BASE_URL".to_string(), openai_v1.clone()),
        ("OPENAI_API_BASE".to_string(), openai_v1.clone()),
        // `buzz-agent` on the `openai-compat` provider reads this name and no
        // other, so without it a metered agent falls back to the vendor
        // default and bills a real provider with a Colony gateway token.
        ("OPENAI_COMPAT_BASE_URL".to_string(), openai_v1),
        ("OPENAI_HOST".to_string(), openai_root),
    ]
}

/// The one OpenAI-dialect checkpoint endpoint, shared by the env vars and the
/// codex gateway so the two routes cannot drift onto different URLs.
fn openai_v1_url(port: u16, virtual_key: &str) -> String {
    format!("http://127.0.0.1:{port}/openai/k/{virtual_key}/v1")
}

/// ACP `providers/set` params pointing a Codex adapter at the checkpoint.
///
/// Codex ignores the `OPENAI_BASE_URL`-style variables above — it routes by
/// its own provider config. The codex-acp adapter's custom-gateway provider
/// is the supported override: it forces every session onto this base URL,
/// sends the headers on every request, and skips the ChatGPT login gate. The
/// virtual key rides in `Authorization`, so the checkpoint attributes each
/// call to the agent the key was minted for.
pub fn metered_gateway_params(meter: &MeterEnv) -> serde_json::Value {
    serde_json::json!({
        "providerId": "custom-gateway",
        "apiType": "openai",
        "baseUrl": openai_v1_url(meter.port, &meter.virtual_key),
        "headers": {
            "Authorization": format!("Bearer {}", meter.virtual_key),
        },
    })
}

/// Every variable a metered agent receives, in a fixed order.
///
/// These are applied last and unconditionally by `spawn`, so they override
/// both persona `extra_env` and anything inherited from the parent process.
pub fn meter_env_vars(meter: &MeterEnv) -> Vec<(String, String)> {
    let mut vars = base_url_vars(meter.port, &meter.virtual_key);
    // The agent is identified by the URL it calls, so its credential only has
    // to be replaced where the checkpoint has one of its own to substitute.
    if meter.metered.anthropic {
        for name in ANTHROPIC_CREDENTIAL_VARS {
            vars.push(((*name).to_string(), meter.virtual_key.clone()));
        }
    }
    if meter.metered.openai {
        for name in OPENAI_CREDENTIAL_VARS {
            vars.push(((*name).to_string(), meter.virtual_key.clone()));
        }
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
    /// Providers the checkpoint holds a real credential for.
    pub metered: MeteredProviders,
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
        metered: meter.metered,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> MeterEnv {
        MeterEnv {
            port: 51234,
            virtual_key: "colony-vk-abc123".to_string(),
            metered: MeteredProviders {
                anthropic: true,
                openai: true,
            },
        }
    }

    #[test]
    fn every_credential_variable_carries_the_virtual_key() {
        let vars = meter_env_vars(&sample());
        for name in ANTHROPIC_CREDENTIAL_VARS
            .iter()
            .chain(OPENAI_CREDENTIAL_VARS)
        {
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
    fn openai_compatible_credentials_are_also_replaced() {
        let vars = meter_env_vars(&sample());
        assert_eq!(
            vars.iter()
                .find(|(key, _)| key == "OPENAI_COMPAT_API_KEY")
                .map(|(_, value)| value.as_str()),
            Some("colony-vk-abc123")
        );
    }

    /// A checkpoint holding no key must not take the agent's credential away:
    /// that is what turned a working subscription login into
    /// "no provider credential configured".
    #[test]
    fn a_subscription_agent_keeps_its_own_credential() {
        let vars = meter_env_vars(&MeterEnv {
            port: 51234,
            virtual_key: "colony-vk-abc123".to_string(),
            metered: MeteredProviders::default(),
        });

        for name in ANTHROPIC_CREDENTIAL_VARS
            .iter()
            .chain(OPENAI_CREDENTIAL_VARS)
        {
            assert!(
                !vars.iter().any(|(key, _)| key == name),
                "{name} must be left alone when the checkpoint has no key to substitute"
            );
        }
        assert_eq!(
            vars.iter()
                .find(|(key, _)| key == "ANTHROPIC_BASE_URL")
                .map(|(_, value)| value.as_str()),
            Some("http://127.0.0.1:51234/anthropic/k/colony-vk-abc123"),
            "attribution moves to the URL so the credential header can stay the agent's"
        );
    }

    /// One key present and the other absent is the common real case: it must
    /// be decided per provider, not for the whole harness.
    #[test]
    fn only_the_funded_provider_has_its_credential_replaced() {
        let vars = meter_env_vars(&MeterEnv {
            port: 51234,
            virtual_key: "colony-vk-abc123".to_string(),
            metered: MeteredProviders {
                anthropic: false,
                openai: true,
            },
        });

        assert!(
            !vars.iter().any(|(key, _)| key == "ANTHROPIC_API_KEY"),
            "no Anthropic key is configured, so the agent keeps its subscription login"
        );
        assert_eq!(
            vars.iter()
                .find(|(key, _)| key == "OPENAI_API_KEY")
                .map(|(_, value)| value.as_str()),
            Some("colony-vk-abc123"),
            "the funded provider still routes through the checkpoint's own key"
        );
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
        // Each URL carries the agent's virtual key, which is what identifies
        // the caller when the credential header belongs to the agent.
        assert_eq!(
            get("ANTHROPIC_BASE_URL"),
            "http://127.0.0.1:51234/anthropic/k/colony-vk-abc123"
        );
        assert_eq!(
            get("ANTHROPIC_HOST"),
            "http://127.0.0.1:51234/anthropic/k/colony-vk-abc123"
        );
        assert_eq!(
            get("OPENAI_BASE_URL"),
            "http://127.0.0.1:51234/openai/k/colony-vk-abc123/v1"
        );
        assert_eq!(
            get("OPENAI_API_BASE"),
            "http://127.0.0.1:51234/openai/k/colony-vk-abc123/v1"
        );
        // The name `buzz-agent` reads on `openai-compat`. Missing it sent a
        // metered agent to the vendor default carrying a Colony token.
        assert_eq!(
            get("OPENAI_COMPAT_BASE_URL"),
            "http://127.0.0.1:51234/openai/k/colony-vk-abc123/v1"
        );
        assert_eq!(
            get("OPENAI_HOST"),
            "http://127.0.0.1:51234/openai/k/colony-vk-abc123"
        );

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
    fn gateway_params_route_codex_through_the_checkpoint() {
        let params = metered_gateway_params(&sample());
        assert_eq!(params["providerId"], "custom-gateway");
        assert_eq!(params["apiType"], "openai");
        assert_eq!(
            params["baseUrl"],
            "http://127.0.0.1:51234/openai/k/colony-vk-abc123/v1"
        );
        assert_eq!(
            params["headers"]["Authorization"],
            "Bearer colony-vk-abc123"
        );
    }

    #[test]
    fn gateway_base_url_is_the_same_endpoint_the_env_vars_advertise() {
        // codex reaches the checkpoint through providers/set while SDK agents
        // read OPENAI_BASE_URL. Two formats drifting apart would silently
        // split the metered surface in half.
        let meter = sample();
        let params = metered_gateway_params(&meter);
        let env_url = meter_env_vars(&meter)
            .into_iter()
            .find(|(key, _)| key == "OPENAI_BASE_URL")
            .map(|(_, value)| value)
            .expect("OPENAI_BASE_URL must be set");
        assert_eq!(params["baseUrl"].as_str(), Some(env_url.as_str()));
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
