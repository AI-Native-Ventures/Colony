//! ACP boundary for native-owned vendor subscriptions and isolated work tools.
mod capability;
mod claude;
mod codex;
mod config;
mod io;

use anyhow::{bail, Context, Result};
use config::Config;
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio::{
    io::{AsyncWriteExt, BufReader},
    sync::{mpsc, watch},
};

enum Vendor {
    Claude(claude::Claude),
    Codex(codex::Codex),
}

/// Read compatibility metadata without accessing a connected account.
pub(crate) fn check_capability() -> Result<()> {
    capability::run()
}

impl Vendor {
    async fn start(config: &Config, system_prompt: &str) -> Result<Self> {
        match config.runtime.as_str() {
            "claude" => Ok(Self::Claude(
                claude::Claude::start(config, system_prompt).await?,
            )),
            "codex" => Ok(Self::Codex(
                codex::Codex::start(config, system_prompt).await?,
            )),
            _ => bail!("Unsupported subscription provider"),
        }
    }

    async fn prompt(
        &mut self,
        content: Vec<Value>,
        updates: mpsc::Sender<Value>,
        cancel: watch::Receiver<bool>,
    ) -> Result<&'static str> {
        match self {
            Self::Claude(agent) => agent.prompt(content, updates, cancel).await,
            Self::Codex(agent) => agent.prompt(content, updates, cancel).await,
        }
    }

    async fn shutdown(&mut self) {
        match self {
            Self::Claude(agent) => agent.shutdown().await,
            Self::Codex(agent) => agent.shutdown().await,
        }
    }
}

/// Serve the native subscription boundary in its own owned process group.
pub(crate) fn run() -> Result<()> {
    #[cfg(unix)]
    {
        if nix::unistd::getpgrp() != nix::unistd::getpid() {
            bail!("Subscription bridge requires its own native process group");
        }
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()?;
        let result = runtime.block_on(serve());
        // ACP owns this group. Vendor and MCP descendants deliberately remain
        // in it, so normal cancellation and abrupt parent teardown cover both.
        let _ = nix::sys::signal::killpg(nix::unistd::getpgrp(), nix::sys::signal::Signal::SIGKILL);
        // If signaling returns, never wait for Tokio's non-cancellable stdin
        // reader on runtime drop. The native ACP owner also retires this group.
        runtime.shutdown_background();
        result
    }
    #[cfg(not(unix))]
    bail!("Subscription process isolation is unavailable on this platform")
}

async fn serve() -> Result<()> {
    let config = Config::from_environment()?;
    let (input_tx, mut input) = mpsc::channel(16);
    let reader = tokio::spawn(async move {
        let mut stdin = BufReader::new(tokio::io::stdin());
        while let Ok(message) = io::read_frame(&mut stdin).await {
            if input_tx.send(message).await.is_err() {
                break;
            }
        }
    });
    let mut sessions = HashMap::<String, Vendor>::new();
    let outcome = async {
        while let Some(request) = input.recv().await {
            let id = request.get("id").cloned();
            let params = &request["params"];
            let result = match request["method"].as_str().unwrap_or("") {
                "initialize" => Ok(json!({"protocolVersion":2,"agentInfo":{"name":"colony-subscription","version":env!("CARGO_PKG_VERSION")},"agentCapabilities":{"loadSession":false},"authMethods":[]})),
                "session/new" => {
                    if sessions.len() >= 8 { Err(anyhow::anyhow!("Too many subscription sessions")) }
                    else {
                        let prompt = system_prompt(params);
                        match await_start(Vendor::start(&config, &prompt), &mut input).await {
                            Ok(agent) => {
                                let session = uuid::Uuid::new_v4().to_string();
                                sessions.insert(session.clone(), agent);
                                Ok(json!({"sessionId":session,"models":{"currentModelId":config.model,"availableModels":[{"modelId":config.model,"name":config.model}]},"configOptions":model_options(&config)}))
                            }
                            Err(error) => Err(error),
                        }
                    }
                }
                "session/set_model" | "session/set_config_option" => {
                    let requested = params.get("modelId").or_else(|| params.get("value")).and_then(Value::as_str);
                    if params.get("configId").is_some_and(|id| id != "model") || requested != Some(config.model.as_str()) {
                        Err(anyhow::anyhow!("Choose a different model in Colony Power setup"))
                    } else { Ok(json!({"configOptions": model_options(&config)})) }
                }
                "session/prompt" => {
                    let session_id = params["sessionId"].as_str().unwrap_or("").to_owned();
                    let content = text_content(params)?;
                    match sessions.get_mut(&session_id) {
                        Some(agent) => run_prompt(agent, content, &session_id, &mut input).await.map(|reason| json!({"stopReason":reason})),
                        None => Err(anyhow::anyhow!("Start a subscription session before sending work")),
                    }
                }
                "session/cancel" | "notifications/initialized" => { continue; }
                _ => Err(anyhow::anyhow!("This operation is unavailable on the subscription work boundary")),
            };
            let retire = result.is_err() || result.as_ref().is_ok_and(|result| result["stopReason"] == "cancelled");
            if let Some(id) = id { respond(id, result).await?; }
            if retire { break; }
        }
        Ok::<_, anyhow::Error>(())
    }.await;
    for agent in sessions.values_mut() {
        agent.shutdown().await;
    }
    reader.abort();
    outcome
}

