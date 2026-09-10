//! Bounded, DNS-pinned HTTPS fetch for website artifact bytes.
//!
//! Website actions carry artifact references, never raw bytes. This module is
//! the relay-side half of that contract: it resolves the host itself, rejects
//! any address core can prove is non-public, and pins the validated address
//! into the HTTP client so the connector cannot re-resolve the name to
//! something else between validation and connection (DNS rebinding).
//!
//! One wall-clock deadline covers DNS, every redirect hop, response headers,
//! and the body. Redirects are handled manually: every hop is re-resolved and
//! re-pinned, the hop must pass core's public-URL policy and stay on the
//! origin host, and the hop count is bounded. The body is read in chunks and
//! refused the moment it exceeds the manifest budget.

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use buzz_core::network::is_private_ip;
use buzz_core::website::validate_public_url;
use url::Url;

/// Maximum artifact bytes accepted from the network.
const MAX_FETCH_BYTES: usize = buzz_core::website::MAX_MANIFEST_BYTES;

/// Maximum redirect hops followed before refusing.
const MAX_REDIRECTS: usize = 3;

/// Total wall-clock budget for one artifact fetch (DNS, hops, headers, body).
const FETCH_DEADLINE: Duration = Duration::from_secs(30);

/// TCP connect budget for one hop.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// One hop's response-header and body-read budget.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// Fetch one public HTTPS artifact under a single wall-clock deadline.
pub(crate) async fn fetch_bounded_bytes(url: &str) -> Result<Vec<u8>, String> {
    tokio::time::timeout(FETCH_DEADLINE, fetch_inner(url))
        .await
        .map_err(|_| "artifact fetch exceeded its deadline".to_owned())?
}

async fn fetch_inner(url: &str) -> Result<Vec<u8>, String> {
    let original = Url::parse(url).map_err(|_| "artifact URL is not absolute".to_owned())?;
    validate_public_url(original.as_str())
        .map_err(|error| format!("artifact URL is not publicly routable: {}", error.code()))?;
    let origin_host = original
        .host_str()
        .ok_or_else(|| "artifact URL has no host".to_owned())?
        .to_ascii_lowercase();

    let mut current = original;
    for _hop in 0..=MAX_REDIRECTS {
        let response = fetch_once(&current).await?;
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
            validate_hop(&origin_host, &next)?;
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

/// Validate one redirect target: core public-URL policy, HTTPS, same origin.
fn validate_hop(origin_host: &str, next: &Url) -> Result<(), String> {
    if next.scheme() != "https" {
        return Err("redirect target must use https".to_owned());
    }
    if next
        .host_str()
        .map(|host| host.to_ascii_lowercase())
        .as_deref()
        != Some(origin_host)
    {
        return Err("artifact redirect must stay on the origin host".to_owned());
    }
    // Core policy rejects userinfo, fragments, and hosts it can prove are not
    // publicly routable, including private IPv6 literals in brackets.
    validate_public_url(next.as_str())
        .map_err(|error| format!("artifact redirect is not publicly routable: {}", error.code()))
}

async fn fetch_once(url: &Url) -> Result<reqwest::Response, String> {
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
        .timeout(REQUEST_TIMEOUT)
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
    let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| format!("artifact DNS lookup failed: {error}"))?
        .collect();
    let address = addresses
        .first()
        .ok_or_else(|| "artifact host resolved to no addresses".to_owned())?;
    if addresses
        .iter()
        .any(|address| is_private_ip(&address.ip()))
    {
        return Err("artifact host resolved to a non-public address".to_owned());
    }
    Ok(address.ip())
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

/// Remaining time before a deadline, or `None` when it has passed.
///
/// Extracted so the deadline arithmetic is unit-testable without a network.
#[cfg(test)]
fn remaining_before(
    deadline: tokio::time::Instant,
    now: tokio::time::Instant,
) -> Option<Duration> {
    deadline.checked_duration_since(now)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hop(origin: &str, target: &str) -> Result<(), String> {
        validate_hop(origin, &Url::parse(target).expect("test URL parses"))
    }

    #[test]
    fn redirect_hop_accepts_same_origin_https() {
        assert!(hop("cdn.colony.test", "https://cdn.colony.test/next.json").is_ok());
        assert!(hop("cdn.colony.test", "https://cdn.colony.test:8443/next.json").is_ok());
    }

    #[test]
    fn redirect_hop_rejects_cross_origin_and_insecure_targets() {
        assert!(hop("cdn.colony.test", "https://evil.example/next.json").is_err());
        assert!(hop("cdn.colony.test", "http://cdn.colony.test/next.json").is_err());
    }

    #[test]
    fn redirect_hop_rejects_userinfo_and_fragments() {
        assert!(hop("cdn.colony.test", "https://user:pass@cdn.colony.test/x").is_err());
        assert!(hop("cdn.colony.test", "https://cdn.colony.test/x#frag").is_err());
    }

    #[test]
    fn redirect_hop_rejects_private_ipv6_literals() {
        assert!(hop("[::1]", "https://[::1]/x").is_err());
        assert!(hop("[fd00::1]", "https://[fd00::1]/x").is_err());
    }

    #[test]
    fn deadline_arithmetic_reports_expiry() {
        let now = tokio::time::Instant::now();
        assert!(remaining_before(now + Duration::from_secs(5), now).is_some());
        assert!(remaining_before(now, now + Duration::from_secs(1)).is_none());
    }
}
