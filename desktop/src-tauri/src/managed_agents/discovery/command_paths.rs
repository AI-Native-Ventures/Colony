//! Search locations for workspace and installed native helpers.

use super::{profile_target_dirs, workspace_root_dir};
use std::path::{Path, PathBuf};

pub(super) fn command_search_dirs() -> Vec<PathBuf> {
    if crate::electron_host::packaged() {
        // Installed helpers are siblings of the native host. Never prefer a
        // build-time checkout (or the Finder launch directory) over the bundle.
        return std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(Path::to_path_buf))
            .into_iter()
            .collect();
    }
    let mut dirs = profile_target_dirs(&workspace_root_dir()).to_vec();
    if let Ok(current_dir) = std::env::current_dir() {
        dirs.extend(profile_target_dirs(&current_dir));
    }

    dirs.extend(
        std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(Path::to_path_buf)),
    );
    dirs.into_iter().fold(Vec::new(), |mut unique, dir| {
        if !unique.contains(&dir) {
            unique.push(dir);
        }
        unique
    })
}
