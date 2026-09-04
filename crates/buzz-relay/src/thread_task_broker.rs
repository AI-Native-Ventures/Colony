//! One open task per thread, decided here rather than on any client.
//!
//! Before this, every agent-directed send minted its own Task from the
//! composer, so one piece of work discussed over five messages produced five
//! Tasks and the Tasks page read as a transcript. A thread is one conversation
//! about one piece of work, so it holds at most one open task: the first
//! work-implying message opens it, every later turn in that thread attaches to
//! it whichever agent is mentioned and even when none is, and it closes only
//! when every assignee has reported its part complete or the owner closes it.
//! Quiet closes nothing. A thread nobody has written in for a week is a thread
//! waiting, not a task finished.
//!
//! The client asks; the relay answers. That is the whole point: two clients
//! (a desktop and a phone) preparing the same send would each read "no open
//! task" and each create one, so the arbitration has to be a single row in one
//! database rather than an agreement between clients.

use std::sync::Arc;

use buzz_core::{
    company::{
        all_assignees_reported, validate_task, CommercialPurpose, CompanyTask, CompanyTeamRef,
        DoerKind, TaskStatus, ThreadAttach, ThreadAttachMode, MAX_THREAD_SUBTASKS,
    },
    kind::{
        KIND_COMPANY_ACTION, KIND_COMPANY_RECEIPT, KIND_MANAGED_AGENT, KIND_TASK, KIND_TASK_REPORT,
    },
};
use buzz_db::thread_tasks::{ThreadClaim, ThreadSlot as DbThreadSlot, ThreadSlotKey};
use buzz_sdk::{
    company::{CompanyAction, CompanyActionPayload, CompanyReceiptOutcome},
    implicit_task::{internal_cost_centre, owning_team_for_chat},
    thread_task::{thread_key, thread_task_id, ThreadSlot},
};
use nostr::Event;

use buzz_core::tenant::TenantContext;

use crate::{
    company_broker::{
        build_head, build_receipt, emit_task_transition, load_company, load_head, load_team_refs,
        refuse, CompanyBrokerOutcome,
    },
    handlers::event::dispatch_persistent_event,
    state::AppState,
};

const TASK_SCHEMA: &str = "colony.task/v1";
/// Title carried by the hidden per-thread task that absorbs turns which were
/// not work. It exists so a greeting still charges somewhere; it is never
/// shown, so the wording only has to be honest in a database.
const CHAT_TASK_TITLE: &str = "Thread chat";
/// Upper bound on owner rows read while collecting a community's teams.
const MAX_OWNER_LOOKUP: i64 = 8;

