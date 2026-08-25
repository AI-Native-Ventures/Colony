//! Attribution rules, owner corrections, and budgets.
//!
//! A usage record that arrives without an explicit work context still has to
//! land somewhere. Rules answer "whose cost was this?" from what the wire
//! observed. Corrections let the owner move a record afterwards without ever
//! touching the record itself, so the original evidence survives the fix.

use serde::{Deserialize, Serialize};

use crate::company::CommercialPurpose;
use crate::usage_record::UsageRecordPayload;

/// What a rule or correction assigns to a usage record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleAssignment {
    /// Company charged.
    pub company_id: String,
    /// Cost centre charged.
    pub cost_centre_id: String,
    /// Team accountable.
    pub owning_team_id: String,
    /// Commercial reason for the work.
    pub commercial_purpose: CommercialPurpose,
    /// Client receiving the work, when this is client delivery.
    pub client_organization_id: Option<String>,
    /// Task the work belonged to, when known.
    pub task_id: Option<String>,
}

/// A rule matches when every matcher it sets equals the record's field.
///
/// Unset matchers are wildcards. Higher `priority` wins; among equal
/// priorities the earliest appended rule wins, so adding a rule can never
/// silently re-route work an existing rule already claimed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttributionRule {
    /// Stable rule identifier, unique within the book.
    pub id: String,
    /// Higher wins.
    pub priority: u32,
    /// Match the provider slug.
    pub match_provider: Option<String>,
    /// Match the harness that spawned the agent.
    pub match_harness: Option<String>,
    /// Match the agent's hex pubkey.
    pub match_agent_pubkey: Option<String>,
    /// Match the channel the turn served.
    pub match_channel_id: Option<String>,
    /// Match the model.
    pub match_model: Option<String>,
    /// What to assign when this rule wins.
    pub assign: RuleAssignment,
}

impl AttributionRule {
    fn matches(&self, record: &UsageRecordPayload) -> bool {
        fn ok(matcher: &Option<String>, value: Option<&str>) -> bool {
            match matcher {
                None => true,
                Some(expected) => value == Some(expected.as_str()),
            }
        }
        ok(&self.match_provider, Some(record.provider.as_str()))
            && ok(&self.match_harness, record.harness.as_deref())
            && ok(&self.match_model, record.model.as_deref())
            && ok(&self.match_agent_pubkey, record.agent_pubkey.as_deref())
            && ok(&self.match_channel_id, record.channel_id.as_deref())
    }
}

/// Ordered rule set; content of the `d=rulebook` head. Append-only.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rulebook {
    /// Every rule ever published, in publication order.
    pub rules: Vec<AttributionRule>,
}

impl Rulebook {
    /// Highest-priority matching rule; ties resolve to the earliest appended.
    ///
    /// Written as an explicit loop rather than an iterator `max_by`: the
    /// tie-break direction is the whole contract here and is easy to invert
    /// by accident.
    pub fn best_match(&self, record: &UsageRecordPayload) -> Option<&AttributionRule> {
        let mut best: Option<&AttributionRule> = None;
        for rule in self.rules.iter().filter(|r| r.matches(record)) {
            match best {
                None => best = Some(rule),
                Some(current) if rule.priority > current.priority => best = Some(rule),
                Some(_) => {}
            }
        }
        best
    }

    /// Append-only check: `new` must begin with exactly `old`'s rules.
    pub fn extends(old: &Rulebook, new: &Rulebook) -> bool {
        new.rules.len() >= old.rules.len() && new.rules[..old.rules.len()] == old.rules[..]
    }
}

/// One owner correction: re-attributes a single usage record.
///
/// The record is never modified. The engine applies corrections last and
/// keeps both the original and corrected classification on the ledger entry,
/// so a correction adds evidence rather than replacing it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Correction {
    /// Stable correction identifier, unique within the book.
    pub id: String,
    /// Hex event id of the `kind:44210` record being corrected.
    pub usage_record_event_id: String,
    /// The attribution that should apply instead.
    pub assign: RuleAssignment,
    /// Why the owner moved it. Required: a correction without a reason is an
    /// unexplained restatement.
    pub reason: String,
    /// Unix seconds the correction was made.
    pub corrected_at: u64,
}

/// Append-only correction log; content of the `d=corrections` head.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorrectionBook {
    /// Every correction ever published, in publication order.
    pub corrections: Vec<Correction>,
}

impl CorrectionBook {
    /// Append-only check: `new` must begin with exactly `old`'s corrections.
    pub fn extends(old: &CorrectionBook, new: &CorrectionBook) -> bool {
        new.corrections.len() >= old.corrections.len()
            && new.corrections[..old.corrections.len()] == old.corrections[..]
    }
}

