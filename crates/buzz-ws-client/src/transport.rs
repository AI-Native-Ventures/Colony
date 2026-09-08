//! WebSocket transport through the host-owned worker gateway when configured.
//! The original URL remains the TLS and WebSocket identity; proxying never
//! rewrites the relay URL used by NIP-42 authentication.
use base64::Engine;
use std::{io, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};
use tokio_tungstenite::{
    tungstenite::{handshake::client::Response, Error},
    MaybeTlsStream, WebSocketStream,
};

type Connection = (WebSocketStream<MaybeTlsStream<TcpStream>>, Response);

/// Connect normally, or tunnel through the desktop's explicit worker gateway.
/// Invalid/unavailable gateways fail closed; there is no direct fallback.
pub async fn connect(url: &str) -> Result<Connection, Error> {
    let proxy = match std::env::var("BUZZ_WORKER_PROXY") {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(_) => return Err(denied("Invalid worker gateway encoding")),
    };
    connect_with_proxy(url, proxy.as_deref()).await
}

async fn connect_with_proxy(url: &str, proxy: Option<&str>) -> Result<Connection, Error> {
    #[cfg(feature = "onboarding-fixture")]
    let fixture = {
        let fixture = crate::onboarding_fixture::FixtureTransport::from_env()
            .map_err(|error| denied(&error.to_string()))?;
        fixture
            .destination(url)
            .map_err(|error| denied(&error.to_string()))?;
        fixture
    };
    let Some(proxy) = proxy else {
        #[cfg(feature = "onboarding-fixture")]
        return fixture
            .connect_websocket(url)
            .await
            .map_err(|error| denied(&error.to_string()));
        #[cfg(not(feature = "onboarding-fixture"))]
        return tokio_tungstenite::connect_async(url).await;
    };
    let proxy = url::Url::parse(proxy).map_err(|_| denied("Invalid worker gateway"))?;
    if proxy.scheme() != "http"
        || proxy.host_str() != Some("127.0.0.1")
        || proxy.port().is_none()
        || proxy.path() != "/"
        || proxy.query().is_some()
        || proxy.fragment().is_some()
        || proxy.username() != "colony"
        || !proxy
            .password()
            .is_some_and(|token| token.len() == 32 && token.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err(denied(
            "Worker gateway must be an explicit local HTTP listener",
        ));
    }
    let target = url::Url::parse(url).map_err(|_| denied("Invalid relay URL"))?;
    if !matches!(target.scheme(), "ws" | "wss") {
        return Err(denied("Relay requires WebSocket transport"));
    }
    let host = target
        .host_str()
        .ok_or_else(|| denied("Relay has no host"))?;
    let port = target
        .port_or_known_default()
        .ok_or_else(|| denied("Relay has no port"))?;
    let gateway_port = proxy
        .port()
        .ok_or_else(|| denied("Worker gateway has no port"))?;
    let authorization = base64::engine::general_purpose::STANDARD.encode(format!(
        "colony:{}",
        proxy
            .password()
            .ok_or_else(|| denied("Missing gateway credential"))?
    ));
    let tunnel = async {
        let mut stream = TcpStream::connect(("127.0.0.1", gateway_port)).await?;
        stream.write_all(format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\nProxy-Authorization: Basic {authorization}\r\n\r\n").as_bytes()).await?;
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            if header.len() == 8192 {
                return Err(denied("Worker gateway response too large"));
            }
            header.push(stream.read_u8().await?);
        }
        if !header.starts_with(b"HTTP/1.1 200 ") && !header.starts_with(b"HTTP/1.0 200 ") {
            return Err(denied("Worker gateway refused relay connection"));
        }
        Ok::<_, Error>(stream)
    };
    let stream = tokio::time::timeout(Duration::from_secs(10), tunnel)
        .await
        .map_err(|_| denied("Worker gateway connection timed out"))??;
    #[cfg(feature = "onboarding-fixture")]
    let connector = Some(fixture.tls_connector());
    #[cfg(not(feature = "onboarding-fixture"))]
    let connector = None;
    tokio_tungstenite::client_async_tls_with_config(url, stream, None, connector).await
}

fn denied(message: &str) -> Error {
    Error::Io(io::Error::new(io::ErrorKind::PermissionDenied, message))
}

// These tests prove the normal plaintext development transport. Fixture builds
// deliberately require configured TLS; that path has separate real-TLS tests.
#[cfg(all(test, not(feature = "onboarding-fixture")))]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::Message;

    #[tokio::test]
    async fn invalid_proxy_does_not_fall_back_to_a_reachable_relay() {
        let relay = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", relay.local_addr().unwrap());
        for proxy in [
            "",
            "https://127.0.0.1:123",
            "http://remote.example:123",
            "http://127.0.0.1:123/path",
        ] {
            assert!(connect_with_proxy(&url, Some(proxy)).await.is_err());
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(50), relay.accept())
                .await
                .is_err()
        );
    }

    // tungstenite fixes the handshake callback error type.
    #[allow(clippy::result_large_err)]
    #[tokio::test]
    async fn websocket_uses_connect_and_preserves_original_host_and_path() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy = format!(
            "http://colony:{}@{}",
            "a".repeat(32),
            listener.local_addr().unwrap()
        );
        let server = async {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                header.push(socket.read_u8().await.unwrap());
            }
            let header = String::from_utf8(header).unwrap();
            assert!(header
                .starts_with("CONNECT relay.invalid:80 HTTP/1.1\r\nHost: relay.invalid:80\r\n"));
            assert!(header.contains(&format!(
                "Proxy-Authorization: Basic {}",
                base64::engine::general_purpose::STANDARD
                    .encode(format!("colony:{}", "a".repeat(32)))
            )));
            socket
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await
                .unwrap();
            let mut ws = tokio_tungstenite::accept_hdr_async(
                socket,
                |request: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
                    assert_eq!(request.uri().path(), "/community");
                    assert_eq!(request.headers()["host"], "relay.invalid");
                    Ok(response)
                },
            )
            .await
            .unwrap();
            ws.send(Message::Text("gateway proof".into()))
                .await
                .unwrap();
            ws.close(None).await.unwrap();
        };
        let client = async {
            let (mut ws, _) = connect_with_proxy("ws://relay.invalid/community", Some(&proxy))
                .await
                .unwrap();
            assert_eq!(
                ws.next().await.unwrap().unwrap().into_text().unwrap(),
                "gateway proof"
            );
        };
        tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(server, client);
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn refused_tunnel_is_an_error_without_websocket_or_direct_retry() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy = format!(
            "http://colony:{}@{}",
            "a".repeat(32),
            listener.local_addr().unwrap()
        );
        let server = async {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                header.push(socket.read_u8().await.unwrap());
            }
            socket
                .write_all(b"HTTP/1.1 403 Forbidden\r\n\r\n")
                .await
                .unwrap();
            let mut byte = [0];
            assert_eq!(socket.read(&mut byte).await.unwrap(), 0);
        };
        let client = async {
            assert!(connect_with_proxy("ws://relay.invalid", Some(&proxy))
                .await
                .is_err());
        };
        tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(server, client);
        })
        .await
        .unwrap();
    }
}