/// Resolve which task one send is charged to, opening one when the thread has
/// none, and answer with a receipt naming that task's head.
pub(crate) async fn handle_thread_attach(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    action_event: &Event,
    action: &CompanyAction,
    request: &ThreadAttach,
) -> Result<CompanyBrokerOutcome, String> {
    let actor_hex = action_event.pubkey.to_hex();
    if state
        .db
        .get_relay_member(tenant.community(), &actor_hex)
        .await
        .map_err(|error| format!("database error checking thread attach authority: {error}"))?
        .is_none()
    {
        return refuse(
            state,
            tenant,
            action_event,
            action,
            "a thread attach requires membership of this community".to_owned(),
        )
        .await;
    }

    let actor_is_agent = state
        .db
        .get_agent_channel_policy(tenant.community(), action_event.pubkey.as_bytes())
        .await
        .map_err(|error| format!("database error checking thread attach actor: {error}"))?
        .is_some_and(|policy| policy.1.is_some());

    // An agent may only open work underneath a task it is already assigned
    // to. Without that, any agent in the community could open tasks against
    // any thread and charge turns to a team that never took the work.
    if actor_is_agent {
        if let Err(message) = authorize_agent_subtask(tenant, state, action_event, request).await {
            return refuse(state, tenant, action_event, action, message).await;
        }
    }

    let key = thread_key(
        request.thread_root.as_deref(),
        &request.send_id,
        request.conversation_scope,
    );

    let decision = match decide_task(tenant, state, request, &actor_hex, &key).await {
        Ok(decision) => decision,
        Err(message) => return refuse(state, tenant, action_event, action, message).await,
    };

    let existing_head = load_head(tenant, state, KIND_TASK, &decision.task_id).await?;
    let mut opened_task: Option<CompanyTask> = None;

    let (head_event, claim_head_id) = match existing_head.as_ref() {
        // The thread already has this task and it is stored, so the request
        // is answered by pointing at it. Rewriting the head to say the same
        // thing would churn a record nobody asked to change.
        Some(head) => (None, head.id.as_bytes().to_vec()),
        None => {
            let task = match build_thread_task(tenant, state, request, &decision, action_event)
                .await
            {
                Ok(task) => task,
                Err(message) => return refuse(state, tenant, action_event, action, message).await,
            };
            let head = build_head(
                &state.relay_keypair,
                &CompanyActionPayload::Task(Box::new(task.clone())),
                None,
            )?;
            let id = head.id.as_bytes().to_vec();
            opened_task = Some(task);
            (Some(head), id)
        }
    };

    let receipt = build_receipt(
        &state.relay_keypair,
        action_event,
        action,
        CompanyReceiptOutcome::Applied,
        Some(&hex::encode(&claim_head_id)),
    )?;

    let outcome = state
        .db
        .apply_thread_attach_once(
            tenant.community(),
            action_event,
            head_event.as_ref(),
            head_event.as_ref().map(|_| decision.task_id.as_str()),
            &receipt,
            &claim_head_id,
            action.idempotency_key,
            &actor_hex,
        )
        .await
        .map_err(|error| format!("failed to apply thread attach atomically: {error}"))?;

    match outcome {
        buzz_db::event::ThreadAttachApply::Applied {
            action: stored_action,
            head: stored_head,
            receipt: stored_receipt,
        } => {
            let relay_pubkey = state.relay_keypair.public_key().to_hex();
            dispatch_persistent_event(
                tenant,
                state,
                &stored_action,
                KIND_COMPANY_ACTION,
                &actor_hex,
                None,
            )
            .await;
            if let Some(stored_head) = stored_head.as_ref() {
                dispatch_persistent_event(
                    tenant,
                    state,
                    stored_head,
                    KIND_TASK,
                    &relay_pubkey,
                    None,
                )
                .await;
            }
            dispatch_persistent_event(
                tenant,
                state,
                &stored_receipt,
                KIND_COMPANY_RECEIPT,
                &relay_pubkey,
                None,
            )
            .await;

            if let (Some(_), Some(task)) = (stored_head.as_ref(), opened_task.as_ref()) {
                // The hidden chat task is not news: it exists so a greeting
                // charges somewhere, and a coordination row announcing it
                // would put the greeting back in the thread it was kept out
                // of.
                if !task.hidden {
                    emit_task_transition(tenant, state, "task_created", task).await;
                }
            }
            Ok(CompanyBrokerOutcome::Applied)
        }
        buzz_db::event::ThreadAttachApply::Duplicate {
            original_action_event_id,
        } => Ok(CompanyBrokerOutcome::Duplicate {
            original_action_event_id,
        }),
        buzz_db::event::ThreadAttachApply::NotMember => {
            refuse(
                state,
                tenant,
                action_event,
                action,
                "a thread attach requires membership of this community".to_owned(),
            )
            .await
        }
        buzz_db::event::ThreadAttachApply::ActionAlreadyStored => {
            refuse(
                state,
                tenant,
                action_event,
                action,
                "this request was already processed; sign a new one to retry".to_owned(),
            )
            .await
        }
        // Another writer took the same coordinate in the instant between the
        // read and the commit. Nothing is lost: the client retries and the
        // retry attaches to the task that won.
        buzz_db::event::ThreadAttachApply::StaleHead { .. } => {
            refuse(
                state,
                tenant,
                action_event,
                action,
                "this thread's task changed while the request was prepared".to_owned(),
            )
            .await
        }
    }
}

