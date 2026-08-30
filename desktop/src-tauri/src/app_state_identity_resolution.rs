//! Identity resolution over the [`IdentityKeyStore`] seam, split out of
//! `app_state.rs` to stay under the file-size ratchet. `use super::*` pulls
//! in everything this needs from `app_state` (the trait, the storage
//! constants, and the other private helpers it calls into).

use super::*;

/// Identity resolution over an [`IdentityKeyStore`] seam, with no legacy
/// service to check. Kept as the entry point most tests use; delegates to
/// [`resolve_identity_with_stores`] with `legacy_store: None`.
#[cfg(test)]
pub(crate) fn resolve_identity_with_store(
    store: &impl IdentityKeyStore,
    legacy_path: &std::path::Path,
    data_dir: &std::path::Path,
) -> Result<ResolvedIdentity, String> {
    resolve_identity_with_stores(
        store,
        None::<&crate::secret_store::SecretStore>,
        legacy_path,
        data_dir,
    )
}

/// Identity resolution over an [`IdentityKeyStore`] seam. Split from
/// [`super::load_or_create_identity`] so the probe/recover branches are
/// testable without the live OS keyring. `legacy_store`, when present, is
/// probed before a "fresh install" conclusion is reached — see
/// [`recover_legacy_or_generate`].
pub(super) fn resolve_identity_with_stores(
    store: &impl IdentityKeyStore,
    legacy_store: Option<&impl IdentityKeyStore>,
    legacy_path: &std::path::Path,
    data_dir: &std::path::Path,
) -> Result<ResolvedIdentity, String> {
    use crate::secret_store::KeyringProbe;

    match store.probe(IDENTITY_KEY_NAME) {
        KeyringProbe::Present => {
            if let Some(nsec) = store.load(IDENTITY_KEY_NAME)? {
                match Keys::parse(nsec.trim()) {
                    Ok(keyring_keys) => {
                        eprintln!(
                            "buzz-desktop: persisted identity pubkey {}",
                            keyring_keys.public_key().to_hex()
                        );
                        // Check for a leftover identity.key. If it holds a
                        // DIFFERENT pubkey, the user imported that key after
                        // the last boot (pre-fix, import only wrote the file).
                        // Adopt it into the keyring so the user's intent sticks.
                        // If the pubkeys match it is a stale leftover from a
                        // prior migration whose remove_file failed — clean it up.
                        if legacy_path.exists() {
                            match load_key_file(legacy_path) {
                                Ok(file_keys)
                                    if file_keys.public_key() != keyring_keys.public_key() =>
                                {
                                    eprintln!(
                                        "buzz-desktop: identity.key differs from keyring; \
                                         adopting imported key {}",
                                        file_keys.public_key().to_hex()
                                    );
                                    // Delegate the store→read-back-verify→marker→delete
                                    // sequence to `persist_identity_to_keyring`, which owns
                                    // the marker-before-delete invariant and the fallback
                                    // logic that keeps identity.key when the marker write
                                    // fails. A transient keyring failure must not abort
                                    // boot — the file key is safe and adoption retries next
                                    // boot when the keyring is reachable again.
                                    let storage = if let Err(e) = persist_identity_to_keyring(
                                        store,
                                        &file_keys,
                                        legacy_path,
                                        data_dir,
                                    ) {
                                        eprintln!(
                                            "buzz-desktop: keyring adoption of identity.key \
                                             failed ({e}); using file key, will retry next boot"
                                        );
                                        IdentityStorage::LocalFile
                                    } else {
                                        IdentityStorage::SystemKeyring
                                    };
                                    return Ok(ResolvedIdentity {
                                        keys: file_keys,
                                        recovery: RecoveryState::None,
                                        storage,
                                    });
                                }
                                // Corrupt file — keyring is authoritative. Log before
                                // cleanup so there is a diagnostic for the lost data.
                                Err(e) => {
                                    eprintln!(
                                        "buzz-desktop: leftover identity.key is corrupt ({e}); \
                                         keyring is authoritative, removing"
                                    );
                                    ensure_marker_then_cleanup(data_dir, legacy_path);
                                }
                                // Same pubkey (stale leftover from a completed migration
                                // whose remove_file previously failed) — keyring is
                                // authoritative. Ensure the marker exists (crash-safe
                                // ordering: marker before delete), then clean up.
                                Ok(_) => {
                                    ensure_marker_then_cleanup(data_dir, legacy_path);
                                }
                            }
                        }
                        // Self-heal: if the identity.key is gone and the migration
                        // marker is absent (e.g. a stranded keyring-only install from
                        // a pre-fix path that stored to the keyring but could not write
                        // the marker or fallback file), write the marker now so a later
                        // keyring-Unreachable boot does not treat this as a fresh install
                        // and silently rotate the identity. Failure is non-fatal — boot
                        // must never be blocked here.
                        if !legacy_path.exists() && !migration_marker_path(data_dir).exists() {
                            if let Err(e) = write_migration_marker(&migration_marker_path(data_dir))
                            {
                                eprintln!(
                                    "buzz-desktop: keyring present but marker missing; \
                                     self-heal marker write failed ({e}), continuing"
                                );
                            }
                        }
                        return Ok(ResolvedIdentity {
                            keys: keyring_keys,
                            recovery: RecoveryState::None,
                            storage: IdentityStorage::SystemKeyring,
                        });
                    }
                    // The corruption is in the KEYRING, not the file. Clear the
                    // bad keyring value and recover from the file (or generate
                    // fresh) — do NOT quarantine a valid leftover `identity.key`
                    // that holds the user's only good key.
                    Err(error) => {
                        return recover_from_keyring(
                            store,
                            legacy_store,
                            legacy_path,
                            data_dir,
                            &error.to_string(),
                        );
                    }
                }
            } else {
                // Probe said Present but load found nothing — treat as empty.
                // Falls through to generate_and_persist below.
            }
        }
        KeyringProbe::ReachableButEmpty => {
            // One-time migration: import the legacy plaintext file, read-back
            // verify, THEN delete it.
            if legacy_path.exists() {
                if let Some(keys) = migrate_identity_file(store, legacy_path, data_dir)? {
                    return Ok(ResolvedIdentity {
                        keys,
                        recovery: RecoveryState::None,
                        storage: IdentityStorage::SystemKeyring,
                    });
                }
            } else if migration_marker_path(data_dir).exists() {
                // Marker present, keyring empty, no file — the key was previously
                // durably stored in the keyring but is now gone (keyring cleared,
                // new login session, or the entry was externally deleted). There
                // is no plaintext fallback to recover from.
                //
                // Generate an ephemeral in-memory key so the app can boot, but
                // surface a "lost" flag so the frontend prompts re-import rather
                // than silently starting a fresh identity.
                let ephemeral = Keys::generate();
                eprintln!(
                    "buzz-desktop: identity lost — keyring was empty despite migration marker; \
                     using ephemeral key {}, awaiting user re-import",
                    ephemeral.public_key().to_hex()
                );
                return Ok(ResolvedIdentity {
                    keys: ephemeral,
                    recovery: RecoveryState::Lost,
                    storage: IdentityStorage::Ephemeral,
                });
            }
        }
        KeyringProbe::Unreachable => {
            // Keyring down this boot. If a recoverable file is present, use it
            // (and do NOT migrate — re-importing later could resurrect a
            // rotated key). With NO file, the marker disambiguates two states
            // that are otherwise byte-identical (Unreachable + no file):
            //   - marker present → the key was migrated into the keyring and the
            //     file deleted. The real key is unreachable this boot but still
            //     exists in the keyring. Boot keyring-locked recovery (ephemeral
            //     key, all signing disabled) so the app can at least open; the
            //     frontend shows a "unlock the keyring and relaunch" screen.
            //     Fail-closed semantics are preserved: nothing is ever persisted
            //     under the ephemeral key, so no silent identity rotation occurs.
            //   - no marker → genuine first-ever launch with nothing to protect.
            //     Generate to the `0o600` file (legitimate first-run).
            if !legacy_path.exists() && migration_marker_path(data_dir).exists() {
                let ephemeral = Keys::generate();
                eprintln!(
                    "buzz-desktop: keyring unreachable but migration marker present; \
                     booting keyring-locked recovery with ephemeral key {} — \
                     unlock the keyring and relaunch",
                    ephemeral.public_key().to_hex()
                );
                return Ok(ResolvedIdentity {
                    keys: ephemeral,
                    recovery: RecoveryState::KeyringLocked,
                    storage: IdentityStorage::Ephemeral,
                });
            }
            let keys = load_file_or_generate(legacy_path, data_dir)?;
            return Ok(ResolvedIdentity {
                keys,
                recovery: RecoveryState::None,
                storage: IdentityStorage::LocalFile,
            });
        }
    }

    recover_legacy_or_generate(store, legacy_store, legacy_path, data_dir)
}

