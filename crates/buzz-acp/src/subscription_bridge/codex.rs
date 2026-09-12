//! Official Codex app-server transport. Authentication stays in its native profile.
#[path = "codex_policy.rs"]
mod policy;

use super::{config::Config, io::Wire};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::sync::{mpsc, watch};

pub(crate) async fn check_capability(config: &Config) -> Result<()> {
    policy::require_no_environment_support(config).await
}

pub(crate) struct Codex {
    wire: Wire,
    config: Config,
    thread: String,
    next_id: u64,
    usable: bool,
}

impl Codex {
    pub(crate) async fn start(config: &Config, instructions: &str) -> Result<Self> {
        policy::require_no_environment_support(config).await?;
        let mut command = policy::command(config);
        command.args(["app-server", "--listen", "stdio://"]);
        let mut agent = Self {
            wire: Wire::spawn(command)?,
            config: config.clone(),
            thread: String::new(),
            next_id: 1,
            usable: true,
        };
        let result = async {
            agent
                .request(
                    "initialize",
                    json!({"clientInfo":{"name":"colony_subscription",
                "title":"Colony", "version":env!("CARGO_PKG_VERSION")},
                "capabilities":{"experimentalApi":true}}),
                )
                .await?;
            agent.wire.send(json!({"method":"initialized"})).await?;
            let account = agent
                .request("account/read", json!({"refreshToken":true}))
                .await?;
            if !matches!(
                account["account"]["type"].as_str(),
                Some("chatgpt" | "chatgptAuthTokens")
            ) {
                bail!("Connect a ChatGPT subscription in Colony Power setup");
            }
            agent.require_model().await?;
            let response = agent
                .request(
                    "thread/start",
                    policy::thread_parameters(config, instructions)?,
                )
                .await?;
            agent.thread = policy::validate_thread(config, &response)?;
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if let Err(error) = result {
            agent.shutdown().await;
            return Err(error);
        }
        Ok(agent)
    }

    async fn require_model(&mut self) -> Result<()> {
        let mut cursor = Value::Null;
        for _ in 0..10 {
            let result = self
                .request(
                    "model/list",
                    json!({"limit":100,"includeHidden":false,"cursor":cursor}),
                )
                .await?;
            if let Some(entry) = result["data"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|model| {
                    model.get("model").or_else(|| model.get("id"))
                        == Some(&json!(self.config.model))
                        && model["hidden"] != true
                })
            {
                return require_supported_effort(entry, self.config.reasoning_effort.as_deref());
            }
            cursor = result.get("nextCursor").cloned().unwrap_or(Value::Null);
            if cursor.is_null() {
                break;
            }
        }
        bail!("The selected model is unavailable on this Codex subscription. Choose another in Power setup")
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.wire
            .send(json!({"id":id,"method":method,"params":params}))
            .await?;
        tokio::time::timeout(Duration::from_secs(90), async {
            loop {
                let message = self.wire.read().await?;
                if message.get("method").is_some() && message.get("id").is_some() {
                    self.decline_request(&message).await?;
                } else if message["id"] == id {
                    if message.get("error").is_some() { bail!("Codex could not complete the subscription request. Reconnect or choose another model in Power setup"); }
                    return message.get("result").cloned().context("Incomplete Codex response");
                }
            }
        }).await.context("Codex subscription request timed out")?
    }

    // Never grant filesystem, execution, network or interactive escalation. These
    // operations belong to the native-wrapped MCP tools, not the vendor process.
    async fn decline_request(&mut self, message: &Value) -> Result<()> {
        self.wire
            .send(json!({"id":message["id"],"error":{"code":-32601,
            "message":"This operation is unavailable in an isolated Colony subscription session"}}))
            .await
    }

    pub(crate) async fn prompt(
        &mut self,
        content: Vec<Value>,
        updates: mpsc::Sender<Value>,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<&'static str> {
        if !self.usable {
            bail!("Restart this teammate to reconnect its subscription");
        }
        if *cancel.borrow() {
            return Ok("cancelled");
        }
        let parameters = policy::turn_parameters(&self.config, &self.thread, content)?;
        let result = self.run_turn(parameters, &updates, &mut cancel).await;
        // An interrupted/failed transport must not accept another prompt while
        // the vendor still has work in flight.
        if result.is_err() || matches!(&result, Ok(reason) if *reason == "cancelled") {
            self.shutdown().await;
        }
        result
    }

    async fn run_turn(
        &mut self,
        parameters: Value,
        updates: &mpsc::Sender<Value>,
        cancel: &mut watch::Receiver<bool>,
    ) -> Result<&'static str> {
        let id = self.next_id;
        self.next_id += 1;
        self.wire
            .send(json!({"id":id,"method":"turn/start","params":parameters}))
            .await?;
        let mut turn = None::<String>;
        let end = tokio::time::Instant::now() + Duration::from_secs(30 * 60);
        let deadline = tokio::time::sleep_until(end);
        tokio::pin!(deadline);
        loop {
            let message = tokio::select! {
                biased;
                changed = cancel.changed() => {
                    if changed.is_err() || *cancel.borrow() {
                        // Closing the coordinator also prevents queued work from
                        // surviving a revoked launch. Native owns group cleanup.
                        return Ok("cancelled");
                    }
                    continue;
                }
                _ = &mut deadline => bail!("Codex work timed out. Restart the teammate to retry"),
                message = self.wire.read() => message?,
            };
            if message.get("method").is_some() && message.get("id").is_some() {
                self.decline_request(&message).await?;
                continue;
            }
            if message["id"] == id {
                if message.get("error").is_some() {
                    bail!(
                        "Codex could not start this work. Check your subscription in Power setup"
                    );
                }
                let returned = message
                    .pointer("/result/turn/id")
                    .and_then(Value::as_str)
                    .context("Codex did not identify this turn")?;
                if turn.as_deref().is_some_and(|active| active != returned) {
                    bail!("Codex turn identity changed");
                }
                turn = Some(returned.to_owned());
                continue;
            }
            let params = &message["params"];
            if params["threadId"] != self.thread {
                continue;
            }
            match message["method"].as_str() {
                Some("turn/started") => {
                    let started = params["turn"]["id"]
                        .as_str()
                        .context("Codex did not identify this turn")?;
                    if turn.as_deref().is_some_and(|active| active != started) {
                        bail!("Unexpected concurrent Codex turn");
                    }
                    turn = Some(started.to_owned());
                }
                Some("item/agentMessage/delta") if matches_turn(params, turn.as_deref()) => {
                    if let Some(text) = params["delta"].as_str() {
                        if !deliver(updates, cancel, end, json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}})).await? { return Ok("cancelled"); }
                    }
                }
                Some("thread/tokenUsage/updated") if matches_turn(params, turn.as_deref()) => {
                    if let Some(update) = usage_update(params, &self.config.model) {
                        if !deliver(updates, cancel, end, update).await? {
                            return Ok("cancelled");
                        }
                    }
                }
                Some("turn/completed")
                    if params["turn"]["id"].as_str() == turn.as_deref() && turn.is_some() =>
                {
                    return match params["turn"]["status"].as_str() {
                        Some("completed") => Ok("end_turn"),
                        Some("interrupted") => Ok("cancelled"),
                        _ => Err(anyhow::anyhow!("Codex could not finish this work. Check subscription availability in Power setup")),
                    };
                }
                _ => {}
            }
        }
    }

    pub(crate) async fn shutdown(&mut self) {
        self.usable = false;
        self.wire.close().await;
    }
}

