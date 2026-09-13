//! Host-owned, descriptor-pinned evidence capture files.
//!
//! Electron receives a PNG from Chromium, but the worker controls the
//! isolated workspace path after the capability has been issued.  Opening
//! that path after a `realpath` check leaves a symlink-swap window.  This
//! command validates the workspace against the native isolated-agent root,
//! pins the root and evidence directory with file descriptors, and creates
//! the final file with `openat(2)` and no-follow flags.

use std::path::{Component, Path};

#[cfg(unix)]
use std::os::fd::RawFd;

#[cfg(unix)]
use nix::unistd::close;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use tauri::Manager;

use crate::{
    app_state::AppState,
    managed_agents::managed_agents_base_dir,
    managed_agents::{
        load_managed_agents, BackendKind, ManagedAgentRuntimeKey, ManagedAgentRuntimeLifecycle,
    },
    relay::{effective_agent_relay_url, relay_ws_url_with_override},
};

use crate::managed_agents::owner_scope::effective_owner_pubkey;

const EVIDENCE_DIRECTORY: &str = ".colony-evidence";
// The private Electron-to-native JSON frame is capped at 16 MiB. Base64
// expands the PNG, so keep the raw payload below that transport ceiling with
// room for the command envelope and identity fields.
const MAX_EVIDENCE_CAPTURE_BYTES: usize = 8 * 1024 * 1024;
const MAX_EVIDENCE_CAPTURE_BASE64_BYTES: usize = ((MAX_EVIDENCE_CAPTURE_BYTES + 2) / 3) * 4;

/// Result returned after a native evidence capture has been durably written.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceCaptureResult {
    /// Canonical path where the isolated worker can consume the capture.
    pub path: String,
    /// Number of bytes written and synced.
    pub bytes: usize,
}

