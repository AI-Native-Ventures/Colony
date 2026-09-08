//! Exercise configuration in separate clean processes without mutating test-runner env.
use std::process::Command;

#[test]
fn deepseek_config_child() {
    let Ok(expected) = std::env::var("TEST_DEEPSEEK_KEY") else {
        return;
    };
    let config = buzz_agent::config::Config::from_env().expect("DeepSeek configuration");
    assert_eq!(config.api_key, expected);
    assert_eq!(config.base_url, "https://api.deepseek.com/v1");
}

#[test]
fn deepseek_configuration_accepts_native_and_legacy_credentials() {
    for (native, legacy, expected) in [
        (Some("synthetic-native"), None, "synthetic-native"),
        (None, Some("synthetic-legacy"), "synthetic-legacy"),
        (
            Some("synthetic-native"),
            Some("synthetic-legacy"),
            "synthetic-native",
        ),
    ] {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .env_clear()
            .arg("--exact")
            .arg("deepseek_config_child")
            .env("BUZZ_AGENT_PROVIDER", "deepseek")
            .env("BUZZ_AGENT_MODEL", "deepseek-chat")
            .env("TEST_DEEPSEEK_KEY", expected);
        if let Some(value) = native {
            command.env("DEEPSEEK_API_KEY", value);
        }
        if let Some(value) = legacy {
            command.env("OPENAI_COMPAT_API_KEY", value);
        }
        let result = command.output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stdout)
        );
    }
}