async fn deliver(
    updates: &mpsc::Sender<Value>,
    cancel: &mut watch::Receiver<bool>,
    deadline: tokio::time::Instant,
    update: Value,
) -> Result<bool> {
    if *cancel.borrow() {
        return Ok(false);
    }
    tokio::select! {
        biased;
        _ = cancel.changed() => Ok(false),
        result = tokio::time::timeout_at(deadline, updates.send(update)) => {
            result.context("Colony stopped reading this work session")?.context("Colony closed this work session")?;
            Ok(true)
        }
    }
}

/// Accept the chosen effort only when this model's own catalog entry advertises
/// it, so a stale or mismatched choice fails startup instead of quietly running
/// at an effort the owner never picked.
///
/// The entry's `supportedReasoningEfforts` is a list of
/// `{reasoningEffort, description}`, and a model may advertise none at all, in
/// which case no effort can be honoured and naming one is an error rather than
/// something to pass through and hope for.
fn require_supported_effort(entry: &Value, effort: Option<&str>) -> Result<()> {
    let Some(effort) = effort else {
        return Ok(());
    };
    let advertised = entry["supportedReasoningEfforts"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|option| option["reasoningEffort"].as_str() == Some(effort));
    if !advertised {
        bail!("This model does not offer that reasoning effort on your Codex subscription. Choose one in Power setup");
    }
    Ok(())
}

fn matches_turn(params: &Value, turn: Option<&str>) -> bool {
    turn.is_some() && params["turnId"].as_str() == turn
}

fn usage_update(params: &Value, model: &str) -> Option<Value> {
    let total = &params["tokenUsage"]["total"];
    let mut update = json!({"sessionUpdate":"usage_update","model":model,
        "accumulatedInputTokens":total["inputTokens"].as_u64()?,
        "accumulatedOutputTokens":total["outputTokens"].as_u64()?});
    if let Some(cached) = total["cachedInputTokens"].as_u64() {
        update["accumulatedCachedInputTokens"] = json!(cached);
    }
    // Subscription allowance is not API spend: monetary usage stays unknown.
    Some(update)
}

#[cfg(test)]
#[path = "codex_tests.rs"]
mod tests;
