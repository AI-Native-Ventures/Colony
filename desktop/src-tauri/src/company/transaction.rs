//! Exactly-once materialization of an approved Blueprint.
//!
//! Approving a Blueprint creates a company: a profile, a set of employees, the
//! teams they sit in, and three proposed initiatives. It is a multi-step
//! operation over two stores (the relay and local persona/team storage), and
//! the app can be closed between any two steps. Running it twice must not
//! produce two companies.
//!
//! Three mechanisms, in decreasing order of how much they are relied on:
//!
//! 1. **Every ID is derived, never generated.** Personas, teams, initiatives
//!    and the idempotency key of every relay write are functions of the
//!    company ID and the request ID. A retry addresses the same records, so
//!    re-running is a no-op even with no journal at all. This is the mechanism
//!    that has to hold; the other two are for speed and diagnosis.
//! 2. **A journal** records the last completed checkpoint, so a resumed run
//!    skips work already proven done rather than re-proving it.
//! 3. **A lock** makes two concurrent calls join one transaction instead of
//!    racing.
//!
//! The journal stores IDs, event IDs, hashes and a checkpoint. It never stores
//! prompts, keys, or anything copied out of runtime memory: it is a file on a
//! user's disk, and a crash-recovery aid is not worth a credential leak.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

use buzz_core_pkg::company_roster::{blueprint_hash, ValidatedBlueprint};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// How far a materialization got. Each is recorded only after the side effect
/// it names has actually completed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
/// The order is the order the work actually happens in, because `advance`
/// refuses to move a checkpoint backwards. A variant listed out of sequence
/// would make its own `advance` call a silent no-op returning `Ok`.
pub enum BlueprintCheckpoint {
    /// The Blueprint parsed and matched the approving action.
    Validated,
    /// Every enabled Persona exists locally.
    PersonasSeeded,
    /// Every Team exists locally.
    TeamsSeeded,
    /// The Company head and all three Initiatives are on the relay, confirmed
    /// by receipt. Recorded last because the relay writes are performed by the
    /// frontend, after this process has handed back the derived keys.
    RelayPublished,
    /// Nothing left to do.
    Completed,
}

/// Why a materialization was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransactionError {
    /// The request ID was seen before carrying different content.
    ///
    /// The likely cause is an edited Blueprint resubmitted under the old
    /// request ID. Executing it would apply changes the owner approved for a
    /// different document.
    HashMismatch,
    /// The approving action was signed by someone other than the owner.
    NotOwner,
    /// The journal on disk could not be read or written.
    Journal(String),
    /// The Blueprint failed revalidation at execution time.
    Invalid(String),
}

impl std::fmt::Display for TransactionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::HashMismatch => {
                write!(
                    f,
                    "this approval does not match the blueprint that was approved"
                )
            }
            Self::NotOwner => write!(f, "a company can only be approved by its owner"),
            Self::Journal(detail) => {
                write!(f, "could not record materialization progress: {detail}")
            }
            Self::Invalid(detail) => write!(f, "blueprint is no longer valid: {detail}"),
        }
    }
}

impl std::error::Error for TransactionError {}

/// The durable record of one materialization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlueprintJournal {
    /// Owner who approved it.
    pub owner_pubkey: String,
    /// Community the company belongs to.
    pub community_scope: String,
    /// The approval this journal belongs to.
    pub request_id: String,
    /// Hash of the approved Blueprint, to catch a resubmitted edit.
    pub blueprint_hash: String,
    /// The company being created.
    pub company_id: String,
    /// How far it got.
    pub checkpoint: BlueprintCheckpoint,
    /// Relay event ID of the company head, once published.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub company_event_id: Option<String>,
    /// Personas created so far.
    #[serde(default)]
    pub persona_ids: Vec<String>,
    /// Teams created so far.
    #[serde(default)]
    pub team_ids: Vec<String>,
    /// Initiatives published so far.
    #[serde(default)]
    pub initiative_ids: Vec<String>,
}