/// What the relay decided one attach request resolves to.
struct AttachDecision {
    task_id: String,
    slot: ThreadSlot,
}

/// Claim the thread's slot and decide which task the send belongs to.
async fn decide_task(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    request: &ThreadAttach,
    actor_hex: &str,
    key: &str,
) -> Result<AttachDecision, String> {
    // A sub-task is deliberately outside the slot claim. It is the "two
    // things at once in one conversation" case, and holding the thread's slot
    // for it would make the parent unreachable for every later turn.
    if let Some(parent_task_id) = request.parent_task_id.as_deref() {
        let task_id = thread_task_id(
            &request.channel_id,
            key,
            &format!("sub:{}", request.send_id),
            ThreadSlot::Work,
        );
        let within_cap = state
            .db
            .record_thread_subtask(
                tenant.community(),
                parent_task_id,
                &task_id,
                MAX_THREAD_SUBTASKS,
            )
            .await
            .map_err(|error| format!("database error recording the sub-task: {error}"))?;
        if !within_cap {
            return Err(format!(
                "this thread's task already holds {MAX_THREAD_SUBTASKS} sub-tasks"
            ));
        }
        return Ok(AttachDecision {
            task_id,
            slot: ThreadSlot::Work,
        });
    }

    let work_key = ThreadSlotKey {
        channel_id: &request.channel_id,
        thread_key: key,
        owner_pubkey: actor_hex,
        slot: DbThreadSlot::Work,
    };

    let (claim, slot) = match request.mode {
        ThreadAttachMode::Open => {
            let proposed =
                thread_task_id(&request.channel_id, key, &request.send_id, ThreadSlot::Work);
            let claim = state
                .db
                .claim_thread_task(tenant.community(), work_key, &proposed, false)
                .await
                .map_err(|error| format!("database error claiming this thread: {error}"))?;
            (claim, ThreadSlot::Work)
        }
        // The composer's explicit "start a second task". The task it replaces
        // stays open until it closes on its own terms; later sends attach to
        // this one, because a switch that left the old task in charge of the
        // conversation would do nothing a member could observe.
        ThreadAttachMode::New => {
            let proposed = thread_task_id(
                &request.channel_id,
                key,
                &format!("new:{}", request.send_id),
                ThreadSlot::Work,
            );
            let claim = state
                .db
                .claim_thread_task(tenant.community(), work_key, &proposed, true)
                .await
                .map_err(|error| format!("database error opening a second task: {error}"))?;
            (claim, ThreadSlot::Work)
        }
        // Not work. It joins the thread's open task when there is one, so an
        // "are you there?" inside live work is charged to that work, and
        // falls back to the hidden chat task otherwise.
        ThreadAttachMode::Attach => {
            let open = state
                .db
                .read_thread_task(tenant.community(), work_key)
                .await
                .map_err(|error| format!("database error reading this thread: {error}"))?;
            match open {
                Some(task_id) => (ThreadClaim::Attached { task_id }, ThreadSlot::Work),
                None => {
                    let chat_key = ThreadSlotKey {
                        slot: DbThreadSlot::Chat,
                        ..work_key
                    };
                    let proposed =
                        thread_task_id(&request.channel_id, key, "chat", ThreadSlot::Chat);
                    let claim = state
                        .db
                        .claim_thread_task(tenant.community(), chat_key, &proposed, false)
                        .await
                        .map_err(|error| {
                            format!("database error claiming this thread's chat task: {error}")
                        })?;
                    (claim, ThreadSlot::Chat)
                }
            }
        }
    };

    Ok(AttachDecision {
        task_id: claim.task_id().to_owned(),
        slot,
    })
}

