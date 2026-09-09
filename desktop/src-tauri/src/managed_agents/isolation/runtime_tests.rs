//! Opt-in tests require the real, locally built binaries. No tools are mocked.
use super::*;
use serde_json::{json, Value};
use std::{fs, process::Stdio, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

async fn response(
    lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    id: u64,
) -> Value {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let line = lines
                .next_line()
                .await
                .unwrap()
                .expect("MCP process exited");
            let value: Value = serde_json::from_str(&line).unwrap();
            if value["id"] == id {
                return value;
            }
        }
    })
    .await
    .expect("MCP response timed out")
}

#[tokio::test]
#[ignore = "Requires COLONY_ISOLATION_MCP pointing to a built buzz-dev-mcp binary"]
async fn real_mcp_reads_and_shell_children_obey_the_os_boundary() {
    let binary =
        PathBuf::from(std::env::var_os("COLONY_ISOLATION_MCP").expect("Set COLONY_ISOLATION_MCP"))
            .canonicalize()
            .unwrap();
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("worker");
    fs::create_dir(&workspace).unwrap();
    let victim = root.path().join("sibling-grant");
    fs::write(&victim, "SYNTHETIC_VICTIM_TOKEN").unwrap();
    fs::write(workspace.join("brief.txt"), "MAKE_A_DRAFT").unwrap();
    let mut policy = WorkerPolicy::new(&workspace).unwrap();
    policy.allow_runtime(&binary).unwrap();
    let command = policy.command(binary.as_os_str()).unwrap();
    let mut command = tokio::process::Command::from(command);
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
        "protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"isolation-proof","version":"1"}
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
    let calls = [
        (2, "read_file", json!({"path":"brief.txt"})),
        (3, "read_file", json!({"path":victim})),
        (
            4,
            "shell",
            json!({"command":"printf DRAFT_READY > draft.txt; cat draft.txt", "timeout_ms":5000}),
        ),
        (
            5,
            "shell",
            json!({"command":format!("/bin/sh -c 'cat \"$1\"' child '{}'", victim.display()), "timeout_ms":5000}),
        ),
    ];
    for (id, name, arguments) in calls {
        stdin.write_all(format!("{}\n", json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":name,"arguments":arguments}})).as_bytes()).await.unwrap();
        let reply = response(&mut lines, id).await;
        let rendered = reply.to_string();
        match id {
            2 => assert!(rendered.contains("MAKE_A_DRAFT"), "{reply}"),
            3 => assert!(
                reply.get("error").is_some() || reply["result"]["isError"] == true,
                "{reply}"
            ),
            4 => assert!(rendered.contains("DRAFT_READY"), "{reply}"),
            5 => assert!(
                rendered.contains("Operation not permitted")
                    || rendered.contains("Permission denied"),
                "{reply}"
            ),
            _ => unreachable!(),
        }
        assert!(
            !rendered.contains("SYNTHETIC_VICTIM_TOKEN"),
            "Sibling secret escaped"
        );
    }
    assert_eq!(
        fs::read_to_string(workspace.join("draft.txt")).unwrap(),
        "DRAFT_READY"
    );
    child.kill().await.unwrap();
    child.wait().await.unwrap();
}

#[test]
#[ignore = "Requires COLONY_ISOLATION_ELECTRON pointing to the packaged executable"]
fn electron_node_adapter_boots_beneath_an_isolated_parent() {
    let binary = PathBuf::from(
        std::env::var_os("COLONY_ISOLATION_ELECTRON").expect("Set COLONY_ISOLATION_ELECTRON"),
    )
    .canonicalize()
    .unwrap();
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("worker");
    fs::create_dir(&workspace).unwrap();
    let mut policy = WorkerPolicy::new(&workspace).unwrap();
    policy
        .allow_runtime(binary.parent().unwrap().parent().unwrap())
        .unwrap();
    policy
        .allow_log_metadata(&root.path().join("host-log"))
        .unwrap();
    let output = policy
        .command(OsStr::new("/bin/sh"))
        .unwrap()
        .env("ELECTRON_RUN_AS_NODE", "1")
        .args([
            "-c",
            "\"$1\" -e 'console.log(\"ISOLATED_NODE_READY\")'; result=$?; exit $result",
            "parent",
        ])
        .arg(binary)
        .stderr(std::fs::File::create(root.path().join("host-log")).unwrap())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        fs::read_to_string(root.path().join("host-log")).unwrap()
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("ISOLATED_NODE_READY"));
}

#[test]
fn https_probe_child() {
    if std::env::var("COLONY_ISOLATION_HTTPS_CHILD").as_deref() != Ok("1") {
        return;
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();
    let response = client.get("https://example.com").send().unwrap();
    assert!(response.status().is_success(), "{}", response.status());
    println!("VERIFIED_HTTPS_READY");
}

#[test]
#[ignore = "Live public HTTPS verification through the private gateway; no credentials"]
fn isolated_http_client_verifies_public_tls_through_gateway() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("worker");
    fs::create_dir(&workspace).unwrap();
    let binary = std::env::current_exe().unwrap();
    let gateway = super::network::WorkerNetwork::start(vec![super::network::Destination::resolve(
        "https://example.com",
    )
    .unwrap()])
    .unwrap();
    let mut policy = WorkerPolicy::new(&workspace).unwrap();
    policy.allow_runtime(&binary).unwrap();
    policy.allow_loopback_port(gateway.port()).unwrap();
    let output = policy
        .command(binary.as_os_str())
        .unwrap()
        .env("COLONY_ISOLATION_HTTPS_CHILD", "1")
        .env("HTTPS_PROXY", gateway.proxy_url())
        .env("NO_PROXY", "")
        .args([
            "managed_agents::isolation::runtime_tests::https_probe_child",
            "--exact",
            "--nocapture",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("VERIFIED_HTTPS_READY"));
}
