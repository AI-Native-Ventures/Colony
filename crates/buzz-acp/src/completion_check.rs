//! The question asked after an agent stops: was the request actually done?
//!
//! An agent turn ends when the model decides it has written a good enough
//! message, which is not the same thing as having finished the work. Nothing
//! downstream can tell those apart: a turn that ends mid-job and a turn that
//! ends because the job is done look identical to the pool, the queue, and the
//! relay. The gap is invisible until a human notices hours of silence.
//!
//! So the turn does not end on the model's first stop. It ends on the model's
//! answer to one narrow question, asked separately: *is the original request
//! complete?* The reframing is the point. At the moment a turn ends the model
//! is optimising for a message that reads well; asked afterwards, in isolation,
//! whether the work is finished, it answers a different question with a
//! different pressure on it.
//!
//! The check deliberately carries no summary of what the turn produced. Two
//! reasons: a large turn's output does not fit, and a summary invites the model
//! to grade the summary rather than the work. It is given the original request
//! and told to go and look.
//!
//! This module holds only the parts that are decidable without a model: what to
//! ask, how to read the answer, and when to stop asking. The turn loop in
//! [`crate::pool`] supplies the model.

/// How many consecutive incomplete verdicts end the run and hand back to the
/// human.
///
/// Consecutive is the operative word. An agent that stops early three times in
/// a row without ever reaching completion is stuck, and continuing to drive it
/// spends money without converging. An agent that finishes, is given more work,
/// and stops early again is working normally, so completion resets the count
/// ([`ContinuationCounter::record_complete`]) as does any new human message
/// ([`ContinuationCounter::reset`]).
pub const MAX_CONSECUTIVE_INCOMPLETE: u32 = 3;

/// What the agent said when asked whether the original request was finished.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// The request is satisfied. The turn ends here.
    Complete,
    /// Work remains and the agent can do it without anyone's help.
    Incomplete {
        /// What the agent says is left, in its own words. Used to write the
        /// one-line update the human sees before work resumes.
        remaining: Vec<String>,
    },
    /// Work remains but cannot proceed without a human. Stopping is correct;
    /// stopping silently is not, so the caller posts the ask.
    BlockedOnHuman {
        /// What the agent needs from the human before it can continue.
        needs: Vec<String>,
    },
}

/// Why a verdict could not be read.
///
/// Kept distinct from [`Verdict`] so the caller can retry the question once
/// before treating an unreadable answer as unfinished work. Folding it into
/// `Incomplete` would make a formatting slip cost a full extra turn of work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerdictParseError {
    /// Operator-facing reason, logged rather than shown to the human.
    pub reason: String,
}

impl std::fmt::Display for VerdictParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.reason)
    }
}

/// The question put to an agent that has just stopped.
///
/// Carries the original request and nothing else. `request` is the human's
/// message as sent; the caller truncates it if it is unreasonably long, because
/// this prompt is charged like any other.
pub fn build_check_prompt(request: &str) -> String {
    format!(
        "You have stopped. Before this turn ends, answer one question about the \
         request below, and nothing else.\n\n\
         Original request:\n{request}\n\n\
         Is that request now complete? Do not answer from memory of what you \
         intended to do. Check the actual state of the work first, then answer.\n\n\
         Reply with a single JSON object and no other text:\n\
         {{\"complete\": true}}\n\
         or\n\
         {{\"complete\": false, \"remaining\": [\"...\"]}}\n\
         or, if you cannot continue without the human:\n\
         {{\"complete\": false, \"blocked_on_human\": [\"...\"]}}\n\n\
         Use blocked_on_human only for things you genuinely cannot obtain or \
         decide yourself. Anything you could do by working longer is remaining, \
         not blocked."
    )
}

