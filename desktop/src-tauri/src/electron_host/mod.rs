//! Opt-in compatibility host for the Electron shell.
//!
//! The parent process owns the visible UI. Existing Tauri commands retain their
//! serialization and managed state until they are extracted into a standalone
//! Rust service. Ordinary Tauri builds never open this transport.

pub(crate) mod deep_links;
pub(crate) mod migration;
#[cfg(feature = "electron-host")]
mod runtime;
pub(crate) mod updater;
#[cfg(feature = "electron-host")]
mod wire;

#[cfg(all(feature = "electron-stable", feature = "onboarding-fixture"))]
compile_error!("A production Electron host cannot include onboarding fixture transport");

pub(crate) fn enabled() -> bool {
    cfg!(feature = "electron-host") && std::env::var("COLONY_ELECTRON_HOST").as_deref() == Ok("1")
}

/// Whether the Electron parent is running from an installed application bundle.
pub(crate) fn packaged() -> bool {
    enabled() && std::env::var("COLONY_ELECTRON_PACKAGED").as_deref() == Ok("1")
}

/// Only the separately compiled release host may select the stable data namespace.
pub(crate) fn stable_profile() -> bool {
    stable_profile_enabled(
        cfg!(feature = "electron-stable") && !cfg!(debug_assertions),
        packaged(),
        std::env::var("COLONY_ELECTRON_PROFILE_ID")
            .as_deref()
            .unwrap_or(""),
    )
}

fn stable_profile_enabled(release_build: bool, installed: bool, profile: &str) -> bool {
    release_build && installed && profile == "stable"
}

/// Profile-scoped native storage and keyring namespace supplied by the parent.
pub(crate) fn data_identifier() -> &'static str {
    static IDENTIFIER: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    IDENTIFIER.get_or_init(|| {
        if stable_profile() {
            return "xyz.block.buzz.app".into();
        }
        let profile = std::env::var("COLONY_ELECTRON_PROFILE_ID").unwrap_or_default();
        profile_identifier(&profile)
    })
}

fn profile_identifier(profile: &str) -> String {
    if profile.len() == 16 && profile.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        format!("xyz.block.buzz.app.dev-electron.{profile}")
    } else {
        "xyz.block.buzz.app.dev-electron".to_string()
    }
}

pub(crate) fn configure(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    #[cfg(feature = "electron-host")]
    if enabled() {
        return builder.channel_interceptor(runtime::channel);
    }
    builder
}

pub(crate) fn context(mut context: tauri::Context<tauri::Wry>) -> tauri::Context<tauri::Wry> {
    if enabled() {
        let config = context.config_mut();
        // Only the release host's explicit stable profile shares installed data.
        config.identifier = data_identifier().into();
        let migration = migration::enabled() && migration::verify_source_bundle().is_ok();
        for window in &mut config.app.windows {
            window.visible = false;
            window.focus = false;
            window.maximized = false;
            // WKWebView default storage follows the outer macOS bundle. A
            // candidate or explicit QA profile must not read stable WebKit data.
            window.incognito = !(stable_profile() || migration && migration::persistent_fixture());
            if migration {
                window.url = tauri::WebviewUrl::App("electron-migration.html".into());
            } else if let Ok(url) = url::Url::parse("about:blank") {
                window.url = tauri::WebviewUrl::External(url);
            }
        }
    }
    context
}

pub(crate) fn start(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(feature = "electron-host")]
    if enabled() {
        runtime::start(app.clone())?;
    }
    #[cfg(not(feature = "electron-host"))]
    let _ = app;
    Ok(())
}

/// Keep the global CLI link owned by the existing Tauri installation during migration.
pub(crate) fn ensure_cli_symlink(is_dev_nest: bool) {
    if enabled() && !stable_profile() {
        return;
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            if let Err(error) = crate::managed_agents::ensure_cli_symlink(parent, is_dev_nest) {
                eprintln!("buzz-desktop: failed to create CLI symlink: {error}");
            }
        }
    }
}

/// The Electron parent owns single-instance coordination; the stdio child must
/// never forward to an unrelated helper and silently exit before its handshake.
pub(crate) fn single_instance(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    if enabled() && !stable_profile() {
        return builder;
    }
    builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_focus();
        }
        for arg in &argv {
            if arg.starts_with("buzz://") {
                crate::handle_deep_link_url(app, arg);
            }
        }
    }))
}

#[cfg(test)]
mod profile_tests {
    use super::{profile_identifier, stable_profile_enabled};

    #[test]
    fn stable_storage_requires_a_release_host_and_explicit_stable_profile() {
        assert!(stable_profile_enabled(true, true, "stable"));
        assert!(!stable_profile_enabled(false, true, "stable"));
        assert!(!stable_profile_enabled(true, false, "stable"));
        assert!(!stable_profile_enabled(true, true, "1234567890abcdef"));
        assert!(!stable_profile_enabled(true, true, ""));
    }

    #[test]
    fn profiles_have_distinct_native_namespaces() {
        assert_ne!(
            profile_identifier("1111111111111111"),
            profile_identifier("2222222222222222")
        );
        assert_eq!(
            profile_identifier("../../production"),
            profile_identifier("")
        );
        assert_eq!(profile_identifier("short"), profile_identifier(""));
        assert_eq!(
            profile_identifier("1234567890abcdef"),
            "xyz.block.buzz.app.dev-electron.1234567890abcdef"
        );
    }
}
