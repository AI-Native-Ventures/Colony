//! Native command boundary for workspace terminal tabs.

use crate::terminal::{TerminalManager, TerminalStartResult};
use portable_pty::PtySize;
use serde::Deserialize;
use std::path::PathBuf;
use tauri::{AppHandle, State};

use super::project_repo_paths::find_local_repo_dir;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStartRequest {
    pub channel_id: String,
    pub project_dtag: Option<String>,
    pub clone_url: Option<String>,
    pub repos_dir: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub pixel_width: Option<u16>,
    pub pixel_height: Option<u16>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResizeRequest {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
    pub pixel_width: Option<u16>,
    pub pixel_height: Option<u16>,
}

/// Resolve a project checkout under the active community's repositories root.
/// Missing or unmatched projects intentionally fall back to the user's home.
pub(crate) fn resolve_terminal_cwd(
    repos_dir: Option<&str>,
    project_dtag: Option<&str>,
    clone_url: Option<&str>,
) -> Result<PathBuf, String> {
    if let Some(project_dtag) = project_dtag
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Some(path) = find_local_repo_dir(repos_dir, project_dtag, clone_url)
            .ok()
            .flatten()
        {
            return Ok(path);
        }
    }
    dirs::home_dir().ok_or_else(|| "unable to resolve the user's home directory".to_string())
}

fn pty_size(
    cols: Option<u16>,
    rows: Option<u16>,
    pixel_width: Option<u16>,
    pixel_height: Option<u16>,
) -> PtySize {
    PtySize {
        cols: cols.unwrap_or(80).max(2),
        rows: rows.unwrap_or(24).max(2),
        pixel_width: pixel_width.unwrap_or(0),
        pixel_height: pixel_height.unwrap_or(0),
    }
}

/// Start a real interactive shell for the current workspace channel.
#[tauri::command]
pub fn workspace_terminal_start(
    request: TerminalStartRequest,
    app: AppHandle,
    state: State<'_, TerminalManager>,
) -> Result<TerminalStartResult, String> {
    if request.channel_id.trim().is_empty() {
        return Err("terminal channel id must not be empty".to_string());
    }
    let cwd = resolve_terminal_cwd(
        request.repos_dir.as_deref(),
        request.project_dtag.as_deref(),
        request.clone_url.as_deref(),
    )?;
    state.start(
        Some(app),
        cwd,
        pty_size(
            request.cols,
            request.rows,
            request.pixel_width,
            request.pixel_height,
        ),
    )
}

/// Write xterm.js input bytes into a live native session.
#[tauri::command]
pub fn workspace_terminal_write(
    session_id: String,
    data: String,
    state: State<'_, TerminalManager>,
) -> Result<(), String> {
    state.write(&session_id, data.as_bytes())
}

/// Resize the PTY backing a terminal tab.
#[tauri::command]
pub fn workspace_terminal_resize(
    request: TerminalResizeRequest,
    state: State<'_, TerminalManager>,
) -> Result<(), String> {
    state.resize(
        &request.session_id,
        pty_size(
            Some(request.cols),
            Some(request.rows),
            request.pixel_width,
            request.pixel_height,
        ),
    )
}

/// Close a terminal tab and reap its complete process group.
#[tauri::command]
pub fn workspace_terminal_close(
    session_id: String,
    state: State<'_, TerminalManager>,
) -> Result<(), String> {
    state.close(&session_id)
}

/// Close all terminal sessions before a community boundary or app exit.
#[tauri::command]
pub fn workspace_terminal_close_all(state: State<'_, TerminalManager>) -> Result<(), String> {
    state.close_all();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn terminal_resolves_matching_project_checkout() {
        let root = tempfile::tempdir().expect("tempdir");
        let checkout = root.path().join("owner--terminal-fixture");
        fs::create_dir_all(checkout.join(".git")).expect("checkout");
        fs::write(
            checkout.join(".git/config"),
            "[remote \"origin\"]\n\turl = https://example.test/owner/terminal-fixture.git\n",
        )
        .expect("origin config");
        let resolved = resolve_terminal_cwd(
            Some(root.path().to_string_lossy().as_ref()),
            Some("terminal-fixture"),
            Some("https://example.test/owner/terminal-fixture.git"),
        )
        .expect("cwd resolution");
        assert_eq!(
            resolved,
            checkout.canonicalize().expect("canonical checkout")
        );
    }

    #[test]
    fn terminal_resolves_home_for_unlinked_project() {
        let resolved = resolve_terminal_cwd(
            Some("/definitely/not/a/repos/root"),
            Some("missing-project"),
            Some("https://example.test/owner/missing-project.git"),
        )
        .expect("home fallback");
        assert_eq!(resolved, dirs::home_dir().expect("home"));
    }
}
