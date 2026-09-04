//! Founder identity: generate, store, and resolve the Nostr key the CLI signs
//! with.
//!
//! The storage layout deliberately mirrors the desktop app exactly, so a key
//! minted by `buzz identity init` is adopted by Buzz Desktop on its next
//! launch and the agent and the app share one identity:
//!
//! - Primary: an OS keyring generic password under service `buzz-desktop`,
//!   account `secrets`. The value is a JSON object holding every desktop
//!   secret (`agent:<pubkey>` entries, discovery credentials, and so on); the
//!   identity nsec lives under the `identity` key. Writes MERGE into that
//!   object, they never replace it. See
//!   `desktop/src-tauri/src/secret_store.rs` and
//!   `desktop/src-tauri/src/app_state.rs`.
//! - Fallback, when the keyring is unavailable: a `0o600`
//!   `<platform-data-dir>/xyz.block.buzz.app/identity.key` file whose content
//!   is the bare nsec, which is the same file the desktop reads.
//!
//! Resolution order for every relay-touching command is
//! `BUZZ_PRIVATE_KEY` env var, then the stored identity (keyring, then file).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use nostr::{Keys, ToBech32};

use crate::error::CliError;

/// Keyring service name the desktop app uses for its secret blob in release
/// builds (`desktop/src-tauri/src/app_state_keyring.rs`).
pub const DEFAULT_KEYRING_SERVICE: &str = "buzz-desktop";

/// Environment variable that overrides [`DEFAULT_KEYRING_SERVICE`]. Exists so
/// tests and dev builds can point at a throwaway service instead of the real
/// desktop item.
pub const KEYRING_SERVICE_ENV: &str = "BUZZ_KEYRING_SERVICE";

/// Account (username) of the single keyring entry holding the JSON secret
/// blob. Matches `BLOB_KEY` in the desktop's `secret_store.rs`.
pub const BLOB_ACCOUNT: &str = "secrets";

/// Key inside the JSON blob that holds the human identity nsec. Matches
/// `IDENTITY_KEY_NAME` in the desktop's `app_state.rs`.
pub const IDENTITY_BLOB_KEY: &str = "identity";

/// Tauri bundle identifier of the production desktop app. Joined with the
/// platform data dir this reproduces the desktop's app-data directory.
const PROD_BUNDLE_IDENTIFIER: &str = "xyz.block.buzz.app";

/// Filename of the desktop's plaintext identity fallback.
const IDENTITY_FILE_NAME: &str = "identity.key";

/// Filename of the desktop's keyring-migration marker. Its presence tells the
/// desktop that a key genuinely lives in the keyring, so a boot where the
/// keyring is unreachable fails closed instead of minting a fresh identity.
const MIGRATION_MARKER_NAME: &str = "identity.migrated";

/// Where a resolved identity came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentitySource {
    /// The `BUZZ_PRIVATE_KEY` environment variable or `--private-key`.
    Env,
    /// The OS keyring blob.
    Keyring,
    /// The `0o600` identity file fallback.
    File,
}

impl IdentitySource {
    /// Stable machine-readable name, used as the `source` field of
    /// `buzz identity show`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Env => "env",
            Self::Keyring => "keyring",
            Self::File => "file",
        }
    }
}

/// An identity plus the store it was resolved from.
#[derive(Debug, Clone)]
pub struct ResolvedIdentity {
    /// The parsed keypair.
    pub keys: Keys,
    /// Which tier of the resolution order supplied it.
    pub source: IdentitySource,
}

/// Read/write access to the secret blob, abstracted so the merge and
/// resolution logic can be unit-tested without touching an OS keyring.
pub trait BlobStore {
    /// Return the raw JSON blob, or `None` when no entry exists.
    fn read_blob(&self) -> Result<Option<String>, CliError>;
    /// Replace the raw JSON blob.
    fn write_blob(&self, json: &str) -> Result<(), CliError>;
}

