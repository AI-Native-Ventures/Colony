//! `buzz communities`: self-serve hosted community provisioning.
//!
//! Mirrors what the desktop app does in
//! `desktop/src-tauri/src/colony_provisioning.rs` against the relay's member
//! surface (`crates/buzz-relay/src/api/self_provisioning.rs`), so an agent can
//! mint a hosted community without a person driving the app. The relay is the
//! authority throughout: it decides whether it provisions at all, on which
//! domain, whether the signer is a member, and how many communities one owner
//! may hold. Nothing here can widen any of that.
//!
//! `config` and `check` are unauthenticated reads. `create` and `list` are
//! NIP-98 signed with the CLI's own key, which is also the key that ends up
//! owning anything created.
//!
//! Every subcommand prints the relay's JSON body verbatim. The one local gate
//! is the name rule in [`validate_community_name`], which exists so an obvious
//! typo fails before a signing round trip rather than after one.

use crate::client::BuzzClient;
use crate::error::CliError;
use crate::CommunitiesCmd;

/// Validate a community name against the rule the desktop create form uses,
/// `^[a-z0-9]+(?:-[a-z0-9]+)*$` (see
/// `desktop/src/features/communities/hostedCommunityApi.ts`): lowercase
/// letters and digits in runs joined by single hyphens, never leading,
/// trailing, or doubled.
///
/// This is a pre-flight check, not the authority. Length, reserved names, and
/// availability all stay relay-side, where they can actually be enforced; the
/// point of checking here is that `Acme Labs` should not cost a signature and
/// a round trip to learn it is not a slug.
pub fn validate_community_name(name: &str) -> Result<(), CliError> {
    let invalid = || {
        CliError::Usage(format!(
            "invalid community name {name:?}: use lowercase letters, numbers, \
             and single hyphens (e.g. acme-labs)"
        ))
    };

    if name.is_empty() {
        return Err(invalid());
    }
    if !name
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(invalid());
    }
    if name.starts_with('-') || name.ends_with('-') || name.contains("--") {
        return Err(invalid());
    }
    Ok(())
}

/// Print what this relay provisions: whether self-serve is on, the domain new
/// hosts are minted under, whether it is open to non-members, and the
/// per-owner cap.
pub async fn cmd_config(client: &BuzzClient) -> Result<(), CliError> {
    let resp = client.provisioning_config().await?;
    println!("{resp}");
    Ok(())
}

/// Check whether `name` is free on this relay.
///
/// The name is not validated locally: the relay answers a rejected name with
/// `available: false` and a `reason`, which is more useful to a caller probing
/// candidates than a client-side refusal.
pub async fn cmd_check(client: &BuzzClient, name: &str) -> Result<(), CliError> {
    let resp = client.community_availability(name).await?;
    println!("{resp}");
    Ok(())
}

/// Create `<name>.<provisioning domain>` owned by the CLI's key.
///
/// The relay refuses this unless the signer is already a member of the
/// community the request lands on (or the deployment runs in public mode), and
/// unless the signer is under the per-owner cap.
pub async fn cmd_create(client: &BuzzClient, name: &str) -> Result<(), CliError> {
    validate_community_name(name)?;
    let resp = client.create_community(name).await?;
    println!("{resp}");
    Ok(())
}

/// List the communities the CLI's key owns on this deployment.
pub async fn cmd_list(client: &BuzzClient) -> Result<(), CliError> {
    let resp = client.list_my_communities().await?;
    println!("{resp}");
    Ok(())
}

/// Route `buzz communities <sub>`.
pub async fn dispatch(cmd: CommunitiesCmd, client: &BuzzClient) -> Result<(), CliError> {
    match cmd {
        CommunitiesCmd::Config => cmd_config(client).await,
        CommunitiesCmd::Check { name } => cmd_check(client, &name).await,
        CommunitiesCmd::Create { name } => cmd_create(client, &name).await,
        CommunitiesCmd::List => cmd_list(client).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_single_run_and_hyphenated_names() {
        for name in [
            "acme",
            "acme-labs",
            "a",
            "a1",
            "0",
            "north-star-labs",
            "x-9",
        ] {
            assert!(
                validate_community_name(name).is_ok(),
                "{name:?} should be accepted"
            );
        }
    }

    #[test]
    fn rejects_uppercase_and_whitespace() {
        for name in ["Acme", "acme Labs", "acme labs", " acme", "acme "] {
            assert!(
                matches!(validate_community_name(name), Err(CliError::Usage(_))),
                "{name:?} should be rejected"
            );
        }
    }

    #[test]
    fn rejects_edge_and_doubled_hyphens() {
        for name in ["-acme", "acme-", "-", "--", "acme--labs", "a--"] {
            assert!(
                matches!(validate_community_name(name), Err(CliError::Usage(_))),
                "{name:?} should be rejected"
            );
        }
    }

    #[test]
    fn rejects_empty_and_punctuated_names() {
        for name in ["", "acme.labs", "acme_labs", "acme/labs", "acme!", "ácme"] {
            assert!(
                matches!(validate_community_name(name), Err(CliError::Usage(_))),
                "{name:?} should be rejected"
            );
        }
    }

    /// The local rule must accept and reject exactly what the desktop regex
    /// `^[a-z0-9]+(?:-[a-z0-9]+)*$` does - a client that refused a name the
    /// relay would mint (or waved through one it would not) would be worse
    /// than no pre-flight check at all.
    #[test]
    fn matches_the_desktop_regex_over_generated_names() {
        // Hand-rolled equivalent of the regex, deliberately written a
        // different way from the implementation so the two can disagree.
        fn regex_equivalent(name: &str) -> bool {
            !name.is_empty()
                && name.split('-').all(|segment| {
                    !segment.is_empty()
                        && segment
                            .chars()
                            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                })
        }

        // Four characters is the shortest width that can hold a doubled
        // hyphen with alphanumerics on both sides (`a--a`), which is the case
        // dropping the `--` check would slip through.
        let alphabet = ['a', '9', '-', 'A', '.', ' '];
        let mut checked = 0usize;
        for a in alphabet {
            for b in alphabet {
                for c in alphabet {
                    for d in alphabet {
                        for len in 1..=4 {
                            let name: String = [a, b, c, d][..len].iter().collect();
                            assert_eq!(
                                validate_community_name(&name).is_ok(),
                                regex_equivalent(&name),
                                "disagreed on {name:?}"
                            );
                            checked += 1;
                        }
                    }
                }
            }
        }
        assert!(checked > 5000, "expected a real sweep, checked {checked}");
    }
}
