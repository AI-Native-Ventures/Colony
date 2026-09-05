//! `buzz identity` subcommands - mint and inspect the founder key.
//!
//! These run locally and need no relay connection. `init` writes into the same
//! OS keyring slot Buzz Desktop reads at boot, so a key minted here is adopted
//! by the app on its next launch and the agent and the app share one identity.
//! See [`crate::identity`] for the storage layout.

use crate::error::CliError;
use crate::identity::{self, BlobStore, KeyringBlobStore, ResolvedIdentity};

use nostr::Keys;

/// Run `buzz identity init`.
///
/// Generates a keypair, stores it (keyring first, `0o600` file if the keyring
/// is unavailable), and prints `{pubkey, npub, stored_in}`. Refuses to replace
/// an identity that is already stored unless `force` is set. The secret is
/// printed only when `show_secret` is set.
pub fn cmd_init(force: bool, show_secret: bool) -> Result<(), CliError> {
    if !force {
        if let Some(existing) = stored_identity()? {
            return Err(CliError::Usage(format!(
                "identity exists in {} (pubkey {}); pass --force to replace it",
                existing.source.as_str(),
                existing.keys.public_key().to_hex()
            )));
        }
    }

    let keys = Keys::generate();
    let nsec = identity::nsec_of(&keys)?;
    let stored_in = store_identity(&nsec)?;

    print_identity(&keys, "stored_in", &stored_in, show_secret, Some(&nsec))
}

/// Run `buzz identity show`.
///
/// Prints `{pubkey, npub, source}` for whatever `BUZZ_PRIVATE_KEY` or the
/// stored identity resolves to. The secret is printed only when `show_secret`
/// is set.
pub fn cmd_show(env_key: Option<&str>, show_secret: bool) -> Result<(), CliError> {
    let resolved = identity::resolve_identity(env_key)?.ok_or_else(|| {
        CliError::NotFound(
            "no identity: set BUZZ_PRIVATE_KEY or run `buzz identity init`".to_string(),
        )
    })?;
    let nsec = if show_secret {
        Some(identity::nsec_of(&resolved.keys)?)
    } else {
        None
    };
    print_identity(
        &resolved.keys,
        "source",
        resolved.source.as_str(),
        show_secret,
        nsec.as_deref(),
    )
}

/// Print the identity as a single JSON object on stdout.
///
/// `location_field` is `stored_in` for `init` and `source` for `show`, which
/// keeps each command's output shape exactly as documented.
fn print_identity(
    keys: &Keys,
    location_field: &str,
    location_value: &str,
    show_secret: bool,
    nsec: Option<&str>,
) -> Result<(), CliError> {
    let mut obj = serde_json::json!({
        "pubkey": keys.public_key().to_hex(),
        "npub": identity::npub_of(keys)?,
    });
    let map = obj
        .as_object_mut()
        .ok_or_else(|| CliError::Other("identity output is not an object".to_string()))?;
    map.insert(
        location_field.to_string(),
        serde_json::Value::String(location_value.to_string()),
    );
    if show_secret {
        let secret = match nsec {
            Some(value) => value.to_string(),
            None => identity::nsec_of(keys)?,
        };
        map.insert("nsec".to_string(), serde_json::Value::String(secret));
    }
    println!("{obj}");
    Ok(())
}

/// Resolve an already-stored identity, ignoring the environment.
///
/// `init` must not treat an exported `BUZZ_PRIVATE_KEY` as an existing stored
/// identity: the whole point of the command is to mint the key that gets
/// stored, and the env var is a per-process override rather than storage.
fn stored_identity() -> Result<Option<ResolvedIdentity>, CliError> {
    identity::resolve_identity(None)
}

/// Persist `nsec`, preferring the keyring and falling back to the `0o600`
/// file. Returns the human-readable location for the `stored_in` field.
///
/// The keyring write merges into the desktop's existing secret blob, so agent
/// keys and discovery credentials already in it are preserved.
fn store_identity(nsec: &str) -> Result<String, CliError> {
    let store = KeyringBlobStore::for_default_service();
    match store_in_keyring(&store, nsec) {
        Ok(()) => {
            let data_dir = identity::app_data_dir()?;
            // Best effort: the marker only matters to a later desktop boot
            // whose keyring is unreachable, and failing to write it is not a
            // reason to fail a successful keyring write.
            if let Err(e) = identity::write_migration_marker(&data_dir) {
                eprintln!("buzz: could not write the desktop keyring marker: {e}");
            }
            Ok(format!("keyring:{}", store.service()))
        }
        Err(keyring_error) => {
            let path = identity::identity_file_path()?;
            match identity::write_identity_file(&path, nsec) {
                Ok(()) => Ok(path.display().to_string()),
                Err(file_error) => Err(CliError::Other(format!(
                    "could not store the identity: keyring failed ({keyring_error}) \
                     and the file fallback failed ({file_error})"
                ))),
            }
        }
    }
}

/// Read-modify-write the keyring blob so the identity is merged in.
fn store_in_keyring(store: &KeyringBlobStore, nsec: &str) -> Result<(), CliError> {
    let existing = store.read_blob()?;
    let merged = identity::merge_identity(existing.as_deref(), nsec)?;
    store.write_blob(&merged)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::BlobStore;
    use std::cell::RefCell;

    /// In-memory blob store standing in for the OS keyring.
    struct FakeBlobStore {
        blob: RefCell<Option<String>>,
    }

    impl BlobStore for FakeBlobStore {
        fn read_blob(&self) -> Result<Option<String>, CliError> {
            Ok(self.blob.borrow().clone())
        }
        fn write_blob(&self, json: &str) -> Result<(), CliError> {
            *self.blob.borrow_mut() = Some(json.to_string());
            Ok(())
        }
    }

    /// Same read-modify-write as `store_in_keyring`, over the trait, so the
    /// merge path is exercised without touching a real keyring.
    fn merge_into(store: &impl BlobStore, nsec: &str) -> Result<(), CliError> {
        let existing = store.read_blob()?;
        let merged = identity::merge_identity(existing.as_deref(), nsec)?;
        store.write_blob(&merged)
    }

    #[test]
    fn storing_an_identity_keeps_the_other_desktop_secrets() {
        let store = FakeBlobStore {
            blob: RefCell::new(Some(
                serde_json::json!({
                    "agent:deadbeef": "nsec-agent",
                    "discovery:apollo": "token",
                })
                .to_string(),
            )),
        };

        merge_into(&store, "nsec-founder").unwrap();

        let raw = store.read_blob().unwrap();
        let map = identity::parse_blob(raw.as_deref()).unwrap();
        assert_eq!(map.len(), 3);
        assert_eq!(
            map.get("agent:deadbeef").map(String::as_str),
            Some("nsec-agent")
        );
        assert_eq!(
            map.get("discovery:apollo").map(String::as_str),
            Some("token")
        );
        assert_eq!(
            map.get("identity").map(String::as_str),
            Some("nsec-founder")
        );
    }

    #[test]
    fn storing_twice_replaces_only_the_identity() {
        let store = FakeBlobStore {
            blob: RefCell::new(None),
        };
        merge_into(&store, "nsec-first").unwrap();
        merge_into(&store, "nsec-second").unwrap();

        let raw = store.read_blob().unwrap();
        let map = identity::parse_blob(raw.as_deref()).unwrap();
        assert_eq!(map.len(), 1);
        assert_eq!(map.get("identity").map(String::as_str), Some("nsec-second"));
    }
}