/// Resolve the keyring service name: [`KEYRING_SERVICE_ENV`] when set and
/// non-empty, otherwise [`DEFAULT_KEYRING_SERVICE`].
pub fn keyring_service() -> String {
    match std::env::var(KEYRING_SERVICE_ENV) {
        Ok(service) if !service.trim().is_empty() => service,
        _ => DEFAULT_KEYRING_SERVICE.to_string(),
    }
}

/// The desktop app-data directory: `<platform-data-dir>/xyz.block.buzz.app`.
pub fn app_data_dir() -> Result<PathBuf, CliError> {
    let data_dir = dirs::data_dir().ok_or_else(|| {
        CliError::Other("could not resolve platform app-data directory".to_string())
    })?;
    Ok(data_dir.join(PROD_BUNDLE_IDENTIFIER))
}

/// Path of the plaintext identity fallback file.
pub fn identity_file_path() -> Result<PathBuf, CliError> {
    Ok(app_data_dir()?.join(IDENTITY_FILE_NAME))
}

// ── Pure blob helpers (unit-tested) ────────────────────────────────────────

/// Parse a raw secret blob into its key/value map.
///
/// `None` (no entry yet) yields an empty map. A blob that is not a JSON object
/// of strings is an error rather than a silent reset: overwriting an
/// unrecognised blob would destroy the desktop's other secrets.
pub fn parse_blob(raw: Option<&str>) -> Result<BTreeMap<String, String>, CliError> {
    let Some(raw) = raw else {
        return Ok(BTreeMap::new());
    };
    if raw.trim().is_empty() {
        return Ok(BTreeMap::new());
    }
    serde_json::from_str::<BTreeMap<String, String>>(raw)
        .map_err(|e| CliError::Other(format!("keyring blob is not a JSON string map: {e}")))
}

/// Merge `nsec` into `raw` under the `identity` key and return the new blob.
///
/// Every other key in the blob is preserved verbatim: the desktop stores agent
/// keys and discovery credentials in the same object, so `init` must never
/// replace it.
pub fn merge_identity(raw: Option<&str>, nsec: &str) -> Result<String, CliError> {
    let mut map = parse_blob(raw)?;
    map.insert(IDENTITY_BLOB_KEY.to_string(), nsec.to_string());
    serde_json::to_string(&map).map_err(|e| CliError::Other(format!("serialize keyring blob: {e}")))
}

/// Read the stored nsec out of a raw blob, if any.
pub fn identity_from_blob(raw: Option<&str>) -> Result<Option<String>, CliError> {
    Ok(parse_blob(raw)?
        .get(IDENTITY_BLOB_KEY)
        .map(|s| s.to_string()))
}

/// Pick the winning tier given the candidate secrets from each one.
///
/// Order: env, then keyring, then file. Returns `None` when nothing is stored
/// anywhere. Blank candidates are treated as absent, so an exported but empty
/// `BUZZ_PRIVATE_KEY` does not shadow a stored identity.
pub fn choose_identity(
    env: Option<&str>,
    keyring: Option<&str>,
    file: Option<&str>,
) -> Option<(String, IdentitySource)> {
    let non_blank = |candidate: Option<&str>| {
        candidate
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    if let Some(secret) = non_blank(env) {
        return Some((secret, IdentitySource::Env));
    }
    if let Some(secret) = non_blank(keyring) {
        return Some((secret, IdentitySource::Keyring));
    }
    non_blank(file).map(|secret| (secret, IdentitySource::File))
}

// ── Keyring-backed store ───────────────────────────────────────────────────

/// A [`BlobStore`] backed by the OS keyring entry the desktop app uses.
pub struct KeyringBlobStore {
    service: String,
}

impl KeyringBlobStore {
    /// Store addressed by `service`, account [`BLOB_ACCOUNT`].
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    /// Store for the service [`keyring_service`] resolves to.
    pub fn for_default_service() -> Self {
        Self::new(keyring_service())
    }

    /// The service name this store addresses.
    pub fn service(&self) -> &str {
        &self.service
    }

    fn entry(&self) -> Result<keyring::Entry, CliError> {
        keyring::Entry::new(&self.service, BLOB_ACCOUNT)
            .map_err(|e| CliError::Other(format!("keyring entry: {e}")))
    }
}

impl BlobStore for KeyringBlobStore {
    fn read_blob(&self) -> Result<Option<String>, CliError> {
        match self.entry()?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(CliError::Other(format!("keyring read: {e}"))),
        }
    }

    fn write_blob(&self, json: &str) -> Result<(), CliError> {
        self.entry()?
            .set_password(json)
            .map_err(|e| CliError::Other(format!("keyring write: {e}")))
    }
}

