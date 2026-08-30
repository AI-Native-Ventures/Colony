//! Detecting coding-agent subscriptions the user already pays for.
//!
//! Onboarding used to offer OpenRouter and Colony credits, and probe for harness
//! binaries only behind an "advanced" disclosure. That buries the best option
//! for anyone holding a Claude Max or ChatGPT Pro plan: they are already paying
//! for frontier models, and Colony was quietly steering them toward a second
//! bill.
//!
//! This module answers three questions for the onboarding screen:
//!
//! 1. Which harness CLIs are installed?
//! 2. Which of them are signed in to a paid plan, and which plan?
//! 3. Which one should be recommended?
//!
//! # Read from disk, never from the network
//!
//! Claude Code writes everything needed to `~/.claude.json`, so detection costs
//! one file read and no auth prompt. Onboarding runs before the user has agreed
//! to anything, so a probe that opened a browser or spent a token would be the
//! wrong shape regardless of what it returned.
//!
//! # Detection is uneven, and callers must not paper over it
//!
//! Claude Code is the rich case: plan tier and both usage windows. Probing a
//! developer machine on 2026-08-30, `codex` and `copilot` both reported an
//! unknown auth status — installed, but exposing neither tier nor usage.
//!
//! So [`HarnessState`] has three variants, not two. Rendering "0% used" for a
//! harness that simply did not report is the failure this exists to prevent:
//! it invents a full quota out of missing data and would win a recommendation
//! it has no evidence for.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Gap in remaining-percentage below which two plans count as equivalent, and
/// the better model tier decides.
///
/// Ranking is on percentage remaining because that is the only quantity either
/// vendor publishes — neither exposes an absolute request budget, so anything
/// phrased as "requests left" would be derived from a capacity we cannot see.
/// Percentages alone would then let a marginally emptier plan displace a
/// materially better one, which this band prevents.
pub const TIER_PREFERENCE_BAND: f64 = 10.0;

/// What a subscription is worth, independent of how much of it is left.
///
/// Ordered so a derived `Ord` ranks stronger plans higher; the discriminants
/// are deliberately coarse, since this only ever breaks near-ties.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum PlanTier {
    /// Signed in, but the plan could not be identified.
    Unknown,
    /// An entry-level paid plan.
    Pro,
    /// A high-multiplier plan (Claude Max, ChatGPT Pro 20x).
    Max,
}

/// One usage window, expressed as the share still available.
///
/// Stored as *remaining* rather than used because that is what the onboarding
/// screen compares and what the meters fill: a fuller bar should mean a better
/// option, not a worse one.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Window {
    /// Percentage of the window still available, 0.0 to 100.0.
    pub remaining_percent: f64,
    /// Unix seconds at which this window resets, when the source reports one.
    pub resets_at: Option<i64>,
}

/// What is known about one harness.
///
/// The three variants exist because a missing measurement and a measurement of
/// zero are different facts, and only this type keeps them apart.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum HarnessState {
    /// Binary not on `PATH`.
    NotInstalled,
    /// Installed, but no signed-in account could be read.
    InstalledNotSignedIn,
    /// Signed in. `tier` may be [`PlanTier::Unknown`] and the windows may be
    /// `None` when the harness exposes no usage — `codex` and `copilot` both
    /// behaved this way when probed.
    SignedIn {
        tier: PlanTier,
        /// Human-readable plan name for display, e.g. `"Max 20x"`.
        plan_label: Option<String>,
        short_window: Option<Window>,
        long_window: Option<Window>,
        /// Unix seconds when the usage figures were captured. Claude Code
        /// writes this cache itself, so a user who has not run it recently has
        /// stale percentages; the UI shows the age rather than implying live data.
        usage_captured_at: Option<i64>,
    },
}

/// One row of the onboarding detection list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DetectedHarness {
    /// Harness id, matching the ACP runtime catalog (`claude`, `codex`, …).
    pub id: String,
    pub state: HarnessState,
}

