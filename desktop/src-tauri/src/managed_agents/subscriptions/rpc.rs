//! Bounded JSON-lines control client. It never sends a prompt or executes a tool.

use serde_json::{json, Value};
use std::{path::Path, process::Stdio};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::{timeout, Duration},
};

const MAX_FRAME: usize = 2 * 1024 * 1024;

pub(super) struct AccountRpc {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next_id: u64,
    claude: bool,
}

impl AccountRpc {
    pub(super) async fn codex(binary: &Path, profile: Option<&Path>) -> Result<Self, String> {
        let mut command = Command::new(binary);
        command
            .arg("app-server")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        // Never return stderr: vendor diagnostics can contain credentials or URLs.
        command.stderr(Stdio::null()).kill_on_drop(true);
        if let Some(profile) = profile {
            super::environment::dedicated(&mut command, profile, "CODEX_HOME");
        }
        let mut child = command
            .spawn()
            .map_err(|_| "Codex could not start".to_string())?;
        let input = child
            .stdin
            .take()
            .ok_or("Codex control input is unavailable")?;
        let output = BufReader::new(
            child
                .stdout
                .take()
                .ok_or("Codex control output is unavailable")?,
        );
        let mut client = Self {
            child,
            input,
            output,
            next_id: 0,
            claude: false,
        };
        client.request("initialize", json!({
            "clientInfo": {"name":"colony","title":"Colony","version":env!("CARGO_PKG_VERSION")}
        })).await?;
        client.notify("initialized", json!({})).await?;
        Ok(client)
    }

    /// Control-only use of the unmodified Claude CLI. No user prompt is sent.
    pub(super) async fn claude(
        binary: &Path,
        profile: Option<&Path>,
    ) -> Result<(Self, Value), String> {
        let mut command = Command::new(binary);
        command.args([
            "--print",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--tools",
            "",
            "--setting-sources",
            "",
            "--strict-mcp-config",
            "--mcp-config",
            "{\"mcpServers\":{}}",
            "--no-session-persistence",
            "--settings",
            "{\"disableAllHooks\":true}",
        ]);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if let Some(profile) = profile {
            super::environment::dedicated(&mut command, profile, "CLAUDE_CONFIG_DIR");
        }
        let mut child = command
            .spawn()
            .map_err(|_| "Claude could not start".to_string())?;
        let input = child
            .stdin
            .take()
            .ok_or("Claude control input is unavailable")?;
        let output = BufReader::new(
            child
                .stdout
                .take()
                .ok_or("Claude control output is unavailable")?,
        );
        let mut client = Self {
            child,
            input,
            output,
            next_id: 0,
            claude: true,
        };
        let initialized = client.request("initialize", json!({})).await?;
        Ok((client, initialized))
    }

    pub(super) async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        if self.claude {
            let mut request = params;
            request["subtype"] = Value::String(method.to_owned());
            self.send(
                &json!({"type":"control_request","request_id":id.to_string(),"request":request}),
            )
            .await?;
        } else {
            self.send(&json!({"id":id,"method":method,"params":params}))
                .await?;
        }
        timeout(Duration::from_secs(15), async {
            for _ in 0..128 {
                let message = self.read().await?;
                if self.claude && message["type"] == "control_response" && message["response"]["request_id"] == id.to_string() {
                    return (message["response"]["subtype"] == "success")
                        .then(|| message["response"]["response"].clone())
                        .ok_or_else(|| "Claude did not provide this account information. Update Claude Code or try again.".to_string());
                }
                if self.claude && message["type"] == "control_request" {
                    self.send(&json!({"type":"control_response","response":{
                        "subtype":"error","request_id":message["request_id"],"error":"Account inspection does not execute actions"
                    }})).await?;
                }
                if message.get("id").and_then(Value::as_u64) == Some(id) {
                    return message.get("result").cloned().ok_or_else(|| {
                        "Codex did not provide this account information. Update Codex or try again.".to_string()
                    });
                }
                // A metadata probe must never authorize a server-initiated tool/action.
                if message.get("method").is_some() && message.get("id").is_some() {
                    self.send(&json!({"id":message["id"],"error":{
                        "code":-32601,"message":"Account inspection does not execute actions"
                    }})).await?;
                }
            }
            Err("Codex returned too many account notifications".into())
        }).await.map_err(|_| "Codex account check timed out".to_string())?
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.send(&json!({"method":method,"params":params})).await
    }

    async fn send(&mut self, value: &Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(value).map_err(|_| "Invalid account request")?;
        bytes.push(b'\n');
        self.input
            .write_all(&bytes)
            .await
            .map_err(|_| "Codex connection ended".to_string())?;
        self.input
            .flush()
            .await
            .map_err(|_| "Codex connection ended".into())
    }

    async fn read(&mut self) -> Result<Value, String> {
        let mut frame = Vec::new();
        loop {
            let available = self
                .output
                .fill_buf()
                .await
                .map_err(|_| "Codex account read failed")?;
            if available.is_empty() {
                return Err("Codex account connection ended".into());
            }
            let consumed = available
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|index| index + 1)
                .unwrap_or(available.len());
            if frame.len() + consumed > MAX_FRAME {
                return Err("Codex account response was too large".into());
            }
            frame.extend_from_slice(&available[..consumed]);
            self.output.consume(consumed);
            if frame.last() == Some(&b'\n') {
                break;
            }
        }
        serde_json::from_slice(&frame)
            .map_err(|_| "Codex returned an unsupported account response".into())
    }

    pub(super) async fn close(mut self) {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
    }

    pub(super) async fn wait_for_codex_login(&mut self, login_id: &str) -> Result<(), String> {
        timeout(Duration::from_secs(300), async {
            loop {
                let message = self.read().await?;
                if message["method"] == "account/login/completed"
                    && message["params"]["loginId"] == login_id
                {
                    return if message["params"]["success"] == true {
                        Ok(())
                    } else {
                        Err("Codex sign-in did not complete. Try connecting again.".into())
                    };
                }
            }
        })
        .await
        .map_err(|_| "Codex sign-in timed out. Connect again when you are ready.".to_string())?
    }
}
