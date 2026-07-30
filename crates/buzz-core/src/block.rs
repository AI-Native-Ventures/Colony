//! Safe, versioned contracts for chat-native Blocks.

use std::collections::{BTreeMap, HashSet};

use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use url::Url;
use uuid::Uuid;

/// JSON Schema dialect accepted for Block inputs and actions.
pub const JSON_SCHEMA_DRAFT_2020_12: &str = "https://json-schema.org/draft/2020-12/schema";
/// Maximum composition-tree depth, including the root.
pub const MAX_BLOCK_DEPTH: usize = 12;
/// Maximum number of nodes in one composition tree.
pub const MAX_BLOCK_NODES: usize = 200;
/// Native primitive handles shipped by the product.
pub const BLOCK_PRIMITIVE_HANDLES: &[&str] = &[
    "section",
    "metric",
    "details",
    "table",
    "card",
    "card-list",
    "chart",
    "media",
    "status",
    "actions",
    "question",
];
/// Starter composite handles shipped by the product.
pub const BLOCK_STARTER_COMPOSITE_HANDLES: &[&str] = &[
    "lead-card",
    "approval",
    "agent-proposal",
    "report",
    "artifact",
    "receipt",
    "brainstorm",
];
/// Canonical required-attention tag values.
pub const BLOCK_ATTENTION_REQUIRED_TAG: [&str; 3] = ["block-attention", "1", "required"];
/// Canonical resolved-attention tag values.
pub const BLOCK_ATTENTION_RESOLVED_TAG: [&str; 3] = ["block-attention", "1", "resolved"];

/// Errors produced by Block parsing and validation.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum BlockError {
    /// A handle did not match the stable handle grammar.
    #[error("invalid block handle: {0}")]
    InvalidHandle(String),
    /// JSON could not be parsed or serialized.
    #[error("invalid block JSON: {0}")]
    Json(String),
    /// A manifest violated the safe Block contract.
    #[error("invalid block manifest: {0}")]
    InvalidManifest(String),
    /// Instance data did not satisfy its JSON Schema.
    #[error("invalid block instance: {0}")]
    InvalidInstance(String),
}

/// Trust and ownership origin of a Block manifest.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BlockOrigin {
    /// Relay-bundled and relay-signed.
    Core,
    /// Supplied by an installed trusted publisher.
    Installed,
    /// Authored and approved inside the workspace.
    WorkspaceCustom,
}

/// Lifecycle state of a catalog head.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BlockCatalogStatus {
    /// The manifest is selected for implicit invocation.
    Active,
    /// The handle is preserved for history but unavailable for new invocation.
    Deprecated,
}

/// Spacing token available to structural layout nodes.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BlockGap {
    /// Compact spacing.
    Small,
    /// Default spacing.
    Medium,
    /// Generous spacing.
    Large,
}

/// A bounded interaction exposed by an action control.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum BlockInteraction {
    /// Open a named, local-only Core review surface without publishing an event.
    Presentation {
        /// The local surface to open.
        surface: CorePresentationSurface,
    },
    /// Publish a signed Block action.
    Signed {
        /// ID of the corresponding declaration in `manifest.actions`.
        action_id: String,
        /// Whether a successful or denied receipt may resolve attention.
        #[serde(default)]
        resolves_attention: bool,
    },
}

/// Local presentation surfaces available only to Core manifests.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CorePresentationSurface {
    /// Reuse the native agent creation or editing dialog.
    AgentReview,
}

/// A declared Block action.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BlockActionDeclaration {
    /// Stable action identifier.
    pub id: String,
    /// Human-readable action label.
    pub label: String,
    /// Schema for signed action input. Presentation interactions omit this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<Value>,
    /// Closed interaction behavior.
    pub interaction: BlockInteraction,
    /// Capability identifiers required to execute the interaction.
    #[serde(default)]
    pub permissions: Vec<String>,
}

/// A capability declaration with non-secret constraints.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BlockPermission {
    /// Stable capability identifier.
    pub capability: String,
    /// Public, non-secret capability constraints.
    #[serde(default)]
    pub constraints: Value,
}

/// Example instance used for previews and contract validation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BlockExample {
    /// Human-readable example name.
    pub name: String,
    /// Schema-valid example data.
    pub data: Value,
}

/// Manifest-wide validation policy.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BlockValidation {
    /// Explicit validation lifecycle state. Unmarked legacy manifests remain drafts.
    #[serde(default)]
    pub state: BlockValidationState,
    /// Whether instances using this manifest may request durable human attention.
    #[serde(default)]
    pub requires_attention: bool,
}

/// Closed validation lifecycle for immutable Block manifests.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BlockValidationState {
    /// The manifest may be authored and tested, but cannot become a catalog head.
    #[default]
    Draft,
    /// The manifest passed its declared contract tests and may become a catalog head.
    Tested,
}

/// One detail label/value pair.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DetailItem {
    /// Visible label.
    pub label: String,
    /// Literal or template-bound value.
    pub value: String,
}

/// One typed table column.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TableColumn {
    /// Data key.
    pub key: String,
    /// Visible column label.
    pub label: String,
}

/// One selectable Question option.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct QuestionOption {
    /// Stable option identifier.
    pub id: String,
    /// Visible option label.
    pub label: String,
}

/// Question selection mode.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum QuestionMode {
    /// Exactly one bounded choice.
    SingleSelect,
    /// Zero or more bounded choices.
    MultiSelect,
}

