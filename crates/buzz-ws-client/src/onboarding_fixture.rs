//! Explicit local transport for a separately built native-onboarding fixture.
//!
//! Canonical HTTPS/WSS URLs, Host headers, SNI and signed relay URLs stay intact.
//! Only socket destinations and trusted roots differ. No system DNS or trust is
//! changed. This module does not exist without the `onboarding-fixture` feature.
//!
//! HTTP builders are NOT a request allowlist: literal IPs bypass DNS. Call
//! [`FixtureTransport::destination`] for EVERY initial request URL, use a fresh
//! builder, and do not subsequently replace its transport settings. Redirects
//! are disabled. Worker callers must use the explicit gateway adapter so their
//! traffic still traverses the authenticated, host-owned isolation gateway.

use std::{
    collections::BTreeMap,
    io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::{Arc, OnceLock},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use rustls::{pki_types::CertificateDer, ClientConfig, RootCertStore};
use serde::Deserialize;
use tokio::net::TcpStream;
use tokio_tungstenite::{
    tungstenite::handshake::client::Response, Connector, MaybeTlsStream, WebSocketStream,
};

/// Process-owned fixture configuration. Contains public CA material, never keys.
pub const CONFIG_ENV: &str = "BUZZ_ONBOARDING_FIXTURE_TRANSPORT";
const MAX_CONFIG_BYTES: usize = 64 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
static PROCESS_CONFIG: OnceLock<Result<Arc<FixtureTransport>, FixtureError>> = OnceLock::new();

/// A fixture configuration or transport failure. No failure triggers real DNS.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum FixtureError {
    /// Explicit fixture mode has no usable process configuration.
    #[error("onboarding fixture configuration is missing")]
    MissingConfig,
    /// Configuration is malformed, unbounded, or points outside loopback.
    #[error("invalid onboarding fixture configuration: {0}")]
    InvalidConfig(&'static str),
    /// Requests must use an exact configured canonical HTTPS/WSS origin.
    #[error("URL is not an allowed onboarding fixture destination")]
    UnmappedDestination,
    /// Same rejection with a sanitized origin and path for fixture diagnostics.
    #[error("URL is not an allowed onboarding fixture destination: {0}")]
    UnmappedDestinationDetail(String),
    /// Worker transport must retain the existing authenticated loopback gateway.
    #[error("invalid onboarding fixture worker gateway")]
    InvalidGateway,
    /// The mapped socket or verified TLS/WebSocket handshake did not succeed.
    #[error("onboarding fixture connection failed: {0}")]
    Connection(String),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    version: u8,
    ca_der_base64: String,
    routes: Vec<Route>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Route {
    host: String,
    address: SocketAddr,
}

#[derive(Clone)]
struct FixtureResolver(BTreeMap<String, SocketAddr>);

impl Resolve for FixtureResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let address = self.0.get(name.as_str()).copied();
        Box::pin(async move {
            match address {
                Some(address) => Ok(Box::new(std::iter::once(address)) as Addrs),
                None => Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "name is not in the onboarding fixture",
                )
                .into()),
            }
        })
    }
}

/// Immutable, process-local roots and exact canonical-host connection mappings.
pub struct FixtureTransport {
    config_json: String,
    resolver: Arc<FixtureResolver>,
    tls: Arc<ClientConfig>,
}

impl FixtureTransport {
    /// Read required configuration once for this process, caching failures too.
    ///
    /// Call only when fixture transport is explicitly requested. Missing or
    /// malformed configuration is an error, never permission to dial normally.
    pub fn from_env() -> Result<Arc<Self>, FixtureError> {
        PROCESS_CONFIG
            .get_or_init(|| {
                let value = std::env::var(CONFIG_ENV).map_err(|_| FixtureError::MissingConfig)?;
                Self::from_json(&value).map(Arc::new)
            })
            .clone()
    }

