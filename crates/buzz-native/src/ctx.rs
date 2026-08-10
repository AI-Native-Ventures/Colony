//! The thing that replaces `AppHandle`.

use std::sync::Arc;

use crate::events::EventSink;
use crate::info::HostInfo;
use crate::paths::AppPaths;
use crate::shell::ShellProxy;
use crate::state::StateProvider;

/// Everything a command needs from its host, with no shell type in sight.
///
/// `AppHandle` currently appears in 272 command signatures and is used for four
/// distinct things: reaching shared state (85 sites), emitting events (34),
/// resolving paths and config (26 + 4), and asking the shell to do something
/// (19). `HostCtx` splits those apart so each can be implemented independently:
/// in Phase 2 `state` stays in-process, `events` becomes a frame writer, `paths`
/// and `info` are resolved once at boot, and only `shell` is a round trip.
///
/// # Why it is generic
///
/// `S` is the application state type. It exists solely so this crate does not
/// have to depend on the crate that defines `AppState` — which today is
/// `buzz-desktop`, the crate that depends on *this* one. Ticket 1.1 moves
/// `AppState` here and the parameter could then be dropped, but it costs nothing
/// to keep and it lets state be stubbed in tests.
///
/// **Do not write the parameter at call sites.** `buzz-desktop` exports
/// `pub type Ctx = HostCtx<AppState>;` and every one of the 280 commands takes
/// `ctx: &Ctx`. That way ticket 1.1 changes one line instead of 280.
pub struct HostCtx<S> {
    state: Arc<dyn StateProvider<S>>,
    events: Arc<dyn EventSink>,
    paths: AppPaths,
    info: HostInfo,
    shell: Arc<dyn ShellProxy>,
}

impl<S> HostCtx<S> {
    pub fn new(
        state: Arc<dyn StateProvider<S>>,
        events: Arc<dyn EventSink>,
        paths: AppPaths,
        info: HostInfo,
        shell: Arc<dyn ShellProxy>,
    ) -> Self {
        Self {
            state,
            events,
            paths,
            info,
            shell,
        }
    }

    /// Was `app.state::<AppState>()`. 85 call sites.
    pub fn state(&self) -> &S {
        self.state.state()
    }

    /// For paths that need state past the borrow, e.g. moving it into a spawned
    /// task, where the old code cloned an `AppHandle` into the closure. Clone
    /// this, move the clone in, and call `.state()` inside.
    ///
    /// Deliberately not `Arc<S>`: Tauri owns the only `AppState` and will not
    /// surrender an `Arc` to it. See [`crate::state`].
    pub fn state_provider(&self) -> Arc<dyn StateProvider<S>> {
        Arc::clone(&self.state)
    }

    /// Was `app.emit(...)`. 39 call sites, 29 event names.
    ///
    /// Returns the trait object so [`EventSinkExt::emit`](crate::EventSinkExt)
    /// applies: `ctx.events().emit("ptt-state", true)`.
    pub fn events(&self) -> &dyn EventSink {
        self.events.as_ref()
    }

    /// For emitting from a spawned task or a stored callback, where the old code
    /// cloned an `AppHandle` into the closure.
    pub fn events_arc(&self) -> Arc<dyn EventSink> {
        Arc::clone(&self.events)
    }

    /// Was `app.path()`. Resolved at boot rather than per call.
    pub fn paths(&self) -> &AppPaths {
        &self.paths
    }

    /// Was `app.config()`. Read the type docs before using
    /// `bundle_identifier`: it is the managed-agent instance id.
    pub fn info(&self) -> &HostInfo {
        &self.info
    }

    /// Reverse RPC. 19 call sites, and every one is a round trip in Phase 2.
    pub fn shell(&self) -> &dyn ShellProxy {
        self.shell.as_ref()
    }

    pub fn shell_arc(&self) -> Arc<dyn ShellProxy> {
        Arc::clone(&self.shell)
    }

    /// Same host, different state. Useful for tests that want the real sinks
    /// with a stub state.
    pub fn with_state<T>(&self, state: Arc<dyn StateProvider<T>>) -> HostCtx<T> {
        HostCtx {
            state,
            events: Arc::clone(&self.events),
            paths: self.paths.clone(),
            info: self.info.clone(),
            shell: Arc::clone(&self.shell),
        }
    }
}

// Derived `Clone` would require `S: Clone`, which `AppState` is not — it holds
// mutexes and an HTTP client. Everything here is behind an `Arc` or is cheap.
impl<S> Clone for HostCtx<S> {
    fn clone(&self) -> Self {
        Self {
            state: Arc::clone(&self.state),
            events: Arc::clone(&self.events),
            paths: self.paths.clone(),
            info: self.info.clone(),
            shell: Arc::clone(&self.shell),
        }
    }
}