impl DetectedHarness {
    /// The percentage this harness is ranked on: the scarcer of its two
    /// windows, since whichever runs out first is what stops the user.
    ///
    /// `None` when the harness reported no usage at all. Such a harness is
    /// offerable but never recommended — a plan with no evidence must not
    /// outrank one with measurements.
    pub fn remaining_percent(&self) -> Option<f64> {
        let HarnessState::SignedIn {
            short_window,
            long_window,
            ..
        } = &self.state
        else {
            return None;
        };
        match (short_window, long_window) {
            (Some(a), Some(b)) => Some(a.remaining_percent.min(b.remaining_percent)),
            (Some(w), None) | (None, Some(w)) => Some(w.remaining_percent),
            (None, None) => None,
        }
    }

    fn tier(&self) -> PlanTier {
        match &self.state {
            HarnessState::SignedIn { tier, .. } => *tier,
            _ => PlanTier::Unknown,
        }
    }

    /// Whether this harness can run agents right now.
    pub fn is_usable(&self) -> bool {
        matches!(self.state, HarnessState::SignedIn { .. })
    }
}

/// Pick the harness to mark as recommended.
///
/// Ranked on remaining percentage, with [`TIER_PREFERENCE_BAND`] reserved for
/// the plan tier: inside that band the stronger plan wins, so a marginally
/// emptier subscription does not displace a materially better one.
///
/// Returns `None` when nothing is signed in, or when every signed-in harness
/// reported no usage — Colony then offers them without ranking rather than
/// inventing an order.
pub fn recommended(harnesses: &[DetectedHarness]) -> Option<&DetectedHarness> {
    let mut best: Option<&DetectedHarness> = None;
    for h in harnesses.iter().filter(|h| h.is_usable()) {
        let Some(pct) = h.remaining_percent() else {
            continue;
        };
        let Some(current) = best else {
            best = Some(h);
            continue;
        };
        // `current` is only ever a candidate that had a percentage.
        let cur_pct = current.remaining_percent().unwrap_or(0.0);
        let take = if (pct - cur_pct).abs() < TIER_PREFERENCE_BAND {
            h.tier() > current.tier()
        } else {
            pct > cur_pct
        };
        if take {
            best = Some(h);
        }
    }
    best
}

/// Shape of the pieces of `~/.claude.json` this module reads.
///
/// Deliberately partial: the file carries a great deal that is none of
/// Colony's business, and `serde` ignores unknown fields, so widening it later
/// is additive.
#[derive(Debug, Deserialize)]
struct ClaudeConfig {
    #[serde(default)]
    #[serde(rename = "oauthAccount")]
    oauth_account: Option<ClaudeAccount>,
    #[serde(default)]
    #[serde(rename = "cachedUsageUtilization")]
    cached_usage: Option<ClaudeUsageCache>,
}

