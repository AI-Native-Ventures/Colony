//! Resolve and verify the offline model supplied by the installer.
use std::{fs::File, io::Read, path::PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};
#[cfg(not(feature = "electron-host"))]
use tauri::Manager;

#[derive(Deserialize)]
struct Manifest {
    filename: String,
    bytes: u64,
    sha256: String,
}

pub(crate) fn verified_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let manifest: Manifest = serde_json::from_str(include_str!("../../dictation-model.json"))
        .map_err(|_| "Invalid bundled dictation manifest.")?;
    let directory = resource_directory(app)?;
    let path = directory.join(&manifest.filename);
    let mut file = File::open(&path)
        .map_err(|_| "The offline dictation model is missing. Please reinstall Colony.")?;
    if file.metadata().map_err(|e| e.to_string())?.len() != manifest.bytes {
        return Err("The offline dictation model is damaged. Please reinstall Colony.".into());
    }
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 16_384];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    if format!("{:x}", hash.finalize()) != manifest.sha256 {
        return Err("The offline dictation model is damaged. Please reinstall Colony.".into());
    }
    Ok(path)
}

fn resource_directory(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/dictation");
        if source.join("ggml-base.en-q5_1.bin").is_file() {
            return Ok(source);
        }
    }
    #[cfg(feature = "electron-host")]
    {
        // Electron stages this next to Resources/native/buzz-desktop.
        std::env::current_exe()
            .map_err(|e| e.to_string())?
            .parent()
            .map(|parent| parent.join("dictation"))
            .ok_or_else(|| "Cannot locate offline dictation resources.".into())
    }
    #[cfg(not(feature = "electron-host"))]
    {
        _app.path()
            .resolve("dictation", tauri::path::BaseDirectory::Resource)
            .map_err(|e| e.to_string())
    }
}
