//! Host-owned per-worker egress gateway. Workers can reach only this listener;
//! this gateway pins and validates every permitted upstream destination.
use base64::Engine;
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinSet,
};

#[cfg(any(not(feature = "onboarding-fixture"), test))]
use std::net::IpAddr;
#[cfg(not(feature = "onboarding-fixture"))]
use std::net::ToSocketAddrs;

const HEADER_LIMIT: usize = 16 * 1024;
const CONNECTION_LIMIT: usize = 32;

#[derive(Clone, Debug)]
pub(crate) struct Destination {
    authority: String,
    addresses: Vec<SocketAddr>,
}

impl Destination {
    /// Resolve a host-authored relay/provider URL once, before launching the worker.
    /// Domain names may not resolve to private networks; explicit local endpoints
    /// remain supported for owner-configured local providers and test relays.
    pub(crate) fn resolve(value: &str) -> Result<Self, String> {
        let url = url::Url::parse(value).map_err(|_| "Invalid worker service URL")?;
        if !matches!(url.scheme(), "http" | "https" | "ws" | "wss")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(
                "Worker services require HTTP or WebSocket URLs without credentials".into(),
            );
        }
        #[cfg(feature = "onboarding-fixture")]
        {
            let address = buzz_ws_client::onboarding_fixture::FixtureTransport::from_env()
                .and_then(|fixture| fixture.destination(value))
                .map_err(|error| error.to_string())?;
            Ok(Self {
                authority: authority(&url)?,
                addresses: vec![address],
            })
        }
        #[cfg(not(feature = "onboarding-fixture"))]
        {
            let host = url.host_str().ok_or("Worker service has no host")?;
            let port = url
                .port_or_known_default()
                .ok_or("Worker service has no port")?;
            let addresses: Vec<_> = (host.trim_matches(['[', ']']), port)
                .to_socket_addrs()
                .map_err(|_| "Could not resolve worker service")?
                .collect();
            let explicit_local =
                host == "localhost" || host.trim_matches(['[', ']']).parse::<IpAddr>().is_ok();
            if addresses.is_empty()
                || (!explicit_local && addresses.iter().any(|address| private_ip(address.ip())))
            {
                return Err(
                    "Worker service domain resolved to a private or unavailable destination".into(),
                );
            }
            Ok(Self {
                authority: authority(&url)?,
                addresses,
            })
        }
    }

    /// The only plaintext fixture exception: the port just reserved by the host
    /// for this worker's meter. Never use this for user-authored service URLs.
    #[cfg(feature = "onboarding-fixture")]
    pub(super) fn reserved_meter(port: u16) -> Self {
        Self {
            authority: format!("127.0.0.1:{port}"),
            addresses: vec![SocketAddr::from(([127, 0, 0, 1], port))],
        }
    }
}

#[cfg(any(not(feature = "onboarding-fixture"), test))]
fn private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_broadcast()
                || ip.is_multicast()
                || ip.octets()[0] == 0
                || ip.octets()[0] >= 240
                || (ip.octets()[0] == 100 && ip.octets()[1] & 0xc0 == 0x40)
        }
        IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .map(|ip| private_ip(ip.into()))
            .unwrap_or_else(|| {
                ip.is_loopback()
                    || ip.is_unspecified()
                    || ip.is_multicast()
                    || ip.is_unique_local()
                    || ip.is_unicast_link_local()
            }),
    }
}

fn authority(url: &url::Url) -> Result<String, String> {
    Ok(format!(
        "{}:{}",
        url.host_str().ok_or("Missing host")?,
        url.port_or_known_default().ok_or("Missing port")?
    ))
}

