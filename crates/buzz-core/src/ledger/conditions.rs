//! When a price applies, beyond the date it took effect.
//!
//! A price book that carries one rate per model per effective date can only
//! describe a vendor whose price depends on nothing but the calendar. No
//! major vendor is that vendor. Reading their published price pages in
//! August 2026:
//!
//! | Vendor | Variation | Size |
//! |---|---|---|
//! | OpenAI | short vs long context, two full rate columns | 2x |
//! | OpenAI | Batch / Flex service tiers | 0.5x |
//! | OpenAI | Fast mode (was Priority) | 2.5x |
//! | Anthropic | Batch API | 0.5x |
//! | Anthropic | Fast mode on Opus 5 / 4.8 | 2x |
//! | Anthropic | US-only inference (`inference_geo`) | 1.1x |
//! | DeepSeek | peak hours, 09:00-12:00 and 14:00-18:00 UTC+8 | 2x |
//!
//! Every one of those is a *conditional* rate, and every one is a silent
//! mispricing if the book cannot express it. The long-context case is the
//! sharpest: `gpt-5.6-sol` is $5 per million input tokens short and $10
//! long, so a book with only the short rate understates a long call by half
//! and nothing about the result looks wrong.
//!
//! So an entry carries conditions, and pricing picks the most specific entry
//! whose conditions the call satisfies. An entry with no conditions matches
//! every call, which is what every row written before this did, so books
//! already published keep behaving exactly as they did.
//!
//! # What a condition may test
//!
//! Only things observable at the wire checkpoint, because the ledger's whole
//! premise is that it does not take an agent's word for what it spent. Token
//! counts and the call's timestamp come from the provider's own response.
//! The service tier is reported by the provider too, but the meter has to
//! record it: see [`CallFacts::tier`].

use serde::{Deserialize, Serialize};

/// Minutes in a day, for window arithmetic.
const MINUTES_PER_DAY: u32 = 24 * 60;

/// A recurring daily window in the vendor's own local time.
///
/// Vendors publish these in their own timezone (DeepSeek's peak hours are
/// Beijing time), so the offset is part of the window rather than assumed.
/// Storing the offset instead of a timezone name keeps this free of a
/// timezone database, at the cost of not following daylight saving. Vendors
/// that publish windows so far do so in zones without it; a vendor that
/// changes with DST needs two entries, and that is worth saying out loud
/// rather than getting silently wrong twice a year.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyWindow {
    /// Minutes past local midnight, inclusive.
    pub start_minute: u32,
    /// Minutes past local midnight, exclusive.
    pub end_minute: u32,
    /// Minutes to add to UTC to reach the vendor's local time. Beijing is
    /// `480`.
    pub utc_offset_minutes: i32,
}

impl DailyWindow {
    /// Whether `at_unix` falls inside this window.
    ///
    /// A window whose end is at or before its start wraps midnight, which is
    /// how an overnight discount is written.
    pub fn contains(&self, at_unix: u64) -> bool {
        let day_minute = self.local_day_minute(at_unix);
        if self.start_minute < self.end_minute {
            day_minute >= self.start_minute && day_minute < self.end_minute
        } else {
            // Wraps midnight: 22:00-06:00 is "at or after 22:00, or before
            // 06:00". Written as a single window rather than two so the
            // vendor's own description survives into the book.
            day_minute >= self.start_minute || day_minute < self.end_minute
        }
    }

    fn local_day_minute(&self, at_unix: u64) -> u32 {
        let utc_minutes = (at_unix / 60) as i64;
        let local = utc_minutes + i64::from(self.utc_offset_minutes);
        // `rem_euclid` so a negative offset before the epoch-day boundary
        // still lands in [0, 1440) rather than going negative.
        local.rem_euclid(i64::from(MINUTES_PER_DAY)) as u32
    }

    /// Whether this window is expressible at all.
    ///
    /// A window outside the day, or one that starts and ends at the same
    /// minute, has no useful reading: the second could mean "never" or
    /// "always", and guessing either way misprices.
    pub fn is_valid(&self) -> bool {
        self.start_minute < MINUTES_PER_DAY
            && self.end_minute <= MINUTES_PER_DAY
            && self.start_minute != self.end_minute
            && self.utc_offset_minutes > -1440
            && self.utc_offset_minutes < 1440
    }
}

