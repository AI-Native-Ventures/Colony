use std::fs::OpenOptions;
use std::io::{self, BufRead, Write};
use std::process::Command;

use serde_json::{json, Value};

struct StubState {
    session_id: Option<String>,
    log_path: Option<String>,
}

impl Default for StubState {
    fn default() -> Self {
        Self {
            session_id: None,
            log_path: std::env::var("BUZZ_STUB_LOG").ok(),
        }
    }
}

struct ParsedBlock {
    ask_id: String,
    answer_command: Vec<String>,
}

fn handle_rpc(line: &str, state: &mut StubState) -> Option<String> {
    let request: Value = match serde_json::from_str(line) {
        Ok(request) => request,
        Err(error) => {
            eprintln!("ask stub received invalid JSON-RPC: {error}");
            return None;
        }
    };

    let id = request.get("id").cloned()?;

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
        "session/prompt" => {
            handle_prompt(params, state);
            json!({ "stopReason": "end_turn" })
        }
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

fn prompt_text(params: &Value) -> String {
    let Some(blocks) = params.get("prompt").and_then(Value::as_array) else {
        return String::new();
    };

    blocks
        .iter()
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

fn handle_prompt(params: &Value, state: &StubState) {
    let prompt = prompt_text(params);
    let entry = match parse_ask_block(&prompt) {
        Some(parsed) => {
            let (exit_code, stderr) = match parsed.answer_command.split_first() {
                Some((program, args)) => match Command::new(program).args(args).output() {
                    Ok(output) => (
                        output.status.code().unwrap_or(-1),
                        String::from_utf8_lossy(&output.stderr).into_owned(),
                    ),
                    Err(error) => (-1, error.to_string()),
                },
                None => (-1, "the answer command was empty".to_string()),
            };

            json!({
                "saw_block": true,
                "ask_id": parsed.ask_id,
                "argv": parsed.answer_command,
                "exit_code": exit_code,
                "stderr": stderr,
            })
        }
        None => json!({ "saw_block": false }),
    };

    if let Some(path) = state.log_path.as_deref() {
        if let Err(error) = log_line(path, &entry) {
            eprintln!("ask stub could not write prompt log: {error}");
        }
    }
}

fn parse_ask_block(prompt: &str) -> Option<ParsedBlock> {
    const START: &str = "<colony-ask>";
    const END: &str = "</colony-ask>";
    const DECISION: &str = "I decided to proceed";
    const RATIONALE: &str = "This is the best available option.";

    let start = prompt.find(START)?;
    let content_start = start + START.len();
    let end = prompt[content_start..].find(END)? + content_start;
    let block = &prompt[content_start..end];
    let ask_id = block.lines().find_map(|line| {
        line.trim()
            .strip_prefix("Ask id:")
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
    })?;

    let command = prompt[end + END.len()..]
        .split('`')
        .map(str::trim)
        .find(|candidate| candidate.starts_with("buzz asks answer"))?
        .replace("<what you decided>", DECISION)
        .replace("<why>", RATIONALE);
    let answer_command = split_argv(&command)?;

    Some(ParsedBlock {
        ask_id,
        answer_command,
    })
}

fn split_argv(command: &str) -> Option<Vec<String>> {
    let mut argv = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    let mut token_started = false;

    for character in command.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            token_started = true;
            continue;
        }

        if let Some(active_quote) = quote {
            match active_quote {
                '\'' => {
                    if character == '\'' {
                        quote = None;
                    } else {
                        current.push(character);
                    }
                }
                '"' => {
                    if character == '"' {
                        quote = None;
                    } else if character == '\\' {
                        escaped = true;
                    } else {
                        current.push(character);
                    }
                }
                _ => return None,
            }
            token_started = true;
            continue;
        }

        match character {
            '\'' | '"' => {
                quote = Some(character);
                token_started = true;
            }
            '\\' => {
                escaped = true;
                token_started = true;
            }
            character if character.is_whitespace() => {
                if token_started {
                    argv.push(std::mem::take(&mut current));
                    token_started = false;
                }
            }
            character => {
                current.push(character);
                token_started = true;
            }
        }
    }

    if escaped || quote.is_some() {
        return None;
    }
    if token_started {
        argv.push(current);
    }
    Some(argv)
}

fn log_line(path: &str, entry: &Value) -> io::Result<()> {
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    serde_json::to_writer(&mut file, entry)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    file.write_all(b"\n")
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

    const BLOCK: &str = "<colony-ask>\nAsk id: abc123\nType: decision\nHeadline: Which vendor?\nCost of delay: blocked\nTask id: task-7\n</colony-ask>\nSomeone below you is blocked on this and is waiting. Answer it if you can decide it, using the ask id verbatim:\n`buzz asks answer --ask abc123 --answer-json '{\"decision\":\"<what you decided>\",\"rationale\":\"<why>\"}'`\n";

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

    #[test]
    fn the_ask_id_comes_from_the_block_not_from_the_test() {
        let parsed = parse_ask_block(BLOCK).expect("a colony-ask block must parse");
        assert_eq!(parsed.ask_id, "abc123");
    }

    #[test]
    fn the_answer_command_is_taken_from_the_block_verbatim() {
        let parsed = parse_ask_block(BLOCK).expect("parses");
        assert_eq!(parsed.answer_command[0], "buzz");
        assert_eq!(parsed.answer_command[1], "asks");
        assert_eq!(parsed.answer_command[2], "answer");
        assert!(
            parsed.answer_command.contains(&"abc123".to_string()),
            "the command must carry the id the block gave, not one we invented"
        );
        assert_eq!(parsed.answer_command.len(), 7);
        assert_eq!(
            parsed.answer_command[6],
            r#"{"decision":"I decided to proceed","rationale":"This is the best available option."}"#
        );
        assert!(
            !parsed
                .answer_command
                .iter()
                .any(|a| a.contains("<what you decided>")),
            "placeholders must be substituted or the CLI receives literal angle brackets"
        );
    }

    #[test]
    fn a_prompt_with_no_block_parses_as_none() {
        assert!(parse_ask_block("just an ordinary chat message").is_none());
    }

    #[test]
    fn a_block_with_no_ask_id_parses_as_none() {
        assert!(parse_ask_block("<colony-ask>\nType: decision\n</colony-ask>").is_none());
    }
}