/// Build the task this request opens, entirely from records the relay holds.
///
/// Nothing here is taken from the request except the title, the channel, and
/// the thread: a client that could name its own team or cost centre could
/// charge its turns to a team that never took the work.
async fn build_thread_task(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    request: &ThreadAttach,
    decision: &AttachDecision,
    action_event: &Event,
) -> Result<CompanyTask, String> {
    let company = load_company(tenant, state).await?;
    let teams = load_thread_teams(tenant, state, action_event.pubkey).await?;
    let persona = request.agent_persona_id.as_deref().unwrap_or_default();
    let team = owning_team_for_chat(&teams, persona)?;
    let cost_centre_id = internal_cost_centre(&company)?.to_owned();

    let assignees = if !persona.is_empty() && team.persona_ids.iter().any(|id| id == persona) {
        vec![persona.to_owned()]
    } else {
        Vec::new()
    };
    let hidden = decision.slot == ThreadSlot::Chat;
    let now = action_event.created_at.as_secs() as i64;

    let task = CompanyTask {
        schema: TASK_SCHEMA.to_owned(),
        id: decision.task_id.clone(),
        initiative_id: None,
        title: if hidden {
            CHAT_TASK_TITLE.to_owned()
        } else {
            request.title.clone()
        },
        status: TaskStatus::InProgress,
        owning_team_id: team.id.clone(),
        assignee_persona_ids: assignees,
        qa_persona_id: team.lead_persona_id.clone(),
        reviewer_team_id: None,
        cost_centre_id,
        commercial_purpose: match request.client_organization_id.as_deref() {
            Some(id) if !id.trim().is_empty() => CommercialPurpose::ClientDelivery,
            _ => CommercialPurpose::Administration,
        },
        client_organization_id: request
            .client_organization_id
            .as_deref()
            .filter(|id| !id.trim().is_empty())
            .map(str::to_owned),
        source_channel_id: request.channel_id.clone(),
        source_event_id: None,
        implicit: true,
        depends_on: Vec::new(),
        subject: None,
        stage: None,
        thread_root: request.thread_root.clone(),
        doer_kind: DoerKind::Agent,
        wake_at: None,
        outcome_reason: None,
        bounce_reason: None,
        bounce_count: 0,
        reported_complete_by: Vec::new(),
        hidden,
        parent_task_id: request.parent_task_id.clone(),
        created_at: now,
        updated_at: now,
    };
    validate_task(&task, &company, None, &teams)
        .map_err(|error| format!("this thread's task cannot be opened: {error}"))?;
    Ok(task)
}

/// Every team this community's owners have published, and the asking member's
/// own, in that member's favour when both name a team.
///
/// Team events are client-authored, so "whose teams are canonical" has to be
/// decided rather than assumed. Reading one arbitrary owner's teams is what
/// this did first, and it was wrong the moment a community had two owner rows:
/// a relay that bootstraps its configured owner at startup, plus whoever the
/// workspace actually belongs to, is the ordinary case, and picking the first
/// row returned meant every attach in that community refused with "this
/// company has no coordination team to own ambiguous work" while the teams sat
/// in the database under the other key.
///
/// The asking member is read first so a member who publishes their own teams
/// is not overruled by an owner's stale head at the same id, and the first
/// live head for an id wins after that.
async fn load_thread_teams(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    actor: nostr::PublicKey,
) -> Result<Vec<CompanyTeamRef>, String> {
    let owners = state
        .db
        .list_relay_owners(tenant.community(), MAX_OWNER_LOOKUP)
        .await
        .map_err(|error| format!("database error reading this community's owners: {error}"))?;

    let mut authors = vec![actor];
    for owner in owners {
        match nostr::PublicKey::parse(&owner) {
            Ok(owner) if owner != actor => authors.push(owner),
            Ok(_) => {}
            // One unreadable owner row must not blank the whole team list: the
            // other owners still hold usable teams.
            Err(error) => {
                tracing::warn!(%error, "skipping an unreadable community owner key");
            }
        }
    }

    let mut teams: Vec<CompanyTeamRef> = Vec::new();
    for author in authors {
        for team in load_team_refs(tenant, state, &author).await? {
            if !teams.iter().any(|held| held.id == team.id) {
                teams.push(team);
            }
        }
    }
    Ok(teams)
}

