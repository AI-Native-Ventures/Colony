//! Read a local file for a workspace `file` or `image` tab.

use base64::Engine as _;
use serde::Serialize;
use std::path::PathBuf;

/// Largest file a workspace tab will load. Bodies are base64 in an IPC
/// response, so this is a memory bound, not a policy.
pub const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// A file loaded for a workspace tab.
#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceFile {
    pub path: String,
    pub name: String,
    pub mime: String,
    pub bytes_base64: String,
    pub size: u64,
    pub is_text: bool,
}

/// Guess a MIME type from a path's extension.
pub fn sniff_mime(path: &str) -> &'static str {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "md" | "markdown" => "text/markdown",
        "json" => "application/json",
        "txt" | "log" | "rs" | "ts" | "tsx" | "js" | "jsx" | "toml" | "yaml" | "yml" | "css"
        | "html" | "sh" | "py" | "dart" | "sql" => "text/plain",
        _ => "application/octet-stream",
    }
}

/// Whether a MIME type should render in the `file` kind's text view.
pub fn is_text_mime(mime: &str) -> bool {
    mime.starts_with("text/") || mime == "application/json"
}

async fn read_file(path: &str) -> Result<WorkspaceFile, String> {
    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|e| format!("cannot read {path}: {e}"))?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!(
            "{path} is too large: {} bytes, cap is {MAX_FILE_BYTES}",
            meta.len()
        ));
    }
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| format!("cannot read {path}: {e}"))?;
    let name = std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path)
        .to_string();
    let mime = sniff_mime(path).to_string();
    Ok(WorkspaceFile {
        path: path.to_string(),
        name,
        is_text: is_text_mime(&mime),
        mime,
        bytes_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        size: meta.len(),
    })
}

/// Read a local file for a workspace tab.
#[tauri::command]
pub async fn read_workspace_file(path: String) -> Result<WorkspaceFile, String> {
    read_file(&path).await
}

/// A path written in a message, resolved to a real file in the workspace.
#[derive(Debug, Clone, Serialize)]
pub struct ResolvedWorkspacePath {
    pub path: String,
    pub mime: String,
    pub is_text: bool,
}

/// Directories a path written in a message is allowed to resolve inside.
///
/// The agent working directory is what a bare `PLANS/FOO.md` is relative to,
/// and `REPOS` inside it is usually a symlink to a repos folder elsewhere on
/// disk, so its canonical target is a second root rather than a child of the
/// first. Both are canonicalized here so containment can be checked against
/// resolved paths.
fn message_path_roots() -> Vec<PathBuf> {
    let Some(workdir) = crate::managed_agents::default_agent_workdir() else {
        return Vec::new();
    };
    [workdir.clone(), workdir.join("REPOS")]
        .iter()
        .filter_map(|candidate| std::fs::canonicalize(candidate).ok())
        .collect()
}

/// Resolve a message-supplied path to an existing file inside one of `roots`.
///
/// A message is untrusted input: anyone in a channel can write a path, and a
/// person who clicks it should not be able to be steered into opening
/// `~/.ssh/id_rsa` in a tab. So resolution is containment-checked after
/// canonicalization, which is what makes both `..` traversal and a symlink
/// pointing outside the workspace fail. With no roots (no resolvable home
/// directory) nothing resolves, including absolute paths.
pub fn resolve_under_roots(roots: &[PathBuf], raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("no path given".to_string());
    }
    let requested = std::path::Path::new(trimmed);
    let candidates: Vec<PathBuf> = if requested.is_absolute() {
        vec![requested.to_path_buf()]
    } else {
        roots.iter().map(|root| root.join(requested)).collect()
    };

    for candidate in candidates {
        let Ok(resolved) = std::fs::canonicalize(&candidate) else {
            continue;
        };
        if resolved.is_file() && roots.iter().any(|root| resolved.starts_with(root)) {
            return Ok(resolved);
        }
    }
    Err(format!(
        "{trimmed} is not a file in the Buzz workspace or your repos folder"
    ))
}

/// Resolve a path written in a message so a workspace tab can open it.
#[tauri::command]
pub async fn resolve_workspace_path(path: String) -> Result<ResolvedWorkspacePath, String> {
    let resolved = resolve_under_roots(&message_path_roots(), &path)?;
    let display = resolved.to_string_lossy().into_owned();
    let mime = sniff_mime(&display).to_string();
    Ok(ResolvedWorkspacePath {
        is_text: is_text_mime(&mime),
        mime,
        path: display,
    })
}

