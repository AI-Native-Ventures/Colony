//! Token provenance for native subscription launches; never estimates API spend.
use std::path::Path;

pub(crate) fn runtime(
    command: &str,
    args: &[String],
    provisioned: bool,
    no_meter: bool,
) -> Option<&'static str> {
    if provisioned || !no_meter || args != ["--subscription-bridge"] {
        return None;
    }
    let own = std::env::current_exe().ok()?.canonicalize().ok()?;
    let command = Path::new(command).canonicalize().ok()?;
    if command != own {
        return None;
    }
    let encoded = std::env::var("BUZZ_SUBSCRIPTION_BRIDGE_CONFIG").ok()?;
    runtime_from_config(&encoded)
}

fn runtime_from_config(encoded: &str) -> Option<&'static str> {
    if encoded.len() > 256 * 1024 {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(encoded).ok()?;
    match value.get("runtime")?.as_str()? {
        "codex" => Some("codex-subscription"),
        "claude" => Some("claude-subscription"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_only_supported_vendor_metadata_without_returning_credentials() {
        assert_eq!(
            runtime_from_config(r#"{"runtime":"codex","secret":"synthetic"}"#),
            Some("codex-subscription")
        );
        assert_eq!(
            runtime_from_config(r#"{"runtime":"claude"}"#),
            Some("claude-subscription")
        );
        for invalid in ["", "{", r#"{"runtime":"unknown"}"#, r#"{"runtime":null}"#] {
            assert_eq!(runtime_from_config(invalid), None);
        }
    }

    #[test]
    fn api_and_credit_routes_cannot_be_relabelled_subscription() {
        let args = vec!["--subscription-bridge".to_owned()];
        assert_eq!(runtime("unused", &args, true, true), None);
        assert_eq!(runtime("unused", &args, false, false), None);
        assert_eq!(runtime("unused", &[], false, true), None);
    }
}
