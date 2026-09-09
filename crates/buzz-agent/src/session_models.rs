//! Session-local model and reasoning choices; process configuration stays immutable.

use crate::catalog::ModelEntry;
use crate::config::{
    parse_thinking_effort, supported_reasoning_efforts, Config, Provider, ThinkingEffort,
};

/// Model IDs accepted for one reply, with only reasoning values this runtime knows how to apply.
/// Native discovery and ACP session discovery share this catalog rather than guessing in the UI.
pub fn supported_reply_model_ids(provider: Provider, model: &str) -> Vec<String> {
    if !is_reply_model_id(model) {
        return Vec::new();
    }
    std::iter::once(model.to_owned())
        .chain(
            supported_reasoning_efforts(provider, model)
                .iter()
                .map(|effort| format!("{model}[{}]", effort.openai_effort_str())),
        )
        .collect()
}

/// Keep model controls limited to reply engines; preserve custom names unless
/// they identify a known non-text modality. Native discovery uses the same filter.
pub fn is_reply_model_id(model: &str) -> bool {
    let lower = model.to_ascii_lowercase();
    !model.is_empty()
        && model.len() <= 256
        && model.bytes().all(|byte| byte.is_ascii_graphic())
        && !model.contains(['[', ']'])
        && ![
            "audio",
            "dall-e",
            "embedding",
            "image",
            "moderation",
            "realtime",
            "speech",
            "transcribe",
            "tts",
            "whisper",
        ]
        .iter()
        .any(|term| lower.contains(term))
}

#[derive(Clone)]
pub(crate) struct Selection {
    model_id: String,
    effort: Option<ThinkingEffort>,
}

pub(crate) fn catalog(cfg: &Config, models: &[ModelEntry]) -> Vec<ModelEntry> {
    models
        .iter()
        .flat_map(|model| {
            supported_reply_model_ids(cfg.provider, &model.id)
                .into_iter()
                .map(move |id| {
                    let name = id
                        .strip_prefix(&model.id)
                        .filter(|suffix| !suffix.is_empty())
                        .map(|suffix| format!("{} {suffix}", model.name))
                        .unwrap_or_else(|| model.name.clone());
                    ModelEntry { id, name }
                })
        })
        .collect()
}

pub(crate) fn select(id: &str, advertised: &[String]) -> Result<Selection, &'static str> {
    // Bare IDs retain the pre-existing custom endpoint RPC contract. Reply-scoped
    // callers additionally validate them against the fresh catalog in buzz-acp.
    if id.contains(['[', ']']) && !advertised.iter().any(|candidate| candidate == id) {
        return Err("model and reasoning choice was not advertised by this session");
    }
    let (model_id, effort) = match id.strip_suffix(']').and_then(|s| s.rsplit_once('[')) {
        Some((base, raw)) => {
            let effort = parse_thinking_effort(Some(raw))
                .map_err(|_| "invalid reasoning value")?
                .ok_or("empty reasoning value")?;
            if base.is_empty() || base.contains(['[', ']']) || raw != effort.openai_effort_str() {
                return Err("invalid canonical model and reasoning choice");
            }
            (base.to_owned(), Some(effort))
        }
        None if id.contains(['[', ']']) || id.trim().is_empty() => return Err("invalid model id"),
        None => (id.to_owned(), None),
    };
    Ok(Selection { model_id, effort })
}

pub(crate) fn prompt_config(defaults: &Config, selection: Option<&Selection>) -> Config {
    let mut cfg = defaults.clone();
    if let Some(selection) = selection {
        cfg.model.clone_from(&selection.model_id);
        cfg.enforce_session_model = true;
        if let Some(effort) = selection.effort {
            cfg.thinking_effort = Some(effort);
        }
    }
    cfg
}

pub(crate) fn enforce_model_request(cfg: &Config, body: &mut serde_json::Value) {
    if cfg.enforce_session_model {
        if let Some(body) = body.as_object_mut() {
            body.remove("models");
            body.insert("model".into(), serde_json::json!(cfg.model));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Provider;

    fn defaults() -> Config {
        let mut cfg =
            Config::for_discovery(Provider::OpenAi, "test".into(), "http://localhost".into());
        cfg.model = "gpt-5.5".into();
        cfg.thinking_effort = Some(ThinkingEffort::Low);
        cfg
    }

    #[test]
    fn catalog_only_exposes_known_pairs() {
        let cfg = defaults();
        let entries = catalog(&cfg, &super::super::configured_model_fallback(&cfg.model));
        let ids: Vec<_> = entries.iter().map(|entry| entry.id.as_str()).collect();
        assert!(ids.contains(&"gpt-5.5[high]"));
        assert!(!ids.contains(&"gpt-5.5[max]"));
        assert_eq!(
            catalog(&cfg, &super::super::configured_model_fallback("unknown")).len(),
            1
        );
    }

    #[test]
    fn selection_changes_only_the_prompt_clone() {
        let cfg = defaults();
        let selection = select("gpt-5.5[high]", &["gpt-5.5[high]".into()]).unwrap();
        let prompt = prompt_config(&cfg, Some(&selection));
        assert_eq!(prompt.model, "gpt-5.5");
        assert_eq!(prompt.thinking_effort, Some(ThinkingEffort::High));
        assert!(prompt.enforce_session_model);
        assert!(!cfg.enforce_session_model);
        assert_eq!(cfg.thinking_effort, Some(ThinkingEffort::Low));
        assert_eq!(
            prompt_config(&cfg, None).thinking_effort,
            Some(ThinkingEffort::Low)
        );
        let bare = select("gpt-5.5", &["gpt-5.5".into()]).unwrap();
        assert_eq!(
            prompt_config(&cfg, Some(&bare)).thinking_effort,
            cfg.thinking_effort
        );
    }

    #[test]
    fn explicit_model_drops_the_gateway_fallback_chain() {
        let cfg = defaults();
        let mut body = serde_json::json!({"model": "other", "models": ["other", "fallback"]});
        enforce_model_request(&cfg, &mut body);
        assert!(body.get("models").is_some());
        let bare = select("gpt-5.5", &["gpt-5.5".into()]).unwrap();
        enforce_model_request(&prompt_config(&cfg, Some(&bare)), &mut body);
        assert!(body.get("models").is_none());
        assert_eq!(body["model"], "gpt-5.5");
        assert_eq!(
            supported_reply_model_ids(Provider::OpenRouter, "openai/gpt-5.5"),
            vec!["openai/gpt-5.5"]
        );
    }

    #[test]
    fn unadvertised_or_malformed_choices_reject() {
        assert!(select("gpt-5.5[max]", &["gpt-5.5[high]".into()]).is_err());
        assert!(select("gpt-5.5[HIGH]", &["gpt-5.5[HIGH]".into()]).is_err());
        assert!(select("gpt-5.5[]", &["gpt-5.5[]".into()]).is_err());
        assert!(select("gpt-5.5[high", &["gpt-5.5[high".into()]).is_err());
        assert!(select("custom-endpoint", &[]).is_ok());
    }
}
