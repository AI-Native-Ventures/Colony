//! Real ACP agent + real MCP descendants; only the model's HTTP responses are fixtures.
use super::*;
use serde_json::{json, Value};
use std::{fs, process::Stdio, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

async fn send(input: &mut tokio::process::ChildStdin, value: Value) {
    input
        .write_all(format!("{value}\n").as_bytes())
        .await
        .unwrap();
}

async fn receive(lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>) -> Value {
    let line = tokio::time::timeout(Duration::from_secs(15), lines.next_line())
        .await
        .expect("Agent timed out")
        .unwrap()
        .expect("Agent exited");
    serde_json::from_str(&line).unwrap()
}

async fn model_round(listener: &tokio::net::TcpListener, round: usize, victim: &Path) -> Value {
    let (mut socket, _) = listener.accept().await.unwrap();
    let mut buffer = vec![];
    let mut block = [0; 8192];
    let header_end = loop {
        let n = socket.read(&mut block).await.unwrap();
        assert!(n > 0);
        buffer.extend_from_slice(&block[..n]);
        assert!(buffer.len() < 1_000_000);
        if let Some(pos) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
    };
    let length = String::from_utf8_lossy(&buffer[..header_end])
        .lines()
        .find_map(|line| {
            line.to_lowercase()
                .strip_prefix("content-length:")
                .map(|value| value.trim().parse::<usize>().unwrap())
        })
        .unwrap();
    assert!(length < 1_000_000);
    while buffer.len() < header_end + length {
        let n = socket.read(&mut block).await.unwrap();
        assert!(n > 0);
        buffer.extend_from_slice(&block[..n]);
    }
    let request: Value = serde_json::from_slice(&buffer[header_end..header_end + length]).unwrap();
    let message = if round < 2 {
        let name = request["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find_map(|tool| {
                tool["function"]["name"]
                    .as_str()
                    .filter(|name| name.ends_with("__shell"))
            })
            .expect("Real MCP shell tool must be offered to the model");
        let command = if round == 0 {
            "printf AGENT_DRAFT_READY > draft.txt; cat draft.txt".to_string()
        } else {
            format!("/bin/sh -c 'cat \"$1\"' child '{}'", victim.display())
        };
        json!({"role":"assistant","content":null,"tool_calls":[{
            "id":format!("call_{round}"),"type":"function","function":{
                "name":name,"arguments":json!({"command":command,"timeout_ms":5000}).to_string()
            }
        }]})
    } else {
        json!({"role":"assistant","content":"Draft completed; sibling access was denied."})
    };
    let response = json!({"id":format!("round-{round}"),"object":"chat.completion","model":"fixture",
        "choices":[{"index":0,"message":message,"finish_reason":if round < 2 {"tool_calls"} else {"stop"}}]});
    let body = response.to_string();
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    request
}

#[tokio::test]
#[ignore = "Requires COLONY_ISOLATION_AGENT and COLONY_ISOLATION_MCP built binaries"]
async fn real_agent_completes_work_but_cannot_steal_through_its_shell_tool() {
    let agent = PathBuf::from(
        std::env::var_os("COLONY_ISOLATION_AGENT").expect("Set COLONY_ISOLATION_AGENT"),
    )
    .canonicalize()
    .unwrap();
    let mcp =
        PathBuf::from(std::env::var_os("COLONY_ISOLATION_MCP").expect("Set COLONY_ISOLATION_MCP"))
            .canonicalize()
            .unwrap();
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("worker");
    fs::create_dir(&workspace).unwrap();
    let victim = root.path().join("sibling-grant");
    fs::write(&victim, "SYNTHETIC_SIBLING_BROWSER_TOKEN").unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let mut policy = WorkerPolicy::new(&workspace).unwrap();
    policy.allow_runtime(&agent).unwrap();
    policy.allow_runtime(&mcp).unwrap();
    policy.allow_loopback_port(address.port()).unwrap();
    let mut command = tokio::process::Command::from(policy.command(agent.as_os_str()).unwrap());
    command
        .env("BUZZ_AGENT_PROVIDER", "openai")
        .env("OPENAI_COMPAT_API_KEY", "synthetic")
        .env("OPENAI_COMPAT_MODEL", "fixture")
        .env("OPENAI_COMPAT_BASE_URL", format!("http://{address}"))
        .env("BUZZ_AGENT_LLM_TIMEOUT_SECS", "5")
        .env("BUZZ_AGENT_TOOL_TIMEOUT_SECS", "5")
        .env("BUZZ_AGENT_MAX_ROUNDS", "4");
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    send(&mut input, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":2,"clientCapabilities":{}}})).await;
    let ready = receive(&mut lines).await;
    assert_eq!(
        ready["result"]["agentInfo"]["name"], "buzz-agent",
        "{ready}"
    );
    send(&mut input, json!({"jsonrpc":"2.0","id":2,"method":"session/new","params":{
        "cwd":workspace.canonicalize().unwrap(),"mcpServers":[{"name":"real","command":mcp,"args":[],"env":[]}]
    }})).await;
    let session = loop {
        let value = receive(&mut lines).await;
        if value["id"] == 2 {
            break value;
        }
    };
    let sid = session["result"]["sessionId"]
        .as_str()
        .expect("Real agent session starts");
    let provider = async {
        let mut requests = vec![];
        for round in 0..3 {
            requests.push(model_round(&listener, round, &victim).await);
        }
        requests
    };
    let conversation = async {
        send(&mut input, json!({"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{
            "sessionId":sid,"prompt":[{"type":"text","text":"Write the test draft and exercise the boundary."}]
        }})).await;
        loop {
            let value = receive(&mut lines).await;
            if value["method"] == "session/request_permission" {
                send(&mut input, json!({"jsonrpc":"2.0","id":value["id"],"result":{"outcome":{"outcome":"selected","optionId":"allow"}}})).await;
            } else if value["id"] == 3 {
                assert_eq!(value["result"]["stopReason"], "end_turn", "{value}");
                break;
            }
        }
    };
    let (requests, ()) = tokio::time::timeout(Duration::from_secs(30), async {
        tokio::join!(provider, conversation)
    })
    .await
    .expect("Complete agent run timed out");
    let final_request = requests[2].to_string();
    assert!(final_request.contains("AGENT_DRAFT_READY"));
    assert!(
        final_request.contains("Operation not permitted")
            || final_request.contains("Permission denied")
    );
    assert!(!final_request.contains("SYNTHETIC_SIBLING_BROWSER_TOKEN"));
    assert_eq!(
        fs::read_to_string(workspace.join("draft.txt")).unwrap(),
        "AGENT_DRAFT_READY"
    );
    assert_eq!(
        fs::read_to_string(&victim).unwrap(),
        "SYNTHETIC_SIBLING_BROWSER_TOKEN"
    );
    drop(input);
    let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .expect("Agent shuts down with MCP descendants")
        .unwrap();
    assert!(status.success(), "{status}");
}