/// Native Stop closes ACP input even while a provider is still initializing.
/// Drop that in-flight startup so the caller can retire the owned process group.
async fn await_start<T>(
    start: impl std::future::Future<Output = Result<T>>,
    input: &mut mpsc::Receiver<Value>,
) -> Result<T> {
    tokio::pin!(start);
    loop {
        tokio::select! {
            biased;
            message = input.recv() => {
                let Some(message) = message else { bail!("Colony closed the subscription session during startup"); };
                if message["method"] == "session/cancel" { bail!("Colony cancelled subscription startup"); }
                if let Some(id) = message.get("id") {
                    respond(id.clone(), Err(anyhow::anyhow!("Wait for the subscription connection to finish starting"))).await?;
                }
            }
            result = &mut start => return result,
        }
    }
}

async fn run_prompt(
    agent: &mut Vendor,
    content: Vec<Value>,
    session: &str,
    input: &mut mpsc::Receiver<Value>,
) -> Result<&'static str> {
    let (cancel, cancellation) = watch::channel(false);
    let (updates, mut output) = mpsc::channel(32);
    let future = agent.prompt(content, updates, cancellation);
    tokio::pin!(future);
    let mut output_open = true;
    loop {
        tokio::select! {
            result = &mut future => {
                while let Ok(update) = output.try_recv() { emit_update(session, update).await?; }
                return result;
            }
            update = output.recv(), if output_open => {
                if let Some(update) = update { emit_update(session, update).await?; }
                else { output_open = false; }
            }
            message = input.recv() => {
                let Some(message) = message else {
                    let _ = cancel.send(true);
                    bail!("Colony closed the subscription session");
                };
                if message["method"] == "session/cancel" && message["params"]["sessionId"] == session {
                    let _ = cancel.send(true);
                } else if let Some(id) = message.get("id") {
                    respond(id.clone(), Err(anyhow::anyhow!("Wait for the current turn to finish"))).await?;
                }
            }
        }
    }
}

fn model_options(config: &Config) -> Value {
    json!([{"id":"model","name":"Model","category":"model","type":"select","currentValue":config.model,"options":[{"value":config.model,"name":config.model}]}])
}

fn system_prompt(params: &Value) -> String {
    params
        .get("systemPrompt")
        .and_then(Value::as_str)
        .or_else(|| {
            params
                .pointer("/_meta/systemPrompt/append")
                .and_then(Value::as_str)
        })
        .unwrap_or("")
        .to_owned()
}

fn text_content(params: &Value) -> Result<Vec<Value>> {
    let content = params["prompt"]
        .as_array()
        .context("The work message is missing")?;
    if content
        .iter()
        .any(|block| block["type"] != "text" || !block["text"].is_string())
    {
        bail!("This subscription connection currently accepts text work messages");
    }
    Ok(content.clone())
}

async fn emit_update(session: &str, update: Value) -> Result<()> {
    let method = if update["sessionUpdate"] == "usage_update" {
        "_goose/unstable/session/update"
    } else {
        "session/update"
    };
    write(json!({"jsonrpc":"2.0","method":method,"params":{"sessionId":session,"update":update}}))
        .await
}

async fn respond(id: Value, result: Result<Value>) -> Result<()> {
    write(match result {
        Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
        Err(error) => {
            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":error.to_string()}})
        }
    })
    .await
}

async fn write(message: Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(&message)?;
    bytes.push(b'\n');
    let mut stdout = tokio::io::stdout();
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        stdout.write_all(&bytes).await?;
        stdout.flush().await
    })
    .await
    .context("Colony response delivery timed out")??;
    Ok(())
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use std::{
        future::Future,
        pin::Pin,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        task::{Context, Poll},
    };

    struct PendingStartup(Arc<AtomicBool>);
    impl Future for PendingStartup {
        type Output = Result<()>;
        fn poll(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Self::Output> {
            Poll::Pending
        }
    }
    impl Drop for PendingStartup {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn closed_parent_drops_vendor_startup_without_waiting_for_provider_timeout() {
        let dropped = Arc::new(AtomicBool::new(false));
        let (sender, mut input) = mpsc::channel(1);
        drop(sender);
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            await_start(PendingStartup(dropped.clone()), &mut input),
        )
        .await
        .unwrap();
        assert!(result.unwrap_err().to_string().contains("closed"));
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn ready_vendor_remains_usable_with_an_open_parent_connection() {
        let (_sender, mut input) = mpsc::channel(1);
        assert_eq!(await_start(async { Ok(42) }, &mut input).await.unwrap(), 42);
    }
}
