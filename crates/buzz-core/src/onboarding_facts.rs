//! The closed set of facts onboarding must establish before a company exists.
//!
//! Why a CLOSED set. An agent told to "ask about the gaps" has no way to know
//! it is finished, so it asks progressively vaguer questions and the owner
//! never reaches an end. Enumerating the facts gives onboarding a definition of
//! done: every fact is either answered or explicitly marked unknown, and then
//! the interview stops.
//!
//! Why UNKNOWN is terminal. A business genuinely may not know its target
//! audience or its per-service pricing yet, and that is a legitimate answer —
//! often the most honest one. Treating it as unresolved would re-ask forever,
//! which is exactly the loop this module exists to prevent. An unknown fact
//! becomes a visible gap on the Blueprint instead, so it is recorded rather
//! than lost.
//!
//! Every fact here earns its place by feeding something downstream. A question
//! that changes no decision is a question not worth an owner's time.

use serde::{Deserialize, Serialize};

/// A fact onboarding must resolve.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FactId {
    /// Where the business operates from.
    Location,
    /// What it sells.
    ServicesAndProducts,
    /// What each service or product costs.
    PricingPerService,
    /// Who it sells to.
    TargetAudience,
    /// What the work is and how it actually gets done.
    WorkTypeAndProcess,
    /// Who does the work today, and how much of it they can carry.
    TeamAndCapacity,
}

/// Ways an owner may answer.
///
/// Answers are not limited to typed text: an owner explaining a delivery
/// process will often have it written down already, and asking them to retype
/// it wastes the thing that makes the answer good.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AnswerKind {
    /// Pick from offered options.
    Choice,
    /// Free-form text.
    Text,
    /// A URL pointing at more detail.
    Link,
    /// An uploaded document.
    File,
}

/// Whether a fact still needs asking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FactState {
    /// Not yet established.
    Outstanding,
    /// Partly established — usually the website answered some of it.
    ///
    /// A site listing its services without prices, or naming the work without
    /// describing the process, has answered enough to be worth building on and
    /// too little to act on. One follow-up is warranted; see
    /// [`MAX_FOLLOW_UPS`] for why it is only one.
    Partial,
    /// The owner answered, or the website told us in full.
    Answered,
    /// The owner said they do not know. Terminal — never asked again.
    Unknown,
}

/// Follow-ups allowed per fact before the partial answer is simply accepted.
///
/// A partial answer reopens the question, and an unbounded "is that everything?"
/// is the same infinite loop this module exists to prevent, just slower. One
/// follow-up captures the detail a website could not carry; a second would be
/// interrogation. Whatever is still missing after that is recorded as a gap
/// rather than chased.
pub const MAX_FOLLOW_UPS: u8 = 1;

impl FactState {
    /// Whether this fact is settled, ignoring follow-up budget.
    ///
    /// `Partial` is deliberately NOT settled here: [`FactProgress::is_resolved`]
    /// decides that, because whether a partial answer still deserves a question
    /// depends on how many have already been asked.
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Answered | Self::Unknown)
    }
}

/// A fact's state plus how many follow-ups it has already consumed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactProgress {
    /// Which fact.
    pub id: FactId,
    /// Where it stands.
    pub state: FactState,
    /// Follow-ups already asked about it.
    #[serde(default)]
    pub follow_ups_asked: u8,
}

impl FactProgress {
    /// A fact in a given state with no follow-ups spent.
    pub const fn new(id: FactId, state: FactState) -> Self {
        Self {
            id,
            state,
            follow_ups_asked: 0,
        }
    }

    /// Whether this fact is finished with.
    ///
    /// The rule that makes the interview terminate: answered and unknown are
    /// terminal outright, and a partial answer becomes terminal once its
    /// follow-up budget is spent.
    pub const fn is_resolved(self) -> bool {
        self.state.is_terminal() || self.follow_ups_asked >= MAX_FOLLOW_UPS
    }

    /// Whether the next question about this fact is a follow-up rather than a
    /// first ask — so it can reference what is already known instead of
    /// starting over.
    pub const fn needs_follow_up(self) -> bool {
        matches!(self.state, FactState::Partial) && self.follow_ups_asked < MAX_FOLLOW_UPS
    }
}