/// A spending limit for one cost centre over one month.
///
/// Content of a `d={cost_centre_id}:{period}` head, where `period` is
/// `YYYY-MM`. Unlike the books, a budget head is last-write-wins: it states
/// the current limit, and the relay event store keeps the history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    /// Cost centre this limit applies to.
    pub cost_centre_id: String,
    /// Month in `YYYY-MM` form.
    pub period: String,
    /// Limit in nanoUSD.
    pub amount_nanousd: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::company::CommercialPurpose;
    use crate::usage_record::{PaymentMode, UsageBreakdown, UsageRecordPayload, UsageSource};

    fn record(model: &str, harness: Option<&str>) -> UsageRecordPayload {
        UsageRecordPayload {
            source: UsageSource::Wire,
            provider: "anthropic".to_string(),
            request_id: "req_1".to_string(),
            model: Some(model.to_string()),
            timestamp: "2026-08-02T10:00:00Z".to_string(),
            payment_mode: PaymentMode::Metered,
            tokens: Some(UsageBreakdown {
                input_uncached_tokens: 1,
                cache_read_tokens: 0,
                cache_write_5m_tokens: 0,
                cache_write_1h_tokens: 0,
                output_tokens: 1,
            }),
            unknown_token_fields: Vec::new(),
            amount_nanousd: None,
            observed_cost_nanousd: None,
            harness: harness.map(str::to_string),
            session_id: None,
            turn_id: None,
            http_status: Some(200),
            description: None,
            agent_pubkey: None,
            channel_id: None,
            work_context: None,
        }
    }

    fn assignment(centre: &str, purpose: CommercialPurpose) -> RuleAssignment {
        RuleAssignment {
            company_id: "horizon-labs".to_string(),
            cost_centre_id: centre.to_string(),
            owning_team_id: "web-team".to_string(),
            commercial_purpose: purpose,
            client_organization_id: None,
            task_id: None,
        }
    }

    fn rule(id: &str, priority: u32) -> AttributionRule {
        AttributionRule {
            id: id.to_string(),
            priority,
            match_provider: None,
            match_harness: None,
            match_agent_pubkey: None,
            match_channel_id: None,
            match_model: None,
            assign: assignment("internal-ops", CommercialPurpose::Administration),
        }
    }

    #[test]
    fn best_match_requires_all_set_matchers_and_prefers_priority() {
        let rules = Rulebook {
            rules: vec![
                AttributionRule {
                    match_provider: Some("anthropic".to_string()),
                    ..rule("any-anthropic", 1)
                },
                AttributionRule {
                    match_provider: Some("anthropic".to_string()),
                    match_harness: Some("goose".to_string()),
                    match_model: Some("claude-sonnet-4-5".to_string()),
                    assign: assignment("web-delivery", CommercialPurpose::Sales),
                    ..rule("goose-sonnet", 10)
                },
            ],
        };
        let hit = rules
            .best_match(&record("claude-sonnet-4-5", Some("goose")))
            .unwrap();
        assert_eq!(
            hit.id, "goose-sonnet",
            "higher priority wins when both match"
        );

        let fallback = rules
            .best_match(&record("claude-haiku-4-5", Some("goose")))
            .unwrap();
        assert_eq!(
            fallback.id, "any-anthropic",
            "a model mismatch drops the specific rule"
        );

        let mut other_provider = record("gpt-5.6", None);
        other_provider.provider = "openai".to_string();
        assert!(rules.best_match(&other_provider).is_none());
    }

    #[test]
    fn equal_priority_earliest_rule_wins() {
        let rules = Rulebook {
            rules: vec![rule("first", 5), rule("second", 5)],
        };
        assert_eq!(rules.best_match(&record("m", None)).unwrap().id, "first");
    }

    #[test]
    fn agent_and_channel_matchers_filter() {
        let rules = Rulebook {
            rules: vec![AttributionRule {
                match_channel_id: Some("chan-a".to_string()),
                match_agent_pubkey: Some("ab".repeat(32)),
                ..rule("scoped", 1)
            }],
        };

        let mut unscoped = record("m", None);
        assert!(
            rules.best_match(&unscoped).is_none(),
            "a record with no channel must not match a channel-scoped rule"
        );

        unscoped.channel_id = Some("chan-a".to_string());
        assert!(
            rules.best_match(&unscoped).is_none(),
            "channel alone is not enough while the agent matcher is unmet"
        );

        unscoped.agent_pubkey = Some("ab".repeat(32));
        assert_eq!(rules.best_match(&unscoped).unwrap().id, "scoped");

        unscoped.channel_id = Some("chan-b".to_string());
        assert!(rules.best_match(&unscoped).is_none());
    }

    #[test]
    fn books_are_append_only() {
        let old = Rulebook { rules: vec![] };
        let one = Rulebook {
            rules: vec![rule("r", 1)],
        };
        assert!(Rulebook::extends(&old, &one));
        assert!(!Rulebook::extends(&one, &old));

        let mutated = Rulebook {
            rules: vec![rule("r", 99)],
        };
        assert!(
            !Rulebook::extends(&one, &mutated),
            "rewriting a published rule must be rejected"
        );

        let empty = CorrectionBook {
            corrections: vec![],
        };
        let with_one = CorrectionBook {
            corrections: vec![Correction {
                id: "c1".to_string(),
                usage_record_event_id: "e".repeat(64),
                assign: assignment("web-delivery", CommercialPurpose::ClientDelivery),
                reason: "was client work for tennant".to_string(),
                corrected_at: 1_700_000_000,
            }],
        };
        assert!(CorrectionBook::extends(&empty, &with_one));
        assert!(!CorrectionBook::extends(&with_one, &empty));
    }
}
