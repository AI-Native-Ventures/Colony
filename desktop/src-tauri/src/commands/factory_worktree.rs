//! Per-agent git worktrees for the Software Factory.
//!
//! One agent, one branch, one checkout: the factory gives every agent it
//! launches its own worktree of the project's local clone so two agents can
//! never fight over the same working tree. Worktrees live beside the checkout
//! under `<repos root>/.colony-worktrees/<project dtag>/<branch slug>`, which
//! keeps them inside the repositories root the rest of the project commands
//! already sandbox themselves to.
//!
//! The operation is local-only — `git worktree add` never talks to a remote —
//! so this runs the system `git` directly instead of going through the
//! credential-carrying `project_git_exec` plumbing.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::State;

use super::project_git_exec::{
    build_git_auth_config, build_git_clone_auth_config, clean_branch,
    validate_local_clone_url_for_workspace,
};
use super::project_git_workflow::{clone_project_repository_blocking, ProjectRepoCloneResult};
use super::project_repo_paths::find_local_repo_dir;
use crate::app_state::AppState;
use crate::managed_agents::resolve_command;

/// Directory under the repositories root holding every factory worktree.
const WORKTREES_DIR: &str = ".colony-worktrees";

/// Request payload for creating (or reusing) an agent's worktree.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactoryWorktreeRequest {
    /// Repositories root; `None` falls back to the default roots.
    pub repos_dir: Option<String>,
    /// `d` tag of the project whose local checkout the worktree branches from.
    pub project_dtag: String,
    /// Primary repository clone URL, used to disambiguate the checkout.
    pub clone_url: Option<String>,
    /// Branch the worktree checks out, created when it does not exist.
    pub branch: String,
    /// Ref a new branch forks from. Defaults to `HEAD` of the checkout.
    pub from: Option<String>,
}

/// The worktree an agent should run in.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FactoryWorktreeResult {
    /// Absolute path of the worktree.
    pub path: String,
    /// Branch checked out in it.
    pub branch: String,
    /// `false` when an existing worktree for this branch was reused.
    pub created: bool,
    /// `true` when the project's repository was cloned to get a checkout.
    pub created_checkout: bool,
}

/// Turn a branch name into a single, safe path segment.
///
/// `feat/factory-worktrees` becomes `feat-factory-worktrees`: worktrees are
/// laid out one directory deep per project, so a branch with slashes must not
/// grow the tree (or, worse, escape it).
fn branch_slug(branch: &str) -> String {
    branch
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

/// Accept a value that may be used as one path segment.
///
/// Rejects traversal, separators, and the flag-shaped values that could reach
/// git as an option rather than a positional argument.
fn safe_path_segment(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.starts_with('-')
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || !trimmed.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-')
        })
    {
        return None;
    }
    Some(trimmed.to_string())
}