/// Check that an agent opening a sub-task is assigned to its parent.
async fn authorize_agent_subtask(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    action_event: &Event,
    request: &ThreadAttach,
) -> Result<(), String> {
    let Some(parent_task_id) = request.parent_task_id.as_deref() else {
        return Err("an agent may only open a sub-task of a task it is assigned to".to_owned());
    };
    let persona = resolve_agent_persona(tenant, state, &action_event.pubkey)
        .await?
        .ok_or_else(|| "this agent has no persona, so it can hold no assignment".to_owned())?;
    let parent = load_head(tenant, state, KIND_TASK, parent_task_id)
        .await?
        .ok_or_else(|| "the parent task does not exist".to_owned())?;
    let parent = buzz_sdk::company::parse_task_event(&parent)
        .map_err(|error| format!("the parent task is unreadable: {error}"))?;
    if !parent.assignee_persona_ids.contains(&persona) {
        return Err("only an assignee of the parent may open a sub-task under it".to_owned());
    }
    Ok(())
}

/// The persona one managed agent's public key belongs to.
///
/// Read from the agent's own kind:30177 head rather than taken from whatever
/// the request claimed: a persona a caller could name is a persona a caller
/// could borrow, and every assignment check downstream keys off this value.
pub(crate) async fn resolve_agent_persona(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    pubkey: &nostr::PublicKey,
) -> Result<Option<String>, String> {
    #[derive(serde::Deserialize)]
    struct ManagedAgentContent {
        #[serde(default)]
        persona_id: Option<String>,
    }

    let rows = state
        .db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![KIND_MANAGED_AGENT as i32]),
            d_tag: Some(pubkey.to_hex()),
            global_only: true,
            limit: Some(4),
            ..buzz_db::event::EventQuery::for_community(tenant.community())
        })
        .await
        .map_err(|error| format!("database error reading this agent's persona: {error}"))?;

    for stored in rows {
        if let Ok(content) = serde_json::from_str::<ManagedAgentContent>(&stored.event.content) {
            if let Some(persona_id) = content.persona_id.filter(|id| !id.trim().is_empty()) {
                return Ok(Some(persona_id));
            }
        }
    }
    Ok(None)
}

/// Free a closed task's thread slot and close whatever hung off it.
///
/// Called after a task head reaching a terminal state has committed, so the
/// next work-implying message in that thread opens a new task rather than
/// reopening a finished one, and no sub-task outlives the work it was split
/// out of.
pub(crate) async fn release_and_cascade(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    task: &CompanyTask,
) {
    if let Err(error) = state
        .db
        .release_thread_task(tenant.community(), &task.id)
        .await
    {
        tracing::warn!(%error, task_id = %task.id, "could not release this thread's task slot");
    }

    let children = match state
        .db
        .thread_subtask_ids(tenant.community(), &task.id)
        .await
    {
        Ok(children) => children,
        Err(error) => {
            tracing::warn!(%error, task_id = %task.id, "could not read this task's sub-tasks");
            return;
        }
    };
    for child_id in children {
        if let Err(error) = close_child_task(tenant, state, &child_id, task.status).await {
            tracing::warn!(%error, task_id = %child_id, "could not close a sub-task with its parent");
        }
    }
}

/// Close one sub-task because its parent closed.
async fn close_child_task(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    child_id: &str,
    parent_status: TaskStatus,
) -> Result<(), String> {
    let Some(previous_event) = load_head(tenant, state, KIND_TASK, child_id).await? else {
        return Ok(());
    };
    let previous = buzz_sdk::company::parse_task_event(&previous_event)
        .map_err(|error| format!("sub-task head is unreadable: {error}"))?;
    if matches!(
        previous.status,
        TaskStatus::Completed | TaskStatus::Cancelled
    ) {
        return Ok(());
    }
    // A sub-task closes the same way its parent did. A parent that was
    // cancelled did not deliver, and recording its children as completed
    // would claim delivery that never happened.
    let mut replacement = previous.clone();
    replacement.status = parent_status;
    replacement.updated_at = replacement.updated_at.max(previous.updated_at) + 1;
    if parent_status == TaskStatus::Completed && replacement.doer_kind == DoerKind::Human {
        replacement.outcome_reason = Some("closed with its parent task".to_owned());
    }
    write_task_head(tenant, state, &previous_event, &replacement).await?;
    let transition = if parent_status == TaskStatus::Completed {
        "task_completed"
    } else {
        "task_cancelled"
    };
    if !replacement.hidden {
        emit_task_transition(tenant, state, transition, &replacement).await;
    }
    state
        .db
        .release_thread_task(tenant.community(), &replacement.id)
        .await
        .map_err(|error| format!("could not release a sub-task's slot: {error}"))?;
    Ok(())
}

