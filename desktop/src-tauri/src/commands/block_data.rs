use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    time::Duration,
};

use futures_util::StreamExt;
use reqwest::{header::LOCATION, redirect::Policy, StatusCode};
use sha2::{Digest, Sha256};
use tokio::net::lookup_host;
use url::Url;

const MAX_BLOCK_DATA_BYTES: u64 = 2 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Fetch content-addressed public JSON for a Block instance.
///
/// Every redirect hop is resolved and pinned independently. The request uses a
/// fresh client with no cookie jar and adds no authorization or Plugin headers.
#[tauri::command]
pub async fn fetch_block_data(
    url: String,
    mime: String,
    sha256: String,
    byte_size: u64,
) -> Result<Vec<u8>, String> {
    validate_declaration(&mime, &sha256, byte_size)?;
    let mut current =
        Url::parse(url.trim()).map_err(|error| format!("invalid Block data URL: {error}"))?;

    for redirect_count in 0..=MAX_REDIRECTS {
        let (host, addresses) = resolve_public_destination(&current).await?;
        let client = reqwest::Client::builder()
            .redirect(Policy::none())
            .no_proxy()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .pool_max_idle_per_host(0)
            .resolve_to_addrs(&host, &addresses)
            .build()
            .map_err(|error| format!("Block data client failed: {error}"))?;

        let response = client
            .get(current.clone())
            .send()
            .await
            .map_err(|error| format!("Block data request failed: {error}"))?;

        if response.status().is_redirection() {
            if redirect_count == MAX_REDIRECTS {
                return Err("Block data exceeded the redirect limit".to_owned());
            }
            let location = response
                .headers()
                .get(LOCATION)
                .ok_or_else(|| "Block data redirect has no Location header".to_owned())?
                .to_str()
                .map_err(|_| "Block data redirect Location is not UTF-8".to_owned())?;
            current = current
                .join(location)
                .map_err(|error| format!("invalid Block data redirect: {error}"))?;
            // The next loop resolves, rejects, and pins the redirect target
            // before any bytes are sent to it.
            continue;
        }

        if response.status() != StatusCode::OK {
            return Err(format!(
                "Block data request returned HTTP {}",
                response.status()
            ));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_BLOCK_DATA_BYTES || length != byte_size)
        {
            return Err("Block data Content-Length does not match its declaration".to_owned());
        }

        let mut body = Vec::with_capacity(usize::try_from(byte_size).unwrap_or(0));
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| format!("reading Block data failed: {error}"))?;
            let next_size = body
                .len()
                .checked_add(chunk.len())
                .ok_or_else(|| "Block data size overflow".to_owned())?;
            if next_size > MAX_BLOCK_DATA_BYTES as usize || next_size > byte_size as usize {
                return Err("Block data exceeds its declared size or 2 MiB limit".to_owned());
            }
            body.extend_from_slice(&chunk);
        }
        return verify_block_data_bytes(body, &sha256, byte_size);
    }

    Err("Block data exceeded the redirect limit".to_owned())
}

fn validate_declaration(mime: &str, sha256: &str, byte_size: u64) -> Result<(), String> {
    if mime != "application/json" {
        return Err("Block data MIME type must be application/json".to_owned());
    }
    if sha256.len() != 64
        || !sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("Block data hash must be lowercase SHA-256".to_owned());
    }
    if byte_size == 0 || byte_size > MAX_BLOCK_DATA_BYTES {
        return Err("Block data size must be between 1 byte and 2 MiB".to_owned());
    }
    Ok(())
}

fn verify_block_data_bytes(
    body: Vec<u8>,
    expected_sha256: &str,
    expected_size: u64,
) -> Result<Vec<u8>, String> {
    if body.len() as u64 != expected_size {
        return Err("Block data byte size does not match its declaration".to_owned());
    }
    let actual_sha256 = hex::encode(Sha256::digest(&body));
    if actual_sha256 != expected_sha256 {
        return Err("Block data SHA-256 does not match its declaration".to_owned());
    }
    std::str::from_utf8(&body).map_err(|_| "Block data is not valid UTF-8".to_owned())?;
    serde_json::from_slice::<serde_json::Value>(&body)
        .map_err(|_| "Block data is not valid JSON".to_owned())?;
    Ok(body)
}

