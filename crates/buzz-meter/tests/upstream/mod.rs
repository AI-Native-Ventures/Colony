//! An in-process fake provider that records exactly what it received.
//!
//! Shared by the proxy integration tests. Every assertion about "the real key
//! reached upstream" or "upstream saw nothing" reads off these recordings.

#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::Router;

/// One request the fake upstream received, captured before it replied.
#[derive(Debug, Clone)]
pub struct RecordedRequest {
    /// HTTP method.
    pub method: String,
    /// Path the checkpoint forwarded to, e.g. `/v1/messages`.
    pub path: String,
    /// Raw query string, if any.
    pub query: Option<String>,
    /// Every header the checkpoint sent.
    pub headers: HeaderMap,
    /// Raw request body.
    pub body: Bytes,
}

impl RecordedRequest {
    /// Header value as a UTF-8 string.
    pub fn header(&self, name: &str) -> Option<String> {
        self.headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
    }

    /// True when `needle` appears in any header value. Used to prove a virtual
    /// key never leaves the machine.
    pub fn any_header_contains(&self, needle: &str) -> bool {
        self.headers.values().any(|value| {
            value
                .to_str()
                .map(|text| text.contains(needle))
                .unwrap_or(false)
        })
    }
}

/// What the fake upstream replies with.
#[derive(Debug, Clone)]
pub struct UpstreamReply {
    /// Status code to return.
    pub status: StatusCode,
    /// `content-type` header to return.
    pub content_type: &'static str,
    /// Body bytes to return, verbatim.
    pub body: Vec<u8>,
}

impl UpstreamReply {
    /// A 200 JSON reply.
    pub fn json(body: &str) -> Self {
        Self {
            status: StatusCode::OK,
            content_type: "application/json",
            body: body.as_bytes().to_vec(),
        }
    }

    /// A 200 server-sent-events reply.
    pub fn sse(body: &str) -> Self {
        Self {
            status: StatusCode::OK,
            content_type: "text/event-stream",
            body: body.as_bytes().to_vec(),
        }
    }

    /// A failure reply with an arbitrary status.
    pub fn error(status: StatusCode, body: &str) -> Self {
        Self {
            status,
            content_type: "application/json",
            body: body.as_bytes().to_vec(),
        }
    }
}

#[derive(Clone)]
struct UpstreamState {
    reply: Arc<UpstreamReply>,
    recorded: Arc<Mutex<Vec<RecordedRequest>>>,
}

/// A running fake provider.
pub struct FakeUpstream {
    /// Base URL to hand to [`buzz_meter::MeterConfig`].
    pub base_url: String,
    recorded: Arc<Mutex<Vec<RecordedRequest>>>,
}

impl FakeUpstream {
    /// Bind a fake provider on loopback that always answers with `reply`.
    pub async fn start(reply: UpstreamReply) -> Self {
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let state = UpstreamState {
            reply: Arc::new(reply),
            recorded: Arc::clone(&recorded),
        };
        let app = Router::new()
            .fallback(record_and_reply)
            .with_state(state)
            .layer(axum::extract::DefaultBodyLimit::max(16 * 1024 * 1024));

        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .expect("bind fake upstream");
        let port = listener.local_addr().expect("upstream addr").port();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        Self {
            base_url: format!("http://127.0.0.1:{port}"),
            recorded,
        }
    }

    /// Everything the fake provider has received so far.
    pub fn requests(&self) -> Vec<RecordedRequest> {
        self.recorded.lock().expect("recorded lock").clone()
    }

    /// How many requests the fake provider has received.
    pub fn request_count(&self) -> usize {
        self.recorded.lock().expect("recorded lock").len()
    }
}

async fn record_and_reply(State(state): State<UpstreamState>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, 16 * 1024 * 1024)
        .await
        .unwrap_or_default();

    state
        .recorded
        .lock()
        .expect("recorded lock")
        .push(RecordedRequest {
            method: parts.method.to_string(),
            path: parts.uri.path().to_string(),
            query: parts.uri.query().map(str::to_string),
            headers: parts.headers.clone(),
            body: bytes,
        });

    Response::builder()
        .status(state.reply.status)
        .header("content-type", state.reply.content_type)
        .header("request-id", "req_upstream_header_id")
        .body(Body::from(state.reply.body.clone()))
        .expect("build upstream reply")
}
