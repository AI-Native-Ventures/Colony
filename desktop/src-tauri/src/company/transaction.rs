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

use buzz_core_pkg::company_roster::{materialized_persona_id, CompanyBlueprint};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// How far a materialization got. Each is recorded only after the side effect
/// it names has actually completed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlueprintCheckpoint {
    /// The Blueprint parsed and matched the approving action.
    Validated,
    /// The Company profile head exists on the relay.
    CompanyPublished,
    /// Every enabled Persona exists locally.
    PersonasSeeded,
    /// Every Team exists locally.
    TeamsSeeded,
    /// All three Initiatives exist on the relay as `proposed`.
    InitiativesPublished,
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

/// The namespace for derived request-scoped UUIDs.
///
/// Fixed forever: changing it would make every in-flight retry generate fresh
/// idempotency keys and re-apply completed relay writes.
const COLONY_NAMESPACE: Uuid = Uuid::from_bytes([
    0x1e, 0x9f, 0x4d, 0x2a, 0x7c, 0x3b, 0x4e, 0x8a, 0x9d, 0x5f, 0x62, 0x10, 0xa4, 0xc7, 0x83, 0x51,
]);

/// The idempotency key for one step of one request.
///
/// Derived, not random. A retry after a crash produces the same key, so the
/// relay recognises the write as one it already applied rather than applying
/// it a second time. This is the single most important function in the module.
pub fn step_idempotency_key(request_id: &str, step: &str) -> Uuid {
    Uuid::new_v5(&COLONY_NAMESPACE, format!("{request_id}:{step}").as_bytes())
}

/// Canonical hash of an approved Blueprint.
pub fn blueprint_hash(blueprint: &CompanyBlueprint) -> String {
    let canonical =
        canonical_json(&serde_json::to_value(blueprint).unwrap_or(serde_json::Value::Null));
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    hex::encode(hasher.finalize())
}

/// Serialize with object keys sorted, so two equal blueprints hash equal
/// regardless of the order a client happened to emit them in.
fn canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let body: Vec<String> = keys
                .into_iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        serde_json::Value::String(key.clone()),
                        canonical_json(&map[key])
                    )
                })
                .collect();
            format!("{{{}}}", body.join(","))
        }
        serde_json::Value::Array(items) => {
            let body: Vec<String> = items.iter().map(canonical_json).collect();
            format!("[{}]", body.join(","))
        }
        other => other.to_string(),
    }
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

    let body =
        serde_json::to_string(journal).map_err(|err| TransactionError::Journal(err.to_string()))?;
    let temp = path.with_extension("json.tmp");
    write_private(&temp, &body)?;
    std::fs::rename(&temp, path).map_err(|err| TransactionError::Journal(err.to_string()))
}

/// Create the file readable only by its owner, before any content lands in it.
#[cfg(unix)]
fn write_private(path: &Path, body: &str) -> Result<(), TransactionError> {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
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
    blueprint: &CompanyBlueprint,
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

/// The Persona ID for a role, honouring the reuse of the existing Chief of
/// Staff.
///
/// Fizz is already in the workspace and already talking to the owner: creating
/// a second Chief of Staff would leave the owner with two, one of which has no
/// memory of the conversation that created the company.
pub fn persona_id_for(
    community_scope: &str,
    company_id: &str,
    role_id: buzz_core_pkg::company_roster::BaselineRoleId,
) -> String {
    if role_id == buzz_core_pkg::company_roster::BaselineRoleId::ChiefOfStaff {
        return "builtin:fizz".to_string();
    }
    materialized_persona_id(community_scope, company_id, role_id)
}

/// Every Initiative ID this Blueprint materializes, in Blueprint order.
pub fn planned_initiative_ids(blueprint: &CompanyBlueprint) -> Vec<String> {
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
