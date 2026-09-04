//! `buzz invites`: mint an invite for a cofounder, and claim one with a fresh
//! key.
//!
//! Mirrors the desktop invite data layer (`desktop/src/shared/api/invites.ts`)
//! against the relay's invite surface (`crates/buzz-relay/src/api/invites.rs`),
//! so an agent can invite a person, or join a community it was invited to,
//! without anyone driving the app.
//!
//! Both `create` and `claim` are NIP-98 signed POSTs. The distinction that
//! matters is *which* key signs: `create` is signed by an owner or admin of
//! the community the relay URL points at, and `claim` is signed by the
//! joining key, which is exempt from the relay's membership gate precisely so
//! a stranger can redeem a code.
//!
//! Every subcommand prints the relay's JSON body verbatim. The only local
//! gate is [`parse_invite_input`], which turns a landing URL into the bare
//! code the claim endpoint wants and refuses a URL pointing at a relay this
//! client is not configured for - that mismatch would otherwise reach the
//! relay as an unrecognised code and read as an expired invite.

use crate::client::BuzzClient;
use crate::error::CliError;
use crate::InvitesCmd;

/// An invite input after parsing: the code, plus the relay authority the
/// input named, if it named one.
///
/// A bare code carries no authority: the caller's configured relay is the
/// only relay it could mean.
#[derive(Debug, PartialEq, Eq)]
pub struct ParsedInvite {
    /// The invite code to redeem, e.g. `v2.abc...`.
    pub code: String,
    /// Host (and port, when present) the input pointed at, lowercased.
    pub authority: Option<String>,
}

/// Host and port of `url`, lowercased, as `host` or `host:port`.
fn authority_of(url: &url::Url) -> Option<String> {
    let host = url.host_str()?.to_ascii_lowercase();
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    })
}

/// Parse an invite argument into a code plus the relay it named.
///
/// Accepts the same forms the desktop app does
/// (`desktop/src/shared/api/inviteHelpers.ts`), minus the ones a CLI cannot
/// act on:
///
/// - `https://<relay>/invite/<code>` and its `http://` twin: the landing URL
///   `invites create` prints.
/// - `buzz://join?relay=<ws url>&code=<code>`: the deep link the desktop app
///   registers.
/// - a bare code: no scheme and no slash.
///
/// Credentials and fragments are rejected rather than ignored, and a URL that
/// is not an invite landing URL is an error rather than a silently accepted
/// code, so a mistyped link fails locally instead of costing a signature and
/// a round trip.
///
/// The code segment is taken verbatim rather than percent-decoded: relay
/// codes are `v2.` plus base64url, so no character in one is ever encoded.
pub fn parse_invite_input(input: &str) -> Result<ParsedInvite, CliError> {
    let trimmed = input.trim();
    let invalid = || {
        CliError::Usage(format!(
            "invalid invite {trimmed:?}: expected an invite code or a landing \
             URL like https://relay.example/invite/<code>"
        ))
    };
    if trimmed.is_empty() {
        return Err(invalid());
    }

    if let Ok(url) = url::Url::parse(trimmed) {
        if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
            return Err(invalid());
        }
        match url.scheme() {
            "http" | "https" => {
                let code = url
                    .path_segments()
                    .and_then(|mut segments| match (segments.next(), segments.next()) {
                        // A single trailing slash yields a final empty
                        // segment, which is fine; anything after it is not a
                        // landing URL.
                        (Some("invite"), Some(code)) if !code.is_empty() => match segments.next() {
                            None | Some("") => Some(code.to_string()),
                            Some(_) => None,
                        },
                        _ => None,
                    })
                    .ok_or_else(invalid)?;
                return Ok(ParsedInvite {
                    code,
                    authority: authority_of(&url),
                });
            }
            "buzz" => {
                // Non-special schemes keep the authority in the host slot, so
                // `buzz://join?...` has host "join" and an empty path.
                if url.host_str() != Some("join") {
                    return Err(invalid());
                }
                let mut relay = None;
                let mut code = None;
                for (key, value) in url.query_pairs() {
                    match key.as_ref() {
                        "relay" => relay = Some(value.into_owned()),
                        "code" => code = Some(value.into_owned()),
                        _ => {}
                    }
                }
                let (relay, code) = match (relay, code) {
                    (Some(relay), Some(code)) if !code.is_empty() => (relay, code),
                    _ => return Err(invalid()),
                };
                let relay = url::Url::parse(&relay).map_err(|_| invalid())?;
                if !matches!(relay.scheme(), "ws" | "wss")
                    || !relay.username().is_empty()
                    || relay.password().is_some()
                    || relay.fragment().is_some()
                {
                    return Err(invalid());
                }
                return Ok(ParsedInvite {
                    code,
                    authority: authority_of(&relay),
                });
            }
            _ => return Err(invalid()),
        }
    }

    // Bare code: no scheme, no slash.
    if trimmed.contains("://") || trimmed.contains('/') {
        return Err(invalid());
    }
    Ok(ParsedInvite {
        code: trimmed.to_string(),
        authority: None,
    })
}

