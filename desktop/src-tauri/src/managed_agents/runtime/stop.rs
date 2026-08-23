use std::collections::HashMap;

use tauri::AppHandle;

use super::{
    append_log_marker, current_instance_id, now_iso, process_belongs_to_us,
    process_has_buzz_marker, process_is_running, terminate_process, ManagedAgentPairRuntime,
    ManagedAgentRecord, ManagedAgentRuntimeKey,
};

pub(crate) fn managed_agent_runtime_keys<T>(
    runtimes: &HashMap<ManagedAgentRuntimeKey, T>,
    pubkey: &str,
) -> Vec<ManagedAgentRuntimeKey> {
    runtimes
        .keys()
        .filter(|key| key.pubkey.eq_ignore_ascii_case(pubkey))
        .cloned()
        .collect()
}

#[cfg(test)]
pub(crate) fn managed_agent_runtime_relay_urls<T>(
    runtimes: &HashMap<ManagedAgentRuntimeKey, T>,
    pubkey: &str,
) -> Vec<String> {
    managed_agent_runtime_keys(runtimes, pubkey)
        .into_iter()
        .map(|key| key.relay_url)
        .collect()
}

/// Stop the single tracked runtime pair at `key`, if present.
///
/// Terminates the child, records the exit code, removes the pair receipt,
/// and appends a stop marker to the pair log. On teardown failure the
/// runtime is reinserted so the pair stays visible and stoppable instead of
/// becoming an invisible orphan. Touches no other pair for the agent and
/// does no record-level stop bookkeeping — callers own that.
fn stop_managed_agent_pair(
    app: &AppHandle,
    record: &mut ManagedAgentRecord,
    runtimes: &mut HashMap<ManagedAgentRuntimeKey, ManagedAgentPairRuntime>,
    key: &ManagedAgentRuntimeKey,
) -> Result<(), String> {
    let Some(mut runtime) = runtimes.remove(key) else {
        return Ok(());
    };
    let result = (|| -> Result<(), String> {
        #[cfg(unix)]
        terminate_process(runtime.child.id())?;
        #[cfg(windows)]
        match runtime.job.take() {
            Some(job) => drop(job),
            None => runtime
                .child
                .kill()
                .map_err(|error| format!("failed to kill agent process: {error}"))?,
        }
        #[cfg(not(any(unix, windows)))]
        runtime
            .child
            .kill()
            .map_err(|error| format!("failed to kill agent process: {error}"))?;
        let status = runtime
            .child
            .wait()
            .map_err(|error| format!("failed to wait for agent shutdown: {error}"))?;
        record.last_exit_code = status.code();
        super::super::remove_agent_runtime_receipt(app, key);
        if let Err(error) = append_log_marker(
            &runtime.log_path,
            &format!(
                "=== stopped {} ({}) at {} ===",
                record.name,
                record.pubkey,
                now_iso()
            ),
        ) {
            eprintln!(
                "buzz-desktop: failed to append stop marker for {} on {}: {error}",
                record.pubkey, key.relay_url
            );
        }
        Ok(())
    })();
    if let Err(error) = result {
        // Keep failed teardown visible/manageable instead of orphaning it.
        runtimes.insert(key.clone(), runtime);
        return Err(error);
    }
    Ok(())
}

/// Terminate a legacy scalar-PID child (pre-pair records) and remove the
/// agent-scoped pid file. Pair receipts are restored separately.
fn stop_legacy_scalar_pid(app: &AppHandle, record: &mut ManagedAgentRecord) -> Result<(), String> {
    if let Some(pid) = record.runtime_pid.take() {
        if process_is_running(pid)
            && process_belongs_to_us(pid)
            && process_has_buzz_marker(pid, &current_instance_id(app))
        {
            terminate_process(pid)?;
        }
        record.updated_at = now_iso();
    }
    super::super::remove_agent_pid_file(app, &record.pubkey);
    Ok(())
}