/// One required fact and why it is worth asking about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequiredFact {
    /// Stable identifier, used by Interview blocks and answer receipts.
    pub id: FactId,
    /// Short label for the Blueprint and gap lists.
    pub label: &'static str,
    /// The question as an owner would be asked it.
    pub prompt: &'static str,
    /// Asked when the website answered part of this.
    ///
    /// Separate from `prompt` because a follow-up that restates the original
    /// question reads as though nothing was heard, and an owner who has
    /// already seen their own website quoted back will not answer it twice.
    pub follow_up_prompt: &'static str,
    /// What this changes downstream. Shown to the owner, because a question
    /// whose purpose is visible is far more likely to get a real answer.
    pub why_it_matters: &'static str,
    /// Accepted answer forms.
    pub accepts: &'static [AnswerKind],
}

const EVERY_FORM: &[AnswerKind] = &[
    AnswerKind::Choice,
    AnswerKind::Text,
    AnswerKind::Link,
    AnswerKind::File,
];

/// The complete set. Onboarding is done when every one of these is resolved.
///
/// Ordered by how much later work depends on the answer: what the business
/// sells and how it delivers gate the roster and the cost model, so they are
/// asked first while the owner's attention is freshest.
pub const REQUIRED_FACTS: &[RequiredFact] = &[
    RequiredFact {
        id: FactId::ServicesAndProducts,
        label: "Services and products",
        prompt: "What does the business sell? List each service or product separately, even if some are occasional.",
        follow_up_prompt: "I found some of what you sell on the site. Is that the full list, and is anything there no longer offered?",
        why_it_matters: "Each one becomes a service the company can be paid for, and its own cost centre, so profit can be told apart per service rather than only in total.",
        accepts: EVERY_FORM,
    },
    RequiredFact {
        id: FactId::WorkTypeAndProcess,
        label: "Type of work and process",
        prompt: "Walk me through how the work actually gets done, from a client saying yes to the work being delivered. Rough steps are fine, and a link or document is better than retyping it.",
        follow_up_prompt: "The site describes what you do but not how a job actually runs. What happens between a client saying yes and the work being delivered?",
        why_it_matters: "This is what the agent team has to reproduce. Without the real steps I can only invent a generic process, and the teams I propose would not match how the business works.",
        accepts: EVERY_FORM,
    },
    RequiredFact {
        id: FactId::PricingPerService,
        label: "Pricing per service",
        prompt: "What does each service or product cost, and is it one-off or recurring?",
        follow_up_prompt: "I found some pricing but not for everything. What do the remaining services cost, and which are recurring?",
        why_it_matters: "Without a price per service, work can be tracked but never told apart as profitable or unprofitable.",
        accepts: EVERY_FORM,
    },
    RequiredFact {
        id: FactId::TargetAudience,
        label: "Target audience",
        prompt: "Who is this for? Industry, size, and where they are, as far as you know.",
        follow_up_prompt: "The site hints at who you work with. Is there a particular industry, size or region you actually want more of?",
        why_it_matters: "Decides who the company looks for when it goes hunting for customers. It is fine not to know yet.",
        accepts: EVERY_FORM,
    },
    RequiredFact {
        id: FactId::Location,
        label: "Where the business is based",
        prompt: "Where is the business based, and where do its customers tend to be?",
        follow_up_prompt: "I have a location from the site. Is that where the work is done, and are your customers mostly in the same place?",
        why_it_matters: "Sets currency, tax and invoicing expectations, working hours for outreach, and which legal obligations are worth flagging.",
        accepts: EVERY_FORM,
    },
    RequiredFact {
        id: FactId::TeamAndCapacity,
        label: "Who does the work today",
        prompt: "Who does this work at the moment, and roughly how much can they take on?",
        follow_up_prompt: "The site suggests roughly how many of you there are. Who actually does the delivery work, and how much can they take on right now?",
        why_it_matters: "Decides how large a team to propose. A solo operator and a ten-person studio need very different rosters, and proposing the wrong one wastes money.",
        accepts: EVERY_FORM,
    },
];

/// Look up one fact.
pub fn required_fact(id: FactId) -> &'static RequiredFact {
    REQUIRED_FACTS
        .iter()
        .find(|fact| fact.id == id)
        .expect("REQUIRED_FACTS covers every FactId, asserted by test")
}

/// What to ask next, and whether it is a first ask or a follow-up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NextQuestion {
    /// The fact to ask about.
    pub fact: &'static RequiredFact,
    /// True when the website answered part of it already.
    pub is_follow_up: bool,
}

impl NextQuestion {
    /// The prompt to put to the owner.
    pub const fn prompt(&self) -> &'static str {
        if self.is_follow_up {
            self.fact.follow_up_prompt
        } else {
            self.fact.prompt
        }
    }
}