    /// Validate a v1 configuration with one DER CA and 1–16 exact `.invalid` hosts.
    ///
    /// Example shape: `{"version":1,"ca_der_base64":"...","routes":[
    /// {"host":"business.run.invalid","address":"127.0.0.1:45678"}]}`.
    pub fn from_json(value: &str) -> Result<Self, FixtureError> {
        if value.is_empty() || value.len() > MAX_CONFIG_BYTES {
            return Err(FixtureError::InvalidConfig("size"));
        }
        let config: Config =
            serde_json::from_str(value).map_err(|_| FixtureError::InvalidConfig("schema"))?;
        if config.version != 1 || config.routes.is_empty() || config.routes.len() > 16 {
            return Err(FixtureError::InvalidConfig("version or route count"));
        }
        let mut routes = BTreeMap::new();
        for route in config.routes {
            if !canonical_fixture_host(&route.host)
                || !matches!(route.address.ip(), IpAddr::V4(ip) if ip == Ipv4Addr::LOCALHOST)
                    && !matches!(route.address.ip(), IpAddr::V6(ip) if ip == Ipv6Addr::LOCALHOST)
                || route.address.port() == 0
            {
                return Err(FixtureError::InvalidConfig("route"));
            }
            if routes.insert(route.host, route.address).is_some() {
                return Err(FixtureError::InvalidConfig("duplicate host"));
            }
        }
        let der = STANDARD
            .decode(config.ca_der_base64)
            .map_err(|_| FixtureError::InvalidConfig("CA encoding"))?;
        if der.is_empty() || der.len() > 8192 {
            return Err(FixtureError::InvalidConfig("CA size"));
        }
        let mut roots = RootCertStore::empty();
        roots
            .add(CertificateDer::from(der))
            .map_err(|_| FixtureError::InvalidConfig("CA certificate"))?;
        // Explicit provider avoids feature-unification dependence on the parent
        // binary's process-global provider. No verification bypass is installed.
        let tls =
            ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .map_err(|_| FixtureError::InvalidConfig("TLS provider"))?
                .with_root_certificates(roots)
                .with_no_client_auth();
        Ok(Self {
            config_json: value.to_string(),
            resolver: Arc::new(FixtureResolver(routes)),
            tls: Arc::new(tls),
        })
    }

    /// Validated public configuration to inject into fixture children after user env.
    pub fn config_json(&self) -> &str {
        &self.config_json
    }

    /// Validate each initial canonical URL and return its socket destination.
    ///
    /// Paths and queries are retained by callers; credentials, fragments,
    /// non-default ports, plaintext schemes and unlisted hosts are rejected.
    pub fn destination(&self, original_url: &str) -> Result<SocketAddr, FixtureError> {
        let url = url::Url::parse(original_url).map_err(|_| rejected_destination(original_url))?;
        if !matches!(url.scheme(), "https" | "wss")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || url.port().is_some()
        {
            return Err(rejected_destination(original_url));
        }
        url.host_str()
            .and_then(|host| self.resolver.0.get(host))
            .copied()
            .ok_or_else(|| rejected_destination(original_url))
    }

    /// Configure fresh HTTP clients for direct fixture sockets and fixture-only TLS.
    ///
    /// Call `destination` before every request; DNS cannot guard literal IPs.
    /// Discards ambient proxies, disables redirects, and installs a fixed
    /// Rustls configuration so previously added system/custom roots cannot leak.
    pub fn configure_http(&self, builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
        builder
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .tls_backend_preconfigured((*self.tls).clone())
            .dns_resolver(Arc::clone(&self.resolver))
    }

    /// Blocking counterpart of `configure_http`, with the same URL-validation contract.
    pub fn configure_blocking_http(
        &self,
        builder: reqwest::blocking::ClientBuilder,
    ) -> reqwest::blocking::ClientBuilder {
        builder
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .tls_backend_preconfigured((*self.tls).clone())
            .dns_resolver(Arc::clone(&self.resolver))
    }

    /// Configure a worker HTTP client without bypassing its authenticated gateway.
    ///
    /// The caller must validate initial URLs and the gateway must pin fixture
    /// destinations. Only this explicit proxy is used; ambient proxies are discarded.
    pub fn configure_gateway_http(
        &self,
        builder: reqwest::ClientBuilder,
        gateway: &str,
    ) -> Result<reqwest::ClientBuilder, FixtureError> {
        validate_gateway(gateway)?;
        let proxy = reqwest::Proxy::all(gateway).map_err(|_| FixtureError::InvalidGateway)?;
        Ok(self.configure_http(builder).proxy(proxy))
    }