// ── File fallback ──────────────────────────────────────────────────────────

/// Read the nsec from the plaintext identity file, if it exists.
pub fn read_identity_file(path: &Path) -> Result<Option<String>, CliError> {
    match std::fs::read_to_string(path) {
        Ok(content) => {
            let trimmed = content.trim().to_string();
            Ok(if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(CliError::Other(format!("read {}: {e}", path.display()))),
    }
}

/// Write `nsec` to `path` with owner-only permissions (`0o600` on Unix).
///
/// The write goes to a sibling temp file that is created with the restricted
/// mode before any secret bytes are written, then renamed over `path`, so a
/// crash mid-write cannot leave a truncated key behind.
pub fn write_identity_file(path: &Path, nsec: &str) -> Result<(), CliError> {
    use std::io::Write;

    let parent = path
        .parent()
        .ok_or_else(|| CliError::Other(format!("no parent directory for {}", path.display())))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| CliError::Other(format!("create {}: {e}", parent.display())))?;

    let tmp = path.with_extension("key.tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&tmp)
        .map_err(|e| CliError::Other(format!("open {}: {e}", tmp.display())))?;
    file.write_all(nsec.as_bytes())
        .map_err(|e| CliError::Other(format!("write {}: {e}", tmp.display())))?;
    file.sync_all()
        .map_err(|e| CliError::Other(format!("sync {}: {e}", tmp.display())))?;
    drop(file);
    std::fs::rename(&tmp, path)
        .map_err(|e| CliError::Other(format!("rename {}: {e}", tmp.display())))
}

/// Write the desktop's keyring-migration marker next to the identity file.
///
/// The desktop treats "no file and no marker" as a first-ever launch and mints
/// a fresh key. After the CLI stores an identity in the keyring only, that
/// heuristic would rotate the founder's key on any boot where the keyring is
/// unreachable, so the marker is written for the same reason the desktop
/// writes it in `generate_and_persist`.
pub fn write_migration_marker(data_dir: &Path) -> Result<(), CliError> {
    std::fs::create_dir_all(data_dir)
        .map_err(|e| CliError::Other(format!("create {}: {e}", data_dir.display())))?;
    let path = data_dir.join(MIGRATION_MARKER_NAME);
    std::fs::write(&path, b"1")
        .map_err(|e| CliError::Other(format!("write {}: {e}", path.display())))
}

// ── Resolution ─────────────────────────────────────────────────────────────

/// Read whatever nsec the keyring holds, treating an unreachable keyring as
/// "nothing stored" rather than a hard failure: the file fallback may still
/// hold the identity.
fn stored_in_keyring() -> Option<String> {
    let store = KeyringBlobStore::for_default_service();
    let raw = store.read_blob().ok()?;
    identity_from_blob(raw.as_deref()).ok().flatten()
}

/// Read whatever nsec the file fallback holds, ignoring IO errors for the same
/// reason as [`stored_in_keyring`].
fn stored_in_file() -> Option<String> {
    let path = identity_file_path().ok()?;
    read_identity_file(&path).ok().flatten()
}

/// Resolve the identity the CLI should sign with.
///
/// `env_key` is the value of `--private-key` / `BUZZ_PRIVATE_KEY`. Returns
/// `Ok(None)` when no identity is configured anywhere, which callers turn into
/// the "run `buzz identity init`" hint.
pub fn resolve_identity(env_key: Option<&str>) -> Result<Option<ResolvedIdentity>, CliError> {
    // The env var wins outright, so the keyring is only touched (and on macOS
    // only prompted for) when there is nothing in the environment.
    if let Some((secret, source)) = choose_identity(env_key, None, None) {
        let keys = parse_secret(&secret, source)?;
        return Ok(Some(ResolvedIdentity { keys, source }));
    }
    let keyring = stored_in_keyring();
    let file = stored_in_file();
    match choose_identity(None, keyring.as_deref(), file.as_deref()) {
        None => Ok(None),
        Some((secret, source)) => Ok(Some(ResolvedIdentity {
            keys: parse_secret(&secret, source)?,
            source,
        })),
    }
}

/// Parse a secret from `source`, labelling the error with where it came from.
fn parse_secret(secret: &str, source: IdentitySource) -> Result<Keys, CliError> {
    Keys::parse(secret).map_err(|e| match source {
        IdentitySource::Env => CliError::Key(format!("invalid BUZZ_PRIVATE_KEY: {e}")),
        IdentitySource::Keyring => {
            CliError::Key(format!("stored identity in the OS keyring is invalid: {e}"))
        }
        IdentitySource::File => CliError::Key(format!("stored identity file is invalid: {e}")),
    })
}

/// Encode a keypair's secret as an nsec string.
pub fn nsec_of(keys: &Keys) -> Result<String, CliError> {
    keys.secret_key()
        .to_bech32()
        .map_err(|e| CliError::Other(format!("encode nsec: {e}")))
}

/// Encode a keypair's public key as an npub string.
pub fn npub_of(keys: &Keys) -> Result<String, CliError> {
    keys.public_key()
        .to_bech32()
        .map_err(|e| CliError::Other(format!("encode npub: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- merge semantics ----

    #[test]
    fn merge_preserves_every_other_key() {
        let existing = serde_json::json!({
            "agent:abc123": "nsec-agent",
            "discovery:token": "secret-token",
        })
        .to_string();

        let merged = merge_identity(Some(&existing), "nsec-founder").unwrap();
        let map = parse_blob(Some(&merged)).unwrap();

        assert_eq!(
            map.get("agent:abc123").map(String::as_str),
            Some("nsec-agent")
        );
        assert_eq!(
            map.get("discovery:token").map(String::as_str),
            Some("secret-token")
        );
        assert_eq!(
            map.get(IDENTITY_BLOB_KEY).map(String::as_str),
            Some("nsec-founder")
        );
        assert_eq!(map.len(), 3);
    }

    #[test]
    fn merge_into_absent_blob_creates_one_key() {
        let merged = merge_identity(None, "nsec-founder").unwrap();
        let map = parse_blob(Some(&merged)).unwrap();
        assert_eq!(map.len(), 1);
        assert_eq!(
            map.get(IDENTITY_BLOB_KEY).map(String::as_str),
            Some("nsec-founder")
        );
    }

    #[test]
    fn merge_overwrites_only_the_identity_key() {
        let existing = serde_json::json!({
            "identity": "nsec-old",
            "agent:abc123": "nsec-agent",
        })
        .to_string();

        let merged = merge_identity(Some(&existing), "nsec-new").unwrap();
        let map = parse_blob(Some(&merged)).unwrap();

        assert_eq!(
            map.get(IDENTITY_BLOB_KEY).map(String::as_str),
            Some("nsec-new")
        );
        assert_eq!(
            map.get("agent:abc123").map(String::as_str),
            Some("nsec-agent")
        );
    }

    #[test]
    fn merge_refuses_a_blob_that_is_not_a_string_map() {
        let err = merge_identity(Some("[1, 2, 3]"), "nsec-founder").unwrap_err();
        assert!(
            err.to_string().contains("not a JSON string map"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn empty_blob_is_treated_as_absent() {
        assert!(parse_blob(Some("   ")).unwrap().is_empty());
        assert!(identity_from_blob(Some("")).unwrap().is_none());
    }

    #[test]
    fn identity_from_blob_reads_the_identity_key() {
        let raw = serde_json::json!({ "identity": "nsec-founder" }).to_string();
        assert_eq!(
            identity_from_blob(Some(&raw)).unwrap().as_deref(),
            Some("nsec-founder")
        );
        let other = serde_json::json!({ "agent:abc": "x" }).to_string();
        assert!(identity_from_blob(Some(&other)).unwrap().is_none());
    }

    // ---- resolution order ----

    #[test]
    fn env_wins_over_keyring_and_file() {
        let chosen = choose_identity(Some("env-key"), Some("keyring-key"), Some("file-key"));
        assert_eq!(chosen, Some(("env-key".to_string(), IdentitySource::Env)));
    }

    #[test]
    fn keyring_wins_over_file_when_env_is_absent() {
        let chosen = choose_identity(None, Some("keyring-key"), Some("file-key"));
        assert_eq!(
            chosen,
            Some(("keyring-key".to_string(), IdentitySource::Keyring))
        );
    }

    #[test]
    fn file_is_used_when_env_and_keyring_are_absent() {
        let chosen = choose_identity(None, None, Some("file-key"));
        assert_eq!(chosen, Some(("file-key".to_string(), IdentitySource::File)));
    }

    #[test]
    fn blank_env_does_not_shadow_a_stored_identity() {
        let chosen = choose_identity(Some(""), Some("keyring-key"), None);
        assert_eq!(
            chosen,
            Some(("keyring-key".to_string(), IdentitySource::Keyring))
        );
        let chosen = choose_identity(Some("   "), None, Some("file-key"));
        assert_eq!(chosen, Some(("file-key".to_string(), IdentitySource::File)));
    }

    #[test]
    fn nothing_stored_anywhere_resolves_to_none() {
        assert_eq!(choose_identity(None, None, None), None);
        assert_eq!(choose_identity(Some(""), Some(""), Some("")), None);
    }

    #[test]
    fn source_names_are_stable() {
        assert_eq!(IdentitySource::Env.as_str(), "env");
        assert_eq!(IdentitySource::Keyring.as_str(), "keyring");
        assert_eq!(IdentitySource::File.as_str(), "file");
    }

    // ---- file fallback ----

    #[test]
    fn identity_file_round_trips_with_owner_only_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("identity.key");
        assert!(read_identity_file(&path).unwrap().is_none());

        let keys = Keys::generate();
        let nsec = nsec_of(&keys).unwrap();
        write_identity_file(&path, &nsec).unwrap();

        assert_eq!(
            read_identity_file(&path).unwrap().as_deref(),
            Some(nsec.as_str())
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "identity.key must be owner-only");
        }
    }

    #[test]
    fn generated_keys_encode_to_nsec_and_npub() {
        let keys = Keys::generate();
        let nsec = nsec_of(&keys).unwrap();
        let npub = npub_of(&keys).unwrap();
        assert!(nsec.starts_with("nsec1"), "unexpected nsec: {nsec}");
        assert!(npub.starts_with("npub1"), "unexpected npub: {npub}");
        assert_eq!(
            Keys::parse(&nsec).unwrap().public_key(),
            keys.public_key(),
            "nsec must round-trip to the same pubkey"
        );
    }

    // ---- keyring service resolution ----

    #[test]
    fn default_service_matches_the_desktop() {
        assert_eq!(DEFAULT_KEYRING_SERVICE, "buzz-desktop");
        assert_eq!(BLOB_ACCOUNT, "secrets");
        assert_eq!(IDENTITY_BLOB_KEY, "identity");
    }
}