/// Store and fan out one relay-authored replacement task head.
pub(crate) async fn write_task_head(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    previous_event: &Event,
    replacement: &CompanyTask,
) -> Result<bool, String> {
    let head = build_head(
        &state.relay_keypair,
        &CompanyActionPayload::Task(Box::new(replacement.clone())),
        Some(previous_event),
    )?;
    let (stored_head, inserted) = state
        .db
        .insert_event(tenant.community(), &head, None)
        .await
        .map_err(|error| format!("failed to store the task head: {error}"))?;
    if inserted {
        dispatch_persistent_event(
            tenant,
            state,
            &stored_head,
            KIND_TASK,
            &state.relay_keypair.public_key().to_hex(),
            None,
        )
        .await;
    }
    Ok(inserted)
}

/// Move a claim made before its thread had a root onto the real root.
///
/// Only a message that starts a thread can do this: a reply already named a
/// root when it was charged, so its claim was never pending. The task id comes
/// off the message's own `task` tag, which the relay handed the client back
/// moments earlier, so nothing here trusts a client to name a task it was not
/// given.
pub(crate) async fn rebind_pending_thread_claim(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
) -> Result<(), String> {
    if crate::interrupt_gate::extract_thread_root(event).is_some() {
        return Ok(());
    }
    let Some(task_id) = event.tags.iter().find_map(|tag| {
        let parts = tag.as_slice();
        (parts.len() == 2 && parts[0] == "task").then(|| parts[1].clone())
    }) else {
        return Ok(());
    };
    let root_hex = event.id.to_hex();
    state
        .db
        .rebind_thread_task(tenant.community(), &task_id, &format!("root:{root_hex}"))
        .await
        .map_err(|error| format!("database error rebinding this thread's claim: {error}"))?;

    // The claim row is not the only thing that was keyed on a thread root that
    // did not exist yet: the task head itself was written with `threadRoot`
    // null, because the message it belongs to had not been published when the
    // task was opened. A reader asking "which task belongs to this thread"
    // filters on that field, so a task opened by a thread's FIRST message was
    // invisible to the thread header, Mark done, and the new-task switch,
    // while a task opened from a reply was not. Now that the root exists, the
    // head learns it. The hidden chat task takes the same path: its own
    // message names it, so it is rebound by this same call.
    record_thread_root(tenant, state, &task_id, &root_hex).await
}

/// Give a task the thread root it could not have been created with.
///
/// Deliberately not a transition: nothing about the work changed, so a
/// coordination row announcing it would be noise in the very thread it is
/// describing.
async fn record_thread_root(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    task_id: &str,
    root_hex: &str,
) -> Result<(), String> {
    let Some(previous_event) = load_head(tenant, state, KIND_TASK, task_id).await? else {
        return Ok(());
    };
    let previous = buzz_sdk::company::parse_task_event(&previous_event)
        .map_err(|error| format!("that task is unreadable: {error}"))?;
    let Some(replacement) = thread_root_backfill(&previous, root_hex) else {
        return Ok(());
    };
    write_task_head(tenant, state, &previous_event, &replacement).await?;
    Ok(())
}

