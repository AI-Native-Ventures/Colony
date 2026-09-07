//! Opt-in compatibility host for the Electron shell.
//!
//! The parent process owns the visible UI. Existing Tauri commands retain their
//! serialization and managed state until they are extracted into a standalone
//! Rust service. Ordinary Tauri builds never open this transport.

#[cfg(feature = "electron-host")]
mod runtime;
#[cfg(feature = "electron-host")]
mod wire;

pub(crate) fn enabled() -> bool {
    cfg!(feature = "electron-host") && std::env::var("COLONY_ELECTRON_HOST").as_deref() == Ok("1")
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
        // Development migration never opens stable app data or existing views.
        config.identifier = "xyz.block.buzz.app.dev-electron".into();
        for window in &mut config.app.windows {
            window.visible = false;
            window.focus = false;
            window.maximized = false;
            if let Ok(url) = url::Url::parse("about:blank") {
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
    if enabled() {
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
    if enabled() {
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
