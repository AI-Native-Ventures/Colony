//! Render an incoming Ask into the block an agent acts on.

use nostr::Event;

/// An Ask (kind 44300) addressed to this agent, reduced to what the agent
/// needs in order to act.
#[derive(Debug, Clone, PartialEq)]
pub struct IncomingAsk {
    /// Event id, hex. This is what `buzz asks answer --ask` takes.
    pub id: String,
    /// `decision`, `question`, `credential`, or `blocker`.
    pub ask_type: String,
    /// One-line statement of what is needed.
    pub headline: String,
    /// What waiting costs, when the filer stated it.
    pub cost_of_delay: Option<String>,
    /// The task the filer is blocked on, when the ask names one.
    pub task_id: Option<String>,
}

/// Read an incoming Ask off an event, or `None` when the event is not an ask
/// or its content is unusable.
///
/// Never returns an error: an agent handed a malformed ask should carry on
/// with the rest of its turn rather than fail it.
pub fn read_incoming_ask(event: &Event) -> Option<IncomingAsk> {
    if event.kind.as_u16() as u32 != buzz_core::kind::KIND_ASK {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(&event.content).ok()?;
    let headline = value
        .get("headline")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())?;
    let ask_type = value
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("question");
    Some(IncomingAsk {
        id: event.id.to_hex(),
        ask_type: ask_type.to_string(),
        headline: headline.to_string(),
        cost_of_delay: value
            .get("cost_of_delay")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        task_id: value
            .get("task")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
}

/// The prompt block for an ask this agent must answer.
///
/// Shaped like [`crate::work_context::work_context_section`]: identifiers the
/// agent has to pass verbatim to a CLI command, and an instruction that names
/// both the answer path and the escalation path. Naming only the answer path
/// leaves an agent that genuinely cannot decide with no move except silence,
/// and silence is what the deadline sweep turns into a founder interrupt.
pub fn ask_context_section(ask: &IncomingAsk) -> String {
    let cost = ask.cost_of_delay.as_deref().unwrap_or("not stated");
    let task = ask.task_id.as_deref().unwrap_or("none");
    format!(
        "<colony-ask>\n\
         Ask id: {id}\n\
         Type: {ask_type}\n\
         Headline: {headline}\n\
         Cost of delay: {cost}\n\
         Task id: {task}\n\
         </colony-ask>\n\
         Someone below you is blocked on this and is waiting. Answer it if you \
         can decide it, using the ask id verbatim:\n\
         `buzz asks answer --ask {id} --answer-json '{{\"decision\":\"<what you \
         decided>\",\"rationale\":\"<why>\"}}'`\n\
         If it genuinely needs a tier above you, escalate instead of going \
         silent:\n\
         `buzz asks escalate --prior {id} --type {ask_type} --to \
         <one-tier-up-pubkey> --task {task} --need <short-slug> --headline \
         \"<what you need>\" --cost-of-delay \"{cost}\"`\n\
         Doing neither is the worst option: an unanswered ask times out and \
         lands on the founder, which is exactly what this chain exists to \
         prevent. Never put a secret in an answer.",
        id = ask.id,
        ask_type = ask.ask_type,
        headline = ask.headline,
        cost = cost,
        task = task,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask_event(content: &str) -> nostr::Event {
        let filer = nostr::Keys::generate();
        nostr::EventBuilder::new(nostr::Kind::from(buzz_core::kind::KIND_ASK as u16), content)
            .sign_with_keys(&filer)
            .unwrap()
    }

    #[test]
    fn a_well_formed_ask_reads_its_fields() {
        let event = ask_event(
            r#"{"type":"decision","headline":"Which vendor for SMS?","cost_of_delay":"onboarding is blocked","task":"task-7"}"#,
        );
        let ask = read_incoming_ask(&event).expect("should parse");
        assert_eq!(ask.id, event.id.to_hex());
        assert_eq!(ask.ask_type, "decision");
        assert_eq!(ask.headline, "Which vendor for SMS?");
        assert_eq!(ask.cost_of_delay.as_deref(), Some("onboarding is blocked"));
        assert_eq!(ask.task_id.as_deref(), Some("task-7"));
    }

    #[test]
    fn an_ask_missing_optional_fields_still_reads() {
        let ask = read_incoming_ask(&ask_event(
            r#"{"type":"question","headline":"Is staging expected to be down?"}"#,
        ))
        .expect("should parse");
        assert_eq!(ask.cost_of_delay, None);
        assert_eq!(ask.task_id, None);
    }

    #[test]
    fn a_non_ask_event_reads_as_none() {
        let filer = nostr::Keys::generate();
        let message = nostr::EventBuilder::new(
            nostr::Kind::from(buzz_core::kind::KIND_STREAM_MESSAGE as u16),
            "hello",
        )
        .sign_with_keys(&filer)
        .unwrap();
        assert!(read_incoming_ask(&message).is_none());
    }

    #[test]
    fn malformed_ask_content_reads_as_none_rather_than_panicking() {
        assert!(read_incoming_ask(&ask_event("{not json")).is_none());
        assert!(read_incoming_ask(&ask_event("{}")).is_none());
    }

    #[test]
    fn the_section_names_the_id_and_the_answer_command() {
        let ask = IncomingAsk {
            id: "abc123".into(),
            ask_type: "decision".into(),
            headline: "Which vendor for SMS?".into(),
            cost_of_delay: Some("onboarding is blocked".into()),
            task_id: Some("task-7".into()),
        };
        let section = ask_context_section(&ask);
        assert!(section.contains("<colony-ask>"));
        assert!(section.contains("</colony-ask>"));
        assert!(
            section.contains("abc123"),
            "the agent cannot answer without the id"
        );
        assert!(section.contains("Which vendor for SMS?"));
        assert!(section.contains("onboarding is blocked"));
        assert!(
            section.contains("buzz asks answer"),
            "the block must name the command that closes the ask"
        );
        assert!(
            section.contains("buzz asks escalate"),
            "an agent that cannot answer must be told the escalation path, \
             otherwise it stalls and the deadline sweep sends it to the owner"
        );
    }
}
