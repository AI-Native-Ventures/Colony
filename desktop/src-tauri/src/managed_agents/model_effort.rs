//! The model catalog entry a harness advertises, and the model/effort split.
//!
//! Lives apart from `types.rs` because the split carries enough reasoning to
//! document, and `types.rs` is already at its size ceiling.

use serde::Serialize;

/// A single model available from an agent.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelInfo {
    /// Canonical ID used for persistence and round-tripping.
    ///
    /// Round-tripped verbatim, including any `[effort]` suffix, because that is
    /// the string the harness expects back. [`Self::base_id`] and
    /// [`Self::effort`] are the parsed view for the UI, never the wire value.
    pub id: String,
    /// `id` with any `[effort]` suffix removed. Equal to `id` when there is none.
    ///
    /// Adapters advertise one entry per model-and-effort pair
    /// (`gpt-5.6-sol[low]`, `gpt-5.6-sol[max]`, ...), so a flat list mixes the
    /// two axes and grows with their product. Splitting them here lets the UI
    /// offer a model, then only the efforts THAT model actually advertises,
    /// without hardcoding a catalog that would drift as models change.
    pub base_id: String,
    /// The reasoning effort this entry pins, when the ID carried one.
    ///
    /// `None` means the entry names a model without pinning effort, so the
    /// harness's own config decides. That is a real, selectable choice, not a
    /// missing value: Codex falls back to `model_reasoning_effort` in
    /// `~/.codex/config.toml`.
    pub effort: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
}

impl AgentModelInfo {
    /// Build an entry, deriving [`Self::base_id`] and [`Self::effort`] from `id`.
    ///
    /// The only constructor, so no producer can publish an entry whose parsed
    /// view disagrees with its wire ID.
    pub fn new(id: String, name: Option<String>, description: Option<String>) -> Self {
        let (base_id, effort) = split_model_effort(&id);
        Self {
            id,
            base_id,
            effort,
            name,
            description,
        }
    }
}

/// Split an advertised model ID into its base model and reasoning effort.
///
/// The ACP convention is a bracketed suffix: `gpt-5.6-sol[xhigh]`. Anything
/// else is a base model with no effort pinned. The suffix must be non-empty and
/// terminal, so a bare `[` or a bracket mid-string is left alone rather than
/// silently truncating a model name we do not recognise.
pub fn split_model_effort(id: &str) -> (String, Option<String>) {
    match id.strip_suffix(']').and_then(|rest| rest.rsplit_once('[')) {
        Some((base, effort)) if !base.is_empty() && !effort.is_empty() => {
            (base.to_string(), Some(effort.to_string()))
        }
        _ => (id.to_string(), None),
    }
}
