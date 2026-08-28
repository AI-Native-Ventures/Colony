//! Brand kit derivation from company-scan evidence.
//!
//! The scan (`super::extract`) already collects brand evidence: hex colours
//! ranked by how often a site uses them, declared font families, and candidate
//! logo and favicon URLs. This module turns that evidence into a brand kit
//! proposal (kind 30198) — the record every content gate measures against.
//!
//! **Ramps, not swatches.** Picking colours by eye shipped cards measuring
//! 2.7:1 and 1.16:1 that the contrast gate caught. Every ramp stop here that
//! type can sit on is *solved*, not sampled: lightness is found by bisection
//! against the WCAG 2.1 contrast formula, the same measurement the post-render
//! gate takes against rendered pixels. Two solves matter:
//!
//! - `white_text_lightness` — the lightest a hue may go while white type still
//!   clears [`WHITE_TEXT_RATIO`] against it. Darker always stays legible for
//!   white, so this bounds the dark end of a ramp.
//! - `ink_canvas_lightness` — the palest full-strength tint on which near-black
//!   ink still clears [`INK_CANVAS_RATIO`]. Colony's own canvas values were
//!   derived exactly this way ("lightness raised until #171717 clears 7:1"),
//!   and this module reproduces those numbers from the same math rather than
//!   copying the table.
//!
//! Both solves exist for every hue: relative luminance rises monotonically
//! with HSL lightness at fixed hue and saturation, so the contrast ratio
//! against a fixed foreground is monotone too and bisection cannot miss.
//!
//! A derivation only proposes. It never publishes: `buzz content kit derive`
//! prints the proposed body, and acceptance is an explicit `buzz content kit
//! set`. A hand-edited kit therefore cannot be clobbered by a re-scan — the
//! re-scan produces a proposal the owner diffs and accepts or drops.

use std::collections::BTreeMap;

use super::extract::{Confidence, Evidence};
use super::fetch::CompanyScanResult;

/// WCAG 2.1 relative luminance of 8-bit sRGB.
pub fn relative_luminance(rgb: [u8; 3]) -> f64 {
    let lin: Vec<f64> = rgb
        .iter()
        .map(|c| {
            let s = f64::from(*c) / 255.0;
            if s <= 0.03928 {
                s / 12.92
            } else {
                ((s + 0.055) / 1.055).powf(2.4)
            }
        })
        .collect();
    0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}

/// WCAG 2.1 contrast ratio between two sRGB triples.
pub fn contrast_ratio(fg: [u8; 3], bg: [u8; 3]) -> f64 {
    let (hi, lo) = (relative_luminance(fg), relative_luminance(bg));
    let (hi, lo) = if hi > lo { (hi, lo) } else { (lo, hi) };
    (hi + 0.05) / (lo + 0.05)
}

/// Parse `#rgb`, `#rrggbb`, or `#rrggbbaa` to an RGB triple (alpha dropped).
pub fn hex_to_rgb(hex: &str) -> Option<[u8; 3]> {
    let body = hex.strip_prefix('#').unwrap_or(hex);
    let expanded: String = match body.len() {
        3 => body.chars().flat_map(|c| [c, c]).collect(),
        6 | 8 => body[..6].to_owned(),
        _ => return None,
    };
    if !expanded.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some([
        u8::from_str_radix(&expanded[0..2], 16).ok()?,
        u8::from_str_radix(&expanded[2..4], 16).ok()?,
        u8::from_str_radix(&expanded[4..6], 16).ok()?,
    ])
}

/// Lowercase `#rrggbb`.
pub fn rgb_to_hex(rgb: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2])
}

/// Hue in `[0, 360)`, saturation and lightness in `[0, 1]`.
fn rgb_to_hsl(rgb: [u8; 3]) -> (f64, f64, f64) {
    let r = f64::from(rgb[0]) / 255.0;
    let g = f64::from(rgb[1]) / 255.0;
    let b = f64::from(rgb[2]) / 255.0;
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    if max == min {
        return (0.0, 0.0, l);
    }
    let d = max - min;
    let s = if l > 0.5 {
        d / (2.0 - max - min)
    } else {
        d / (max + min)
    };
    let h = if max == r {
        ((g - b) / d + if g < b { 6.0 } else { 0.0 }) * 60.0
    } else if max == g {
        ((b - r) / d + 2.0) * 60.0
    } else {
        ((r - g) / d + 4.0) * 60.0
    };
    (h, s, l)
}

fn hue_to_rgb(p: f64, q: f64, t: f64) -> f64 {
    let mut t = t;
    if t < 0.0 {
        t += 1.0;
    }
    if t > 1.0 {
        t -= 1.0;
    }
    if t < 1.0 / 6.0 {
        p + (q - p) * 6.0 * t
    } else if t < 0.5 {
        q
    } else if t < 2.0 / 3.0 {
        p + (q - p) * (2.0 / 3.0 - t) * 6.0
    } else {
        p
    }
}

/// HSL to 8-bit sRGB.
fn hsl_to_rgb(h: f64, s: f64, l: f64) -> [u8; 3] {
    if s == 0.0 {
        let v = (l * 255.0).round() as u8;
        return [v, v, v];
    }
    let q = if l < 0.5 {
        l * (1.0 + s)
    } else {
        l + s - l * s
    };
    let p = 2.0 * l - q;
    let channel = |t: f64| (hue_to_rgb(p, q, t) * 255.0).round() as u8;
    [
        channel(h / 360.0 + 1.0 / 3.0),
        channel(h / 360.0),
        channel(h / 360.0 - 1.0 / 3.0),
    ]
}