/// Open a native file picker for a workspace tab.
#[tauri::command]
pub async fn pick_workspace_file(
    app: tauri::AppHandle,
    images_only: bool,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file();
    if images_only {
        dialog = dialog.add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp"]);
    }
    dialog.pick_file(move |path| {
        let _ = tx.send(path);
    });

    let file_path = match rx.await.map_err(|_| "dialog cancelled".to_string())? {
        Some(path) => path,
        None => return Ok(None),
    };
    let path = file_path.as_path().ok_or("invalid path")?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_is_sniffed_from_the_extension() {
        assert_eq!(sniff_mime("photo.PNG"), "image/png");
        assert_eq!(sniff_mime("a/b/photo.jpg"), "image/jpeg");
        assert_eq!(sniff_mime("notes.md"), "text/markdown");
        assert_eq!(sniff_mime("main.rs"), "text/plain");
        assert_eq!(sniff_mime("mystery"), "application/octet-stream");
    }

    #[test]
    fn text_mimes_are_recognized_for_the_file_kind() {
        assert!(is_text_mime("text/plain"));
        assert!(is_text_mime("text/markdown"));
        assert!(is_text_mime("application/json"));
        assert!(!is_text_mime("image/png"));
    }

    #[tokio::test]
    async fn reading_a_real_file_returns_its_bytes_and_name() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        std::fs::write(&path, b"# hello").unwrap();
        let file = read_file(path.to_string_lossy().as_ref()).await.unwrap();
        assert_eq!(file.name, "notes.md");
        assert_eq!(file.mime, "text/markdown");
        assert!(file.is_text);
        assert_eq!(file.size, 7);
        assert_eq!(
            String::from_utf8(
                base64::engine::general_purpose::STANDARD
                    .decode(&file.bytes_base64)
                    .unwrap()
            )
            .unwrap(),
            "# hello"
        );
    }

    #[tokio::test]
    async fn image_file_is_marked_non_text() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("photo.png");
        std::fs::write(&path, [0x89, b'P', b'N', b'G']).unwrap();
        let file = read_file(path.to_string_lossy().as_ref()).await.unwrap();
        assert!(!file.is_text);
    }

    #[tokio::test]
    async fn a_missing_file_reports_the_path() {
        let err = read_file("/nonexistent/nope.txt").await.unwrap_err();
        assert!(err.contains("nope.txt"), "unexpected error: {err}");
    }

    #[tokio::test]
    async fn a_file_over_the_cap_is_refused_rather_than_loaded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.bin");
        std::fs::write(&path, vec![0u8; (MAX_FILE_BYTES + 1) as usize]).unwrap();
        let err = read_file(path.to_string_lossy().as_ref())
            .await
            .unwrap_err();
        assert!(err.contains("too large"), "unexpected error: {err}");
    }

    /// A workspace root holding `PLANS/FOO.md`, plus a directory outside it.
    fn message_path_fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let workspace = root.join("workspace");
        std::fs::create_dir_all(workspace.join("PLANS")).unwrap();
        std::fs::write(workspace.join("PLANS/FOO.md"), b"# plan").unwrap();
        let outside = root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), b"secret").unwrap();
        (dir, workspace, outside)
    }

    #[test]
    fn a_relative_path_resolves_against_the_workspace_root() {
        let (_dir, workspace, _outside) = message_path_fixture();
        let roots = vec![workspace.clone()];
        assert_eq!(
            resolve_under_roots(&roots, " PLANS/FOO.md ").unwrap(),
            workspace.join("PLANS/FOO.md")
        );
    }

    #[test]
    fn a_second_root_is_tried_when_the_first_has_no_such_file() {
        let (_dir, workspace, outside) = message_path_fixture();
        let roots = vec![workspace, outside.clone()];
        assert_eq!(
            resolve_under_roots(&roots, "secret.txt").unwrap(),
            outside.join("secret.txt")
        );
    }

    #[test]
    fn traversal_out_of_every_root_is_refused() {
        let (_dir, workspace, _outside) = message_path_fixture();
        let roots = vec![workspace];
        let err = resolve_under_roots(&roots, "PLANS/../../outside/secret.txt").unwrap_err();
        assert!(err.contains("secret.txt"), "unexpected error: {err}");
    }

    #[test]
    fn an_absolute_path_outside_every_root_is_refused() {
        let (_dir, workspace, outside) = message_path_fixture();
        let roots = vec![workspace];
        let absolute = outside.join("secret.txt");
        let err = resolve_under_roots(&roots, absolute.to_string_lossy().as_ref()).unwrap_err();
        assert!(err.contains("secret.txt"), "unexpected error: {err}");
    }

    #[test]
    fn an_absolute_path_inside_a_root_resolves() {
        let (_dir, workspace, _outside) = message_path_fixture();
        let roots = vec![workspace.clone()];
        let absolute = workspace.join("PLANS/FOO.md");
        assert_eq!(
            resolve_under_roots(&roots, absolute.to_string_lossy().as_ref()).unwrap(),
            absolute
        );
    }

    #[test]
    fn a_symlink_escaping_the_root_is_refused() {
        let (_dir, workspace, outside) = message_path_fixture();
        let link = workspace.join("escape.txt");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.join("secret.txt"), &link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(outside.join("secret.txt"), &link).unwrap();
        let roots = vec![workspace];
        let err = resolve_under_roots(&roots, "escape.txt").unwrap_err();
        assert!(err.contains("escape.txt"), "unexpected error: {err}");
    }

    #[test]
    fn a_directory_is_not_a_file_to_open() {
        let (_dir, workspace, _outside) = message_path_fixture();
        let roots = vec![workspace];
        let err = resolve_under_roots(&roots, "PLANS").unwrap_err();
        assert!(err.contains("PLANS"), "unexpected error: {err}");
    }

    #[test]
    fn nothing_resolves_without_a_root() {
        let (_dir, workspace, _outside) = message_path_fixture();
        let absolute = workspace.join("PLANS/FOO.md");
        assert!(resolve_under_roots(&[], "PLANS/FOO.md").is_err());
        assert!(resolve_under_roots(&[], absolute.to_string_lossy().as_ref()).is_err());
        assert!(resolve_under_roots(&[workspace], "  ").is_err());
    }
}
