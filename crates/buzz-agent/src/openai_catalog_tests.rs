use super::*;
use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use axum::{
    http::{HeaderMap, Method, Uri},
    response::IntoResponse,
    Json, Router,
};
use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};

use crate::config::{Provider, ThinkingEffort};
use crate::wire::WireMsg;

async fn fixture(
    responses: Vec<(StatusCode, Value)>,
) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let responses = Arc::new(Mutex::new(VecDeque::from(responses)));
    let count = Arc::new(AtomicUsize::new(0));
    let count_in_handler = count.clone();
    let router = Router::new()
        .route("/v1/chat/completions", axum::routing::post(|headers: HeaderMap, Json(body): Json<Value>| async move {
            assert_eq!(headers.get("authorization").unwrap(), "Bearer synthetic-existing-key");
            assert_eq!(body["model"], "gpt-5.6");
            assert_eq!(body["reasoning_effort"], "max");
            Json(json!({"model":"gpt-5.6", "choices":[{"index":0,"message":{"role":"assistant","content":"switched"},"finish_reason":"stop"}]}))
        }))
        .fallback(move |method: Method, uri: Uri, headers: HeaderMap| {
        let responses = responses.clone();
        let count = count_in_handler.clone();
        async move {
            assert_eq!(
                method,
                Method::GET,
                "catalog discovery must not perform inference"
            );
            assert_eq!(uri.path(), "/v1/models");
            assert_eq!(
                headers.get("authorization").unwrap(),
                "Bearer synthetic-existing-key"
            );
            assert_eq!(headers.get("cache-control").unwrap(), "no-store");
            count.fetch_add(1, Ordering::SeqCst);
            let (status, body) = responses.lock().await.pop_front().unwrap();
            (status, Json(body)).into_response()
        }
    });
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (base, count, server)
}

fn cfg(base: String) -> Config {
    let mut cfg = Config::for_discovery(Provider::OpenAi, "synthetic-existing-key".into(), base);
    cfg.model = "gpt-5.5".into();
    cfg.thinking_effort = Some(ThinkingEffort::Low);
    cfg.hints_enabled = false;
    cfg
}

#[tokio::test]
async fn live_catalog_uses_existing_auth_and_caches_only_served_models() {
    let (base, requests, server) = fixture(vec![(
        StatusCode::OK,
        json!({"data": [
            {"id":"gpt-5.5"}, {"id":"gpt-5.6"}, {"id":"gpt-5.6"},
            {"id":"text-embedding-3-large"}, {"id":"gpt-image-1"}, {"id":"bad[high]"}
        ]}),
    )])
    .await;
    let cfg = cfg(base);
    let cache = OnceCell::new();
    let models = resolve(&cfg, &cache).await.unwrap();
    assert_eq!(
        models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        ["gpt-5.5", "gpt-5.6"]
    );
    assert_eq!(resolve(&cfg, &cache).await.unwrap(), models);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    server.abort();
}

#[tokio::test]
async fn only_optional_custom_catalog_absence_falls_back_and_is_not_cached() {
    let (base, requests, server) = fixture(vec![
        (StatusCode::NOT_FOUND, json!({})),
        (StatusCode::OK, json!({"data":[{"id":"gpt-5.6"}]})),
    ])
    .await;
    let cfg = cfg(base);
    let cache = OnceCell::new();
    assert_eq!(resolve(&cfg, &cache).await.unwrap()[0].id, "gpt-5.5");
    assert!(cache.get().is_none());
    assert_eq!(resolve(&cfg, &cache).await.unwrap()[0].id, "gpt-5.6");
    assert_eq!(requests.load(Ordering::SeqCst), 2);
    server.abort();
    for base in [
        "https://api.openai.com/v1",
        "https://relay.example/gateway/openai/v1",
        "http://localhost/openai/k/virtual-key/v1",
    ] {
        assert!(!optional_catalog(&url::Url::parse(base).unwrap()));
    }
}

#[tokio::test]
async fn auth_server_and_malformed_responses_reject_without_caching() {
    for (status, body, auth) in [
        (StatusCode::UNAUTHORIZED, json!({}), true),
        (StatusCode::FORBIDDEN, json!({}), true),
        (StatusCode::SERVICE_UNAVAILABLE, json!({}), false),
        (StatusCode::OK, json!({"choices":[]}), false),
        (StatusCode::OK, json!({"data":[]}), false),
    ] {
        let (base, _, server) = fixture(vec![(status, body)]).await;
        let cache = OnceCell::new();
        let error = resolve(&cfg(base), &cache).await.unwrap_err();
        assert_eq!(matches!(error, AgentError::LlmAuth(_)), auth);
        assert!(cache.get().is_none());
        server.abort();
    }
}

#[tokio::test]
async fn scoped_session_can_choose_another_served_model_and_reasoning() {
    let (base, requests, server) = fixture(vec![(
        StatusCode::OK,
        json!({"data":[
            {"id":"gpt-5.5"}, {"id":"gpt-5.6"}
        ]}),
    )])
    .await;
    let cfg = cfg(base);
    let app = Arc::new(crate::App {
        llm: Arc::new(crate::llm::Llm::new(&cfg).unwrap()),
        cfg,
        sessions: Mutex::new(std::collections::HashMap::new()),
        models_cache: OnceCell::new(),
    });
    let (tx, mut rx) = mpsc::channel(8);
    crate::session_new(
        &app,
        json!(1),
        json!({"cwd":"/tmp", "_meta":{"colony":{"discoverModels":true}}}),
        &tx,
    )
    .await;
    let WireMsg::Notify(value) = rx.recv().await.unwrap();
    let id = value["result"]["sessionId"].as_str().unwrap().to_owned();
    let choices = value["result"]["models"]["availableModels"]
        .as_array()
        .unwrap();
    assert!(choices
        .iter()
        .any(|choice| choice["modelId"] == "gpt-5.6[max]"));
    crate::session_controls::set_model(
        &app,
        json!(2),
        json!({"sessionId":id,"modelId":"gpt-5.6[max]"}),
        &tx,
    )
    .await;
    let WireMsg::Notify(value) = rx.recv().await.unwrap();
    assert_eq!(value["result"]["modelId"], "gpt-5.6[max]");
    let sessions = app.sessions.lock().await;
    let prompt_cfg =
        crate::session_models::prompt_config(&app.cfg, sessions[&id].effective_model.as_ref());
    drop(sessions);
    assert_eq!(prompt_cfg.model, "gpt-5.6");
    assert_eq!(prompt_cfg.thinking_effort, Some(ThinkingEffort::Max));
    assert_eq!(app.cfg.model, "gpt-5.5");
    assert_eq!(app.cfg.thinking_effort, Some(ThinkingEffort::Low));
    let response = app
        .llm
        .complete(&prompt_cfg, "test", &[], &[], &prompt_cfg.model)
        .await
        .unwrap();
    assert_eq!(response.text, "switched");
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    server.abort();
}
