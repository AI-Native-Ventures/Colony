//! Official Codex App Server account/rate-limit/model APIs; never reads auth.json.

use super::{account::*, rpc::AccountRpc};
use serde_json::{json, Value};
use std::path::Path;
use tauri_plugin_opener::OpenerExt;

/// Let Codex own OAuth, token storage and refresh in a dedicated native profile.
pub(crate) async fn connect(
    binary: &Path,
    profile: &Path,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let mut client = AccountRpc::codex(binary, Some(profile)).await?;
    let result = async {
        let login = client
            .request("account/login/start", json!({"type":"chatgpt"}))
            .await?;
        let url = login
            .get("authUrl")
            .and_then(Value::as_str)
            .ok_or("Codex did not provide a sign-in link")?;
        let parsed = url::Url::parse(url).map_err(|_| "Codex returned an invalid sign-in link")?;
        if parsed.scheme() != "https"
            || !matches!(
                parsed.host_str(),
                Some("auth.openai.com" | "auth.chatgpt.com")
            )
        {
            return Err("Codex returned an unsupported sign-in destination".into());
        }
        let id = login
            .get("loginId")
            .and_then(Value::as_str)
            .ok_or("Codex did not provide a sign-in session")?;
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|_| "The browser could not open Codex sign-in")?;
        client.wait_for_codex_login(id).await
    }
    .await;
    client.close().await;
    result
}

pub(crate) async fn inspect(binary: &Path, profile: Option<&Path>) -> SubscriptionAccount {
    let mut client = match AccountRpc::codex(binary, profile).await {
        Ok(client) => client,
        Err(notice) => {
            return SubscriptionAccount {
                notice: Some(notice),
                ..Default::default()
            }
        }
    };
    let mut account = match client
        .request("account/read", json!({"refreshToken":false}))
        .await
    {
        Ok(value) => account_from_value(&value),
        Err(notice) => SubscriptionAccount {
            notice: Some(notice),
            ..Default::default()
        },
    };
    if account.authentication == AccountAuthentication::Subscription {
        match client.request("account/rateLimits/read", json!({})).await {
            Ok(value) => {
                account.windows = windows_from_value(&value);
                if !account.windows.is_empty() {
                    account.measurement_status = MeasurementStatus::Live;
                    account.captured_at = Some(chrono::Utc::now().timestamp());
                }
            }
            Err(_) => account.notice = Some(
                "Codex did not report usage limits. This does not mean your allowance is empty."
                    .into(),
            ),
        }
        let mut cursor = Value::Null;
        for _ in 0..10 {
            let Ok(value) = client
                .request(
                    "model/list",
                    json!({"limit":100,"includeHidden":false,"cursor":cursor}),
                )
                .await
            else {
                break;
            };
            account.models.extend(models_from_value(&value));
            cursor = value.get("nextCursor").cloned().unwrap_or(Value::Null);
            if cursor.is_null() {
                break;
            }
        }
    }
    client.close().await;
    account
}

fn account_from_value(value: &Value) -> SubscriptionAccount {
    let Some(account) = value.get("account").filter(|value| !value.is_null()) else {
        return SubscriptionAccount {
            authentication: AccountAuthentication::SignedOut,
            ..Default::default()
        };
    };
    let authentication = match account.get("type").and_then(Value::as_str) {
        Some("chatgpt" | "chatgptAuthTokens") => AccountAuthentication::Subscription,
        Some("apiKey" | "apikey") => AccountAuthentication::ApiKey,
        _ => AccountAuthentication::Unknown,
    };
    SubscriptionAccount {
        authentication,
        plan_label: account
            .get("planType")
            .and_then(Value::as_str)
            .map(str::to_owned),
        ..Default::default()
    }
}

fn windows_from_value(value: &Value) -> Vec<AccountUsageWindow> {
    let mut result = Vec::new();
    if let Some(buckets) = value
        .get("rateLimitsByLimitId")
        .and_then(Value::as_object)
        .filter(|map| !map.is_empty())
    {
        for (id, bucket) in buckets {
            append_windows(&mut result, id, bucket);
        }
    } else if let Some(bucket) = value.get("rateLimits") {
        append_windows(&mut result, "codex", bucket);
    }
    result
}

fn append_windows(result: &mut Vec<AccountUsageWindow>, id: &str, value: &Value) {
    let label = value.get("limitName").and_then(Value::as_str).unwrap_or(id);
    for key in ["primary", "secondary"] {
        let window = &value[key];
        let Some(used_percent) = percent(window.get("usedPercent").and_then(Value::as_f64)) else {
            continue;
        };
        result.push(AccountUsageWindow {
            id: format!("{id}:{key}"),
            label: label.to_owned(),
            used_percent,
            resets_at: window.get("resetsAt").and_then(Value::as_i64),
            duration_minutes: window
                .get("windowDurationMins")
                .and_then(Value::as_i64)
                .filter(|value| *value > 0),
            account_wide: id == "codex",
        });
    }
}

fn models_from_value(value: &Value) -> Vec<SubscriptionModel> {
    value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| {
            if value.get("hidden").and_then(Value::as_bool) == Some(true) {
                return None;
            }
            let id = value
                .get("model")
                .or_else(|| value.get("id"))?
                .as_str()?
                .trim();
            if id.is_empty() {
                return None;
            }
            Some(SubscriptionModel {
                id: id.to_owned(),
                label: value
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or(id)
                    .to_owned(),
                is_default: value
                    .get("isDefault")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_key_is_not_a_subscription_and_null_is_signed_out() {
        assert_eq!(
            account_from_value(&json!({"account":{"type":"apiKey"}})).authentication,
            AccountAuthentication::ApiKey
        );
        assert_eq!(
            account_from_value(&json!({"account":null})).authentication,
            AccountAuthentication::SignedOut
        );
    }

    #[test]
    fn missing_window_is_unavailable_but_zero_used_is_real() {
        assert!(windows_from_value(&json!({"rateLimits":{"primary":null}})).is_empty());
        let windows = windows_from_value(
            &json!({"rateLimits":{"primary":{"usedPercent":0,"windowDurationMins":300}}}),
        );
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].used_percent, 0.0);
    }

    #[test]
    fn scoped_buckets_win_over_legacy_and_invalid_values_are_ignored() {
        let windows = windows_from_value(&json!({
            "rateLimits":{"primary":{"usedPercent":100}},
            "rateLimitsByLimitId":{"codex":{"primary":{"usedPercent":18},"secondary":{"usedPercent":101}}}
        }));
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].used_percent, 18.0);
    }
}