/// Whether a string is a well-formed Nostr event ID.
///
/// The frontend reports the relay's receipt, and this process cannot verify
/// that the relay accepted anything. It can refuse to record something that is
/// not an event ID at all, so a journal marked complete at least points at a
/// plausible event rather than an empty string or arbitrary text that would
/// then be believed forever.
pub fn is_event_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Where one transaction's journal lives.
///
/// The filename is a hash of the key rather than the key itself: an owner's
/// public key should not be readable from a directory listing.
pub fn journal_path(dir: &Path, owner_pubkey: &str, scope: &str, request_id: &str) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(owner_pubkey.as_bytes());
    hasher.update(b"\x1f");
    hasher.update(scope.as_bytes());
    hasher.update(b"\x1f");
    hasher.update(request_id.as_bytes());
    dir.join(format!("{}.json", hex::encode(hasher.finalize())))
}

/// Read an existing journal, if this transaction has run before.
pub fn load_journal(path: &Path) -> Result<Option<BlueprintJournal>, TransactionError> {
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw)
            .map(Some)
            .map_err(|err| TransactionError::Journal(err.to_string())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(TransactionError::Journal(err.to_string())),
    }
}

/// Write a journal so that a crash mid-write cannot leave a half-written one.
///
/// Write to a temporary file, fsync it, then rename over the target: rename is
/// atomic, so a reader sees either the old journal or the new one. A torn
/// journal would be worse than no journal, because it reads as progress that
/// did not happen.
pub fn store_journal(path: &Path, journal: &BlueprintJournal) -> Result<(), TransactionError> {
    let parent = path
        .parent()
        .ok_or_else(|| TransactionError::Journal("journal path has no parent".to_string()))?;
    std::fs::create_dir_all(parent).map_err(|err| TransactionError::Journal(err.to_string()))?;
    restrict_dir(parent)?;

    let body =
        serde_json::to_string(journal).map_err(|err| TransactionError::Journal(err.to_string()))?;
    let temp = path.with_extension("json.tmp");
    write_private(&temp, &body)?;
    std::fs::rename(&temp, path).map_err(|err| TransactionError::Journal(err.to_string()))?;

    // The rename is atomic but not yet durable: the directory entry lives in
    // the parent's own metadata, and without this a power loss can leave the
    // file written and the rename lost. That is the one outcome the whole
    // temp-and-rename dance exists to prevent.
    sync_dir(parent)
}

/// Make the journal directory owner-only.
///
/// Best effort, and deliberately not fatal: the files inside are already
/// mode 600, so a permissive directory reveals only that a materialization
/// happened, and failing the approval over it would be the worse trade.
#[cfg(unix)]
fn restrict_dir(dir: &Path) -> Result<(), TransactionError> {
    use std::os::unix::fs::PermissionsExt;

    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    Ok(())
}

#[cfg(not(unix))]
fn restrict_dir(_dir: &Path) -> Result<(), TransactionError> {
    Ok(())
}

/// Flush the directory entry so a completed rename survives a power loss.
#[cfg(unix)]
fn sync_dir(dir: &Path) -> Result<(), TransactionError> {
    std::fs::File::open(dir)
        .and_then(|handle| handle.sync_all())
        .map_err(|err| TransactionError::Journal(err.to_string()))
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) -> Result<(), TransactionError> {
    // Windows has no portable equivalent, and the rename itself is atomic.
    Ok(())
}

