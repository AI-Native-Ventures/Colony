//! One-shot storage migration (S1): clear the stamped `runtime` harness pin
//! from every agent record and definition so every agent follows the global
//! default harness.
//!
//! Owner decision, 2026-08-23: 12 of 13 definitions carried a `runtime`
//! stamped at create time, never chosen by the user, which starved
//! `global.preferred_runtime` of almost every agent it was meant to govern.
//! This migration removes the stamp everywhere — records AND key-less
//! definition records sharing the unified store, plus the pre-fold
//! `personas.json` on stores that have not folded yet — so the inheritance
//! chain in `effective_config::resolve_effective_runtime_id`
//! (record → definition → global) starts from a clean slate.
//!
//! One-shot by design: gated behind a marker file
//! (`agents/runtime-inherit-migration.done`) so pins the user deliberately
//! sets AFTER this migration are never wiped by a later launch. Runs after
//! `materialize_agent_runtimes` in the boot order so the mirror that
//! materialization inserts from definitions is cleared in the same pass; on
//! subsequent boots materialization finds no definition runtimes to mirror
//! until the user pins one again.
//!
//! Known boundary: team-directory personas are non-editable and their
//! harness is re-imported from the team dir by `sync_team_personas` after
//! boot migrations. Their definitions regain the team-authored runtime each
//! launch; this migration does not fight the team source of truth.

use std::path::Path;

use tauri::Manager as _;

use super::canonical_dev_data_dir;

const MARKER_FILE: &str = "runtime-inherit-migration.done";

/// Store files whose top-level objects may carry a `runtime` pin. Both hold
/// JSON arrays of objects; missing files are skipped.
const STORE_FILES: &[&str] = &["managed-agents.json", "personas.json"];

pub fn clear_agent_runtime_pins(app: &tauri::AppHandle) {
    let Ok(current_dir) = app.path().app_data_dir() else {
        return;
    };
    let mut dirs = vec![current_dir.clone()];
    if let Some(canonical) = canonical_dev_data_dir(&current_dir) {
        if canonical.exists() && canonical != current_dir {
            dirs.push(canonical);
        }
    }
    for dir in dirs {
        clear_runtime_pins_in_dir(&dir);
    }
}

fn clear_runtime_pins_in_dir(dir: &Path) {
    let agents_dir = dir.join("agents");
    let marker = agents_dir.join(MARKER_FILE);
    if marker.exists() {
        return;
    }
    if std::fs::create_dir_all(&agents_dir).is_err() {
        eprintln!(
            "buzz-desktop: runtime-inherit-migration: cannot create {}",
            agents_dir.display()
        );
        return;
    }

    // Parse failures leave that file untouched and suppress the marker so the
    // migration retries next boot instead of silently consuming the one shot.
    let mut failed = false;
    for name in STORE_FILES {
        let path = agents_dir.join(name);
        if !path.exists() {
            continue;
        }
        if let Err(error) = clear_runtime_pins_in_file(&path) {
            eprintln!("buzz-desktop: runtime-inherit-migration: {name}: {error}");
            failed = true;
        }
    }
    if failed {
        return;
    }
    if let Err(error) = std::fs::write(&marker, b"ok\n") {
        eprintln!(
            "buzz-desktop: runtime-inherit-migration: failed to write {}: {error}",
            marker.display()
        );
    }
}

