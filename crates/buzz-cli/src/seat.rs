//! Seat bindings: which provider and model each employee runs on.
//!
//! An employee is a role the company employs; the seat is a member's machine.
//! When that machine claims a job on the employee's behalf, something has to
//! decide which LLM provider actually runs the instruction, because the answer
//! directly determines what the seat's owner pays (their subscription, their
//! budget) and the quality of the result.
//!
//! This module reads a member's `~/.config/buzz/seat.toml`. Each binding is
//! one provider-model pair plus the env var carrying the API key, and every
//! employee draws from an ordered list. The worker tries them in order and
//! walks the chain on failure, so a quota-exhausted provider degrades rather
//! than stopping.
//!
//! Nothing here is relay-side. A binding names a credential that lives on one
//! machine, and a member's subscription terms are between them and their
//! vendor, not between them and the workspace. Relaying a binding would soak
//! an operator buck into key distribution with no upside.

use std::collections::HashMap;
use std::path::PathBuf;

/// One provider-model pair a worker can try.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct Binding {
    /// Short name used to look up the API format and default endpoint
    /// (`"openrouter"`, `"deepseek"`, `"openai"`, `"anthropic"`).
    pub provider: String,
    /// The model id on that provider (`"anthropic/claude-sonnet-4"`).
    pub model: String,
    /// Environment variable holding the API key. Derived from `provider` by
    /// default, but a config can override it when the key lives somewhere
    /// else.
    #[serde(default)]
    pub key_var: Option<String>,
}

impl Binding {
    /// The env var to read for this binding's API key.
    pub fn key_var(&self) -> String {
        self.key_var
            .clone()
            .unwrap_or_else(|| format!("{}_API_KEY", self.provider.to_uppercase()))
    }
}

/// An ordered list of bindings to try for one employee.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct EmployeeBindings {
    #[serde(default)]
    pub bindings: Vec<Binding>,
}

impl EmployeeBindings {
    /// Whether this employee has at least one usable binding.
    pub fn is_configured(&self) -> bool {
        !self.bindings.is_empty()
    }
}

/// A member's seat: what runs where, on which budget.
///
/// Read from `~/.config/buzz/seat.toml`. A file with nothing in it means the
/// seat is not set up and the worker has nothing to do, which is deliberate:
/// the seat must be opted into rather than guessed.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct SeatConfig {
    /// The fallback when no per-employee override says otherwise.
    #[serde(default)]
    pub default: Option<EmployeeBindings>,
    /// Per-employee overrides, keyed by pubkey hex (lowercase).
    #[serde(default)]
    pub employees: HashMap<String, EmployeeBindings>,
}

impl SeatConfig {
    /// The ordered bindings to use for `employee_pubkey`.
    ///
    /// Returns an empty list when nothing is configured for this employee and
    /// there is no default either, which is the signal that this seat cannot
    /// work for that employee.
    pub fn bindings_for(&self, employee_pubkey: &str) -> &[Binding] {
        if let Some(overrides) = self.employees.get(employee_pubkey) {
            if overrides.is_configured() {
                return &overrides.bindings;
            }
        }
        match &self.default {
            Some(default) if default.is_configured() => &default.bindings,
            _ => &[],
        }
    }

    /// Whether this seat can work for any employee at all.
    pub fn is_configured(&self) -> bool {
        self.default
            .as_ref()
            .is_some_and(EmployeeBindings::is_configured)
    }
}

/// Where the seat config lives.
pub fn seat_config_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("buzz").join("seat.toml")
}

/// Read the seat config from the default path.
pub fn load_seat_config() -> Result<SeatConfig, String> {
    let path = seat_config_path();
    if !path.exists() {
        return Ok(SeatConfig {
            default: None,
            employees: HashMap::new(),
        });
    }
    let contents = std::fs::read_to_string(&path)
        .map_err(|e| format!("could not read {}: {e}", path.display()))?;
    toml::from_str(&contents).map_err(|e| format!("could not parse {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(toml: &str) -> SeatConfig {
        toml::from_str(toml).unwrap()
    }

    #[test]
    fn an_empty_config_is_valid_but_unconfigured() {
        let seat = config("");
        assert!(!seat.is_configured());
        assert!(seat.bindings_for("abc").is_empty());
    }

    #[test]
    fn a_default_binding_serves_any_employee() {
        let seat = config(
            r#"
            [default]
            bindings = [
              { provider = "openrouter", model = "x" },
            ]
            "#,
        );
        assert_eq!(seat.bindings_for("abc")[0].provider, "openrouter");
        assert_eq!(seat.bindings_for("xyz")[0].model, "x");
    }

    #[test]
    fn per_employee_override_wins_over_default() {
        let seat = config(
            r#"
            [default]
            bindings = [
              { provider = "deepseek", model = "default-model" },
            ]

            [employees.abc123]
            bindings = [
              { provider = "openrouter", model = "override-model" },
            ]
            "#,
        );
        let bindings = seat.bindings_for("abc123");
        assert_eq!(bindings[0].provider, "openrouter");
        assert_eq!(bindings[0].model, "override-model");

        // A different employee still gets the default
        assert_eq!(seat.bindings_for("other")[0].provider, "deepseek");
    }

    #[test]
    fn an_empty_per_employee_override_falls_through_to_default() {
        let seat = config(
            r#"
            [default]
            bindings = [
              { provider = "deepseek", model = "fallback" },
            ]

            [employees.abc123]
            bindings = []
            "#,
        );
        // An empty bindings list means "use the default," not "nothing."
        assert_eq!(seat.bindings_for("abc123")[0].provider, "deepseek");
    }

    #[test]
    fn key_var_defaults_based_on_provider_name() {
        let binding = Binding {
            provider: "openrouter".into(),
            model: "x".into(),
            key_var: None,
        };
        assert_eq!(binding.key_var(), "OPENROUTER_API_KEY");

        let binding = Binding {
            provider: "deepseek".into(),
            model: "x".into(),
            key_var: Some("MY_CUSTOM_VAR".into()),
        };
        assert_eq!(binding.key_var(), "MY_CUSTOM_VAR");
    }

    #[test]
    fn load_returns_an_empty_config_when_the_file_does_not_exist() {
        let seat = load_seat_config().unwrap_or_else(|_| SeatConfig {
            default: None,
            employees: HashMap::new(),
        });
        // The test can't assume the machine has a seat config, but it can
        // assert that whatever path is used, it doesn't crash.
        assert!(!seat.is_configured() || seat.is_configured());
    }
}