/// Lifetime guard: dropping the last owner aborts the listener and all tunnels.
pub(crate) struct WorkerNetwork {
    port: u16,
    token: String,
    task: tauri::async_runtime::JoinHandle<()>,
}
impl std::fmt::Debug for WorkerNetwork {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkerNetwork")
            .field("port", &self.port)
            .finish_non_exhaustive()
    }
}
impl Drop for WorkerNetwork {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl WorkerNetwork {
    /// Create a unique local listener with an immutable upstream allowlist.
    pub(crate) fn start(destinations: Vec<Destination>) -> Result<Arc<Self>, String> {
        if destinations.is_empty() {
            return Err("Worker network requires configured services".into());
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let token = uuid::Uuid::new_v4().simple().to_string();
        let authorization = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!("colony:{token}"))
        );
        let task = tauri::async_runtime::spawn(async move {
            let Ok(listener) = TcpListener::from_std(listener) else {
                return;
            };
            let destinations = Arc::new(destinations);
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((socket, _)) = accepted else { break; };
                        if connections.len() >= CONNECTION_LIMIT { drop(socket); continue; }
                        let destinations = destinations.clone();
                        let authorization = authorization.clone();
                        connections.spawn(async move { let _ = proxy(socket, &destinations, &authorization).await; });
                    }
                    _ = connections.join_next(), if !connections.is_empty() => {}
                }
            }
        });
        Ok(Arc::new(Self { port, token, task }))
    }
    /// Port allowed by the worker's OS policy.
    pub(crate) fn port(&self) -> u16 {
        self.port
    }
    /// Standard HTTP proxy URL, also used for WebSocket CONNECT tunnelling.
    pub(crate) fn proxy_url(&self) -> String {
        format!("http://colony:{}@127.0.0.1:{}", self.token, self.port)
    }
}

async fn read_header(socket: &mut TcpStream) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    // Read through the terminator exactly; leave TLS or request-body bytes in
    // the socket for bidirectional forwarding after validating the destination.
    while !bytes.ends_with(b"\r\n\r\n") {
        if bytes.len() == HEADER_LIMIT {
            return Err(std::io::Error::other("Header too large"));
        }
        bytes.push(socket.read_u8().await?);
    }
    Ok(bytes)
}

fn route(
    header: &[u8],
    destinations: &[Destination],
) -> Option<(Vec<SocketAddr>, Option<Vec<u8>>)> {
    let text = std::str::from_utf8(header).ok()?;
    let mut lines = text.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, target, version) = (first.next()?, first.next()?, first.next()?);
    if first.next().is_some() || !matches!(version, "HTTP/1.0" | "HTTP/1.1") {
        return None;
    }
    let connect = method == "CONNECT";
    let url = url::Url::parse(&if connect {
        format!("http://{target}")
    } else {
        target.into()
    })
    .ok()?;
    if url.scheme() != "http"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || (connect && (url.path() != "/" || url.query().is_some()))
    {
        return None;
    }
    let authority = authority(&url).ok()?;
    let destination = destinations
        .iter()
        .find(|destination| destination.authority == authority)?;
    let mut forwarded = String::new();
    if !connect {
        let query = url.query().map(|q| format!("?{q}")).unwrap_or_default();
        forwarded = format!(
            "{method} {}{query} {version}\r\nHost: {authority}\r\n",
            url.path()
        );
    }
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let (name, _) = line.split_once(':')?;
        if name.is_empty()
            || !name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
            || line.bytes().any(|c| c < 32 && c != b'\t')
        {
            return None;
        }
        if !connect
            && ![
                "host",
                "proxy-authorization",
                "proxy-connection",
                "connection",
            ]
            .iter()
            .any(|skip| name.eq_ignore_ascii_case(skip))
        {
            forwarded.push_str(line);
            forwarded.push_str("\r\n");
        }
    }
    if !connect {
        forwarded.push_str("Connection: close\r\n\r\n");
    }
    Some((
        destination.addresses.clone(),
        (!connect).then(|| forwarded.into_bytes()),
    ))
}

async fn proxy(
    mut client: TcpStream,
    destinations: &[Destination],
    authorization: &str,
) -> std::io::Result<()> {
    let header = tokio::time::timeout(Duration::from_secs(10), read_header(&mut client)).await??;
    // A port can be reused after restart. Its old OS permission is not an
    // authentication credential for a new worker's gateway.
    let authorized = std::str::from_utf8(&header).ok().is_some_and(|text| {
        let values: Vec<_> = text
            .split("\r\n")
            .filter_map(|line| line.split_once(':'))
            .filter(|(name, _)| name.eq_ignore_ascii_case("proxy-authorization"))
            .collect();
        values.len() == 1 && values[0].1.trim() == authorization
    });
    if !authorized {
        client.write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await?;
        return Ok(());
    }
    let Some((addresses, request)) = route(&header, destinations) else {
        client
            .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await?;
        return Ok(());
    };
    let mut upstream = tokio::time::timeout(
        Duration::from_secs(10),
        TcpStream::connect(addresses.as_slice()),
    )
    .await??;
    match request {
        Some(request) => upstream.write_all(&request).await?,
        None => {
            client
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await?
        }
    }
    tokio::io::copy_bidirectional(&mut client, &mut upstream).await?;
    Ok(())
}

#[cfg(test)]
#[path = "network_tests.rs"]
mod tests;
