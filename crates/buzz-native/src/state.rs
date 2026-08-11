//! How the core reaches shared application state.
//!
//! # Why this is a trait and not just `Arc<S>`
//!
//! The obvious design is for [`HostCtx`](crate::HostCtx) to hold `Arc<AppState>`.
//! It does not, and the reason is migration cost rather than taste.
//!
//! Tauri owns the state: `lib.rs` calls `.manage(build_app_state())`, which moves
//! an `AppState` into Tauri's state manager, and 203 command signatures then take
//! `State<'_, AppState>`. There is no way to obtain an `Arc<AppState>` from a
//! value Tauri owns, so a `HostCtx` holding `Arc<AppState>` would force
//! `.manage(Arc::new(...))` and convert all 203 signatures to
//! `State<'_, Arc<AppState>>` in one commit — a 203-site change, in files owned
//! by eleven different tickets, landing before any of them start.
//!
//! `State<'r, T>::inner()` returns `&'r T` borrowed from the manager, so a
//! provider that holds an `AppHandle` can hand out `&AppState` with its own
//! lifetime. That makes both access paths work at once: existing commands keep
//! their `State<'_, AppState>` parameter and converted commands read
//! `ctx.state()`, with one `AppState` behind both. Commands migrate one at a
//! time instead of all at once.
//!
//! Phase 2 replaces the Tauri-backed provider with [`ArcState`], since the
//! daemon owns its state outright and the indirection costs nothing.

use std::sync::Arc;

/// Hands out a reference to the shared application state.
///
/// Implementations must return the *same* state every call. Two providers
/// answering with different objects would split the mutexes that serialise
/// identity changes and the managed-agent PID set.
pub trait StateProvider<S>: Send + Sync {
    fn state(&self) -> &S;
}

/// A provider that simply owns the state. For the daemon, and for tests.
#[derive(Debug)]
pub struct ArcState<S>(Arc<S>);

impl<S> ArcState<S> {
    pub fn new(state: Arc<S>) -> Self {
        Self(state)
    }

    pub fn into_arc(self) -> Arc<S> {
        self.0
    }
}

impl<S> Clone for ArcState<S> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

impl<S: Send + Sync> StateProvider<S> for ArcState<S> {
    fn state(&self) -> &S {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Counted {
        value: u32,
    }

    #[test]
    fn arc_state_returns_the_same_object_every_call() {
        let provider = ArcState::new(Arc::new(Counted { value: 7 }));
        let first = provider.state() as *const Counted;
        let second = provider.state() as *const Counted;
        assert_eq!(first, second, "a provider must not clone the state");
        assert_eq!(provider.state().value, 7);
    }

    #[test]
    fn cloning_a_provider_shares_the_state() {
        let provider = ArcState::new(Arc::new(Counted { value: 1 }));
        let clone = provider.clone();
        assert_eq!(
            provider.state() as *const Counted,
            clone.state() as *const Counted,
        );
    }

    #[test]
    fn provider_is_object_safe() {
        let provider: Arc<dyn StateProvider<Counted>> =
            Arc::new(ArcState::new(Arc::new(Counted { value: 3 })));
        assert_eq!(provider.state().value, 3);
    }
}