/// Contrast target white type must clear against a ramp stop that carries it.
///
/// WCAG AA for body text, and the same floor the kit's rules declare by
/// default, so a solved stop and the gate agree without translation.
pub const WHITE_TEXT_RATIO: f64 = 4.5;

/// Contrast target near-black ink must clear against a canvas tint.
///
/// Colony's own canvases were raised until `#171717` cleared 7:1; this module
/// solves new hues to the same bar rather than borrowing the table.
pub const INK_CANVAS_RATIO: f64 = 7.0;

/// The near-black ink every card sets text in.
const INK: [u8; 3] = [0x17, 0x17, 0x17];

const WHITE: [u8; 3] = [255, 255, 255];

/// Bisection precision in lightness percentage points; finer than any display
/// can distinguish and far coarser than float noise.
const SOLVE_EPSILON: f64 = 0.01;

/// The lightest HSL lightness (percent) of hue `h`, saturation `s` at which
/// white type still clears [`WHITE_TEXT_RATIO`] against it.
///
/// Monotone in lightness, so bisection finds the boundary exactly; darker than
/// this, white type only gets safer.
pub fn white_text_lightness(h: f64, s: f64) -> f64 {
    let clears = |l: f64| contrast_ratio(WHITE, hsl_to_rgb(h, s, l / 100.0)) >= WHITE_TEXT_RATIO;
    // At L=0 every hue renders black (21:1); at L=100 it renders white (1:1).
    let mut lo = 0.0f64;
    let mut hi = 100.0f64;
    while hi - lo > SOLVE_EPSILON {
        let mid = (lo + hi) / 2.0;
        if clears(mid) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    lo
}

/// The darkest HSL lightness (percent) of hue `h`, saturation `s` on which
/// near-black ink still clears [`INK_CANVAS_RATIO`] against it.
///
/// Lighter than this, ink only gets safer; this is the palest full-strength
/// tint usable as a text ground.
pub fn ink_canvas_lightness(h: f64, s: f64) -> f64 {
    let clears = |l: f64| contrast_ratio(INK, hsl_to_rgb(h, s, l / 100.0)) >= INK_CANVAS_RATIO;
    let mut lo = 0.0f64;
    let mut hi = 100.0f64;
    while hi - lo > SOLVE_EPSILON {
        let mid = (lo + hi) / 2.0;
        if clears(mid) {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    hi
}

// ── the solved ramp ───────────────────────────────────────────────────────

/// The wash tones that close a ramp, as (saturation factor, lightness
/// percent). These mirror Colony's canvas-mid and canvas-light treatment:
/// same hue pushed paler for grounds that carry no body text of their own.
/// They are derived deterministically from the hue rather than solved against
/// type because nothing is set in them; every stop that carries text is a
/// bisection solve.
const WASH_TONES: [(f64, f64); 2] = [(0.55, 96.0), (0.70, 90.0)];

/// The ratios white type is solved against, darkest ground first.
///
/// Three rather than one, because the renderer's ground is banded: the
/// darkest stop carries the type, the middle one carries the mass of the
/// field, and the lightest still has to hold a word that drifts onto it.
const WHITE_SAFE_RATIOS: [f64; 3] = [11.0, 7.5, 5.8];

/// The ratios near-black ink is solved against, darkest ground first. Mirrors
/// [`WHITE_SAFE_RATIOS`] for the light family.
const INK_SAFE_RATIOS: [f64; 3] = [5.5, 7.5, 11.0];

/// The lightest lightness of `h`/`s` at which white type clears `ratio`.
///
/// Generalises [`white_text_lightness`], which is this at 4.5. The ramp needs
/// several ratios rather than one because the ground is banded rather than
/// flat.
fn white_lightness_at(h: f64, s: f64, ratio: f64) -> f64 {
    let clears = |l: f64| contrast_ratio(WHITE, hsl_to_rgb(h, s, l / 100.0)) >= ratio;
    let mut lo = 0.0f64;
    let mut hi = 100.0f64;
    while hi - lo > SOLVE_EPSILON {
        let mid = (lo + hi) / 2.0;
        if clears(mid) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    lo
}

/// The darkest lightness of `h`/`s` on which ink clears `ratio`.
fn ink_lightness_at(h: f64, s: f64, ratio: f64) -> f64 {
    let clears = |l: f64| contrast_ratio(INK, hsl_to_rgb(h, s, l / 100.0)) >= ratio;
    let mut lo = 0.0f64;
    let mut hi = 100.0f64;
    while hi - lo > SOLVE_EPSILON {
        let mid = (lo + hi) / 2.0;
        if clears(mid) {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    hi
}

/// Build one hue's ramp from its base colour.
///
/// Stops, before ordering: the base itself; the white-type solve (lightest
/// lightness still carrying white type — the dark end); the ink solve
/// (darkest full-strength tint carrying ink); then the two wash tones. The
/// result is ordered dark to light and deduplicated by exact hex, so a base
/// that already sits on a solve boundary appears once.
pub fn solved_ramp(base_hex: &str) -> Option<Vec<String>> {
    let rgb = hex_to_rgb(base_hex)?;
    let (h, s, _l) = rgb_to_hsl(rgb);
    // Near-greys carry no hue to solve; a ramp of them would be noise.
    if s < 0.08 {
        return None;
    }

    // Positional, not sorted. The renderer reads this ramp by named index
    // (`COLONY_RAMP` in colonyKit.ts): three white-safe stops, three ink-safe
    // stops, then the two washes. A ramp that was sorted and deduplicated -
    // which this was - has no stable positions at all, so the ground read the
    // wrong stop or ran off the end of a short ramp and threw. Every stop is
    // emitted even when two solves land on the same hex, because a missing
    // stop shifts every stop after it.
    let mut ramp: Vec<String> = Vec::with_capacity(8);
    for ratio in WHITE_SAFE_RATIOS {
        let l = white_lightness_at(h, s, ratio);
        ramp.push(rgb_to_hex(hsl_to_rgb(h, s, l / 100.0)));
    }
    for ratio in INK_SAFE_RATIOS {
        let l = ink_lightness_at(h, s, ratio);
        ramp.push(rgb_to_hex(hsl_to_rgb(h, s, l / 100.0)));
    }
    for (sat_factor, lightness) in WASH_TONES {
        ramp.push(rgb_to_hex(hsl_to_rgb(h, s * sat_factor, lightness / 100.0)));
    }
    Some(ramp)
}

// ── clustering observed colours into hues ─────────────────────────────────

/// Most hues one derivation will propose. A customer edits from there; five
/// covers every palette the launch build used without drowning the editor.
pub const MAX_DERIVED_HUES: usize = 5;

/// One observed colour and how much the site leaned on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColorCandidate {
    /// Lowercase `#rrggbb`.
    pub hex: String,
    /// Times this colour was observed across all scanned pages.
    pub occurrences: usize,
    /// True when the site declared it outright (`theme-color`), which outranks
    /// any number of stylistic accidents.
    pub declared: bool,
}

impl ColorCandidate {
    fn weight(&self) -> usize {
        if self.declared {
            self.occurrences + 1_000
        } else {
            self.occurrences
        }
    }

    fn saturation(&self) -> f64 {
        rgb_to_hsl(hex_to_rgb(&self.hex).unwrap_or([0, 0, 0])).1
    }
}

/// Shortest distance between two hue angles, in degrees.
fn hue_distance(a: f64, b: f64) -> f64 {
    let d = (a - b).abs() % 360.0;
    if d > 180.0 {
        360.0 - d
    } else {
        d
    }
}

/// Two colours within this hue angle belong to one family. Wide enough to
/// merge the shades a site uses of one brand colour, narrow enough to keep
/// violet and blue apart.
const HUE_FAMILY_TOLERANCE_DEG: f64 = 24.0;

/// Lightness band a colour must sit in to count as an accent.
///
/// HSL saturation stays high near white and black — a cream page background
/// measures s=0.7 — so saturation alone cannot tell a brand hue from a wash.
/// Lightness can: page-scale washes live past ~92%, true accents do not.
fn is_accent_like(lightness: f64) -> bool {
    (0.06..=0.92).contains(&lightness)
}

struct HueCluster {
    hue: f64,
    members: Vec<ColorCandidate>,
}

fn cluster_hues(candidates: &[ColorCandidate], accents_only: bool) -> Vec<HueCluster> {
    let mut ranked: Vec<&ColorCandidate> = candidates.iter().collect();
    ranked.sort_by(|left, right| {
        right
            .weight()
            .cmp(&left.weight())
            .then_with(|| left.hex.cmp(&right.hex))
    });

    let mut clusters: Vec<HueCluster> = Vec::new();
    for candidate in ranked {
        let Some(rgb) = hex_to_rgb(&candidate.hex) else {
            continue;
        };
        let (_, _, lightness) = rgb_to_hsl(rgb);
        if candidate.saturation() < 0.08 {
            continue;
        }
        if accents_only && !is_accent_like(lightness) {
            continue;
        }
        let h = rgb_to_hsl(rgb).0;
        if let Some(cluster) = clusters
            .iter_mut()
            .find(|cluster| hue_distance(cluster.hue, h) <= HUE_FAMILY_TOLERANCE_DEG)
        {
            cluster.members.push(candidate.clone());
        } else {
            clusters.push(HueCluster {
                hue: h,
                members: vec![candidate.clone()],
            });
        }
    }
    clusters
}

/// The conventional colour name for a hue angle, so a derived kit reads like
/// Colony's (`violet`, `amber`) instead of `hue-3`. Colony calls hsl(258)
/// violet, so the violet band is centred there rather than on the 270-290
/// convention; fuchsia-family accents (#c026d3) read as magenta.
fn hue_name(hue: f64) -> &'static str {
    match hue as u32 {
        0..=14 => "red",
        15..=44 => "orange",
        45..=64 => "amber",
        65..=84 => "yellow",
        85..=104 => "lime",
        105..=149 => "green",
        150..=179 => "teal",
        180..=199 => "cyan",
        200..=249 => "blue",
        250..=289 => "violet",
        290..=324 => "magenta",
        325..=349 => "pink",
        _ => "red",
    }
}

/// One proposed hue: slug name, identity colour, solved ramp.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DerivedHue {
    pub name: String,
    pub base: String,
    pub ramp: Vec<String>,
}

/// Cluster the observed colours and solve a ramp per hue family.
///
/// Families are ranked by evidence weight (declared first, then frequency);
/// at most [`MAX_DERIVED_HUES`] come back. Names are conventional colour
/// words, suffixed `-2`, `-3` when one site leans on two families with the
/// same name.
pub fn derive_hues(colors: &[ColorCandidate]) -> Vec<DerivedHue> {
    // Accents lead; page-scale washes only join when the site offered nothing
    // else, because a cream background is a real choice too.
    let mut hues: Vec<DerivedHue> = Vec::new();
    for clusters in [cluster_hues(colors, true), cluster_hues(colors, false)] {
        for cluster in clusters {
            if hues.len() >= MAX_DERIVED_HUES {
                break;
            }
            // The heaviest member is the family's face: it keeps the exact
            // bytes the site actually uses rather than an average nobody chose.
            let base = &cluster.members[0].hex;
            let Some(ramp) = solved_ramp(base) else {
                continue;
            };
            let name = hue_name(cluster.hue);
            let ordinal = hues.iter().filter(|hue| hue.name.starts_with(name)).count();
            hues.push(DerivedHue {
                name: if ordinal == 0 {
                    name.to_owned()
                } else {
                    format!("{name}-{}", ordinal + 1)
                },
                base: base.clone(),
                ramp,
            });
        }
        if !hues.is_empty() {
            break;
        }
    }
    hues
}

// ── from a scan to a proposal ─────────────────────────────────────────────

/// Brand evidence aggregated across every page of one scan.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ScanBranding {
    /// Observed colours with occurrence counts and declared flags.
    pub colors: Vec<ColorCandidate>,
    /// Font families, best first.
    pub fonts: Vec<String>,
    /// Candidate logo URLs, most deliberate first.
    pub logo_urls: Vec<String>,
    /// Candidate favicon / touch-icon URLs, most deliberate first.
    pub icon_urls: Vec<String>,
}

/// Families every CSS engine resolves itself; they are fallbacks, not
/// identity, so they rank after any real name.
const GENERIC_FAMILIES: [&str; 8] = [
    "serif",
    "sans-serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
    "ui-sans-serif",
    "ui-monospace",
];

/// True when a declaration fragment can act as a font family name.
///
/// Sites leak CSS tokens (`var(--font-display)`, `inherit`,
/// `!important`) into their stacks; none of those names anything a renderer
/// can load.
fn is_usable_family(raw: &str) -> bool {
    let name = raw.trim();
    !name.is_empty()
        && !name.contains(['(', ')'])
        && !name.contains('!')
        && !matches!(
            name.to_ascii_lowercase().as_str(),
            "inherit" | "initial" | "unset" | "revert"
        )
}

fn push_font(fonts: &mut Vec<String>, raw: &str) {
    let cleaned: String = raw.trim().trim_matches('"').trim_matches('\'').to_owned();
    if !is_usable_family(&cleaned) || fonts.iter().any(|held| held == &cleaned) {
        return;
    }
    // Real family names precede generics regardless of declaration order,
    // because a generic first would make the kit's headline font a browser
    // default even when the site names one later in its own stack.
    let generics_start = fonts
        .iter()
        .position(|font| GENERIC_FAMILIES.contains(&font.to_ascii_lowercase().as_str()))
        .unwrap_or(fonts.len());
    if GENERIC_FAMILIES.contains(&cleaned.to_ascii_lowercase().as_str()) {
        // Generics keep declaration order among themselves.
        fonts.push(cleaned);
    } else {
        fonts.insert(generics_start, cleaned);
    }
}

/// Aggregate per-page brand evidence into [`ScanBranding`].
///
/// Colours keep their exact observed spelling and gain counts; `theme-color`
/// declarations outrank stylistic inference regardless of how often an
/// accident repeats. Logo candidates are ordered by confidence (declared
/// OpenGraph images first), icons follow their link order.
pub fn summarize_scan(scan: &CompanyScanResult) -> ScanBranding {
    let mut colors: BTreeMap<String, ColorCandidate> = BTreeMap::new();
    let mut fonts: Vec<String> = Vec::new();
    let mut logo_urls: Vec<String> = Vec::new();
    let mut icon_urls: Vec<String> = Vec::new();

    let push_logo = |evidence: &Evidence<String>, out: &mut Vec<String>| {
        if !out.contains(&evidence.value) {
            out.push(evidence.value.clone());
        }
    };

    // Two passes so every Declared logo precedes every Inferred one across
    // pages, not merely within a page.
    for pass in [Confidence::Declared, Confidence::Inferred] {
        for page in &scan.pages {
            for evidence in &page.brand.logo_candidates {
                if evidence.confidence == pass {
                    push_logo(evidence, &mut logo_urls);
                }
            }
        }
    }

    for page in &scan.pages {
        for evidence in &page.brand.colors {
            let entry = colors
                .entry(evidence.value.clone())
                .or_insert_with(|| ColorCandidate {
                    hex: evidence.value.clone(),
                    occurrences: 0,
                    declared: false,
                });
            entry.occurrences += 1;
            entry.declared |= evidence.confidence == Confidence::Declared;
        }
        for font in &page.brand.fonts {
            push_font(&mut fonts, font);
        }
        for url in &page.brand.icon_candidates {
            if !icon_urls.contains(&url.value) {
                icon_urls.push(url.value.clone());
            }
        }
    }

    let mut ordered: Vec<ColorCandidate> = colors.into_values().collect();
    ordered.sort_by(|left, right| {
        right
            .weight()
            .cmp(&left.weight())
            .then_with(|| left.hex.cmp(&right.hex))
    });

    ScanBranding {
        colors: ordered,
        fonts,
        logo_urls,
        icon_urls,
    }
}

/// A mark whose bytes have been fetched and hashed by the caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProposedMark {
    pub role: &'static str,
    /// Bare lowercase SHA-256 of the mark's bytes.
    pub media_hash: String,
    /// Public URL the bytes were uploaded to.
    pub media_url: String,
}

/// The default canvases a derived kit declares.
///
/// The two formats the launch build actually rendered, plus the square both
/// platforms accept.
/// Only the canvas the renderer can actually draw. `CANVAS_W` x `CANVAS_H` in
/// `compositions.ts` is a constant, so a kit that advertised a square or a
/// landscape promised a size no card can be produced at, and the canvas gate
/// would refuse every one of them.
const DEFAULT_CANVASES: [(&str, u64, u64); 1] = [("ig-portrait", 1080, 1350)];

/// The layouts a derived kit allows.
///
/// These are layout ids the renderer implements (`LAYOUTS` in
/// `compositions.ts`), not jobs in a running order. This list used to be
/// `who, what, why, proof, when`, which are the *jobs* a week's cards do; an
/// agent reading the kit for a template would write `layout: "who"` and every
/// card would throw `unknown layout who` after passing every text gate.
const DEFAULT_TEMPLATES: [&str; 2] = ["statement", "poster"];

/// Derive a brand kit proposal body from aggregated scan branding.
///
/// Returns the full kind-30198 JSON document — schema, scan source, hues with
/// solved ramps, typography, canvases, templates, rules — without marks. The
/// caller attaches fetched-and-hashed marks separately because those need
/// network work this pure function must not do. A site that offered no fonts
/// omits `type` entirely rather than inheriting a font it never chose; a site
/// that offered no colours yields an empty `hues`, which parses but should be
/// treated as "the site needs JavaScript" and warned about upstream.
pub fn derive_kit_body(url: &str, scanned_at: u64, branding: &ScanBranding) -> serde_json::Value {
    let hues = derive_hues(&branding.colors);

    let mut body = serde_json::json!({
        "schema": buzz_core::content_brand_kit::SCHEMA_CONTENT_BRAND_KIT,
        "source": { "type": "scan", "url": url, "scanned_at": scanned_at },
        "hues": hues
            .iter()
            .map(|hue| serde_json::json!({
                "name": hue.name,
                "base": hue.base,
                "ramp": hue.ramp,
            }))
            .collect::<Vec<serde_json::Value>>(),
        "canvases": DEFAULT_CANVASES
            .iter()
            .map(|(name, w, h)| serde_json::json!({ "name": name, "w": w, "h": h }))
            .collect::<Vec<serde_json::Value>>(),
        "templates": DEFAULT_TEMPLATES,
        "rules": {
            "claim_strictness": "strict",
            "contrast_floor": WHITE_TEXT_RATIO,
        },
        "version": "1",
    });

    if !branding.fonts.is_empty() {
        let families: Vec<String> = branding
            .fonts
            .iter()
            .take(buzz_core::content_brand_kit::MAX_TYPE_FAMILIES)
            .cloned()
            .collect();
        body["type"] = serde_json::json!({
            "families": families,
            "scale": { "ratio": 1.25, "steps": [14, 18, 22, 28] },
        });
    }
    body
}

/// Attach fetched marks to a proposal body.
pub fn attach_marks(body: &mut serde_json::Value, marks: &[ProposedMark]) {
    if marks.is_empty() {
        return;
    }
    body["marks"] = serde_json::json!(marks
        .iter()
        .map(|mark| serde_json::json!({
            "role": mark.role,
            "media_hash": mark.media_hash,
            "media_url": mark.media_url,
        }))
        .collect::<Vec<serde_json::Value>>());
}

// ── fetching mark bytes ───────────────────────────────────────────────────

/// Why a candidate mark could not be turned into bytes.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct MarkFetchError(pub String);

/// Longest wait on one mark request.
const MARK_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Most redirect hops a mark may follow.
const MAX_MARK_REDIRECTS: usize = 3;

/// Largest mark accepted, in bytes.
const MAX_MARK_BYTES: usize = 5 * 1024 * 1024;

const MARK_USER_AGENT: &str = "ColonyBrandKitDeriver/1 (+https://colony.ainative.ventures)";

/// Fetch one candidate mark image from the scanned origin.
///
/// The same discipline as the page fetcher, narrowed to images: every URL is
/// re-validated against the scan origin (a logo must live where the site
/// lives), redirects are followed manually through the same guard, the host
/// is resolved once and pinned so DNS cannot answer twice, and the body cap
/// is enforced chunk by chunk while streaming.
pub async fn fetch_mark_bytes(
    origin: &super::url_guard::CheckedUrl,
    raw_url: &str,
) -> Result<(Vec<u8>, String), MarkFetchError> {
    let mut current = super::url_guard::check_redirect(raw_url, origin)
        .map_err(|error| MarkFetchError(error.to_string()))?;
    if current.origin_key() != origin.origin_key() {
        return Err(MarkFetchError(format!(
            "{raw_url} is not same-origin with the scanned site"
        )));
    }

    for _hop in 0..=MAX_MARK_REDIRECTS {
        let addresses = super::url_guard::resolve_public(&current)
            .await
            .map_err(|error| {
                MarkFetchError(format!("could not resolve {}: {error}", current.host))
            })?;

        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(MARK_REQUEST_TIMEOUT)
            .user_agent(MARK_USER_AGENT);
        for address in &addresses {
            builder = builder.resolve(&current.host, *address);
        }
        let client = builder
            .build()
            .map_err(|error| MarkFetchError(format!("http client: {error}")))?;

        let mut response = client
            .get(current.url.clone())
            .send()
            .await
            .map_err(|error| MarkFetchError(format!("fetch {raw_url}: {error}")))?;

        let status = response.status();
        if status.is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| MarkFetchError("redirect without a location".to_owned()))?
                .to_owned();
            current = super::url_guard::check_redirect(&location, &current)
                .map_err(|error| MarkFetchError(error.to_string()))?;
            if current.origin_key() != origin.origin_key() {
                return Err(MarkFetchError(format!(
                    "{raw_url} redirected off the scanned origin"
                )));
            }
            continue;
        }
        if !status.is_success() {
            return Err(MarkFetchError(format!(
                "fetch {raw_url}: HTTP {}",
                status.as_u16()
            )));
        }

        let declared_mime = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();

        let mut buffer: Vec<u8> = Vec::new();
        loop {
            let chunk = response
                .chunk()
                .await
                .map_err(|error| MarkFetchError(format!("read {raw_url}: {error}")))?;
            let Some(chunk) = chunk else { break };
            let room = MAX_MARK_BYTES.saturating_sub(buffer.len());
            if room == 0 {
                break;
            }
            let take = room.min(chunk.len());
            buffer.extend_from_slice(&chunk[..take]);
            if buffer.len() >= MAX_MARK_BYTES {
                break;
            }
        }

        // Content-Type is a hint; the bytes decide. A server that labels a
        // PNG `image/svg+xml` still gets its real type back here.
        let mime = sniff_mime(&buffer).unwrap_or(declared_mime);
        return Ok((buffer, mime));
    }

    Err(MarkFetchError(format!(
        "more than {MAX_MARK_REDIRECTS} redirects fetching {raw_url}"
    )))
}

