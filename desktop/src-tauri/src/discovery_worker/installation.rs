use std::{fs, io::Write as _, path::Path};

use atomic_write_file::AtomicWriteFile;
use uuid::Uuid;

const DISCOVERY_DIR: &str = "discovery";
const WORKER_ID_FILE: &str = "worker-id";

pub(crate) fn load_or_create_worker_id(app_data_dir: &Path) -> Result<Uuid, String> {
    let discovery_dir = app_data_dir.join(DISCOVERY_DIR);
    fs::create_dir_all(&discovery_dir)
        .map_err(|error| format!("create Discovery state directory: {error}"))?;
    set_directory_owner_only(&discovery_dir)?;

    let path = discovery_dir.join(WORKER_ID_FILE);
    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(id) = Uuid::parse_str(raw.trim()) {
            if !id.is_nil() {
                set_file_owner_only(&path)?;
                return Ok(id);
            }
        }
    }

    let id = Uuid::new_v4();
    let mut file = AtomicWriteFile::open(&path)
        .map_err(|error| format!("open Discovery worker identity: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("protect Discovery worker identity: {error}"))?;
    }
    file.write_all(id.to_string().as_bytes())
        .map_err(|error| format!("write Discovery worker identity: {error}"))?;
    file.commit()
        .map_err(|error| format!("commit Discovery worker identity: {error}"))?;
    Ok(id)
}

pub(super) fn set_directory_owner_only(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("protect Discovery state directory: {error}"))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

pub(super) fn set_file_owner_only(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("protect Discovery worker identity: {error}"))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_id_survives_host_restart() {
        let dir = tempfile::tempdir().expect("temporary app data");
        let first = load_or_create_worker_id(dir.path()).expect("first worker id");
        let second = load_or_create_worker_id(dir.path()).expect("second worker id");
        assert_eq!(first, second);
        assert!(!first.is_nil());
    }

    #[test]
    fn malformed_and_nil_worker_ids_are_replaced() {
        let dir = tempfile::tempdir().expect("temporary app data");
        let discovery = dir.path().join(DISCOVERY_DIR);
        fs::create_dir_all(&discovery).expect("Discovery state directory");
        let path = discovery.join(WORKER_ID_FILE);

        fs::write(&path, "not-a-uuid").expect("malformed worker id");
        let repaired = load_or_create_worker_id(dir.path()).expect("repair malformed id");
        assert!(!repaired.is_nil());

        fs::write(&path, Uuid::nil().to_string()).expect("nil worker id");
        let replaced = load_or_create_worker_id(dir.path()).expect("replace nil id");
        assert!(!replaced.is_nil());
        assert_ne!(repaired, replaced);
    }

    #[cfg(unix)]
    #[test]
    fn worker_identity_is_owner_only() {
        use std::os::unix::fs::PermissionsExt as _;

        let dir = tempfile::tempdir().expect("temporary app data");
        load_or_create_worker_id(dir.path()).expect("worker id");
        let discovery = dir.path().join(DISCOVERY_DIR);
        let path = discovery.join(WORKER_ID_FILE);
        assert_eq!(
            fs::metadata(discovery)
                .expect("Discovery directory metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(path)
                .expect("worker id metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
