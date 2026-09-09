//! Idle-session controls; neither operation changes process-wide settings.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::wire::{self, SessionCancelParams, SessionSetModelParams, WireSender, INVALID_PARAMS};
use crate::{decode, reject, session_models, App};

pub(crate) async fn set_model(app: &Arc<App>, id: Value, params: Value, wire_tx: &WireSender) {
    let p: SessionSetModelParams = match decode(params, "session/set_model") {
        Ok(p) => p,
        Err(m) => return reject(wire_tx, id, INVALID_PARAMS, &m).await,
    };
    let result = {
        let mut sessions = app.sessions.lock().await;
        match sessions.get_mut(&p.session_id) {
            None => Err("unknown session"),
            Some(session) if session.busy => Err("prompt already in flight"),
            Some(session) => session_models::select(&p.model_id, &session.available_model_ids)
                .map(|selection| session.effective_model = Some(selection)),
        }
    };
    if let Err(reason) = result {
        return reject(
            wire_tx,
            id,
            INVALID_PARAMS,
            &format!("session/set_model: {reason}"),
        )
        .await;
    }
    wire::send(
        wire_tx,
        wire::ok(
            id,
            json!({ "sessionId": p.session_id, "modelId": p.model_id }),
        ),
    )
    .await;
}

/// Colony ACP extension advertised by `session/new` metadata. Removing the
/// registry's final Arc runs the existing MCP Server Drop cleanup.
pub(crate) async fn close(app: &Arc<App>, id: Value, params: Value, wire_tx: &WireSender) {
    let p: SessionCancelParams = match decode(params, "_colony/session/close") {
        Ok(p) => p,
        Err(m) => return reject(wire_tx, id, INVALID_PARAMS, &m).await,
    };
    let result = {
        let mut sessions = app.sessions.lock().await;
        match sessions.get(&p.session_id) {
            None => Err("unknown session"),
            Some(session) if session.busy => Err("prompt already in flight"),
            Some(_) => Ok(sessions.remove(&p.session_id)),
        }
    };
    match result {
        Ok(session) => {
            drop(session);
            wire::send(
                wire_tx,
                wire::ok(id, json!({ "sessionId": p.session_id, "closed": true })),
            )
            .await;
        }
        Err(reason) => {
            reject(
                wire_tx,
                id,
                INVALID_PARAMS,
                &format!("_colony/session/close: {reason}"),
            )
            .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Config, Provider};
    use crate::llm::Llm;
    use crate::wire::WireMsg;
    use std::collections::HashMap;
    use tokio::sync::{mpsc, Mutex, OnceCell};

    fn app() -> Arc<App> {
        let mut cfg =
            Config::for_discovery(Provider::OpenAi, "test".into(), "http://localhost".into());
        cfg.model = "gpt-5.5".into();
        cfg.hints_enabled = false;
        Arc::new(App {
            llm: Arc::new(Llm::new(&cfg).unwrap()),
            cfg,
            sessions: Mutex::new(HashMap::new()),
            models_cache: OnceCell::new(),
        })
    }

    async fn new_session(
        app: &Arc<App>,
        tx: &WireSender,
        rx: &mut mpsc::Receiver<WireMsg>,
    ) -> String {
        crate::session_new(app, json!(1), json!({"cwd": "/tmp"}), tx).await;
        let WireMsg::Notify(value) = rx.recv().await.unwrap();
        assert_eq!(
            value["result"]["_meta"]["colony"]["closeSessionMethod"],
            "_colony/session/close"
        );
        value["result"]["sessionId"].as_str().unwrap().to_owned()
    }

    #[tokio::test]
    async fn disposing_sessions_does_not_exhaust_the_session_cap() {
        let app = app();
        let (tx, mut rx) = mpsc::channel(8);
        for _ in 0..3 {
            let session_id = new_session(&app, &tx, &mut rx).await;
            let weak_mcp = Arc::downgrade(&app.sessions.lock().await[&session_id].mcp);
            close(&app, json!(2), json!({"sessionId": session_id}), &tx).await;
            let WireMsg::Notify(value) = rx.recv().await.unwrap();
            assert_eq!(value["result"]["closed"], true);
            assert!(app.sessions.lock().await.is_empty());
            assert!(weak_mcp.upgrade().is_none());
        }
    }

    #[tokio::test]
    async fn controls_reject_active_sessions_and_unadvertised_settings() {
        let app = app();
        let (tx, mut rx) = mpsc::channel(8);
        let session_id = new_session(&app, &tx, &mut rx).await;
        set_model(
            &app,
            json!(2),
            json!({"sessionId": session_id, "modelId": "gpt-5.5[max]"}),
            &tx,
        )
        .await;
        let WireMsg::Notify(value) = rx.recv().await.unwrap();
        assert_eq!(value["error"]["code"], INVALID_PARAMS);
        assert!(app.sessions.lock().await[&session_id]
            .effective_model
            .is_none());
        app.sessions.lock().await.get_mut(&session_id).unwrap().busy = true;
        close(&app, json!(3), json!({"sessionId": session_id}), &tx).await;
        let WireMsg::Notify(value) = rx.recv().await.unwrap();
        assert_eq!(value["error"]["code"], INVALID_PARAMS);
        set_model(
            &app,
            json!(4),
            json!({"sessionId": session_id, "modelId": "gpt-5.5[high]"}),
            &tx,
        )
        .await;
        let WireMsg::Notify(value) = rx.recv().await.unwrap();
        assert_eq!(value["error"]["code"], INVALID_PARAMS);
        assert_eq!(app.sessions.lock().await.len(), 1);
    }
}