/// Stop the runtime pair this record resolves to for the active workspace
/// (explicit relay pin, else the active workspace relay) — the pair-scoped
/// counterpart of [`stop_managed_agent_process`], which drains every pair.
///
/// Community-scoped surfaces (profile panel, Agents tab, auto-restart) stop
/// through here so stopping an agent in one community never tears down its
/// pairs in other communities. Clears the matching agent session cache
/// (pair-scoped when a pair key resolves). When no pair is tracked for this
/// workspace, only legacy scalar-PID cleanup runs.
pub fn stop_managed_agent_workspace_pair(
    app: &AppHandle,
    record: &mut ManagedAgentRecord,
    runtimes: &mut HashMap<ManagedAgentRuntimeKey, ManagedAgentPairRuntime>,
) -> Result<(), String> {
    use tauri::Manager;
    let state = app.state::<crate::app_state::AppState>();
    match super::workspace_pair_key(app, record) {
        Some(pair_key) if runtimes.contains_key(&pair_key) => {
            stop_managed_agent_pair(app, record, runtimes, &pair_key)?;
            state.clear_agent_session_cache(&pair_key);
            super::super::remove_agent_pid_file(app, &record.pubkey);
            let now = now_iso();
            record.runtime_pid = None;
            record.updated_at = now.clone();
            record.last_stopped_at = Some(now);
            record.last_error = None;
            record.last_error_code = None;
        }
        Some(pair_key) => {
            // No tracked pair here — a pubkey-wide cache clear would disturb
            // live pairs in other communities, so stay pair-scoped.
            stop_legacy_scalar_pid(app, record)?;
            state.clear_agent_session_cache(&pair_key);
        }
        None => {
            stop_legacy_scalar_pid(app, record)?;
            state.clear_agent_session_caches(&record.pubkey);
        }
    }
    Ok(())
}

/// The tracked pairs whose key relay canonicalizes equal to the given
/// community relay — the selection core of [`stop_managed_agents_pinned_to`],
/// kept pure so the boundary decision is unit-testable.
fn keys_pinned_to<'a, T: 'a>(
    runtimes: impl IntoIterator<Item = (&'a ManagedAgentRuntimeKey, &'a T)>,
    relay_url: &str,
) -> Vec<ManagedAgentRuntimeKey> {
    let target = buzz_core_pkg::relay::normalize_relay_url(relay_url).ok();
    runtimes
        .into_iter()
        .filter(|(key, _)| Some(&key.relay_url) == target.as_ref())
        .map(|(key, _)| key.clone())
        .collect()
}

/// Stop every tracked runtime pair pinned to `relay_url` — the teardown half
/// of "an agent belongs to exactly one community".
///
/// A community switch must not leave the community's agents running against a
/// relay nobody is viewing: leaving stops them. Only pairs whose key relay
/// canonicalizes equal to the given relay are touched; pairs in other
/// communities and legacy scalar-PID children are left alone. Record-level
/// stop bookkeeping mirrors [`stop_managed_agent_workspace_pair`]'s pair arm.
///
/// Caller owns the records/runtimes maps and the surrounding locks; returns
/// the pubkeys whose pairs were stopped (in map order).
pub(crate) fn stop_managed_agents_pinned_to(
    app: &AppHandle,
    relay_url: &str,
    records: &mut [ManagedAgentRecord],
    runtimes: &mut HashMap<ManagedAgentRuntimeKey, ManagedAgentPairRuntime>,
) -> Result<Vec<String>, String> {
    use tauri::Manager;
    let state = app.state::<crate::app_state::AppState>();

    let mut stopped = Vec::new();
    for key in keys_pinned_to(runtimes.iter(), relay_url) {
        let Some(record) = records
            .iter_mut()
            .find(|record| record.pubkey.eq_ignore_ascii_case(&key.pubkey))
        else {
            continue;
        };
        stop_managed_agent_pair(app, record, runtimes, &key)?;
        state.clear_agent_session_cache(&key);
        let now = now_iso();
        record.runtime_pid = None;
        record.updated_at = now.clone();
        record.last_stopped_at = Some(now);
        stopped.push(key.pubkey);
    }
    Ok(stopped)
}

