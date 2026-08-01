//! Server-side request forgery defence for the company website scanner.
//!
//! The scanner fetches a URL the user typed, then follows links that the
//! *scanned site* controls. Both are attacker-influenced: a hostile site can
//! list internal addresses in its own sitemap or `<a href>` and try to make the
//! relay fetch them on its behalf. So every candidate URL — seed, discovered
//! link, and each individual redirect hop — is revalidated here before a socket
//! is opened.
//!
//! Two independent checks, because either alone is bypassable:
//!
//! 1. The URL's literal shape (scheme, credentials, hostname, IP literals in
//!    any of the notations `inet_aton` accepts).
//! 2. Every address the hostname actually resolves to. A public name whose DNS
//!    answer includes `127.0.0.1` is the classic bypass, and only a
//!    post-resolution check catches it.
//!
//! Resolution is done once and the resolved addresses are handed to the caller
//! to connect to directly, so a name cannot resolve to a safe address for the
//! check and a blocked one for the connection (DNS rebinding).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use url::{Host, Url};

/// Why a URL may not be fetched. Display-safe: never echoes response content.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum UrlRejection {
    /// Not a parseable absolute URL.
    #[error("not a valid absolute URL")]
    Unparseable,
    /// Scheme other than `https`.
    #[error("only https:// websites can be scanned, got `{0}:`")]
    Scheme(String),
    /// Embedded credentials.
    #[error("URLs with embedded credentials are not scanned")]
    Credentials,
    /// A fragment, which is never sent to the server and signals a copied link.
    #[error("URLs with a `#fragment` are not scanned")]
    Fragment,
    /// No hostname at all.
    #[error("URL has no hostname")]
    NoHost,
    /// A name reserved for local resolution.
    #[error("`{0}` is a local hostname")]
    LocalHostname(String),
    /// An address in a range that is not publicly routable.
    #[error("`{0}` resolves to a non-public address")]
    BlockedAddress(String),
    /// The hostname does not resolve.
    #[error("`{0}` could not be resolved")]
    Unresolvable(String),
    /// A redirect left the origin the scan was authorized for.
    #[error("redirect left the original site")]
    CrossOrigin,
}

/// Hostname suffixes reserved for local or private resolution.
///
/// `.local` is mDNS, `.internal`/`.intranet`/`.corp`/`.home`/`.lan` are common
/// split-horizon internal zones, and `.localhost` is reserved by RFC 6761.
const LOCAL_SUFFIXES: [&str; 8] = [
    "localhost",
    ".localhost",
    ".local",
    ".internal",
    ".intranet",
    ".corp",
    ".home",
    ".lan",
];

/// Whether an IPv4 address is outside the publicly routable space.
///
/// Written out rather than using unstable std helpers so the blocked set is
/// visible and reviewable.
fn is_blocked_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    ip.is_private()            // 10/8, 172.16/12, 192.168/16
        || ip.is_loopback()    // 127/8
        || ip.is_link_local()  // 169.254/16
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_unspecified() // 0.0.0.0
        || ip.is_multicast()
        || a == 0              // 0/8 "this network"
        || a >= 240            // 240/4 reserved, includes 255.255.255.255
        || (a == 100 && (64..128).contains(&b)) // 100.64/10 carrier-grade NAT
        || (a == 192 && b == 0)                 // 192.0.0/24 IETF protocol
        || (a == 198 && (18..20).contains(&b)) // 198.18/15 benchmarking
}

/// Whether an IPv6 address is outside the publicly routable space.
fn is_blocked_v6(ip: Ipv6Addr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() {
        return true;
    }
    let segments = ip.segments();
    // fc00::/7 unique local, fe80::/10 link-local.
    if (segments[0] & 0xfe00) == 0xfc00 || (segments[0] & 0xffc0) == 0xfe80 {
        return true;
    }
    // 2001:db8::/32 documentation.
    if segments[0] == 0x2001 && segments[1] == 0x0db8 {
        return true;
    }
    // An IPv4-mapped or IPv4-compatible address is only as safe as the IPv4
    // address inside it — ::ffff:127.0.0.1 must not slip through.
    match ip.to_ipv4_mapped().or_else(|| ip.to_ipv4()) {
        Some(v4) => is_blocked_v4(v4),
        None => false,
    }
}

/// Whether an address may be connected to.
pub fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_v4(v4),
        IpAddr::V6(v6) => is_blocked_v6(v6),
    }
}

/// A URL that passed literal-shape validation and is ready for resolution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckedUrl {
    /// The normalized absolute URL.
    pub url: Url,
    /// Lowercase hostname.
    pub host: String,
    /// Effective port (443 unless explicitly given).
    pub port: u16,
}

