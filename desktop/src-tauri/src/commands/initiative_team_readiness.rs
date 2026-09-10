//! Publish and verify this owner's genuine Team before signing a first-job Task.

use buzz_core_pkg::kind::{KIND_NIP43_MEMBERSHIP_LIST, KIND_TEAM};
use buzz_sdk_pkg::{company::CompanyAction, company_blueprint::sign_action};
use nostr::{Event, JsonUtil, Keys};
use tauri::{AppHandle, Manager};

use super::attach_scope::AttachScope;
use crate::{
    app_state::AppState,
    managed_agents::{
        load_teams_readonly,
        retention::{get_retained_event, scoped_retention_db_path, tombstone_retention_d_tag},
        team_events::{build_team_event, team_event_content},
        TeamRecord,
    },
};

#[path = "initiative_team_readiness_policy.rs"]
mod policy;

struct Snapshot {
    fingerprint: serde_json::Value,
    candidate: TeamRecord,
    deletion: Option<Event>,
    retained_team: Option<Event>,
}

/// Proof carried to the final scoped signature; never a fabricated Task or team.
pub(super) struct ReadyTeam {
    scout: String,
    snapshot: Snapshot,
    verified: Event,
    initial_missing: bool,
    submitted: Option<String>,
}

fn directory(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("agents"))
        .map_err(|error| error.to_string())
}

fn fingerprint(teams: &[TeamRecord]) -> Result<serde_json::Value, String> {
    serde_json::to_value(
        teams
            .iter()
            .map(|team| {
                (
                    &team.id,
                    &team.relay_url,
                    team.is_builtin,
                    team_event_content(team),
                )
            })
            .collect::<Vec<_>>(),
    )
    .map_err(|error| error.to_string())
}

fn with_snapshot<T>(
    app: &AppHandle,
    state: &AppState,
    scope: &AttachScope,
    scout: &str,
    operation: impl FnOnce(Snapshot) -> Result<T, String>,
) -> Result<T, String> {
    let _community = state
        .community_operation_lock
        .try_read()
        .map_err(|_| "The business connection is changing. Try again.".to_string())?;
    let _identity = state
        .identity_mutation
        .lock()
        .map_err(|error| error.to_string())?;
    scope.check(state)?;
    let _store = state
        .managed_agents_store_lock
        .lock()
        .map_err(|error| error.to_string())?;
    scope.persona(app, Some(scout))?;
    let directory = directory(app)?;
    let teams = load_teams_readonly(&directory.join("teams.json"))?;
    // Only public, semantically relevant fields. Synthesized built-in timestamps
    // can vary between read-only loads, and do not indicate an owner edit.
    let fingerprint = fingerprint(&teams)?;
    let candidate = policy::local_team(teams, scope.relay(), "builtin:fizz")?;
    let path = scoped_retention_db_path(&directory, scope.relay(), scope.owner());
    let (deletion, retained_team) = if path.exists() {
        let conn = rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|_| "The saved business team could not be checked. Try again.".to_string())?;
        let read = |kind, id: &str| {
            get_retained_event(&conn, kind, scope.owner(), id)?
                .map(|row| {
                    Event::from_json(&row.raw_event).map_err(|_| {
                        "The saved business team history could not be read.".to_string()
                    })
                })
                .transpose()
        };
        (
            read(5, &tombstone_retention_d_tag(KIND_TEAM, &candidate.id))?,
            read(KIND_TEAM, &candidate.id)?,
        )
    } else {
        (None, None)
    };
    operation(Snapshot {
        fingerprint,
        candidate,
        deletion,
        retained_team,
    })
}

fn unchanged(expected: &Snapshot, actual: &Snapshot) -> Result<(), String> {
    if expected.fingerprint != actual.fingerprint
        || expected.candidate.id != actual.candidate.id
        || expected.deletion.as_ref().map(|event| event.id)
            != actual.deletion.as_ref().map(|event| event.id)
    {
        return Err(policy::CONFLICT.into());
    }
    Ok(())
}

fn recheck(
    app: &AppHandle,
    state: &AppState,
    scope: &AttachScope,
    scout: &str,
    snapshot: &Snapshot,
) -> Result<(), String> {
    with_snapshot(app, state, scope, scout, |actual| {
        unchanged(snapshot, &actual)
    })
}

async fn query(
    state: &AppState,
    scope: &AttachScope,
    keys: &Keys,
    filter: serde_json::Value,
) -> Result<Vec<Event>, String> {
    scope.check(state)?;
    let result = crate::relay::query_relay_at_with_keys(
        state,
        &crate::relay::relay_http_base_url(scope.relay()),
        &[filter],
        keys,
        None,
    )
    .await;
    scope.check(state)?;
    result.map_err(|_| "The business team could not be checked on the server. Your job has not started; try again.".into())
}

async fn heads(
    state: &AppState,
    scope: &AttachScope,
    keys: &Keys,
    owners: &[String],
) -> Result<Vec<Event>, String> {
    let events = query(
        state,
        scope,
        keys,
        serde_json::json!({
            "kinds": [KIND_TEAM], "authors": owners, "limit": policy::MAX_HEADS
        }),
    )
    .await?;
    policy::verified_heads(events, owners)
}

