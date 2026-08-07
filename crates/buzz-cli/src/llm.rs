//! Call an LLM provider with a single instruction.
//!
//! The worker's job is to turn a human's instruction into a result it can
//! post. This module is the part that talks to the provider: one function,
//! one instruction, one response. No streaming, no tool use, no conversation
//! history. Those live in the ACP harness; the worker is just a loop with
//! a keyboard.
//!
//! Four providers are supported by name. The caller picks the name; this
//! module maps it to an endpoint and a format.
//!
//! - `openrouter` — OpenAI-compatible at `openrouter.ai/api/v1/chat/completions`
//! - `deepseek` — OpenAI-compatible at `api.deepseek.com/v1/chat/completions`
//! - `openai` — OpenAI-compatible at `api.openai.com/v1/chat/completions`
//! - `anthropic` — Native Messages API at `api.anthropic.com/v1/messages`
//!
//! Neither the provider nor the model is hardcoded: both come from the seat
//! binding.

use crate::seat::Binding;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// What the LLM said, and enough detail to stamp the result.
#[derive(Debug, Clone)]
pub struct LlmResponse {
    /// The model's text response.
    pub text: String,
    /// The provider's request id, when it returned one.
    ///
    /// This is the ledger's dedupe key together with the provider, so a
    /// retried HTTP call cannot be counted twice.
    pub request_id: Option<String>,
    /// HTTP status the provider returned on this call.
    pub http_status: u16,
    /// Provider that served the call, as-stated in the binding.
    pub provider: String,
    /// Model that served the call, as-stated in the binding.
    pub model: String,
    /// Tokens consumed on the request (prompt tokens).
    pub input_tokens: u32,
    /// Tokens produced in the response (completion tokens).
    pub output_tokens: u32,
}

#[derive(Debug)]
pub enum LlmError {
    /// The API key env var is not set or empty.
    NoKey(String),
    /// The provider returned an error (eg. 429 rate limit).
    ProviderError { status: u16, body: String },
    /// The provider's response was not the documented shape.
    BadResponse(String),
    /// A network or timeout error.
    Http(String),
    /// The call took longer than allowed.
    Timeout,
}

impl std::fmt::Display for LlmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoKey(var) => write!(f, "{var} is not set"),
            Self::ProviderError { status, body } => {
                write!(f, "provider returned {status}: {body}")
            }
            Self::BadResponse(msg) => write!(f, "unexpected response shape: {msg}"),
            Self::Http(msg) => write!(f, "network error: {msg}"),
            Self::Timeout => write!(f, "the call timed out"),
        }
    }
}

/// The OpenAI-compatible chat completion request body.
#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: [ChatMessage<'a>; 1],
    max_tokens: u32,
}

#[derive(Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: &'a str,
}

/// The subset of the response the worker cares about.
#[derive(Deserialize)]
struct ChatResponse {
    id: Option<String>,
    choices: Vec<ChatChoice>,
    usage: Option<ChatUsage>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatChoiceMessage,
}

#[derive(Deserialize)]
struct ChatChoiceMessage {
    content: String,
}

#[derive(Deserialize)]
struct ChatUsage {
    prompt_tokens: u32,
    completion_tokens: u32,
}

/// The Anthropic Messages request body.
#[derive(Serialize)]
struct AnthropicRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    messages: [AnthropicMessage<'a>; 1],
}

#[derive(Serialize)]
struct AnthropicMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct AnthropicResponse {
    content: Vec<AnthropicContentBlock>,
    usage: AnthropicUsage,
}

#[derive(Deserialize)]
struct AnthropicContentBlock {
    text: String,
}

#[derive(Deserialize)]
struct AnthropicUsage {
    input_tokens: u32,
    output_tokens: u32,
}

const MAX_TOKENS: u32 = 4096;

/// Send one instruction to one provider and get the text back.
pub async fn call_llm(
    instruction: &str,
    binding: &Binding,
    timeout: std::time::Duration,
) -> Result<LlmResponse, LlmError> {
    let key = std::env::var(binding.key_var())
        .map(|v| v.trim().to_string())
        .ok()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| LlmError::NoKey(binding.key_var()))?;

    match binding.provider.as_str() {
        "anthropic" => call_anthropic(instruction, binding, &key, timeout).await,
        "openrouter" | "deepseek" | "openai" => {
            call_openai_compatible(instruction, binding, &key, timeout).await
        }
        other => Err(LlmError::BadResponse(format!("unknown provider: {other}"))),
    }
}

