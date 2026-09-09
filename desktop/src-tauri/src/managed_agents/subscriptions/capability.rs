//! Cache installed-binary compatibility; probes use a fresh credential-free profile.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::SystemTime,
};
use tokio::io::AsyncReadExt;

type CacheKey = (String, PathBuf, u64, SystemTime);
static SUPPORTED: LazyLock<Mutex<HashMap<CacheKey, bool>>> = LazyLock::new(Mutex::default);

pub(crate) async fn launch_error(runtime: &str, binary: &Path) -> Option<String> {
    if !crate::electron_host::enabled() || !cfg!(target_os = "macos") {
        return Some("Subscription teammates require the Electron desktop app on macOS.".into());
    }
    check(runtime, binary).await.err()
}

async fn check(runtime: &str, binary: &Path) -> Result<(), String> {
    let metadata = std::fs::metadata(binary).map_err(|_| "The provider app is unavailable")?;
    let key = (
        runtime.to_owned(),
        binary.to_owned(),
        metadata.len(),
        metadata
            .modified()
            .map_err(|_| "The provider version is unavailable")?,
    );
    if SUPPORTED
        .lock()
        .map_err(|_| "Compatibility check is unavailable")?
        .get(&key)
        == Some(&true)
    {
        return Ok(());
    }
    let helper = crate::managed_agents::find_command("buzz-acp")
        .ok_or("Colony's subscription runtime is unavailable. Reinstall this beta.")?;
    let directory = std::env::temp_dir().join(format!(
        "colony-subscription-capability-{}",
        uuid::Uuid::new_v4()
    ));
    crate::managed_agents::isolation::launch::private_directory(&directory)?;
    crate::managed_agents::isolation::launch::private_directory(&directory.join("tmp"))?;
    let result = probe(&helper, runtime, binary, &directory).await;
    let _ = std::fs::remove_dir_all(&directory);
    if result.is_ok() {
        SUPPORTED
            .lock()
            .map_err(|_| "Compatibility check is unavailable")?
            .insert(key, true);
    }
    result
}

async fn probe(
    helper: &Path,
    runtime: &str,
    binary: &Path,
    directory: &Path,
) -> Result<(), String> {
    use std::process::Stdio;
    let mut command = tokio::process::Command::new(helper);
    super::environment::dedicated(&mut command, directory, "HOME");
    let mut child = command
        .args(["--subscription-capability", runtime])
        .arg(binary)
        .arg(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "The provider compatibility check could not start")?;
    let output = child
        .stdout
        .take()
        .ok_or("Compatibility response is unavailable")?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(45), async {
        let mut bytes = Vec::new();
        output
            .take(16385)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "Compatibility check ended")?;
        let status = child
            .wait()
            .await
            .map_err(|_| "Compatibility check ended")?;
        if bytes.len() > 16384 || !status.success() {
            return Err(
                "Update Colony and the provider app to use subscription teammates.".to_string(),
            );
        }
        let response: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|_| "Update Colony to check provider compatibility.")?;
        if response["supported"] == true {
            return Ok(());
        }
        Err(response["reason"]
            .as_str()
            .unwrap_or(
                "This provider version cannot run isolated teammates. Update it and check again.",
            )
            .to_owned())
    })
    .await
    .map_err(|_| "Provider compatibility check timed out. Try again.".to_string())?;
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}