    /// TLS connector for an already-mapped socket or authenticated worker tunnel.
    ///
    /// Pass the original WSS URL to `client_async_tls_with_config`; replacing it
    /// with the loopback address would lose hostname, Host and SNI verification.
    pub fn tls_connector(&self) -> Connector {
        Connector::Rustls(Arc::clone(&self.tls))
    }

    /// Dial a mapped socket and perform actual TLS/WSS against the canonical URL.
    ///
    /// Direct desktop/fixture clients only: workers must retain their gateway
    /// tunnel and use `tls_connector` on it instead. Errors never fall back.
    pub async fn connect_websocket(
        &self,
        original_url: &str,
    ) -> Result<(WebSocketStream<MaybeTlsStream<TcpStream>>, Response), FixtureError> {
        let address = self.destination(original_url)?;
        if !original_url.starts_with("wss://") {
            return Err(FixtureError::UnmappedDestination);
        }
        tokio::time::timeout(CONNECT_TIMEOUT, async {
            let stream = TcpStream::connect(address)
                .await
                .map_err(|error| FixtureError::Connection(error.to_string()))?;
            tokio_tungstenite::client_async_tls_with_config(
                original_url,
                stream,
                None,
                Some(self.tls_connector()),
            )
            .await
            .map_err(|error| FixtureError::Connection(error.to_string()))
        })
        .await
        .map_err(|_| FixtureError::Connection("timeout".into()))?
    }
}

/// Validate the current request before handing it to reqwest, including literal IPs.
/// This does not replace configuring the client with fixture-only TLS and no redirects.
pub fn validate_process_url(url: &str) -> Result<(), FixtureError> {
    FixtureTransport::from_env()?.destination(url).map(|_| ())
}

/// Configure the current process's HTTP client, retaining an explicit worker gateway.
/// Missing/invalid fixture configuration or gateway encoding never falls back.
pub fn configure_process_http(
    builder: reqwest::ClientBuilder,
) -> Result<reqwest::ClientBuilder, FixtureError> {
    let fixture = FixtureTransport::from_env()?;
    match std::env::var("BUZZ_WORKER_PROXY") {
        Ok(gateway) => fixture.configure_gateway_http(builder, &gateway),
        Err(std::env::VarError::NotPresent) => Ok(fixture.configure_http(builder)),
        Err(_) => Err(FixtureError::InvalidGateway),
    }
}

fn canonical_fixture_host(host: &str) -> bool {
    host.len() <= 253
        && host.ends_with(".invalid")
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
}

/// Emit enough information to diagnose a fixture allowlist miss without
/// copying credentials, query values, fragments or other URL data into logs.
fn rejected_destination(original_url: &str) -> FixtureError {
    let display = safe_origin_path(original_url).unwrap_or_else(|| "<unparseable>".to_owned());
    eprintln!("buzz onboarding fixture rejected destination origin+path={display}");
    FixtureError::UnmappedDestinationDetail(display)
}

fn safe_origin_path(original_url: &str) -> Option<String> {
    url::Url::parse(original_url).ok().and_then(|url| {
        let host = url.host_str()?;
        let host = if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]")
        } else {
            host.to_owned()
        };
        let port = url
            .port()
            .map(|port| format!(":{port}"))
            .unwrap_or_default();
        let path: String = url
            .path()
            .chars()
            .filter(|character| character.is_ascii_graphic())
            .take(256)
            .collect();
        Some(format!(
            "{}://{}{}{}",
            url.scheme(),
            host,
            port,
            if path.is_empty() { "/" } else { &path },
        ))
    })
}

fn validate_gateway(value: &str) -> Result<(), FixtureError> {
    let url = url::Url::parse(value).map_err(|_| FixtureError::InvalidGateway)?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none_or(|port| port == 0)
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || url.username() != "colony"
        || !url.password().is_some_and(|token| {
            token.len() == 32 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    {
        return Err(FixtureError::InvalidGateway);
    }
    Ok(())
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod diagnostic_tests {
    use super::safe_origin_path;

    #[test]
    fn destination_diagnostic_excludes_url_secrets() {
        assert_eq!(
            safe_origin_path(
                "https://fixture-user:fixture-token@public.example.invalid/gateway?token=secret#private"
            ),
            Some("https://public.example.invalid/gateway".to_owned())
        );
    }
}
