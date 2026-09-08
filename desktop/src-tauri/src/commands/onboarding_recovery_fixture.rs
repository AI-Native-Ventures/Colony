//! Save-dialog selection for the explicitly compiled onboarding fixture only.
//! The registered identity checks and exclusive, synced secret-file write remain real.

use std::path::{Path, PathBuf};

const DESTINATION_ENV: &str = "BUZZ_ONBOARDING_FIXTURE_RECOVERY_PATH";

pub(super) fn selected_path() -> Result<Option<PathBuf>, String> {
    buzz_ws_client::onboarding_fixture::FixtureTransport::from_env()
        .map_err(|error| error.to_string())?;
    let directory = std::env::var_os("COLONY_ELECTRON_USER_DATA")
        .ok_or("Fixture profile directory is missing")?;
    let destination =
        std::env::var_os(DESTINATION_ENV).ok_or("Fixture recovery destination is missing")?;
    checked_destination(Path::new(&directory), Path::new(&destination)).map(Some)
}

fn checked_destination(directory: &Path, destination: &Path) -> Result<PathBuf, String> {
    if !directory.is_absolute()
        || !destination.is_absolute()
        || destination
            .file_name()
            .is_none_or(|name| name != "colony-recovery-code.txt")
    {
        return Err("Invalid fixture recovery destination".into());
    }
    let directory = directory
        .canonicalize()
        .map_err(|_| "Fixture profile is unavailable")?;
    let parent = destination
        .parent()
        .ok_or("Fixture recovery destination has no parent")?
        .canonicalize()
        .map_err(|_| "Fixture recovery directory is unavailable")?;
    if !parent.starts_with(&directory) {
        return Err("Fixture recovery destination is outside its profile".into());
    }
    // Selection only. Existing files/symlinks are rejected by the real writer's
    // create_new contract; never replace them or bypass its 0o600 verification.
    Ok(parent.join("colony-recovery-code.txt"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_only_an_absolute_recovery_file_inside_the_fixture_profile() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let file = root.join("colony-recovery-code.txt");
        assert_eq!(checked_destination(&root, &file).unwrap(), file);
        assert!(!file.exists(), "selection must not fake the export write");
        assert!(checked_destination(&root, Path::new("colony-recovery-code.txt")).is_err());
        assert!(checked_destination(&root, &root.join("other.txt")).is_err());
        let outside = tempfile::tempdir().unwrap();
        assert!(
            checked_destination(&root, &outside.path().join("colony-recovery-code.txt")).is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn cannot_select_through_a_directory_symlink_outside_the_fixture() {
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let link = directory.path().join("outside");
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        assert!(
            checked_destination(directory.path(), &link.join("colony-recovery-code.txt")).is_err()
        );
    }
}
