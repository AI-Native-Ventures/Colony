use crate::commands::export_util::save_bytes_with_dialog;
use crate::commands::media::sanitize_filename;

/// Largest export accepted, in bytes.
///
/// A lead row is well under a kilobyte, so this is roughly a hundred
/// thousand leads. The bound exists so a renderer bug cannot ask this
/// process to allocate an unbounded buffer, not because a real export
/// approaches it.
const MAX_CSV_BYTES: usize = 64 * 1024 * 1024;

/// Write a leads CSV through the native save-file dialog.
///
/// The renderer renders the CSV, because it holds the leads and the filters
/// currently in view; this process owns the filesystem. Returns `false` when
/// the person cancelled the dialog, which is not an error and must not be
/// reported as one.
#[tauri::command]
pub async fn save_leads_csv(
    csv: String,
    filename: String,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    if csv.len() > MAX_CSV_BYTES {
        return Err("that export is too large to write in one file".to_string());
    }
    // `sanitize_filename` keeps a caller-supplied name from escaping the
    // chosen directory; the dialog then lets the person override it anyway.
    let filename = sanitize_filename(&filename);
    let filename = if filename.to_ascii_lowercase().ends_with(".csv") {
        filename
    } else {
        format!("{filename}.csv")
    };
    save_bytes_with_dialog(&app, &filename, "CSV spreadsheet", &["csv"], csv.as_bytes()).await
}