/// Chart presentation family.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ChartKind {
    /// Bar chart.
    Bar,
    /// Line chart.
    Line,
    /// Area chart.
    Area,
    /// Donut chart.
    Donut,
}

/// One action control rendered by an Actions node.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BlockActionControl {
    /// Visible control label.
    pub label: String,
    /// Closed interaction behavior.
    pub interaction: BlockInteraction,
}

/// Section primitive configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SectionNode {
    /// Optional heading or template.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Optional body or template.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// Metric primitive configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MetricNode {
    /// Visible metric label.
    pub label: String,
    /// Literal or template-bound value.
    pub value: String,
    /// Optional unit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
}

/// Details primitive configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DetailsNode {
    /// Ordered label/value items.
    pub items: Vec<DetailItem>,
}

/// Table primitive configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TableNode {
    /// Visible columns.
    pub columns: Vec<TableColumn>,
    /// Path to the instance array.
    pub rows_path: String,
}

/// Card primitive configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CardNode {
    /// Optional card title.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Optional card description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Ordered nested content.
    #[serde(default)]
    pub children: Vec<BlockNode>,
}

/// Card-list primitive configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CardListNode {
    /// Path to the instance collection.
    pub items_path: String,
    /// Card template rendered for each item.
    pub card: Box<BlockNode>,
}

/// Chart primitive configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ChartNode {
    /// Chart family.
    pub kind: ChartKind,
    /// Path to chart data.
    pub data_path: String,
    /// Label field in each datum.
    pub label_key: String,
    /// Numeric value field in each datum.
    pub value_key: String,
}

/// Media primitive configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MediaNode {
    /// Optional fixed media URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Optional path to a media URL in instance data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url_path: Option<String>,
    /// Accessible description.
    pub alt: String,
}

/// Status primitive configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct StatusNode {
    /// Visible status label.
    pub label: String,
    /// Optional path to state in instance data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_path: Option<String>,
}

/// Actions primitive configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ActionsNode {
    /// Ordered controls.
    pub controls: Vec<BlockActionControl>,
}

/// Question primitive configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct QuestionNode {
    /// Prompt shown to the user.
    pub prompt: String,
    /// Selection mode.
    pub mode: QuestionMode,
    /// Bounded choices.
    pub options: Vec<QuestionOption>,
    /// Minimum option selections.
    pub min_selections: u8,
    /// Maximum option selections.
    pub max_selections: u8,
    /// Whether custom text is accepted.
    pub allow_custom: bool,
    /// Whether custom text is mandatory.
    pub require_custom_input: bool,
    /// Signed action ID used for structured submission.
    pub submit_action: String,
}

/// Closed composition grammar for Blocks.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum BlockNode {
    /// Vertical layout.
    Stack {
        /// Spacing token.
        gap: BlockGap,
        /// Ordered children.
        children: Vec<BlockNode>,
    },
    /// Bounded column layout.
    Grid {
        /// Number of columns.
        columns: u8,
        /// Spacing token.
        gap: BlockGap,
        /// Ordered children.
        children: Vec<BlockNode>,
    },
    /// Rich section.
    Section(SectionNode),
    /// Metric.
    Metric(MetricNode),
    /// Label/value details.
    Details(DetailsNode),
    /// Typed table.
    Table(TableNode),
    /// Structured card.
    Card(CardNode),
    /// Repeated cards.
    CardList(CardListNode),
    /// Accessible chart.
    Chart(ChartNode),
    /// Media.
    Media(MediaNode),
    /// Status or progress.
    Status(StatusNode),
    /// Bounded controls.
    Actions(ActionsNode),
    /// Structured question.
    Question(QuestionNode),
}

/// Immutable, versioned Block definition.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BlockManifest {
    /// Manifest schema identifier.
    pub schema: String,
    /// Stable handle without the display `@`.
    pub handle: String,
    /// Semantic version.
    pub version: Version,
    /// Human-readable name.
    pub name: String,
    /// Human-readable description.
    pub description: String,
    /// Trust origin.
    pub origin: BlockOrigin,
    /// Fixed Unix timestamp used to produce deterministic Core event IDs.
    pub created_at: u64,
    /// Draft 2020-12 JSON Schema for instance data.
    pub input_schema: Value,
    /// Closed primitive composition tree.
    pub tree: BlockNode,
    /// Declared interactions.
    pub actions: Vec<BlockActionDeclaration>,
    /// Required public capabilities.
    pub permissions: Vec<BlockPermission>,
    /// Human-readable fallback template.
    pub fallback_template: String,
    /// Supported client identifiers.
    pub supported_clients: Vec<String>,
    /// Native primitive major versions keyed by handle.
    pub primitive_versions: BTreeMap<String, u32>,
    /// Preview and validation examples.
    pub examples: Vec<BlockExample>,
    /// Additional contract policy.
    pub validation: BlockValidation,
}

/// Relay-authored catalog projection for one stable handle.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BlockCatalogEntry {
    /// Catalog schema identifier.
    pub schema: String,
    /// Stable handle.
    pub handle: String,
    /// Active immutable manifest event ID.
    pub active_manifest_id: String,
    /// Current lifecycle state.
    pub status: BlockCatalogStatus,
    /// Short catalog summary.
    pub summary: String,
    /// Trust origin.
    pub origin: BlockOrigin,
    /// Safe preview data.
    pub preview: Value,
    /// Public permission declarations.
    pub permissions: Vec<BlockPermission>,
    /// Optional workshop conversation deep link or identifier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workshop: Option<String>,
}