/// Write an Electron-owned PNG inside the exact isolated worker home.
///
/// The caller passes the owner, relay, and worker identities captured by the
/// capability authority. The native command resolves the worker's exact
/// `agents/isolated/<runtime-key>/home` directory from those identities rather
/// than accepting a caller-supplied filesystem path.
#[allow(clippy::too_many_arguments)] // Keep the flat, explicit native IPC contract.
#[tauri::command]
pub async fn write_evidence_capture(
    app: tauri::AppHandle,
    owner_pubkey: String,
    relay_url: String,
    worker_pubkey: String,
    expected_pid: u32,
    expected_start_nonce: String,
    file_name: String,
    bytes_base64: String,
) -> Result<EvidenceCaptureResult, String> {
    let state = app.state::<AppState>();
    let _community_guard = state.community_operation_lock.read().await;
    let owner_pubkey = validate_pubkey(&owner_pubkey, "owner")?;
    let relay_url = buzz_core_pkg::relay::normalize_relay_url(&relay_url)
        .map_err(|error| format!("invalid evidence relay: {error}"))?;
    let worker_pubkey = validate_pubkey(&worker_pubkey, "worker")?;
    if expected_pid == 0 {
        return Err("evidence worker pid is invalid".to_string());
    }
    let expected_start_nonce = validate_runtime_generation(&expected_start_nonce)?;
    if bytes_base64.len() > MAX_EVIDENCE_CAPTURE_BASE64_BYTES {
        return Err("evidence capture exceeds native transport budget".to_string());
    }
    let bytes = STANDARD
        .decode(bytes_base64.as_bytes())
        .map_err(|_| "evidence capture is not valid base64".to_string())?;
    if bytes.len() > MAX_EVIDENCE_CAPTURE_BYTES {
        return Err(format!(
            "evidence capture exceeds {} byte limit",
            MAX_EVIDENCE_CAPTURE_BYTES
        ));
    }
    assert_current_scope(&state, &owner_pubkey, &relay_url)?;
    let file_name = validate_capture_file_name(&file_name)?.to_owned();

    // Keep the plain mutex guards inside this block. Tauri commands are Send
    // futures, so an explicit `drop` immediately before an await is not enough
    // for the compiler to prove that a guard cannot cross `spawn_blocking`.
    // Copy only the runtime identity and generation we need for the blocking
    // write, then re-acquire the map after it returns.
    let (key, workspace, runtime_generation) = {
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| error.to_string())?;
        let records = load_managed_agents(&app)?;
        let key = ManagedAgentRuntimeKey::new(worker_pubkey.clone(), &relay_url)?;
        let record = records
            .iter()
            .find(|record| {
                record.pubkey.eq_ignore_ascii_case(&worker_pubkey)
                    && record.backend == BackendKind::Local
                    && effective_agent_relay_url(&record.relay_url, &relay_url) == relay_url
                    && effective_owner_pubkey(record)
                        .is_some_and(|actual| actual.eq_ignore_ascii_case(&owner_pubkey))
            })
            .ok_or_else(|| {
                "evidence worker is not owned by the active relay identity".to_string()
            })?;
        if record.pubkey.to_ascii_lowercase() != key.pubkey {
            return Err("evidence worker identity does not match its runtime key".to_string());
        }
        let runtimes = state
            .managed_agent_processes
            .lock()
            .map_err(|error| error.to_string())?;
        let runtime = runtimes
            .get(&key)
            .ok_or_else(|| "evidence worker runtime is not live".to_string())?;
        if runtime.isolation_network.is_none()
            || matches!(
                runtime.lifecycle,
                ManagedAgentRuntimeLifecycle::Starting
                    | ManagedAgentRuntimeLifecycle::Failed
                    | ManagedAgentRuntimeLifecycle::Stopped
            )
        {
            return Err("evidence worker runtime is not isolated and live".to_string());
        }
        if runtime.child.id() != expected_pid
            || runtime.start_nonce.as_str() != expected_start_nonce.as_str()
        {
            return Err("evidence worker generation no longer matches the capability".to_string());
        }
        let isolated_root = managed_agents_base_dir(&app)?.join("isolated");
        let isolated_root = std::fs::canonicalize(&isolated_root)
            .map_err(|error| format!("cannot resolve isolated worker root: {error}"))?;
        let workspace = isolated_root.join(key.runtime_id()).join("home");
        if !workspace.is_dir() {
            return Err("evidence worker workspace is unavailable".to_string());
        }
        let runtime_generation = (runtime.child.id(), runtime.start_nonce.clone());
        (key, workspace, runtime_generation)
    };

    let cleanup_workspace = workspace.clone();
    let cleanup_file_name = file_name.clone();
    let result = tokio::task::spawn_blocking(move || {
        write_evidence_capture_at(&workspace, &file_name, &bytes)
    })
    .await
    .map_err(|error| format!("evidence capture task failed: {error}"))??;
    let post_capture_check = (|| -> Result<(), String> {
        assert_current_scope(&state, &owner_pubkey, &relay_url)?;

        let runtimes = state
            .managed_agent_processes
            .lock()
            .map_err(|error| error.to_string())?;
        let runtime = runtimes
            .get(&key)
            .ok_or_else(|| "evidence worker runtime stopped during capture".to_string())?;
        if runtime.child.id() != expected_pid
            || runtime.start_nonce.as_str() != expected_start_nonce.as_str()
            || runtime.child.id() != runtime_generation.0
            || runtime.start_nonce.as_str() != runtime_generation.1.as_str()
            || runtime.isolation_network.is_none()
            || matches!(
                runtime.lifecycle,
                ManagedAgentRuntimeLifecycle::Starting
                    | ManagedAgentRuntimeLifecycle::Failed
                    | ManagedAgentRuntimeLifecycle::Stopped
            )
        {
            return Err("evidence worker runtime changed during capture".to_string());
        }
        Ok(())
    })();
    if let Err(error) = post_capture_check {
        let cleanup = tokio::task::spawn_blocking(move || {
            remove_evidence_capture_at(&cleanup_workspace, &cleanup_file_name)
        })
        .await
        .map_err(|cleanup_error| format!("evidence cleanup task failed: {cleanup_error}"))?;
        if let Err(cleanup_error) = cleanup {
            return Err(format!("{error}; evidence cleanup failed: {cleanup_error}"));
        }
        return Err(error);
    }
    Ok(result)
}

fn validate_pubkey(value: &str, label: &str) -> Result<String, String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("evidence {label} pubkey is invalid"));
    }
    Ok(value.to_ascii_lowercase())
}