/// Existing owner approval permits publishing its Team projection, never hiring or starting here.
pub(super) async fn ensure(
    app: &AppHandle,
    state: &AppState,
    scope: &AttachScope,
    keys: &Keys,
    relay_pubkey: &str,
    scout: &str,
) -> Result<ReadyTeam, String> {
    if keys.public_key().to_hex() != scope.owner() {
        return Err(policy::CONFLICT.into());
    }
    let snapshot = with_snapshot(app, state, scope, scout, Ok)?;
    // Capture signed bytes before network work. A retry first reads authoritative
    // relay state and does not republish a matching (or owner-edited) existing head.
    let expected = build_team_event(&snapshot.candidate)?
        .sign_with_keys(keys)
        .map_err(|_| "The business team could not be signed. Try again.".to_string())?;
    let membership = query(
        state,
        scope,
        keys,
        serde_json::json!({
            "kinds": [KIND_NIP43_MEMBERSHIP_LIST], "authors": [relay_pubkey], "limit": 1
        }),
    )
    .await?;
    recheck(app, state, scope, scout, &snapshot)?;
    let owners = policy::owners(
        membership
            .first()
            .ok_or_else(|| "This business's owners could not be verified.".to_string())?,
        relay_pubkey,
        scope.owner(),
    )?;
    let remote = heads(state, scope, keys, &owners).await?;
    recheck(app, state, scope, scout, &snapshot)?;
    if let Some(verified) = policy::ready_head(&remote, "builtin:fizz")? {
        if verified.pubkey == keys.public_key()
            && verified.tags.identifier() == Some(snapshot.candidate.id.as_str())
        {
            policy::refuse_deletion(
                &snapshot.deletion.iter().cloned().collect::<Vec<_>>(),
                scope.owner(),
                &format!("{KIND_TEAM}:{}:{}", scope.owner(), snapshot.candidate.id),
                Some(&verified),
            )?;
        }
        return Ok(ReadyTeam {
            scout: scout.to_owned(),
            snapshot,
            verified,
            initial_missing: false,
            submitted: None,
        });
    }
    policy::may_publish_missing(&remote, &snapshot.candidate)?;
    let coordinate = format!("{KIND_TEAM}:{}:{}", scope.owner(), snapshot.candidate.id);
    let deletions = query(
        state,
        scope,
        keys,
        serde_json::json!({
            "kinds": [5], "authors": [scope.owner()], "#a": [coordinate], "limit": 1
        }),
    )
    .await?;
    let recreated = snapshot
        .retained_team
        .as_ref()
        .filter(|head| policy::same_projection(head, &expected));
    policy::refuse_deletion(&deletions, scope.owner(), &coordinate, recreated)?;
    policy::refuse_deletion(
        &snapshot.deletion.iter().cloned().collect::<Vec<_>>(),
        scope.owner(),
        &coordinate,
        recreated,
    )?;
    recheck(app, state, scope, scout, &snapshot)?;
    // A background publish may have won after our first read. Only signed
    // readback may resolve a duplicate, superseded response or lost acknowledgment.
    let submitted = crate::relay::submit_signed_event_at_with_keys_allow_rejected(
        &expected,
        state,
        &crate::relay::relay_http_base_url(scope.relay()),
        keys,
    )
    .await;
    recheck(app, state, scope, scout, &snapshot)?;
    let remote = heads(state, scope, keys, &owners).await?;
    recheck(app, state, scope, scout, &snapshot)?;
    let verified = policy::ready_head(&remote, "builtin:fizz")?
        .filter(|head| policy::same_projection(head, &expected))
        .ok_or_else(|| "The business team has not been confirmed on the server. Your job has not started; try again.".to_string())?;
    if let Ok(response) = submitted {
        if response.event_id != expected.id.to_hex() {
            return Err("The business team acknowledgment did not match. Try again.".into());
        }
    }
    Ok(ReadyTeam {
        scout: scout.to_owned(),
        snapshot,
        verified,
        initial_missing: true,
        submitted: Some(expected.id.to_hex()),
    })
}

impl ReadyTeam {
    /// Recheck identity and local authority under the short context/store locks while signing.
    pub(super) fn sign(
        &self,
        app: &AppHandle,
        state: &AppState,
        scope: &AttachScope,
        send_id: &str,
        action: &CompanyAction,
        keys: &Keys,
    ) -> Result<String, String> {
        with_snapshot(app, state, scope, &self.scout, |actual| {
            unchanged(&self.snapshot, &actual)?;
            #[cfg(feature = "onboarding-fixture")]
            self.record_fixture_proof(app, scope, send_id)?;
            #[cfg(not(feature = "onboarding-fixture"))]
            let _ = (
                send_id,
                &self.verified,
                self.initial_missing,
                &self.submitted,
            );
            sign_action(action, keys)
        })
    }

    #[cfg(feature = "onboarding-fixture")]
    fn record_fixture_proof(
        &self,
        app: &AppHandle,
        scope: &AttachScope,
        send_id: &str,
    ) -> Result<(), String> {
        use std::io::{Read, Write};
        let path = directory(app)?.join("first-job-team-readiness.jsonl");
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(path)
            .map_err(|error| error.to_string())?;
        if file.metadata().map_err(|error| error.to_string())?.len() >= 262_144 {
            return Err("The fixture Team readiness log exceeded its bound.".into());
        }
        let row = serde_json::json!({ "ownerPubkey": scope.owner(), "relayUrl": scope.relay(),
            "sendId": send_id, "initialMissing": self.initial_missing,
            "submittedEventId": self.submitted, "verifiedEventId": self.verified.id.to_hex() });
        let mut previous = String::new();
        file.read_to_string(&mut previous)
            .map_err(|error| error.to_string())?;
        if previous.lines().count() >= 64 || row.to_string().len() >= 4096 {
            return Err("The fixture Team readiness log exceeded its bound.".into());
        }
        writeln!(file, "{row}").map_err(|error| error.to_string())
    }
}

#[cfg(test)]
#[path = "initiative_team_readiness_tests.rs"]
mod tests;