pub fn stop_managed_agent_process(
    app: &AppHandle,
    record: &mut ManagedAgentRecord,
    runtimes: &mut HashMap<ManagedAgentRuntimeKey, ManagedAgentPairRuntime>,
) -> Result<(), String> {
    let keys = managed_agent_runtime_keys(runtimes, &record.pubkey);
    if keys.is_empty() {
        return stop_legacy_scalar_pid(app, record);
    }

    let mut errors = Vec::new();
    for key in keys {
        if let Err(error) = stop_managed_agent_pair(app, record, runtimes, &key) {
            errors.push(format!("{}: {error}", key.relay_url));
        }
    }

    let now = now_iso();
    record.runtime_pid = None;
    record.updated_at = now.clone();
    record.last_stopped_at = Some(now);
    record.last_error = None;
    record.last_error_code = None;
    super::super::remove_agent_pid_file(app, &record.pubkey);

    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "failed to stop one or more managed-agent runtimes: {}",
            errors.join("; ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Community-switch teardown must stop ONLY the outgoing community's
    /// pairs. An agent pinned elsewhere (or an unrelated agent on the same
    /// relay) keeps running; equivalent spellings of the outgoing relay are
    /// the same community and must match.
    #[test]
    fn community_stop_selects_only_pairs_of_the_outgoing_relay() {
        let horizon_luke = ManagedAgentRuntimeKey::new(
            "3e5e1624266baf36c5c8e0c89c159914e894b51d1f7fdcba00b4afea68d709a3",
            "wss://horizon.example.com",
        )
        .unwrap();
        let colony_luke = ManagedAgentRuntimeKey::new(
            "6846a5551f47c4dc78ab3caaef5fe9a95e2bda3eb475a5469e8874712a793810",
            "wss://colony.example.com",
        )
        .unwrap();
        let colony_spelled_differently = ManagedAgentRuntimeKey::new(
            "1111111111111111111111111111111111111111111111111111111111111111",
            "WSS://Colony.Example.com:443/",
        )
        .unwrap();

        let runtimes = HashMap::from([
            (horizon_luke.clone(), ()),
            (colony_luke.clone(), ()),
            (colony_spelled_differently, ()),
        ]);

        let mut selected = keys_pinned_to(runtimes.iter(), "wss://colony.example.com");
        selected.sort_by(|left, right| left.pubkey.cmp(&right.pubkey));

        assert_eq!(selected.len(), 2, "both Colony pairs stop");
        assert!(selected.contains(&colony_luke));
        // Horizon's pair is a different community and survives.
        assert!(!selected.contains(&horizon_luke));
    }

    #[test]
    fn pair_preserving_restart_targets_exact_original_relays() {
        let agent = "aa".repeat(32);
        let other = "bb".repeat(32);
        let first = ManagedAgentRuntimeKey::new(&agent, "wss://one.example").unwrap();
        let second = ManagedAgentRuntimeKey::new(&agent, "wss://two.example").unwrap();
        let unrelated = ManagedAgentRuntimeKey::new(other, "wss://fallback.example").unwrap();
        let runtimes = HashMap::from([(first, ()), (second, ()), (unrelated, ())]);

        let mut relays = managed_agent_runtime_relay_urls(&runtimes, &agent);
        relays.sort();
        assert_eq!(
            relays,
            vec![
                "wss://one.example".to_string(),
                "wss://two.example".to_string()
            ]
        );
    }

    #[test]
    fn pair_scoped_selection_targets_only_the_exact_pair() {
        // stop_managed_agent_workspace_pair resolves one key and removes only
        // that map entry: the same agent's pair on another relay and other
        // agents' pairs must survive a pair-scoped stop.
        let agent = "aa".repeat(32);
        let other = "bb".repeat(32);
        let viewed = ManagedAgentRuntimeKey::new(&agent, "wss://one.example").unwrap();
        let elsewhere = ManagedAgentRuntimeKey::new(&agent, "wss://two.example").unwrap();
        let unrelated = ManagedAgentRuntimeKey::new(other, "wss://one.example").unwrap();
        let mut runtimes = HashMap::from([
            (viewed.clone(), ()),
            (elsewhere.clone(), ()),
            (unrelated.clone(), ()),
        ]);

        // Non-canonical spelling of the viewed workspace relay resolves to
        // the same canonical key that spawn stamped.
        let resolved = ManagedAgentRuntimeKey::new(&agent, "WSS://One.Example:443/").unwrap();
        assert_eq!(resolved, viewed);
        assert!(runtimes.remove(&resolved).is_some());
        assert!(runtimes.contains_key(&elsewhere));
        assert!(runtimes.contains_key(&unrelated));
    }

    #[test]
    fn agent_wide_selection_drains_every_pair_only_for_that_agent() {
        let agent = "aa".repeat(32);
        let other = "bb".repeat(32);
        let first = ManagedAgentRuntimeKey::new(&agent, "wss://one.example").unwrap();
        let second = ManagedAgentRuntimeKey::new(&agent, "wss://two.example").unwrap();
        let unrelated = ManagedAgentRuntimeKey::new(other, "wss://one.example").unwrap();
        let runtimes = HashMap::from([(first.clone(), ()), (second.clone(), ()), (unrelated, ())]);

        let mut selected = managed_agent_runtime_keys(&runtimes, &agent);
        selected.sort_by(|left, right| left.relay_url.cmp(&right.relay_url));
        assert_eq!(selected, vec![first, second]);
    }
}