/// The instruction that resumes work after an incomplete verdict.
///
/// Posting the update is the agent's own job: it already has the ability to
/// write to the channel, and routing it through here would add a second way to
/// say the same thing.
pub fn build_continuation_prompt(remaining: &[String]) -> String {
    let list = remaining
        .iter()
        .map(|item| format!("- {item}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "The request is not complete. Outstanding:\n{list}\n\n\
         Post one short message to the channel saying what you are doing next, \
         then continue working on it now. Do not wait to be asked again."
    )
}

/// The message the human reads when an agent stops needing something from them.
///
/// Written by the harness rather than asked of the agent, and deliberately so.
/// The agent's own words would read better, but agents post to a channel by
/// running a tool, and a tool call can fail, be skipped, or be quietly declined.
/// Betting the "you are waiting on me" signal on that is how the silent stall
/// comes back: the harness knows the turn ended blocked, so the harness is what
/// says it.
pub fn build_blocked_notice(needs: &[String]) -> String {
    let list = needs
        .iter()
        .map(|item| format!("- {item}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "⏸ I have stopped because I need something from you before I can \
         finish.\n\nWaiting on:\n{list}\n\n\
         Reply here with it and I will carry on. Nothing wakes me until you do."
    )
}

/// Read the agent's answer to [`build_check_prompt`].
///
/// Tolerates a fenced block or surrounding prose, because models add both, but
/// refuses to guess: an answer with no readable `complete` field is an error
/// rather than an assumed completion. Assuming completion here would restore
/// exactly the silent stall this module exists to prevent.
pub fn parse_verdict(answer: &str) -> Result<Verdict, VerdictParseError> {
    let object = extract_json_object(answer).ok_or_else(|| VerdictParseError {
        reason: "no JSON object in completion-check answer".to_string(),
    })?;

    let value: serde_json::Value =
        serde_json::from_str(&object).map_err(|error| VerdictParseError {
            reason: format!("completion-check answer is not valid JSON: {error}"),
        })?;

    let complete = value
        .get("complete")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| VerdictParseError {
            reason: "completion-check answer has no boolean `complete` field".to_string(),
        })?;

    if complete {
        return Ok(Verdict::Complete);
    }

    let blocked = string_list(&value, "blocked_on_human");
    if !blocked.is_empty() {
        return Ok(Verdict::BlockedOnHuman { needs: blocked });
    }

    let remaining = string_list(&value, "remaining");
    if remaining.is_empty() {
        // `complete: false` with nothing named is still unfinished work. Losing
        // the detail is worse than losing the run, so this continues with a
        // placeholder rather than falling back to Complete.
        return Ok(Verdict::Incomplete {
            remaining: vec!["unfinished work the agent did not name".to_string()],
        });
    }

    Ok(Verdict::Incomplete { remaining })
}

/// Pull the outermost JSON object out of an answer that may be fenced or
/// wrapped in prose.
///
/// Scans for the first `{` and matches to its balanced `}`, ignoring braces
/// inside string literals so a `remaining` entry containing one cannot end the
/// object early.
fn extract_json_object(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let start = text.find('{')?;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    for (offset, byte) in bytes.iter().enumerate().skip(start) {
        if in_string {
            if escaped {
                escaped = false;
            } else if *byte == b'\\' {
                escaped = true;
            } else if *byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return text.get(start..=offset).map(str::to_string);
                }
            }
            _ => {}
        }
    }
    None
}

/// Read a field that should be a list of non-empty strings.
///
/// A bare string is accepted as a one-item list: models write
/// `"remaining": "stage 2"` often enough that refusing it would cost a turn.
fn string_list(value: &serde_json::Value, key: &str) -> Vec<String> {
    match value.get(key) {
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .collect(),
        Some(serde_json::Value::String(item)) if !item.trim().is_empty() => {
            vec![item.trim().to_string()]
        }
        _ => Vec::new(),
    }
}

/// Consecutive incomplete verdicts for one channel's run.
///
/// Only consecutive incompletes count toward the cap: see
/// [`MAX_CONSECUTIVE_INCOMPLETE`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ContinuationCounter {
    consecutive_incomplete: u32,
}

impl ContinuationCounter {
    /// A counter with nothing recorded against it.
    pub fn new() -> Self {
        Self::default()
    }

    /// Record an incomplete verdict. Returns `true` while work may continue,
    /// and `false` once the cap is reached and the run must hand back.
    pub fn record_incomplete(&mut self) -> bool {
        self.consecutive_incomplete = self.consecutive_incomplete.saturating_add(1);
        self.consecutive_incomplete < MAX_CONSECUTIVE_INCOMPLETE
    }

