//! The Buzz desktop native layer, with no shell attached.
//!
//! # What this crate is for
//!
//! `desktop/src-tauri` currently holds 320 Rust files and 280 Tauri commands,
//! and 272 of those command signatures take an `AppHandle`. That type is the
//! shell, so every one of them is welded to Tauri. This crate is where the
//! shell-agnostic half goes.
//!
//! The seam is [`HostCtx`]. It replaces `AppHandle` and splits the four
//! different jobs that type was doing:
//!
//! | Was | Is | Sites |
//! | --- | --- | --- |
//! | `app.state::<AppState>()` | [`HostCtx::state`] | 85 |
//! | `app.emit(name, payload)` | [`HostCtx::events`] + [`EventSinkExt::emit`] | 34 |
//! | `app.path()` | [`HostCtx::paths`] | 26 |
//! | `app.config()` | [`HostCtx::info`] | 4 |
//! | `app.dialog()`, `get_webview_window()`, `run_on_main_thread()`, `request_restart()`, `opener()`, `global_shortcut()` | [`HostCtx::shell`] | 19 |
//!
//! Those five numbers come from `desktop/native-inventory.json`, which is
//! generated and drift-checked in CI. Do not retype them from memory; two
//! earlier revisions of the migration plan did, and both were wrong.
//!
//! # The rule this crate enforces
//!
//! **No `tauri` dependency, in any profile, ever.** `cargo tree -p buzz-native`
//! is the check. The Tauri-backed implementations of [`EventSink`] and
//! [`ShellProxy`] live in `buzz-desktop`, on the other side of the seam, which
//! is what lets Phase 2 put a process boundary here and Phase 3 swap the shell
//! for Electron without touching a single command.
//!
//! # Using it
//!
//! Take `&Ctx`, not `HostCtx<S>`. `buzz-desktop` exports
//! `pub type Ctx = HostCtx<AppState>` and the generic parameter is an
//! implementation detail that exists only so this crate need not depend on the
//! crate defining `AppState`.
//!
//! ```
//! use std::sync::Arc;
//! use buzz_native::{
//!     AppPaths, ArcState, EventSinkExt, HostCtx, HostInfo, RecordingEventSink,
//! };
//! # use buzz_native::{DialogCallback, DialogPath, FileDialogRequest, MainThreadTask,
//! #     ShellError, ShellProxy, VibrancyMaterial, WindowOp};
//! # struct NoShell;
//! # impl ShellProxy for NoShell {
//! #     fn request_restart(&self) {}
//! #     fn relaunch(&self) -> ! { unreachable!() }
//! #     fn window_op(&self, _: &str, _: WindowOp) -> Result<bool, ShellError> { Ok(false) }
//! #     fn set_window_vibrancy(&self, _: &str, _: Option<VibrancyMaterial>) -> Result<(), ShellError> { Ok(()) }
//! #     fn run_on_main_thread(&self, t: MainThreadTask) -> Result<(), ShellError> { t(); Ok(()) }
//! #     fn open_external(&self, _: &str) -> Result<(), ShellError> { Ok(()) }
//! #     fn set_push_to_talk_shortcut(&self, _: bool) -> Result<(), ShellError> { Ok(()) }
//! #     fn pick_file(&self, _: FileDialogRequest, d: DialogCallback<DialogPath>) { d(None) }
//! #     fn pick_files(&self, _: FileDialogRequest, d: DialogCallback<Vec<DialogPath>>) { d(None) }
//! #     fn save_file(&self, _: FileDialogRequest, d: DialogCallback<DialogPath>) { d(None) }
//! # }
//! struct MyState { relay: String }
//!
//! let events = Arc::new(RecordingEventSink::new());
//! let ctx = HostCtx::new(
//!     Arc::new(ArcState::new(Arc::new(MyState {
//!         relay: "wss://relay.example".into(),
//!     }))),
//!     events.clone(),
//!     AppPaths::new("/tmp/buzz"),
//!     HostInfo::new("xyz.block.buzz.app", Some("Buzz".into())),
//!     Arc::new(NoShell),
//! );
//!
//! assert_eq!(ctx.state().relay, "wss://relay.example");
//! ctx.events().emit("ptt-state", true).unwrap();
//! assert_eq!(events.names(), vec!["ptt-state"]);
//! ```

#![deny(rust_2018_idioms)]

pub mod events;
pub mod info;
pub mod paths;
pub mod shell;
pub mod state;

mod ctx;

pub use ctx::HostCtx;
pub use events::{
    DeferredEventSink, EmitError, EventSink, EventSinkExt, NullEventSink, RecordingEventSink,
    EVENT_NAMES,
};
pub use info::HostInfo;
pub use paths::AppPaths;
pub use shell::{
    DialogCallback, DialogPath, FileDialogRequest, MainThreadTask, ShellError, ShellProxy,
    VibrancyMaterial, WindowOp,
};
pub use state::{ArcState, StateProvider};
