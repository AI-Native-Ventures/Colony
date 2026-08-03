//! Cross-checking agents' own account of their spend against the wire.
//!
//! The ledger's source of record is the metering checkpoint: what the
//! provider itemized on the response. Agents also publish their own per-turn
//! token counts (NIP-AM, `kind:44200`), and those are not used for money.
//!
//! They are useful for something else. Comparing the two answers a question
//! the ledger alone cannot: *did every call an agent made actually cross the
//! checkpoint?* An agent that reports more tokens than the wire observed made
//! calls the meter never saw, which is the signature of a real provider
//! credential reaching an agent. The reverse gap is benign by comparison: a
//! harness that publishes no metrics is under-reporting itself, not spending
//! outside the ledger.
//!
//! Two details decide whether this report is a signal or noise, and both are
//! easy to get wrong:
//!
//! 1. **NIP-AM `input_tokens` is cache-inclusive.** It counts cache reads and
//!    writes inside the input figure, while the wire breakdown itemizes them
//!    separately. Comparing NIP-AM input against the wire's *uncached* input
//!    would report drift on every cached call, i.e. on almost all of them.
//! 2. **An unreliable delta must not be summed.** When a harness restarts
//!    mid-session it loses the cumulative baseline and flags the turn
//!    `deltaReliable: false`. Adding those turns produces drift that is an
//!    artifact of the restart. They are excluded and counted, so the report
//!    can say how much of the comparison it had to skip.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::engine::StoredUsageRecord;
use crate::usage_record::UsageSource;

/// One agent-reported turn, reduced to what the comparison needs.
///
/// Built by the caller from a decrypted NIP-AM payload: the event's author is
/// the agent, and `turn` (never `cumulative`) carries the per-turn delta.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfReportedTurn {
    /// Hex pubkey of the agent that published the metric.
    pub agent_pubkey: String,
    /// UTC day in `YYYY-MM-DD` form, from the payload timestamp.
    pub day: String,
    /// Input tokens the agent claims, cache reads and writes included.
    pub input_tokens: u64,
    /// Output tokens the agent claims.
    pub output_tokens: u64,
    /// False when the harness could not observe its previous baseline, which
    /// makes this turn's delta untrustworthy.
    pub delta_reliable: bool,
}

/// What each side counted for one agent on one day.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossCheckRow {
    /// Hex pubkey of the agent.
    pub agent_pubkey: String,
    /// UTC day in `YYYY-MM-DD` form.
    pub day: String,
    /// Input tokens the checkpoint observed, cache reads and writes included
    /// so the figure is comparable with what an agent reports.
    pub wire_input_tokens: u64,
    /// Output tokens the checkpoint observed.
    pub wire_output_tokens: u64,
    /// Input tokens the agent reported across reliable turns.
    pub reported_input_tokens: u64,
    /// Output tokens the agent reported across reliable turns.
    pub reported_output_tokens: u64,
    /// Turns skipped because the agent flagged the delta unreliable.
    pub skipped_unreliable_turns: u64,
}

impl CrossCheckRow {
    /// Total tokens the checkpoint observed.
    pub fn wire_total(&self) -> u64 {
        self.wire_input_tokens
            .saturating_add(self.wire_output_tokens)
    }

    /// Total tokens the agent reported.
    pub fn reported_total(&self) -> u64 {
        self.reported_input_tokens
            .saturating_add(self.reported_output_tokens)
    }
}

/// A disagreement worth a human's attention.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum CrossCheckFinding {
    /// The agent reported more than the checkpoint saw.
    ///
    /// The serious direction: tokens it claims to have spent did not cross
    /// the meter, so a credential that bypasses the checkpoint is the first
    /// thing to look for.
    ReportedAboveWire {
        /// Hex pubkey of the agent.
        agent_pubkey: String,
        /// UTC day.
        day: String,
        /// Tokens the checkpoint observed.
        wire_tokens: u64,
        /// Tokens the agent reported.
        reported_tokens: u64,
    },
    /// The checkpoint saw more than the agent reported.
    ///
    /// Usually a harness that publishes metrics partially or not at all. The
    /// money is still counted: the wire is the source of record.
    WireAboveReported {
        /// Hex pubkey of the agent.
        agent_pubkey: String,
        /// UTC day.
        day: String,
        /// Tokens the checkpoint observed.
        wire_tokens: u64,
        /// Tokens the agent reported.
        reported_tokens: u64,
    },
    /// An agent published metrics for a day on which the checkpoint observed
    /// nothing at all from it.
    ///
    /// The strongest form of [`Self::ReportedAboveWire`]: not a shortfall but
    /// a complete absence, so every call that agent made that day went
    /// somewhere the ledger cannot see.
    NoWireRecords {
        /// Hex pubkey of the agent.
        agent_pubkey: String,
        /// UTC day.
        day: String,
        /// Tokens the agent reported.
        reported_tokens: u64,
    },
}