/// Exact consequential proposal covered by an Approval hash.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ApprovalProposal {
    /// Stable action identifier.
    pub action: String,
    /// Exact destination.
    pub destination: String,
    /// Exact content to send or execute.
    pub content: Value,
    /// Unix expiry timestamp.
    pub expires_at: u64,
}

/// Agent Proposal operation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AgentProposalOperation {
    /// Create a new managed agent.
    Create,
    /// Update an existing managed agent.
    Update,
}

/// Non-secret execution target for an Agent Proposal.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum AgentRunTarget {
    /// Use the local runtime.
    Local,
    /// Use an already configured provider by safe identifier.
    Provider {
        /// Existing provider identifier; credentials remain outside the event.
        provider_id: String,
    },
}

/// Canonical, non-secret Agent Proposal instance data.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AgentProposalData {
    /// Create or update.
    pub operation: AgentProposalOperation,
    /// Stable proposal request ID.
    pub request_id: Uuid,
    /// Existing managed agent ID for updates.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<Uuid>,
    /// Proposed display name.
    pub name: String,
    /// Proposed role summary.
    pub role: String,
    /// Proposed instructions.
    pub instructions: String,
    /// Optional uploaded HTTP(S) avatar URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    /// Safe execution target.
    pub run_target: AgentRunTarget,
}

/// Normalize a user-facing handle to its stable wire form.
pub fn normalize_block_handle(raw: &str) -> Result<String, BlockError> {
    let trimmed = raw.trim();
    let without_at = trimmed.strip_prefix('@').unwrap_or(trimmed);
    let normalized = without_at.to_ascii_lowercase();
    let valid = !normalized.is_empty()
        && normalized.len() <= 64
        && normalized
            .bytes()
            .enumerate()
            .all(|(index, byte)| match byte {
                b'a'..=b'z' => true,
                b'0'..=b'9' | b'-' => index > 0,
                _ => false,
            });
    if valid {
        Ok(normalized)
    } else {
        Err(BlockError::InvalidHandle(raw.to_owned()))
    }
}

/// Serialize JSON with recursively sorted object keys and no insignificant whitespace.
pub fn canonical_json(value: &Value) -> Result<String, BlockError> {
    fn sort(value: &Value) -> Value {
        match value {
            Value::Array(values) => Value::Array(values.iter().map(sort).collect()),
            Value::Object(values) => {
                let sorted = values
                    .iter()
                    .map(|(key, value)| (key.clone(), sort(value)))
                    .collect::<BTreeMap<_, _>>();
                Value::Object(sorted.into_iter().collect())
            }
            scalar => scalar.clone(),
        }
    }

    serde_json::to_string(&sort(value)).map_err(|error| BlockError::Json(error.to_string()))
}