/// The replacement head a thread root backfill needs, or `None` when the task
/// needs no rewrite.
///
/// A task that already names a thread root keeps it: the root it was opened
/// against is the truth, and a later message in the same thread must not be
/// able to move a task to a different conversation. A closed task is left
/// alone for the same reason, plus a simpler one: rewriting a finished record
/// to improve a filter is not worth touching the record at all.
fn thread_root_backfill(previous: &CompanyTask, root_hex: &str) -> Option<CompanyTask> {
    if previous.thread_root.is_some()
        || matches!(
            previous.status,
            TaskStatus::Completed | TaskStatus::Cancelled
        )
    {
        return None;
    }
    let mut replacement = previous.clone();
    replacement.thread_root = Some(root_hex.to_owned());
    // `updatedAt` deliberately stays where it was. Nothing about the work
    // changed, and a client that read this task before its root was known
    // computes its next replacement's timestamp from what it read: bumping
    // here would make that client's perfectly ordinary "mark done" fail with
    // "updatedAt must strictly increase" for no reason a person could see.
    // The head event id does change, so a client still re-reads the head
    // before a compare-and-set write, which it has to do anyway.
    Some(replacement)
}

/// Whether this event is one assignee reporting its part of a task done.
pub(crate) fn is_task_report_candidate(event: &Event) -> bool {
    event.kind.as_u16() as u32 == KIND_TASK_REPORT
}

/// Record one assignee's completion report, closing the task once every
/// assignee has filed one.
///
/// Agent-signable on purpose. A thread task is shared by every agent that
/// answers in its thread, and a Company Action can only be signed by the human
/// owner, so without this an agent had no legal way to say its own share of
/// shared work had finished, and the only thing that could ever close such a
/// task was the owner doing it by hand.
pub(crate) async fn handle_task_report(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
) -> Result<(), String> {
    let task_id = event
        .tags
        .iter()
        .find_map(|tag| {
            let parts = tag.as_slice();
            (parts.len() == 2 && parts[0] == "task").then(|| parts[1].clone())
        })
        .ok_or_else(|| "a completion report must name the task it is about".to_owned())?;

    let persona = resolve_agent_persona(tenant, state, &event.pubkey)
        .await?
        .ok_or_else(|| {
            "only an assigned agent may report completion; an owner closes a task directly"
                .to_owned()
        })?;

    let previous_event = load_head(tenant, state, KIND_TASK, &task_id)
        .await?
        .ok_or_else(|| "that task does not exist".to_owned())?;
    let previous = buzz_sdk::company::parse_task_event(&previous_event)
        .map_err(|error| format!("that task is unreadable: {error}"))?;

    if !previous.assignee_persona_ids.contains(&persona) {
        return Err("only an assignee of this task may report it complete".to_owned());
    }
    // A repeat report is the same claim, so it is answered rather than
    // refused: an agent retrying after a lost connection must not be told its
    // work does not count.
    if previous.reported_complete_by.contains(&persona)
        || matches!(
            previous.status,
            TaskStatus::Completed | TaskStatus::Cancelled
        )
    {
        return Ok(());
    }

    // The report is evidence of a moment, so it is stored whether or not it
    // is the one that closes the task.
    let (stored_report, inserted) = state
        .db
        .insert_event(tenant.community(), event, None)
        .await
        .map_err(|error| format!("failed to store the completion report: {error}"))?;
    if inserted {
        dispatch_persistent_event(
            tenant,
            state,
            &stored_report,
            KIND_TASK_REPORT,
            &event.pubkey.to_hex(),
            None,
        )
        .await;
    }

    let mut replacement = previous.clone();
    replacement.reported_complete_by.push(persona);
    replacement.updated_at = previous.updated_at + 1;
    let closing = report_closes_task(&replacement);
    if closing {
        replacement.status = TaskStatus::Completed;
        if replacement.doer_kind == DoerKind::Human && replacement.outcome_reason.is_none() {
            replacement.outcome_reason = Some("every assignee reported complete".to_owned());
        }
    }

    if !write_task_head(tenant, state, &previous_event, &replacement).await? {
        return Ok(());
    }
    if closing {
        if !replacement.hidden {
            emit_task_transition(tenant, state, "task_completed", &replacement).await;
        }
        release_and_cascade(tenant, state, &replacement).await;
    }
    Ok(())
}

