//! Recovery of managed-agent keys orphaned by PR #478's keyring-service
//! rename, split out of `storage.rs` to stay under the file-size ratchet.
//! `use super::*` pulls in everything this needs from `storage` (the
//! [`KeyStore`] trait, [`agent_keyring_name`], [`keyring_service`], and
//! [`SecretStore`]).
//!
//! PR #478 baked Canary's keychain service `buzz-desktop` -> `colony-canary-desktop`
//! with no migration. Managed-agent nsecs are stored under `agent:<pubkey>`
//! in the same rotated blob and service as the human identity (see
//! `agent_keyring_name`), so every agent key became unreachable under the
//! new service after the rotation — `hydrate_keys` logged "agent <pubkey>
//! has no key in JSON or keyring" and left the key blank, so an agent that
//! used to spawn fine could no longer start.
//!
//! This mirrors PR #526's decision for the human identity half of the same
//! rotation (`app_state_identity_resolution.rs` there, not yet merged): COPY
//! a recovered key from the legacy service into the current one, leave the
//! legacy entry untouched (another channel install may still depend on it),
//! and only recover when the current service does not already have the key —
//! never overwrite one it does.
//!
//! [`legacy_keyring_service`] duplicates the function PR #526 adds to
//! `app_state_keyring.rs` (same name, same logic). That PR is not merged
//! into this branch, and this module cannot depend on unmerged code, so the
//! small helper is duplicated here rather than shared. When #526 lands,
//! reconcile by calling the shared one and deleting this copy.

use super::*;

/// Legacy keyring service an existing agent key may still be sitting under
/// because it predates this build's channel scoping — `None` when the
/// current service already IS the historical default, so there is nothing to
/// recover from.
///
/// Duplicated from PR #526's (`fix/canary-identity-migration`) unmerged
/// `app_state_keyring::legacy_keyring_service` — see the module doc comment.
fn legacy_keyring_service() -> Option<&'static str> {
    if cfg!(debug_assertions) {
        return None;
    }
    match keyring_service() {
        "buzz-desktop" => None,
        _ => Some("buzz-desktop"),
    }
}

/// The legacy agent secret store for a channel-scoped release build (see
/// [`legacy_keyring_service`]) — `None` when there is no legacy service to
/// recover from. A fresh, non-singleton [`SecretStore`] instance (like
/// `migrate_agent_keys_to_dev_service`'s `prod_store`): read at most once per
/// unrecovered agent, and must not share the current service's singleton
/// cache/mutex.
pub(super) fn agent_legacy_secret_store() -> Option<SecretStore> {
    if !cfg!(feature = "system-keyring") {
        return None;
    }
    legacy_keyring_service().map(SecretStore::keyring)
}

/// Recover `pubkey`'s key from the legacy keyring service when the current
/// (channel-scoped) service has just confirmed it does not have it — the
/// managed-agent half of the same PR #478 rotation recovered for the human
/// identity in PR #526. Mirrors that PR's decision: COPY the key into the
/// current service and leave the legacy entry untouched, since another
/// channel install may still depend on it.
///
/// Per-agent and resilient: `None` covers "no legacy service", "legacy has no
/// key either", and "legacy read failed" alike — every case the caller must
/// treat identically to "genuinely no key" and keep going with the next
/// agent, never aborting the whole load. Idempotent: once the copy succeeds,
/// the next boot finds the key via `store.load()` directly and this function
/// is never reached again for that agent.
///
/// A copy that fails to persist (keyring write/verify error) still returns
/// the recovered key — the agent can spawn for this boot — and logs so the
/// next save's `persist_agent_keys` retries the write.
pub(super) fn recover_legacy_agent_key(
    store: &impl KeyStore,
    legacy_store: Option<&impl KeyStore>,
    pubkey: &str,
) -> Option<String> {
    let legacy_store = legacy_store?;
    let name = agent_keyring_name(pubkey);
    match legacy_store.load(&name) {
        Ok(Some(nsec)) => {
            if let Err(e) = store.write_and_verify(&name, &nsec) {
                eprintln!(
                    "buzz-desktop: recovered agent {pubkey} key from the legacy keyring \
                     service but could not copy it into the current service ({e}); \
                     using it for this boot, will retry the copy on the next save"
                );
            } else {
                eprintln!(
                    "buzz-desktop: recovered agent {pubkey} key from the legacy keyring \
                     service; this channel now owns an independent copy"
                );
            }
            Some(nsec)
        }
        Ok(None) => None,
        Err(e) => {
            eprintln!(
                "buzz-desktop: legacy keyring read for agent {pubkey} failed ({e}); \
                 treating it as unrecoverable this boot"
            );
            None
        }
    }
}

#[cfg(test)]
#[path = "storage_legacy_keys_tests.rs"]
mod tests;