/// Parse and validate a canonical Block manifest.
pub fn parse_manifest(content: &str) -> Result<BlockManifest, BlockError> {
    let manifest: BlockManifest =
        serde_json::from_str(content).map_err(|error| BlockError::Json(error.to_string()))?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

/// Validate a Block manifest's bounded, non-executable contract.
pub fn validate_manifest(manifest: &BlockManifest) -> Result<(), BlockError> {
    let normalized = normalize_block_handle(&manifest.handle)?;
    if normalized != manifest.handle {
        return Err(BlockError::InvalidManifest(
            "manifest handle must already be normalized".to_owned(),
        ));
    }
    if manifest.schema.trim().is_empty()
        || manifest.name.trim().is_empty()
        || manifest.description.trim().is_empty()
        || manifest.fallback_template.trim().is_empty()
        || manifest.created_at == 0
    {
        return Err(BlockError::InvalidManifest(
            "required manifest metadata must not be empty".to_owned(),
        ));
    }
    validate_schema(&manifest.input_schema)?;

    let mut ids = HashSet::new();
    for action in &manifest.actions {
        if action.id.trim().is_empty() || !ids.insert(action.id.as_str()) {
            return Err(BlockError::InvalidManifest(
                "action IDs must be non-empty and unique".to_owned(),
            ));
        }
        match &action.interaction {
            BlockInteraction::Presentation { .. } => {
                if manifest.origin != BlockOrigin::Core {
                    return Err(BlockError::InvalidManifest(
                        "presentation surfaces are reserved for Core manifests".to_owned(),
                    ));
                }
            }
            BlockInteraction::Signed {
                action_id,
                resolves_attention,
            } => {
                if action_id != &action.id {
                    return Err(BlockError::InvalidManifest(
                        "signed interaction must reference its declaration ID".to_owned(),
                    ));
                }
                if *resolves_attention && action.input_schema.is_none() {
                    return Err(BlockError::InvalidManifest(
                        "resolving actions require an input schema".to_owned(),
                    ));
                }
                if let Some(schema) = &action.input_schema {
                    validate_schema(schema)?;
                }
            }
        }
    }
    if manifest.validation.requires_attention
        && !manifest.actions.iter().any(|action| {
            matches!(
                action.interaction,
                BlockInteraction::Signed {
                    resolves_attention: true,
                    ..
                }
            )
        })
    {
        return Err(BlockError::InvalidManifest(
            "attention requires at least one resolving signed action".to_owned(),
        ));
    }

    for (handle, major) in &manifest.primitive_versions {
        let handle = normalize_block_handle(handle)?;
        if !BLOCK_PRIMITIVE_HANDLES.contains(&handle.as_str()) || *major != 1 {
            return Err(BlockError::InvalidManifest(format!(
                "unsupported primitive version: {handle}@{major}"
            )));
        }
    }

    let mut count = 0;
    validate_node(&manifest.tree, 1, &mut count, manifest, &ids)?;
    for permission in &manifest.permissions {
        if permission.capability.trim().is_empty()
            || contains_secret_looking_key(&permission.constraints)
        {
            return Err(BlockError::InvalidManifest(
                "permission payloads must be named and non-secret".to_owned(),
            ));
        }
    }
    if manifest.handle == "approval" {
        validate_approval_schema(&manifest.input_schema)?;
    }
    if manifest.handle == "agent-proposal" {
        let secret_bearing_schema = contains_secret_looking_key(&manifest.input_schema)
            || manifest.actions.iter().any(|action| {
                action
                    .input_schema
                    .as_ref()
                    .is_some_and(contains_secret_looking_key)
            });
        if secret_bearing_schema {
            return Err(BlockError::InvalidManifest(
                "Agent Proposal schemas must not permit secret-bearing fields".to_owned(),
            ));
        }
    }
    for example in &manifest.examples {
        if example.name.trim().is_empty() {
            return Err(BlockError::InvalidManifest(
                "example names must not be empty".to_owned(),
            ));
        }
        validate_instance(&manifest.input_schema, &example.data).map_err(|error| {
            BlockError::InvalidManifest(format!("example {} is invalid: {error}", example.name))
        })?;
    }
    Ok(())
}

/// Whether a validated manifest may be selected as an active catalog head.
///
/// Examples are preview fixtures, not evidence of a completed test lifecycle.
/// Only an explicit `tested` validation state makes a manifest eligible.
pub fn is_manifest_activation_eligible(manifest: &BlockManifest) -> bool {
    manifest.validation.state == BlockValidationState::Tested
}

/// Validate instance data against a local Draft 2020-12 JSON Schema.
pub fn validate_instance(schema: &Value, data: &Value) -> Result<(), BlockError> {
    validate_schema(schema)?;
    let validator = jsonschema::draft202012::options()
        .should_validate_formats(true)
        .build(schema)
        .map_err(|error| BlockError::InvalidInstance(error.to_string()))?;
    validator
        .validate(data)
        .map_err(|error| BlockError::InvalidInstance(error.to_string()))
}

/// Compute the stable lowercase SHA-256 hash of an exact Approval proposal.
pub fn compute_approval_hash(proposal: &ApprovalProposal) -> Result<String, BlockError> {
    let value =
        serde_json::to_value(proposal).map_err(|error| BlockError::Json(error.to_string()))?;
    let canonical = canonical_json(&value)?;
    Ok(hex::encode(Sha256::digest(canonical.as_bytes())))
}

fn validate_schema(schema: &Value) -> Result<(), BlockError> {
    if schema.get("$schema").and_then(Value::as_str) != Some(JSON_SCHEMA_DRAFT_2020_12) {
        return Err(BlockError::InvalidManifest(
            "only JSON Schema Draft 2020-12 is accepted".to_owned(),
        ));
    }
    if contains_remote_ref(schema) {
        return Err(BlockError::InvalidManifest(
            "remote JSON Schema references are forbidden".to_owned(),
        ));
    }
    jsonschema::draft202012::meta::validate(schema)
        .map_err(|error| BlockError::InvalidManifest(format!("invalid JSON Schema: {error}")))
}

fn contains_remote_ref(value: &Value) -> bool {
    match value {
        Value::Object(values) => values.iter().any(|(key, value)| {
            (key == "$ref"
                && value
                    .as_str()
                    .is_some_and(|reference| !reference.starts_with('#')))
                || contains_remote_ref(value)
        }),
        Value::Array(values) => values.iter().any(contains_remote_ref),
        _ => false,
    }
}

fn contains_secret_looking_key(value: &Value) -> bool {
    const FORBIDDEN: &[&str] = &[
        "privatekey",
        "secretkey",
        "envvars",
        "environmentvariables",
        "providercredentials",
        "backendconfiguration",
        "backendconfig",
        "apikey",
        "accesstoken",
        "password",
        "credential",
    ];
    match value {
        Value::Object(values) => values.iter().any(|(key, value)| {
            let normalized = key
                .chars()
                .filter(|character| character.is_ascii_alphanumeric())
                .flat_map(char::to_lowercase)
                .collect::<String>();
            FORBIDDEN
                .iter()
                .any(|forbidden| normalized.contains(forbidden))
                || contains_secret_looking_key(value)
        }),
        Value::Array(values) => values.iter().any(contains_secret_looking_key),
        _ => false,
    }
}

fn validate_node(
    node: &BlockNode,
    depth: usize,
    count: &mut usize,
    manifest: &BlockManifest,
    action_ids: &HashSet<&str>,
) -> Result<(), BlockError> {
    if depth > MAX_BLOCK_DEPTH {
        return Err(BlockError::InvalidManifest(
            "composition exceeds 12 nesting levels".to_owned(),
        ));
    }
    *count += 1;
    if *count > MAX_BLOCK_NODES {
        return Err(BlockError::InvalidManifest(
            "composition exceeds 200 nodes".to_owned(),
        ));
    }
    match node {
        BlockNode::Stack { children, .. } => {
            for child in children {
                validate_node(child, depth + 1, count, manifest, action_ids)?;
            }
        }
        BlockNode::Grid {
            columns, children, ..
        } => {
            if !(1..=12).contains(columns) {
                return Err(BlockError::InvalidManifest(
                    "grid columns must be between 1 and 12".to_owned(),
                ));
            }
            for child in children {
                validate_node(child, depth + 1, count, manifest, action_ids)?;
            }
        }
        BlockNode::Card(card) => {
            for child in &card.children {
                validate_node(child, depth + 1, count, manifest, action_ids)?;
            }
        }
        BlockNode::CardList(list) => {
            validate_node(&list.card, depth + 1, count, manifest, action_ids)?;
        }
        BlockNode::Media(media) => {
            if media.url.is_none() == media.url_path.is_none() {
                return Err(BlockError::InvalidManifest(
                    "media requires exactly one of url or url_path".to_owned(),
                ));
            }
            if let Some(raw_url) = &media.url {
                let url = Url::parse(raw_url).map_err(|_| {
                    BlockError::InvalidManifest("media URL must be valid HTTP(S)".to_owned())
                })?;
                if !matches!(url.scheme(), "http" | "https") {
                    return Err(BlockError::InvalidManifest(
                        "media URL must use HTTP(S)".to_owned(),
                    ));
                }
            }
        }
        BlockNode::Actions(actions) => {
            for control in &actions.controls {
                match &control.interaction {
                    BlockInteraction::Presentation { .. } => {
                        if manifest.origin != BlockOrigin::Core {
                            return Err(BlockError::InvalidManifest(
                                "presentation surfaces are reserved for Core manifests".to_owned(),
                            ));
                        }
                    }
                    BlockInteraction::Signed { action_id, .. } => {
                        if !action_ids.contains(action_id.as_str()) {
                            return Err(BlockError::InvalidManifest(format!(
                                "unknown action control: {action_id}"
                            )));
                        }
                    }
                }
            }
        }
        BlockNode::Question(question) => {
            let option_count = u8::try_from(question.options.len()).unwrap_or(u8::MAX);
            if question.max_selections == 0
                || question.min_selections > question.max_selections
                || question.max_selections > option_count
                || (question.mode == QuestionMode::SingleSelect
                    && (question.min_selections > 1 || question.max_selections != 1))
                || (question.require_custom_input && !question.allow_custom)
                || !action_ids.contains(question.submit_action.as_str())
            {
                return Err(BlockError::InvalidManifest(
                    "Question selection bounds or submit action are invalid".to_owned(),
                ));
            }
        }
        BlockNode::Section(_)
        | BlockNode::Metric(_)
        | BlockNode::Details(_)
        | BlockNode::Table(_)
        | BlockNode::Chart(_)
        | BlockNode::Status(_) => {}
    }
    Ok(())
}

fn validate_approval_schema(schema: &Value) -> Result<(), BlockError> {
    let required = schema
        .get("required")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            BlockError::InvalidManifest(
                "Approval schema must require action, destination, content, and expiry".to_owned(),
            )
        })?;
    for field in ["action", "destination", "content", "expires_at"] {
        if !required.iter().any(|value| value.as_str() == Some(field))
            || schema
                .get("properties")
                .and_then(|value| value.get(field))
                .is_none()
        {
            return Err(BlockError::InvalidManifest(format!(
                "Approval schema must require exact {field}"
            )));
        }
    }
    if schema.get("additionalProperties") != Some(&Value::Bool(false)) {
        return Err(BlockError::InvalidManifest(
            "Approval schema must reject unspecified fields".to_owned(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use semver::Version;
    use serde_json::{json, Value};
    use uuid::Uuid;

    use super::{
        canonical_json, compute_approval_hash, is_manifest_activation_eligible, validate_instance,
        validate_manifest, AgentProposalData, ApprovalProposal, BlockActionDeclaration, BlockError,
        BlockExample, BlockGap, BlockInteraction, BlockManifest, BlockNode, BlockOrigin,
        BlockValidation, BlockValidationState, CorePresentationSurface, QuestionMode, QuestionNode,
        QuestionOption, SectionNode, BLOCK_PRIMITIVE_HANDLES, BLOCK_STARTER_COMPOSITE_HANDLES,
        JSON_SCHEMA_DRAFT_2020_12,
    };

    fn empty_object_schema() -> Value {
        json!({
            "$schema": JSON_SCHEMA_DRAFT_2020_12,
            "type": "object",
            "additionalProperties": false
        })
    }

    fn section_node() -> BlockNode {
        BlockNode::Section(SectionNode {
            title: Some("Summary".to_owned()),
            text: Some("{{summary}}".to_owned()),
        })
    }

    fn signed_action(
        id: &str,
        resolves_attention: bool,
        input_schema: Option<Value>,
    ) -> BlockActionDeclaration {
        BlockActionDeclaration {
            id: id.to_owned(),
            label: id.to_owned(),
            input_schema,
            interaction: BlockInteraction::Signed {
                action_id: id.to_owned(),
                resolves_attention,
            },
            permissions: Vec::new(),
        }
    }

    fn manifest(handle: &str) -> BlockManifest {
        BlockManifest {
            schema: "ai-native-office.block-manifest/1".to_owned(),
            handle: handle.to_owned(),
            version: Version::parse("1.0.0").expect("valid version"),
            name: "Test Block".to_owned(),
            description: "A bounded test Block.".to_owned(),
            origin: BlockOrigin::Core,
            created_at: 1,
            input_schema: empty_object_schema(),
            tree: section_node(),
            actions: Vec::new(),
            permissions: Vec::new(),
            fallback_template: "{{summary}}".to_owned(),
            supported_clients: vec!["desktop".to_owned()],
            primitive_versions: BTreeMap::from([("section".to_owned(), 1)]),
            examples: vec![BlockExample {
                name: "Empty".to_owned(),
                data: json!({}),
            }],
            validation: BlockValidation::default(),
        }
    }

    fn question_manifest(question: QuestionNode) -> BlockManifest {
        let mut manifest = manifest("question");
        manifest.actions.push(signed_action(
            "question.submit",
            false,
            Some(empty_object_schema()),
        ));
        manifest.primitive_versions.insert("question".to_owned(), 1);
        manifest.tree = BlockNode::Question(question);
        manifest
    }

    fn options(count: usize) -> Vec<QuestionOption> {
        (1..=count)
            .map(|index| QuestionOption {
                id: format!("option-{index}"),
                label: format!("Option {index}"),
            })
            .collect()
    }

    fn agent_proposal_schema() -> Value {
        json!({
            "$schema": JSON_SCHEMA_DRAFT_2020_12,
            "type": "object",
            "additionalProperties": false,
            "required": [
                "operation",
                "request_id",
                "name",
                "role",
                "instructions",
                "run_target"
            ],
            "properties": {
                "operation": {
                    "type": "string",
                    "enum": ["create", "update"]
                },
                "request_id": {
                    "type": "string",
                    "format": "uuid"
                },
                "agent_id": {
                    "type": "string",
                    "format": "uuid"
                },
                "name": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 80
                },
                "role": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 500
                },
                "instructions": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 20000
                },
                "avatar_url": {
                    "type": "string",
                    "format": "uri",
                    "pattern": "^https?://"
                },
                "run_target": {
                    "oneOf": [
                        {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["type"],
                            "properties": {
                                "type": { "const": "local" }
                            }
                        },
                        {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["type", "provider_id"],
                            "properties": {
                                "type": { "const": "provider" },
                                "provider_id": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 160
                                }
                            }
                        }
                    ]
                }
            },
            "allOf": [
                {
                    "if": {
                        "properties": {
                            "operation": { "const": "update" }
                        },
                        "required": ["operation"]
                    },
                    "then": { "required": ["agent_id"] }
                }
            ]
        })
    }

    #[test]
    fn canonical_json_recursively_orders_object_keys() {
        let first = json!({
            "z": [{"b": 2, "a": 1}],
            "a": {"d": 4, "c": 3}
        });
        let second = json!({
            "a": {"c": 3, "d": 4},
            "z": [{"a": 1, "b": 2}]
        });
        let golden = r#"{"a":{"c":3,"d":4},"z":[{"a":1,"b":2}]}"#;

        assert_eq!(canonical_json(&first).expect("canonical JSON"), golden);
        assert_eq!(canonical_json(&second).expect("canonical JSON"), golden);
    }

    #[test]
    fn handle_registry_pins_all_eighteen_core_blocks() {
        assert_eq!(
            BLOCK_PRIMITIVE_HANDLES,
            &[
                "section",
                "metric",
                "details",
                "table",
                "card",
                "card-list",
                "chart",
                "media",
                "status",
                "actions",
                "question",
            ]
        );
        assert_eq!(
            BLOCK_STARTER_COMPOSITE_HANDLES,
            &[
                "lead-card",
                "approval",
                "agent-proposal",
                "report",
                "artifact",
                "receipt",
                "brainstorm",
            ]
        );
        assert_eq!(
            BLOCK_PRIMITIVE_HANDLES.len() + BLOCK_STARTER_COMPOSITE_HANDLES.len(),
            18
        );
    }

    #[test]
    fn only_explicitly_tested_manifests_are_activation_eligible() {
        let draft = manifest("section");
        assert_eq!(draft.validation.state, BlockValidationState::Draft);
        assert!(!is_manifest_activation_eligible(&draft));

        let mut unmarked_value = serde_json::to_value(&draft).expect("serialize manifest");
        unmarked_value
            .pointer_mut("/validation")
            .and_then(Value::as_object_mut)
            .expect("validation object")
            .remove("state");
        let unmarked: BlockManifest =
            serde_json::from_value(unmarked_value).expect("legacy unmarked manifest");
        assert_eq!(unmarked.validation.state, BlockValidationState::Draft);
        assert!(!is_manifest_activation_eligible(&unmarked));

        let mut tested = draft;
        tested.validation.state = BlockValidationState::Tested;
        assert!(is_manifest_activation_eligible(&tested));
    }

    #[test]
    fn validation_state_rejects_values_outside_the_closed_lifecycle() {
        assert!(serde_json::from_value::<BlockValidation>(json!({
            "state": "approved",
            "requires_attention": false
        }))
        .is_err());
    }

    #[test]
    fn question_accepts_single_multi_and_optional_custom_input() {
        let single = question_manifest(QuestionNode {
            prompt: "Choose one".to_owned(),
            mode: QuestionMode::SingleSelect,
            options: options(2),
            min_selections: 1,
            max_selections: 1,
            allow_custom: false,
            require_custom_input: false,
            submit_action: "question.submit".to_owned(),
        });
        validate_manifest(&single).expect("single-select should validate");

        let multiple = question_manifest(QuestionNode {
            prompt: "Choose several".to_owned(),
            mode: QuestionMode::MultiSelect,
            options: options(3),
            min_selections: 1,
            max_selections: 3,
            allow_custom: false,
            require_custom_input: false,
            submit_action: "question.submit".to_owned(),
        });
        validate_manifest(&multiple).expect("multi-select should validate");

        let custom = question_manifest(QuestionNode {
            prompt: "Choose or add your own".to_owned(),
            mode: QuestionMode::MultiSelect,
            options: options(3),
            min_selections: 1,
            max_selections: 3,
            allow_custom: true,
            require_custom_input: false,
            submit_action: "question.submit".to_owned(),
        });
        validate_manifest(&custom).expect("optional custom input should validate");
    }

    #[test]
    fn question_rejects_impossible_selection_bounds() {
        let impossible = question_manifest(QuestionNode {
            prompt: "Impossible".to_owned(),
            mode: QuestionMode::MultiSelect,
            options: options(2),
            min_selections: 2,
            max_selections: 1,
            allow_custom: false,
            require_custom_input: false,
            submit_action: "question.submit".to_owned(),
        });

        assert!(matches!(
            validate_manifest(&impossible),
            Err(BlockError::InvalidManifest(message))
                if message.contains("Question selection bounds")
        ));
    }

    #[test]
    fn approval_hash_has_a_stable_golden_vector() {
        let proposal = ApprovalProposal {
            action: "email.send".to_owned(),
            destination: "mailto:owner@example.com".to_owned(),
            content: json!({
                "subject": "Intro",
                "body": "Hello"
            }),
            expires_at: 1_785_456_000,
        };

        assert_eq!(
            compute_approval_hash(&proposal).expect("approval hash"),
            "15c0fae0965fb074722e07e8ccaf8a431ccb9328195c8fc3682e8d0a4f77f44c"
        );
    }

    #[test]
    fn agent_proposal_accepts_create_and_update_examples() {
        let create = json!({
            "operation": "create",
            "request_id": "8797229a-3c2c-4bd0-8e2e-48e13f9bcc6f",
            "name": "Developer",
            "role": "Builds premium client websites.",
            "instructions": "Build from the approved client brief.",
            "avatar_url": "https://example.com/developer.png",
            "run_target": { "type": "local" }
        });
        let update = json!({
            "operation": "update",
            "request_id": "5b0907aa-aa18-4db7-b721-04c90492b9e0",
            "agent_id": "1a3c3f89-c798-4e99-bf37-a9b5f1abb167",
            "name": "Researcher",
            "role": "Finds and qualifies US businesses.",
            "instructions": "Preserve source evidence for every qualified lead.",
            "run_target": {
                "type": "provider",
                "provider_id": "trusted-remote"
            }
        });
        let schema = agent_proposal_schema();

        validate_instance(&schema, &create).expect("create proposal should validate");
        validate_instance(&schema, &update).expect("update proposal should validate");
        serde_json::from_value::<AgentProposalData>(create)
            .expect("create proposal should deserialize to the safe typed model");
        serde_json::from_value::<AgentProposalData>(update)
            .expect("update proposal should deserialize to the safe typed model");

        let missing_agent_id = json!({
            "operation": "update",
            "request_id": Uuid::nil(),
            "name": "Researcher",
            "role": "Researcher",
            "instructions": "Research.",
            "run_target": { "type": "local" }
        });
        assert!(validate_instance(&schema, &missing_agent_id).is_err());
    }

    #[test]
    fn agent_proposal_rejects_secret_bearing_instance_and_action_schemas() {
        for forbidden in [
            "private_key",
            "envVars",
            "provider_credentials",
            "backend_config",
        ] {
            let mut manifest = manifest("agent-proposal");
            manifest.input_schema = agent_proposal_schema();
            manifest
                .input_schema
                .pointer_mut("/properties")
                .and_then(Value::as_object_mut)
                .expect("properties")
                .insert(forbidden.to_owned(), json!({ "type": "string" }));

            assert!(
                matches!(
                    validate_manifest(&manifest),
                    Err(BlockError::InvalidManifest(message))
                        if message.contains("secret-bearing")
                ),
                "{forbidden} should be rejected"
            );
        }

        let mut manifest = manifest("agent-proposal");
        manifest.input_schema = agent_proposal_schema();
        let mut action_schema = empty_object_schema();
        action_schema
            .as_object_mut()
            .expect("schema object")
            .insert(
                "properties".to_owned(),
                json!({ "access_token": { "type": "string" } }),
            );
        manifest
            .actions
            .push(signed_action("agent.create", true, Some(action_schema)));
        assert!(matches!(
            validate_manifest(&manifest),
            Err(BlockError::InvalidManifest(message))
                if message.contains("secret-bearing")
        ));
    }

    #[test]
    fn duplicate_action_ids_are_rejected() {
        let mut manifest = manifest("section");
        manifest.actions = vec![
            signed_action("duplicate", false, Some(empty_object_schema())),
            signed_action("duplicate", false, Some(empty_object_schema())),
        ];

        assert!(matches!(
            validate_manifest(&manifest),
            Err(BlockError::InvalidManifest(message)) if message.contains("unique")
        ));
    }

    #[test]
    fn unsupported_primitive_versions_are_rejected() {
        let mut manifest = manifest("section");
        manifest.primitive_versions.insert("section".to_owned(), 2);

        assert!(matches!(
            validate_manifest(&manifest),
            Err(BlockError::InvalidManifest(message))
                if message.contains("unsupported primitive version")
        ));
    }

    #[test]
    fn composition_deeper_than_twelve_levels_is_rejected() {
        let mut node = section_node();
        for _ in 0..12 {
            node = BlockNode::Stack {
                gap: BlockGap::Small,
                children: vec![node],
            };
        }
        let mut manifest = manifest("section");
        manifest.tree = node;

        assert!(matches!(
            validate_manifest(&manifest),
            Err(BlockError::InvalidManifest(message)) if message.contains("12 nesting levels")
        ));
    }

    #[test]
    fn composition_larger_than_two_hundred_nodes_is_rejected() {
        let mut manifest = manifest("section");
        manifest.tree = BlockNode::Stack {
            gap: BlockGap::Small,
            children: (0..200).map(|_| section_node()).collect(),
        };

        assert!(matches!(
            validate_manifest(&manifest),
            Err(BlockError::InvalidManifest(message)) if message.contains("200 nodes")
        ));
    }

    #[test]
    fn external_schema_references_are_rejected() {
        let mut manifest = manifest("section");
        manifest.input_schema = json!({
            "$schema": JSON_SCHEMA_DRAFT_2020_12,
            "$ref": "https://example.com/remote-schema.json"
        });

        assert!(matches!(
            validate_manifest(&manifest),
            Err(BlockError::InvalidManifest(message))
                if message.contains("remote JSON Schema references")
        ));
    }

    #[test]
    fn schema_invalid_examples_are_rejected() {
        let mut manifest = manifest("section");
        manifest.input_schema = json!({
            "$schema": JSON_SCHEMA_DRAFT_2020_12,
            "type": "object",
            "additionalProperties": false,
            "required": ["summary"],
            "properties": {
                "summary": { "type": "string" }
            }
        });
        manifest.examples = vec![BlockExample {
            name: "Invalid".to_owned(),
            data: json!({ "summary": 42 }),
        }];

        assert!(matches!(
            validate_manifest(&manifest),
            Err(BlockError::InvalidManifest(message)) if message.contains("example Invalid")
        ));
    }

    #[test]
    fn presentation_surfaces_are_rejected_outside_core() {
        let mut manifest = manifest("section");
        manifest.origin = BlockOrigin::WorkspaceCustom;
        manifest.actions.push(BlockActionDeclaration {
            id: "agent.review".to_owned(),
            label: "Review".to_owned(),
            input_schema: None,
            interaction: BlockInteraction::Presentation {
                surface: CorePresentationSurface::AgentReview,
            },
            permissions: Vec::new(),
        });

        assert!(matches!(
            validate_manifest(&manifest),
            Err(BlockError::InvalidManifest(message))
                if message.contains("reserved for Core manifests")
        ));
    }

    #[test]
    fn attention_without_a_resolving_action_is_rejected() {
        let mut manifest = manifest("section");
        manifest.validation.requires_attention = true;
        manifest
            .actions
            .push(signed_action("refresh", false, Some(empty_object_schema())));

        assert!(matches!(
            validate_manifest(&manifest),
            Err(BlockError::InvalidManifest(message))
                if message.contains("attention requires")
        ));
    }

    #[test]
    fn resolving_signed_action_without_a_schema_is_rejected() {
        let mut manifest = manifest("section");
        manifest.actions.push(signed_action("resolve", true, None));

        assert!(matches!(
            validate_manifest(&manifest),
            Err(BlockError::InvalidManifest(message))
                if message.contains("resolving actions require an input schema")
        ));
    }

    #[test]
    fn approval_schema_requires_exact_action_destination_content_and_expiry() {
        for missing in ["action", "destination", "content", "expires_at"] {
            let required: Vec<_> = ["action", "destination", "content", "expires_at"]
                .into_iter()
                .filter(|field| field != &missing)
                .collect();
            let mut manifest = manifest("approval");
            manifest.input_schema = json!({
                "$schema": JSON_SCHEMA_DRAFT_2020_12,
                "type": "object",
                "additionalProperties": false,
                "required": required,
                "properties": {
                    "action": { "type": "string" },
                    "destination": { "type": "string" },
                    "content": {},
                    "expires_at": { "type": "integer" }
                }
            });
            manifest.examples.clear();

            assert!(
                matches!(
                    validate_manifest(&manifest),
                    Err(BlockError::InvalidManifest(message))
                        if message.contains(&format!("exact {missing}"))
                ),
                "missing {missing} should be rejected"
            );
        }

        let mut permissive = manifest("approval");
        permissive.input_schema = json!({
            "$schema": JSON_SCHEMA_DRAFT_2020_12,
            "type": "object",
            "additionalProperties": true,
            "required": ["action", "destination", "content", "expires_at"],
            "properties": {
                "action": { "type": "string" },
                "destination": { "type": "string" },
                "content": {},
                "expires_at": { "type": "integer" }
            }
        });
        permissive.examples.clear();
        assert!(matches!(
            validate_manifest(&permissive),
            Err(BlockError::InvalidManifest(message))
                if message.contains("reject unspecified fields")
        ));
    }
}
