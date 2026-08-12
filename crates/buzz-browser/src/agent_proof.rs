//! ACP agent wiring proof: a real agent drives the browser daemon.

use std::time::Duration;

use buzz_acp::{AcpClient, McpServer, SystemPromptTransport};

use crate::contracts::BrowserError;

/// The stdio MCP server config an ACP session receives.
pub fn browser_mcp_server(daemon_path: String) -> McpServer {
    McpServer {
        name: "buzz-browser".into(),
        command: daemon_path,
        args: vec!["mcp".into()],
        env: vec![],
    }
}

/// Attach the daemon to a real ACP session and prompt the agent to complete
/// the fixture journey. Requires an ACP agent binary on PATH.
pub async fn run_agent_proof(
    daemon_path: String,
    agent_command: String,
    agent_args: Vec<String>,
) -> Result<String, BrowserError> {
    // Fresh, neutral session context. The cwd must not be the repo root
    // (the agent harness then loads AGENTS.md and the spike plan and derails
    // into repo work instead of driving the browser), and a project-level
    // `.claude/settings.json` there applies a deny-all permissions file.
    // That file alone does not hold against claude-agent-acp: the adapter
    // hardcodes `ALLOW_BYPASS = !IS_ROOT` and passes
    // `allowDangerouslySkipPermissions` to the SDK, which emits
    // `--allow-dangerously-skip-permissions` and disables the settings
    // permission layer entirely. The binding lock is therefore the ACP
    // session's `_meta.claudeCode.options.disallowedTools`: the adapter
    // forwards it to the SDK as `--disallowedTools`, which strips the tools
    // from the agent's toolset BEFORE permission checks run, so the bypass
    // flag cannot resurrect them. The agent gets browser tools and nothing
    // else. The Claude config dir is deliberately left at its default: the
    // SDK resolves credentials against it, and a fresh CLAUDE_CONFIG_DIR
    // fails with "Authentication required" at the first prompt.
    let cwd = std::env::temp_dir().join(format!("buzz-browser-agent-proof-{}", std::process::id()));
    std::fs::create_dir_all(&cwd).map_err(BrowserError::Io)?;
    std::fs::create_dir_all(cwd.join(".claude")).map_err(BrowserError::Io)?;
    std::fs::write(
        cwd.join(".claude").join("settings.json"),
        r#"{
  "permissions": {
    "defaultMode": "deny",
    "allow": ["mcp__buzz-browser"],
    "deny": [
      "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch",
      "WebSearch", "TodoWrite", "Task", "NotebookEdit", "KillShell",
      "AskUserQuestion", "EnterPlanMode", "ExitPlanMode"
    ]
  }
}"#,
    )
    .map_err(BrowserError::Io)?;
    let mut acp = AcpClient::spawn(&agent_command, &agent_args, &[], false, None)
        .await
        .map_err(|e| BrowserError::Host(e.to_string()))?;
    acp.initialize()
        .await
        .map_err(|e| BrowserError::Host(e.to_string()))?;
    let cwd = cwd.to_string_lossy().to_string();
    let locked_down = serde_json::json!({
        "claudeCode": {
            "options": {
                "disallowedTools": [
                    "Bash", "Read", "Write", "Edit", "Glob", "Grep",
                    "WebFetch", "WebSearch", "TodoWrite", "Task",
                    "NotebookEdit", "KillShell", "AskUserQuestion",
                    "EnterPlanMode", "ExitPlanMode"
                ]
            }
        }
    });
    let session = acp
        .session_new_with_meta(
            &cwd,
            vec![browser_mcp_server(daemon_path)],
            Some(SystemPromptTransport::Field(
                "You have a browser MCP server whose tools are browser_connect, \
                 browser_navigate, browser_snapshot, browser_click, browser_type, \
                 browser_wait_for, browser_scroll, browser_screenshot, \
                 browser_tabs_list and context_budget_report. Use ONLY those \
                 tools: do not read files, do not run shell commands, do not \
                 write anything. Navigate to the interaction fixture at \
                 http://127.0.0.1:8777/interaction.html, call browser_connect \
                 first, fill the name field with colony-agent, submit, verify \
                 PASS appears, then call context_budget_report.",
            )),
            Some("browser-agent-proof"),
            Some(locked_down),
        )
        .await
        .map_err(|e| BrowserError::Host(e.to_string()))?;
    let stop = acp
        .session_prompt_with_idle_timeout(
            &session.session_id,
            "Complete the following journey using ONLY your browser MCP \
             tools (browser_connect, browser_navigate, browser_snapshot, \
             browser_click, browser_type, browser_wait_for, browser_scroll, \
             browser_screenshot, browser_tabs_list, context_budget_report). \
             Do not read files, do not run shell commands, do not write \
             anything: your toolset has been restricted to the browser MCP \
             server, so if you need details, inspect the page itself. \
             Target: http://127.0.0.1:8777/interaction.html. Call \
             browser_connect first, then browser_navigate to that URL, fill \
             the name field with colony-agent, submit, verify PASS appears, \
             then call context_budget_report and report the budget numbers \
             you observe.",
            Duration::from_secs(120),
            Duration::from_secs(600),
        )
        .await
        .map_err(|e| BrowserError::Host(e.to_string()))?;
    Ok(format!("{stop:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_server_config_points_at_daemon() {
        let server = browser_mcp_server("/abs/path/buzz-browserd".to_string());
        assert_eq!(server.name, "buzz-browser");
        assert_eq!(server.args, vec!["mcp"]);
    }
}
