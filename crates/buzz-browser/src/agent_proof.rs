//! ACP agent wiring proof: a real agent drives the browser daemon.

use std::time::Duration;

use buzz_acp::{AcpClient, McpServer};

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
    let mut acp = AcpClient::spawn(&agent_command, &agent_args, &[], false, None)
        .await
        .map_err(|e| BrowserError::Host(e.to_string()))?;
    acp.initialize()
        .await
        .map_err(|e| BrowserError::Host(e.to_string()))?;
    let cwd = std::env::current_dir()
        .map_err(BrowserError::Io)?
        .to_str()
        .unwrap_or("/tmp")
        .to_string();
    let session = acp
        .session_new_full(
            &cwd,
            vec![browser_mcp_server(daemon_path)],
            Some(
                "You have a browser MCP server. Navigate to the interaction \
                 fixture at http://127.0.0.1:8777/interaction.html, call \
                 browser_connect first, fill the name field with \
                 colony-agent, submit, verify PASS appears, then call \
                 context_budget_report.",
            ),
            Some("browser-agent-proof"),
        )
        .await
        .map_err(|e| BrowserError::Host(e.to_string()))?;
    let stop = acp
        .session_prompt_with_idle_timeout(
            &session.session_id,
            "Complete the journey.",
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

    #[test]
    fn module_loads() {}
}
