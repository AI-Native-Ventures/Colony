//! The single-relay boundary for an agent identity.
//!
//! An agent belongs to exactly one community, and that community is a relay.
//! [`RelayPin`] captures that relay once — at the moment an agent process
//! resolves its record's `relay_url` — and every later dial must prove it is
//! talking to the same one. Equivalent spellings of the same relay
//! (`wss://host/`, `WSS://HOST:443`) name the same community and are accepted;
//! any genuinely different relay is refused with [`WsClientError::ForeignRelay`]
//! rather than dialed.

use crate::error::WsClientError;

/// The pinned relay an agent identity is allowed to contact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayPin {
    canonical: String,
}

impl RelayPin {
    /// Pin the relay given in canonical form.
    ///
    /// Fails when the value is not a parseable URL; an unpinnable relay must
    /// stop the caller here rather than surface later as a dial to wherever a
    /// default points.
    pub fn new(url: &str) -> Result<Self, WsClientError> {
        let parsed = url
            .trim()
            .parse::<url::Url>()
            .map_err(|e| WsClientError::Url(e.to_string()))?;
        Ok(Self {
            canonical: canonicalize(&parsed),
        })
    }

    /// The canonical URL of the pinned relay.
    pub fn url(&self) -> &str {
        &self.canonical
    }

    /// Refuse any relay other than the pinned one.
    ///
    /// This is the client-side half of the identity boundary: an agent process
    /// may not publish, subscribe, or authenticate anywhere its own record does
    /// not live. Errors carry both sides so logs show what was asked versus
    /// what was pinned.
    pub fn ensure_allows(&self, requested: &str) -> Result<(), WsClientError> {
        let parsed = requested
            .trim()
            .parse::<url::Url>()
            .map_err(|e| WsClientError::Url(e.to_string()))?;
        let canonical = canonicalize(&parsed);
        if canonical == self.canonical {
            Ok(())
        } else {
            Err(WsClientError::ForeignRelay {
                pinned: self.canonical.clone(),
                requested: canonical,
            })
        }
    }
}

/// Reduce equivalent spellings of one relay to one string.
///
/// Lowercases scheme and host, drops default ports (`url::Url` already hides
/// them), and strips trailing slashes from the path so `/` and empty compare
/// equal. A path other than root is preserved: some relays serve under a
/// sub-path and that is part of their identity.
fn canonicalize(url: &url::Url) -> String {
    let mut out = format!(
        "{}://{}",
        url.scheme().to_ascii_lowercase(),
        url.host_str().unwrap_or_default().to_ascii_lowercase()
    );
    if let Some(port) = url.port() {
        out.push(':');
        out.push_str(&port.to_string());
    }
    let path = url.path().trim_end_matches('/');
    out.push_str(path);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins_the_exact_relay_it_was_given() {
        let pin = RelayPin::new("wss://colony.example.com").expect("pinnable");
        assert_eq!(pin.url(), "wss://colony.example.com");
        pin.ensure_allows("wss://colony.example.com")
            .expect("same relay allowed");
    }

    #[test]
    fn equivalent_spellings_of_one_relay_are_allowed() {
        let pin = RelayPin::new("wss://colony.example.com").expect("pinnable");
        // Default port hidden, trailing slash, uppercase host, whitespace.
        pin.ensure_allows("wss://colony.example.com/")
            .expect("trailing slash");
        pin.ensure_allows("WSS://COLONY.EXAMPLE.COM").expect("case");
        pin.ensure_allows(" wss://colony.example.com ")
            .expect("whitespace");
    }

    #[test]
    fn a_different_relay_is_refused_with_both_sides_named() {
        let pin = RelayPin::new("wss://colony.example.com").expect("pinnable");
        let err = pin
            .ensure_allows("wss://horizon.example.com")
            .expect_err("foreign relay must be refused");
        match err {
            WsClientError::ForeignRelay { pinned, requested } => {
                assert_eq!(pinned, "wss://colony.example.com");
                assert_eq!(requested, "wss://horizon.example.com");
            }
            other => panic!("expected ForeignRelay, got {other:?}"),
        }
    }

    #[test]
    fn same_host_different_scheme_is_refused() {
        // An insecure downgrade of the pinned relay is still another endpoint.
        let pin = RelayPin::new("wss://colony.example.com").expect("pinnable");
        assert!(pin.ensure_allows("ws://colony.example.com").is_err());
    }

    #[test]
    fn same_host_different_port_is_refused() {
        let pin = RelayPin::new("ws://localhost:3000").expect("pinnable");
        assert!(pin.ensure_allows("ws://localhost:3001").is_err());
        pin.ensure_allows("ws://localhost:3000/")
            .expect("self allows");
    }

    #[test]
    fn a_sub_path_is_part_of_the_identity() {
        let pin = RelayPin::new("wss://relay.example.com/buzz").expect("pinnable");
        pin.ensure_allows("wss://relay.example.com/buzz/")
            .expect("same with slash");
        assert!(pin.ensure_allows("wss://relay.example.com").is_err());
    }

    #[test]
    fn an_unparseable_relay_cannot_be_pinned_or_requested() {
        assert!(RelayPin::new("not a url").is_err());
        let pin = RelayPin::new("wss://colony.example.com").expect("pinnable");
        assert!(pin.ensure_allows("::::").is_err());
    }
}
