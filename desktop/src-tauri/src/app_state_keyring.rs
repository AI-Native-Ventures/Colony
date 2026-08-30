/// Service name for the desktop OS keyring. Debug builds default to a distinct
/// service, while standalone worktree launches may request a scoped dev service.
fn dev_keyring_service(configured: Option<String>) -> String {
    configured
        .filter(|service| service.starts_with("buzz-desktop-dev."))
        .unwrap_or_else(|| "buzz-desktop-dev".to_string())
}

pub(crate) fn keyring_service() -> &'static str {
    if cfg!(debug_assertions) {
        static DEV_SERVICE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
        DEV_SERVICE
            .get_or_init(|| dev_keyring_service(std::env::var("BUZZ_DEV_KEYRING_SERVICE").ok()))
            .as_str()
    } else {
        // Channel-scoped when baked at build time (the Canary release sets
        // `colony-canary-desktop`); stable and OSS builds stay on the
        // historical default. Sharing one service across channels would let a
        // side-by-side install read - and fail to rewrite - the other
        // channel's identity blob, which broke Canary signup outright
        // (2026-08-27).
        const BAKED: Option<&str> = option_env!("BUZZ_DESKTOP_BUILD_KEYRING_SERVICE");
        BAKED.unwrap_or("buzz-desktop")
    }
}

pub(super) fn migration_marker_name(service: &str, default_name: &str) -> String {
    if service == "buzz-desktop" || service == "buzz-desktop-dev" {
        default_name.to_string()
    } else {
        format!("identity.{service}.migrated")
    }
}

/// Legacy keyring service an existing identity may still be sitting under
/// because it predates this build's channel scoping — `None` when the
/// current service already IS the historical default, so there is nothing
/// to recover from.
///
/// Only release builds can have a baked, channel-scoped service (Canary's
/// `colony-canary-desktop`); a debug build's own service-scoping
/// (`BUZZ_DEV_KEYRING_SERVICE`, standalone worktrees) is a deliberate dev
/// isolation choice, not an involuntary rename, so it has no legacy identity
/// to recover — `None` there too.
///
/// This is what makes a channel-scoping change like #478 non-destructive:
/// an install that already had an identity under `"buzz-desktop"` is found
/// and recovered on first boot under the new service, rather than treated
/// as a fresh install (see `recover_legacy_or_generate` in `app_state.rs`).
pub(crate) fn legacy_keyring_service() -> Option<&'static str> {
    if cfg!(debug_assertions) {
        return None;
    }
    match keyring_service() {
        "buzz-desktop" => None,
        _ => Some("buzz-desktop"),
    }
}

#[cfg(test)]
mod tests {
    use super::{dev_keyring_service, legacy_keyring_service, migration_marker_name};

    #[test]
    fn standalone_scope_must_remain_under_dev_service() {
        assert_eq!(
            dev_keyring_service(Some("buzz-desktop-dev.example".to_string())),
            "buzz-desktop-dev.example"
        );
        assert_eq!(
            dev_keyring_service(Some("buzz-desktop".to_string())),
            "buzz-desktop-dev"
        );
    }

    #[test]
    fn standalone_scope_uses_its_own_migration_marker() {
        assert_eq!(
            migration_marker_name("buzz-desktop", "identity.migrated"),
            "identity.migrated"
        );
        assert_eq!(
            migration_marker_name("buzz-desktop-dev", "identity.migrated"),
            "identity.migrated"
        );
        assert_eq!(
            migration_marker_name("buzz-desktop-dev.example", "identity.migrated"),
            "identity.buzz-desktop-dev.example.migrated"
        );
    }

    #[test]
    fn debug_builds_have_no_legacy_service_to_recover() {
        // Test binaries are always debug builds. Legacy-identity recovery is
        // scoped to release builds with a baked, channel-specific service
        // (Canary); a debug build's own scoping is deliberate dev isolation,
        // not an involuntary rename, so there is nothing to recover.
        assert_eq!(legacy_keyring_service(), None);
    }
}