#[derive(Debug, Deserialize)]
struct ClaudeAccount {
    #[serde(default)]
    #[serde(rename = "organizationType")]
    organization_type: Option<String>,
    #[serde(default)]
    #[serde(rename = "organizationRateLimitTier")]
    rate_limit_tier: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClaudeUsageCache {
    #[serde(default)]
    #[serde(rename = "fetchedAtMs")]
    fetched_at_ms: Option<i64>,
    #[serde(default)]
    utilization: Option<ClaudeUtilization>,
}

#[derive(Debug, Deserialize)]
struct ClaudeUtilization {
    #[serde(default)]
    five_hour: Option<ClaudeWindow>,
    #[serde(default)]
    seven_day: Option<ClaudeWindow>,
}

#[derive(Debug, Deserialize)]
struct ClaudeWindow {
    /// Percentage *used*, which this module inverts on the way in so every
    /// downstream consumer speaks one direction.
    #[serde(default)]
    utilization: Option<f64>,
    #[serde(default)]
    resets_at: Option<String>,
}

/// Map Claude's plan strings onto a tier and a display label.
///
/// `organizationRateLimitTier` is the specific one (`default_claude_max_20x`),
/// with `organizationType` (`claude_max`) as the fallback when the first is
/// absent. Both are matched by substring rather than equality: these strings
/// have vendor-side variants, and a plan Colony does not recognise should
/// degrade to "signed in, plan unknown" rather than vanish from the list.
fn claude_plan(org_type: Option<&str>, rate_tier: Option<&str>) -> (PlanTier, Option<String>) {
    let tier_str = rate_tier.unwrap_or_default().to_ascii_lowercase();
    if tier_str.contains("max") {
        let label = if tier_str.contains("20x") {
            "Max 20x"
        } else if tier_str.contains("5x") {
            "Max 5x"
        } else {
            "Max"
        };
        return (PlanTier::Max, Some(label.to_string()));
    }
    if tier_str.contains("pro") {
        return (PlanTier::Pro, Some("Pro".to_string()));
    }
    match org_type.unwrap_or_default().to_ascii_lowercase() {
        t if t.contains("max") => (PlanTier::Max, Some("Max".to_string())),
        t if t.contains("pro") => (PlanTier::Pro, Some("Pro".to_string())),
        _ => (PlanTier::Unknown, None),
    }
}

/// Convert a used-percentage into a [`Window`] of remaining share.
///
/// Values outside 0–100 are clamped rather than rejected: a nonsense reading
/// should degrade the meter, not discard an otherwise usable subscription.
fn window_from(used: Option<f64>, resets_at: Option<&str>) -> Option<Window> {
    let used = used?;
    Some(Window {
        remaining_percent: (100.0 - used).clamp(0.0, 100.0),
        resets_at: resets_at.and_then(parse_rfc3339_secs),
    })
}

/// Parse the subset of RFC 3339 Claude Code writes into Unix seconds.
///
/// Hand-rolled to avoid adding a date dependency for one field. Anything
/// unparseable yields `None`, which renders as a missing reset time rather than
/// a wrong one.
fn parse_rfc3339_secs(s: &str) -> Option<i64> {
    let (date, rest) = s.split_once('T')?;
    let mut d = date.split('-');
    let (y, mo, da): (i64, i64, i64) = (
        d.next()?.parse().ok()?,
        d.next()?.parse().ok()?,
        d.next()?.parse().ok()?,
    );
    let time = rest.split(['+', 'Z', '.']).next()?;
    let mut t = time.split(':');
    let (h, mi, se): (i64, i64, i64) = (
        t.next()?.parse().ok()?,
        t.next()?.parse().ok()?,
        t.next().unwrap_or("0").parse().ok()?,
    );
    // Days since the Unix epoch by the civil-from-days algorithm (Howard
    // Hinnant), which is exact for all dates this will ever see.
    let y_adj = if mo <= 2 { y - 1 } else { y };
    let era = if y_adj >= 0 { y_adj } else { y_adj - 399 } / 400;
    let yoe = y_adj - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + da - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + h * 3_600 + mi * 60 + se)
}

/// Read Claude Code's state from an explicit config path.
///
/// Split from the public entry point so tests exercise real parsing against a
/// fixture instead of the developer's own `$HOME`.
pub fn claude_state_from_path(path: &PathBuf, installed: bool) -> HarnessState {
    if !installed {
        return HarnessState::NotInstalled;
    }
    let Ok(raw) = std::fs::read_to_string(path) else {
        return HarnessState::InstalledNotSignedIn;
    };
    let Ok(cfg) = serde_json::from_str::<ClaudeConfig>(&raw) else {
        return HarnessState::InstalledNotSignedIn;
    };
    let Some(account) = cfg.oauth_account else {
        return HarnessState::InstalledNotSignedIn;
    };
    let (tier, plan_label) = claude_plan(
        account.organization_type.as_deref(),
        account.rate_limit_tier.as_deref(),
    );
    let util = cfg
        .cached_usage
        .as_ref()
        .and_then(|c| c.utilization.as_ref());
    HarnessState::SignedIn {
        tier,
        plan_label,
        short_window: util
            .and_then(|u| u.five_hour.as_ref())
            .and_then(|w| window_from(w.utilization, w.resets_at.as_deref())),
        long_window: util
            .and_then(|u| u.seven_day.as_ref())
            .and_then(|w| window_from(w.utilization, w.resets_at.as_deref())),
        usage_captured_at: cfg
            .cached_usage
            .as_ref()
            .and_then(|c| c.fetched_at_ms)
            .map(|ms| ms / 1000),
    }
}