fn validate_runtime_generation(value: &str) -> Result<String, String> {
    if value.len() != 32
        || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
        || value != value.to_ascii_lowercase()
    {
        return Err("evidence worker generation is invalid".to_string());
    }
    Ok(value.to_owned())
}

fn assert_current_scope(
    state: &AppState,
    owner_pubkey: &str,
    relay_url: &str,
) -> Result<(), String> {
    let actual_owner = super::workspace_owner_hex(state)?;
    if !actual_owner.eq_ignore_ascii_case(owner_pubkey) {
        return Err("evidence owner changed during capture".to_string());
    }
    let actual_relay =
        buzz_core_pkg::relay::normalize_relay_url(&relay_ws_url_with_override(state))
            .map_err(|error| format!("active relay is invalid: {error}"))?;
    if actual_relay != relay_url {
        return Err("evidence relay changed during capture".to_string());
    }
    Ok(())
}

fn validate_capture_file_name(file_name: &str) -> Result<&str, String> {
    let path = Path::new(file_name);
    if file_name.is_empty()
        || path.components().count() != 1
        || !matches!(path.components().next(), Some(Component::Normal(_)))
        || !file_name.ends_with(".png")
        || !file_name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
    {
        return Err("evidence capture filename is invalid".to_string());
    }
    Ok(file_name)
}

#[cfg(unix)]
fn write_evidence_capture_at(
    workspace: &Path,
    file_name: &str,
    bytes: &[u8],
) -> Result<EvidenceCaptureResult, String> {
    write_evidence_capture_at_with_hook(workspace, file_name, bytes, || {})
}

#[cfg(unix)]
fn write_evidence_capture_at_with_hook<F>(
    workspace: &Path,
    file_name: &str,
    bytes: &[u8],
    before_directory_open: F,
) -> Result<EvidenceCaptureResult, String>
where
    F: FnOnce(),
{
    use std::{fs::OpenOptions, io::Write};

    use nix::{
        errno::Errno,
        fcntl::{open, openat, OFlag},
        sys::stat::{mkdirat, Mode},
        unistd::{unlinkat, UnlinkatFlags},
    };

    validate_capture_file_name(file_name)?;
    if bytes.len() > MAX_EVIDENCE_CAPTURE_BYTES {
        return Err(format!(
            "evidence capture exceeds {} byte limit",
            MAX_EVIDENCE_CAPTURE_BYTES
        ));
    }
    let directory_flags =
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
    let root = FdGuard::new(
        open(workspace, directory_flags, Mode::empty())
            .map_err(|error| format!("cannot open evidence workspace: {error}"))?,
    );
    let directory = match openat(
        Some(root.raw()),
        EVIDENCE_DIRECTORY,
        directory_flags,
        Mode::empty(),
    ) {
        Ok(fd) => FdGuard::new(fd),
        Err(Errno::ENOENT) => {
            mkdirat(
                Some(root.raw()),
                EVIDENCE_DIRECTORY,
                Mode::from_bits_truncate(0o700),
            )
            .map_err(|error| format!("cannot create evidence directory: {error}"))?;
            before_directory_open();
            FdGuard::new(
                openat(
                    Some(root.raw()),
                    EVIDENCE_DIRECTORY,
                    directory_flags,
                    Mode::empty(),
                )
                .map_err(|error| format!("cannot pin evidence directory: {error}"))?,
            )
        }
        Err(error) => return Err(format!("cannot open evidence directory: {error}")),
    };
    let file = FdGuard::new(
        openat(
            Some(directory.raw()),
            file_name,
            OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
            Mode::from_bits_truncate(0o600),
        )
        .map_err(|error| format!("cannot create evidence capture: {error}"))?,
    );

    // `openat` returns a raw descriptor in nix 0.28.  Duplicate the already
    // pinned file through the direct `/dev/fd/<file-fd>` form so all writes
    // stay on that inode without introducing unsafe raw-FD ownership code.
    let file_descriptor_path = format!("/dev/fd/{}", file.raw());
    let write_result = (|| -> Result<(), String> {
        let mut output = OpenOptions::new()
            .write(true)
            .open(&file_descriptor_path)
            .map_err(|error| format!("cannot open pinned evidence capture: {error}"))?;
        output
            .write_all(bytes)
            .map_err(|error| format!("cannot write evidence capture: {error}"))?;
        output
            .sync_all()
            .map_err(|error| format!("cannot sync evidence capture: {error}"))
    })();
    if let Err(error) = write_result {
        let _ = unlinkat(Some(directory.raw()), file_name, UnlinkatFlags::NoRemoveDir);
        return Err(error);
    }

    Ok(EvidenceCaptureResult {
        path: workspace
            .join(EVIDENCE_DIRECTORY)
            .join(file_name)
            .to_string_lossy()
            .into_owned(),
        bytes: bytes.len(),
    })
}

