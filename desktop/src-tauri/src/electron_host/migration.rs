//! Same-origin WebKit export for the first stable Electron launch.
//! No database scanning, logging, source writes, or provider/identity changes.
use std::sync::OnceLock;
use tokio::sync::{Mutex, Notify};

type Entries = Vec<(String, String)>;
#[derive(Default)]
struct Export {
    result: Option<Result<Entries, String>>,
    finished: bool,
}
static EXPORT: OnceLock<Mutex<Export>> = OnceLock::new();
static READY: Notify = Notify::const_new();

pub(crate) fn enabled() -> bool {
    (cfg!(feature = "electron-stable") || cfg!(feature = "onboarding-fixture"))
        && !cfg!(debug_assertions)
        && super::packaged()
}

fn valid_export_origin(label: &str, url: &url::Url) -> bool {
    label == "main" && url.as_str() == "tauri://localhost/electron-migration.html"
}

fn validate_entries(entries: &[(String, String)]) -> Result<(), String> {
    let allowed = |key: &str| {
        [
            "buzz-", "buzz.", "buzz:", "colony-", "colony.", "colony:", "sprout-",
        ]
        .iter()
        .any(|prefix| key.starts_with(prefix))
    };
    let mut keys = std::collections::HashSet::new();
    if entries.len() > 10_000
        || entries
            .iter()
            .any(|(key, _)| !allowed(key) || !keys.insert(key))
    {
        return Err("Saved app state could not be validated".into());
    }
    if serde_json::to_vec(entries)
        .map_err(|_| "Saved app state could not be encoded")?
        .len()
        > 8 * 1024 * 1024
    {
        return Err("Saved app state is too large to transfer".into());
    }
    Ok(())
}

/// Receive state only from the inert bundled page in the original application's origin.
#[tauri::command]
pub(crate) async fn electron_export_frontend_state(
    webview: tauri::Webview,
    entries: Entries,
    failed: bool,
) -> Result<(), String> {
    if !enabled()
        || !valid_export_origin(
            webview.label(),
            &webview.url().map_err(|_| "Migration origin unavailable")?,
        )
    {
        return Err("App state export is unavailable in this window".into());
    }
    let result = if failed {
        Err("Colony could not read the existing app state. Reopen Colony to retry.".into())
    } else {
        validate_entries(&entries).map(|()| entries)
    };
    let mut export = EXPORT.get_or_init(Default::default).lock().await;
    if !export.finished && export.result.is_none() {
        export.result = Some(result);
        READY.notify_waiters();
    }
    Ok(())
}

/// Return a bounded snapshot after the original WebKit origin has exported it.
#[tauri::command]
pub(crate) async fn electron_read_frontend_migration() -> Result<Entries, String> {
    if !enabled() {
        return Err("App state migration is unavailable in this build".into());
    }
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            let notified = READY.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let export = EXPORT.get_or_init(Default::default).lock().await;
                if export.finished {
                    return Err("App state migration has already finished".into());
                }
                if let Some(result) = &export.result {
                    return result.clone();
                }
            }
            notified.await;
        }
    })
    .await
    .map_err(|_| {
        "Colony could not finish reading its saved app state. Reopen Colony to retry.".to_string()
    })?
}

/// Drop the in-memory export only after Chromium has verified its durable import.
#[tauri::command]
pub(crate) async fn electron_finish_frontend_migration() -> Result<(), String> {
    if !enabled() {
        return Err("App state migration is unavailable in this build".into());
    }
    let mut export = EXPORT.get_or_init(Default::default).lock().await;
    export.finished = true;
    export.result = None;
    READY.notify_waiters();
    Ok(())
}

/// Fixed synthetic source for the separately compiled hosted migration proof only.
/// A production or candidate binary can never seed its WebKit store.
#[tauri::command]
pub(crate) fn electron_frontend_migration_fixture() -> Option<Entries> {
    #[cfg(feature = "onboarding-fixture")]
    if enabled()
        && !super::stable_profile()
        && std::env::var("COLONY_MIGRATION_PROOF").as_deref() == Ok("1")
    {
        return Some(vec![
            ("buzz-communities".into(), r#"[{"id":"proof-alpha","name":"Alpha","relayUrl":"wss://alpha.example.invalid","pubkey":"79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798","addedAt":"2026-09-09T00:00:00Z"},{"id":"proof-bravo","name":"Bravo","relayUrl":"wss://bravo.example.invalid","pubkey":"79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798","addedAt":"2026-09-09T00:00:00Z"}]"#.into()),
            ("buzz-active-community-id".into(), "proof-bravo".into()),
            ("buzz-machine-onboarding-complete.v2:79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798".into(), "true".into()),
            ("buzz-drafts.v1:migration-proof".into(), r#"{"thread:fixture":{"content":"Unsent migration proof"}}"#.into()),
            ("buzz-theme".into(), "github-dark".into()),
            ("buzz-follow-system".into(), "false".into()),
        ]);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_the_original_main_app_origin_can_export() {
        for (label, raw, allowed) in [
            ("main", "tauri://localhost/electron-migration.html", true),
            (
                "browser",
                "tauri://localhost/electron-migration.html",
                false,
            ),
            ("main", "https://example.com/electron-migration.html", false),
            ("main", "tauri://other/electron-migration.html", false),
            ("main", "tauri://localhost/index.html", false),
            (
                "main",
                "tauri://localhost/electron-migration.html?spoof=1",
                false,
            ),
        ] {
            assert_eq!(
                valid_export_origin(label, &url::Url::parse(raw).unwrap()),
                allowed
            );
        }
    }
    #[test]
    fn export_payload_is_bounded_and_app_scoped() {
        assert!(validate_entries(&[("buzz-communities".into(), "[]".into())]).is_ok());
        assert!(validate_entries(&[("other-site".into(), "value".into())]).is_err());
        assert!(
            validate_entries(&[("buzz-a".into(), "1".into()), ("buzz-a".into(), "2".into())])
                .is_err()
        );
        assert!(validate_entries(&[("buzz-a".into(), "x".repeat(8 * 1024 * 1024))]).is_err());
    }
}
