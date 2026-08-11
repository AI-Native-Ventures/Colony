//! Filesystem locations, resolved once at boot.
//!
//! The Tauri app asks `app.path()` per call. That is cheap today and a round
//! trip across a process boundary in Phase 2, so the values are resolved during
//! startup and carried in [`HostCtx`](crate::HostCtx) instead.

use std::path::{Path, PathBuf};

/// Every directory the native layer needs.
///
/// Deliberately one field. All 14 `app.path()` call sites in the tree resolve
/// `app_data_dir` and nothing else, so speculatively adding `cache_dir`,
/// `log_dir` and friends would be inventing surface the daemon then has to
/// answer for. Add a field when a call site needs it, not before.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppPaths {
    data_dir: PathBuf,
}

impl AppPaths {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
        }
    }

    /// Where identity, agent records, channel templates and migrations live.
    /// Equivalent to `app.path().app_data_dir()`.
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// `data_dir` joined with `relative`. The overwhelmingly common shape at
    /// call sites is `app.path().app_data_dir()?.join("something")`.
    pub fn data_path(&self, relative: impl AsRef<Path>) -> PathBuf {
        self.data_dir.join(relative)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_path_joins_under_the_data_dir() {
        let paths = AppPaths::new("/tmp/buzz");
        assert_eq!(paths.data_dir(), Path::new("/tmp/buzz"));
        assert_eq!(
            paths.data_path("identity.key"),
            PathBuf::from("/tmp/buzz/identity.key")
        );
    }

    #[test]
    fn data_path_accepts_nested_relatives() {
        let paths = AppPaths::new("/tmp/buzz");
        assert_eq!(
            paths.data_path("custom_harnesses/goose.yaml"),
            PathBuf::from("/tmp/buzz/custom_harnesses/goose.yaml")
        );
    }
}