/// Run a local `git` invocation with no credential helper and no user config.
fn run_local_git(args: &[&str], cwd: &Path) -> Result<String, String> {
    let git = resolve_command("git").ok_or_else(|| "git was not found on PATH".to_string())?;
    let mut command = Command::new(git);
    command.args(args);
    command.current_dir(cwd);
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.env("GIT_CONFIG_NOSYSTEM", "1");
    // Git for Windows maps `/dev/null` to `NUL`, so this disables the global
    // config file on every platform git supports.
    command.env("GIT_CONFIG_GLOBAL", "/dev/null");
    for key in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"] {
        command.env_remove(key);
    }
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    crate::util::configure_no_window(&mut command);

    let output = command
        .output()
        .map_err(|error| format!("failed to run git: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("git exited with status {}", output.status)
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Whether a local branch of this name already exists in the checkout.
fn branch_exists(checkout: &Path, branch: &str) -> bool {
    run_local_git(
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
        checkout,
    )
    .is_ok()
}

/// The branch a path has checked out, when the path is a git working tree.
fn checked_out_branch(path: &Path) -> Option<String> {
    run_local_git(&["rev-parse", "--abbrev-ref", "HEAD"], path)
        .ok()
        .filter(|value| !value.is_empty())
}

fn display_path(path: &Path) -> String {
    let display = path.display().to_string();
    // Rust canonicalization returns verbatim paths on Windows. Git for Windows
    // normalizes their slashes and rejects the resulting //?/C:/ worktree path.
    #[cfg(windows)]
    {
        if let Some(unc) = display.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{unc}");
        }
        if let Some(drive) = display.strip_prefix(r"\\?\") {
            return drive.to_string();
        }
    }
    display
}

/// Create — or reuse — the worktree an agent runs in.
///
/// A project whose repository has never been cloned on this machine is cloned
/// first, the way [`open_project_terminal`](super::project_terminal) already
/// does, so launching an agent from a project channel never asks the owner to
/// clone by hand. Without a clone URL there is nothing to branch from and the
/// call fails: an agent is never silently dropped into the user's home
/// directory, which is where a checkout-less terminal would land.
#[tauri::command]
pub async fn factory_worktree_create(
    request: FactoryWorktreeRequest,
    state: State<'_, AppState>,
) -> Result<FactoryWorktreeResult, String> {
    let clone_url = request
        .clone_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    // Validate and build the credentials outside the blocking task: both
    // borrow Tauri state, which must not cross into it.
    let auth = match clone_url.as_deref() {
        Some(clone_url) => {
            validate_local_clone_url_for_workspace(clone_url, &state)?;
            build_git_clone_auth_config(clone_url, &state)
        }
        None => build_git_auth_config(&state),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let default_branch = request.from.clone();
        let repos_dir = request.repos_dir.clone();
        let project_dtag = request.project_dtag.trim().to_string();
        factory_worktree_create_blocking(request, |clone_url| {
            let auth = auth?;
            clone_project_repository_blocking(
                repos_dir.as_deref(),
                &project_dtag,
                clone_url,
                default_branch.as_deref(),
                &auth,
            )
        })
    })
    .await
    .map_err(|error| format!("factory worktree task failed: {error}"))?
}

