//! Reverse RPC: the small set of things the core cannot do for itself.
//!
//! Everything else in this crate is computation the core owns. This module is
//! the opposite: operations that only the shell process can perform, because
//! they touch windows, native dialogs, the main thread, or the process itself.
//!
//! There are 19 such call sites in the tree, and the list is deliberately short.
//! Every method here becomes a request travelling *from* the daemon *to* the
//! shell in Phase 2, so each one is latency, a failure mode, and a protocol
//! message. Adding one is a contract change; route it through ticket 1.0 rather
//! than growing the trait from a conversion ticket.

use std::path::{Path, PathBuf};

/// A reverse-RPC call failed.
///
/// In Phase 1 this wraps a Tauri error string. In Phase 2 it additionally covers
/// transport failure, which is new: today these calls cannot fail to be
/// *delivered*.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ShellError(pub String);

impl ShellError {
    pub fn new(message: impl std::fmt::Display) -> Self {
        Self(message.to_string())
    }
}

/// Operations performed on an existing window.
///
/// Modelled as a closed enum rather than a window handle on purpose: handing
/// out a live window object would mean shipping something across the Phase 2
/// boundary that cannot be serialised.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowOp {
    /// `huddle/window.rs` closing a huddle companion.
    Close,
    /// `deep_link.rs` raising the main window.
    Show,
    /// `lib.rs` single-instance focus, `deep_link.rs`, `huddle/window.rs`.
    SetFocus,
    /// `deep_link.rs`, before `Show`.
    Unminimize,
}

/// macOS `NSVisualEffectMaterial` values used by `set_window_vibrancy`.
///
/// Unknown strings fall back to `Sidebar`, matching the command's documented
/// behavior.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VibrancyMaterial {
    Sidebar,
    HudWindow,
    UnderWindowBackground,
    FullScreenUi,
    HeaderView,
    Popover,
    Menu,
    Titlebar,
}

impl VibrancyMaterial {
    /// Parses the wire strings the frontend sends. Anything unrecognised, and
    /// `None`, become `Sidebar` — preserving `commands/window_vibrancy.rs`.
    pub fn from_wire(value: Option<&str>) -> Self {
        match value {
            Some("hud-window") => Self::HudWindow,
            Some("under-window-background") => Self::UnderWindowBackground,
            Some("fullscreen-ui") => Self::FullScreenUi,
            Some("header-view") => Self::HeaderView,
            Some("popover") => Self::Popover,
            Some("menu") => Self::Menu,
            Some("titlebar") => Self::Titlebar,
            _ => Self::Sidebar,
        }
    }
}

/// A path chosen in a native file dialog.
///
/// Not a plain `PathBuf`: Tauri's `FilePath` can be a URL rather than a path,
/// and every call site distinguishes the two — cancelling gives `None`, while a
/// non-path selection is a distinct error ("the selected voice path is
/// invalid", "Save dialog returned an invalid path"). Collapsing both into
/// `Option<PathBuf>` would merge two user-visible messages into one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DialogPath {
    Path(PathBuf),
    /// A selection that is not a filesystem path, e.g. a content URI.
    Opaque(String),
}

impl DialogPath {
    /// `Some` only for real filesystem paths. Mirrors `FilePath::as_path`.
    pub fn as_path(&self) -> Option<&Path> {
        match self {
            Self::Path(path) => Some(path),
            Self::Opaque(_) => None,
        }
    }
}

/// What to show in a file dialog.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileDialogRequest {
    /// `(label, extensions)`, as passed to `add_filter`. Empty means no filter.
    pub filters: Vec<(String, Vec<String>)>,
    /// Prefilled name for save dialogs (`set_file_name`).
    pub suggested_file_name: Option<String>,
}

impl FileDialogRequest {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_filter(mut self, label: impl Into<String>, extensions: &[&str]) -> Self {
        self.filters.push((
            label.into(),
            extensions.iter().map(|e| (*e).to_string()).collect(),
        ));
        self
    }

    pub fn with_file_name(mut self, name: impl Into<String>) -> Self {
        self.suggested_file_name = Some(name.into());
        self
    }
}

/// Dialogs answer through a callback, not a return value, because the native
/// picker is modal on its own thread. Call sites bridge to `async` with a
/// oneshot channel; that stays their business.
pub type DialogCallback<T> = Box<dyn FnOnce(Option<T>) + Send + 'static>;

/// Work that must run on the platform main thread.
pub type MainThreadTask = Box<dyn FnOnce() + Send + 'static>;

/// The shell, as the core sees it.
///
/// Object-safe: `HostCtx` holds `Arc<dyn ShellProxy>`.
pub trait ShellProxy: Send + Sync {
    /// Ask the shell to restart the application after a clean shutdown.
    ///
    /// 6 call sites (`commands/identity.rs`, `commands/mesh_llm.rs` ×3,
    /// `mesh_llm/recovery.rs`, `mesh_llm/coordinator.rs`).
    ///
    /// **Does not diverge.** Every caller runs code afterwards — `identity.rs`
    /// returns `Ok(())`, `mesh_llm.rs` returns a status. The restart happens
    /// once the runtime unwinds, which is what avoids a single-instance race.
    /// Anyone tempted to give this `-> !` will change behavior.
    fn request_restart(&self);