/// Last-resort branch before minting a brand-new identity: the current
/// (scoped) service looks empty/unrecoverable, but that must not by itself
/// mean "fresh install" — a channel-scoped build (Canary) can be booting for
/// the first time since its service was renamed away from the historical
/// `"buzz-desktop"`, with the real identity still sitting there. Skipping
/// this check is exactly what caused the 2026-08-30 incident: PR #478 baked
/// a new service name, the marker name derived from it changed too, so the
/// next boot saw neither a key nor a marker under the new name and silently
/// minted a fresh identity — dropping the user out of their community.
///
/// Order of checks:
/// 1. `legacy_store` (`Some` only for a channel-scoped release build) holds a
///    parseable key → copy it into the scoped service via
///    [`persist_imported_identity_impl`] (keyring, falling back to the
///    `0o600` file) so this channel now owns its own durable copy, and use
///    it. The legacy entry is left untouched — another channel install may
///    still depend on it.
/// 2. No recoverable legacy key, but a migration marker — this service's own
///    (`migration_marker_path`) or the legacy unscoped one
///    (`MIGRATION_MARKER_NAME`) — proves an identity existed at some point →
///    `Lost` recovery (ephemeral key, frontend prompts re-import) rather
///    than silently rotating identity.
/// 3. Neither → genuine first-ever launch, generate normally.
fn recover_legacy_or_generate(
    store: &impl IdentityKeyStore,
    legacy_store: Option<&impl IdentityKeyStore>,
    legacy_path: &std::path::Path,
    data_dir: &std::path::Path,
) -> Result<ResolvedIdentity, String> {
    use crate::secret_store::KeyringProbe;

    if let Some(legacy_store) = legacy_store {
        if matches!(legacy_store.probe(IDENTITY_KEY_NAME), KeyringProbe::Present) {
            match legacy_store.load(IDENTITY_KEY_NAME) {
                Ok(Some(nsec)) => match Keys::parse(nsec.trim()) {
                    Ok(legacy_keys) => {
                        eprintln!(
                            "buzz-desktop: recovered identity {} from the legacy keyring \
                             service; this channel now owns an independent copy",
                            legacy_keys.public_key().to_hex()
                        );
                        let storage = persist_imported_identity_impl(
                            store,
                            &legacy_keys,
                            legacy_path,
                            data_dir,
                        )?;
                        return Ok(ResolvedIdentity {
                            keys: legacy_keys,
                            recovery: RecoveryState::None,
                            storage,
                        });
                    }
                    Err(e) => eprintln!(
                        "buzz-desktop: legacy keyring holds an unparseable identity ({e}); \
                         treating it as unrecoverable"
                    ),
                },
                Ok(None) => {}
                Err(e) => eprintln!(
                    "buzz-desktop: legacy keyring probe said Present but load failed ({e}); \
                     treating it as unrecoverable this boot"
                ),
            }
        }
    }

    // No recoverable legacy key. A migration marker — this service's own, or
    // the legacy service's unscoped one — means an identity existed before;
    // never generate over that, even though neither keyring can produce it.
    let marker_exists = migration_marker_path(data_dir).exists()
        || (legacy_store.is_some() && data_dir.join(MIGRATION_MARKER_NAME).exists());
    if marker_exists {
        let ephemeral = Keys::generate();
        eprintln!(
            "buzz-desktop: identity lost — a migration marker shows a prior identity existed \
             but no key could be recovered from the scoped or legacy keyring; using ephemeral \
             key {}, awaiting user re-import",
            ephemeral.public_key().to_hex()
        );
        return Ok(ResolvedIdentity {
            keys: ephemeral,
            recovery: RecoveryState::Lost,
            storage: IdentityStorage::Ephemeral,
        });
    }

    let (keys, storage) = generate_and_persist(store, legacy_path, data_dir)?;
    Ok(ResolvedIdentity {
        keys,
        recovery: RecoveryState::None,
        storage,
    })
}

