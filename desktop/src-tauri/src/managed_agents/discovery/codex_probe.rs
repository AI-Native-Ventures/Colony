//! Codex adapter version probing and availability classification.
//!
//! Split out of `discovery.rs` for the file-size ratchet; re-exported
//! there so every existing call path keeps working.

use std::path::Path;
use std::process::Command;

use super::AcpAvailabilityStatus;

/// The oldest `codex-acp` version supported by Buzz managed agents.
///
/// Older 1.x adapters are detected successfully, but can still bundle a Codex runtime
/// that does not reliably give `buzz` CLI subprocesses outbound relay access.
///
/// Bump policy: raise this only when a newer adapter fixes a defect that breaks managed
/// agents, and only to a version already published on npm — every user below the floor is
/// offered a reinstall on their next discovery pass.
pub(crate) const MIN_CODEX_ACP_VERSION: (u64, u64, u64) = (1, 1, 7);

/// Probe the full version of a `codex-acp` binary by running `--version`.
///
/// The 1.x adapter (`@agentclientprotocol/codex-acp`) outputs
/// `@agentclientprotocol/codex-acp <major>.<minor>.<patch>` on stdout and exits 0.
/// The old 0.16.x adapter (`@zed-industries/codex-acp`) is a Rust binary that does
/// not recognise `--version` and exits non-zero.
///
/// Returns the `(major, minor, patch)` triple on success, `None` on any failure
/// (non-zero exit, unparseable output, timeout, or missing binary).
///
/// The parse is deliberately strict: exactly three numeric dot-separated components.
/// Partial versions (`1.2`) and prerelease tags (`1.2.0-rc1`) return `None` and so
/// classify as [`AcpAvailabilityStatus::AdapterOutdated`] — failing closed offers a
/// reinstall rather than running an adapter whose version cannot be compared.
///
/// The probe is bounded by a 5-second deadline. The child is polled with
/// [`std::process::Child::try_wait`] (the repo's standard deadline pattern) and
/// killed if it does not exit in time.
///
/// Stdout is redirected to a temporary file rather than a pipe, so forked
/// descendants cannot hold EOF open. Reads from a regular file return EOF at its
/// current write position regardless of inherited file descriptors, cross-platform.
pub(crate) fn probe_codex_acp_version(binary_path: &Path) -> Option<(u64, u64, u64)> {
    probe_codex_acp_version_with_path(
        binary_path,
        crate::managed_agents::readiness::cli_probe::augmented_path().as_deref(),
    )
}
pub(crate) fn probe_codex_acp_version_with_path(
    binary_path: &Path,
    augmented_path: Option<&str>,
) -> Option<(u64, u64, u64)> {
    use std::io::{Read as _, Seek as _, SeekFrom};
    use std::time::{Duration, Instant};
    const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
    // Linux refuses to exec a file any process still holds open for writing and
    // fails with ETXTBSY. A perfectly good adapter hits this: the installer that
    // just wrote it may not have closed its descriptor, and any concurrent fork
    // in this process inherits that descriptor for the window before it execs.
    // The condition clears in milliseconds, so retry rather than report the
    // adapter missing. macOS does not enforce the rule, so only Linux retries.
    const EXEC_ATTEMPTS: usize = 10;
    const EXEC_RETRY_DELAY: Duration = Duration::from_millis(50);
    // glibc's `posix_spawn`, which `Command::spawn` uses on Linux, does not
    // report a failed exec to the caller: it succeeds, and the child exits 127
    // having written nothing. So a transient ETXTBSY arrives here as an exit
    // status, never as a spawn error, and both have to be caught.
    const EXEC_FAILED_EXIT_CODE: i32 = 127;

    // Every attempt shares one deadline, so retrying can never stretch the
    // probe past the timeout a caller is already prepared to wait.
    let deadline = Instant::now() + VERSION_PROBE_TIMEOUT;

    for attempt in 1..=EXEC_ATTEMPTS {
        let retries_left = attempt < EXEC_ATTEMPTS && Instant::now() < deadline;

        // A regular file returns EOF at its current size even when a descendant
        // inherits its descriptor, bounding the post-exit read cross-platform.
        // Fresh per attempt so a previous attempt's bytes cannot be read back.
        let mut tmp = tempfile::tempfile().ok()?;

        // Rebuilt per attempt: spawning consumes the stdout handle.
        let mut command = Command::new(binary_path);
        command.arg("--version");
        if let Some(path) = augmented_path {
            command.env("PATH", path);
        }
        crate::util::configure_no_window(&mut command);
        let spawned = command
            .stdout(tmp.try_clone().ok()?)
            .stderr(std::process::Stdio::null())
            .spawn();

        let mut child = match spawned {
            Ok(child) => child,
            // Not the path glibc takes, but musl and other platforms do report
            // the errno, and then it is the same transient.
            Err(err) if err.kind() == std::io::ErrorKind::ExecutableFileBusy && retries_left => {
                std::thread::sleep(EXEC_RETRY_DELAY);
                continue;
            }
            Err(_) => return None,
        };

        // Poll until the deadline rather than blocking on stdout EOF.
        let exit_status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return None;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
            }
        };

        // Read at most 4 KiB from the regular file without blocking.
        tmp.seek(SeekFrom::Start(0)).ok()?;
        let mut buf = Vec::with_capacity(128);
        let _ = (&mut tmp as &mut dyn std::io::Read)
            .take(4096)
            .read_to_end(&mut buf);

        if !exit_status.success() {
            // Exactly glibc's failed-exec signature: 127 and not one byte of
            // output. A real adapter that exits 127 with nothing to say is
            // retried too and still ends as None, only later.
            if exit_status.code() == Some(EXEC_FAILED_EXIT_CODE) && buf.is_empty() && retries_left {
                std::thread::sleep(EXEC_RETRY_DELAY);
                continue;
            }
            return None;
        }

        let stdout = String::from_utf8_lossy(&buf);
        // Output format: "<package-name> <major>.<minor>.<patch>"
        let version_str = stdout.split_whitespace().last()?;
        let mut components = version_str.split('.');
        let major = components.next()?.parse::<u64>().ok()?;
        let minor = components.next()?.parse::<u64>().ok()?;
        let patch = components.next()?.parse::<u64>().ok()?;
        if components.next().is_some() {
            return None;
        }
        return Some((major, minor, patch));
    }

    None
}

