//! Preserve the existing updater trust root while replacing the outer Electron bundle.

use std::path::{Path, PathBuf};

#[derive(serde::Serialize)]
pub(crate) struct UpdateMetadata {
    rid: tauri::ResourceId,
    version: String,
}

fn outer_executable(host: &Path) -> Result<PathBuf, String> {
    let suffix = Path::new("Contents/Resources/native/buzz-desktop");
    if !host.ends_with(suffix) {
        return Err("Updater cannot locate the installed Colony app".into());
    }
    let bundle = host
        .ancestors()
        .nth(4)
        .ok_or("Updater app path is incomplete")?;
    if bundle.extension().and_then(|value| value.to_str()) != Some("app") {
        return Err("Updater requires an application bundle".into());
    }
    Ok(bundle.join("Contents/MacOS/buzz-desktop"))
}

/// Check the fixed signed feed for a stable Electron installation only.
#[tauri::command]
pub(crate) async fn electron_check_for_update(
    webview: tauri::Webview,
    timeout: Option<u64>,
) -> Result<Option<UpdateMetadata>, String> {
    if !super::stable_profile() || !cfg!(buzz_updater_enabled) || !cfg!(target_os = "macos") {
        return Err("Updater not initialized: this private Electron build does not receive production updates".into());
    }
    use tauri::Manager;
    use tauri_plugin_updater::UpdaterExt;
    let host = std::env::current_exe().map_err(|error| error.to_string())?;
    let executable = outer_executable(&host)?;
    let canonical = executable
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if canonical != executable {
        return Err("Updater will not replace an app through an executable symlink".into());
    }
    let updater = webview
        .updater_builder()
        .executable_path(executable)
        .timeout(std::time::Duration::from_millis(
            timeout.unwrap_or(30_000).clamp(1_000, 120_000),
        ))
        .build()
        .map_err(|error| error.to_string())?;
    let update = updater.check().await.map_err(|error| error.to_string())?;
    Ok(update.map(|update| UpdateMetadata {
        version: update.version.clone(),
        rid: webview.resources_table().add(update),
    }))
}

#[cfg(test)]
mod tests {
    use super::outer_executable;
    use std::path::{Path, PathBuf};

    #[test]
    fn update_replaces_outer_app_and_preserves_legacy_relaunch_executable() {
        assert_eq!(
            outer_executable(Path::new(
                "/Applications/Colony.app/Contents/Resources/native/buzz-desktop"
            )),
            Ok(PathBuf::from(
                "/Applications/Colony.app/Contents/MacOS/buzz-desktop"
            ))
        );
    }

    #[test]
    fn checkout_or_nested_helper_cannot_be_an_update_target() {
        for path in [
            "/checkout/target/release/colony-native-host",
            "/tmp/native/buzz-desktop",
            "/tmp/folder/Contents/Resources/native/buzz-desktop",
            "/Applications/Colony.app/Contents/MacOS/buzz-desktop",
        ] {
            assert!(outer_executable(Path::new(path)).is_err(), "{path}");
        }
    }
}
