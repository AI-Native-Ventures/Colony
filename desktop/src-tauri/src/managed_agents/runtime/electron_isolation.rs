//! Keep bundled helpers and worker cleanup inside the active Electron profile.

use std::path::{Path, PathBuf};

// Electron has always stamped profile ownership on its children. A shared
// executable path cannot prove ownership when several profiles use one bundle.
#[cfg(any(unix, test))]
pub(super) fn allow_unmarked_bundle_sweep(electron_host: bool) -> bool {
    !electron_host
}

// KERN_PROCARGS2 contains argv and the original environment. Match complete
// entries: another profile, a longer suffix, or a similarly named variable
// must never make a dead instance appear live.
#[cfg(any(unix, test))]
pub(super) fn matches_electron_instance(buffer: &[u8], instance_id: &str) -> bool {
    let Some(profile) = instance_id.strip_prefix("xyz.block.buzz.app.dev-electron.") else {
        return false;
    };
    if profile.len() != 16 || !profile.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return false;
    }
    let marker = format!("COLONY_ELECTRON_PROFILE_ID={profile}");
    let entries = || buffer.split(|byte| *byte == 0);
    entries().any(|entry| entry == b"COLONY_ELECTRON_HOST=1")
        && entries().any(|entry| entry == marker.as_bytes())
}

// Managed processes invoke buzz in a shell as well as through resolve_command.
// Keep both paths on the same bundle; ordinary Tauri precedence is unchanged.
pub(super) fn prioritize_packaged_helpers(
    paths: &mut Vec<PathBuf>,
    exe_parent: Option<&Path>,
    packaged: bool,
) {
    if packaged {
        if let Some(parent) = exe_parent {
            paths.retain(|entry| entry != parent);
            paths.insert(0, parent.to_path_buf());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn electron_isolation_does_not_reap_other_profiles_by_bundle_path() {
        // Two profiles share one .app and thus one buzz-acp executable. The
        // legacy sweep cannot distinguish them; profile-marker sweeps can.
        assert!(!allow_unmarked_bundle_sweep(true));
        assert!(allow_unmarked_bundle_sweep(false));
    }

    #[test]
    fn electron_isolation_live_host_is_visible_to_foreign_profile_and_tauri() {
        let host = b"colony-native-host\0COLONY_ELECTRON_HOST=1\0COLONY_ELECTRON_PROFILE_ID=1234567890abcdef\0";
        assert!(matches_electron_instance(
            host,
            "xyz.block.buzz.app.dev-electron.1234567890abcdef"
        ));
        assert!(!matches_electron_instance(
            host,
            "xyz.block.buzz.app.dev-electron.1111111111111111"
        ));
        assert!(!matches_electron_instance(host, "xyz.block.buzz.app"));
        assert!(!matches_electron_instance(
            host,
            "xyz.block.buzz.app.dev-electron.1234567890abcde"
        ));
    }

    #[test]
    fn electron_isolation_packaged_host_remains_visible_to_legacy_tauri() {
        use super::super::instance_reaper::{buffer_contains_identifier, is_desktop_binary};
        // The package uses a legacy-recognized name and supplies the entire
        // identifier at exec time, so an already-installed Tauri can see it.
        let id = "xyz.block.buzz.app.dev-electron.1234567890abcdef";
        let buffer = format!("buzz-desktop\0COLONY_ELECTRON_INSTANCE_ID={id}\0");
        assert!(is_desktop_binary("buzz-desktop"));
        assert!(buffer_contains_identifier(buffer.as_bytes(), id.as_bytes()));
        assert!(!buffer_contains_identifier(
            buffer.as_bytes(),
            b"xyz.block.buzz.app.dev-electron.1111111111111111",
        ));
        assert!(!buffer_contains_identifier(
            buffer.as_bytes(),
            b"xyz.block.buzz.app"
        ));
    }

    #[test]
    fn electron_isolation_requires_complete_marker_entries() {
        let id = "xyz.block.buzz.app.dev-electron.1234567890abcdef";
        for host in [
            b"COLONY_ELECTRON_PROFILE_ID=1234567890abcdef\0".as_slice(),
            b"COLONY_ELECTRON_HOST=10\0COLONY_ELECTRON_PROFILE_ID=1234567890abcdef\0",
            b"COLONY_ELECTRON_HOST=1\0COLONY_ELECTRON_PROFILE_ID=1234567890abcdef0\0",
            b"COLONY_ELECTRON_HOST=1\0OTHER_COLONY_ELECTRON_PROFILE_ID=1234567890abcdef\0",
        ] {
            assert!(!matches_electron_instance(host, id));
        }
    }

    #[cfg(unix)]
    #[test]
    fn electron_isolation_shell_resolves_bundled_buzz_before_old_install() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("old-install");
        let bundled = root.path().join("bundle native");
        for dir in [&old, &bundled] {
            std::fs::create_dir(dir).unwrap();
            std::fs::write(dir.join("buzz"), "#!/bin/sh\nexit 0\n").unwrap();
            std::fs::set_permissions(dir.join("buzz"), std::fs::Permissions::from_mode(0o755))
                .unwrap();
        }
        let original = vec![old.clone(), bundled.clone(), PathBuf::from("/usr/bin")];
        for packaged in [true, false] {
            let mut paths = original.clone();
            prioritize_packaged_helpers(&mut paths, Some(&bundled), packaged);
            let output = std::process::Command::new("/bin/sh")
                .args(["-c", "command -v buzz"])
                .env("PATH", std::env::join_paths(&paths).unwrap())
                .output()
                .unwrap();
            assert!(output.status.success());
            let expected = if packaged { &bundled } else { &old };
            assert_eq!(
                String::from_utf8(output.stdout).unwrap().trim(),
                expected.join("buzz").to_str().unwrap()
            );
        }
    }
}
