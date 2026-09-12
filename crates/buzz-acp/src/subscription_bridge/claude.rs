//! Unmodified Claude CLI with built-ins disabled and native-isolated MCP tools.

use super::{config::Config, io::Wire};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};

pub(crate) struct Claude {
    wire: Wire,
    config: Config,
    interrupted: bool,
}

impl Claude {
    pub(crate) async fn start(config: &Config, system_prompt: &str) -> Result<Self> {
        super::capability::claude(config).await?;
        let command = restricted_command(config, system_prompt);
        let mut agent = Self {
            wire: Wire::spawn(command)?,
            config: config.clone(),
            interrupted: false,
        };
        let result = agent.initialize().await;
        if let Err(error) = result {
            agent.shutdown().await;
            return Err(error);
        }
        Ok(agent)
    }

    async fn initialize(&mut self) -> Result<()> {
        let agent = self;
        let config = agent.config.clone();
        agent.wire.send(json!({"type":"control_request","request_id":"initialize","request":{"subtype":"initialize"}})).await?;
        let initialized = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            loop {
                let message = agent.wire.read().await?;
                if message["type"] == "control_response"
                    && message["response"]["request_id"] == "initialize"
                {
                    if message["response"]["subtype"] != "success" {
                        bail!("Claude did not initialize the restricted runtime");
                    }
                    return Ok::<_, anyhow::Error>(message["response"]["response"].clone());
                }
                agent.control(&message).await?;
            }
        })
        .await
        .context("Claude startup timed out")??;
        let account = &initialized["account"];
        let key = account["apiKeySource"].as_str();
        if account["subscriptionType"]
            .as_str()
            .is_none_or(str::is_empty)
            || !account["tokenSource"].is_null()
            || account["apiProvider"]
                .as_str()
                .is_some_and(|value| value != "firstParty")
            || !matches!(
                key,
                None | Some("none" | "user" | "project" | "org" | "temporary" | "oauth")
            )
        {
            bail!("Connect a Claude subscription for this business before starting the agent");
        }
        let Some(entry) = initialized["models"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|model| model["value"] == config.model || model["id"] == config.model)
        else {
            bail!("Claude no longer offers the selected model. Choose a model in Power setup");
        };
        require_supported_effort(entry, config.reasoning_effort.as_deref())?;
        Ok(())
    }

    pub(crate) async fn prompt(
        &mut self,
        content: Vec<Value>,
        updates: mpsc::Sender<Value>,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<&'static str> {
        self.interrupted = false;
        if *cancel.borrow() {
            return Ok("cancelled");
        }
        self.wire.send(json!({"type":"user","session_id":"","parent_tool_use_id":null,"message":{"role":"user","content":content}})).await?;
        let deadline = tokio::time::sleep(std::time::Duration::from_secs(30 * 60));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _ = &mut deadline => bail!("Claude work timed out. Restart the teammate to retry"),
                message = self.wire.read() => {
                    let message = message?;
                    if message["type"] == "assistant" {
                        for block in message["message"]["content"].as_array().into_iter().flatten() {
                            if let Some(text) = block.get("text").and_then(Value::as_str) {
                                let update = json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}});
                                tokio::select! {
                                    result = updates.send(update) => result.context("Agent response was closed")?,
                                    _ = cancel.changed() => return Ok("cancelled"),
                                }
                            }
                        }
                    }
                    if message["type"] == "result" {
                        if let Some(update) = usage_update(&message) {
                            tokio::select! {
                                result = updates.send(update) => result.context("Agent response was closed")?,
                                _ = cancel.changed() => return Ok("cancelled"),
                            }
                        }
                        if self.interrupted { return Ok("cancelled"); }
                        if message["is_error"] == true || message["subtype"] != "success" {
                            bail!("Claude could not finish this turn. Check the connected account and its usage in Power setup");
                        }
                        return Ok("end_turn");
                    }
                    self.control(&message).await?;
                }
                changed = cancel.changed(), if !self.interrupted => {
                    if changed.is_err() || *cancel.borrow() {
                        self.interrupted = true;
                        self.wire.send(json!({"type":"control_request","request_id":"cancel","request":{"subtype":"interrupt"}})).await?;
                        return Ok("cancelled");
                    }
                }
            }
        }
    }

    async fn control(&mut self, message: &Value) -> Result<()> {
        if message["type"] != "control_request" {
            return Ok(());
        }
        let response = permission_response(&self.config, &message["request"]);
        self.wire.send(json!({"type":"control_response","response":{"subtype":"success","request_id":message["request_id"],"response":response}})).await
    }

    pub(crate) async fn shutdown(&mut self) {
        self.wire.close().await;
    }
}