/// Classifies a resolved codex-acp binary path as [`AcpAvailabilityStatus::Available`]
/// or [`AcpAvailabilityStatus::AdapterOutdated`].
///
/// The 0.16.x adapter (`@zed-industries/codex-acp`) does not recognise `--version`
/// and exits non-zero — that probe failure yields `AdapterOutdated`. An adapter is
/// available only when its version is at least [`MIN_CODEX_ACP_VERSION`].
///
/// Used by `discover_acp_runtimes`, `cli_login_requirements`, and
/// `install_acp_runtime_blocking` so the version-gate logic is not duplicated.
pub(crate) fn codex_adapter_availability(path: &Path) -> AcpAvailabilityStatus {
    match probe_codex_acp_version(path) {
        Some(version) if version >= MIN_CODEX_ACP_VERSION => AcpAvailabilityStatus::Available,
        _ => AcpAvailabilityStatus::AdapterOutdated,
    }
}

/// Returns `true` when the codex-acp binary at `path` is below
/// [`MIN_CODEX_ACP_VERSION`] or cannot be probed using `augmented_path`. Thin wrapper
/// around [`codex_adapter_is_outdated_with_path`].
#[cfg(test)]
pub(crate) fn codex_adapter_is_outdated(path: &Path) -> bool {
    codex_adapter_is_outdated_with_path(
        path,
        crate::managed_agents::readiness::cli_probe::augmented_path().as_deref(),
    )
}

/// Returns `true` when the codex-acp binary at `path` is below
/// [`MIN_CODEX_ACP_VERSION`] or cannot be probed with the supplied PATH.
pub(crate) fn codex_adapter_is_outdated_with_path(
    path: &Path,
    augmented_path: Option<&str>,
) -> bool {
    !matches!(
        probe_codex_acp_version_with_path(path, augmented_path),
        Some(version) if version >= MIN_CODEX_ACP_VERSION
    )
}
