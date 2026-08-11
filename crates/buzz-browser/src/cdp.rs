//! Minimal CDP WebSocket client.

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::VecDeque;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use crate::contracts::BrowserError;

type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

/// Minimal CDP client: one command at a time, events buffered (bounded).
pub struct CdpClient {
    ws: Ws,
    next_id: u64,
    events: VecDeque<Value>,
}

impl CdpClient {
    pub async fn connect(ws_url: &str) -> Result<Self, BrowserError> {
        let (ws, _) = connect_async(ws_url)
            .await
            .map_err(|e| BrowserError::Cdp(e.to_string()))?;
        Ok(Self {
            ws,
            next_id: 1,
            events: VecDeque::new(),
        })
    }

    pub async fn send_command(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<Value, BrowserError> {
        let id = self.next_id;
        self.next_id += 1;
        let msg = serde_json::json!({ "id": id, "method": method, "params": params });
        self.ws
            .send(Message::Text(msg.to_string().into()))
            .await
            .map_err(|e| BrowserError::Cdp(e.to_string()))?;
        loop {
            let msg = self
                .ws
                .next()
                .await
                .ok_or_else(|| BrowserError::Cdp("websocket closed".into()))?
                .map_err(|e| BrowserError::Cdp(e.to_string()))?;
            let text = msg
                .into_text()
                .map_err(|e| BrowserError::Cdp(e.to_string()))?;
            let v: Value = serde_json::from_str(&text)
                .map_err(|e| BrowserError::Cdp(format!("bad json: {e}")))?;
            if v["id"].as_u64() == Some(id) {
                if let Some(err) = v["error"].as_object() {
                    return Err(BrowserError::Cdp(format!("{err:?}")));
                }
                return Ok(v["result"].clone());
            }
            if self.events.len() < 100 {
                self.events.push_back(v);
            }
        }
    }

    /// Read the next CDP notification, preserving a bounded queue of events
    /// received while a command response was in flight.
    ///
    /// A screencast is a stream of `Page.screencastFrame` notifications. The
    /// command path above must continue to correlate responses by id, while a
    /// live surface needs to consume those notifications in order. Keeping
    /// both operations on this one websocket prevents a second browser/engine
    /// path from being introduced by the desktop shell.
    pub async fn next_event(&mut self) -> Result<Value, BrowserError> {
        loop {
            if let Some(event) = self.events.pop_front() {
                if event.get("method").is_some() {
                    return Ok(event);
                }
            }

            let msg = self
                .ws
                .next()
                .await
                .ok_or_else(|| BrowserError::Cdp("websocket closed".into()))?
                .map_err(|e| BrowserError::Cdp(e.to_string()))?;
            let text = msg
                .into_text()
                .map_err(|e| BrowserError::Cdp(e.to_string()))?;
            let event: Value = serde_json::from_str(&text)
                .map_err(|e| BrowserError::Cdp(format!("bad json: {e}")))?;
            if event.get("method").is_some() {
                return Ok(event);
            }
        }
    }

    pub async fn navigate(&mut self, url: &str) -> Result<(), BrowserError> {
        self.send_command("Page.navigate", serde_json::json!({ "url": url }))
            .await?;
        self.wait_until_ready().await?;
        Ok(())
    }

    /// Poll `document.readyState` until `complete` (bounded), so callers get a
    /// settled document before snapshotting or interacting.
    pub async fn wait_until_ready(&mut self) -> Result<(), BrowserError> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let ready = self
                .evaluate("document.readyState")
                .await
                .unwrap_or(Value::Null);
            if ready.as_str() == Some("complete") {
                return Ok(());
            }
            if tokio::time::Instant::now() > deadline {
                return Err(BrowserError::Cdp(
                    "page did not reach readyState complete".into(),
                ));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    pub async fn evaluate(&mut self, expression: &str) -> Result<Value, BrowserError> {
        let result = self
            .send_command(
                "Runtime.evaluate",
                serde_json::json!({
                    "expression": expression,
                    "returnByValue": true,
                    "awaitPromise": true,
                }),
            )
            .await?;
        if let Some(details) = result["exceptionDetails"].as_object() {
            return Err(BrowserError::Cdp(format!("evaluate threw: {details:?}")));
        }
        Ok(result["result"]["value"].clone())
    }

    pub async fn get_ax_tree(&mut self) -> Result<Value, BrowserError> {
        self.send_command("Accessibility.getFullAXTree", serde_json::json!({}))
            .await
    }

    /// Center of an element's content box, from `DOM.getBoxModel`.
    pub async fn get_box_center(
        &mut self,
        backend_node_id: i64,
    ) -> Result<Option<(f64, f64)>, BrowserError> {
        let result = self
            .send_command(
                "DOM.getBoxModel",
                serde_json::json!({ "backendNodeId": backend_node_id }),
            )
            .await?;
        let Some(content) = result["model"]["content"].as_array() else {
            return Ok(None);
        };
        let points: Vec<(f64, f64)> = content
            .chunks(2)
            .filter_map(|pair| Some((pair.first()?.as_f64()?, pair.get(1)?.as_f64()?)))
            .collect();
        if points.is_empty() {
            return Ok(None);
        }
        let cx = points.iter().map(|p| p.0).sum::<f64>() / points.len() as f64;
        let cy = points.iter().map(|p| p.1).sum::<f64>() / points.len() as f64;
        Ok(Some((cx, cy)))
    }

    pub async fn capture_screenshot(&mut self) -> Result<String, BrowserError> {
        let result = self
            .send_command(
                "Page.captureScreenshot",
                serde_json::json!({ "format": "png" }),
            )
            .await?;
        result["data"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| BrowserError::Cdp("no screenshot data".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn send_command_correlates_by_id() {
        // Fake CDP endpoint that answers every command with id + echo.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            loop {
                let msg = ws.next().await.unwrap().unwrap();
                let v: serde_json::Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();
                let reply = serde_json::json!({
                    "id": v["id"],
                    "result": { "echo": v["method"] }
                });
                ws.send(tokio_tungstenite::tungstenite::Message::Text(
                    reply.to_string().into(),
                ))
                .await
                .unwrap();
            }
        });
        let url = format!("ws://{addr}");
        let mut client = CdpClient::connect(&url).await.unwrap();
        let result = client
            .send_command("Page.navigate", serde_json::json!({ "url": "about:blank" }))
            .await
            .unwrap();
        assert_eq!(result["echo"], "Page.navigate");
        server.abort();
    }

    #[tokio::test]
    async fn next_event_returns_notifications_buffered_during_a_command() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            let msg = ws.next().await.unwrap().unwrap();
            let request: serde_json::Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();
            ws.send(tokio_tungstenite::tungstenite::Message::Text(
                serde_json::json!({
                    "method": "Page.screencastFrame",
                    "params": { "sessionId": 7, "data": "frame" }
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
            ws.send(tokio_tungstenite::tungstenite::Message::Text(
                serde_json::json!({
                    "id": request["id"],
                    "result": {}
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
        });

        let url = format!("ws://{addr}");
        let mut client = CdpClient::connect(&url).await.unwrap();
        client
            .send_command("Page.enable", serde_json::json!({}))
            .await
            .unwrap();
        let event = client.next_event().await.unwrap();
        assert_eq!(event["method"], "Page.screencastFrame");
        assert_eq!(event["params"]["sessionId"], 7);
        server.await.unwrap();
    }
}
