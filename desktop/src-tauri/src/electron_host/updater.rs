//! Preserve the existing updater trust root while replacing the outer Electron bundle.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{Manager, Resource};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio_util::sync::CancellationToken;

struct ElectronUpdate {
    update: Update,
    downloaded: Mutex<Option<Vec<u8>>>,
    download_gate: tokio::sync::Mutex<()>,
    cancelled: CancellationToken,
}

impl Resource for ElectronUpdate {
    fn close(self: Arc<Self>) {
        self.cancelled.cancel();
        if let Ok(mut bytes) = self.downloaded.lock() {
            bytes.take();
        }
    }
}

async fn until_cancelled<T>(
    cancelled: &CancellationToken,
    operation: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::select! {
        biased;
        _ = cancelled.cancelled() => Err("Update was cancelled because its desktop view closed".into()),
        result = operation => result,
    }
}

/// Download and verify into a cancellable native resource owned by the desktop.
#[tauri::command]
pub(crate) async fn electron_download_update(
    webview: tauri::Webview,
    rid: tauri::ResourceId,
) -> Result<(), String> {
    let resource = webview
        .resources_table()
        .get::<ElectronUpdate>(rid)
        .map_err(|error| error.to_string())?;
    let _download = resource
        .download_gate
        .try_lock()
        .map_err(|_| "Update download is already running")?;
    let mut update = resource.update.clone();
    update.timeout = Some(std::time::Duration::from_secs(15 * 60));
    let bytes = until_cancelled(&resource.cancelled, async {
        update
            .download(|_, _| {}, || {})
            .await
            .map_err(|error| error.to_string())
    })
    .await?;
    if resource.cancelled.is_cancelled() {
        return Err("Update was cancelled".into());
    }
    *resource
        .downloaded
        .lock()
        .map_err(|_| "Update storage is unavailable")? = Some(bytes);
    Ok(())
}

/// Install only the signature-verified bytes attached to this native update.
#[tauri::command]
pub(crate) async fn electron_install_update(
    webview: tauri::Webview,
    rid: tauri::ResourceId,
) -> Result<(), String> {
    let resource = webview
        .resources_table()
        .get::<ElectronUpdate>(rid)
        .map_err(|error| error.to_string())?;
    if resource.cancelled.is_cancelled() {
        return Err("Update was cancelled".into());
    }
    let bytes = resource
        .downloaded
        .lock()
        .map_err(|_| "Update storage is unavailable")?
        .take()
        .ok_or("Download and verify this update before installing")?;
    match resource.update.install(&bytes) {
        Ok(()) => Ok(()),
        Err(error) => {
            if !resource.cancelled.is_cancelled() {
                *resource
                    .downloaded
                    .lock()
                    .map_err(|_| "Update storage is unavailable")? = Some(bytes);
            }
            Err(error.to_string())
        }
    }
}

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
    headers: Option<std::collections::HashMap<String, String>>,
) -> Result<Option<UpdateMetadata>, String> {
    if !super::stable_profile() || !cfg!(buzz_updater_enabled) || !cfg!(target_os = "macos") {
        return Err("Updater not initialized: this private Electron build does not receive production updates".into());
    }
    let host = std::env::current_exe().map_err(|error| error.to_string())?;
    let executable = outer_executable(&host)?;
    let canonical = executable
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if canonical != executable {
        return Err("Updater will not replace an app through an executable symlink".into());
    }
    let mut builder = webview
        .updater_builder()
        .executable_path(executable)
        .timeout(std::time::Duration::from_secs(30));
    for (key, value) in headers.unwrap_or_default() {
        builder = builder
            .header(key, value)
            .map_err(|error| error.to_string())?;
    }
    let updater = builder.build().map_err(|error| error.to_string())?;
    let update = updater.check().await.map_err(|error| error.to_string())?;
    Ok(update.map(|update| UpdateMetadata {
        version: update.version.clone(),
        rid: webview.resources_table().add(ElectronUpdate {
            update,
            downloaded: Mutex::new(None),
            download_gate: tokio::sync::Mutex::new(()),
            cancelled: CancellationToken::new(),
        }),
    }))
}

#[cfg(test)]
mod tests {
    use super::{outer_executable, until_cancelled};
    use std::path::{Path, PathBuf};
    #[tokio::test]
    async fn closing_a_resource_cancels_an_unfinished_download() {
        let cancelled = tokio_util::sync::CancellationToken::new();
        let token = cancelled.clone();
        let waiting = tokio::spawn(async move {
            until_cancelled(&token, std::future::pending::<Result<Vec<u8>, String>>()).await
        });
        cancelled.cancel();
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), waiting)
            .await
            .unwrap()
            .unwrap();
        assert!(result.unwrap_err().contains("cancelled"));
    }

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