/// The comparison, per agent-day, with the disagreements called out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossCheckReport {
    /// Every agent-day either side knew about, ordered by agent then day.
    pub rows: Vec<CrossCheckRow>,
    /// Disagreements past the tolerance, most serious first.
    pub findings: Vec<CrossCheckFinding>,
    /// Turns excluded because the agent flagged the delta unreliable.
    pub skipped_unreliable_turns: u64,
}

/// Key for one agent's activity on one day.
type AgentDay = (String, String);

/// Sum a record's input tokens the way an agent counts them.
///
/// Cache reads and writes are input tokens that a provider prices
/// differently; NIP-AM folds them into one input figure. Comparing like with
/// like means folding them here too.
fn wire_input_tokens(record: &StoredUsageRecord) -> u64 {
    let Some(tokens) = record.payload.tokens.as_ref() else {
        return 0;
    };
    tokens
        .input_uncached_tokens
        .saturating_add(tokens.cache_read_tokens)
        .saturating_add(tokens.cache_write_5m_tokens)
        .saturating_add(tokens.cache_write_1h_tokens)
}

fn wire_output_tokens(record: &StoredUsageRecord) -> u64 {
    record
        .payload
        .tokens
        .as_ref()
        .map_or(0, |tokens| tokens.output_tokens)
}

/// Whether a difference is big enough to report.
///
/// Relative, with an absolute floor. A handful of tokens' difference between
/// two counting methods is not evidence of anything, and reporting it on
/// every agent-day would bury the case that matters.
fn beyond_tolerance(left: u64, right: u64, tolerance_bps: u32, floor_tokens: u64) -> bool {
    let gap = left.abs_diff(right);
    if gap <= floor_tokens {
        return false;
    }
    let larger = left.max(right);
    if larger == 0 {
        return false;
    }
    let allowed = (u128::from(larger) * u128::from(tolerance_bps)) / 10_000;
    u128::from(gap) > allowed
}

/// Compare what agents said they spent against what the checkpoint observed.
///
/// `tolerance_bps` is a relative allowance in basis points (100 = 1%) and
/// `floor_tokens` an absolute one; a gap must exceed both to be reported.
///
/// Only wire-sourced records are compared. A manual record is the owner
/// entering a cost by hand, which no agent ever claimed and which would
/// otherwise read as the agent under-reporting.
pub fn cross_check(
    wire_records: &[StoredUsageRecord],
    self_reports: &[SelfReportedTurn],
    tolerance_bps: u32,
    floor_tokens: u64,
) -> CrossCheckReport {
    let mut wire: BTreeMap<AgentDay, (u64, u64)> = BTreeMap::new();
    for record in wire_records {
        if record.payload.source != UsageSource::Wire {
            continue;
        }
        // A record with no agent attached cannot be checked against any
        // agent's account of itself.
        let Some(agent) = record.payload.agent_pubkey.as_ref() else {
            continue;
        };
        let day = super::engine::utc_day_for(record);
        let entry = wire.entry((agent.clone(), day)).or_default();
        entry.0 = entry.0.saturating_add(wire_input_tokens(record));
        entry.1 = entry.1.saturating_add(wire_output_tokens(record));
    }

    let mut reported: BTreeMap<AgentDay, (u64, u64, u64)> = BTreeMap::new();
    let mut skipped_unreliable_turns = 0u64;
    for turn in self_reports {
        let key = (turn.agent_pubkey.clone(), turn.day.clone());
        let entry = reported.entry(key).or_default();
        if !turn.delta_reliable {
            entry.2 = entry.2.saturating_add(1);
            skipped_unreliable_turns = skipped_unreliable_turns.saturating_add(1);
            continue;
        }
        entry.0 = entry.0.saturating_add(turn.input_tokens);
        entry.1 = entry.1.saturating_add(turn.output_tokens);
    }

    let mut keys: Vec<AgentDay> = wire.keys().cloned().collect();
    keys.extend(reported.keys().cloned());
    keys.sort();
    keys.dedup();

    let mut rows = Vec::with_capacity(keys.len());
    let mut findings = Vec::new();
    for key in keys {
        let (wire_input, wire_output) = wire.get(&key).copied().unwrap_or((0, 0));
        let (reported_input, reported_output, skipped) =
            reported.get(&key).copied().unwrap_or((0, 0, 0));
        let row = CrossCheckRow {
            agent_pubkey: key.0.clone(),
            day: key.1.clone(),
            wire_input_tokens: wire_input,
            wire_output_tokens: wire_output,
            reported_input_tokens: reported_input,
            reported_output_tokens: reported_output,
            skipped_unreliable_turns: skipped,
        };

        let wire_total = row.wire_total();
        let reported_total = row.reported_total();
        if reported_total > 0 && wire_total == 0 {
            findings.push(CrossCheckFinding::NoWireRecords {
                agent_pubkey: key.0.clone(),
                day: key.1.clone(),
                reported_tokens: reported_total,
            });
        } else if beyond_tolerance(wire_total, reported_total, tolerance_bps, floor_tokens) {
            if reported_total > wire_total {
                findings.push(CrossCheckFinding::ReportedAboveWire {
                    agent_pubkey: key.0.clone(),
                    day: key.1.clone(),
                    wire_tokens: wire_total,
                    reported_tokens: reported_total,
                });
            } else {
                findings.push(CrossCheckFinding::WireAboveReported {
                    agent_pubkey: key.0.clone(),
                    day: key.1.clone(),
                    wire_tokens: wire_total,
                    reported_tokens: reported_total,
                });
            }
        }
        rows.push(row);
    }

    // Most serious first: an absent wire trail, then a shortfall, then the
    // benign direction.
    findings.sort_by_key(|finding| match finding {
        CrossCheckFinding::NoWireRecords { .. } => 0,
        CrossCheckFinding::ReportedAboveWire { .. } => 1,
        CrossCheckFinding::WireAboveReported { .. } => 2,
    });

    CrossCheckReport {
        rows,
        findings,
        skipped_unreliable_turns,
    }
}