/// Resolve an invite argument against the relay this client is configured
/// for, returning the bare code.
///
/// A landing URL naming a different relay is refused here: posting its code
/// to the configured relay would come back as an unknown invite, which reads
/// as an expired or revoked code rather than as a misconfigured client.
pub fn code_for_relay(client: &BuzzClient, input: &str) -> Result<String, CliError> {
    let parsed = parse_invite_input(input)?;
    if let Some(authority) = parsed.authority {
        let configured = url::Url::parse(client.relay_url())
            .ok()
            .and_then(|url| authority_of(&url));
        if configured.as_deref() != Some(authority.as_str()) {
            return Err(CliError::Usage(format!(
                "invite is for relay {authority}, but this client is pointed at \
                 {}: set BUZZ_RELAY_URL to that relay and retry",
                configured.unwrap_or_else(|| client.relay_url().to_string())
            )));
        }
    }
    Ok(parsed.code)
}

/// Mint an invite code on this relay and print the relay's JSON, which
/// carries the shareable landing URL alongside the code.
///
/// The relay refuses this unless the signing key is an owner or admin of the
/// community the relay URL resolves to.
pub async fn cmd_create(
    client: &BuzzClient,
    ttl_secs: Option<u64>,
    max_uses: Option<i32>,
) -> Result<(), CliError> {
    let resp = client.mint_invite(ttl_secs, max_uses).await?;
    println!("{resp}");
    Ok(())
}

/// Claim an invite, signed by this client's key, and print the relay's JSON.
///
/// Accepts a bare code or a landing URL. On a relay with a configured join
/// policy the claim is refused with `join_policy_required` until a receipt
/// from `invites accept-policy` is passed here.
pub async fn cmd_claim(
    client: &BuzzClient,
    invite: &str,
    policy_receipt: Option<&str>,
) -> Result<(), CliError> {
    let code = code_for_relay(client, invite)?;
    let resp = client.claim_invite(&code, policy_receipt).await?;
    println!("{resp}");
    Ok(())
}

/// Exchange an explicit policy acceptance for the receipt `claim` needs, and
/// print the relay's JSON.
///
/// Only relays with a configured join policy expose this: one without answers
/// `404 join_policy_not_configured`, and on such a relay `claim` needs no
/// receipt at all. `buzz invites policy` prints the policy and its current
/// version.
pub async fn cmd_accept_policy(
    client: &BuzzClient,
    invite: &str,
    policy_version: &str,
    age_confirmed: bool,
) -> Result<(), CliError> {
    let code = code_for_relay(client, invite)?;
    let resp = client
        .accept_invite_policy(&code, policy_version, age_confirmed)
        .await?;
    println!("{resp}");
    Ok(())
}

/// Print this relay's join policy, including the `version` string
/// `accept-policy` has to echo back.
pub async fn cmd_policy(client: &BuzzClient) -> Result<(), CliError> {
    let resp = client.join_policy().await?;
    println!("{resp}");
    Ok(())
}

