//! Provider-owned account facts. Missing measurements never imply an allowance.

use serde::{Deserialize, Serialize};

/// Whether the provider confirmed a subscription, another credential, or neither.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountAuthentication {
    Subscription,
    ApiKey,
    SignedOut,
    #[default]
    Unknown,
}

/// Freshness applies to the measurement, independently of authentication.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MeasurementStatus {
    Live,
    Cached,
    Stale,
    #[default]
    Unavailable,
}

/// A provider-reported window; the identifier also distinguishes model buckets.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageWindow {
    pub id: String,
    pub label: String,
    pub used_percent: f64,
    pub resets_at: Option<i64>,
    pub duration_minutes: Option<i64>,
    /// Only an account-wide window can block every model in the connection.
    pub account_wide: bool,
}

/// One reasoning effort a model advertises, with the vendor's own description.
///
/// The description is the vendor's wording, not ours: an owner choosing between
/// `xhigh` and `max` needs the provider's explanation of what that costs, and
/// inventing one here would drift the moment a model changes.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionModelEffort {
    pub effort: String,
    pub description: Option<String>,
}

/// A model returned by the selected vendor runtime, never a guessed model ID.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionModel {
    pub id: String,
    pub label: String,
    pub is_default: bool,
    /// The reasoning efforts this model advertises, in the vendor's order.
    ///
    /// Empty means the provider reported none for this model, which is a real
    /// answer and not a parse failure: Claude's Haiku entry carries no
    /// `supportedEffortLevels` at all. The list is never hardcoded, because it
    /// differs per model even within one provider (measured on this Mac:
    /// GPT-5.6-Sol offers `ultra`, GPT-5.5 stops at `xhigh`).
    #[serde(default)]
    pub efforts: Vec<SubscriptionModelEffort>,
    /// The effort the provider itself defaults this model to, when it says.
    ///
    /// `None` means the provider advertises efforts without naming a default
    /// (Claude does exactly that), so the owner is offered the provider's own
    /// default as an unnamed choice rather than one we picked for them.
    #[serde(default)]
    pub default_effort: Option<String>,
}

/// Accept a vendor-advertised effort only in the shape that can be round-tripped
/// safely into an env var, a CLI argument and a JSON turn parameter.
///
/// Everything measured is a short lowercase word (`low` … `ultra`), so this is
/// deliberately narrow: an effort reaches a vendor process, and a value carrying
/// whitespace, control bytes or shell punctuation has no business doing that.
pub(super) fn effort_token(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    let shaped = !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    shaped.then(|| value.to_owned())
}

/// Public projection only: no credentials, credential paths, or raw CLI errors.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionAccount {
    pub authentication: AccountAuthentication,
    pub plan_label: Option<String>,
    pub measurement_status: MeasurementStatus,
    pub captured_at: Option<i64>,
    pub windows: Vec<AccountUsageWindow>,
    pub models: Vec<SubscriptionModel>,
    pub notice: Option<String>,
}

/// Validate percentages before rendering or using them in readiness.
pub(super) fn percent(value: Option<f64>) -> Option<f64> {
    value.filter(|value| value.is_finite() && (0.0..=100.0).contains(value))
}
