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
//! | Any model | which provider served it | up to 1.7x |
//!
//! Every one of those is a *conditional* rate, and every one is a silent
//! mispricing if the book cannot express it. The long-context case is the
//! sharpest: `gpt-5.6-sol` is $5 per million input tokens short and $10
//! long, so a book with only the short rate understates a long call by half
//! and nothing about the result looks wrong.
//!
//! The provider case is the widest. A model is sold by the lab that trained
//! it and also by Vertex, Bedrock, Alibaba, DigitalOcean and a long tail of
//! routers, each at its own price, and a local runtime charges nothing at
//! all. Read on 2026-08-05, `deepseek-v4-flash` was served by 21 providers
//! between $0.084 and $0.14 per million input tokens: a 67% spread on one
//! model string.
//!
//! So an entry carries conditions, and pricing picks the most specific entry
//! whose conditions the call satisfies. An entry with no conditions matches
//! every call, which is what every row written before this did, so books
//! already published keep behaving exactly as they did.
//!
//! # The provider is ranked above all of these
//!
//! Not by counting it in [`PriceConditions::specificity`], but a level up, in
//! [`crate::ledger::prices::PriceBook::entry_for_call`], which looks through
//! rows naming the call's provider before it looks at list rows at all.
//!
//! The conditions in this module describe *variations within one seller's
//! price list*: a batch discount, a long-context premium, an off-peak window.
//! The provider decides **whose list is read at all**. Applying DeepSeek's
//! peak-hour multiplier to a call Alibaba served and invoiced is not a more
//! precise answer, it is the wrong list. A specificity weight could not have
//! achieved that on its own, because model matching is a hard gate that runs
//! before any ranking: an exact list row would have beaten an alias row
//! naming the provider.
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
    /// Applies only to calls this provider served, by canonical slug.
    ///
    /// Absent means the row states the **vendor's own list price**, which is
    /// what every row published before this field existed meant and still
    /// means. Such a row prices a call from any provider, because leaving a
    /// resold call unpriced hides real money, while pricing it at list is
    /// wrong by a knowable amount. Which of the two happened is recorded on
    /// the priced line rather than left to be guessed: see
    /// [`crate::ledger::prices::PriceBasis`].
    ///
    /// Compared case-insensitively against the slug the meter recorded. A row
    /// naming a provider never matches a call whose provider is unknown, on
    /// the same reasoning as [`Self::tier`].
    pub provider: Option<String>,
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
    /// Canonical slug of whoever served and invoiced the call.
    ///
    /// The rule is **whoever bills you**, not whoever trained the model:
    /// Claude served through Vertex is `vertex`, because Google issues the
    /// invoice and Google's price applies. It is the only definition under
    /// which reconciliation against a provider's invoice can ever balance.
    ///
    /// `None` is "not known", never "the vendor". Rows naming a provider are
    /// skipped, so the call falls to the list rate rather than being handed
    /// a reseller's rate on no evidence.
    pub provider: Option<String>,
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
        if let Some(provider) = &self.provider {
            match &facts.provider {
                None => return false,
                Some(observed) if !observed.eq_ignore_ascii_case(provider) => return false,
                Some(_) => {}
            }
        }
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
    ///
    /// The provider is deliberately not counted here. It is ranked above all
    /// of these by [`crate::ledger::prices::PriceBook::entry_for_call`], which
    /// only ever compares rows already agreeing on it, so counting it would
    /// add a term that cancels in every comparison this method is used for.
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
        // A blank provider would match nothing while looking like the row
        // covers one, which is the exact failure this check exists to stop.
        if self.provider.as_ref().is_some_and(|p| p.trim().is_empty()) {
            return false;
        }
        self.hours.iter().all(DailyWindow::is_valid)
    }

    /// Whether any condition is set at all, provider included.
    ///
    /// This is not `specificity() == 0`. The provider is excluded from
    /// specificity because it is ranked a level up, but it is very much a
    /// condition, and a row is only unconditional without one. Conflating the
    /// two would be silent and expensive: `PriceEntry` omits `conditions`
    /// from the published book when this returns true, so a provider-only row
    /// would be written out with its provider erased and would then price
    /// every provider's calls at that one provider's rate.
    pub fn is_unconditional(&self) -> bool {
        self.provider.is_none() && self.specificity() == 0
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
            provider: None,
            tier: tier.map(str::to_owned),
        }
    }

    fn served_by(provider: &str) -> CallFacts {
        CallFacts {
            provider: Some(provider.to_owned()),
            ..facts(10, None)
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

    /// A row that names no provider is the vendor's list price, and must keep
    /// pricing calls from everyone. Every row published before providers
    /// existed is such a row, and the entire production book is made of them.
    #[test]
    fn a_row_naming_no_provider_prices_every_provider() {
        let list = PriceConditions::default();
        assert!(list.matches(&served_by("anthropic")));
        assert!(list.matches(&served_by("bedrock")));
        assert!(list.matches(&facts(10, None)), "and an unknown provider");
    }

    /// The whole point: an Alibaba-served call must not be priced from
    /// DeepSeek's own rate when a row for Alibaba exists.
    #[test]
    fn a_provider_row_matches_only_that_provider() {
        let alibaba = PriceConditions {
            provider: Some("alibaba".to_owned()),
            ..PriceConditions::default()
        };
        assert!(alibaba.matches(&served_by("alibaba")));
        assert!(alibaba.matches(&served_by("ALIBABA")), "case-insensitive");
        assert!(!alibaba.matches(&served_by("deepseek")));
    }

    /// Same rule as an uncaptured tier: an unknown provider earns no
    /// provider-specific rate. Otherwise a call we cannot place would collect
    /// whichever reseller's rate happened to be cheapest in the book.
    #[test]
    fn a_provider_row_never_matches_a_call_whose_provider_is_unknown() {
        let alibaba = PriceConditions {
            provider: Some("alibaba".to_owned()),
            ..PriceConditions::default()
        };
        assert!(!alibaba.matches(&facts(10, None)));
    }

    /// The provider is ranked a level up, in `PriceBook::entry_for_call`, so
    /// it must not also be counted here. Two rows are only ever compared by
    /// specificity once they already agree on the provider, and counting it
    /// would add a term that cancels in every such comparison.
    ///
    /// That the provider actually outranks these is asserted where it is
    /// decided: see the provider tests in [`crate::ledger::prices`].
    #[test]
    fn specificity_does_not_count_the_provider() {
        let provider_only = PriceConditions {
            provider: Some("alibaba".to_owned()),
            ..PriceConditions::default()
        };
        assert_eq!(provider_only.specificity(), 0);

        let provider_and_tier = PriceConditions {
            tier: Some("batch".to_owned()),
            ..provider_only.clone()
        };
        assert_eq!(provider_and_tier.specificity(), 1);
    }

    /// A provider-only row scores zero specificity, and a row is dropped from
    /// the published book when it reads as unconditional. If those two were
    /// the same test, the book would be written with the provider erased and
    /// that row would then price everyone's calls at one provider's rate.
    #[test]
    fn a_provider_only_row_is_not_unconditional() {
        let provider_only = PriceConditions {
            provider: Some("bedrock".to_owned()),
            ..PriceConditions::default()
        };
        assert_eq!(provider_only.specificity(), 0, "not counted in specificity");
        assert!(
            !provider_only.is_unconditional(),
            "but still a condition, or publishing silently drops it"
        );
        assert!(PriceConditions::default().is_unconditional());
    }

    #[test]
    fn a_blank_provider_is_rejected() {
        assert!(!PriceConditions {
            provider: Some("   ".to_owned()),
            ..PriceConditions::default()
        }
        .is_valid());
        assert!(PriceConditions {
            provider: Some("vertex".to_owned()),
            ..PriceConditions::default()
        }
        .is_valid());
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
