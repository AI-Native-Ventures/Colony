use std::io::{self, BufRead, Write};

use serde_json::{json, Value};

#[derive(Default)]
struct StubState {
    session_id: Option<String>,
}

fn handle_rpc(line: &str, state: &mut StubState) -> Option<String> {
    let request: Value = match serde_json::from_str(line) {
        Ok(request) => request,
        Err(error) => {
            eprintln!("ask stub received invalid JSON-RPC: {error}");
            return None;
        }
    };

    let Some(id) = request.get("id").cloned() else {
        return None;
    };

    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = request.get("params").unwrap_or(&Value::Null);
    let result = match method {
        "initialize" => {
            let protocol_version = params
                .get("protocolVersion")
                .cloned()
                .unwrap_or_else(|| json!(2));
            json!({
                "protocolVersion": protocol_version,
                "agentCapabilities": {},
            })
        }
        "session/new" => {
            let session_id = uuid::Uuid::new_v4().to_string();
            state.session_id = Some(session_id.clone());
            json!({ "sessionId": session_id })
        }
        "session/prompt" => json!({ "stopReason": "end_turn" }),
        _ => json!({ "ok": true }),
    };

    Some(
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result,
        })
        .to_string(),
    )
}

fn run() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    let mut state = StubState::default();

    for line in stdin.lock().lines() {
        let line = line?;
        if let Some(response) = handle_rpc(&line, &mut state) {
            writeln!(stdout, "{response}")?;
            stdout.flush()?;
        }
    }

    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("ask stub failed: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_returns_a_result_for_the_same_id() {
        let mut state = StubState::default();
        let out = handle_rpc(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
            &mut state,
        )
        .expect("initialize must produce a response");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["id"], 1);
        assert!(v["result"].is_object());
    }

    #[test]
    fn session_new_returns_a_session_id() {
        let mut state = StubState::default();
        let out = handle_rpc(
            r#"{"jsonrpc":"2.0","id":2,"method":"session/new","params":{}}"#,
            &mut state,
        )
        .expect("session/new must produce a response");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(
            v["result"]["sessionId"].as_str().is_some(),
            "the harness errors with 'session/new response missing sessionId' without this"
        );
    }

    #[test]
    fn session_prompt_returns_a_stop_reason() {
        let mut state = StubState::default();
        handle_rpc(
            r#"{"jsonrpc":"2.0","id":2,"method":"session/new","params":{}}"#,
            &mut state,
        );
        let out = handle_rpc(
            r#"{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"prompt":[{"type":"text","text":"hello"}]}}"#,
            &mut state,
        )
        .expect("session/prompt must produce a response");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v["result"]["stopReason"].as_str().is_some());
    }

    #[test]
    fn an_unknown_method_does_not_kill_the_stub() {
        let mut state = StubState::default();
        assert!(handle_rpc(
            r#"{"jsonrpc":"2.0","id":9,"method":"session/cancel","params":{}}"#,
            &mut state,
        )
        .is_some());
    }

    #[test]
    fn a_notification_gets_no_response() {
        let mut state = StubState::default();
        assert!(handle_rpc(
            r#"{"jsonrpc":"2.0","method":"session/update","params":{}}"#,
            &mut state,
        )
        .is_none());
    }
}
