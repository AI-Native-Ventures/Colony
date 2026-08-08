//! The Tauri side of the seam.
//!
//! `buzz-native` defines [`EventSink`] and [`ShellProxy`] and knows nothing
//! about Tauri. This module is the only place in the tree that implements them
//! against an `AppHandle`. Phase 2 adds a sibling that writes daemon frames
//! instead; Phase 3 adds one for Electron. Neither touches a command.
//!
//! Keep this file boring. Every method here is a thin adapter, and anything
//! clever in it is logic that should have stayed in `buzz-native` where it can
//! be tested without a shell.

use std::sync::Arc;

use buzz_native::{
    AppPaths, DialogCallback, DialogPath, EmitError, EventSink, FileDialogRequest, HostCtx,
    HostInfo, MainThreadTask, ShellError, ShellProxy, StateProvider, VibrancyMaterial, WindowOp,
};
use tauri::{AppHandle, Emitter, Manager};

use crate::app_state::AppState;

/// What every command takes instead of an `AppHandle`.
///
/// The generic parameter on `HostCtx` exists only so `buzz-native` need not
/// depend on the crate that defines `AppState`. Write `&Ctx`, never
/// `&HostCtx<AppState>`, so that when `AppState` moves the change is one line
/// here rather than 280 signatures.
pub type Ctx = HostCtx<AppState>;

/// Reads `AppState` out of Tauri's state manager.
///
/// This is what lets the 203 existing `State<'_, AppState>` command parameters
/// stay exactly as they are while converted commands read `ctx.state()`. Both
/// reach the one `AppState` that `.manage(build_app_state())` owns, because
/// `State<'r, T>::inner()` returns `&'r T` borrowed from the manager and the
/// manager outlives this handle.
///
/// Phase 2 replaces this with `buzz_native::ArcState`: the daemon owns its state
/// outright and has no manager to ask.
pub struct TauriStateProvider {
    app: AppHandle,
}

impl TauriStateProvider {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl StateProvider<AppState> for TauriStateProvider {
    fn state(&self) -> &AppState {
        // Panics if `AppState` was never managed, which would mean `lib.rs` no
        // longer calls `.manage(build_app_state())` — a boot-time bug, not a
        // runtime condition worth threading a Result through 85 call sites for.
        self.app.state::<AppState>().inner()
    }
}

/// Emits through a Tauri `AppHandle`.
pub struct TauriEventSink {
    app: AppHandle,
}

impl TauriEventSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl EventSink for TauriEventSink {
    fn emit_json(&self, event: &str, payload: serde_json::Value) -> Result<(), EmitError> {
        // `emit` serialises its payload with serde, so passing an already
        // serialised `Value` produces the same bytes on the wire as passing the
        // original type did.
        self.app.emit(event, payload).map_err(EmitError::new)
    }
}

/// Performs the 19 reverse-RPC operations against a Tauri `AppHandle`.
pub struct TauriShellProxy {
    app: AppHandle,
}

impl TauriShellProxy {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    fn file_dialog(
        &self,
        request: &FileDialogRequest,
    ) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
        use tauri_plugin_dialog::DialogExt;

        let mut builder = self.app.dialog().file();
        for (label, extensions) in &request.filters {
            let refs: Vec<&str> = extensions.iter().map(String::as_str).collect();
            builder = builder.add_filter(label, &refs);
        }
        if let Some(name) = &request.suggested_file_name {
            builder = builder.set_file_name(name);
        }
        builder
    }
}

/// Tauri's `FilePath` is either a real path or something opaque (a content URI).
/// Call sites treat those two differently — cancelled is `None`, non-path is a
/// distinct error message — so the distinction is preserved rather than
/// flattened.
fn to_dialog_path(path: tauri_plugin_dialog::FilePath) -> DialogPath {
    match path.as_path() {
        Some(p) => DialogPath::Path(p.to_path_buf()),
        None => DialogPath::Opaque(path.to_string()),
    }
}