/// When one price row applies.
///
/// Every field absent means "always", which is what an unconditional row is
/// and what every row published before conditions existed becomes.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PriceConditions {
    /// Service tier as the provider names it: `batch`, `flex`, `fast`.
    ///
    /// Compared case-insensitively against what the meter recorded. A row
    /// with a tier never matches a call whose tier is unknown, so a batch
    /// rate cannot be applied to a call we cannot prove was batched.
    pub tier: Option<String>,
    /// Applies only when total input tokens are at or above this.
    ///
    /// This is how a long-context tier is written. "Input tokens" is every
    /// input category summed, including cached reads and cache writes,
    /// because the context a vendor charges for is the whole prompt.
    pub min_input_tokens: Option<u64>,
    /// Applies only when total input tokens are below this.
    pub max_input_tokens: Option<u64>,
    /// Applies only inside one of these recurring local-time windows.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub hours: Vec<DailyWindow>,
}

/// What was observed about one call, for matching against conditions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallFacts {
    /// Every input category summed.
    pub input_tokens: u64,
    /// End-of-call instant.
    pub at_unix: u64,
    /// Service tier the provider reported, when the meter captured it.
    ///
    /// `None` is "not known", never "standard". A row conditioned on a tier
    /// is skipped rather than matched, so an uncaptured tier leaves the call
    /// on the base rate instead of quietly earning a batch discount it may
    /// not be entitled to.
    pub tier: Option<String>,
}

impl PriceConditions {
    /// Whether these conditions are all satisfied.
    pub fn matches(&self, facts: &CallFacts) -> bool {
        if let Some(tier) = &self.tier {
            match &facts.tier {
                None => return false,
                Some(observed) if !observed.eq_ignore_ascii_case(tier) => return false,
                Some(_) => {}
            }
        }
        if let Some(min) = self.min_input_tokens {
            if facts.input_tokens < min {
                return false;
            }
        }
        if let Some(max) = self.max_input_tokens {
            if facts.input_tokens >= max {
                return false;
            }
        }
        if !self.hours.is_empty() && !self.hours.iter().any(|w| w.contains(facts.at_unix)) {
            return false;
        }
        true
    }

    /// How specific these conditions are.
    ///
    /// More conditions beats fewer, so a long-context batch rate wins over a
    /// plain batch rate, which wins over the unconditional rate. Ties fall
    /// through to the effective date and then to origin, exactly as before.
    pub fn specificity(&self) -> u32 {
        u32::from(self.tier.is_some())
            + u32::from(self.min_input_tokens.is_some())
            + u32::from(self.max_input_tokens.is_some())
            + u32::from(!self.hours.is_empty())
    }

    /// Whether this row is expressible.
    ///
    /// An unsatisfiable row is worse than a missing one: it looks like the
    /// price is covered while every call falls through to something else.
    pub fn is_valid(&self) -> bool {
        if let (Some(min), Some(max)) = (self.min_input_tokens, self.max_input_tokens) {
            if min >= max {
                return false;
            }
        }
        if self.tier.as_ref().is_some_and(|t| t.trim().is_empty()) {
            return false;
        }
        self.hours.iter().all(DailyWindow::is_valid)
    }

