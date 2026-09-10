//! Install the recipe's skill files into the agent workspace.
//!
//! Runtimes load skills from the nest (`~/.buzz`) under `.agents/skills`, with
//! provider-specific symlink directories (`.claude/skills`, `.codex/skills`,
//! `.goose/skills`) mirroring the canonical tree — the same layout
//! `nest.rs::ensure_nest_at` uses for the bundled buzz-cli skill.
//!
//! Preservation contract: a skill file the user edited is never overwritten.
//! The installer records the SHA-256 of the exact content it last wrote; if the
//! file on disk still matches that hash it is ours and may be upgraded when the
//! recipe version changes, and if it does not, the file is a user edit and is
//! left alone.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::recipe::{RecipeSkill, SKILLS};
#[cfg(unix)]
use crate::util::create_symlink;

/// Marker file recording the recipe version and content hash of the last
/// install-written skill, relative to the skill directory.
const SKILL_MARKER_FILE: &str = ".website-skill.json";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledWebsiteSkill {
    pub name: String,
    pub path: String,
    pub status: String,
    pub detail: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SkillMarker {
    version: u32,
    sha256: String,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn read_marker(path: &Path) -> Option<SkillMarker> {
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn write_marker(path: &Path, version: u32, content: &str) -> Result<(), String> {
    let marker = SkillMarker {
        version,
        sha256: sha256_hex(content.as_bytes()),
    };
    let payload = serde_json::to_vec_pretty(&marker)
        .map_err(|error| format!("serialize skill marker: {error}"))?;
    // A marker is bookkeeping; write it atomically through the same helper the
    // rest of the store uses so a crash cannot leave a half-written marker.
    crate::managed_agents::storage::atomic_write_json(path, &payload)
}

/// Canonical skill directory for `name` under the nest root.
pub fn canonical_skill_dir(root: &Path, name: &str) -> PathBuf {
    root.join(".agents").join("skills").join(name)
}

fn install_one(root: &Path, skill: &RecipeSkill) -> InstalledWebsiteSkill {
    let dir = canonical_skill_dir(root, skill.name);
    let target = dir.join("SKILL.md");
    let marker_path = dir.join(SKILL_MARKER_FILE);
    let path_display = target.display().to_string();

    if let Err(error) = fs::create_dir_all(&dir) {
        return InstalledWebsiteSkill {
            name: skill.name.to_string(),
            path: path_display,
            status: "failed".to_string(),
            detail: Some(format!("create {}: {error}", dir.display())),
        };
    }

    let existing = fs::read_to_string(&target).ok();
    let has_existing = existing.is_some();
    let mut status = if has_existing {
        "unchanged"
    } else {
        "installed"
    };
    let mut detail = None;

    let should_write = match existing.as_deref() {
        None => true,
        Some(content) if content == skill.content => {
            // Already current: refresh the marker so a later recipe bump can
            // recognize this file as installer-authored.
            true
        }
        Some(content) => {
            let existing_hash = sha256_hex(content.as_bytes());
            let ours =
                read_marker(&marker_path).is_some_and(|marker| marker.sha256 == existing_hash);
            if ours {
                status = "updated";
                true
            } else {
                status = "preserved";
                detail =
                    Some("Kept your edited copy; the bundled recipe was not applied.".to_string());
                false
            }
        }
    };

    if should_write {
        if let Err(error) = write_skill_file(&target, skill.content) {
            return InstalledWebsiteSkill {
                name: skill.name.to_string(),
                path: path_display,
                status: "failed".to_string(),
                detail: Some(error),
            };
        }
        if let Err(error) = write_marker(&marker_path, skill.version, skill.content) {
            eprintln!("buzz-desktop: website-team skill marker: {error}");
        }
    }

    if let Err(error) = ensure_provider_links(root, skill.name) {
        detail = Some(match detail {
            Some(existing) => format!("{existing} Provider skill link: {error}"),
            None => format!("Provider skill link: {error}"),
        });
    }

    InstalledWebsiteSkill {
        name: skill.name.to_string(),
        path: path_display,
        status: status.to_string(),
        detail,
    }
}

fn write_skill_file(target: &Path, content: &str) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "skill path has no parent".to_string())?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("tempfile in {}: {error}", parent.display()))?;
    {
        use std::io::Write;
        tmp.write_all(content.as_bytes())
            .map_err(|error| format!("write tempfile: {error}"))?;
    }
    tmp.persist(target)
        .map_err(|error| format!("persist {}: {error}", target.display()))?;
    Ok(())
}