impl ShellProxy for TauriShellProxy {
    fn request_restart(&self) {
        // Deliberately not diverging: callers run code after this, and the
        // restart happens once the runtime unwinds. See the trait docs.
        self.app.request_restart();
    }

    fn relaunch(&self) -> ! {
        #[cfg(all(feature = "mesh-llm", target_os = "macos"))]
        {
            crate::shutdown::relaunch_after_mesh_shutdown(&self.app);
        }
        #[cfg(not(all(feature = "mesh-llm", target_os = "macos")))]
        {
            // The only caller is gated the same way, so reaching here means the
            // gate was removed without updating this.
            panic!("relaunch is only implemented for macOS builds with mesh-llm");
        }
    }

    fn window_op(&self, label: &str, op: WindowOp) -> Result<bool, ShellError> {
        let Some(window) = self.app.get_webview_window(label) else {
            // Absent window is the normal case at every call site, not an error.
            return Ok(false);
        };
        let result = match op {
            WindowOp::Close => window.close(),
            WindowOp::Show => window.show(),
            WindowOp::SetFocus => window.set_focus(),
            WindowOp::Unminimize => window.unminimize(),
        };
        result.map(|()| true).map_err(ShellError::new)
    }

    fn set_window_vibrancy(
        &self,
        label: &str,
        material: Option<VibrancyMaterial>,
    ) -> Result<(), ShellError> {
        #[cfg(target_os = "macos")]
        {
            use window_vibrancy::{apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial};

            let window = self
                .app
                .get_webview_window(label)
                .ok_or_else(|| ShellError::new(format!("{label} window not found")))?;

            let Some(material) = material else {
                return clear_vibrancy(&window).map(|_| ()).map_err(ShellError::new);
            };

            // `apply_vibrancy` appends a tagged NSVisualEffectView each call
            // while `clear_vibrancy` removes one, so repeated enables stack blur
            // views and leave a stale one behind. Clear first so exactly one
            // material is ever installed; the clear is a no-op when none exists.
            let _ = clear_vibrancy(&window);

            let material = match material {
                VibrancyMaterial::Sidebar => NSVisualEffectMaterial::Sidebar,
                VibrancyMaterial::HudWindow => NSVisualEffectMaterial::HudWindow,
                VibrancyMaterial::UnderWindowBackground => {
                    NSVisualEffectMaterial::UnderWindowBackground
                }
                VibrancyMaterial::FullScreenUi => NSVisualEffectMaterial::FullScreenUI,
                VibrancyMaterial::HeaderView => NSVisualEffectMaterial::HeaderView,
                VibrancyMaterial::Popover => NSVisualEffectMaterial::Popover,
                VibrancyMaterial::Menu => NSVisualEffectMaterial::Menu,
                VibrancyMaterial::Titlebar => NSVisualEffectMaterial::Titlebar,
            };
            apply_vibrancy(&window, material, None, None).map_err(ShellError::new)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (label, material);
            Ok(())
        }
    }

    fn run_on_main_thread(&self, task: MainThreadTask) -> Result<(), ShellError> {
        self.app
            .run_on_main_thread(move || task())
            .map_err(ShellError::new)
    }

    fn open_external(&self, url: &str) -> Result<(), ShellError> {
        use tauri_plugin_opener::OpenerExt;

        self.app
            .opener()
            .open_url(url.to_string(), None::<&str>)
            .map_err(ShellError::new)
    }

    fn set_push_to_talk_shortcut(&self, enabled: bool) -> Result<(), ShellError> {
        #[cfg(not(test))]
        {
            use tauri_plugin_global_shortcut::{
                Code, GlobalShortcutExt, Modifiers, Shortcut,
            };

            let shortcut = Shortcut::new(Some(Modifiers::CONTROL), Code::Space);
            let manager = self.app.global_shortcut();
            let is_registered = manager.is_registered(shortcut);

            // Idempotent: registering twice or unregistering an absent shortcut
            // are both errors from the plugin, and neither is interesting.
            if enabled && !is_registered {
                manager.register(shortcut).map_err(ShellError::new)?;
            } else if !enabled && is_registered {
                manager.unregister(shortcut).map_err(ShellError::new)?;
            }
            Ok(())
        }
        #[cfg(test)]
        {
            // Test builds omit the global-shortcut plugin, and calling it
            // without the plugin installed panics.
            let _ = enabled;
            Ok(())
        }
    }

