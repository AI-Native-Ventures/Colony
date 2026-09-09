//! Real subprocess proof that declared MCP env crosses the agent's env-clear boundary.

use std::process::Command;

use base64::{engine::general_purpose::STANDARD, Engine};
use buzz_ws_client::onboarding_fixture::CONFIG_ENV;

use super::{build_mcp_servers_tests::test_config, build_runtime_mcp_servers};

const CHILD: &str = "BUZZ_TEST_MCP_FIXTURE_CHILD";

#[test]
fn declared_mcp_fixture_transport_survives_child_env_clear() {
    if let Ok(mode) = std::env::var(CHILD) {
        let mut config = test_config();
        config.electron_browser = Some(super::config::ElectronBrowserConfig {
            command: "/fixture/electron".into(),
            adapter: "/fixture/adapter.mjs".into(),
            grant: "/fixture/grant.json".into(),
        });
        let result = build_runtime_mcp_servers(&config);
        if mode != "valid" {
            assert!(
                result.is_err(),
                "missing or malformed fixture config must fail closed"
            );
            return;
        }
        let servers = result.expect("validated fixture servers");
        let server = &servers[0];
        assert_eq!(server.command, config.mcp_command);
        assert_eq!(
            server
                .env
                .iter()
                .filter(|item| item.name == CONFIG_ENV)
                .count(),
            1
        );
        assert!(server
            .env
            .iter()
            .any(|item| item.name == "BUZZ_PRIVATE_KEY"));
        assert!(servers[1].env.iter().all(|item| item.name != CONFIG_ENV));
        // buzz-agent clears inherited env before applying these declared entries.
        // Launch a real child using only that public declaration, then check its
        // bytes without printing either its fixture config or identity entries.
        let child = Command::new("/usr/bin/env")
            .env_clear()
            .envs(server.env.iter().map(|item| (&item.name, &item.value)))
            .output()
            .expect("declared MCP child");
        assert!(child.status.success());
        let output = String::from_utf8(child.stdout).expect("child env encoding");
        let actual = output
            .lines()
            .find_map(|line| line.strip_prefix(&format!("{CONFIG_ENV}=")));
        assert_eq!(actual, std::env::var(CONFIG_ENV).ok().as_deref());
        return;
    }

    let directory = tempfile::tempdir().expect("fixture certificate directory");
    let certificate = directory.path().join("ca.der");
    let key = directory.path().join("ca.key");
    let output = Command::new("openssl")
        .args([
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=MCP fixture CA",
            "-outform",
            "DER",
            "-out",
        ])
        .arg(&certificate)
        .arg("-keyout")
        .arg(&key)
        .output()
        .expect("openssl fixture CA");
    assert!(output.status.success());
    let config = serde_json::json!({
        "version": 1,
        "ca_der_base64": STANDARD.encode(std::fs::read(certificate).expect("public CA")),
        "routes": [{"host": "business.mcp.invalid", "address": "127.0.0.1:32123"}],
    })
    .to_string();
    for (mode, value) in [
        ("valid", Some(config.as_str())),
        ("missing", None),
        ("malformed", Some("{}")),
    ] {
        let mut command = Command::new(std::env::current_exe().expect("test executable"));
        command.args(["--exact", "onboarding_fixture_mcp_tests::declared_mcp_fixture_transport_survives_child_env_clear", "--nocapture"])
            .env(CHILD, mode)
            .env_remove(CONFIG_ENV);
        if let Some(value) = value {
            command.env(CONFIG_ENV, value);
        }
        let result = command.output().expect("isolated fixture test");
        assert!(
            result.status.success(),
            "{mode}: {}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }
}