/// Recover from a corrupt nsec in the keyring (parse failed). Clear the bad
/// keyring value, then migrate a valid leftover `identity.key` if one exists.
/// Otherwise defer to [`recover_legacy_or_generate`]: recover from the legacy
/// service if one holds a good key, else `Lost` recovery if a marker proves a
/// prior identity existed, else generate fresh. The keyring delete is
/// best-effort: a delete failure logs and continues — it must never block
/// startup.
fn recover_from_keyring(
    store: &impl IdentityKeyStore,
    legacy_store: Option<&impl IdentityKeyStore>,
    legacy_path: &std::path::Path,
    data_dir: &std::path::Path,
    error: &str,
) -> Result<ResolvedIdentity, String> {
    eprintln!("buzz-desktop: corrupt nsec in keyring ({error}), clearing and recovering from file");
    if let Err(e) = store.delete(IDENTITY_KEY_NAME) {
        eprintln!("buzz-desktop: failed to clear corrupt keyring value: {e}");
    }
    if legacy_path.exists() {
        if let Some(keys) = migrate_identity_file(store, legacy_path, data_dir)? {
            return Ok(ResolvedIdentity {
                keys,
                recovery: RecoveryState::None,
                storage: IdentityStorage::SystemKeyring,
            });
        }
    }
    // No valid file to recover from. The corrupt-scoped-keyring case
    // otherwise faces the exact same "is this really a fresh install?"
    // question as the empty-keyring case, so it shares the same answer.
    recover_legacy_or_generate(store, legacy_store, legacy_path, data_dir)
}

#[cfg(test)]
#[path = "app_state_identity_resolution_tests.rs"]
mod tests;
