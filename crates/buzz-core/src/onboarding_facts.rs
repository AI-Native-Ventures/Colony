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
    /// The owner answered, or the website already told us.
    Answered,
    /// The owner said they do not know. Terminal — never asked again.
    Unknown,
}

impl FactState {
    /// Whether this fact is finished with, either way.
    ///
    /// The single rule that makes the interview terminate.
    pub const fn is_resolved(self) -> bool {
        matches!(self, Self::Answered | Self::Unknown)
    }
}

/// One required fact and why it is worth asking about.
#[derive(Debug, Clone, Copy)]
pub struct RequiredFact {
    /// Stable identifier, used by Interview blocks and answer receipts.
    pub id: FactId,
    /// Short label for the Blueprint and gap lists.
    pub label: &'static str,
    /// The question as an owner would be asked it.
    pub prompt: &'static str,
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
        why_it_matters: "Each one becomes a service the company can be paid for, and its own cost centre, so profit can be told apart per service rather than only in total.",
        accepts: EVERY_FORM,
    },
    RequiredFact {
        id: FactId::WorkTypeAndProcess,
        label: "Type of work and process",
        prompt: "Walk me through how the work actually gets done, from a client saying yes to the work being delivered. Rough steps are fine, and a link or document is better than retyping it.",
        why_it_matters: "This is what the agent team has to reproduce. Without the real steps I can only invent a generic process, and the teams I propose would not match how the business works.",
        accepts: EVERY_FORM,
    },
    RequiredFact {
        id: FactId::PricingPerService,
        label: "Pricing per service",
        prompt: "What does each service or product cost, and is it one-off or recurring?",
        why_it_matters: "Without a price per service, work can be tracked but never told apart as profitable or unprofitable.",
        accepts: EVERY_FORM,
    },
    RequiredFact {
        id: FactId::TargetAudience,
        label: "Target audience",
        prompt: "Who is this for? Industry, size, and where they are, as far as you know.",
        why_it_matters: "Decides who the company looks for when it goes hunting for customers. It is fine not to know yet.",
        accepts: EVERY_FORM,
    },
    RequiredFact {
        id: FactId::Location,
        label: "Where the business is based",
        prompt: "Where is the business based, and where do its customers tend to be?",
        why_it_matters: "Sets currency, tax and invoicing expectations, working hours for outreach, and which legal obligations are worth flagging.",
        accepts: EVERY_FORM,
    },
    RequiredFact {
        id: FactId::TeamAndCapacity,
        label: "Who does the work today",
        prompt: "Who does this work at the moment, and roughly how much can they take on?",
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

/// The next fact worth asking about, or `None` when onboarding may proceed.
///
/// Takes resolved state rather than answers so a fact the website already
/// established is never asked about — the owner should not be made to retype
/// something their own site said.
pub fn next_outstanding(resolved: &[(FactId, FactState)]) -> Option<&'static RequiredFact> {
    REQUIRED_FACTS.iter().find(|fact| {
        !resolved
            .iter()
            .any(|(id, state)| *id == fact.id && state.is_resolved())
    })
}

/// Whether every required fact has been settled one way or the other.
pub fn onboarding_is_complete(resolved: &[(FactId, FactState)]) -> bool {
    next_outstanding(resolved).is_none()
}

/// Facts the owner said they do not know, for the Blueprint's gap list.
///
/// Recorded rather than discarded: an unknown is a real finding about the
/// business, and the company can revisit it once it has evidence.
pub fn unknown_facts(resolved: &[(FactId, FactState)]) -> Vec<&'static RequiredFact> {
    resolved
        .iter()
        .filter(|(_, state)| *state == FactState::Unknown)
        .map(|(id, _)| required_fact(*id))
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
    fn every_fact_states_a_prompt_and_a_consequence() {
        for fact in REQUIRED_FACTS {
            assert!(!fact.label.trim().is_empty(), "{:?} needs a label", fact.id);
            assert!(fact.prompt.len() > 20, "{:?} needs a real prompt", fact.id);
            assert!(
                fact.why_it_matters.len() > 30,
                "{:?} must say what it changes",
                fact.id
            );
        }
    }

    /// An owner explaining a delivery process usually has it written down.
    /// Making them retype it destroys the thing that made the answer good.
    #[test]
    fn every_fact_accepts_links_and_documents() {
        for fact in REQUIRED_FACTS {
            assert!(
                fact.accepts.contains(&AnswerKind::Link),
                "{:?} must accept a link",
                fact.id
            );
            assert!(
                fact.accepts.contains(&AnswerKind::File),
                "{:?} must accept a document",
                fact.id
            );
        }
    }

    /// The whole reason this module exists: without a terminal state the agent
    /// re-asks forever.
    #[test]
    fn an_unknown_answer_is_terminal_and_never_asked_again() {
        assert!(FactState::Unknown.is_resolved());
        assert!(FactState::Answered.is_resolved());
        assert!(!FactState::Outstanding.is_resolved());

        let resolved: Vec<(FactId, FactState)> = ALL
            .iter()
            .map(|id| {
                let state = if *id == FactId::TargetAudience {
                    FactState::Unknown
                } else {
                    FactState::Answered
                };
                (*id, state)
            })
            .collect();

        assert!(
            onboarding_is_complete(&resolved),
            "a fact the owner cannot answer must not block onboarding"
        );
        assert!(next_outstanding(&resolved).is_none());
    }

    #[test]
    fn outstanding_facts_are_asked_in_dependency_order() {
        // Nothing resolved: what the business sells comes first, because the
        // roster and cost model both hang off it.
        let first = next_outstanding(&[]).expect("a first question");
        assert_eq!(first.id, FactId::ServicesAndProducts);

        let after_services =
            next_outstanding(&[(FactId::ServicesAndProducts, FactState::Answered)])
                .expect("a second question");
        assert_eq!(after_services.id, FactId::WorkTypeAndProcess);
    }

    /// A fact the website already established must not be asked about. Making
    /// an owner retype what their own site says is the fastest way to lose them.
    #[test]
    fn facts_answered_by_the_website_are_skipped() {
        let resolved = [
            (FactId::ServicesAndProducts, FactState::Answered),
            (FactId::WorkTypeAndProcess, FactState::Answered),
            (FactId::PricingPerService, FactState::Answered),
        ];
        let next = next_outstanding(&resolved).expect("more to ask");
        assert_eq!(next.id, FactId::TargetAudience);
        assert!(!onboarding_is_complete(&resolved));
    }

    /// An unknown is a real finding about the business, not an absence of one.
    #[test]
    fn unknown_facts_are_kept_for_the_blueprint_gap_list() {
        let resolved = [
            (FactId::ServicesAndProducts, FactState::Answered),
            (FactId::PricingPerService, FactState::Unknown),
            (FactId::TargetAudience, FactState::Unknown),
        ];
        let unknown = unknown_facts(&resolved);

        assert_eq!(unknown.len(), 2);
        let ids: BTreeSet<FactId> = unknown.iter().map(|fact| fact.id).collect();
        assert!(ids.contains(&FactId::PricingPerService));
        assert!(ids.contains(&FactId::TargetAudience));
        // The gap carries its reason, so the Blueprint can explain the cost of
        // leaving it open rather than just listing a missing field.
        assert!(unknown.iter().all(|fact| !fact.why_it_matters.is_empty()));
    }

    #[test]
    fn an_empty_fact_set_is_never_treated_as_complete() {
        assert!(!onboarding_is_complete(&[]));
    }
}
