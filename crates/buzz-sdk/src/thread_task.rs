//! One open task per thread, decided by the relay.
//!
//! Every agent-directed send used to mint its own Task, so one piece of work
//! discussed over five messages produced five Tasks and the Tasks page read
//! as a transcript. A thread is one conversation about one piece of work, so
//! it holds at most one open task: the first work-implying message opens it,
//! and every later turn in that thread attaches to it, whichever agent is
//! mentioned and even when none is.
//!
//! The client never proposes a task id. It computes the thread's slot
//! coordinate, which is derivable without any relay state, and asks the relay
//! to attach or open; the relay answers with the task the turn is charged to.
//! That is what makes two devices racing on the same thread produce one task
//! rather than two: the arbitration is a single row in one database, not an
//! agreement between clients.

use buzz_core::{
    company::{ThreadAttach, ThreadAttachMode, THREAD_ATTACH_SCHEMA, THREAD_SLOT_PREFIX},
    company_roster::step_idempotency_key,
    kind::KIND_TASK,
};

use crate::company::{CompanyAction, CompanyActionOperation, CompanyActionPayload};

/// Which of a thread's two slots a request is addressed to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadSlot {
    /// The thread's visible work task.
    Work,
    /// The thread's hidden task, which carries the cost of turns that were
    /// not work so that no turn goes unattributed.
    Chat,
}

impl ThreadSlot {
    /// The exact stable string this slot is keyed by.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Work => "work",
            Self::Chat => "chat",
        }
    }
}

/// The key a thread is claimed under.
///
/// A send that starts its own thread has no root event id yet, because the
/// event does not exist until after the task is confirmed. Such a send is
/// claimed under its own send id, and the relay rebinds that claim to the
/// real root the moment the message it belongs to arrives. A conversation
/// scope (a DM) is one thread for its whole life, so it is keyed by neither.
pub fn thread_key(thread_root: Option<&str>, send_id: &str, conversation_scope: bool) -> String {
    if conversation_scope {
        return "conversation".to_owned();
    }
    match thread_root.map(str::trim).filter(|root| !root.is_empty()) {
        Some(root) => format!("root:{root}"),
        None => format!("send:{send_id}"),
    }
}

/// The stable coordinate one thread's slot is addressed at.
///
/// Computable by a client that holds no company state: it names the channel,
/// the thread, the member asking, and which slot, and nothing else. Two
/// clients preparing the same send therefore address the same slot, which is
/// what lets the relay recognise the race at all.
pub fn thread_slot_id(
    channel_id: &str,
    thread_key: &str,
    owner_pubkey: &str,
    slot: ThreadSlot,
) -> String {
    let derived = step_idempotency_key(
        "thread-slot",
        &format!(
            "{channel_id}:{thread_key}:{}:{}",
            owner_pubkey.to_ascii_lowercase(),
            slot.as_str()
        ),
    );
    format!("{THREAD_SLOT_PREFIX}{derived}")
}

/// The stable identity of the task one send would open.
///
/// Derived from the send rather than from the thread, so the task opened
/// after an earlier one closed is a different task rather than a resurrection
/// of the closed one, and so a retry of the same send asks for the same task.
/// Which of two racing candidates actually becomes the thread's task is the
/// relay's decision, not this function's.
pub fn thread_task_id(
    channel_id: &str,
    thread_key: &str,
    send_id: &str,
    slot: ThreadSlot,
) -> String {
    let derived = step_idempotency_key(
        "thread-task",
        &format!("{channel_id}:{thread_key}:{send_id}:{}", slot.as_str()),
    );
    format!("thread-task:{derived}")
}

/// What a client supplies to charge one send to its thread's task.
#[derive(Debug, Clone, Copy)]
pub struct ThreadAttachRequest<'a> {
    /// Channel the send happens in.
    pub channel_id: &'a str,
    /// Root event id of the thread the send replies in, absent when the send
    /// starts its own thread.
    pub thread_root: Option<&'a str>,
    /// Whether the whole conversation is the thread, which is what a DM is.
    pub conversation_scope: bool,
    /// This client's stable identity for this send. A retry reuses it.
    pub send_id: &'a str,
    /// What the client is asking for.
    pub mode: ThreadAttachMode,
    /// The instruction being sent, used as the title when a task is opened.
    pub title: &'a str,
    /// Persona of the agent the send names, when it names one.
    pub agent_persona_id: Option<&'a str>,
    /// Explicit client-delivery context, when the composer had any.
    pub client_organization_id: Option<&'a str>,
    /// Parent task, when this request opens a sub-task under one.
    pub parent_task_id: Option<&'a str>,
    /// Public key of the member asking. Their own slot, so a second member
    /// working in the same thread opens their own task rather than spending
    /// against the thread starter's.
    pub owner_pubkey: &'a str,
    /// Tenant relay public key that must author the resulting head.
    pub relay_pubkey: &'a str,
    /// Timestamp to stamp the request with.
    pub now: i64,
}