impl CheckedUrl {
    /// Scheme, host and port — the tuple a same-origin check compares.
    pub fn origin_key(&self) -> (String, u16) {
        (self.host.clone(), self.port)
    }
}

/// Validate a URL's literal shape, before any DNS or network activity.
///
/// Rejects on shape alone. Passing this is necessary but NOT sufficient — the
/// caller must still resolve and check every address via [`resolve_public`].
pub fn check_url_shape(raw: &str) -> Result<CheckedUrl, UrlRejection> {
    let url = Url::parse(raw.trim()).map_err(|_| UrlRejection::Unparseable)?;

    if url.scheme() != "https" {
        return Err(UrlRejection::Scheme(url.scheme().to_owned()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(UrlRejection::Credentials);
    }
    if url.fragment().is_some() {
        return Err(UrlRejection::Fragment);
    }

    let host = url.host().ok_or(UrlRejection::NoHost)?;
    match host {
        // `url` normalizes every IPv4 notation — decimal, octal and hex — into
        // an Ipv4Addr, so the disguises collapse to one check here.
        Host::Ipv4(ip) => {
            if is_blocked_v4(ip) {
                return Err(UrlRejection::BlockedAddress(ip.to_string()));
            }
        }
        Host::Ipv6(ip) => {
            if is_blocked_v6(ip) {
                return Err(UrlRejection::BlockedAddress(ip.to_string()));
            }
        }
        Host::Domain(name) => {
            let lowered = name.to_ascii_lowercase();
            let trimmed = lowered.strip_suffix('.').unwrap_or(&lowered);
            if trimmed.is_empty() {
                return Err(UrlRejection::NoHost);
            }
            if LOCAL_SUFFIXES.iter().any(|suffix| {
                trimmed == suffix.trim_start_matches('.') || trimmed.ends_with(suffix)
            }) {
                return Err(UrlRejection::LocalHostname(trimmed.to_owned()));
            }
            // A bare label with no dot is an intranet name, not a public site.
            if !trimmed.contains('.') {
                return Err(UrlRejection::LocalHostname(trimmed.to_owned()));
            }
        }
    }

    let host_string = url
        .host_str()
        .ok_or(UrlRejection::NoHost)?
        .to_ascii_lowercase();
    let port = url.port_or_known_default().unwrap_or(443);
    Ok(CheckedUrl {
        url,
        host: host_string,
        port,
    })
}

/// Resolve a checked URL and return only publicly routable addresses.
///
/// Rejects the whole target if ANY resolved address is blocked, rather than
/// filtering to the allowed ones: a name answering with both a public and a
/// private address is a rebinding attempt, not a multi-homed site.
pub async fn resolve_public(checked: &CheckedUrl) -> Result<Vec<SocketAddr>, UrlRejection> {
    let addresses: Vec<SocketAddr> = tokio::net::lookup_host((checked.host.as_str(), checked.port))
        .await
        .map_err(|_| UrlRejection::Unresolvable(checked.host.clone()))?
        .collect();

    if addresses.is_empty() {
        return Err(UrlRejection::Unresolvable(checked.host.clone()));
    }
    for address in &addresses {
        if is_blocked_ip(address.ip()) {
            return Err(UrlRejection::BlockedAddress(address.ip().to_string()));
        }
    }
    Ok(addresses)
}

/// Validate a redirect target against the origin the scan was authorized for.
pub fn check_redirect(location: &str, from: &CheckedUrl) -> Result<CheckedUrl, UrlRejection> {
    // Resolve relative locations against the page that issued them.
    let absolute = from
        .url
        .join(location.trim())
        .map_err(|_| UrlRejection::Unparseable)?;
    let checked = check_url_shape(absolute.as_str())?;
    if checked.origin_key() != from.origin_key() {
        return Err(UrlRejection::CrossOrigin);
    }
    Ok(checked)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rejection(raw: &str) -> UrlRejection {
        check_url_shape(raw).expect_err(&format!("{raw} must be rejected"))
    }

    #[test]
    fn only_https_is_scannable() {
        assert!(check_url_shape("https://example.com/").is_ok());
        for raw in [
            "http://example.com/",
            "file:///etc/passwd",
            "ftp://example.com/",
            "ws://example.com/",
            "data:text/html,<h1>x</h1>",
            "gopher://example.com/",
        ] {
            assert!(
                matches!(
                    rejection(raw),
                    UrlRejection::Scheme(_) | UrlRejection::Unparseable
                ),
                "{raw} must not be fetchable"
            );
        }
    }

    #[test]
    fn credentials_and_fragments_are_refused() {
        assert_eq!(
            rejection("https://user:pass@example.com/"),
            UrlRejection::Credentials
        );
        assert_eq!(
            rejection("https://user@example.com/"),
            UrlRejection::Credentials
        );
        assert_eq!(
            rejection("https://example.com/#section"),
            UrlRejection::Fragment
        );
    }

    #[test]
    fn local_hostnames_are_refused() {
        for raw in [
            "https://localhost/",
            "https://LOCALHOST/",
            "https://foo.localhost/",
            "https://printer.local/",
            "https://vault.internal/",
            "https://wiki.corp/",
            "https://nas.home/",
            "https://box.lan/",
            "https://intranet/",
        ] {
            assert!(
                matches!(rejection(raw), UrlRejection::LocalHostname(_)),
                "{raw} must be treated as local"
            );
        }
    }

    /// The seed check must catch IP literals in every notation `inet_aton`
    /// accepts, not just dotted-quad — 2130706433 and 0x7f.1 are both 127.0.0.1.
    #[test]
    fn private_and_loopback_literals_are_refused_in_every_notation() {
        for raw in [
            "https://127.0.0.1/",
            "https://2130706433/",
            "https://0x7f000001/",
            "https://0177.0.0.1/",
            "https://10.0.0.5/",
            "https://172.16.4.1/",
            "https://192.168.1.1/",
            "https://169.254.169.254/",
            "https://0.0.0.0/",
            "https://100.64.0.1/",
            "https://198.18.0.1/",
            "https://255.255.255.255/",
            "https://[::1]/",
            "https://[::]/",
            "https://[fc00::1]/",
            "https://[fe80::1]/",
            "https://[::ffff:127.0.0.1]/",
            "https://[2001:db8::1]/",
        ] {
            assert!(
                matches!(rejection(raw), UrlRejection::BlockedAddress(_)),
                "{raw} must be blocked"
            );
        }
    }

    /// 169.254.169.254 is the cloud metadata endpoint — the single highest
    /// value SSRF target, reachable from most hosted environments.
    #[test]
    fn cloud_metadata_endpoint_is_blocked_by_address_check() {
        assert!(is_blocked_ip("169.254.169.254".parse().unwrap()));
        assert!(is_blocked_ip("fd00:ec2::254".parse().unwrap()));
    }

    #[test]
    fn public_addresses_are_permitted() {
        for ip in ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"] {
            assert!(
                !is_blocked_ip(ip.parse().unwrap()),
                "{ip} is publicly routable"
            );
        }
        assert!(check_url_shape("https://93.184.216.34/").is_ok());
    }

    #[test]
    fn a_trailing_dot_cannot_smuggle_a_local_name() {
        assert!(matches!(
            rejection("https://localhost./"),
            UrlRejection::LocalHostname(_)
        ));
    }

    #[test]
    fn redirects_must_stay_on_the_authorized_origin() {
        let from = check_url_shape("https://example.com/a").expect("seed");

        let same = check_redirect("/b", &from).expect("same-origin relative");
        assert_eq!(same.url.as_str(), "https://example.com/b");
        assert!(check_redirect("https://example.com/c", &from).is_ok());

        assert_eq!(
            check_redirect("https://evil.example/", &from).unwrap_err(),
            UrlRejection::CrossOrigin
        );
        // A subdomain is a different origin.
        assert_eq!(
            check_redirect("https://www.example.com/", &from).unwrap_err(),
            UrlRejection::CrossOrigin
        );
        // A port change is a different origin.
        assert_eq!(
            check_redirect("https://example.com:8443/", &from).unwrap_err(),
            UrlRejection::CrossOrigin
        );
    }

    /// A redirect is the classic bypass: the seed is public, the destination is
    /// not. Shape validation must run again on the hop, not only the seed.
    #[test]
    fn a_redirect_to_a_private_address_is_refused() {
        let from = check_url_shape("https://example.com/a").expect("seed");
        for location in [
            "https://127.0.0.1/",
            "https://169.254.169.254/latest/meta-data/",
            "http://example.com/plain",
            "file:///etc/passwd",
        ] {
            assert!(
                check_redirect(location, &from).is_err(),
                "redirect to {location} must be refused"
            );
        }
    }

    #[test]
    fn origin_key_ignores_path_and_default_port() {
        let bare = check_url_shape("https://example.com/one").expect("bare");
        let explicit = check_url_shape("https://example.com:443/two").expect("explicit port");
        assert_eq!(bare.origin_key(), explicit.origin_key());
    }
}