/// Route `buzz invites <sub>`.
pub async fn dispatch(cmd: InvitesCmd, client: &BuzzClient) -> Result<(), CliError> {
    match cmd {
        InvitesCmd::Create { ttl_secs, max_uses } => cmd_create(client, ttl_secs, max_uses).await,
        InvitesCmd::Claim {
            invite,
            policy_receipt,
        } => cmd_claim(client, &invite, policy_receipt.as_deref()).await,
        InvitesCmd::AcceptPolicy {
            invite,
            policy_version,
            age_confirmed,
        } => cmd_accept_policy(client, &invite, &policy_version, age_confirmed).await,
        InvitesCmd::Policy => cmd_policy(client).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(input: &str) -> ParsedInvite {
        match parse_invite_input(input) {
            Ok(parsed) => parsed,
            Err(e) => panic!("{input:?} should parse, got {e:?}"),
        }
    }

    #[test]
    fn accepts_a_bare_code() {
        let invite = parsed("v2.abcdef");
        assert_eq!(invite.code, "v2.abcdef");
        assert_eq!(invite.authority, None);
    }

    #[test]
    fn trims_surrounding_whitespace() {
        assert_eq!(parsed("  v2.abcdef\n").code, "v2.abcdef");
    }

    /// The landing URL the relay mints is `{scheme}://{host}/invite/{code}`
    /// (`crates/buzz-relay/src/api/invites.rs`), so pasting it back must
    /// yield exactly the code that went into it.
    #[test]
    fn accepts_the_landing_url_the_relay_mints() {
        let invite = parsed("https://acme.buzz.place/invite/v2.abcdef");
        assert_eq!(invite.code, "v2.abcdef");
        assert_eq!(invite.authority.as_deref(), Some("acme.buzz.place"));
    }

    #[test]
    fn keeps_the_port_and_lowercases_the_host() {
        let invite = parsed("http://LOCALHOST:3000/invite/v2.abcdef");
        assert_eq!(invite.authority.as_deref(), Some("localhost:3000"));
    }

    #[test]
    fn tolerates_a_single_trailing_slash() {
        assert_eq!(
            parsed("https://acme.buzz.place/invite/v2.abcdef/").code,
            "v2.abcdef"
        );
    }

    #[test]
    fn accepts_the_desktop_deep_link() {
        let invite = parsed("buzz://join?relay=wss%3A%2F%2Facme.buzz.place&code=v2.abcdef");
        assert_eq!(invite.code, "v2.abcdef");
        assert_eq!(invite.authority.as_deref(), Some("acme.buzz.place"));
    }

    #[test]
    fn rejects_non_invite_urls_and_malformed_input() {
        for input in [
            "",
            "   ",
            "https://acme.buzz.place/",
            "https://acme.buzz.place/invite",
            "https://acme.buzz.place/invite/",
            "https://acme.buzz.place/invite/v2.abc/extra",
            "https://user:pw@acme.buzz.place/invite/v2.abc",
            "https://acme.buzz.place/invite/v2.abc#frag",
            "wss://acme.buzz.place/invite/v2.abc",
            "buzz://other?relay=wss://acme.test&code=v2.abc",
            "buzz://join?code=v2.abc",
            "buzz://join?relay=wss://acme.test",
            "buzz://join?relay=https://acme.test&code=v2.abc",
            "some/path",
        ] {
            assert!(
                matches!(parse_invite_input(input), Err(CliError::Usage(_))),
                "{input:?} should be rejected"
            );
        }
    }

    fn client_for(relay_url: &str) -> BuzzClient {
        match BuzzClient::new(relay_url.to_string(), nostr::Keys::generate(), None, None) {
            Ok(client) => client,
            Err(e) => panic!("client construction failed: {e:?}"),
        }
    }

    #[test]
    fn a_bare_code_always_targets_the_configured_relay() {
        let client = client_for("https://acme.buzz.place");
        match code_for_relay(&client, "v2.abcdef") {
            Ok(code) => assert_eq!(code, "v2.abcdef"),
            Err(e) => panic!("expected the code through, got {e:?}"),
        }
    }

    #[test]
    fn a_matching_landing_url_resolves_to_its_code() {
        let client = client_for("https://acme.buzz.place");
        match code_for_relay(&client, "https://acme.buzz.place/invite/v2.abcdef") {
            Ok(code) => assert_eq!(code, "v2.abcdef"),
            Err(e) => panic!("expected the code through, got {e:?}"),
        }
    }

    /// A ws relay URL normalizes to http before it reaches the client, so a
    /// wss-configured client must still match its own https landing URL.
    #[test]
    fn a_ws_configured_relay_matches_its_https_landing_url() {
        let client = client_for(&crate::client::normalize_relay_url("wss://acme.buzz.place"));
        assert!(code_for_relay(&client, "https://acme.buzz.place/invite/v2.abc").is_ok());
    }

    /// Claiming a code minted by another relay would fail relay-side as an
    /// unknown invite, which reads as "expired" rather than "wrong relay".
    #[test]
    fn a_landing_url_for_another_relay_is_refused_locally() {
        let client = client_for("https://acme.buzz.place");
        match code_for_relay(&client, "https://other.buzz.place/invite/v2.abcdef") {
            Err(CliError::Usage(message)) => {
                assert!(
                    message.contains("other.buzz.place") && message.contains("BUZZ_RELAY_URL"),
                    "unhelpful message: {message}"
                );
            }
            other => panic!("expected a usage error, got {other:?}"),
        }
    }
}