/// Create the file readable only by its owner, before any content lands in it.
///
/// `create_new` rather than `create`: a mode is only applied to a file this
/// call actually creates, so opening one that already exists would keep
/// whatever permissions it had, and would follow it if it were a symlink
/// planted at the predictable temp path. `O_CREAT|O_EXCL` refuses both, and
/// does not follow a symlink at the final component.
///
/// A stale temp file from an interrupted run is removed first. The window
/// between removing and creating is not a hole: if something recreates the
/// path in between, the create fails and the journal write fails with it,
/// which is the safe direction.
#[cfg(unix)]
fn write_private(path: &Path, body: &str) -> Result<(), TransactionError> {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};

    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(TransactionError::Journal(err.to_string())),
    }

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|err| TransactionError::Journal(err.to_string()))?;
    file.write_all(body.as_bytes())
        .map_err(|err| TransactionError::Journal(err.to_string()))?;
    file.sync_all()
        .map_err(|err| TransactionError::Journal(err.to_string()))
}

#[cfg(not(unix))]
fn write_private(path: &Path, body: &str) -> Result<(), TransactionError> {
    std::fs::write(path, body).map_err(|err| TransactionError::Journal(err.to_string()))
}

/// Start or resume a transaction.
///
/// A journal whose hash differs from the Blueprint now being executed is
/// refused rather than overwritten: the owner approved a specific document,
/// and the safe response to a mismatch is to stop.
pub fn begin(
    existing: Option<BlueprintJournal>,
    owner_pubkey: &str,
    community_scope: &str,
    request_id: &str,
    blueprint: &ValidatedBlueprint,
) -> Result<BlueprintJournal, TransactionError> {
    let hash = blueprint_hash(blueprint);
    match existing {
        Some(journal) => {
            if journal.blueprint_hash != hash {
                return Err(TransactionError::HashMismatch);
            }
            // A journal is keyed by owner, but a stale file must never let one
            // owner resume another's transaction.
            if journal.owner_pubkey != owner_pubkey
                || journal.community_scope != community_scope
                || journal.request_id != request_id
            {
                return Err(TransactionError::HashMismatch);
            }
            Ok(journal)
        }
        None => Ok(BlueprintJournal {
            owner_pubkey: owner_pubkey.to_string(),
            community_scope: community_scope.to_string(),
            request_id: request_id.to_string(),
            blueprint_hash: hash,
            company_id: blueprint.company.id.clone(),
            checkpoint: BlueprintCheckpoint::Validated,
            company_event_id: None,
            persona_ids: Vec::new(),
            team_ids: Vec::new(),
            initiative_ids: Vec::new(),
        }),
    }
}

/// Whether a step still has to run, given how far the last attempt got.
pub fn needs(journal: &BlueprintJournal, step: BlueprintCheckpoint) -> bool {
    journal.checkpoint < step
}

/// Record that a step completed. Never moves a checkpoint backwards.
pub fn advance(
    journal: &mut BlueprintJournal,
    path: &Path,
    reached: BlueprintCheckpoint,
) -> Result<(), TransactionError> {
    if reached > journal.checkpoint {
        journal.checkpoint = reached;
    }
    store_journal(path, journal)
}

/// Every Initiative ID this Blueprint materializes, in Blueprint order.
pub fn planned_initiative_ids(blueprint: &ValidatedBlueprint) -> Vec<String> {
    blueprint
        .proposed_initiatives
        .iter()
        .map(|initiative| format!("{}:{}", blueprint.company.id, initiative.id))
        .collect()
}

/// Per-transaction locks, so two concurrent approvals of one Blueprint join
/// rather than race.
fn locks() -> &'static Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The lock guarding one transaction. Two callers with the same journal path
/// get the same lock and run one after the other; the second then finds the
/// work already done and reports it as recovered.
pub fn transaction_lock(path: &Path) -> Arc<tokio::sync::Mutex<()>> {
    let mut guard = locks()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Arc::clone(guard.entry(path.to_path_buf()).or_default())
}

/// Discard the lock table. Test-only: a fresh temp dir per test would
/// otherwise accumulate entries for the life of the process.
#[cfg(test)]
pub fn reset_locks_for_test() {
    locks()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();
}

#[cfg(test)]
#[path = "transaction_tests.rs"]
mod transaction_tests;