/// Create the provider-specific symlinks that point at the canonical skill.
///
/// Skips any path that already exists (real directory or symlink), matching
/// `nest.rs::ensure_skill_symlinks`; a user's own copy is never replaced.
#[cfg(unix)]
fn ensure_provider_links(root: &Path, name: &str) -> Result<(), String> {
    for skill_dir in crate::managed_agents::known_skill_dirs() {
        let parent = root.join(skill_dir);
        fs::create_dir_all(&parent)
            .map_err(|error| format!("create {}: {error}", parent.display()))?;
        let link = parent.join(name);
        if link.symlink_metadata().is_ok() {
            continue;
        }
        let depth = std::path::Path::new(skill_dir).components().count();
        let prefix = "../".repeat(depth);
        let target = format!("{prefix}.agents/skills/{name}");
        create_symlink(std::path::Path::new(&target), &link)
            .map_err(|error| format!("symlink {} -> {}: {error}", link.display(), target))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn ensure_provider_links(_root: &Path, _name: &str) -> Result<(), String> {
    Ok(())
}

/// Install every recipe skill under `root`, returning one outcome per skill.
///
/// Never fails the whole install: a per-skill filesystem error is reported in
/// that skill's outcome so the UI can show the real state.
pub fn install_recipe_skills(root: &Path) -> Vec<InstalledWebsiteSkill> {
    SKILLS
        .iter()
        .map(|skill| install_one(root, skill))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_root() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn installs_every_skill_and_is_idempotent() {
        let root = temp_root();
        let first = install_recipe_skills(root.path());
        assert_eq!(first.len(), SKILLS.len());
        assert!(first.iter().all(|skill| skill.status == "installed"));

        let second = install_recipe_skills(root.path());
        assert!(second.iter().all(|skill| skill.status == "unchanged"));

        let skill = canonical_skill_dir(root.path(), "website-research").join("SKILL.md");
        assert!(skill.exists());
    }

    #[test]
    fn preserves_a_user_edited_skill() {
        let root = temp_root();
        let dir = canonical_skill_dir(root.path(), "website-research");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), "my edited runbook").unwrap();

        let outcomes = install_recipe_skills(root.path());
        let research = outcomes
            .iter()
            .find(|skill| skill.name == "website-research")
            .unwrap();
        assert_eq!(research.status, "preserved");
        assert_eq!(
            fs::read_to_string(dir.join("SKILL.md")).unwrap(),
            "my edited runbook"
        );
    }

    #[test]
    fn upgrades_an_installer_written_skill() {
        let root = temp_root();
        let dir = canonical_skill_dir(root.path(), "website-research");
        fs::create_dir_all(&dir).unwrap();
        // Simulate an older recipe install: our marker plus old content.
        write_marker(&dir.join(SKILL_MARKER_FILE), 0, "an older bundled runbook").unwrap();
        fs::write(dir.join("SKILL.md"), "an older bundled runbook").unwrap();

        let outcomes = install_recipe_skills(root.path());
        let research = outcomes
            .iter()
            .find(|skill| skill.name == "website-research")
            .unwrap();
        assert_eq!(research.status, "updated");
        assert!(fs::read_to_string(dir.join("SKILL.md"))
            .unwrap()
            .contains("Website Research"));
    }

    #[test]
    fn provider_links_point_at_the_canonical_skill() {
        let root = temp_root();
        install_recipe_skills(root.path());
        #[cfg(unix)]
        {
            let link = root.path().join(".claude/skills/website-research/SKILL.md");
            assert!(link.exists(), "claude skill link should resolve");
        }
    }
}