/// The next question worth asking, or `None` when onboarding may proceed.
///
/// Takes progress rather than answers so a fact the website already settled is
/// never asked about — the owner should not be made to retype something their
/// own site said — and so a partly-answered fact gets a follow-up that builds
/// on what is known instead of starting over.
pub fn next_question(progress: &[FactProgress]) -> Option<NextQuestion> {
    REQUIRED_FACTS.iter().find_map(|fact| {
        let entry = progress.iter().find(|entry| entry.id == fact.id);
        match entry {
            Some(entry) if entry.is_resolved() => None,
            Some(entry) => Some(NextQuestion {
                fact,
                is_follow_up: entry.needs_follow_up(),
            }),
            None => Some(NextQuestion {
                fact,
                is_follow_up: false,
            }),
        }
    })
}

/// Whether every required fact has been settled.
pub fn onboarding_is_complete(progress: &[FactProgress]) -> bool {
    next_question(progress).is_none()
}

/// Facts still open when onboarding finished, for the Blueprint's gap list.
///
/// Covers both an owner who said they do not know and a partial answer whose
/// follow-up budget ran out. Recorded rather than discarded: an unknown is a
/// real finding about the business, and the company can revisit it once it has
/// evidence.
pub fn outstanding_gaps(progress: &[FactProgress]) -> Vec<&'static RequiredFact> {
    progress
        .iter()
        .filter(|entry| {
            entry.state == FactState::Unknown
                || (entry.state == FactState::Partial && entry.is_resolved())
        })
        .map(|entry| required_fact(entry.id))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    const ALL: [FactId; 6] = [
        FactId::Location,
        FactId::ServicesAndProducts,
        FactId::PricingPerService,
        FactId::TargetAudience,
        FactId::WorkTypeAndProcess,
        FactId::TeamAndCapacity,
    ];

    fn answered_except(exceptions: &[(FactId, FactState)]) -> Vec<FactProgress> {
        ALL.iter()
            .map(|id| {
                let state = exceptions
                    .iter()
                    .find(|(other, _)| other == id)
                    .map(|(_, state)| *state)
                    .unwrap_or(FactState::Answered);
                FactProgress::new(*id, state)
            })
            .collect()
    }

    #[test]
    fn every_fact_id_has_exactly_one_definition() {
        assert_eq!(REQUIRED_FACTS.len(), ALL.len());
        let defined: BTreeSet<FactId> = REQUIRED_FACTS.iter().map(|fact| fact.id).collect();
        assert_eq!(defined.len(), REQUIRED_FACTS.len(), "no duplicate ids");
        for id in ALL {
            assert!(defined.contains(&id), "{id:?} has no definition");
        }
    }

    /// A question whose purpose is invisible is a question an owner answers
    /// carelessly, so every fact must say what it changes.
    #[test]
    fn every_fact_states_prompts_and_a_consequence() {
        for fact in REQUIRED_FACTS {
            assert!(!fact.label.trim().is_empty(), "{:?} needs a label", fact.id);
            assert!(fact.prompt.len() > 20, "{:?} needs a real prompt", fact.id);
            assert!(
                fact.why_it_matters.len() > 30,
                "{:?} must say what it changes",
                fact.id
            );
            // A follow-up that restates the original reads as though nothing
            // was heard, and will not be answered twice.
            assert!(
                fact.follow_up_prompt.len() > 20,
                "{:?} needs a follow-up prompt",
                fact.id
            );
            assert_ne!(
                fact.follow_up_prompt, fact.prompt,
                "{:?} follow-up must not restate the first ask",
                fact.id
            );
        }
    }

    /// An owner explaining a delivery process usually has it written down.
    /// Making them retype it destroys the thing that made the answer good.
    #[test]
    fn every_fact_accepts_links_and_documents() {
        for fact in REQUIRED_FACTS {
            assert!(fact.accepts.contains(&AnswerKind::Link), "{:?}", fact.id);
            assert!(fact.accepts.contains(&AnswerKind::File), "{:?}", fact.id);
        }
    }

    /// The whole reason this module exists: without a terminal state the agent
    /// re-asks forever.
    #[test]
    fn an_unknown_answer_is_terminal_and_never_asked_again() {
        assert!(FactState::Unknown.is_terminal());
        assert!(FactState::Answered.is_terminal());
        assert!(!FactState::Outstanding.is_terminal());

        let progress = answered_except(&[(FactId::TargetAudience, FactState::Unknown)]);
        assert!(
            onboarding_is_complete(&progress),
            "a fact the owner cannot answer must not block onboarding"
        );
    }

    /// A website often answers part of something — services listed without
    /// prices, work named without a process. That deserves a follow-up.
    #[test]
    fn a_partial_website_answer_earns_one_follow_up() {
        let progress = answered_except(&[(FactId::PricingPerService, FactState::Partial)]);
        let question = next_question(&progress).expect("a follow-up is due");

        assert_eq!(question.fact.id, FactId::PricingPerService);
        assert!(question.is_follow_up);
        // It builds on what is known rather than starting over.
        assert_eq!(question.prompt(), question.fact.follow_up_prompt);
        assert_ne!(question.prompt(), question.fact.prompt);
        assert!(!onboarding_is_complete(&progress));
    }

    /// The loop guard. An unbounded "is that everything?" is the same infinite
    /// interview, just slower.
    #[test]
    fn a_partial_answer_is_accepted_once_its_follow_up_budget_is_spent() {
        let mut progress = answered_except(&[(FactId::PricingPerService, FactState::Partial)]);
        for entry in &mut progress {
            if entry.id == FactId::PricingPerService {
                entry.follow_ups_asked = MAX_FOLLOW_UPS;
            }
        }

        assert!(
            onboarding_is_complete(&progress),
            "a still-partial answer must stop being asked about, not loop"
        );
        assert!(next_question(&progress).is_none());
    }

    /// What is still missing after the budget runs out is recorded, not chased.
    #[test]
    fn spent_partials_and_unknowns_both_become_blueprint_gaps() {
        let mut progress = answered_except(&[
            (FactId::PricingPerService, FactState::Partial),
            (FactId::TargetAudience, FactState::Unknown),
        ]);
        for entry in &mut progress {
            if entry.id == FactId::PricingPerService {
                entry.follow_ups_asked = MAX_FOLLOW_UPS;
            }
        }

        let gaps = outstanding_gaps(&progress);
        let ids: BTreeSet<FactId> = gaps.iter().map(|fact| fact.id).collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&FactId::PricingPerService));
        assert!(ids.contains(&FactId::TargetAudience));
        // Each gap carries the reason, so the Blueprint can explain the cost of
        // leaving it open rather than just listing a missing field.
        assert!(gaps.iter().all(|fact| !fact.why_it_matters.is_empty()));
    }

    /// A partial answer still being chased is not yet a gap.
    #[test]
    fn a_partial_answer_with_budget_left_is_not_yet_a_gap() {
        let progress = answered_except(&[(FactId::PricingPerService, FactState::Partial)]);
        assert!(outstanding_gaps(&progress).is_empty());
    }

    #[test]
    fn outstanding_facts_are_asked_in_dependency_order() {
        let first = next_question(&[]).expect("a first question");
        assert_eq!(first.fact.id, FactId::ServicesAndProducts);
        assert!(!first.is_follow_up, "nothing is known yet");
        assert_eq!(first.prompt(), first.fact.prompt);

        let second = next_question(&[FactProgress::new(
            FactId::ServicesAndProducts,
            FactState::Answered,
        )])
        .expect("a second question");
        assert_eq!(second.fact.id, FactId::WorkTypeAndProcess);
    }

    /// Making an owner retype what their own site says is the fastest way to
    /// lose them.
    #[test]
    fn facts_fully_answered_by_the_website_are_skipped() {
        let progress = [
            FactProgress::new(FactId::ServicesAndProducts, FactState::Answered),
            FactProgress::new(FactId::WorkTypeAndProcess, FactState::Answered),
            FactProgress::new(FactId::PricingPerService, FactState::Answered),
        ];
        let next = next_question(&progress).expect("more to ask");
        assert_eq!(next.fact.id, FactId::TargetAudience);
        assert!(!onboarding_is_complete(&progress));
    }

    #[test]
    fn an_empty_fact_set_is_never_treated_as_complete() {
        assert!(!onboarding_is_complete(&[]));
    }

    /// However the six are answered, the interview reaches an end.
    #[test]
    fn the_interview_terminates_from_any_starting_state() {
        for state in [
            FactState::Answered,
            FactState::Unknown,
            FactState::Partial,
            FactState::Outstanding,
        ] {
            let mut progress: Vec<FactProgress> =
                ALL.iter().map(|id| FactProgress::new(*id, state)).collect();

            // Simulate the agent working the queue: ask, record, repeat.
            let mut asked = 0;
            while let Some(question) = next_question(&progress) {
                asked += 1;
                assert!(asked <= 24, "interview did not terminate from {state:?}");
                for entry in &mut progress {
                    if entry.id != question.fact.id {
                        continue;
                    }
                    if question.is_follow_up {
                        entry.follow_ups_asked += 1;
                    } else {
                        entry.state = FactState::Answered;
                    }
                }
            }
            assert!(onboarding_is_complete(&progress));
        }
    }
}
