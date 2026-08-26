//! Publishing a doer's queue decision: complete, snooze, or bounce.
//!
//! Mirrors `commands::initiative`: the frontend holds the relay-authored
//! task head it read and the connection to publish on; this holds the
//! owner's signing key and the rule for what may be signed. It takes the
//! relay-signed head, not the record, and re-derives from it - a caller that
//! hand-edited a task would otherwise get the owner's signature on it.
//! `buzz_sdk_pkg::task_transition` decides whether the requested move is
//! legal at all; this only reads the head, signs what that module builds,
//! and returns it for the frontend to publish and wait on a receipt for.

use buzz_sdk_pkg::{company::parse_task_event, company_blueprint::sign_action, task_transition};
use tauri::State;

use crate::{
    app_state::AppState, commands::initiative::relay_head, company::transaction::is_event_id,
};

/// Complete a human-doer task the queue shows, writing why.
#[tauri::command]
pub async fn complete_queue_task(
    task_head: String,
    outcome_reason: String,
    relay_pubkey: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let keys = state
        .signing_keys()
        .map_err(|_| "completing a task requires the community owner".to_string())?;
    if !is_event_id(&relay_pubkey) {
        return Err("relay pubkey is not a valid public key".to_string());
    }
    let event = relay_head(&task_head, &relay_pubkey, "task")?;
    let task = parse_task_event(&event)
        .map_err(|error| format!("the task head is unreadable: {error}"))?;
    let action = task_transition::plan_task_completion(
        &task,
        &event.id.to_hex(),
        &outcome_reason,
        &relay_pubkey,
    )?;
    sign_action(&action, &keys)
}

/// Snooze a task the queue shows until `wake_at`.
#[tauri::command]
pub async fn snooze_queue_task(
    task_head: String,
    wake_at: i64,
    relay_pubkey: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let keys = state
        .signing_keys()
        .map_err(|_| "snoozing a task requires the community owner".to_string())?;
    if !is_event_id(&relay_pubkey) {
        return Err("relay pubkey is not a valid public key".to_string());
    }
    let event = relay_head(&task_head, &relay_pubkey, "task")?;
    let task = parse_task_event(&event)
        .map_err(|error| format!("the task head is unreadable: {error}"))?;
    let action =
        task_transition::plan_task_snooze(&task, &event.id.to_hex(), wake_at, &relay_pubkey)?;
    sign_action(&action, &keys)
}

/// Bounce an upstream task back to ready, given its own current head.
#[tauri::command]
pub async fn bounce_queue_task(
    upstream_task_head: String,
    reason: String,
    relay_pubkey: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let keys = state
        .signing_keys()
        .map_err(|_| "bouncing a task requires the community owner".to_string())?;
    if !is_event_id(&relay_pubkey) {
        return Err("relay pubkey is not a valid public key".to_string());
    }
    let event = relay_head(&upstream_task_head, &relay_pubkey, "task")?;
    let upstream = parse_task_event(&event)
        .map_err(|error| format!("the task head is unreadable: {error}"))?;
    let action =
        task_transition::plan_task_bounce(&upstream, &event.id.to_hex(), &reason, &relay_pubkey)?;
    sign_action(&action, &keys)
}
