use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamRecord {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// Runtime-layered instructions shared by every member deployment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    pub persona_ids: Vec<String>,
    /// Persona responsible for delegation and QA. A lead is always also a
    /// member; every write path validates that invariant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lead_persona_id: Option<String>,
    #[serde(default)]
    pub is_builtin: bool,
    /// Recipe id that provisioned this team on the owner's behalf, or `None`
    /// for a team the user created. A `Some` value marks the team as provided
    /// by Colony: the owner cannot delete it, and its owned content is
    /// upgraded when the recipe version changes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provisioned: Option<String>,
    /// Recipe version that last wrote the content Colony owns.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provisioned_version: Option<String>,
    /// Absolute path to the team's backing directory (if directory-backed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_dir: Option<PathBuf>,
    /// Whether `source_dir` is a symlink to an external directory.
    #[serde(default)]
    pub is_symlink: bool,
    /// Resolved symlink target path (for display). Only set when `is_symlink` is true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symlink_target: Option<String>,
    /// Version from the team's `plugin.json` manifest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The community this team belongs to, as a relay URL.
    ///
    /// Local-only bookkeeping: deliberately absent from `TeamEventContent`, so
    /// it never reaches the wire. One `teams.json` is shared by every
    /// community the user has joined, and a team that only makes sense on one
    /// relay must not list members, own tasks, or be published anywhere else.
    ///
    /// `None` means unpinned: the record predates the pin, or it is a plain
    /// user team that has no community of its own. Unpinned records behave
    /// exactly as they did before the pin existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay_url: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
