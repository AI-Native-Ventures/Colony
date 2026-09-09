//! Hosted macOS proof of the actual subscription MCP process wrapper.
use super::tool_server;
use crate::managed_agents::isolation::{launch, runtime_tests::response, WorkerPolicy};
use serde_json::{json, Value};
use std::{
    ffi::OsStr,
    fs,
    os::unix::fs::{symlink, PermissionsExt},
    path::PathBuf,
    process::Stdio,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[tokio::test]
#[ignore = "Requires packaged COLONY_ISOLATION_MCP and the macOS Seatbelt runtime"]
async fn subscription_tool_wrapper_denies_private_provider_profile_and_allows_worker_files() {
    let binary =
        PathBuf::from(std::env::var_os("COLONY_ISOLATION_MCP").expect("Set COLONY_ISOLATION_MCP"))
            .canonicalize()
            .unwrap();
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("worker");
    let profiles = root.path().join("subscription-profiles");
    let owner = profiles.join("synthetic-owner-business");
    let profile = owner.join("claude");
    for directory in [&workspace, &profiles, &owner, &profile] {
        launch::private_directory(directory).unwrap();
        assert_eq!(
            fs::metadata(directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    let secret = profile.join("auth.json");
    const SECRET: &str = "SYNTHETIC_SUBSCRIPTION_PROFILE_SECRET";
    fs::write(&secret, SECRET).unwrap();
    fs::set_permissions(&secret, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(workspace.join("brief.txt"), "SUBSCRIPTION_BRIEF_READY").unwrap();
    let link = workspace.join("profile-link");
    symlink(&secret, &link).unwrap();

    // Positive control: identical permissions and paths are readable without Seatbelt.
    // A denied read below cannot pass just because the file is missing or unreadable.
    for path in [&secret, &link] {
        let output = std::process::Command::new("/bin/cat")
            .arg(path)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, SECRET.as_bytes());
    }

    let mut policy = WorkerPolicy::new(&workspace).unwrap();
    policy.allow_runtime(&binary).unwrap();
    let original = OsStr::new("/bin/true");
    let captured = policy.command(original).unwrap();
    let server = tool_server(&captured, original, &binary, &[]).unwrap();
    // Execute the serialized command, arguments and environment exactly as a vendor
    // MCP client does. Claude inherits this cwd; Codex sets it on the MCP entry.
    let mut command = tokio::process::Command::new(server["command"].as_str().unwrap());
    command.env_clear().current_dir(&workspace);
    for argument in server["args"].as_array().unwrap() {
        command.arg(argument.as_str().unwrap());
    }
    for (key, value) in server["env"].as_object().unwrap() {
        command.env(key, value.as_str().unwrap());
    }
    let mut child = command
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    stdin.write_all(format!("{}\n", json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"subscription-boundary-proof","version":"1"}
    }})).as_bytes()).await.unwrap();
    let ready = response(&mut lines, 1).await;
    assert_eq!(
        ready["result"]["serverInfo"]["name"], "buzz-dev-mcp",
        "{ready}"
    );
    stdin
        .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n")
        .await
        .unwrap();

    let child_read = |path: &std::path::Path| {
        let quoted = format!("'{}'", path.to_string_lossy().replace('\'', "'\"'\"'"));
        json!({"command": format!("/bin/sh -c '/bin/cat \"$1\"' child {quoted}"), "timeout_ms":5000})
    };
    let calls = [
        (2, "read_file", json!({"path":"brief.txt"})),
        (
            3,
            "shell",
            json!({"command":"printf SUBSCRIPTION_DRAFT_READY > draft.txt; /bin/sh -c 'cat draft.txt'", "timeout_ms":5000}),
        ),
        (4, "read_file", json!({"path":secret})),
        (5, "shell", child_read(&secret)),
        (6, "read_file", json!({"path":"profile-link"})),
        (7, "shell", child_read(&link)),
    ];
    for (id, name, arguments) in calls {
        stdin.write_all(format!("{}\n", json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":name,"arguments":arguments}})).as_bytes()).await.unwrap();
        let reply: Value = response(&mut lines, id).await;
        let rendered = reply.to_string();
        assert!(
            !rendered.contains(SECRET),
            "Provider profile contents escaped the wrapper"
        );
        match id {
            2 | 3 => {
                assert!(
                    reply.get("error").is_none() && reply["result"]["isError"] != true,
                    "{reply}"
                );
                let marker = if id == 2 {
                    "SUBSCRIPTION_BRIEF_READY"
                } else {
                    "SUBSCRIPTION_DRAFT_READY"
                };
                assert!(rendered.contains(marker), "{reply}");
            }
            4 | 6 => assert!(
                reply.get("error").is_some() || reply["result"]["isError"] == true,
                "{reply}"
            ),
            5 | 7 => assert!(
                rendered.contains("Operation not permitted")
                    || rendered.contains("Permission denied"),
                "{reply}"
            ),
            _ => unreachable!(),
        }
    }
    child.kill().await.unwrap();
    child.wait().await.unwrap();
    assert_eq!(fs::read_to_string(&secret).unwrap(), SECRET);
    assert_eq!(
        fs::read_to_string(workspace.join("draft.txt")).unwrap(),
        "SUBSCRIPTION_DRAFT_READY"
    );
}
