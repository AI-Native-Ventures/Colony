//! Private scoped browser configuration for Electron-managed local processes.
use super::super::ManagedAgentRuntimeKey;
use std::{path::Path, process::Command};

pub(super) fn apply(
    command: &mut Command,
    key: &ManagedAgentRuntimeKey,
    generation: &str,
) -> Result<(), String> {
    command.env_remove("BUZZ_ACP_ELECTRON_BROWSER_CONFIG");
    let keys = [
        "COLONY_ELECTRON_BROWSER_ROOT",
        "COLONY_ELECTRON_BROWSER_COMMAND",
        "COLONY_ELECTRON_BROWSER_ADAPTER",
    ];
    for name in keys {
        command.env_remove(name);
    }
    if !crate::electron_host::enabled() {
        return Ok(());
    }
    let values = keys.map(|name| std::env::var(name).unwrap_or_default());
    let config = configuration(&values[0], &values[1], &values[2], key, generation)?;
    command.env("BUZZ_ACP_ELECTRON_BROWSER_CONFIG", config);
    // No fallback to a globally attachable DevTools browser in Electron.
    command.env("BUZZ_ACP_BROWSER_MCP_COMMAND", "");
    command.env("BUZZ_ACP_BROWSER_ENDPOINT", "");
    command.env("BUZZ_ACP_BROWSER_TARGET_ID", "");
    Ok(())
}

fn configuration(
    root: &str,
    command: &str,
    adapter: &str,
    key: &ManagedAgentRuntimeKey,
    generation: &str,
) -> Result<String, String> {
    if [root, command, adapter]
        .iter()
        .any(|value| value.is_empty() || !Path::new(value).is_absolute())
    {
        return Err("Electron browser connection is incomplete; restart Colony".into());
    }
    if generation.len() != 32 || !generation.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid native browser launch generation".into());
    }
    let grant = Path::new(root).join(format!("{}__{generation}.json", key.runtime_id()));
    Ok(serde_json::json!({"command": command, "adapter": adapter, "grant": grant}).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scoped_path_binds_the_launch_generation_and_contains_no_credentials() {
        let generation = "b".repeat(32);
        let key = ManagedAgentRuntimeKey::new("a".repeat(64), "wss://LOCALHOST:443/").unwrap();
        let base = std::env::temp_dir();
        let root = base.join("private-runtime");
        let command = base.join("electron");
        let adapter = base.join("browser.mjs");
        let value: serde_json::Value = serde_json::from_str(
            &configuration(
                root.to_str().unwrap(),
                command.to_str().unwrap(),
                adapter.to_str().unwrap(),
                &key,
                &generation,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            value["grant"],
            root.join(format!("{}__{generation}.json", key.runtime_id()))
                .to_str()
                .unwrap()
        );
        assert_eq!(value.as_object().unwrap().len(), 3);
        assert!(configuration("relative", "/electron", "/adapter", &key, &generation).is_err());
        assert!(configuration("/root", "", "/adapter", &key, &generation).is_err());
    }
}
