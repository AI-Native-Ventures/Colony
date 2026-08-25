//! Input/navigation commands dispatched to a live web session's CDP client.

use buzz_browser_pkg::cdp::CdpClient;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::oneshot;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebMouseInput {
    /// CDP mouse event type: move, press, or release.
    pub event_type: String,
    /// Page-space horizontal coordinate.
    pub x: f64,
    /// Page-space vertical coordinate.
    pub y: f64,
    /// Optional CDP mouse button.
    pub button: Option<String>,
    /// Optional click count for press/release events.
    pub click_count: Option<u8>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebWheelInput {
    /// Page-space horizontal coordinate.
    pub x: f64,
    /// Page-space vertical coordinate.
    pub y: f64,
    /// Horizontal wheel delta.
    pub delta_x: f64,
    /// Vertical wheel delta.
    pub delta_y: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebKeyInput {
    /// CDP key event type: `keyDown` or `keyUp`.
    pub event_type: String,
    /// Logical key value.
    pub key: String,
    /// Optional physical key code.
    pub code: Option<String>,
    /// Optional text associated with a key-down event.
    pub text: Option<String>,
    /// CDP modifier bitmask.
    pub modifiers: Option<u8>,
    /// Optional Windows virtual key code.
    pub windows_virtual_key_code: Option<i64>,
}

pub(super) enum WebCommand {
    Navigate {
        url: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Mouse {
        input: WebMouseInput,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Wheel {
        input: WebWheelInput,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Key {
        input: WebKeyInput,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Text {
        text: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Back {
        reply: oneshot::Sender<Result<(), String>>,
    },
    Forward {
        reply: oneshot::Sender<Result<(), String>>,
    },
    Reload {
        reply: oneshot::Sender<Result<(), String>>,
    },
    Resize {
        width: u32,
        height: u32,
        device_scale_factor: f64,
        reply: oneshot::Sender<Result<(), String>>,
    },
}

pub(super) async fn execute_command(
    client: &mut CdpClient,
    command: WebCommand,
) -> Result<(), String> {
    match command {
        WebCommand::Navigate { url, reply } => {
            let result =
                super::send_command_bounded(client, "Page.navigate", json!({ "url": url }))
                    .await
                    .map(|_| ())
                    .map_err(|error| error.to_string());
            let _ = reply.send(result);
        }
        WebCommand::Mouse { input, reply } => {
            let mut params = json!({
                "type": input.event_type,
                "x": input.x,
                "y": input.y,
                "button": input.button.unwrap_or_else(|| "none".to_string()),
            });
            if let Some(click_count) = input.click_count {
                params["clickCount"] = json!(click_count);
            }
            let result = super::send_command_bounded(client, "Input.dispatchMouseEvent", params)
                .await
                .map(|_| ())
                .map_err(|error| error.to_string());
            let _ = reply.send(result);
        }
        WebCommand::Wheel { input, reply } => {
            let result = super::send_command_bounded(
                client,
                "Input.dispatchMouseEvent",
                json!({
                    "type": "mouseWheel",
                    "x": input.x,
                    "y": input.y,
                    "deltaX": input.delta_x,
                    "deltaY": input.delta_y,
                }),
            )
            .await
            .map(|_| ())
            .map_err(|error| error.to_string());
            let _ = reply.send(result);
        }
        WebCommand::Key { input, reply } => {
            let mut params = json!({
                "type": input.event_type,
                "key": input.key,
                "code": input.code.unwrap_or_default(),
                "modifiers": input.modifiers.unwrap_or(0),
            });
            if let Some(text) = input.text {
                params["text"] = json!(text);
            }
            if let Some(key_code) = input.windows_virtual_key_code {
                params["windowsVirtualKeyCode"] = json!(key_code);
            }
            let result = super::send_command_bounded(client, "Input.dispatchKeyEvent", params)
                .await
                .map(|_| ())
                .map_err(|error| error.to_string());
            let _ = reply.send(result);
        }
        WebCommand::Text { text, reply } => {
            let result =
                super::send_command_bounded(client, "Input.insertText", json!({ "text": text }))
                    .await
                    .map(|_| ())
                    .map_err(|error| error.to_string());
            let _ = reply.send(result);
        }
        WebCommand::Back { reply } => {
            let _ = reply.send(navigate_history(client, -1).await);
        }
        WebCommand::Forward { reply } => {
            let _ = reply.send(navigate_history(client, 1).await);
        }
        WebCommand::Reload { reply } => {
            let result =
                super::send_command_bounded(client, "Page.reload", json!({ "ignoreCache": false }))
                    .await
                    .map(|_| ())
                    .map_err(|error| error.to_string());
            let _ = reply.send(result);
        }
        WebCommand::Resize {
            width,
            height,
            device_scale_factor,
            reply,
        } => {
            let result = super::send_command_bounded(
                client,
                "Emulation.setDeviceMetricsOverride",
                json!({
                    "width": width,
                    "height": height,
                    "deviceScaleFactor": device_scale_factor,
                    "mobile": false
                }),
            )
            .await
            .map(|_| ())
            .map_err(|error| error.to_string());
            let _ = reply.send(result);
        }
    }
    Ok(())
}

async fn navigate_history(client: &mut CdpClient, delta: i64) -> Result<(), String> {
    let history = super::send_command_bounded(client, "Page.getNavigationHistory", json!({}))
        .await
        .map_err(|error| error.to_string())?;
    let index = history["currentIndex"].as_i64().unwrap_or(0) + delta;
    let entry_id = history["entries"]
        .as_array()
        .and_then(|entries| {
            usize::try_from(index)
                .ok()
                .and_then(|index| entries.get(index))
        })
        .and_then(|entry| entry["id"].as_i64());
    let Some(entry_id) = entry_id else {
        return Ok(());
    };
    super::send_command_bounded(
        client,
        "Page.navigateToHistoryEntry",
        json!({ "entryId": entry_id }),
    )
    .await
    .map(|_| ())
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::web::validation::{validate_key, validate_mouse};

    #[test]
    fn input_validation_accepts_supported_events_and_rejects_bad_coordinates() {
        assert!(validate_mouse(&WebMouseInput {
            event_type: "mousePressed".into(),
            x: 20.0,
            y: 40.0,
            button: Some("left".into()),
            click_count: Some(1),
        })
        .is_ok());
        assert!(validate_mouse(&WebMouseInput {
            event_type: "mouseMoved".into(),
            x: f64::NAN,
            y: 0.0,
            button: None,
            click_count: None,
        })
        .is_err());
    }

    #[test]
    fn key_validation_preserves_text_support() {
        assert!(validate_key(&WebKeyInput {
            event_type: "keyDown".into(),
            key: "a".into(),
            code: Some("KeyA".into()),
            text: Some("a".into()),
            modifiers: Some(0),
            windows_virtual_key_code: Some(65),
        })
        .is_ok());
        assert!(validate_key(&WebKeyInput {
            event_type: "keyPress".into(),
            key: "a".into(),
            code: None,
            text: None,
            modifiers: None,
            windows_virtual_key_code: None,
        })
        .is_err());
    }
}