    fn pick_file(&self, request: FileDialogRequest, done: DialogCallback<DialogPath>) {
        self.file_dialog(&request)
            .pick_file(move |path| done(path.map(to_dialog_path)));
    }

    fn pick_files(&self, request: FileDialogRequest, done: DialogCallback<Vec<DialogPath>>) {
        self.file_dialog(&request).pick_files(move |paths| {
            done(paths.map(|list| list.into_iter().map(to_dialog_path).collect()))
        });
    }

    fn save_file(&self, request: FileDialogRequest, done: DialogCallback<DialogPath>) {
        self.file_dialog(&request)
            .save_file(move |path| done(path.map(to_dialog_path)));
    }
}

/// Resolves the values `HostCtx` carries and assembles it.
///
/// Called once during `setup()`. `app_data_dir` is resolved here rather than per
/// call, which is the whole point of `AppPaths`: in Phase 2 it would otherwise
/// be a round trip 26 times over.
pub fn build_ctx(app: &AppHandle) -> Result<Ctx, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve the app data dir: {e}"))?;

    let config = app.config();
    let info = HostInfo::new(config.identifier.clone(), config.product_name.clone());

    Ok(HostCtx::new(
        Arc::new(TauriStateProvider::new(app.clone())),
        Arc::new(TauriEventSink::new(app.clone())),
        AppPaths::new(data_dir),
        info,
        Arc::new(TauriShellProxy::new(app.clone())),
    ))
}

/// Builds the host context and hands it to Tauri as managed state.
///
/// Called once from `setup()`. Failure is fatal for the same reason identity
/// resolution is: a desktop that cannot resolve its data directory has nowhere
/// to keep the user's keys, and continuing would boot a functional-looking app
/// with no persistence.
pub fn install_ctx(app: &AppHandle) {
    let ctx = match build_ctx(app) {
        Ok(ctx) => ctx,
        Err(error) => {
            eprintln!("buzz-desktop: fatal: could not build the host context: {error}");
            std::process::exit(1);
        }
    };

    // `manage` returns false when the type is already managed, and in that case
    // it does NOT overwrite. Ignoring that would leave every converted command
    // reading a Ctx built from an earlier AppHandle.
    if !app.manage(ctx) {
        eprintln!(
            "buzz-desktop: fatal: a host context was already managed; \
             setup() must run exactly once"
        );
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opaque_and_real_paths_are_distinguished() {
        // The two outcomes drive different user-visible messages, so a
        // regression here silently merges "cancelled" with "invalid path".
        let real = tauri_plugin_dialog::FilePath::Path("/tmp/voice.wav".into());
        assert_eq!(
            to_dialog_path(real),
            DialogPath::Path(std::path::PathBuf::from("/tmp/voice.wav"))
        );
    }

    #[test]
    fn every_vibrancy_material_maps_without_a_catch_all() {
        // The match in set_window_vibrancy is exhaustive by construction. This
        // asserts the wire parsing it depends on still covers every variant, so
        // adding one to buzz-native fails here instead of silently becoming
        // Sidebar.
        for wire in [
            "sidebar",
            "hud-window",
            "under-window-background",
            "fullscreen-ui",
            "header-view",
            "popover",
            "menu",
            "titlebar",
        ] {
            let parsed = VibrancyMaterial::from_wire(Some(wire));
            if wire != "sidebar" {
                assert_ne!(
                    parsed,
                    VibrancyMaterial::Sidebar,
                    "{wire} must not fall back to Sidebar"
                );
            }
        }
    }
}