/// The body of [`factory_worktree_create`], with the clone step injected.
///
/// The command passes the real relay clone; tests pass a local one, because
/// the workspace clone-URL validation only accepts http(s) Colony or GitHub
/// URLs and a test has neither.
fn factory_worktree_create_blocking<F>(
    request: FactoryWorktreeRequest,
    clone: F,
) -> Result<FactoryWorktreeResult, String>
where
    F: FnOnce(&str) -> Result<ProjectRepoCloneResult, String>,
{
    let branch = clean_branch(Some(request.branch.clone()))
        .ok_or_else(|| "worktree branch name is not valid".to_string())?;
    let from = clean_branch(request.from.clone()).unwrap_or_else(|| "HEAD".to_string());
    let project_dtag = request.project_dtag.trim();
    if project_dtag.is_empty() {
        return Err("worktree project is required".to_string());
    }
    let project_segment = safe_path_segment(project_dtag)
        .ok_or_else(|| "worktree project name is not valid".to_string())?;
    let slug = branch_slug(&branch);
    if slug.is_empty() {
        return Err("worktree branch name is not valid".to_string());
    }

    let clone_url = request
        .clone_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let existing = match find_local_repo_dir(
        request.repos_dir.as_deref(),
        project_dtag,
        request.clone_url.as_deref(),
    ) {
        Ok(found) => found,
        // A repos root that does not exist yet (fresh machine, nothing cloned)
        // is not fatal when there is something to clone: the clone below
        // creates the root. An explicit, misconfigured reposDir still errors
        // there, and with no clone URL the original error stands.
        Err(error) => {
            if clone_url.is_none() {
                return Err(error);
            }
            None
        }
    };
    let (checkout, created_checkout) = match existing {
        Some(checkout) => (checkout, false),
        None => {
            let clone_url = clone_url
                .ok_or_else(|| "this project has no local checkout to branch from".to_string())?;
            let cloned = clone(clone_url)?;
            (PathBuf::from(&cloned.path), cloned.cloned)
        }
    };
    let repos_root = checkout
        .parent()
        .ok_or_else(|| "the project checkout has no repositories root".to_string())?
        .to_path_buf();

    let worktree_parent = repos_root.join(WORKTREES_DIR).join(&project_segment);
    let worktree_path = worktree_parent.join(&slug);

    if worktree_path.exists() {
        return match checked_out_branch(&worktree_path) {
            Some(existing) if existing == branch => Ok(FactoryWorktreeResult {
                path: display_path(
                    &worktree_path
                        .canonicalize()
                        .unwrap_or_else(|_| worktree_path.clone()),
                ),
                branch,
                created: false,
                created_checkout,
            }),
            Some(existing) => Err(format!(
                "{} already holds branch {existing}",
                display_path(&worktree_path)
            )),
            None => Err(format!(
                "{} exists and is not a git worktree",
                display_path(&worktree_path)
            )),
        };
    }

    std::fs::create_dir_all(&worktree_parent)
        .map_err(|error| format!("failed to create the worktree directory: {error}"))?;

    let worktree_arg = display_path(&worktree_path);
    if branch_exists(&checkout, &branch) {
        run_local_git(&["worktree", "add", &worktree_arg, &branch], &checkout)?;
    } else {
        run_local_git(
            &["worktree", "add", "-b", &branch, &worktree_arg, &from],
            &checkout,
        )?;
    }

    let resolved: PathBuf = worktree_path
        .canonicalize()
        .unwrap_or_else(|_| worktree_path.clone());
    Ok(FactoryWorktreeResult {
        path: display_path(&resolved),
        branch,
        created: true,
        created_checkout,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[cfg(windows)]
    #[test]
    fn git_paths_preserve_drive_and_unc_roots_without_verbatim_prefix() {
        assert_eq!(
            display_path(Path::new(r"\\?\C:\repos\work")),
            r"C:\repos\work"
        );
        assert_eq!(
            display_path(Path::new(r"\\?\UNC\server\share\work")),
            r"\\server\share\work"
        );
        assert_eq!(display_path(Path::new(r"C:\repos\work")), r"C:\repos\work");
    }

    /// A checkout named after its project dtag, with one commit on `main`.
    fn fixture_repo(root: &Path, dtag: &str) -> PathBuf {
        let checkout = root.join(dtag);
        fs::create_dir_all(&checkout).expect("checkout dir");
        run_local_git(&["init", "-b", "main"], &checkout).expect("git init");
        run_local_git(&["config", "user.email", "factory@example.test"], &checkout)
            .expect("git config email");
        run_local_git(&["config", "user.name", "Factory"], &checkout).expect("git config name");
        fs::write(checkout.join("README.md"), "factory\n").expect("seed file");
        run_local_git(&["add", "README.md"], &checkout).expect("git add");
        run_local_git(&["commit", "-m", "seed"], &checkout).expect("git commit");
        checkout
    }

    fn request(root: &Path, dtag: &str, branch: &str) -> FactoryWorktreeRequest {
        FactoryWorktreeRequest {
            repos_dir: Some(root.to_string_lossy().to_string()),
            project_dtag: dtag.to_string(),
            clone_url: None,
            branch: branch.to_string(),
            from: Some("main".to_string()),
        }
    }

    /// The command's body with a clone step that must never run.
    fn create(request: FactoryWorktreeRequest) -> Result<FactoryWorktreeResult, String> {
        factory_worktree_create_blocking(request, |_| Err("this test must not clone".to_string()))
    }

    #[test]
    fn branch_slug_flattens_and_trims() {
        assert_eq!(
            branch_slug("feat/factory-worktrees"),
            "feat-factory-worktrees"
        );
        assert_eq!(branch_slug("feat/"), "feat");
        assert_eq!(branch_slug("a b/c"), "a-b-c");
    }

    #[test]
    fn safe_path_segment_rejects_traversal_and_flags() {
        assert_eq!(safe_path_segment(" colony "), Some("colony".to_string()));
        assert_eq!(safe_path_segment(".."), None);
        assert_eq!(safe_path_segment("a/b"), None);
        assert_eq!(safe_path_segment("--force"), None);
        assert_eq!(safe_path_segment(""), None);
    }

    #[test]
    fn creates_a_worktree_for_a_new_branch() {
        let root = tempfile::tempdir().expect("tempdir");
        fixture_repo(root.path(), "factory-fixture");
        let result = create(request(
            root.path(),
            "factory-fixture",
            "feat/factory-worktrees",
        ))
        .expect("worktree creation");
        assert!(result.created);
        assert_eq!(result.branch, "feat/factory-worktrees");
        assert!(result.path.ends_with("feat-factory-worktrees"));
        assert!(Path::new(&result.path).join("README.md").exists());
    }

    #[test]
    fn reuses_an_existing_worktree_for_the_same_branch() {
        let root = tempfile::tempdir().expect("tempdir");
        fixture_repo(root.path(), "factory-fixture");
        let first =
            create(request(root.path(), "factory-fixture", "feat/reuse")).expect("first worktree");
        let second =
            create(request(root.path(), "factory-fixture", "feat/reuse")).expect("second worktree");
        assert!(first.created);
        assert!(!second.created);
        assert_eq!(first.path, second.path);
    }

    #[test]
    fn checks_out_a_branch_that_already_exists() {
        let root = tempfile::tempdir().expect("tempdir");
        let checkout = fixture_repo(root.path(), "factory-fixture");
        run_local_git(&["branch", "feat/existing"], &checkout).expect("create branch");
        let result = create(request(root.path(), "factory-fixture", "feat/existing"))
            .expect("worktree for existing branch");
        assert!(result.created);
        assert_eq!(
            checked_out_branch(Path::new(&result.path)).as_deref(),
            Some("feat/existing")
        );
    }

    #[test]
    fn refuses_a_project_without_a_local_checkout() {
        let root = tempfile::tempdir().expect("tempdir");
        let error = create(request(root.path(), "missing-project", "feat/x"))
            .expect_err("missing checkout must fail");
        assert!(error.contains("no local checkout"), "unexpected: {error}");
    }

    #[test]
    fn clones_the_project_when_there_is_no_checkout() {
        let source = tempfile::tempdir().expect("source tempdir");
        fixture_repo(source.path(), "factory-fixture");
        let bare = source.path().join("factory-fixture.git");
        run_local_git(
            &[
                "clone",
                "--bare",
                &display_path(&source.path().join("factory-fixture")),
                &display_path(&bare),
            ],
            source.path(),
        )
        .expect("bare clone");

        // An empty repos root: nothing has ever been cloned on this machine.
        let root = tempfile::tempdir().expect("tempdir");
        let mut request = request(root.path(), "factory-fixture", "feat/first-launch");
        request.clone_url = Some(display_path(&bare));
        let cloned_to = root.path().join("factory-fixture");
        let result = factory_worktree_create_blocking(request, |clone_url| {
            run_local_git(
                &["clone", clone_url, &display_path(&cloned_to)],
                root.path(),
            )?;
            Ok(ProjectRepoCloneResult {
                path: display_path(&cloned_to),
                cloned: true,
                message: "cloned".to_string(),
            })
        })
        .expect("worktree after clone");

        assert!(result.created);
        assert!(result.created_checkout);
        assert_eq!(result.branch, "feat/first-launch");
        assert!(result.path.ends_with("feat-first-launch"));
        assert!(Path::new(&result.path).join("README.md").exists());
    }

    #[test]
    fn reports_no_clone_when_the_checkout_already_exists() {
        let root = tempfile::tempdir().expect("tempdir");
        fixture_repo(root.path(), "factory-fixture");
        let result = create(request(root.path(), "factory-fixture", "feat/no-clone"))
            .expect("worktree creation");
        assert!(!result.created_checkout);
    }

    #[test]
    fn refuses_a_flag_shaped_branch() {
        let root = tempfile::tempdir().expect("tempdir");
        fixture_repo(root.path(), "factory-fixture");
        let error = create(request(
            root.path(),
            "factory-fixture",
            "--upload-pack=evil",
        ))
        .expect_err("flag-shaped branch must fail");
        assert!(error.contains("not valid"), "unexpected: {error}");
    }
}