/// Remove the `runtime` key from every object in the JSON array at `path`.
///
/// Returns whether anything changed. Writes back owner-only
/// (`atomic_write_json_restricted`) — the unified store can carry plaintext
/// nsecs on keyringless hosts, so the same rule as `patch_json_records`
/// applies.
fn clear_runtime_pins_in_file(path: &Path) -> Result<bool, String> {
    let content = std::fs::read_to_string(path).map_err(|e| format!("failed to read: {e}"))?;
    let mut records: Vec<serde_json::Value> =
        serde_json::from_str(&content).map_err(|e| format!("failed to parse: {e}"))?;
    let mut changed = false;
    for record in &mut records {
        if let Some(obj) = record.as_object_mut() {
            changed |= obj.remove("runtime").is_some();
        }
    }
    if changed {
        let bytes =
            serde_json::to_vec_pretty(&records).map_err(|e| format!("failed to serialize: {e}"))?;
        crate::managed_agents::atomic_write_json_restricted(path, &bytes)?;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::clear_runtime_pins_in_dir;
    use crate::migration::test_support::{
        read_agents_json, write_agents_json, write_personas_json,
    };

    #[test]
    fn clears_runtime_on_records_and_definitions_and_writes_marker_once() {
        let dir = tempfile::tempdir().unwrap();
        write_agents_json(
            dir.path(),
            &serde_json::json!([
                // Key-less definition record (unified store).
                { "slug": "chief-of-staff", "pubkey": "", "runtime": "codex", "name": "Chief" },
                // Deployed instance with its own pinned runtime.
                { "pubkey": "abc123", "name": "Luke", "persona_id": "chief-of-staff", "runtime": "claude" },
                // Instance with no runtime at all.
                { "pubkey": "def456", "name": "Scout" }
            ]),
        );

        let agents_dir = dir.path().join("agents");
        let marker = agents_dir.join(super::MARKER_FILE);
        assert!(!marker.exists());

        clear_runtime_pins_in_dir(dir.path());
        assert!(marker.exists(), "a clean pass must write the marker");

        let records = read_agents_json(dir.path());
        assert!(
            records[0].get("runtime").is_none(),
            "definition runtime must be cleared"
        );
        assert!(
            records[1].get("runtime").is_none(),
            "record runtime must be cleared"
        );
        assert_eq!(
            records[2],
            serde_json::json!({ "pubkey": "def456", "name": "Scout" })
        );
    }

    #[test]
    fn second_run_is_a_no_op_after_the_marker() {
        let dir = tempfile::tempdir().unwrap();
        write_agents_json(
            dir.path(),
            &serde_json::json!([{ "pubkey": "abc", "runtime": "goose" }]),
        );
        clear_runtime_pins_in_dir(dir.path());
        assert!(read_agents_json(dir.path())[0].get("runtime").is_none());

        // A pin set AFTER the migration must survive later launches.
        write_agents_json(
            dir.path(),
            &serde_json::json!([{ "pubkey": "abc", "runtime": "goose" }]),
        );
        clear_runtime_pins_in_dir(dir.path());
        assert_eq!(
            read_agents_json(dir.path())[0]["runtime"],
            serde_json::json!("goose"),
            "the one-shot gate must not wipe pins set after the migration ran"
        );
    }

    #[test]
    fn clears_legacy_prefold_personas_json_too() {
        let dir = tempfile::tempdir().unwrap();
        write_personas_json(
            dir.path(),
            &serde_json::json!([{ "id": "persona-1", "displayName": "Alice", "runtime": "goose" }]),
        );
        write_agents_json(
            dir.path(),
            &serde_json::json!([{ "pubkey": "abc", "persona_id": "persona-1", "runtime": "goose" }]),
        );

        clear_runtime_pins_in_dir(dir.path());

        let personas = crate::migration::test_support::read_personas_json(dir.path());
        assert!(personas[0].get("runtime").is_none());
        assert!(read_agents_json(dir.path())[0].get("runtime").is_none());
    }

    #[test]
    fn unparsable_store_suppresses_marker_so_migration_retries() {
        let dir = tempfile::tempdir().unwrap();
        let agents_dir = dir.path().join("agents");
        std::fs::create_dir_all(&agents_dir).unwrap();
        std::fs::write(agents_dir.join("managed-agents.json"), "not json").unwrap();

        clear_runtime_pins_in_dir(dir.path());

        assert!(
            !agents_dir.join(super::MARKER_FILE).exists(),
            "a failed pass must not consume the one-shot gate"
        );
    }

    #[test]
    fn other_fields_are_untouched() {
        let dir = tempfile::tempdir().unwrap();
        write_agents_json(
            dir.path(),
            &serde_json::json!([{
                "pubkey": "abc",
                "name": "Luke",
                "runtime": "codex",
                "model": "stealth/ox-alpha",
                "agent_command_override": "/usr/local/bin/goose"
            }]),
        );

        clear_runtime_pins_in_dir(dir.path());

        let record = &read_agents_json(dir.path())[0];
        assert!(record.get("runtime").is_none());
        assert_eq!(record["model"], serde_json::json!("stealth/ox-alpha"));
        assert_eq!(
            record["agent_command_override"],
            serde_json::json!("/usr/local/bin/goose"),
            "explicit per-instance command pins are a different field and must survive"
        );
    }
}