fn restricted_command(config: &Config, system_prompt: &str) -> tokio::process::Command {
    let mut command = config.vendor_command();
    command.args([
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--restricted",
        "--tools",
        "",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--permission-prompt-tool",
        "stdio",
        "--settings",
        "{\"disableAllHooks\":true}",
        "--model",
        &config.model,
        "--mcp-config",
        &json!({"mcpServers": config.mcp_servers}).to_string(),
    ]);
    // Claude takes the effort as a session flag rather than a per-turn field, and
    // only for a model that advertised support for one (`initialize` gates this
    // through `require_supported_effort`). Absent leaves the CLI's own default.
    if let Some(effort) = &config.reasoning_effort {
        command.arg("--effort").arg(effort);
    }
    if !system_prompt.is_empty() {
        command.arg("--append-system-prompt").arg(system_prompt);
    }
    command
}

/// Accept the chosen effort only when this model's own initialize entry advertises
/// it.
///
/// Claude reports `supportsEffort` plus a flat `supportedEffortLevels` array, and
/// omits both for a model that has no effort axis at all (measured: Haiku). Either
/// way, an effort the model did not advertise fails startup instead of reaching
/// `--effort`, where the CLI's own rejection would surface as an unexplained
/// teammate that cannot start.
fn require_supported_effort(entry: &Value, effort: Option<&str>) -> Result<()> {
    let Some(effort) = effort else {
        return Ok(());
    };
    let advertised = entry["supportsEffort"] == true
        && entry["supportedEffortLevels"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|level| level.as_str() == Some(effort));
    if !advertised {
        bail!("This model does not offer that reasoning effort on your Claude subscription. Choose one in Power setup");
    }
    Ok(())
}

fn permission_response(config: &Config, request: &Value) -> Value {
    let allowed = request["subtype"] == "can_use_tool"
        && request["tool_name"]
            .as_str()
            .is_some_and(|tool| config.permits_mcp_tool(tool));
    if allowed {
        json!({"behavior":"allow","updatedInput":request["input"]})
    } else {
        json!({"behavior":"deny","message":"Use the Colony work tools for this task"})
    }
}

