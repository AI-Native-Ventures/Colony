//! Read a local file for a workspace `file` or `image` tab.

use base64::Engine as _;
use serde::Serialize;

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
#[allow(dead_code)]
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
    Ok(WorkspaceFile {
        path: path.to_string(),
        name,
        mime: sniff_mime(path).to_string(),
        bytes_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        size: meta.len(),
    })
}

/// Read a local file for a workspace tab.
#[tauri::command]
pub async fn read_workspace_file(path: String) -> Result<WorkspaceFile, String> {
    read_file(&path).await
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
}