/// Default location of Claude Code's config.
pub fn claude_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signed_in(tier: PlanTier, short: f64, long: f64) -> HarnessState {
        HarnessState::SignedIn {
            tier,
            plan_label: Some("test".into()),
            short_window: Some(Window {
                remaining_percent: short,
                resets_at: None,
            }),
            long_window: Some(Window {
                remaining_percent: long,
                resets_at: None,
            }),
            usage_captured_at: None,
        }
    }

    fn h(id: &str, state: HarnessState) -> DetectedHarness {
        DetectedHarness {
            id: id.into(),
            state,
        }
    }

    /// The scarcer window decides, because whichever runs out first is what
    /// actually stops the user mid-task.
    #[test]
    fn remaining_is_the_scarcer_window() {
        let x = h("claude", signed_in(PlanTier::Max, 88.0, 57.0));
        assert_eq!(x.remaining_percent(), Some(57.0));
    }

    /// A clear gap is decided on percentage alone.
    #[test]
    fn clear_gap_ranks_on_remaining_percentage() {
        let hs = vec![
            h("claude", signed_in(PlanTier::Max, 88.0, 57.0)),
            h("codex", signed_in(PlanTier::Pro, 95.0, 92.0)),
        ];
        assert_eq!(
            recommended(&hs).unwrap().id,
            "codex",
            "92 vs 57 is decisive"
        );
    }

    /// Inside the band the better plan wins, so a marginally emptier
    /// subscription cannot displace a materially better one.
    #[test]
    fn near_tie_prefers_the_stronger_tier() {
        let hs = vec![
            h("codex", signed_in(PlanTier::Pro, 95.0, 92.0)),
            h("claude", signed_in(PlanTier::Max, 90.0, 89.0)),
        ];
        assert_eq!(
            recommended(&hs).unwrap().id,
            "claude",
            "3 points apart is inside the band, so Max beats Pro"
        );
    }

    /// Just outside the band, percentage decides again — proving the band is a
    /// threshold and not a blanket preference for the higher tier.
    #[test]
    fn outside_the_band_percentage_wins_again() {
        let hs = vec![
            h("codex", signed_in(PlanTier::Pro, 99.0, 99.0)),
            h("claude", signed_in(PlanTier::Max, 80.0, 80.0)),
        ];
        assert_eq!(recommended(&hs).unwrap().id, "codex", "19 points apart");
    }

    /// A harness that reported no usage is never recommended. Treating missing
    /// data as a full quota would hand the recommendation to whichever vendor
    /// exposes the least.
    #[test]
    fn harness_without_usage_is_offerable_but_not_recommended() {
        let no_usage = HarnessState::SignedIn {
            tier: PlanTier::Max,
            plan_label: Some("Pro 20x".into()),
            short_window: None,
            long_window: None,
            usage_captured_at: None,
        };
        let hs = vec![
            h("codex", no_usage),
            h("claude", signed_in(PlanTier::Pro, 40.0, 30.0)),
        ];
        assert!(hs[0].is_usable(), "still offered to the user");
        assert_eq!(hs[0].remaining_percent(), None);
        assert_eq!(
            recommended(&hs).unwrap().id,
            "claude",
            "a measured 30% must beat an unmeasured Max"
        );
    }

    /// Nothing signed in means nothing recommended — onboarding then leads with
    /// OpenRouter rather than a subscription card.
    #[test]
    fn nothing_signed_in_recommends_nothing() {
        let hs = vec![
            h("claude", HarnessState::NotInstalled),
            h("codex", HarnessState::InstalledNotSignedIn),
        ];
        assert!(recommended(&hs).is_none());
    }

    /// Every signed-in harness lacking usage also yields no recommendation,
    /// rather than falling back to input order.
    #[test]
    fn all_unmeasured_recommends_nothing() {
        let bare = || HarnessState::SignedIn {
            tier: PlanTier::Max,
            plan_label: None,
            short_window: None,
            long_window: None,
            usage_captured_at: None,
        };
        let hs = vec![h("codex", bare()), h("copilot", bare())];
        assert!(recommended(&hs).is_none());
    }

    #[test]
    fn plan_strings_map_to_tiers() {
        assert_eq!(
            claude_plan(Some("claude_max"), Some("default_claude_max_20x")),
            (PlanTier::Max, Some("Max 20x".into()))
        );
        assert_eq!(
            claude_plan(Some("claude_max"), Some("default_claude_max_5x")),
            (PlanTier::Max, Some("Max 5x".into()))
        );
        // Unrecognised tier falls back to the coarser organizationType.
        assert_eq!(
            claude_plan(Some("claude_max"), Some("something_new")),
            (PlanTier::Max, Some("Max".into()))
        );
        // Neither recognised: signed in, plan unknown — never dropped.
        assert_eq!(claude_plan(Some("weird"), None), (PlanTier::Unknown, None));
    }

    /// Percentages are inverted on the way in so the whole codebase speaks
    /// "remaining", matching the meters the user sees.
    #[test]
    fn used_percentage_is_stored_as_remaining() {
        let w = window_from(Some(43.0), None).unwrap();
        assert_eq!(w.remaining_percent, 57.0);
        assert_eq!(window_from(None, None), None, "absent stays absent");
        assert_eq!(
            window_from(Some(140.0), None).unwrap().remaining_percent,
            0.0,
            "a nonsense reading clamps rather than going negative"
        );
    }

    #[test]
    fn rfc3339_parses_to_unix_seconds() {
        // Both values cross-checked against the millisecond timestamps Claude
        // Code itself reports for the same two windows (1788505200292 and
        // 1788100800292), so the fixture is anchored to the vendor's own
        // arithmetic rather than to this parser's.
        assert_eq!(
            parse_rfc3339_secs("2026-09-04T07:00:00+00:00"),
            Some(1_788_505_200)
        );
        assert_eq!(
            parse_rfc3339_secs("2026-08-30T14:40:00.292365+00:00"),
            Some(1_788_100_800),
            "fractional seconds and a +00:00 offset must both be tolerated"
        );
        assert_eq!(parse_rfc3339_secs("not a date"), None);
        assert_eq!(
            parse_rfc3339_secs("2026-08-30"),
            None,
            "date alone is not a timestamp"
        );
    }

    /// End-to-end against the real shape of `~/.claude.json`, using the exact
    /// field names and a value observed on a live machine.
    #[test]
    fn parses_a_real_shaped_claude_config() {
        let dir = std::env::temp_dir().join(format!("colony-subs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".claude.json");
        std::fs::write(
            &path,
            r#"{
              "oauthAccount": {
                "organizationType": "claude_max",
                "organizationRateLimitTier": "default_claude_max_20x",
                "emailAddress": "someone@example.com"
              },
              "cachedUsageUtilization": {
                "fetchedAtMs": 1788089563549,
                "utilization": {
                  "five_hour": { "utilization": 12, "resets_at": "2026-08-30T14:40:00.292365+00:00" },
                  "seven_day": { "utilization": 43, "resets_at": "2026-09-04T07:00:00.292384+00:00" }
                }
              }
            }"#,
        )
        .unwrap();

        let state = claude_state_from_path(&path, true);
        let HarnessState::SignedIn {
            tier,
            plan_label,
            short_window,
            long_window,
            usage_captured_at,
        } = state
        else {
            panic!("expected SignedIn, got {state:?}");
        };
        assert_eq!(tier, PlanTier::Max);
        assert_eq!(plan_label.as_deref(), Some("Max 20x"));
        assert_eq!(short_window.unwrap().remaining_percent, 88.0);
        assert_eq!(long_window.unwrap().remaining_percent, 57.0);
        assert_eq!(usage_captured_at, Some(1788089563));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A missing or unreadable file is "installed, not signed in" — never a
    /// hard error, because onboarding must still render.
    #[test]
    fn missing_config_degrades_to_not_signed_in() {
        let path = PathBuf::from("/nonexistent/colony/.claude.json");
        assert_eq!(
            claude_state_from_path(&path, true),
            HarnessState::InstalledNotSignedIn
        );
        assert_eq!(
            claude_state_from_path(&path, false),
            HarnessState::NotInstalled
        );
    }
}
