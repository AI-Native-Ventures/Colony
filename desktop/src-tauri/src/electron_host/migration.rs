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

fn persistent_fixture_allowed(release_fixture: bool, hosted: bool, mode: &str) -> bool {
    release_fixture && hosted && matches!(mode, "legacy-seed" | "legacy-read" | "import")
}

/// Only the separately compiled hosted fixture can select its own persistent store.
pub(super) fn persistent_fixture() -> bool {
    persistent_fixture_allowed(
        cfg!(feature = "onboarding-fixture") && enabled(),
        std::env::var("GITHUB_ACTIONS").as_deref() == Ok("true"),
        &std::env::var("COLONY_MIGRATION_PROOF").unwrap_or_default(),
    )
}

#[cfg(target_os = "macos")]
fn legacy_fixture() -> bool {
    persistent_fixture()
        && matches!(
            std::env::var("COLONY_MIGRATION_PROOF").as_deref(),
            Ok("legacy-seed" | "legacy-read")
        )
}

#[cfg(any(target_os = "macos", test))]
fn source_bundle_matches(identifier: Option<&str>, fixture: bool) -> bool {
    identifier
        == Some(if fixture {
            "ventures.ainative.colony.onboarding-fixture"
        } else {
            "xyz.block.buzz.app"
        })
}

#[cfg(any(target_os = "macos", test))]
fn containing_app(host: &std::path::Path, legacy: bool) -> Result<&std::path::Path, &'static str> {
    let suffix = if legacy {
        "Contents/MacOS/buzz-desktop"
    } else {
        "Contents/Resources/native/buzz-desktop"
    };
    if !host.ends_with(suffix) {
        return Err("Native helper is outside its installed app layout");
    }
    let app = host
        .ancestors()
        .nth(if legacy { 3 } else { 4 })
        .ok_or("Native app path is incomplete")?;
    if app.extension().and_then(|value| value.to_str()) != Some("app") {
        return Err("Native helper requires its containing application");
    }
    Ok(app)
}

pub(super) fn verify_source_bundle() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Embedded helper metadata cannot authorize a standalone binary.
        // Independently validate its real containing app first. Production
        // signing and notarization remain separate release gates.
        let host = std::env::current_exe().map_err(|_| "Native app path unavailable")?;
        let legacy = legacy_fixture();
        let app = containing_app(&host, legacy)?;
        let info = app.join("Contents/Info.plist");
        if host
            .canonicalize()
            .map_err(|_| "Native app path unavailable")?
            != host
            || info
                .canonicalize()
                .map_err(|_| "Native app metadata unavailable")?
                != info
        {
            return Err("Native app storage cannot be selected through a symlink".into());
        }
        let metadata: plist::Dictionary =
            plist::from_file(&info).map_err(|_| "Native app metadata could not be read")?;
        let fixture = cfg!(feature = "onboarding-fixture");
        if !source_bundle_matches(
            metadata
                .get("CFBundleIdentifier")
                .and_then(plist::Value::as_string),
            fixture,
        ) {
            return Err("Native helper and containing app identities do not match".into());
        }
        let executable = if fixture && !legacy {
            "Colony Onboarding Fixture"
        } else {
            "buzz-desktop"
        };
        if metadata
            .get("CFBundleExecutable")
            .and_then(plist::Value::as_string)
            != Some(executable)
        {
            return Err("Native helper is not inside the expected Colony app".into());
        }
        let outer = app.join("Contents/MacOS").join(executable);
        if outer
            .canonicalize()
            .map_err(|_| "Colony executable unavailable")?
            != outer
        {
            return Err("Colony executable must remain inside its application".into());
        }
        // Matching Tauri's configured data directory alone does not establish
        // WebKit's process identity. Require NSBundle to resolve the same ID.
        let identifier = objc2_foundation::NSBundle::mainBundle()
            .bundleIdentifier()
            .map(|value| value.to_string());
        if source_bundle_matches(identifier.as_deref(), fixture) {
            Ok(())
        } else {
            Err(format!(
                "Colony could not identify its original app storage (native bundle: {}). Your original data is unchanged.",
                identifier.as_deref().unwrap_or("unbundled")
            ))
        }
    }
    #[cfg(not(target_os = "macos"))]
    Err("App state migration is available only on macOS".into())
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
    verify_source_bundle()?;
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
        && persistent_fixture()
        && std::env::var("COLONY_MIGRATION_PROOF").as_deref() == Ok("legacy-seed")
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
    fn persistent_proof_modes_never_authorize_a_production_or_unhosted_binary() {
        for mode in ["legacy-seed", "legacy-read", "import"] {
            assert!(persistent_fixture_allowed(true, true, mode));
            assert!(!persistent_fixture_allowed(false, true, mode));
            assert!(!persistent_fixture_allowed(true, false, mode));
        }
        for mode in ["", "1", "stable", "production"] {
            assert!(!persistent_fixture_allowed(true, true, mode));
        }
    }
    #[test]
    fn helper_metadata_cannot_authorize_a_standalone_or_wrong_layout_binary() {
        use std::path::Path;
        assert_eq!(
            containing_app(
                Path::new("/Applications/Colony.app/Contents/Resources/native/buzz-desktop"),
                false
            )
            .unwrap(),
            Path::new("/Applications/Colony.app")
        );
        for path in [
            "/tmp/buzz-desktop",
            "/tmp/Colony/Contents/Resources/native/buzz-desktop",
            "/tmp/Colony.app/Contents/MacOS/buzz-desktop",
            "/tmp/Colony.app/Contents/Resources/native/other",
        ] {
            assert!(containing_app(Path::new(path), false).is_err());
        }
        assert_eq!(
            containing_app(
                Path::new("/tmp/Fixture.app/Contents/MacOS/buzz-desktop"),
                true
            )
            .unwrap(),
            Path::new("/tmp/Fixture.app")
        );
        assert!(containing_app(
            Path::new("/tmp/Fixture.app/Contents/Resources/native/buzz-desktop"),
            true
        )
        .is_err());
    }
    #[test]
    fn migration_requires_the_expected_process_bundle_not_only_the_data_identifier() {
        assert!(source_bundle_matches(Some("xyz.block.buzz.app"), false));
        assert!(source_bundle_matches(
            Some("ventures.ainative.colony.onboarding-fixture"),
            true
        ));
        assert!(!source_bundle_matches(None, false));
        assert!(!source_bundle_matches(Some("xyz.block.buzz.app"), true));
        assert!(!source_bundle_matches(Some("unrelated.app"), false));
    }
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