    /// Record a completion. The agent converged, so the streak is over.
    pub fn record_complete(&mut self) {
        self.consecutive_incomplete = 0;
    }

    /// Clear the streak because a human said something new.
    ///
    /// A fresh instruction starts a fresh run: the previous streak says nothing
    /// about whether the agent can finish what it has just been given.
    pub fn reset(&mut self) {
        self.consecutive_incomplete = 0;
    }

    /// How many consecutive incomplete verdicts stand against this run.
    pub fn consecutive_incomplete(&self) -> u32 {
        self.consecutive_incomplete
    }

    /// Whether the cap has been reached and the run must stop.
    pub fn exhausted(&self) -> bool {
        self.consecutive_incomplete >= MAX_CONSECUTIVE_INCOMPLETE
    }
}

/// The message left in the channel when an agent stops early too many times.
///
/// Names the outstanding work so the human can decide whether to push it again
/// or take it over, and says plainly that the agent gave up rather than
/// finished, because those two look the same from the outside.
pub fn build_exhausted_notice(remaining: &[String]) -> String {
    let list = remaining
        .iter()
        .map(|item| format!("- {item}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "⚠️ I stopped short of finishing this {MAX_CONSECUTIVE_INCOMPLETE} times in a row, \
         so I am handing it back rather than looping.\n\nStill outstanding:\n{list}\n\n\
         Reply here to push it again, and say if you want it approached differently."
    )
}

/// The message left in the channel when a turn ends on a token or request
/// ceiling rather than on the agent deciding it was finished.
///
/// A ceiling stop is not a completion, and the completion check cannot rescue
/// it: the session is discarded straight afterwards because its context is what
/// filled up, so there is nothing left to drive on. What the harness can do is
/// refuse to let it pass for a finished turn. Without this the run simply goes
/// quiet, which is indistinguishable from success until a human counts the
/// hours.
///
/// `reason` is a short human phrase for the ceiling that was hit, not the enum
/// name.
pub fn build_ceiling_notice(reason: &str) -> String {
    format!(
        "⚠️ I had to stop mid-way: {reason}. The work is not finished, and I \
         have started a fresh session, so I no longer remember what I had \
         already done.\n\n\
         Reply here to pick it up. Telling me what is already done, or asking \
         me to check first, saves me repeating it."
    )
}

/// The two things the completion loop needs a model for.
///
/// Split out so the loop's sequencing — when it asks again, when it drives on,
/// when it gives up — is testable against a scripted responder. The alternative
/// is proving that behaviour only through a live agent, which is the one thing
/// a stall bug guarantees you cannot do quickly.
#[allow(async_fn_in_trait)]
pub trait CompletionResponder {
    /// Whatever the transport failed with. Only ever displayed.
    type Error: std::fmt::Display;

    /// Put a question to the agent and return its own prose.
    async fn ask(&mut self, prompt: &str) -> Result<String, Self::Error>;

    /// Give the agent an instruction whose output belongs to the channel
    /// rather than to the harness.
    async fn instruct(&mut self, prompt: &str) -> Result<(), Self::Error>;
}

/// How the completion loop left the turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompletionOutcome {
    /// The agent said the request was finished.
    Complete,
    /// The agent stopped needing something only the human can supply.
    /// Carries what it is waiting on, for the notice the human reads.
    BlockedOnHuman {
        /// What the agent needs before it can continue.
        needs: Vec<String>,
    },
    /// The agent stopped short [`MAX_CONSECUTIVE_INCOMPLETE`] times running.
    /// Carries what was still outstanding, for the notice the human reads.
    Exhausted {
        /// Outstanding work as the agent last described it.
        remaining: Vec<String>,
    },
    /// The check could not be run or could not be read. The turn ends exactly
    /// as it would have before the check existed.
    Indeterminate,
}