/// What a finding most likely means, and what to do about it.
pub fn diagnose(finding: &CrossCheckFinding) -> &'static str {
    match finding {
        CrossCheckFinding::NoWireRecords { .. } => {
            "the agent reported work the checkpoint never saw at all: every call it made that day \
             went straight to a provider, so it is holding a real credential rather than its \
             virtual key. Check how that agent was spawned and whether a provider key is set in \
             its environment."
        }
        CrossCheckFinding::ReportedAboveWire { .. } => {
            "the agent reported more tokens than crossed the checkpoint, so some of its calls \
             bypassed metering and their cost is missing from the ledger. A real provider \
             credential reaching the agent is the usual cause."
        }
        CrossCheckFinding::WireAboveReported { .. } => {
            "the checkpoint observed more than the agent reported. The money is counted correctly \
             either way; this usually means the harness publishes turn metrics partially or not \
             at all."
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage_record::{PaymentMode, UsageBreakdown, UsageRecordPayload};

    const AGENT: &str = "aa";
    const DAY: &str = "2026-08-03";

    fn wire_record(
        event_id: &str,
        agent: Option<&str>,
        breakdown: UsageBreakdown,
    ) -> StoredUsageRecord {
        StoredUsageRecord {
            event_id: event_id.to_string(),
            created_at: 1_785_628_800,
            payload: UsageRecordPayload {
                source: UsageSource::Wire,
                provider: "anthropic".to_string(),
                request_id: format!("req-{event_id}"),
                model: Some("claude-sonnet-4-5".to_string()),
                timestamp: "2026-08-03T10:00:00Z".to_string(),
                payment_mode: PaymentMode::Metered,
                tokens: Some(breakdown),
                amount_nanousd: None,
                harness: None,
                session_id: None,
                turn_id: None,
                http_status: Some(200),
                description: None,
                agent_pubkey: agent.map(str::to_string),
                channel_id: None,
                work_context: None,
            },
        }
    }

    fn breakdown(uncached: u64, cache_read: u64, output: u64) -> UsageBreakdown {
        UsageBreakdown {
            input_uncached_tokens: uncached,
            cache_read_tokens: cache_read,
            cache_write_5m_tokens: 0,
            cache_write_1h_tokens: 0,
            output_tokens: output,
        }
    }

    fn turn(input: u64, output: u64, delta_reliable: bool) -> SelfReportedTurn {
        SelfReportedTurn {
            agent_pubkey: AGENT.to_string(),
            day: DAY.to_string(),
            input_tokens: input,
            output_tokens: output,
            delta_reliable,
        }
    }

    /// The comparison folds cache tokens into the wire's input figure,
    /// because NIP-AM counts them inside its own. Comparing against uncached
    /// input alone would report drift on every cached call.
    #[test]
    fn cached_input_is_counted_the_way_an_agent_counts_it() {
        // Wire: 100 uncached + 900 cache read = 1000 input, 50 output.
        // Agent reports 1000 input, 50 output. These agree.
        let report = cross_check(
            &[wire_record("e1", Some(AGENT), breakdown(100, 900, 50))],
            &[turn(1_000, 50, true)],
            100,
            10,
        );
        assert_eq!(report.rows[0].wire_input_tokens, 1_000);
        assert!(
            report.findings.is_empty(),
            "cache-inclusive input must agree, got {:?}",
            report.findings
        );
    }

    /// An unreliable delta is excluded, not summed.
    ///
    /// Written as the failure it prevents: the unreliable turn's tokens would
    /// double the reported total and manufacture a finding.
    #[test]
    fn an_unreliable_turn_is_skipped_rather_than_summed() {
        let report = cross_check(
            &[wire_record("e1", Some(AGENT), breakdown(1_000, 0, 50))],
            &[turn(1_000, 50, true), turn(1_000, 50, false)],
            100,
            10,
        );
        assert_eq!(report.rows[0].reported_input_tokens, 1_000);
        assert_eq!(report.skipped_unreliable_turns, 1);
        assert_eq!(report.rows[0].skipped_unreliable_turns, 1);
        assert!(
            report.findings.is_empty(),
            "an excluded turn must not create drift, got {:?}",
            report.findings
        );
    }

    /// The serious direction: tokens claimed that never crossed the meter.
    #[test]
    fn reporting_more_than_the_wire_saw_is_flagged() {
        let report = cross_check(
            &[wire_record("e1", Some(AGENT), breakdown(100, 0, 10))],
            &[turn(5_000, 500, true)],
            100,
            10,
        );
        assert!(matches!(
            report.findings.as_slice(),
            [CrossCheckFinding::ReportedAboveWire {
                wire_tokens: 110,
                reported_tokens: 5_500,
                ..
            }]
        ));
        assert!(diagnose(&report.findings[0]).contains("bypassed metering"));
    }

    /// An agent with metrics but no wire trail at all is the strongest case.
    #[test]
    fn an_agent_with_no_wire_records_at_all_is_the_most_serious_finding() {
        let report = cross_check(&[], &[turn(5_000, 500, true)], 100, 10);
        assert!(matches!(
            report.findings.as_slice(),
            [CrossCheckFinding::NoWireRecords {
                reported_tokens: 5_500,
                ..
            }]
        ));
        assert!(diagnose(&report.findings[0]).contains("real credential"));
    }

    /// A harness that publishes nothing is under-reporting itself, not
    /// spending outside the ledger, so it sorts below the serious cases.
    #[test]
    fn findings_are_ordered_most_serious_first() {
        let other = "bb";
        let quiet = "cc";
        let mut reports = vec![turn(5_000, 0, true)];
        reports.push(SelfReportedTurn {
            agent_pubkey: other.to_string(),
            day: DAY.to_string(),
            input_tokens: 9_000,
            output_tokens: 0,
            delta_reliable: true,
        });
        let report = cross_check(
            &[
                wire_record("e1", Some(AGENT), breakdown(100, 0, 0)),
                wire_record("e2", Some(other), breakdown(10, 0, 0)),
                wire_record("e3", Some(quiet), breakdown(9_000, 0, 0)),
            ],
            &reports,
            100,
            10,
        );
        let kinds: Vec<&str> = report
            .findings
            .iter()
            .map(|finding| match finding {
                CrossCheckFinding::NoWireRecords { .. } => "absent",
                CrossCheckFinding::ReportedAboveWire { .. } => "over",
                CrossCheckFinding::WireAboveReported { .. } => "under",
            })
            .collect();
        assert_eq!(kinds, vec!["over", "over", "under"]);
    }

    /// A manual record is the owner entering a cost by hand. No agent ever
    /// claimed it, so counting it would read as the agent under-reporting.
    #[test]
    fn a_manual_record_is_left_out_of_the_comparison() {
        let mut manual = wire_record("e1", Some(AGENT), breakdown(9_000, 0, 0));
        manual.payload.source = UsageSource::Manual;
        let report = cross_check(&[manual], &[turn(0, 0, true)], 100, 10);
        assert_eq!(report.rows[0].wire_input_tokens, 0);
        assert!(report.findings.is_empty());
    }

    /// A record the checkpoint could not bind to an agent cannot be checked
    /// against any agent's account of itself.
    #[test]
    fn a_record_without_an_agent_is_left_out() {
        let report = cross_check(
            &[wire_record("e1", None, breakdown(9_000, 0, 0))],
            &[],
            100,
            10,
        );
        assert!(report.rows.is_empty());
        assert!(report.findings.is_empty());
    }

    /// Small differences between two counting methods are not evidence.
    #[test]
    fn a_difference_within_tolerance_is_not_reported() {
        let report = cross_check(
            &[wire_record("e1", Some(AGENT), breakdown(10_000, 0, 0))],
            &[turn(10_050, 0, true)],
            100,
            10,
        );
        assert!(report.findings.is_empty());

        // Both the relative and the absolute allowance must be exceeded, so a
        // tiny absolute gap stays quiet even when it is a large proportion.
        let tiny = cross_check(
            &[wire_record("e2", Some(AGENT), breakdown(5, 0, 0))],
            &[turn(12, 0, true)],
            100,
            10,
        );
        assert!(tiny.findings.is_empty());
    }
}