/// The vendor's result.modelUsage is cumulative across streaming-input turns.
/// API-equivalent dollar estimates are intentionally excluded for subscriptions.
fn usage_update(result: &Value) -> Option<Value> {
    let models = result["modelUsage"].as_object()?;
    if models.is_empty() {
        return None;
    }
    let mut input = 0u64;
    let mut output = 0u64;
    let mut cached = 0u64;
    let mut created = 0u64;
    for usage in models.values() {
        input = input.checked_add(usage["inputTokens"].as_u64()?)?;
        output = output.checked_add(usage["outputTokens"].as_u64()?)?;
        cached = cached.checked_add(usage["cacheReadInputTokens"].as_u64()?)?;
        created = created.checked_add(usage["cacheCreationInputTokens"].as_u64()?)?;
    }
    let mut update = json!({"sessionUpdate":"usage_update",
        "accumulatedInputTokens":input.checked_add(cached)?.checked_add(created)?,
        "accumulatedOutputTokens":output,"accumulatedCachedInputTokens":cached,
        "accumulatedCacheWriteTokens":created});
    if models.len() == 1 {
        if let Some((name, usage)) = models.iter().next() {
            update["model"] = json!(usage["canonicalModel"].as_str().unwrap_or(name));
        }
    }
    Some(update)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Config {
        Config {
            runtime: "claude".into(),
            vendor_binary: "/synthetic/claude".into(),
            profile: "/private/provider".into(),
            workspace: "/private/worker".into(),
            model: "synthetic-model".into(),
            reasoning_effort: None,
            mcp_servers: json!({"colony_work":{"command":"/usr/bin/sandbox-exec","args":["synthetic"],"env":{}}}),
            host_login: None,
        }
    }

    #[test]
    fn result_tokens_are_cumulative_and_never_subscription_dollar_cost() {
        let result = json!({"modelUsage":{"synthetic-model":{"inputTokens":10,"outputTokens":20,
            "cacheReadInputTokens":30,"cacheCreationInputTokens":40,"costUSD":99.0}},
            "usage":{"input_tokens":1},"total_cost_usd":99.0});
        let update = usage_update(&result).unwrap();
        assert_eq!(update["accumulatedInputTokens"], 80);
        assert_eq!(update["accumulatedOutputTokens"], 20);
        assert_eq!(update["accumulatedCachedInputTokens"], 30);
        assert_eq!(update["accumulatedCacheWriteTokens"], 40);
        assert!(update.get("accumulatedCost").is_none());
        assert_eq!(usage_update(&json!({"modelUsage":{}})), None);
        assert_eq!(
            usage_update(&json!({"modelUsage":{"synthetic-model":{"inputTokens":1}}})),
            None
        );
    }

    #[test]
    fn builtin_and_unapproved_server_tools_never_receive_permission() {
        for tool in [
            "Bash",
            "Read",
            "Write",
            "Agent",
            "Skill",
            "mcp__foreign__shell",
            "mcp__colony_work_elsewhere__shell",
        ] {
            assert_eq!(
                permission_response(
                    &config(),
                    &json!({"subtype":"can_use_tool","tool_name":tool,"input":{}})
                )["behavior"],
                "deny"
            );
        }
        assert_eq!(
            permission_response(
                &config(),
                &json!({"subtype":"can_use_tool","tool_name":"mcp__colony_work__shell","input":{"command":"synthetic"}})
            ),
            json!({"behavior":"allow","updatedInput":{"command":"synthetic"}})
        );
        assert_eq!(
            permission_response(
                &config(),
                &json!({"subtype":"start_hook","tool_name":"mcp__colony_work__shell"})
            )["behavior"],
            "deny"
        );
    }

    #[test]
    fn an_effort_reaches_the_cli_only_when_the_model_advertised_it() {
        let arguments = |config: &Config| -> Vec<String> {
            restricted_command(config, "")
                .as_std()
                .get_args()
                .map(|value| value.to_string_lossy().into_owned())
                .collect()
        };
        let mut config = config();
        assert!(
            !arguments(&config)
                .iter()
                .any(|argument| argument == "--effort"),
            "no chosen effort leaves the CLI's own default alone"
        );
        config.reasoning_effort = Some("xhigh".into());
        assert!(arguments(&config)
            .windows(2)
            .any(|pair| pair == ["--effort", "xhigh"]));

        // Shapes taken from the installed CLI's initialize response.
        let supported = json!({"value":"synthetic-model","supportsEffort":true,"supportedEffortLevels":["low","xhigh"]});
        assert!(require_supported_effort(&supported, Some("xhigh")).is_ok());
        assert!(require_supported_effort(&supported, None).is_ok());
        assert!(
            require_supported_effort(&supported, Some("ultra")).is_err(),
            "an effort this model never advertised must fail startup, not be passed on"
        );
        let effortless = json!({"value":"haiku"});
        assert!(require_supported_effort(&effortless, None).is_ok());
        assert!(require_supported_effort(&effortless, Some("high")).is_err());
    }

    #[test]
    fn provider_execution_disables_builtin_tools_hooks_and_project_settings() {
        let config = config();
        let command = restricted_command(&config, "Owner-approved instructions");
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();
        assert!(args.iter().any(|arg| arg == "--restricted"));
        assert!(args.windows(2).any(|pair| pair == ["--tools", ""]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--setting-sources", ""]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--settings", "{\"disableAllHooks\":true}"]));
        assert!(!args.iter().any(|arg| arg.contains("bypassPermissions")));
        assert_eq!(
            command.as_std().get_current_dir(),
            Some(config.workspace.as_path())
        );
        for (key, _) in command.as_std().get_envs() {
            assert!(!matches!(
                key.to_str(),
                Some(
                    "ANTHROPIC_API_KEY"
                        | "ANTHROPIC_AUTH_TOKEN"
                        | "OPENAI_API_KEY"
                        | "NODE_OPTIONS"
                )
            ));
        }
    }
}
