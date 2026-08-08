//! Event emission, abstracted away from the shell.
//!
//! Today the only implementation writes to a Tauri `AppHandle`. In Phase 2 a
//! second one writes notification frames to the daemon's stdio transport, and
//! in Phase 3 a third talks to Electron. None of the callers change.

use std::fmt;
use std::sync::Arc;

use serde::Serialize;

/// Every event name the native layer emits.
///
/// Generated from `desktop/native-inventory.json` (`events.names`): 24 names
/// across 34 emit sites. This list is a **contract** — the frontend listens on
/// these exact strings, so renaming one is a breaking change disguised as a
/// refactor.
///
/// Three of these are emitted through a `const` rather than a literal
/// (`mesh-download-progress`, `managed-agent-runtime-status`,
/// `native-notification-activated`) and were missing from the inventory
/// entirely until the generator learned to resolve identifiers. If you add an
/// event, run `pnpm generate:native-inventory` from `desktop/` and add it here;
/// `pnpm check` fails otherwise.
///
/// `initial-render-ready` is deliberately absent. It is emitted by the frontend
/// and only *listened* to in Rust (`lib.rs`, via `.once()`), so it is inbound
/// and not part of this contract.
pub const EVENT_NAMES: &[&str] = &[
    "agents-data-changed",
    "deep-link-add-community",
    "deep-link-connect",
    "deep-link-join",
    "deep-link-message",
    "deep-link-nostr-bind",
    "huddle-active-speakers",
    "huddle-audio-disconnected",
    "huddle-companion-returned",
    "huddle-speaker-levels",
    "huddle-state-changed",
    "huddle-tts-speaker-level",
    "legacy-nest-migrated",
    "managed-agent-runtime-status",
    "media-upload-progress",
    "mesh-download-progress",
    "native-notification-activated",
    "pairing-aborted",
    "pairing-complete",
    "pairing-error",
    "pairing-sas-received",
    "prevent-sleep-expired",
    "ptt-state",
    "repos-dir-error",
];

/// An emit failed.
///
/// Most call sites discard this (`let _ = app.emit(...)`), but two do not:
/// `huddle/window.rs` returns it to its caller and `lib.rs` formats it into a
/// log line. So emitting has to stay fallible — collapsing it to `()` would be
/// a silent behavior change in exactly the places that care.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct EmitError(pub String);

impl EmitError {
    pub fn new(message: impl fmt::Display) -> Self {
        Self(message.to_string())
    }
}

/// Sends events to whatever is listening on the other side of the shell.
///
/// Object-safe on purpose: `HostCtx` holds `Arc<dyn EventSink>` so the shell can
/// be swapped at runtime and so tests can install a recording sink without
/// generics leaking into 280 command signatures. Payloads arrive pre-serialised
/// for the same reason; use [`EventSinkExt::emit`] to keep call sites readable.
pub trait EventSink: Send + Sync {
    fn emit_json(&self, event: &str, payload: serde_json::Value) -> Result<(), EmitError>;
}

/// Ergonomic `emit` over any [`EventSink`], including `dyn EventSink`.
///
/// Kept separate because a generic method would make `EventSink` not
/// object-safe.
pub trait EventSinkExt {
    fn emit<S: Serialize>(&self, event: &str, payload: S) -> Result<(), EmitError>;
}

impl<T: EventSink + ?Sized> EventSinkExt for T {
    fn emit<S: Serialize>(&self, event: &str, payload: S) -> Result<(), EmitError> {
        let value = serde_json::to_value(payload).map_err(EmitError::new)?;
        self.emit_json(event, value)
    }
}

/// Records every emit instead of sending it. For tests and for the parity
/// oracle's recorder.
#[derive(Debug, Default)]
pub struct RecordingEventSink {
    emitted: std::sync::Mutex<Vec<(String, serde_json::Value)>>,
}

impl RecordingEventSink {
    pub fn new() -> Self {
        Self::default()
    }

    /// Every `(event, payload)` in emit order.
    pub fn emitted(&self) -> Vec<(String, serde_json::Value)> {
        self.emitted
            .lock()
            .expect("recording sink poisoned")
            .clone()
    }

    pub fn names(&self) -> Vec<String> {
        self.emitted().into_iter().map(|(name, _)| name).collect()
    }
}

impl EventSink for RecordingEventSink {
    fn emit_json(&self, event: &str, payload: serde_json::Value) -> Result<(), EmitError> {
        self.emitted
            .lock()
            .map_err(|_| EmitError::new("recording sink poisoned"))?
            .push((event.to_string(), payload));
        Ok(())
    }
}

/// A sink whose real destination arrives later.
///
/// `AppState` is constructed at `lib.rs`'s `.manage(build_app_state())`, which
/// runs before `setup()` and therefore before any shell exists to emit through.
/// Today the state stores `Mutex<Option<AppHandle>>` and every emit path checks
/// for `None`; this type moves that check to one place so callers can just emit.
///
/// Emits before [`set`](Self::set) are **dropped, not buffered**, and that is
/// deliberate — it is exactly what happens now when `app_handle` is still
/// `None`. Buffering would change startup behavior by replaying stale state to
/// the frontend once it connects.
#[derive(Default)]
pub struct DeferredEventSink {
    inner: std::sync::OnceLock<Arc<dyn EventSink>>,
    dropped: std::sync::atomic::AtomicUsize,
}

impl DeferredEventSink {
    pub fn new() -> Self {
        Self::default()
    }