    /// Whether any condition is set.
    pub fn is_unconditional(&self) -> bool {
        self.specificity() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// DeepSeek publishes peak hours in Beijing time, so the window carries
    /// the offset rather than assuming the relay's clock is theirs.
    #[test]
    fn a_window_is_read_in_the_vendors_local_time() {
        // 09:00-12:00 Beijing (UTC+8) is 01:00-04:00 UTC.
        let window = DailyWindow {
            start_minute: 9 * 60,
            end_minute: 12 * 60,
            utc_offset_minutes: 480,
        };
        // 2026-08-05T02:30:00Z is 10:30 Beijing: inside.
        assert!(window.contains(1_785_205_800));
        // 2026-08-05T05:30:00Z is 13:30 Beijing: outside, between the two
        // published peak windows.
        assert!(!window.contains(1_785_216_600));
    }

    /// An overnight window is one window, not two, so the vendor's own
    /// description survives into the book.
    #[test]
    fn a_window_that_wraps_midnight_is_one_window() {
        let window = DailyWindow {
            start_minute: 22 * 60,
            end_minute: 6 * 60,
            utc_offset_minutes: 0,
        };
        let at = |hour: u64, minute: u64| 1_785_196_800 + hour * 3600 + minute * 60;
        assert!(window.contains(at(23, 0)), "before midnight");
        assert!(window.contains(at(2, 0)), "after midnight");
        assert!(!window.contains(at(12, 0)), "the middle of the day");
        assert!(window.contains(at(22, 0)), "start is inclusive");
        assert!(!window.contains(at(6, 0)), "end is exclusive");
    }

    #[test]
    fn an_unexpressible_window_is_rejected() {
        let base = DailyWindow {
            start_minute: 60,
            end_minute: 120,
            utc_offset_minutes: 0,
        };
        assert!(base.is_valid());
        assert!(
            !DailyWindow {
                start_minute: 600,
                end_minute: 600,
                ..base
            }
            .is_valid(),
            "start == end could mean never or always"
        );
        assert!(!DailyWindow {
            start_minute: 1_500,
            ..base
        }
        .is_valid());
        assert!(!DailyWindow {
            utc_offset_minutes: 5_000,
            ..base
        }
        .is_valid());
    }

    fn facts(input_tokens: u64, tier: Option<&str>) -> CallFacts {
        CallFacts {
            input_tokens,
            at_unix: 1_785_196_800,
            tier: tier.map(str::to_owned),
        }
    }

    /// An unconditional row matches everything, which is what every row
    /// published before conditions existed must keep doing.
    #[test]
    fn an_unconditional_row_matches_every_call() {
        let conditions = PriceConditions::default();
        assert!(conditions.matches(&facts(0, None)));
        assert!(conditions.matches(&facts(2_000_000, Some("batch"))));
        assert_eq!(conditions.specificity(), 0);
        assert!(conditions.is_unconditional());
    }

    /// The long-context case: `gpt-5.6-sol` is $5 per million input tokens
    /// short and $10 long, so the boundary decides a factor of two.
    #[test]
    fn a_context_bound_splits_at_the_threshold() {
        let long = PriceConditions {
            min_input_tokens: Some(128_000),
            ..PriceConditions::default()
        };
        assert!(!long.matches(&facts(127_999, None)));
        assert!(long.matches(&facts(128_000, None)), "min is inclusive");

        let short = PriceConditions {
            max_input_tokens: Some(128_000),
            ..PriceConditions::default()
        };
        assert!(short.matches(&facts(127_999, None)));
        assert!(
            !short.matches(&facts(128_000, None)),
            "max is exclusive, so the two rows meet without overlapping"
        );
    }

    /// A tier we did not capture must not earn a discounted rate. Matching
    /// an unknown tier against a batch row would hand every call a 50% cut
    /// on no evidence.
    #[test]
    fn a_tier_row_never_matches_a_call_whose_tier_is_unknown() {
        let batch = PriceConditions {
            tier: Some("batch".to_owned()),
            ..PriceConditions::default()
        };
        assert!(!batch.matches(&facts(10, None)));
        assert!(batch.matches(&facts(10, Some("batch"))));
        assert!(batch.matches(&facts(10, Some("BATCH"))), "case-insensitive");
        assert!(!batch.matches(&facts(10, Some("flex"))));
    }

    #[test]
    fn specificity_orders_more_conditions_first() {
        let base = PriceConditions::default();
        let tier = PriceConditions {
            tier: Some("batch".to_owned()),
            ..PriceConditions::default()
        };
        let tier_and_context = PriceConditions {
            tier: Some("batch".to_owned()),
            min_input_tokens: Some(128_000),
            ..PriceConditions::default()
        };
        assert!(base.specificity() < tier.specificity());
        assert!(tier.specificity() < tier_and_context.specificity());
    }

    /// A row nothing can satisfy looks like coverage and provides none.
    #[test]
    fn an_unsatisfiable_row_is_rejected() {
        assert!(!PriceConditions {
            min_input_tokens: Some(200_000),
            max_input_tokens: Some(128_000),
            ..PriceConditions::default()
        }
        .is_valid());
        assert!(!PriceConditions {
            tier: Some("  ".to_owned()),
            ..PriceConditions::default()
        }
        .is_valid());
        assert!(PriceConditions {
            min_input_tokens: Some(128_000),
            max_input_tokens: Some(200_000),
            ..PriceConditions::default()
        }
        .is_valid());
    }
}