/// Build the Company Action that asks the relay to charge this send.
///
/// The action's target names the thread's slot, not a task: the client cannot
/// know which task it will be given, and a target it invented would be a
/// claim about company state rather than a question about it.
pub fn plan_thread_attach(request: ThreadAttachRequest) -> Result<CompanyAction, String> {
    if request.channel_id.trim().is_empty() || request.send_id.trim().is_empty() {
        return Err("a thread attach needs the channel and send it came from".to_owned());
    }
    if request.owner_pubkey.trim().is_empty() {
        return Err("a thread attach needs the member asking for it".to_owned());
    }
    let key = thread_key(
        request.thread_root,
        request.send_id,
        request.conversation_scope,
    );
    // Addressed to the work slot even when the mode may land on the chat
    // slot: which slot answers is the relay's decision, and a client that
    // addressed the chat slot directly could route real work into the hidden
    // task nobody ever sees.
    let slot_id = thread_slot_id(
        request.channel_id,
        &key,
        request.owner_pubkey,
        ThreadSlot::Work,
    );

    let payload = ThreadAttach {
        schema: THREAD_ATTACH_SCHEMA.to_owned(),
        id: slot_id.clone(),
        channel_id: request.channel_id.to_owned(),
        thread_root: request
            .thread_root
            .map(str::trim)
            .filter(|root| !root.is_empty())
            .map(str::to_owned),
        conversation_scope: request.conversation_scope,
        mode: request.mode,
        title: crate::implicit_task::clamp_title(request.title),
        send_id: request.send_id.to_owned(),
        agent_persona_id: request.agent_persona_id.map(str::to_owned),
        client_organization_id: request
            .client_organization_id
            .filter(|id| !id.trim().is_empty())
            .map(str::to_owned),
        parent_task_id: request.parent_task_id.map(str::to_owned),
        created_at: request.now,
    };

    Ok(CompanyAction {
        relay_pubkey: request.relay_pubkey.to_owned(),
        operation: CompanyActionOperation::Attach,
        request_id: step_idempotency_key(&slot_id, &format!("attach-request:{}", request.send_id)),
        // Keyed by the send and the mode, so a retry of one send replays and
        // a deliberate second "new task" on the same send is still a second
        // request rather than a silently swallowed replay.
        idempotency_key: step_idempotency_key(
            &slot_id,
            &format!(
                "attach:{}:{}",
                request.send_id,
                match request.mode {
                    ThreadAttachMode::Open => "open",
                    ThreadAttachMode::Attach => "attach",
                    ThreadAttachMode::New => "new",
                }
            ),
        ),
        target: format!("{KIND_TASK}:{}:{slot_id}", request.relay_pubkey),
        // Nothing is being replaced: the request asks a question about the
        // thread, and asserting a head would make a safe retry a conflict.
        expected_head: None,
        expected_references: Vec::new(),
        payload: CompanyActionPayload::ThreadAttach(payload),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_thread_slot_is_the_same_coordinate_from_every_client() {
        let first = thread_slot_id("engineering", "root:abc", "AB12", ThreadSlot::Work);
        let second = thread_slot_id("engineering", "root:abc", "ab12", ThreadSlot::Work);
        assert_eq!(first, second);
        assert!(first.starts_with(THREAD_SLOT_PREFIX));
    }

    #[test]
    fn work_and_chat_slots_never_collide() {
        assert_ne!(
            thread_slot_id("engineering", "root:abc", "ab12", ThreadSlot::Work),
            thread_slot_id("engineering", "root:abc", "ab12", ThreadSlot::Chat)
        );
    }

    #[test]
    fn a_second_member_in_one_thread_gets_their_own_slot() {
        assert_ne!(
            thread_slot_id("engineering", "root:abc", "ab12", ThreadSlot::Work),
            thread_slot_id("engineering", "root:abc", "cd34", ThreadSlot::Work)
        );
    }

    #[test]
    fn a_reply_and_a_root_send_key_the_same_thread_differently() {
        assert_eq!(thread_key(Some("abc"), "send-1", false), "root:abc");
        assert_eq!(thread_key(None, "send-1", false), "send:send-1");
        assert_eq!(thread_key(Some("abc"), "send-1", true), "conversation");
    }

    #[test]
    fn two_sends_in_one_thread_propose_different_tasks() {
        assert_ne!(
            thread_task_id("engineering", "root:abc", "send-1", ThreadSlot::Work),
            thread_task_id("engineering", "root:abc", "send-2", ThreadSlot::Work)
        );
        assert_eq!(
            thread_task_id("engineering", "root:abc", "send-1", ThreadSlot::Work),
            thread_task_id("engineering", "root:abc", "send-1", ThreadSlot::Work)
        );
    }

    fn sample(mode: ThreadAttachMode) -> ThreadAttachRequest<'static> {
        ThreadAttachRequest {
            channel_id: "engineering",
            thread_root: Some("abc"),
            conversation_scope: false,
            send_id: "send-1",
            mode,
            title: "ship the release",
            agent_persona_id: Some("persona-cto"),
            client_organization_id: None,
            parent_task_id: None,
            owner_pubkey: "ab12",
            relay_pubkey: "cd34",
            now: 1_767_225_600,
        }
    }

    #[test]
    fn an_attach_targets_its_slot_and_asserts_no_head() {
        let action = plan_thread_attach(sample(ThreadAttachMode::Open)).expect("plan");
        assert_eq!(action.operation, CompanyActionOperation::Attach);
        assert!(action.expected_head.is_none());
        assert!(action.target.starts_with(&format!("{KIND_TASK}:cd34:")));
    }

    #[test]
    fn the_same_send_replays_and_a_new_task_does_not() {
        let open = plan_thread_attach(sample(ThreadAttachMode::Open)).expect("plan");
        let repeat = plan_thread_attach(sample(ThreadAttachMode::Open)).expect("plan");
        let fresh = plan_thread_attach(sample(ThreadAttachMode::New)).expect("plan");
        assert_eq!(open.idempotency_key, repeat.idempotency_key);
        assert_ne!(open.idempotency_key, fresh.idempotency_key);
    }

    #[test]
    fn a_send_without_a_channel_is_refused() {
        let mut request = sample(ThreadAttachMode::Open);
        request.channel_id = "   ";
        assert!(plan_thread_attach(request).is_err());
    }
}
