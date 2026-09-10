//! Bounded, DNS-pinned HTTPS fetch for website artifact bytes.
//!
//! Website actions carry artifact references, never raw bytes. This module is
//! the relay-side half of that contract: it resolves the host itself, rejects
//! any address core can prove is non-public, and pins the validated address
//! into the HTTP client so the connector cannot re-resolve the name to
//! something else between validation and connection (DNS rebinding).
//!
//! Redirects are handled manually: every hop is re-resolved and re-pinned, the
//! hop must stay on the origin host and use HTTPS, and the hop count and total
//! deadline are bounded. The response body is read in chunks and refused the
//! moment it exceeds the manifest budget, so a hostile host cannot spend the
//! relay's memory.

use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::time::Duration;

use buzz_core::network::is_private_ip;
use url::Url;

/// Maximum manifest bytes accepted from the network.
const MAX_FETCH_BYTES: usize = buzz_core::website::MAX_MANIFEST_BYTES;

/// Maximum redirect hops followed before refusing.
const MAX_REDIRECTS: usize = 3;

/// Total wall-clock budget for one artifact fetch.
const FETCH_DEADLINE: Duration = Duration::from_secs(30);

/// TCP connect budget for one hop.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Fetch one public HTTPS artifact with DNS pinning, redirect control, a byte
/// cap, and a deadline.
pub(crate) async fn fetch_bounded_bytes(url: &str) -> Result<Vec<u8>, String> {
    let original = Url::parse(url).map_err(|_| "artifact URL is not absolute".to_owned())?;
    if original.scheme() != "https" {
        return Err("artifact URL must use https".to_owned());
    }
    let origin_host = original
        .host_str()
        .ok_or_else(|| "artifact URL has no host".to_owned())?
        .to_ascii_lowercase();

    let deadline = tokio::time::Instant::now() + FETCH_DEADLINE;
    let mut current = original;
    for _hop in 0..=MAX_REDIRECTS {
        let remaining = deadline
            .checked_duration_since(tokio::time::Instant::now())
            .ok_or_else(|| "artifact fetch exceeded its deadline".to_owned())?;
        let response = fetch_once(&current, remaining).await?;
        let status = response.status();

        if status.is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "redirect response carried no location".to_owned())?
                .to_owned();
            let next = current
                .join(&location)
                .map_err(|_| "redirect location is not a valid URL".to_owned())?;
            if next.scheme() != "https" {
                return Err("redirect target must use https".to_owned());
            }
            if next
                .host_str()
                .map(|host| host.to_ascii_lowercase())
                .as_deref()
                != Some(origin_host.as_str())
            {
                return Err("artifact redirect must stay on the origin host".to_owned());
            }
            current = next;
            continue;
        }

        if !status.is_success() {
            return Err(format!("artifact fetch failed with HTTP {}", status.as_u16()));
        }
        return read_capped(response, MAX_FETCH_BYTES).await;
    }

    Err(format!("artifact fetch exceeded {MAX_REDIRECTS} redirects"))
}

async fn fetch_once(url: &Url, remaining: Duration) -> Result<reqwest::Response, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "artifact URL has no host".to_owned())?
        .to_owned();
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "artifact URL has no port".to_owned())?;
    let address = resolve_public(&host, port).await?;
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(remaining)
        // A system proxy would resolve the original hostname itself, bypassing
        // the validated and pinned address below.
        .no_proxy()
        // Redirects are followed manually so each hop is re-validated.
        .redirect(reqwest::redirect::Policy::none())
        .resolve(&host, SocketAddr::new(address, port))
        .build()
        .map_err(|error| format!("artifact fetch client failed: {error}"))?;
    client
        .get(url.clone())
        .send()
        .await
        .map_err(|error| format!("artifact fetch failed: {error}"))
}

async fn resolve_public(host: &str, port: u16) -> Result<IpAddr, String> {
    let target = format!("{host}:{port}");
    let addresses: Vec<IpAddr> = tokio::task::spawn_blocking(move || {
        target
            .to_socket_addrs()
            .map(|iter| iter.map(|address| address.ip()).collect::<Vec<_>>())
    })
    .await
    .map_err(|error| format!("artifact DNS lookup task failed: {error}"))?
    .map_err(|error| format!("artifact DNS lookup failed: {error}"))?;

    let address = addresses
        .first()
        .copied()
        .ok_or_else(|| "artifact host resolved to no addresses".to_owned())?;
    if addresses.iter().any(is_private_ip) {
        return Err("artifact host resolved to a non-public address".to_owned());
    }
    Ok(address)
}

async fn read_capped(mut response: reqwest::Response, cap: usize) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > cap as u64)
    {
        return Err(format!("artifact response exceeds {cap} bytes"));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("artifact response read failed: {error}"))?
    {
        if body.len().saturating_add(chunk.len()) > cap {
            return Err(format!("artifact response exceeds {cap} bytes"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
