use super::wire::{self, Request};
use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponse, InvokeResponseBody};
use tauri::{Emitter, Listener, Manager};

fn response_body(body: &InvokeResponseBody) -> Result<Value, &'static str> {
    match body {
        InvokeResponseBody::Json(text) => {
            serde_json::from_str(text).map_err(|_| "Native JSON response is invalid")
        }
        InvokeResponseBody::Raw(bytes) => {
            Ok(json!({"__colony_binary": base64::engine::general_purpose::STANDARD.encode(bytes)}))
        }
    }
}

pub(super) fn channel(
    webview: &tauri::Webview,
    callback: CallbackFn,
    sequence: usize,
    body: &InvokeResponseBody,
) -> bool {
    if !super::enabled() {
        return false;
    }
    let sent = response_body(body).and_then(|payload| {
        wire::send(
            &json!({"type":"channel", "id":callback.0, "sequence":sequence, "payload":payload}),
        )
    });
    if sent.is_err() {
        webview.app_handle().exit(1);
    }
    true
}

fn error(id: u64, message: &str) {
    let _ = wire::send(&json!({"type":"response", "id":id, "error":message}));
}

fn valid_event(event: &str) -> bool {
    !event.is_empty()
        && event.len() <= 256
        && event
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_:./".contains(&b))
}

fn invoke(
    app: &tauri::AppHandle,
    id: u64,
    command: String,
    args: Value,
    binary: Option<String>,
    headers: HashMap<String, String>,
    pending: Arc<AtomicUsize>,
) {
    if command.is_empty() || command.len() > 256 {
        error(id, "Invalid native command");
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        error(id, "Native dispatch context is unavailable");
        return;
    };
    let webview: tauri::Webview = window.as_ref().clone();
    let body = if let Some(encoded) = binary {
        match base64::engine::general_purpose::STANDARD.decode(encoded) {
            Ok(bytes) => InvokeBody::Raw(bytes),
            Err(_) => {
                error(id, "Invalid binary request");
                return;
            }
        }
    } else if args.is_null() || args.is_object() {
        InvokeBody::Json(if args.is_null() { json!({}) } else { args })
    } else {
        error(id, "Native arguments must be an object");
        return;
    };
    let mut parsed_headers = tauri::http::HeaderMap::new();
    for (name, value) in headers {
        let (Ok(name), Ok(value)) = (
            tauri::http::HeaderName::from_bytes(name.as_bytes()),
            tauri::http::HeaderValue::from_str(&value),
        ) else {
            error(id, "Invalid native request headers");
            return;
        };
        parsed_headers.insert(name, value);
    }
    let Ok(url) = url::Url::parse("tauri://localhost") else {
        error(id, "Native origin is unavailable");
        return;
    };
    if pending.fetch_add(1, Ordering::AcqRel) >= 128 {
        pending.fetch_sub(1, Ordering::AcqRel);
        error(id, "Native host is busy");
        return;
    }
    let request = tauri::webview::InvokeRequest {
        cmd: command,
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url,
        body,
        headers: parsed_headers,
        invoke_key: app.invoke_key().to_string(),
    };
    webview.on_message(
        request,
        Box::new(move |webview, _, response, _, _| {
            pending.fetch_sub(1, Ordering::AcqRel);
            let result = match response {
                InvokeResponse::Ok(body) => match response_body(&body) {
                    Ok(value) => json!({"type":"response", "id":id, "result":value}),
                    Err(message) => json!({"type":"response", "id":id, "error":message}),
                },
                InvokeResponse::Err(value) => json!({"type":"response", "id":id, "error":value.0}),
            };
            if wire::send(&result).is_err() {
                webview.app_handle().exit(1);
            }
        }),
    );
}

pub(super) fn start(app: tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Accessory)?;
    std::thread::Builder::new()
        .name("electron-native-transport".into())
        .spawn(move || {
            let pending = Arc::new(AtomicUsize::new(0));
            let mut subscriptions = HashMap::new();
            let mut input = std::io::stdin().lock();
            if wire::send(&json!({"type":"ready", "version":1})).is_err() {
                app.exit(1);
                return;
            }
            loop {
                let request = match wire::read(&mut input) {
                    Ok(Some(request)) => request,
                    Ok(None) => break,
                    Err(message) => {
                        eprintln!("colony-native: {message}");
                        app.exit(1);
                        return;
                    }
                };
                match request {
                    Request::Shutdown {} => break,
                    Request::Invoke {
                        id,
                        command,
                        args,
                        binary,
                        headers,
                    } => invoke(&app, id, command, args, binary, headers, pending.clone()),
                    Request::Listen { id, event } => {
                        if !valid_event(&event)
                            || subscriptions.len() >= 1024
                            || subscriptions.contains_key(&id)
                        {
                            error(id, "Invalid native subscription");
                            continue;
                        }
                        let notify_app = app.clone();
                        let handle = app.listen_any(event, move |event| {
                            let Ok(payload) = serde_json::from_str::<Value>(event.payload()) else {
                                return;
                            };
                            if wire::send(&json!({"type":"event", "id":id, "payload":payload}))
                                .is_err()
                            {
                                notify_app.exit(1);
                            }
                        });
                        subscriptions.insert(id, handle);
                        let _ = wire::send(&json!({"type":"response", "id":id, "result":id}));
                    }
                    Request::Unlisten { id, subscription } => {
                        if let Some(handle) = subscriptions.remove(&subscription) {
                            app.unlisten(handle);
                        }
                        let _ = wire::send(&json!({"type":"response", "id":id, "result":null}));
                    }
                    Request::Emit { id, event, payload } => {
                        if !valid_event(&event) {
                            error(id, "Invalid native event");
                            continue;
                        }
                        match app.emit(&event, payload) {
                            Ok(()) => {
                                let _ =
                                    wire::send(&json!({"type":"response", "id":id, "result":null}));
                            }
                            Err(_) => error(id, "Native event could not be emitted"),
                        }
                    }
                }
            }
            for handle in subscriptions.into_values() {
                app.unlisten(handle);
            }
            app.exit(0);
        })?;
    Ok(())
}