async fn call_openai_compatible(
    instruction: &str,
    binding: &Binding,
    key: &str,
    timeout: Duration,
) -> Result<LlmResponse, LlmError> {
    let endpoint = endpoint_for(&binding.provider);
    let body = ChatRequest {
        model: &binding.model,
        messages: [ChatMessage {
            role: "user",
            content: instruction,
        }],
        max_tokens: MAX_TOKENS,
    };

    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| LlmError::Http(e.to_string()))?;

    let resp = client
        .post(&endpoint)
        .header("Authorization", format!("Bearer {key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                LlmError::Timeout
            } else {
                LlmError::Http(e.to_string())
            }
        })?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(LlmError::ProviderError {
            status: status.as_u16(),
            body,
        });
    }

    let chat: ChatResponse = resp
        .json()
        .await
        .map_err(|e| LlmError::BadResponse(e.to_string()))?;
    let request_id = chat.id.clone();

    let text = chat
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .ok_or_else(|| LlmError::BadResponse("no choices in response".to_string()))?;

    let input_tokens = chat.usage.as_ref().map(|u| u.prompt_tokens).unwrap_or(0);
    let output_tokens = chat
        .usage
        .as_ref()
        .map(|u| u.completion_tokens)
        .unwrap_or(0);

    Ok(LlmResponse {
        text,
        request_id,
        http_status: status.as_u16(),
        provider: binding.provider.clone(),
        model: binding.model.clone(),
        input_tokens,
        output_tokens,
    })
}

fn endpoint_for(provider: &str) -> String {
    match provider {
        "openrouter" => "https://openrouter.ai/api/v1/chat/completions".to_string(),
        "deepseek" => "https://api.deepseek.com/v1/chat/completions".to_string(),
        "openai" => "https://api.openai.com/v1/chat/completions".to_string(),
        _ => unreachable!(),
    }
}

async fn call_anthropic(
    instruction: &str,
    binding: &Binding,
    key: &str,
    timeout: Duration,
) -> Result<LlmResponse, LlmError> {
    let body = AnthropicRequest {
        model: &binding.model,
        max_tokens: MAX_TOKENS,
        messages: [AnthropicMessage {
            role: "user",
            content: instruction,
        }],
    };

    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| LlmError::Http(e.to_string()))?;

    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                LlmError::Timeout
            } else {
                LlmError::Http(e.to_string())
            }
        })?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(LlmError::ProviderError {
            status: status.as_u16(),
            body,
        });
    }

    let request_id = resp
        .headers()
        .get("request-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let msg: AnthropicResponse = resp
        .json()
        .await
        .map_err(|e| LlmError::BadResponse(e.to_string()))?;

    let text = msg
        .content
        .first()
        .map(|block| block.text.clone())
        .ok_or_else(|| LlmError::BadResponse("no content in response".to_string()))?;

    Ok(LlmResponse {
        text,
        request_id,
        http_status: status.as_u16(),
        provider: binding.provider.clone(),
        model: binding.model.clone(),
        input_tokens: msg.usage.input_tokens,
        output_tokens: msg.usage.output_tokens,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_for_maps_each_known_provider() {
        // If any match arm is wrong the function won't even compile, but
        // asserting the result pins the URLs so nobody changes them by
        // accident, because an endpoint change would make every existing
        // seat config silently reach a different host.
        assert_eq!(
            endpoint_for("openrouter"),
            "https://openrouter.ai/api/v1/chat/completions"
        );
        assert_eq!(
            endpoint_for("deepseek"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            endpoint_for("openai"),
            "https://api.openai.com/v1/chat/completions"
        );
    }

    #[test]
    fn missing_key_is_reported_by_the_variable_name_not_an_http_error() {
        // The worker reads this to decide between "I need to tell the user
        // to set a key" and "the provider is down." Without this it would
        // report a network error for a missing credential, which is the
        // wrong diagnosis.
        let rt = tokio::runtime::Runtime::new().unwrap();
        // Temporarily unset the key so the error fires.
        let prev = std::env::var("NONEXISTENT_KEY_DO_NOT_SET").ok();
        std::env::remove_var("NONEXISTENT_KEY_DO_NOT_SET");

        let binding = Binding {
            provider: "openrouter".into(),
            model: "test".into(),
            key_var: Some("NONEXISTENT_KEY_DO_NOT_SET".into()),
        };
        let result = rt.block_on(call_llm("hi", &binding, Duration::from_secs(1)));

        match result {
            Err(LlmError::NoKey(var)) => {
                assert_eq!(var, "NONEXISTENT_KEY_DO_NOT_SET");
            }
            other => panic!("expected NoKey, got {other:?}"),
        }

        if let Some(val) = prev {
            std::env::set_var("NONEXISTENT_KEY_DO_NOT_SET", val);
        }
    }
}