/// Ask a stopped agent whether the request is done, and drive it on while it
/// is not.
///
/// Every failure path returns [`CompletionOutcome::Indeterminate`]: a check
/// that cannot run must not cost the human the work that already succeeded.
pub async fn run_completion_loop<R: CompletionResponder>(
    responder: &mut R,
    request: &str,
) -> CompletionOutcome {
    let mut counter = ContinuationCounter::new();

    loop {
        let answer = match responder.ask(&build_check_prompt(request)).await {
            Ok(answer) => answer,
            Err(error) => {
                tracing::warn!(
                    target: "pool::completion",
                    "completion check could not be asked ({error}) — ending turn as-is"
                );
                return CompletionOutcome::Indeterminate;
            }
        };

        let verdict = match parse_verdict(&answer) {
            Ok(verdict) => verdict,
            Err(error) => {
                // Unreadable is not the same as unfinished. Driving the agent
                // on from a formatting slip would spend a whole turn on a
                // guess, so this stops and says why in the log.
                tracing::warn!(
                    target: "pool::completion",
                    "completion check answer unreadable ({error}) — ending turn as-is"
                );
                return CompletionOutcome::Indeterminate;
            }
        };

        match verdict {
            Verdict::Complete => return CompletionOutcome::Complete,
            Verdict::BlockedOnHuman { needs } => {
                // Stopping is right here; stopping silently is the bug. The
                // caller posts the ask, because the harness knows the turn
                // ended blocked and does not have to trust a tool call to say so.
                return CompletionOutcome::BlockedOnHuman { needs };
            }
            Verdict::Incomplete { remaining } => {
                if !counter.record_incomplete() {
                    return CompletionOutcome::Exhausted { remaining };
                }
                if let Err(error) = responder
                    .instruct(&build_continuation_prompt(&remaining))
                    .await
                {
                    tracing::warn!(
                        target: "pool::completion",
                        "continuation turn failed ({error}) — ending turn as-is"
                    );
                    return CompletionOutcome::Indeterminate;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_complete_answer_is_complete() {
        assert_eq!(
            parse_verdict(r#"{"complete": true}"#),
            Ok(Verdict::Complete)
        );
    }

    #[test]
    fn a_fenced_answer_is_read_through_the_fence() {
        let answer = "Checked the output directory.\n```json\n{\"complete\": false, \
                      \"remaining\": [\"stage 2: design and build\"]}\n```\n";
        assert_eq!(
            parse_verdict(answer),
            Ok(Verdict::Incomplete {
                remaining: vec!["stage 2: design and build".to_string()],
            })
        );
    }

    #[test]
    fn blocked_on_human_outranks_remaining() {
        // An answer naming both is blocked: continuing would burn a turn on
        // work that cannot land without the human's answer anyway.
        let answer = r#"{"complete": false, "remaining": ["contact page"],
                        "blocked_on_human": ["street address"]}"#;
        assert_eq!(
            parse_verdict(answer),
            Ok(Verdict::BlockedOnHuman {
                needs: vec!["street address".to_string()],
            })
        );
    }

    #[test]
    fn a_bare_string_list_is_accepted() {
        assert_eq!(
            parse_verdict(r#"{"complete": false, "remaining": "stage 2"}"#),
            Ok(Verdict::Incomplete {
                remaining: vec!["stage 2".to_string()],
            })
        );
    }

    #[test]
    fn a_brace_inside_a_string_does_not_end_the_object() {
        let answer = r#"{"complete": false, "remaining": ["fix the `{}` literal", "ship"]}"#;
        assert_eq!(
            parse_verdict(answer),
            Ok(Verdict::Incomplete {
                remaining: vec!["fix the `{}` literal".to_string(), "ship".to_string()],
            })
        );
    }

    #[test]
    fn incomplete_with_nothing_named_is_still_incomplete() {
        // The one case where guessing is tempting. Treating this as Complete
        // is exactly the silent stall the module exists to prevent.
        let verdict = parse_verdict(r#"{"complete": false}"#);
        assert!(matches!(verdict, Ok(Verdict::Incomplete { .. })));
    }

    #[test]
    fn an_answer_with_no_json_is_an_error_not_a_completion() {
        let error = parse_verdict("Yes, all done!").expect_err("prose must not parse");
        assert!(error.reason.contains("no JSON object"), "{error}");
    }

    #[test]
    fn an_answer_with_no_complete_field_is_an_error() {
        let error =
            parse_verdict(r#"{"status": "done"}"#).expect_err("missing field must not parse");
        assert!(error.reason.contains("`complete`"), "{error}");
    }

    #[test]
    fn the_check_prompt_carries_the_request_and_no_output_summary() {
        let prompt = build_check_prompt("build the Global Chain site");
        assert!(prompt.contains("build the Global Chain site"));
        assert!(prompt.contains("Check the actual state of the work"));
    }

    #[test]
    fn three_consecutive_incompletes_exhaust_the_run() {
        let mut counter = ContinuationCounter::new();
        assert!(counter.record_incomplete(), "first stop may continue");
        assert!(counter.record_incomplete(), "second stop may continue");
        assert!(!counter.record_incomplete(), "third stop hands back");
        assert!(counter.exhausted());
    }

    #[test]
    fn a_completion_between_stops_clears_the_streak() {
        // The sequence the cap is written for: stop, stop, finish, get more
        // work, stop again. That last stop is the first of a new streak, not
        // the third of an old one.
        let mut counter = ContinuationCounter::new();
        counter.record_incomplete();
        counter.record_incomplete();
        counter.record_complete();
        assert_eq!(counter.consecutive_incomplete(), 0);
        assert!(counter.record_incomplete(), "new streak may continue");
        assert!(!counter.exhausted());
    }

    #[test]
    fn a_new_human_message_clears_the_streak() {
        let mut counter = ContinuationCounter::new();
        counter.record_incomplete();
        counter.record_incomplete();
        counter.reset();
        assert_eq!(counter.consecutive_incomplete(), 0);
        assert!(!counter.exhausted());
    }

    /// A responder that answers from a script and records what it was told.
    ///
    /// Recording the instructions matters as much as the answers: the bug this
    /// module exists for is an agent that is never told to carry on, and a loop
    /// that reached the right verdict without sending the continuation would
    /// look identical from the outcome alone.
    struct ScriptedResponder {
        answers: Vec<String>,
        asked: Vec<String>,
        instructed: Vec<String>,
        fail_on_ask: bool,
    }

    impl ScriptedResponder {
        fn new(answers: &[&str]) -> Self {
            Self {
                answers: answers.iter().rev().map(|a| (*a).to_string()).collect(),
                asked: Vec::new(),
                instructed: Vec::new(),
                fail_on_ask: false,
            }
        }

        fn failing() -> Self {
            Self {
                answers: Vec::new(),
                asked: Vec::new(),
                instructed: Vec::new(),
                fail_on_ask: true,
            }
        }
    }

    impl CompletionResponder for ScriptedResponder {
        type Error = String;

        async fn ask(&mut self, prompt: &str) -> Result<String, Self::Error> {
            if self.fail_on_ask {
                return Err("transport died".to_string());
            }
            self.asked.push(prompt.to_string());
            Ok(self
                .answers
                .pop()
                .expect("loop asked more times than the script allows"))
        }

        async fn instruct(&mut self, prompt: &str) -> Result<(), Self::Error> {
            self.instructed.push(prompt.to_string());
            Ok(())
        }
    }

    #[tokio::test]
    async fn a_finished_agent_is_asked_once_and_left_alone() {
        let mut responder = ScriptedResponder::new(&[r#"{"complete": true}"#]);
        let outcome = run_completion_loop(&mut responder, "answer my question").await;
        assert_eq!(outcome, CompletionOutcome::Complete);
        assert_eq!(responder.asked.len(), 1);
        assert!(
            responder.instructed.is_empty(),
            "a finished agent must not be driven on"
        );
    }

    #[tokio::test]
    async fn an_unfinished_agent_is_told_to_carry_on() {
        // The Fable case: stage 1 done, stage 2 never started.
        let mut responder = ScriptedResponder::new(&[
            r#"{"complete": false, "remaining": ["stage 2: design and build"]}"#,
            r#"{"complete": true}"#,
        ]);
        let outcome = run_completion_loop(&mut responder, "build the site").await;
        assert_eq!(outcome, CompletionOutcome::Complete);
        assert_eq!(responder.asked.len(), 2, "must re-check after continuing");
        assert_eq!(responder.instructed.len(), 1);
        assert!(
            responder.instructed[0].contains("stage 2: design and build"),
            "continuation must name the outstanding work: {}",
            responder.instructed[0]
        );
        assert!(
            responder.instructed[0].contains("continue working"),
            "continuation must actually tell it to carry on"
        );
    }

    #[tokio::test]
    async fn three_stops_in_a_row_hand_back_with_what_is_left() {
        let stalled = r#"{"complete": false, "remaining": ["stage 4"]}"#;
        let mut responder = ScriptedResponder::new(&[stalled, stalled, stalled]);
        let outcome = run_completion_loop(&mut responder, "build the site").await;
        assert_eq!(
            outcome,
            CompletionOutcome::Exhausted {
                remaining: vec!["stage 4".to_string()],
            }
        );
        assert_eq!(responder.asked.len(), 3, "asked exactly three times");
        assert_eq!(
            responder.instructed.len(),
            2,
            "driven on twice, then handed back rather than a third time"
        );
    }

    #[tokio::test]
    async fn a_completion_between_stops_buys_a_fresh_streak() {
        // Two stops, a finish, then two more stops and a finish. Nine asks
        // would be impossible if the counter were cumulative rather than
        // consecutive: it would have handed back at the third stop overall.
        let stalled = r#"{"complete": false, "remaining": ["more"]}"#;
        let done = r#"{"complete": true}"#;
        let mut responder = ScriptedResponder::new(&[stalled, stalled, done]);
        assert_eq!(
            run_completion_loop(&mut responder, "first job").await,
            CompletionOutcome::Complete
        );

        let mut responder = ScriptedResponder::new(&[stalled, stalled, done]);
        assert_eq!(
            run_completion_loop(&mut responder, "second job").await,
            CompletionOutcome::Complete,
            "a new turn starts a new streak"
        );
    }

    #[tokio::test]
    async fn a_blocked_agent_stops_and_reports_what_it_needs() {
        let mut responder = ScriptedResponder::new(&[
            r#"{"complete": false, "blocked_on_human": ["street address"]}"#,
        ]);
        let outcome = run_completion_loop(&mut responder, "build the site").await;
        assert_eq!(
            outcome,
            CompletionOutcome::BlockedOnHuman {
                needs: vec!["street address".to_string()],
            }
        );
        assert!(
            responder.instructed.is_empty(),
            "the ask is posted by the caller, not asked of the agent: a tool \
             call that fails would restore the silent stall"
        );
    }

    #[test]
    fn the_blocked_notice_names_what_is_needed_and_that_nothing_will_wake_it() {
        let notice = build_blocked_notice(&["street address in Edenvale".to_string()]);
        assert!(notice.contains("street address in Edenvale"));
        assert!(
            notice.contains("Nothing wakes me until you do"),
            "the human must know the agent is not on a timer: {notice}"
        );
    }

    #[test]
    fn the_ceiling_notice_says_the_work_is_unfinished_and_the_memory_is_gone() {
        let notice = build_ceiling_notice("I ran out of context for this session");
        assert!(notice.contains("ran out of context"));
        assert!(
            notice.contains("not finished"),
            "a ceiling stop must not read as a completed turn: {notice}"
        );
        assert!(
            notice.contains("no longer remember"),
            "the human has to know the next reply starts from nothing: {notice}"
        );
    }

    #[tokio::test]
    async fn an_unreadable_answer_ends_the_turn_without_driving_on() {
        let mut responder = ScriptedResponder::new(&["all good chief"]);
        let outcome = run_completion_loop(&mut responder, "build the site").await;
        assert_eq!(outcome, CompletionOutcome::Indeterminate);
        assert!(
            responder.instructed.is_empty(),
            "a formatting slip must not cost a full turn of work"
        );
    }

    #[tokio::test]
    async fn a_failed_check_leaves_the_turn_exactly_as_it_was() {
        let mut responder = ScriptedResponder::failing();
        let outcome = run_completion_loop(&mut responder, "build the site").await;
        assert_eq!(outcome, CompletionOutcome::Indeterminate);
        assert!(responder.instructed.is_empty());
    }

    #[test]
    fn the_exhausted_notice_names_what_is_left() {
        let notice = build_exhausted_notice(&["stage 4: contact page".to_string()]);
        assert!(notice.contains("stage 4: contact page"));
        assert!(notice.contains("handing it back"));
    }
}