    /// Relaunch immediately, without waiting for a normal shutdown.
    ///
    /// This is **not** `request_restart`. `shutdown.rs::relaunch_after_mesh_shutdown`
    /// tears down single-instance state, spawns a fresh binary with the current
    /// arguments, and hard-exits. It needs the process environment and the
    /// current binary path, neither of which the core has.
    ///
    /// Only reachable on macOS with the `mesh-llm` feature.
    fn relaunch(&self) -> !;

    /// Apply `op` to the window labelled `label`.
    ///
    /// Returns `Ok(false)` when no such window exists, which is the common case
    /// at every call site — all five look up the window and silently do nothing
    /// if it is gone. Errors from the operation itself are `Err`; callers today
    /// log them and continue.
    fn window_op(&self, label: &str, op: WindowOp) -> Result<bool, ShellError>;

    /// Install or clear the macOS vibrancy effect on a window.
    ///
    /// **This one can never move out of the shell.** `window_vibrancy::apply_vibrancy`
    /// needs the underlying `NSWindow`, so unlike the other window operations it
    /// is not merely convenient to do shell-side, it is impossible to do
    /// anywhere else. `None` clears.
    ///
    /// The implementation must clear before applying: `apply_vibrancy` appends a
    /// tagged `NSVisualEffectView` each call while `clear_vibrancy` removes one,
    /// so repeated enables stack blur views and leave a stale one behind.
    fn set_window_vibrancy(
        &self,
        label: &str,
        material: Option<VibrancyMaterial>,
    ) -> Result<(), ShellError>;

    /// Run `task` on the platform main thread.
    ///
    /// 2 call sites, both in `commands/media_download.rs`, both because
    /// `arboard` requires main-thread access to the clipboard on macOS.
    fn run_on_main_thread(&self, task: MainThreadTask) -> Result<(), ShellError>;

    /// Open a URL in the user's browser.
    ///
    /// Exactly 1 call site: `commands/openrouter_connect.rs`, via `app.opener()`.
    ///
    /// Note for anyone reading the daemon contract: this is the real
    /// `shell.openExternal`. The contract originally attributed it to
    /// `app.shell()`, which has **zero** call sites in this tree, and so listed
    /// a method against nothing while omitting `request_restart`.
    fn open_external(&self, url: &str) -> Result<(), ShellError>;

    /// Register or unregister the push-to-talk global shortcut (Ctrl+Space).
    ///
    /// Narrow by design. This is the only global shortcut in the tree, so the
    /// trait exposes the intent rather than a general shortcut manager — a
    /// generic one would be protocol surface with no caller.
    ///
    /// Must be idempotent and best-effort: `ptt_shortcut.rs` checks
    /// `is_registered` before acting and treats failure as non-fatal, because
    /// huddles still work in VAD mode without the shortcut.
    fn set_push_to_talk_shortcut(&self, enabled: bool) -> Result<(), ShellError>;

    /// Native open-file dialog, single selection.
    fn pick_file(&self, request: FileDialogRequest, done: DialogCallback<DialogPath>);

    /// Native open-file dialog, multiple selection.
    fn pick_files(&self, request: FileDialogRequest, done: DialogCallback<Vec<DialogPath>>);

    /// Native save-file dialog.
    fn save_file(&self, request: FileDialogRequest, done: DialogCallback<DialogPath>);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_and_missing_vibrancy_materials_fall_back_to_sidebar() {
        assert_eq!(
            VibrancyMaterial::from_wire(Some("popover")),
            VibrancyMaterial::Popover
        );
        assert_eq!(
            VibrancyMaterial::from_wire(Some("not-a-material")),
            VibrancyMaterial::Sidebar
        );
        assert_eq!(VibrancyMaterial::from_wire(None), VibrancyMaterial::Sidebar);
    }

    #[test]
    fn every_wire_material_round_trips() {
        for (wire, expected) in [
            ("hud-window", VibrancyMaterial::HudWindow),
            (
                "under-window-background",
                VibrancyMaterial::UnderWindowBackground,
            ),
            ("fullscreen-ui", VibrancyMaterial::FullScreenUi),
            ("header-view", VibrancyMaterial::HeaderView),
            ("popover", VibrancyMaterial::Popover),
            ("menu", VibrancyMaterial::Menu),
            ("titlebar", VibrancyMaterial::Titlebar),
            ("sidebar", VibrancyMaterial::Sidebar),
        ] {
            assert_eq!(VibrancyMaterial::from_wire(Some(wire)), expected, "{wire}");
        }
    }

    #[test]
    fn opaque_dialog_paths_are_not_paths() {
        // The distinction exists so "cancelled" and "invalid path" stay
        // separate user-visible outcomes.
        assert_eq!(
            DialogPath::Path(PathBuf::from("/tmp/a.wav")).as_path(),
            Some(Path::new("/tmp/a.wav"))
        );
        assert_eq!(DialogPath::Opaque("content://x".into()).as_path(), None);
    }

    #[test]
    fn dialog_request_builds_filters_in_order() {
        let request = FileDialogRequest::new()
            .with_filter("Audio", &["wav", "mp3"])
            .with_file_name("voice.wav");
        assert_eq!(
            request.filters,
            vec![(
                "Audio".to_string(),
                vec!["wav".to_string(), "mp3".to_string()]
            )]
        );
        assert_eq!(request.suggested_file_name.as_deref(), Some("voice.wav"));
    }

    #[test]
    fn shell_proxy_is_object_safe() {
        // HostCtx stores Arc<dyn ShellProxy>; if this stops compiling the seam
        // stops working.
        fn assert_object_safe(_: &dyn ShellProxy) {}
        let _ = assert_object_safe;
    }
}