async fn resolve_public_destination(url: &Url) -> Result<(String, Vec<SocketAddr>), String> {
    if url.scheme() != "https" {
        return Err("Block data URL must use HTTPS".to_owned());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Block data URL must not contain credentials".to_owned());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Block data URL has no host".to_owned())?
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if is_metadata_hostname(&host) {
        return Err("Block data metadata-service destinations are forbidden".to_owned());
    }
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "Block data URL has no usable port".to_owned())?;
    let mut addresses = lookup_host((host.as_str(), port))
        .await
        .map_err(|error| format!("Block data DNS lookup failed: {error}"))?
        .collect::<Vec<_>>();
    addresses.sort_unstable();
    addresses.dedup();
    if addresses.is_empty() {
        return Err("Block data DNS lookup returned no addresses".to_owned());
    }
    if addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err("Block data destination resolves to a forbidden network".to_owned());
    }
    Ok((host, addresses))
}

fn is_metadata_hostname(host: &str) -> bool {
    matches!(
        host,
        "metadata.google.internal"
            | "metadata.google"
            | "instance-data"
            | "instance-data.ec2.internal"
    )
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_ipv4(ip),
        IpAddr::V6(ip) => is_public_ipv6(ip),
    }
}

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, d] = ip.octets();
    if ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_broadcast()
    {
        return false;
    }

    // Shared, documentation, benchmarking, reserved, and metadata-service
    // ranges are not valid public fetch targets even when an OS resolver
    // returns them.
    !((a == 100 && (64..=127).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 240
        || [a, b, c, d] == [100, 100, 100, 200])
}

fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(ipv4) = ip.to_ipv4_mapped() {
        return is_public_ipv4(ipv4);
    }
    let segments = ip.segments();
    let unique_local = segments[0] & 0xfe00 == 0xfc00;
    let link_local = segments[0] & 0xffc0 == 0xfe80;
    let documentation = segments[0] == 0x2001 && segments[1] == 0x0db8;
    let six_to_four = segments[0] == 0x2002;
    let globally_routable_prefix = segments[0] & 0xe000 == 0x2000;

    globally_routable_prefix
        && !ip.is_unspecified()
        && !ip.is_loopback()
        && !ip.is_multicast()
        && !unique_local
        && !link_local
        && !documentation
        && !six_to_four
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    use sha2::{Digest, Sha256};

    use super::{
        is_metadata_hostname, is_public_ip, resolve_public_destination, validate_declaration,
        verify_block_data_bytes,
    };

    #[test]
    fn block_data_rejects_private_and_metadata_destinations() {
        for ip in [
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254)),
            IpAddr::V4(Ipv4Addr::new(224, 0, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(100, 100, 100, 200)),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
            IpAddr::V6("fe80::1".parse().expect("link-local IPv6")),
            IpAddr::V6("fc00::1".parse().expect("private IPv6")),
        ] {
            assert!(!is_public_ip(ip), "{ip} must be rejected");
        }
        assert!(is_metadata_hostname("metadata.google.internal"));
        assert!(is_public_ip(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
        assert!(is_public_ip(IpAddr::V6(
            "2606:4700:4700::1111".parse().expect("public IPv6")
        )));
    }

    #[test]
    fn block_data_declaration_is_closed_and_bounded() {
        let hash = "0".repeat(64);
        assert!(validate_declaration("application/json", &hash, 1).is_ok());
        assert!(validate_declaration("text/json", &hash, 1).is_err());
        assert!(validate_declaration("application/json", &"A".repeat(64), 1).is_err());
        assert!(validate_declaration("application/json", &hash, 0).is_err());
        assert!(validate_declaration("application/json", &hash, 2 * 1024 * 1024 + 1).is_err());
    }

    #[tokio::test]
    async fn block_data_rejects_unsafe_urls_before_connecting() {
        for raw_url in [
            "file:///etc/passwd",
            "http://example.com/data.json",
            "http://user:password@example.com/data.json",
            "http://127.0.0.1/data.json",
            "http://[::1]/data.json",
            "http://metadata.google.internal/latest/meta-data",
        ] {
            let url = url::Url::parse(raw_url).expect("test URL");
            assert!(
                resolve_public_destination(&url).await.is_err(),
                "{raw_url} must be rejected"
            );
        }
    }

    #[test]
    fn block_data_bytes_require_exact_hash_size_utf8_and_json() {
        let body = br#"{"ok":true}"#.to_vec();
        let hash = hex::encode(Sha256::digest(&body));
        assert_eq!(
            verify_block_data_bytes(body.clone(), &hash, body.len() as u64).expect("valid body"),
            body
        );
        assert!(verify_block_data_bytes(body.clone(), &"0".repeat(64), body.len() as u64).is_err());
        assert!(verify_block_data_bytes(body.clone(), &hash, body.len() as u64 + 1).is_err());

        let invalid_json = b"not-json".to_vec();
        let invalid_json_hash = hex::encode(Sha256::digest(&invalid_json));
        assert!(verify_block_data_bytes(
            invalid_json.clone(),
            &invalid_json_hash,
            invalid_json.len() as u64
        )
        .is_err());
    }
}