impl<S> std::fmt::Debug for HostCtx<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Deliberately does not print state: AppState holds keys.
        f.debug_struct("HostCtx")
            .field("paths", &self.paths)
            .field("info", &self.info)
            .field("state", &format_args!("<{}>", std::any::type_name::<S>()))
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{EventSinkExt, RecordingEventSink};
    use crate::shell::{
        DialogCallback, DialogPath, FileDialogRequest, MainThreadTask, ShellError, ShellProxy,
        VibrancyMaterial, WindowOp,
    };
    use crate::state::ArcState;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeShell {
        calls: Mutex<Vec<String>>,
    }

    impl ShellProxy for FakeShell {
        fn request_restart(&self) {
            self.calls.lock().unwrap().push("request_restart".into());
        }
        fn relaunch(&self) -> ! {
            panic!("relaunch");
        }
        fn window_op(&self, label: &str, op: WindowOp) -> Result<bool, ShellError> {
            self.calls.lock().unwrap().push(format!("{op:?}:{label}"));
            Ok(true)
        }
        fn set_window_vibrancy(
            &self,
            _label: &str,
            _material: Option<VibrancyMaterial>,
        ) -> Result<(), ShellError> {
            Ok(())
        }
        fn run_on_main_thread(&self, task: MainThreadTask) -> Result<(), ShellError> {
            task();
            Ok(())
        }
        fn open_external(&self, url: &str) -> Result<(), ShellError> {
            self.calls.lock().unwrap().push(format!("open:{url}"));
            Ok(())
        }
        fn set_push_to_talk_shortcut(&self, _enabled: bool) -> Result<(), ShellError> {
            Ok(())
        }
        fn pick_file(&self, _r: FileDialogRequest, done: DialogCallback<DialogPath>) {
            done(None);
        }
        fn pick_files(&self, _r: FileDialogRequest, done: DialogCallback<Vec<DialogPath>>) {
            done(None);
        }
        fn save_file(&self, _r: FileDialogRequest, done: DialogCallback<DialogPath>) {
            done(None);
        }
    }

    struct TestState {
        name: &'static str,
    }

    fn ctx() -> (HostCtx<TestState>, Arc<RecordingEventSink>, Arc<FakeShell>) {
        let events = Arc::new(RecordingEventSink::new());
        let shell = Arc::new(FakeShell::default());
        let ctx = HostCtx::new(
            Arc::new(ArcState::new(Arc::new(TestState { name: "test" }))),
            events.clone(),
            AppPaths::new("/tmp/buzz"),
            HostInfo::new("xyz.block.buzz.app.dev", Some("Buzz".into())),
            shell.clone(),
        );
        (ctx, events, shell)
    }

    #[test]
    fn accessors_reach_each_collaborator() {
        let (ctx, events, shell) = ctx();

        assert_eq!(ctx.state().name, "test");
        assert_eq!(ctx.paths().data_dir(), std::path::Path::new("/tmp/buzz"));
        assert_eq!(ctx.info().instance_id(), "xyz.block.buzz.app.dev");

        ctx.events().emit("ptt-state", true).unwrap();
        assert_eq!(events.names(), vec!["ptt-state"]);

        assert!(ctx.shell().window_op("main", WindowOp::SetFocus).unwrap());
        assert_eq!(shell.calls.lock().unwrap().as_slice(), ["SetFocus:main"]);
    }

    #[test]
    fn clone_shares_collaborators_rather_than_copying_them() {
        let (ctx, events, _shell) = ctx();
        let clone = ctx.clone();

        ctx.events().emit("ptt-state", true).unwrap();
        clone.events().emit("ptt-state", false).unwrap();

        // One sink, two handles. If Clone deep-copied, the second emit would be
        // invisible here and events emitted from spawned tasks would vanish.
        assert_eq!(events.names().len(), 2);
        assert_eq!(
            ctx.state() as *const TestState,
            clone.state() as *const TestState,
            "a clone must reach the same state, not a copy of it",
        );
    }

    #[test]
    fn with_state_swaps_state_and_keeps_the_host() {
        let (ctx, events, _shell) = ctx();
        let swapped = ctx.with_state(Arc::new(ArcState::new(Arc::new(TestState {
            name: "other",
        }))));

        assert_eq!(swapped.state().name, "other");
        swapped.events().emit("ptt-state", true).unwrap();
        assert_eq!(events.names(), vec!["ptt-state"], "same sink as the parent");
    }

    #[test]
    fn debug_does_not_print_state() {
        // AppState holds the user's nsec. A stray `{ctx:?}` in a log must not
        // leak it, so Debug prints the state's *type* and never its contents.
        // The sentinel is deliberately unlike any type or field name here: an
        // earlier version of this test looked for "test", which the rendered
        // type path `buzz_native::ctx::tests::TestState` contains, so it failed
        // for a reason that had nothing to do with leaking.
        const SENTINEL: &str = "nsec1-do-not-log-me";
        let (base, _, _) = ctx();
        let ctx = base.with_state(Arc::new(ArcState::new(Arc::new(TestState {
            name: SENTINEL,
        }))));

        let rendered = format!("{ctx:?}");
        assert!(rendered.contains("HostCtx"), "{rendered}");
        assert!(
            !rendered.contains(SENTINEL),
            "state contents must not appear: {rendered}"
        );
        assert!(
            rendered.contains("TestState"),
            "the state type is useful and safe to print: {rendered}"
        );
    }

    #[test]
    fn main_thread_tasks_run() {
        let (ctx, _, _) = ctx();
        let ran = Arc::new(Mutex::new(false));
        let flag = ran.clone();
        ctx.shell()
            .run_on_main_thread(Box::new(move || *flag.lock().unwrap() = true))
            .unwrap();
        assert!(*ran.lock().unwrap());
    }
}