/// Detect an image MIME from magic bytes, preferring certainty over the
/// declared header.
fn sniff_mime(bytes: &[u8]) -> Option<String> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png".to_owned());
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return Some("image/jpeg".to_owned());
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif".to_owned());
    }
    if bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
        return Some("image/webp".to_owned());
    }
    None
}

/// File extension for an uploadable image MIME.
pub fn extension_for_mime(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contrast_formula_matches_published_wcag_values() {
        // #767676 on #fff is the canonical AA boundary pair (4.54:1).
        assert!(
            (contrast_ratio([0x76, 0x76, 0x76], WHITE) - 4.54).abs() < 0.01,
            "got {}",
            contrast_ratio([0x76, 0x76, 0x76], WHITE)
        );
        assert!((contrast_ratio(WHITE, [0, 0, 0]) - 21.0).abs() < 1e-9);
    }

    #[test]
    fn hex_round_trips_through_hsl() {
        for hex in ["#c026d3", "#b394f9", "#f59f0a", "#171717", "#ffffff"] {
            let rgb = hex_to_rgb(hex).expect("parse");
            let (h, s, l) = rgb_to_hsl(rgb);
            assert_eq!(rgb_to_hex(hsl_to_rgb(h, s, l)), hex, "{hex} drifted");
        }
    }

    /// Colony's violet canvas was measured at hsl(258 90% 78%) after raising
    /// lightness until #171717 cleared 7:1. The solver must land there.
    #[test]
    fn violet_ink_canvas_solve_lands_on_the_measured_colony_value() {
        let solved = ink_canvas_lightness(258.0, 0.90);
        assert!(
            (solved - 78.0).abs() < 1.0,
            "solved {solved}, colony measured 78"
        );
        let rgb = hsl_to_rgb(258.0, 0.90, solved / 100.0);
        assert!(contrast_ratio(INK, rgb) >= INK_CANVAS_RATIO);
    }

    /// Colony's amber canvas is the raw accent itself (hsl(38 92% 50%)),
    /// kept because it already clears 7:1. The solver returns the darkest
    /// such lightness, which sits below the accent's own 50%; what must hold
    /// is that the solve clears the bar and Colony's kept value clears it
    /// too.
    #[test]
    fn amber_ink_canvas_solve_stays_at_the_raw_accent_lightness() {
        let solved = ink_canvas_lightness(38.0, 0.92);
        assert!(
            solved <= 50.0,
            "solved {solved} must not exceed colony's 50"
        );
        assert!(contrast_ratio(INK, hsl_to_rgb(38.0, 0.92, solved / 100.0)) >= INK_CANVAS_RATIO);
        assert!(
            contrast_ratio(INK, hsl_to_rgb(38.0, 0.92, 0.50)) >= INK_CANVAS_RATIO,
            "colony's kept 50% must clear the same bar"
        );
    }

    #[test]
    fn white_type_solve_clears_the_floor_and_nothing_lighter_does() {
        // Colony violet hsl(258 90% 66%): solve the boundary, then confirm
        // one step lighter breaks it and the solved value itself clears it.
        let solved = white_text_lightness(258.0, 0.90) / 100.0;
        let at = contrast_ratio(WHITE, hsl_to_rgb(258.0, 0.90, solved));
        let lighter = contrast_ratio(
            WHITE,
            hsl_to_rgb(258.0, 0.90, (solved + 6.0 / 100.0).min(1.0)),
        );
        assert!(at >= WHITE_TEXT_RATIO);
        assert!(lighter < WHITE_TEXT_RATIO);
    }

    /// A ramp is read by position, not scanned as a gradient.
    ///
    /// This test used to assert dark-to-light and no duplicate neighbours,
    /// which sounds right and is not: the renderer reads named indices
    /// (`COLONY_RAMP`), and Colony's own ramp is not monotone either, because
    /// the palest canvas tint sits at index 6 and the fuller one at 7. Sorting
    /// and deduplicating destroyed the positions, so the ground read the wrong
    /// stop or ran off the end of a short ramp. The property that actually
    /// matters is that each position clears the ratio it was solved for.
    #[test]
    fn every_ramp_position_clears_the_ratio_it_was_solved_for() {
        for base in ["#c026d3", "#f59f0a", "#72a5f8", "#33cc99", "#1d9bf0"] {
            let ramp = solved_ramp(base).expect("saturated hue");
            assert_eq!(ramp.len(), 8, "{base} produced {ramp:?}");
            for hex in &ramp {
                assert_eq!(*hex, hex.to_ascii_lowercase());
            }

            // Solved by bisection to the boundary, so allow the epsilon the
            // solver stops at rather than demanding the exact ratio.
            const SLACK: f64 = 0.05;
            for (index, ratio) in WHITE_SAFE_RATIOS.iter().enumerate() {
                let rgb = hex_to_rgb(&ramp[index]).expect("parse");
                let measured = contrast_ratio(WHITE, rgb);
                assert!(
                    measured >= ratio - SLACK,
                    "{base} stop {index} measures {measured} against a {ratio} white bar"
                );
            }
            for (offset, ratio) in INK_SAFE_RATIOS.iter().enumerate() {
                let rgb = hex_to_rgb(&ramp[3 + offset]).expect("parse");
                let measured = contrast_ratio(INK, rgb);
                assert!(
                    measured >= ratio - SLACK,
                    "{base} stop {} measures {measured} against a {ratio} ink bar",
                    3 + offset
                );
            }

            // The two washes close the ramp and carry no type, so they are
            // only required to be pale.
            for (offset, wash) in ramp[6..8].iter().enumerate() {
                let (_, _, l) = rgb_to_hsl(hex_to_rgb(wash).expect("parse"));
                assert!(l > 0.8, "{base} wash {} is not pale: {wash:?}", 6 + offset);
            }
        }
    }

    #[test]
    fn near_grey_bases_produce_no_ramp() {
        assert_eq!(solved_ramp("#171717"), None);
        assert_eq!(solved_ramp("#ffffff"), None);
    }

    #[test]
    fn same_family_colours_cluster_and_keep_the_heaviest_base() {
        let colors = vec![
            ColorCandidate {
                hex: "#c026d3".to_owned(),
                occurrences: 9,
                declared: false,
            },
            ColorCandidate {
                hex: "#86198f".to_owned(),
                occurrences: 4,
                declared: false,
            },
            ColorCandidate {
                hex: "#1d9bf0".to_owned(),
                occurrences: 7,
                declared: false,
            },
        ];
        let hues = derive_hues(&colors);
        assert_eq!(hues.len(), 2);
        assert_eq!(hues[0].name, "magenta");
        assert_eq!(hues[0].base, "#c026d3");
        assert_eq!(hues[1].name, "blue");
    }

    #[test]
    fn a_declared_colour_outranks_a_frequent_inferred_one() {
        let colors = vec![
            ColorCandidate {
                hex: "#00ff88".to_owned(),
                occurrences: 30,
                declared: false,
            },
            ColorCandidate {
                hex: "#c026d3".to_owned(),
                occurrences: 1,
                declared: true,
            },
        ];
        let hues = derive_hues(&colors);
        assert_eq!(hues[0].base, "#c026d3", "declared must lead");
        assert_eq!(hues.len(), 2);
    }

    #[test]
    fn repeated_family_names_get_ordinals() {
        let colors = vec![
            ColorCandidate {
                hex: "#c026d3".to_owned(),
                occurrences: 5,
                declared: false,
            },
            ColorCandidate {
                hex: "#e879f9".to_owned(),
                occurrences: 5,
                declared: false,
            },
            ColorCandidate {
                hex: "#1d9bf0".to_owned(),
                occurrences: 5,
                declared: false,
            },
        ];
        let hues = derive_hues(&colors);
        // #c026d3 and #e879f9 are both magenta-family but far enough apart in
        // hue angle that they may split; either way names never collide.
        let mut seen = std::collections::BTreeSet::new();
        for hue in &hues {
            assert!(seen.insert(hue.name.clone()), "duplicate name {}", hue.name);
        }
    }

    fn evidence(value: &str, confidence: Confidence) -> Evidence<String> {
        Evidence {
            value: value.to_owned(),
            confidence,
            source_url: "https://acme.test/".to_owned(),
        }
    }

    fn scan_fixture() -> CompanyScanResult {
        use super::super::extract::{BrandEvidence, PageEvidence};
        CompanyScanResult {
            requested_url: "https://acme.test".to_owned(),
            canonical_url: "https://acme.test/".to_owned(),
            pages: vec![PageEvidence {
                url: "https://acme.test/".to_owned(),
                brand: BrandEvidence {
                    logo_candidates: vec![evidence(
                        "https://acme.test/logo.png",
                        Confidence::Declared,
                    )],
                    icon_candidates: vec![evidence(
                        "https://acme.test/favicon.ico",
                        Confidence::Declared,
                    )],
                    colors: vec![
                        evidence("#c026d3", Confidence::Declared),
                        evidence("#c026d3", Confidence::Inferred),
                        evidence("#1d9bf0", Confidence::Inferred),
                        evidence("#1d9bf0", Confidence::Inferred),
                    ],
                    fonts: vec!["\"Inter\"".to_owned(), "Inter".to_owned()],
                },
                ..PageEvidence::default()
            }],
            ..CompanyScanResult::default()
        }
    }

    #[test]
    fn summarize_aggregates_counts_and_orders_marks_by_confidence() {
        let branding = summarize_scan(&scan_fixture());
        // Same hex from two observations collapses to one candidate.
        assert_eq!(branding.colors.len(), 2);
        assert_eq!(branding.colors[0].hex, "#c026d3");
        assert!(branding.colors[0].declared);
        assert_eq!(branding.colors[0].occurrences, 2);
        assert_eq!(branding.colors[1].occurrences, 2);
        // Quoted font spellings collapse; one entry remains.
        assert_eq!(branding.fonts, vec!["Inter".to_owned()]);
        assert_eq!(branding.logo_urls, vec!["https://acme.test/logo.png"]);
        assert_eq!(branding.icon_urls, vec!["https://acme.test/favicon.ico"]);
    }

    #[test]
    fn css_tokens_and_generics_do_not_lead_the_font_list() {
        let mut branding = ScanBranding::default();
        for font in [
            "var(--font-display)",
            "inherit",
            "monospace",
            "\"Sohne\"",
            "Sohne",
            "system-ui",
        ] {
            push_font(&mut branding.fonts, font);
        }
        assert_eq!(
            branding.fonts,
            vec![
                "Sohne".to_owned(),
                "monospace".to_owned(),
                "system-ui".to_owned()
            ]
        );
    }

    #[test]
    fn a_page_wash_does_not_lead_when_a_real_accent_exists() {
        // #fbf0df is a cream that HSL calls saturated (s=0.77 at L=0.93);
        // it must not become the kit's orange.
        let colors = vec![
            ColorCandidate {
                hex: "#fbf0df".to_owned(),
                occurrences: 40,
                declared: false,
            },
            ColorCandidate {
                hex: "#22d3ee".to_owned(),
                occurrences: 6,
                declared: false,
            },
        ];
        let hues = derive_hues(&colors);
        assert_eq!(hues.len(), 1);
        assert_eq!(hues[0].base, "#22d3ee");
    }

    #[test]
    fn a_wash_only_site_still_gets_its_hue() {
        let colors = vec![ColorCandidate {
            hex: "#fbf0df".to_owned(),
            occurrences: 12,
            declared: false,
        }];
        let hues = derive_hues(&colors);
        assert_eq!(hues.len(), 1);
        assert_eq!(hues[0].base, "#fbf0df");
    }

    /// The whole point: a derived body must pass the same parser the relay
    /// runs at ingest, so acceptance is never blocked on derivation output.
    #[test]
    fn a_derived_body_round_trips_through_the_record_parser() {
        use buzz_core::content_brand_kit::{parse_content_brand_kit, BrandKitSource, MarkRole};
        use nostr::{EventBuilder, Keys, Kind, Tag};

        let branding = summarize_scan(&scan_fixture());
        let body = derive_kit_body("https://acme.test/", 1_755_000_000, &branding);
        attach_marks(
            &mut body.clone(),
            &[ProposedMark {
                role: "logo",
                media_hash: "a".repeat(64),
                media_url: "https://media.test/logo.png".to_owned(),
            }],
        );
        let mut marked = body;
        attach_marks(
            &mut marked,
            &[ProposedMark {
                role: "icon",
                media_hash: "b".repeat(64),
                media_url: "https://media.test/icon.ico".to_owned(),
            }],
        );

        let event = EventBuilder::new(Kind::Custom(30198), marked.to_string())
            .tags(vec![Tag::parse(["d", "acme"].iter().copied()).expect("tag")])
            .sign_with_keys(&Keys::generate())
            .expect("sign");
        let parsed = parse_content_brand_kit(&event).expect("derived kit must parse");

        assert_eq!(parsed.id, "acme");
        assert_eq!(
            parsed.source,
            BrandKitSource::Scan {
                url: "https://acme.test/".to_owned(),
                scanned_at: 1_755_000_000,
            }
        );
        assert!(
            parsed.rules.claim_strictness == buzz_core::content_brand_kit::ClaimStrictness::Strict
        );
        assert_eq!(parsed.rules.contrast_floor, Some(WHITE_TEXT_RATIO));
        assert_eq!(parsed.canvases.len(), DEFAULT_CANVASES.len());
        assert_eq!(parsed.templates, DEFAULT_TEMPLATES);
        let kit_type = parsed.kit_type.as_ref().expect("fonts were found");
        assert_eq!(kit_type.families, vec!["Inter".to_owned()]);
        assert_eq!(parsed.marks.len(), 1);
        assert_eq!(parsed.marks[0].role, MarkRole::Icon);
        // The property the renderer relies on is positional: eight stops, so
        // every named index in COLONY_RAMP resolves. Ordering is not it - the
        // washes that close the ramp are deliberately out of lightness order.
        for hue in &parsed.hues {
            assert_eq!(
                hue.ramp.len(),
                8,
                "{} ramp has no named positions: {:?}",
                hue.name,
                hue.ramp
            );
            for hex in &hue.ramp {
                assert!(
                    hex_to_rgb(hex).is_some(),
                    "{} ramp stop is not a colour: {hex}",
                    hue.name
                );
            }
        }
    }
}