    /// Installs the real sink. Returns `false` if one was already installed;
    /// the first wins, matching "set once during `setup()`; never cleared".
    pub fn set(&self, sink: Arc<dyn EventSink>) -> bool {
        self.inner.set(sink).is_ok()
    }

    pub fn is_ready(&self) -> bool {
        self.inner.get().is_some()
    }

    /// How many emits were discarded because no sink was installed yet. A
    /// non-zero value at steady state means something emits too early.
    pub fn dropped_count(&self) -> usize {
        self.dropped.load(std::sync::atomic::Ordering::Relaxed)
    }
}

impl std::fmt::Debug for DeferredEventSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeferredEventSink")
            .field("ready", &self.is_ready())
            .field("dropped", &self.dropped_count())
            .finish()
    }
}

impl EventSink for DeferredEventSink {
    fn emit_json(&self, event: &str, payload: serde_json::Value) -> Result<(), EmitError> {
        match self.inner.get() {
            Some(sink) => sink.emit_json(event, payload),
            None => {
                self.dropped
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                Ok(())
            }
        }
    }
}

/// Drops every emit. For the handful of paths that run before a shell exists,
/// and for tests that do not care.
#[derive(Debug, Default, Clone, Copy)]
pub struct NullEventSink;

impl EventSink for NullEventSink {
    fn emit_json(&self, _event: &str, _payload: serde_json::Value) -> Result<(), EmitError> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_names_are_sorted_deduped_and_counted() {
        // The list is pasted from generated output. These assertions are what
        // stop it drifting into a hand-maintained approximation.
        let mut sorted = EVENT_NAMES.to_vec();
        sorted.sort_unstable();
        assert_eq!(EVENT_NAMES, sorted.as_slice(), "EVENT_NAMES must be sorted");

        let unique: std::collections::BTreeSet<_> = EVENT_NAMES.iter().collect();
        assert_eq!(unique.len(), EVENT_NAMES.len(), "no duplicate event names");
        assert_eq!(
            EVENT_NAMES.len(),
            24,
            "inventory reports 24 distinct emitted events; regenerate and update both"
        );
    }

    #[test]
    fn const_named_events_are_present() {
        // These three are emitted via a `const`, not a literal, and were absent
        // from the inventory until the generator resolved identifiers. If a
        // future edit rebuilds this list from the old measurement they vanish
        // again, and Phase 2's frame writer silently stops carrying them.
        for name in [
            "mesh-download-progress",
            "managed-agent-runtime-status",
            "native-notification-activated",
        ] {
            assert!(EVENT_NAMES.contains(&name), "{name} missing from contract");
        }
    }

    #[test]
    fn inbound_only_events_are_absent() {
        assert!(
            !EVENT_NAMES.contains(&"initial-render-ready"),
            "initial-render-ready is emitted by the frontend, not by us"
        );
    }

    #[test]
    fn recording_sink_preserves_order_and_payloads() {
        let sink = RecordingEventSink::new();
        sink.emit("ptt-state", true).unwrap();
        sink.emit("huddle-active-speakers", vec!["a", "b"]).unwrap();

        assert_eq!(sink.names(), vec!["ptt-state", "huddle-active-speakers"]);
        assert_eq!(
            sink.emitted()[1].1,
            serde_json::json!(["a", "b"]),
            "payload must survive the Serialize -> Value hop unchanged"
        );
    }

    #[test]
    fn emit_error_displays_the_underlying_message() {
        // lib.rs formats this into a log line, so Display is load-bearing.
        assert_eq!(EmitError::new("boom").to_string(), "boom");
    }

    #[test]
    fn deferred_sink_drops_before_ready_and_delivers_after() {
        let deferred = DeferredEventSink::new();
        assert!(!deferred.is_ready());

        // Pre-setup emit: swallowed, and Ok, exactly as `app_handle == None` is
        // today. Returning Err here would make startup paths start logging.
        deferred.emit("huddle-state-changed", 1).unwrap();
        assert_eq!(deferred.dropped_count(), 1);

        let real = Arc::new(RecordingEventSink::new());
        assert!(deferred.set(real.clone()));
        assert!(deferred.is_ready());

        deferred.emit("huddle-state-changed", 2).unwrap();
        assert_eq!(
            real.emitted(),
            vec![("huddle-state-changed".to_string(), serde_json::json!(2))],
            "only the post-setup emit is delivered; the dropped one is not replayed"
        );
        assert_eq!(
            deferred.dropped_count(),
            1,
            "count does not grow once ready"
        );
    }

    #[test]
    fn deferred_sink_keeps_the_first_installed_sink() {
        // "Set once during setup(); never cleared." A second install must not
        // silently redirect events somewhere else.
        let deferred = DeferredEventSink::new();
        let first = Arc::new(RecordingEventSink::new());
        let second = Arc::new(RecordingEventSink::new());

        assert!(deferred.set(first.clone()));
        assert!(!deferred.set(second.clone()), "second set must be rejected");

        deferred.emit("ptt-state", true).unwrap();
        assert_eq!(first.names(), vec!["ptt-state"]);
        assert!(second.names().is_empty());
    }

    #[test]
    fn unit_payload_serialises_as_null_like_tauri() {
        // Many sites emit `()`. Tauri sends `null` for it; so must we.
        let sink = RecordingEventSink::new();
        sink.emit("pairing-complete", ()).unwrap();
        assert_eq!(sink.emitted()[0].1, serde_json::Value::Null);
    }
}