/// Remove a capture through descriptors pinned to the authorized workspace.
///
/// This is used only after a post-write scope/generation check fails. It must
/// not fall back to `remove_file(path)`: the worker owns the workspace and can
/// race path resolution with a rename or symlink replacement.
#[cfg(unix)]
fn remove_evidence_capture_at(workspace: &Path, file_name: &str) -> Result<(), String> {
    use nix::{
        errno::Errno,
        fcntl::{open, openat, OFlag},
        sys::stat::Mode,
        unistd::{unlinkat, UnlinkatFlags},
    };

    validate_capture_file_name(file_name)?;
    let directory_flags =
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
    let root = FdGuard::new(
        open(workspace, directory_flags, Mode::empty())
            .map_err(|error| format!("cannot open evidence workspace for cleanup: {error}"))?,
    );
    let directory = match openat(
        Some(root.raw()),
        EVIDENCE_DIRECTORY,
        directory_flags,
        Mode::empty(),
    ) {
        Ok(fd) => FdGuard::new(fd),
        Err(Errno::ENOENT) => return Ok(()),
        Err(error) => {
            return Err(format!(
                "cannot open evidence directory for cleanup: {error}"
            ))
        }
    };
    match unlinkat(Some(directory.raw()), file_name, UnlinkatFlags::NoRemoveDir) {
        Ok(()) | Err(Errno::ENOENT) => Ok(()),
        Err(error) => Err(format!("cannot remove evidence capture: {error}")),
    }
}

#[cfg(not(unix))]
fn remove_evidence_capture_at(_workspace: &Path, _file_name: &str) -> Result<(), String> {
    Err("descriptor-pinned evidence cleanup is unavailable on this platform".to_string())
}

#[cfg(not(unix))]
fn write_evidence_capture_at(
    _workspace: &Path,
    _file_name: &str,
    _bytes: &[u8],
) -> Result<EvidenceCaptureResult, String> {
    Err("descriptor-pinned evidence capture is unavailable on this platform".to_string())
}

#[cfg(unix)]
struct FdGuard(RawFd);

#[cfg(unix)]
impl FdGuard {
    fn new(fd: RawFd) -> Self {
        Self(fd)
    }

    fn raw(&self) -> RawFd {
        self.0
    }
}

#[cfg(unix)]
impl Drop for FdGuard {
    fn drop(&mut self) {
        let _ = close(self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_name_rejects_paths_and_non_pngs() {
        for name in ["", "../capture.png", "capture.jpg", "capture.png/child"] {
            assert!(validate_capture_file_name(name).is_err(), "{name}");
        }
        assert!(validate_capture_file_name("capture-1.png").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn swapped_evidence_directory_is_rejected_before_openat() {
        use std::{fs, os::unix::fs::symlink};

        let workspace = tempfile::tempdir().expect("workspace");
        let outside = tempfile::tempdir().expect("outside");
        let result =
            write_evidence_capture_at_with_hook(workspace.path(), "capture.png", b"png", || {
                let original = workspace.path().join(EVIDENCE_DIRECTORY);
                let moved = workspace.path().join(".colony-evidence-real");
                fs::rename(&original, moved).expect("move evidence directory");
                symlink(outside.path(), original).expect("swap symlink");
            });

        assert!(result.is_err());
        assert!(fs::read_dir(outside.path())
            .expect("outside entries")
            .next()
            .is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_descriptor_writer_persists_capture_bytes() {
        let workspace = tempfile::tempdir().expect("workspace");
        let result = write_evidence_capture_at(workspace.path(), "capture.png", b"png")
            .expect("descriptor-pinned capture");
        assert_eq!(std::fs::read(result.path).expect("capture bytes"), b"png");
    }
}