/// Whether a completion report closes the task it names.
///
/// Separated from the storage path so the rule itself is testable without a
/// database: a task closes when every assignee has reported, and never
/// because time passed.
pub(crate) fn report_closes_task(task: &CompanyTask) -> bool {
    all_assignees_reported(task)
        && !matches!(task.status, TaskStatus::Completed | TaskStatus::Cancelled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::company::CompanyTask;

    fn sample_task() -> CompanyTask {
        CompanyTask {
            schema: TASK_SCHEMA.to_owned(),
            id: "thread-task:one".to_owned(),
            initiative_id: None,
            title: "ship the release".to_owned(),
            status: TaskStatus::InProgress,
            owning_team_id: "engineering".to_owned(),
            assignee_persona_ids: vec!["persona-a".to_owned(), "persona-b".to_owned()],
            qa_persona_id: "persona-a".to_owned(),
            reviewer_team_id: None,
            cost_centre_id: "internal-coordination".to_owned(),
            commercial_purpose: CommercialPurpose::Administration,
            client_organization_id: None,
            source_channel_id: "engineering".to_owned(),
            source_event_id: None,
            implicit: true,
            depends_on: Vec::new(),
            subject: None,
            stage: None,
            thread_root: Some("abc".to_owned()),
            doer_kind: DoerKind::Agent,
            wake_at: None,
            outcome_reason: None,
            bounce_reason: None,
            bounce_count: 0,
            reported_complete_by: Vec::new(),
            hidden: false,
            parent_task_id: None,
            created_at: 1_767_225_600,
            updated_at: 1_767_225_600,
        }
    }

    #[test]
    fn a_task_opened_by_a_threads_first_message_learns_its_root() {
        let mut task = sample_task();
        task.thread_root = None;
        let root = "b".repeat(64);
        let replacement = thread_root_backfill(&task, &root).expect("the head is rewritten");
        assert_eq!(replacement.thread_root.as_deref(), Some(root.as_str()));
        assert_eq!(
            replacement.updated_at, task.updated_at,
            "learning a root is not work happening, and a bump here would refuse the owner's next write"
        );
        assert_eq!(
            replacement.id, task.id,
            "it is the same task, told where it lives"
        );
    }

    #[test]
    fn a_task_that_already_names_a_thread_is_never_moved_to_another_one() {
        let task = sample_task();
        assert_eq!(task.thread_root.as_deref(), Some("abc"));
        assert!(thread_root_backfill(&task, &"b".repeat(64)).is_none());
    }

    #[test]
    fn a_closed_task_is_not_rewritten_to_improve_a_filter() {
        let mut task = sample_task();
        task.thread_root = None;
        task.status = TaskStatus::Completed;
        assert!(thread_root_backfill(&task, &"b".repeat(64)).is_none());
        task.status = TaskStatus::Cancelled;
        assert!(thread_root_backfill(&task, &"b".repeat(64)).is_none());
    }

    #[test]
    fn one_assignee_reporting_does_not_close_a_shared_task() {
        let mut task = sample_task();
        task.reported_complete_by = vec!["persona-a".to_owned()];
        assert!(!report_closes_task(&task));
    }

    #[test]
    fn a_task_closes_once_every_assignee_has_reported() {
        let mut task = sample_task();
        task.reported_complete_by = vec!["persona-a".to_owned(), "persona-b".to_owned()];
        assert!(report_closes_task(&task));
    }

    #[test]
    fn an_unassigned_task_never_closes_itself() {
        let mut task = sample_task();
        task.assignee_persona_ids.clear();
        task.reported_complete_by.clear();
        assert!(!report_closes_task(&task));
    }

    #[test]
    fn an_already_closed_task_is_not_closed_twice() {
        let mut task = sample_task();
        task.reported_complete_by = vec!["persona-a".to_owned(), "persona-b".to_owned()];
        task.status = TaskStatus::Completed;
        assert!(!report_closes_task(&task));
    }
}
