//! Where a managed agent's harness process runs.
//!
//! The Software Factory gives each agent its own git worktree and records it
//! on the agent. This resolves that record field to a directory the spawn can
//! actually `current_dir` into — a worktree the user has since deleted must
//! degrade to the historical home directory rather than making the agent
//! unstartable.

use std::path::PathBuf;

/// The agent's own worktree, when it has one that still exists on disk.
pub(crate) fn resolve_agent_working_dir(working_dir: Option<&str>) -> Option<PathBuf> {
    let path = PathBuf::from(
        working_dir
            .map(str::trim)
            .filter(|value| !value.is_empty())?,
    );
    path.is_dir().then_some(path)
}

#[cfg(test)]
mod tests {
    use super::resolve_agent_working_dir;

    #[test]
    fn resolves_an_existing_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().to_string_lossy().to_string();
        assert_eq!(
            resolve_agent_working_dir(Some(&path)),
            Some(dir.path().to_path_buf())
        );
    }

    #[test]
    fn falls_back_for_absent_blank_and_missing_paths() {
        assert_eq!(resolve_agent_working_dir(None), None);
        assert_eq!(resolve_agent_working_dir(Some("   ")), None);
        assert_eq!(
            resolve_agent_working_dir(Some("/definitely/not/a/worktree")),
            None
        );
    }
}
