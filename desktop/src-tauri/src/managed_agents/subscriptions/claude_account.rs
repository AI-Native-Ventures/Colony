//! Account/model metadata from the unmodified CLI; usage is version-gated by response.

use super::{account::*, rpc::AccountRpc};
use serde_json::{json, Value};
use std::path::Path;

/// Claude Code performs its own browser login; Colony never receives its token.
pub(crate) async fn connect(binary: &Path, profile: &Path) -> Result<(), String> {
    use std::process::Stdio;
    let mut command = tokio::process::Command::new(binary);
    super::environment::dedicated(&mut command, profile, "CLAUDE_CONFIG_DIR");
    let mut child = command
        .args(["auth", "login"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "Claude sign-in could not start")?;
    let status = tokio::time::timeout(std::time::Duration::from_secs(300), child.wait())
        .await
        .map_err(|_| "Claude sign-in timed out. Connect again when you are ready.")?
        .map_err(|_| "Claude sign-in ended unexpectedly")?;
    if !status.success() {
        return Err("Claude sign-in did not complete. Try connecting again.".into());
    }
    Ok(())
}

pub(crate) async fn inspect(binary: &Path, profile: Option<&Path>) -> SubscriptionAccount {
    let (mut client, initialized) = match AccountRpc::claude(binary, profile).await {
        Ok(value) => value,
        Err(notice) => {
            return SubscriptionAccount {
                notice: Some(notice),
                ..Default::default()
            }
        }
    };
    let mut account = account_from_value(&initialized);
    if account.authentication == AccountAuthentication::Subscription {
        // The CLI's structured get_usage control response is experimental. Unsupported
        // versions fail closed to unavailable; no private token endpoint fallback.
        if let Ok(usage) = client.request("get_usage", json!({})).await {
            account.windows = windows_from_value(&usage);
            if !account.windows.is_empty() {
                account.measurement_status = MeasurementStatus::Live;
                account.captured_at = Some(chrono::Utc::now().timestamp());
            }
        }
        if account.windows.is_empty() {
            account.notice = Some("Claude did not report current usage limits. You can check them in Claude Code with /usage.".into());
        }
    }
    client.close().await;
    account
}

fn account_from_value(value: &Value) -> SubscriptionAccount {
    let account = &value["account"];
    let plan = account
        .get("subscriptionType")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let api_key = account.get("apiKeySource").and_then(Value::as_str);
    let known_non_key_source = matches!(
        api_key,
        None | Some("none" | "user" | "project" | "org" | "temporary" | "oauth")
    );
    let subscription = plan.is_some()
        && account.get("tokenSource").is_none_or(Value::is_null)
        && account
            .get("apiProvider")
            .and_then(Value::as_str)
            .is_none_or(|value| value == "firstParty")
        && known_non_key_source;
    let authentication = if subscription {
        AccountAuthentication::Subscription
    } else if account
        .get("tokenSource")
        .is_some_and(|value| !value.is_null())
        || matches!(
            api_key,
            Some("ANTHROPIC_API_KEY" | "apiKeyHelper" | "/login managed key")
        )
        || account
            .get("apiProvider")
            .and_then(Value::as_str)
            .is_some_and(|value| value != "firstParty")
    {
        AccountAuthentication::ApiKey
    } else if account.is_null() || account.as_object().is_some_and(|object| object.is_empty()) {
        AccountAuthentication::SignedOut
    } else {
        AccountAuthentication::Unknown
    };
    let models = value
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| {
            let id = model
                .get("value")
                .or_else(|| model.get("id"))?
                .as_str()?
                .trim();
            if id.is_empty() {
                return None;
            }
            Some(SubscriptionModel {
                id: id.to_owned(),
                label: model
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or(id)
                    .to_owned(),
                is_default: id == "default",
            })
        })
        .collect();
    SubscriptionAccount {
        authentication,
        plan_label: plan.map(str::to_owned),
        models,
        ..Default::default()
    }
}

fn windows_from_value(value: &Value) -> Vec<AccountUsageWindow> {
    if value.get("rate_limits_available").and_then(Value::as_bool) != Some(true) {
        return vec![];
    }
    let Some(windows) = value.get("rate_limits").and_then(Value::as_object) else {
        return vec![];
    };
    windows
        .iter()
        .filter_map(|(id, value)| {
            let used_percent = percent(value.get("utilization").and_then(Value::as_f64))?;
            let (label, duration_minutes) = match id.as_str() {
                "five_hour" => ("5-hour allowance".into(), Some(300)),
                "seven_day" => ("Weekly allowance".into(), Some(10080)),
                _ => (id.replace('_', " "), None),
            };
            Some(AccountUsageWindow {
                id: id.clone(),
                label,
                used_percent,
                duration_minutes,
                account_wide: matches!(id.as_str(), "five_hour" | "seven_day"),
                resets_at: value
                    .get("resets_at")
                    .and_then(Value::as_str)
                    .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                    .map(|date| date.timestamp()),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cached_subscription_does_not_override_an_active_api_key() {
        let account = account_from_value(
            &json!({"account":{"subscriptionType":"max","apiKeySource":"ANTHROPIC_API_KEY"}}),
        );
        assert_eq!(account.authentication, AccountAuthentication::ApiKey);
    }

    #[test]
    fn direct_subscription_auth_is_distinct_from_missing_profile_scope() {
        assert_eq!(account_from_value(&json!({"account":{"subscriptionType":"pro","apiProvider":"firstParty","apiKeySource":"none"}})).authentication, AccountAuthentication::Subscription);
        assert_eq!(
            account_from_value(&json!({"account":{}})).authentication,
            AccountAuthentication::SignedOut
        );
    }

    #[test]
    fn unknown_credential_sources_are_not_guessed_to_be_subscriptions() {
        assert_eq!(
            account_from_value(
                &json!({"account":{"subscriptionType":"max","apiKeySource":"new-source"}})
            )
            .authentication,
            AccountAuthentication::Unknown
        );
    }

    #[test]
    fn usage_preserves_exhaustion_and_rejects_missing_utilization() {
        let windows = windows_from_value(&json!({"rate_limits_available":true,"rate_limits":{
            "five_hour":{"utilization":100,"resets_at":"2026-09-09T14:00:00+02:00"},
            "seven_day":{"utilization":null}
        }}));
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].used_percent, 100.0);
        assert_eq!(windows[0].resets_at, Some(1788955200));
        assert!(windows_from_value(&json!({"rate_limits_available":false})).is_empty());
    }
}
