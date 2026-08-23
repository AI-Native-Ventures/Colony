//! Legacy personas.json field rename: `provider` → `runtime`.
//!
//! Split from `migration.rs` (file-size guard). Runs before the unified-store
//! fold so pre-fold stores keep resolving harnesses; post-fold stores have no
//! `personas.json` and this is a no-op.

use std::path::Path;

use tauri::Manager as _;

/// Rename the legacy `provider` key to `runtime` in every personas.json
/// object that does not already carry a runtime.
pub(crate) fn rename_provider_to_runtime_in_personas(path: &Path) {
    super::patch_json_records(path, |obj| {
        if obj.contains_key("runtime") {
            return false;
        }
        if let Some(value) = obj.remove("provider") {
            obj.insert("runtime".to_string(), value);
            true
        } else {
            false
        }
    });
}

pub fn migrate_persona_provider_to_runtime(app: &tauri::AppHandle) {
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    let path = dir.join("agents/personas.json");
    if !path.exists() {
        return;
    }
    rename_provider_to_runtime_in_personas(&path);
}
