//! Evidence extraction from one fetched HTML page.
//!
//! Everything here is a pure function over markup, so the whole surface is
//! testable without a network. That matters: the Chief of Staff has to be able
//! to show its sources, and a scanner that silently guesses is worse than one
//! that reports a gap.
//!
//! The ordering principle throughout is **stated beats inferred**. A site's own
//! JSON-LD is a claim the business published about itself; an OpenGraph tag is
//! a claim it made to social networks; a heuristic over CSS is our guess. Each
//! extracted value carries which of those it came from so downstream can weigh
//! it, and so a Company Brief can cite it.

use std::collections::{BTreeMap, BTreeSet};

use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use url::Url;

/// How strongly a piece of evidence is attested.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Confidence {
    /// The site published this as machine-readable structured data (JSON-LD).
    Stated,
    /// The site declared it in metadata intended for machines (OG, meta tags).
    Declared,
    /// We inferred it from page content or styling.
    Inferred,
}

/// One extracted fact plus where it came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence<T> {
    /// The extracted value.
    pub value: T,
    /// How strongly it is attested.
    pub confidence: Confidence,
    /// Exact URL this was read from, so a brief can cite it.
    pub source_url: String,
}

impl<T> Evidence<T> {
    fn new(value: T, confidence: Confidence, source_url: &str) -> Self {
        Self {
            value,
            confidence,
            source_url: source_url.to_owned(),
        }
    }
}

/// Brand assets and styling observed on a page.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandEvidence {
    /// Absolute URLs of candidate logo images, best guess first.
    pub logo_candidates: Vec<Evidence<String>>,
    /// Absolute URLs of favicons and touch icons.
    pub icon_candidates: Vec<Evidence<String>>,
    /// Hex colours observed, most frequent first.
    pub colors: Vec<Evidence<String>>,
    /// Font families declared in inline styles or CSS custom properties.
    pub fonts: Vec<String>,
}

/// Ways a visitor is asked to make contact.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactEvidence {
    /// Email addresses found in `mailto:` links.
    pub emails: Vec<String>,
    /// Phone numbers found in `tel:` links.
    pub phones: Vec<String>,
    /// Social profile URLs, keyed by network.
    pub socials: BTreeMap<String, String>,
    /// Third-party booking or scheduling links.
    pub booking_links: Vec<String>,
    /// True when emails were scraped from prose rather than read from links.
    #[serde(default)]
    pub emails_inferred: bool,
    /// True when phones were scraped from prose rather than read from links.
    #[serde(default)]
    pub phones_inferred: bool,
}

/// A same-origin link, classified by what kind of page it probably is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassifiedLink {
    /// Absolute URL.
    pub url: String,
    /// Which crawl category it fell into.
    pub category: LinkCategory,
    /// Visible link text, trimmed.
    pub text: String,
}

/// Page categories worth crawling, in priority order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkCategory {
    /// What the business sells. Highest value: drives services and cost centres.
    Services,
    /// Stated prices, packages, tiers.
    Pricing,
    /// Who they are, size, history.
    About,
    /// Proof: case studies, portfolio, clients.
    Work,
    /// How to reach them.
    Contact,
    /// Hiring pages, which reveal team size and structure.
    Careers,
    /// Anything else same-origin.
    Other,
    /// Terms, privacy, cookies. Enormous, boilerplate, and says nothing about
    /// what the business does — but "Terms of Service" reads as a services
    /// page unless it is matched first.
    Legal,
}

impl LinkCategory {
    /// Classify from the URL path and link text.
    fn classify(path: &str, text: &str) -> Self {
        let haystack = format!(
            "{} {}",
            path.to_ascii_lowercase(),
            text.to_ascii_lowercase()
        );
        let has = |needles: &[&str]| needles.iter().any(|n| haystack.contains(n));

        // Legal first, and deliberately so. "Terms of Service" contains
        // "service", so without this these pages classify as the highest
        // priority category and their boilerplate eats the whole byte budget
        // ahead of the pages that describe the business.
        if has(&[
            "/legal",
            "terms",
            "privacy",
            "cookie",
            "gdpr",
            "/dpa",
            "acceptable-use",
            "disclaimer",
            "refund-policy",
            "sub-processor",
            "subprocessor",
        ]) {
            return Self::Legal;
        }
        if has(&["pricing", "price", "plans", "packages", "rates"]) {
            return Self::Pricing;
        }
        if has(&[
            "service",
            "solution",
            "product",
            "what-we-do",
            "offering",
            "capabilit",
        ]) {
            return Self::Services;
        }
        if has(&[
            "case-stud",
            "case_stud",
            "portfolio",
            "our-work",
            "/work",
            "project",
            "client",
        ]) {
            return Self::Work;
        }
        if has(&["career", "job", "hiring", "join-us", "vacanc"]) {
            return Self::Careers;
        }
        if has(&["contact", "get-in-touch", "book", "enquir", "inquir"]) {
            return Self::Contact;
        }
        if has(&["about", "who-we-are", "our-story", "team", "mission"]) {
            return Self::About;
        }
        Self::Other
    }
}

/// Everything extracted from one page.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageEvidence {
    /// URL this page was fetched from.
    pub url: String,
    /// `<title>`, or the OpenGraph title when richer.
    pub title: Option<Evidence<String>>,
    /// Meta description or OpenGraph description.
    pub description: Option<Evidence<String>>,
    /// Canonical URL the site declares for this page.
    pub canonical_url: Option<String>,
    /// Headings in document order, giving the page's shape.
    pub headings: Vec<String>,
    /// Readable body text with boilerplate removed.
    pub text: String,
    /// Raw JSON-LD blocks, parsed but not interpreted.
    pub structured_data: Vec<serde_json::Value>,
    /// Brand assets observed here.
    pub brand: BrandEvidence,
    /// Contact routes observed here.
    pub contact: ContactEvidence,
    /// Same-origin links worth following.
    pub links: Vec<ClassifiedLink>,
    /// Absolute URLs of content images, for brand and asset gathering.
    pub images: Vec<String>,
    /// Notes about what could not be read.
    pub warnings: Vec<String>,
}

fn selector(spec: &str) -> Selector {
    // Every selector here is a compile-time constant string; a parse failure is
    // a programming error, not a runtime condition.
    Selector::parse(spec).expect("static selector must parse")
}

fn attr_of(document: &Html, spec: &str, attribute: &str) -> Option<String> {
    document
        .select(&selector(spec))
        .find_map(|element| element.value().attr(attribute))
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn absolutize(base: &Url, candidate: &str) -> Option<String> {
    let joined = base.join(candidate.trim()).ok()?;
    matches!(joined.scheme(), "https" | "http").then(|| joined.to_string())
}

/// Extract the page title, preferring OpenGraph when the site supplied one.
fn extract_title(document: &Html, url: &str) -> Option<Evidence<String>> {
    if let Some(og) = attr_of(document, r#"meta[property="og:title"]"#, "content") {
        return Some(Evidence::new(og, Confidence::Declared, url));
    }
    document
        .select(&selector("title"))
        .next()
        .map(|element| element.text().collect::<String>().trim().to_owned())
        .filter(|title| !title.is_empty())
        .map(|title| Evidence::new(title, Confidence::Declared, url))
}

fn extract_description(document: &Html, url: &str) -> Option<Evidence<String>> {
    for spec in [
        r#"meta[name="description"]"#,
        r#"meta[property="og:description"]"#,
        r#"meta[name="twitter:description"]"#,
    ] {
        if let Some(value) = attr_of(document, spec, "content") {
            return Some(Evidence::new(value, Confidence::Declared, url));
        }
    }
    None
}

/// Parse every JSON-LD block. These are the site's own machine-readable claims
/// and are the highest-confidence evidence available, so they are kept whole
/// rather than being flattened into our own shapes.
fn extract_structured_data(document: &Html) -> Vec<serde_json::Value> {
    document
        .select(&selector(r#"script[type="application/ld+json"]"#))
        .filter_map(|element| {
            let raw = element.text().collect::<String>();
            serde_json::from_str::<serde_json::Value>(raw.trim()).ok()
        })
        .collect()
}

fn extract_brand(document: &Html, base: &Url, url: &str, extra_css: &str) -> BrandEvidence {
    let mut brand = BrandEvidence::default();
    let mut seen_logos = BTreeSet::new();

    // An explicit OpenGraph image is a deliberate choice by the site owner.
    if let Some(og) = attr_of(document, r#"meta[property="og:image"]"#, "content") {
        if let Some(absolute) = absolutize(base, &og) {
            if seen_logos.insert(absolute.clone()) {
                brand
                    .logo_candidates
                    .push(Evidence::new(absolute, Confidence::Declared, url));
            }
        }
    }

    // Images that call themselves a logo. Inferred, but usually the real mark.
    for element in document.select(&selector("img")) {
        let value = element.value();
        let haystack = [
            value.attr("src").unwrap_or_default(),
            value.attr("alt").unwrap_or_default(),
            value.attr("class").unwrap_or_default(),
            value.attr("id").unwrap_or_default(),
        ]
        .join(" ")
        .to_ascii_lowercase();
        if !haystack.contains("logo") && !haystack.contains("brand") {
            continue;
        }
        let Some(src) = value.attr("src") else {
            continue;
        };
        let Some(absolute) = absolutize(base, src) else {
            continue;
        };
        if seen_logos.insert(absolute.clone()) {
            brand
                .logo_candidates
                .push(Evidence::new(absolute, Confidence::Inferred, url));
        }
    }

    let mut seen_icons = BTreeSet::new();
    for spec in [
        r#"link[rel="icon"]"#,
        r#"link[rel="shortcut icon"]"#,
        r#"link[rel="apple-touch-icon"]"#,
        r#"link[rel="mask-icon"]"#,
    ] {
        for element in document.select(&selector(spec)) {
            let Some(href) = element.value().attr("href") else {
                continue;
            };
            let Some(absolute) = absolutize(base, href) else {
                continue;
            };
            if seen_icons.insert(absolute.clone()) {
                brand
                    .icon_candidates
                    .push(Evidence::new(absolute, Confidence::Declared, url));
            }
        }
    }

    // `theme-color` is the one colour a site states outright.
    if let Some(theme) = attr_of(document, r#"meta[name="theme-color"]"#, "content") {
        if let Some(hex) = normalize_hex(&theme) {
            brand
                .colors
                .push(Evidence::new(hex, Confidence::Declared, url));
        }
    }

    // Colours from inline styles and CSS custom properties, ranked by how often
    // they appear — a brand colour is used repeatedly, an accident once.
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut style_text = String::from(extra_css);
    for element in document.select(&selector("style")) {
        style_text.push_str(&element.text().collect::<String>());
    }
    for element in document.select(&selector("[style]")) {
        if let Some(style) = element.value().attr("style") {
            style_text.push(' ');
            style_text.push_str(style);
        }
    }
    for hex in hex_colors_in(&style_text)
        .into_iter()
        .chain(rgb_colors_in(&style_text))
    {
        if is_near_grey(&hex) {
            continue;
        }
        *counts.entry(hex).or_default() += 1;
    }
    let mut ranked: Vec<(String, usize)> = counts.into_iter().collect();
    ranked.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));
    for (hex, _) in ranked.into_iter().take(8) {
        if brand.colors.iter().any(|existing| existing.value == hex) {
            continue;
        }
        brand
            .colors
            .push(Evidence::new(hex, Confidence::Inferred, url));
    }

    brand.fonts = font_families_in(&style_text);
    brand
}

/// Normalize a CSS hex colour to lowercase `#rrggbb`.
fn normalize_hex(raw: &str) -> Option<String> {
    let value = raw.trim().trim_start_matches('#');
    if !value.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let expanded = match value.len() {
        3 => value.chars().flat_map(|c| [c, c]).collect::<String>(),
        6 => value.to_owned(),
        // 8 digits is #rrggbbaa; keep the colour, drop the alpha.
        8 => value[..6].to_owned(),
        _ => return None,
    };
    Some(format!("#{}", expanded.to_ascii_lowercase()))
}

/// Whether a colour is too close to grey to be a brand colour.
///
/// Adopted from the browser-based crawl skill, which hard-codes the common
/// Tailwind greys. Measuring saturation generalizes that: page chrome is
/// near-grey whatever framework produced it, and a brand colour is not.
fn is_near_grey(hex: &str) -> bool {
    let Ok(r) = u8::from_str_radix(&hex[1..3], 16) else {
        return false;
    };
    let Ok(g) = u8::from_str_radix(&hex[3..5], 16) else {
        return false;
    };
    let Ok(b) = u8::from_str_radix(&hex[5..7], 16) else {
        return false;
    };
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    // Low chroma is grey. Very dark and very light are chrome regardless.
    (max - min) < 24 || max < 24 || min > 244
}

/// Parse `rgb()` / `rgba()` into `#rrggbb`.
///
/// Stylesheets mix notations freely, and a brand colour written `rgb(29,155,240)`
/// is the same colour as `#1d9bf0` — counting them separately would split the
/// frequency ranking and bury the real brand colour.
fn rgb_colors_in(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let lowered = text.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(offset) = lowered[cursor..].find("rgb") {
        let start = cursor + offset;
        let Some(open) = lowered[start..].find('(') else {
            break;
        };
        let Some(close) = lowered[start + open..].find(')') else {
            break;
        };
        let inner = &lowered[start + open + 1..start + open + close];
        let parts: Vec<&str> = inner
            .split(&[',', '/', ' '][..])
            .filter(|p| !p.is_empty())
            .collect();
        if parts.len() >= 3 {
            let channel = |raw: &str| raw.trim().parse::<u16>().ok().filter(|v| *v <= 255);
            if let (Some(r), Some(g), Some(b)) =
                (channel(parts[0]), channel(parts[1]), channel(parts[2]))
            {
                found.push(format!("#{r:02x}{g:02x}{b:02x}"));
            }
        }
        cursor = start + open + close;
    }
    found
}

fn hex_colors_in(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'#' {
            index += 1;
            continue;
        }
        let start = index + 1;
        let mut end = start;
        while end < bytes.len() && (bytes[end] as char).is_ascii_hexdigit() && end - start < 8 {
            end += 1;
        }
        let candidate = &text[start..end];
        // Only 3, 6 and 8 digit runs are colours; 4 or 5 is something else.
        if matches!(candidate.len(), 3 | 6 | 8) {
            if let Some(hex) = normalize_hex(candidate) {
                found.push(hex);
            }
        }
        index = end.max(index + 1);
    }
    found
}

fn font_families_in(style_text: &str) -> Vec<String> {
    let mut families = BTreeSet::new();
    let lowered = style_text.to_ascii_lowercase();
    for (offset, _) in lowered.match_indices("font-family") {
        let Some(colon) = lowered[offset..].find(':') else {
            continue;
        };
        let rest = &style_text[offset + colon + 1..];
        let end = rest.find([';', '}']).unwrap_or(rest.len());
        let first = rest[..end]
            .split(',')
            .next()
            .unwrap_or_default()
            .trim()
            .trim_matches(['"', '\''])
            .to_owned();
        if !first.is_empty() && first.len() <= 64 {
            families.insert(first);
        }
    }
    families.into_iter().take(6).collect()
}

/// Known social networks, matched on host so a link to a post still counts.
const SOCIAL_HOSTS: [(&str, &str); 9] = [
    ("linkedin.com", "linkedin"),
    ("twitter.com", "twitter"),
    ("x.com", "twitter"),
    ("instagram.com", "instagram"),
    ("facebook.com", "facebook"),
    ("youtube.com", "youtube"),
    ("tiktok.com", "tiktok"),
    ("github.com", "github"),
    ("threads.net", "threads"),
];

/// Third-party scheduling tools, which reveal how a business converts interest.
const BOOKING_HOSTS: [&str; 5] = [
    "calendly.com",
    "cal.com",
    "hubspot.com",
    "savvycal.com",
    "acuityscheduling.com",
];

fn extract_contact_and_links(
    document: &Html,
    base: &Url,
    origin_host: &str,
) -> (ContactEvidence, Vec<ClassifiedLink>) {
    let mut contact = ContactEvidence::default();
    let mut emails = BTreeSet::new();
    let mut phones = BTreeSet::new();
    let mut booking = BTreeSet::new();
    let mut links: Vec<ClassifiedLink> = Vec::new();
    let mut seen_links = BTreeSet::new();

    for element in document.select(&selector("a[href]")) {
        let Some(href) = element.value().attr("href") else {
            continue;
        };
        let href = href.trim();

        if let Some(address) = href.strip_prefix("mailto:") {
            let cleaned = address.split('?').next().unwrap_or(address).trim();
            if cleaned.contains('@') {
                emails.insert(cleaned.to_ascii_lowercase());
            }
            continue;
        }
        if let Some(number) = href.strip_prefix("tel:") {
            let cleaned = number.trim();
            if !cleaned.is_empty() {
                phones.insert(cleaned.to_owned());
            }
            continue;
        }

        let Some(absolute) = absolutize(base, href) else {
            continue;
        };
        let Ok(parsed) = Url::parse(&absolute) else {
            continue;
        };
        let Some(host) = parsed.host_str().map(str::to_ascii_lowercase) else {
            continue;
        };

        if host == origin_host || host == format!("www.{origin_host}") {
            // Fragments and queries point at the same document; the crawler
            // wants distinct pages, so key on the path alone.
            let mut canonical = parsed.clone();
            canonical.set_fragment(None);
            canonical.set_query(None);
            let key = canonical.to_string();
            if seen_links.insert(key.clone()) {
                let text = element.text().collect::<String>().trim().to_owned();
                links.push(ClassifiedLink {
                    category: LinkCategory::classify(canonical.path(), &text),
                    url: key,
                    text: text.chars().take(120).collect(),
                });
            }
            continue;
        }

        for (needle, network) in SOCIAL_HOSTS {
            if host == needle || host.ends_with(&format!(".{needle}")) {
                contact
                    .socials
                    .entry(network.to_owned())
                    .or_insert(absolute.clone());
            }
        }
        for needle in BOOKING_HOSTS {
            if host == needle || host.ends_with(&format!(".{needle}")) {
                booking.insert(absolute.clone());
            }
        }
    }

    contact.emails = emails.into_iter().collect();
    contact.phones = phones.into_iter().collect();
    contact.booking_links = booking.into_iter().collect();
    (contact, links)
}

/// Find email addresses printed as plain text.
///
/// Adopted from the browser-based crawl skill: plenty of sites print the
/// address rather than linking it, and reading only `mailto:` misses them
/// entirely. Deliberately conservative — a false address is worse than none,
/// because outreach would send to it.
fn emails_in_text(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    for token in text.split(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | '(' | ')' | ','))
    {
        let candidate = token
            .trim_matches(|c: char| !c.is_alphanumeric())
            .to_ascii_lowercase();
        let Some((local, domain)) = candidate.split_once('@') else {
            continue;
        };
        let plausible = !local.is_empty()
            && domain.contains('.')
            && !domain.starts_with('.')
            && !domain.ends_with('.')
            && domain
                .rsplit('.')
                .next()
                .is_some_and(|tld| tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic()))
            && candidate.len() <= 254
            && !candidate.contains("..");
        if plausible {
            found.push(candidate);
        }
    }
    found
}

/// Find phone numbers printed as plain text.
///
/// Requires a leading `+` or a run long enough to be a real number, so years,
/// prices and street numbers are not mistaken for phones.
fn phones_in_text(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let starts = chars[index] == '+' || chars[index].is_ascii_digit();
        if !starts {
            index += 1;
            continue;
        }
        let start = index;
        let mut digits = 0;
        let mut end = index;
        while end < chars.len() {
            let c = chars[end];
            if c.is_ascii_digit() {
                digits += 1;
                end += 1;
            } else if matches!(c, ' ' | '-' | '(' | ')' | '.') && digits > 0 {
                end += 1;
            } else if c == '+' && end == start {
                // A leading `+` is part of the number, so it must be consumed
                // before any digits exist — otherwise the scan restarts one
                // character in and silently drops the country prefix.
                end += 1;
            } else {
                break;
            }
            if digits > 15 {
                break;
            }
        }
        let raw: String = chars[start..end].iter().collect();
        let trimmed = raw.trim().trim_end_matches(['-', '.', ' ', '(', ')']);
        // E.164 allows up to 15 digits; fewer than 9 is not an international
        // number and is far more likely to be a price or a year.
        if (9..=15).contains(&digits) && (trimmed.starts_with('+') || digits >= 10) {
            found.push(trimmed.to_owned());
        }
        index = end.max(index + 1);
    }
    found
}

/// Readable text with scripts, styling and chrome removed.
/// Content images, excluding inline data URIs which carry no fetchable asset.
fn collect_images(document: &Html, base: &Url) -> Vec<String> {
    let mut seen = BTreeSet::new();
    for element in document.select(&selector("img[src]")) {
        let Some(src) = element.value().attr("src") else {
            continue;
        };
        if src.trim_start().starts_with("data:") {
            continue;
        }
        if let Some(absolute) = absolutize(base, src) {
            seen.insert(absolute);
        }
    }
    seen.into_iter().take(60).collect()
}

/// Tags whose contents are not readable text, however much text they contain.
///
/// A modern site ships its whole page state as JSON inside a `<script>` in the
/// body, and draws its icons as `<svg>` full of coordinates. Both look like
/// prose to a naive walk, and both then get mined for contact details: the
/// JSON yields "emails" like `dangerouslysetinnerhtml":{"__html":...` and the
/// path coordinates yield "phone numbers" like `2 2 0 0 1-2.009 0`. Those end
/// up in the brief an owner reads as if they were facts about the business.
const NON_PROSE_TAGS: &[&str] = &[
    "script", "style", "noscript", "svg", "template", "iframe", "canvas",
];

/// Values a page's schema.org markup states for one field.
///
/// Walks nested objects and arrays, since a business can publish its contact
/// details on the organization itself or on a nested `PostalAddress`, and both
/// are equally stated.
fn structured_strings(blocks: &[serde_json::Value], field: &str) -> Vec<String> {
    fn walk(value: &serde_json::Value, field: &str, found: &mut Vec<String>) {
        match value {
            serde_json::Value::Object(map) => {
                for (key, nested) in map {
                    if key.eq_ignore_ascii_case(field) {
                        match nested {
                            serde_json::Value::String(text) if !text.trim().is_empty() => {
                                found.push(text.trim().to_owned());
                            }
                            serde_json::Value::Array(items) => {
                                for item in items {
                                    if let Some(text) = item.as_str() {
                                        if !text.trim().is_empty() {
                                            found.push(text.trim().to_owned());
                                        }
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    walk(nested, field, found);
                }
            }
            serde_json::Value::Array(items) => {
                for item in items {
                    walk(item, field, found);
                }
            }
            _ => {}
        }
    }

    let mut found = Vec::new();
    for block in blocks {
        walk(block, field, &mut found);
    }
    found.sort();
    found.dedup();
    found.truncate(5);
    found
}

fn extract_text(document: &Html) -> String {
    let mut out = String::new();
    for element in document.select(&selector("body")) {
        for node in element.descendants() {
            let Some(text) = node.value().as_text() else {
                continue;
            };
            if node.ancestors().any(|ancestor| {
                ancestor
                    .value()
                    .as_element()
                    .is_some_and(|element| NON_PROSE_TAGS.contains(&element.name()))
            }) {
                continue;
            }
            let trimmed = text.trim();
            if trimmed.is_empty() {
                continue;
            }
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(trimmed);
        }
    }
    // scraper's text nodes already skip comments; strip the remaining runs.
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Extract every piece of evidence from one page of HTML.
pub fn extract_page(html: &str, page_url: &str) -> PageEvidence {
    extract_page_with_styles(html, page_url, "")
}

/// Absolute URLs of the stylesheets a page links, in document order.
///
/// Most modern sites keep their palette and fonts out of the HTML entirely,
/// so brand evidence has to reach the sheets to see it. Bounded by the
/// caller; this returns what the document declares.
pub fn stylesheet_hrefs(html: &str, page_url: &str) -> Vec<String> {
    let document = Html::parse_document(html);
    let base = Url::parse(page_url).ok();
    let mut hrefs: Vec<String> = Vec::new();
    for element in document.select(&selector(
        r#"link[rel="stylesheet"], link[rel~="stylesheet"]"#,
    )) {
        let Some(href) = element.value().attr("href") else {
            continue;
        };
        let Some(absolute) = base.as_ref().and_then(|base| absolutize(base, href)) else {
            continue;
        };
        if !hrefs.contains(&absolute) {
            hrefs.push(absolute);
        }
    }
    hrefs
}

/// [`extract_page`] with stylesheet text folded into brand extraction.
///
/// `extra_css` is treated exactly like an inline `<style>` block: colours and
/// font families found in it rank alongside everything else the page
/// declares. It carries no weight of its own.
pub fn extract_page_with_styles(html: &str, page_url: &str, extra_css: &str) -> PageEvidence {
    let document = Html::parse_document(html);
    let base = Url::parse(page_url).ok();
    let origin_host = base
        .as_ref()
        .and_then(|url| url.host_str())
        .map(|host| host.trim_start_matches("www.").to_ascii_lowercase())
        .unwrap_or_default();

    let mut evidence = PageEvidence {
        url: page_url.to_owned(),
        title: extract_title(&document, page_url),
        description: extract_description(&document, page_url),
        canonical_url: attr_of(&document, r#"link[rel="canonical"]"#, "href"),
        headings: document
            .select(&selector("h1, h2, h3"))
            .map(|element| element.text().collect::<String>().trim().to_owned())
            .filter(|heading| !heading.is_empty())
            .take(60)
            .collect(),
        text: extract_text(&document),
        structured_data: extract_structured_data(&document),
        ..PageEvidence::default()
    };

    if let Some(base) = base.as_ref() {
        evidence.brand = extract_brand(&document, base, page_url, extra_css);
        let (contact, links) = extract_contact_and_links(&document, base, &origin_host);
        evidence.contact = contact;
        evidence.links = links;
        evidence.images = collect_images(&document, base);
    }

    // Structured data next, before prose. A site that publishes schema.org
    // markup is telling us its own contact details rather than leaving them to
    // be recognised, and that is the strongest evidence available: exact, and
    // stated by the business itself.
    if evidence.contact.emails.is_empty() {
        let stated = structured_strings(&evidence.structured_data, "email");
        if !stated.is_empty() {
            evidence.contact.emails = stated;
        }
    }
    if evidence.contact.phones.is_empty() {
        let stated = structured_strings(&evidence.structured_data, "telephone");
        if !stated.is_empty() {
            evidence.contact.phones = stated;
        }
    }

    // Only fall back to scanning text when neither links nor structured data
    // said anything. A linked or declared address is stated; one scraped out of
    // prose is a guess, and mixing the two would hide which is which.
    if evidence.contact.emails.is_empty() {
        let mut scraped = emails_in_text(&evidence.text);
        scraped.sort();
        scraped.dedup();
        scraped.truncate(5);
        evidence.contact.emails = scraped;
        evidence.contact.emails_inferred = true;
    }
    if evidence.contact.phones.is_empty() {
        let mut scraped = phones_in_text(&evidence.text);
        scraped.sort();
        scraped.dedup();
        scraped.truncate(5);
        evidence.contact.phones = scraped;
        evidence.contact.phones_inferred = true;
    }

    // A shell with almost no text but plenty of script is a client-rendered
    // app. Saying so beats reporting an empty business.
    let script_count = document.select(&selector("script")).count();
    if evidence.text.len() < 200 && script_count > 0 && evidence.structured_data.is_empty() {
        evidence.warnings.push(
            "page rendered almost no text server-side; it is probably a client-rendered app"
                .to_owned(),
        );
    }
    evidence
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = r##"<!doctype html>
<html><head>
  <title>Horizon Labs — Web &amp; Brand Studio</title>
  <meta name="description" content="We build websites and brands for small teams.">
  <meta property="og:title" content="Horizon Labs">
  <meta property="og:image" content="/img/og-card.png">
  <meta name="theme-color" content="#1D9BF0">
  <link rel="canonical" href="https://horizonlabs.example/">
  <link rel="icon" href="/favicon.ico">
  <link rel="apple-touch-icon" href="/touch.png">
  <style>
    :root { --brand: #1d9bf0; --accent: #FF6B35; font-family: "Sohne", sans-serif; }
    .a { color: #ff6b35; } .b { border: 1px solid #ff6b35; } .c { background: #000000; }
  </style>
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Organization","name":"Horizon Labs",
     "email":"hi@horizonlabs.example","sameAs":["https://www.linkedin.com/company/horizon"]}
  </script>
</head>
<body>
  <img src="/img/logo.svg" alt="Horizon Labs logo">
  <h1>Websites that earn their keep</h1>
  <h2>Services</h2>
  <p>We design, build and maintain marketing sites.</p>
  <a href="/services/web-design">Web design</a>
  <a href="/pricing">Pricing</a>
  <a href="/about-us">About us</a>
  <a href="/work/acme">Case study: Acme</a>
  <a href="/careers">Join the team</a>
  <a href="/contact">Get in touch</a>
  <a href="/services/web-design#top">Web design again</a>
  <a href="mailto:hi@horizonlabs.example?subject=Hi">Email us</a>
  <a href="tel:+27115551234">Call us</a>
  <a href="https://www.linkedin.com/company/horizon">LinkedIn</a>
  <a href="https://x.com/horizon">X</a>
  <a href="https://calendly.com/horizon/intro">Book a call</a>
  <a href="https://partner.example/somewhere">A partner</a>
</body></html>"##;

    fn page() -> PageEvidence {
        extract_page(PAGE, "https://horizonlabs.example/")
    }

    #[test]
    fn opengraph_title_wins_over_the_document_title() {
        let evidence = page();
        let title = evidence.title.expect("title");
        assert_eq!(title.value, "Horizon Labs");
        assert_eq!(title.confidence, Confidence::Declared);
        assert_eq!(title.source_url, "https://horizonlabs.example/");
    }

    #[test]
    fn meta_description_and_canonical_are_captured() {
        let evidence = page();
        assert_eq!(
            evidence.description.expect("description").value,
            "We build websites and brands for small teams."
        );
        assert_eq!(
            evidence.canonical_url.as_deref(),
            Some("https://horizonlabs.example/")
        );
    }

    /// JSON-LD is the site's own machine-readable claim about itself — the
    /// highest-confidence evidence there is, and kept whole rather than
    /// flattened into our shapes.
    #[test]
    fn structured_data_is_captured_verbatim() {
        let evidence = page();
        assert_eq!(evidence.structured_data.len(), 1);
        let organization = &evidence.structured_data[0];
        assert_eq!(organization["@type"], "Organization");
        assert_eq!(organization["name"], "Horizon Labs");
        assert_eq!(organization["email"], "hi@horizonlabs.example");
    }

    #[test]
    fn logo_and_icons_are_absolutized_with_provenance() {
        let brand = page().brand;
        let logos: Vec<&str> = brand
            .logo_candidates
            .iter()
            .map(|c| c.value.as_str())
            .collect();
        assert!(logos.contains(&"https://horizonlabs.example/img/og-card.png"));
        assert!(logos.contains(&"https://horizonlabs.example/img/logo.svg"));
        // The declared OpenGraph image outranks the inferred <img> guess.
        assert_eq!(brand.logo_candidates[0].confidence, Confidence::Declared);

        let icons: Vec<&str> = brand
            .icon_candidates
            .iter()
            .map(|c| c.value.as_str())
            .collect();
        assert!(icons.contains(&"https://horizonlabs.example/favicon.ico"));
        assert!(icons.contains(&"https://horizonlabs.example/touch.png"));
    }

    /// theme-color is stated outright, so it leads. The rest are ranked by how
    /// often they appear, because a brand colour recurs and an accident does not.
    #[test]
    fn colors_prefer_the_declared_theme_then_the_most_repeated() {
        let brand = page().brand;
        let colors: Vec<&str> = brand.colors.iter().map(|c| c.value.as_str()).collect();
        assert_eq!(colors[0], "#1d9bf0");
        assert_eq!(brand.colors[0].confidence, Confidence::Declared);
        // #ff6b35 appears three times, more than any other inferred colour.
        assert_eq!(colors[1], "#ff6b35");
        // Pure black is chrome, not brand.
        assert!(!colors.contains(&"#000000"));
    }

    #[test]
    fn shorthand_and_alpha_hex_normalize_to_six_digits() {
        assert_eq!(normalize_hex("#ABC").as_deref(), Some("#aabbcc"));
        assert_eq!(normalize_hex("#1D9BF0").as_deref(), Some("#1d9bf0"));
        assert_eq!(normalize_hex("#1d9bf080").as_deref(), Some("#1d9bf0"));
        assert_eq!(normalize_hex("not-a-colour"), None);
        assert_eq!(normalize_hex("#12345"), None);
    }

    #[test]
    fn declared_font_family_is_captured() {
        assert_eq!(page().brand.fonts, vec!["Sohne".to_owned()]);
    }

    #[test]
    fn contact_routes_are_separated_by_kind() {
        let contact = page().contact;
        assert_eq!(contact.emails, vec!["hi@horizonlabs.example".to_owned()]);
        assert_eq!(contact.phones, vec!["+27115551234".to_owned()]);
        assert_eq!(
            contact.socials.get("linkedin").map(String::as_str),
            Some("https://www.linkedin.com/company/horizon")
        );
        // x.com and twitter.com are the same network.
        assert_eq!(
            contact.socials.get("twitter").map(String::as_str),
            Some("https://x.com/horizon")
        );
        assert_eq!(
            contact.booking_links,
            vec!["https://calendly.com/horizon/intro".to_owned()]
        );
    }

    #[test]
    fn links_are_same_origin_only_and_classified_by_purpose() {
        let links = page().links;
        let by_url = |needle: &str| {
            links
                .iter()
                .find(|link| link.url.contains(needle))
                .unwrap_or_else(|| panic!("expected a link containing {needle}"))
        };
        assert_eq!(by_url("/services/").category, LinkCategory::Services);
        assert_eq!(by_url("/pricing").category, LinkCategory::Pricing);
        assert_eq!(by_url("/about-us").category, LinkCategory::About);
        assert_eq!(by_url("/work/").category, LinkCategory::Work);
        assert_eq!(by_url("/careers").category, LinkCategory::Careers);
        assert_eq!(by_url("/contact").category, LinkCategory::Contact);

        // Off-origin links are never crawl candidates, only contact evidence.
        assert!(!links
            .iter()
            .any(|link| link.url.contains("partner.example")));
        assert!(!links.iter().any(|link| link.url.contains("linkedin.com")));
    }

    /// Found live: "Commercial Terms of Service" contains "service", so legal
    /// boilerplate classified as the highest-priority category and a 340 KB
    /// terms page consumed the byte budget ahead of the company page.
    #[test]
    fn terms_of_service_is_legal_not_a_services_page() {
        for (path, text) in [
            ("/legal/commercial-terms", "Commercial Terms of Service"),
            ("/legal/consumer-terms", "Consumer Terms of Service"),
            ("/privacy", "Privacy Policy"),
            ("/cookie-policy", "Cookies"),
            ("/legal/subprocessors", "Sub-processors"),
        ] {
            assert_eq!(
                LinkCategory::classify(path, text),
                LinkCategory::Legal,
                "{path} must be legal boilerplate, not a services page"
            );
        }
    }

    /// The fix must not swallow genuine services pages.
    #[test]
    fn real_services_pages_still_classify_as_services() {
        for (path, text) in [
            ("/services/web-design", "Web design"),
            ("/what-we-do", "What we do"),
            ("/solutions", "Solutions"),
            ("/products/analytics", "Analytics product"),
        ] {
            assert_eq!(
                LinkCategory::classify(path, text),
                LinkCategory::Services,
                "{path} is a real services page"
            );
        }
    }

    /// A fragment points at the same document, so following it would spend a
    /// page of the crawl budget re-reading what we already have.
    #[test]
    fn fragment_variants_collapse_to_one_crawl_target() {
        let links = page().links;
        let design = links
            .iter()
            .filter(|link| link.url.contains("/services/web-design"))
            .count();
        assert_eq!(design, 1);
        assert!(links.iter().all(|link| !link.url.contains('#')));
    }

    #[test]
    fn headings_and_text_survive_but_style_and_script_do_not() {
        let evidence = page();
        assert_eq!(evidence.headings[0], "Websites that earn their keep");
        assert!(evidence.text.contains("We design, build and maintain"));
        assert!(!evidence.text.contains("font-family"));
        assert!(!evidence.text.contains("schema.org"));
    }

    /// Reporting "we could not read this" is more useful than reporting an
    /// empty business.
    /// Adopted from the browser-based crawl skill: plenty of sites print the
    /// address instead of linking it, and reading only `mailto:` misses them.
    #[test]
    fn plain_text_contact_details_are_found_when_no_links_exist() {
        let html = r#"<!doctype html><html><body>
            <p>Reach us on +27 11 555 1234 or hello@studio.example any weekday.</p>
            <p>We have been trading since 1998 and charge from 4500 per project.</p>
        </body></html>"#;
        let evidence = extract_page(html, "https://studio.example/");

        assert_eq!(evidence.contact.emails, vec!["hello@studio.example"]);
        assert_eq!(evidence.contact.phones, vec!["+27 11 555 1234"]);
        // Scraped from prose, so marked as inferred rather than stated.
        assert!(evidence.contact.emails_inferred);
        assert!(evidence.contact.phones_inferred);
        // A year and a price must not be mistaken for phone numbers.
        assert!(!evidence.contact.phones.iter().any(|p| p.contains("1998")));
        assert!(!evidence.contact.phones.iter().any(|p| p.contains("4500")));
    }

    /// A linked address is stated; one scraped from prose is a guess. Mixing
    /// them would hide which is which, so links always win outright.
    #[test]
    fn linked_contacts_win_and_are_not_marked_inferred() {
        let contact = page().contact;
        assert_eq!(contact.emails, vec!["hi@horizonlabs.example".to_owned()]);
        assert!(!contact.emails_inferred);
        assert!(!contact.phones_inferred);
    }

    /// Stylesheets mix notations freely; counting `rgb(29,155,240)` separately
    /// from `#1d9bf0` would split the ranking and bury the real brand colour.
    #[test]
    fn rgb_and_hex_notations_are_counted_as_one_colour() {
        let html = r##"<!doctype html><html><head><style>
            .a { color: rgb(29, 155, 240); }
            .b { background: rgba(29,155,240,0.5); }
            .c { border-color: #1d9bf0; }
            .d { color: #ff0000; }
        </style></head><body><p>x</p></body></html>"##;
        let evidence = extract_page(html, "https://example.com/");
        let colors: Vec<&str> = evidence
            .brand
            .colors
            .iter()
            .map(|c| c.value.as_str())
            .collect();
        // Three occurrences across two notations beat the single red.
        assert_eq!(colors.first(), Some(&"#1d9bf0"));
        assert!(colors.contains(&"#ff0000"));
    }

    /// Page chrome is near-grey whatever framework produced it. Measuring
    /// chroma generalizes the crawl skill's hard-coded Tailwind grey list.
    #[test]
    fn greys_and_near_greys_are_not_brand_colours() {
        for grey in [
            "#000000", "#ffffff", "#f9fafb", "#f3f4f6", "#e5e7eb", "#111111", "#808080",
        ] {
            assert!(
                is_near_grey(grey),
                "{grey} must not count as a brand colour"
            );
        }
        for brand in ["#1d9bf0", "#ff6b35", "#7c3aed"] {
            assert!(!is_near_grey(brand), "{brand} is a brand colour");
        }
    }

    #[test]
    fn content_images_are_collected_without_data_uris() {
        let html = r#"<!doctype html><html><body>
            <img src="/photo.jpg"><img src="data:image/gif;base64,R0lGOD">
        </body></html>"#;
        let evidence = extract_page(html, "https://example.com/");
        assert_eq!(evidence.images, vec!["https://example.com/photo.jpg"]);
    }

    #[test]
    fn a_client_rendered_shell_is_reported_rather_than_read_as_empty() {
        let shell = r#"<!doctype html><html><head><title>App</title></head>
            <body><div id="root"></div><script src="/app.js"></script></body></html>"#;
        let evidence = extract_page(shell, "https://app.example/");
        assert!(
            evidence
                .warnings
                .iter()
                .any(|warning| warning.contains("client-rendered")),
            "warnings: {:?}",
            evidence.warnings
        );
    }

    #[test]
    fn a_server_rendered_page_carries_no_client_render_warning() {
        assert!(page().warnings.is_empty());
    }

    /// A real site's own markup, reduced to the shape that broke the scan.
    ///
    /// Every one of these came from scanning a live business: the page state
    /// shipped as JSON inside a body script, icons drawn as SVG coordinates,
    /// and the actual contact details published only as schema.org markup.
    const NEXT_JS_PAGE: &str = r##"<html><head>
        <script type="application/ld+json">
        {"@context":"https://schema.org","@type":"ProfessionalService",
         "name":"Horizon Labs","email":"hello@horizonlabs.co.za",
         "telephone":"+27683735905",
         "address":{"@type":"PostalAddress","addressCountry":"ZA"}}
        </script></head>
        <body>
        <h1>See your new website before you pay for it.</h1>
        <p>Live in 5 business days.</p>
        <svg><path d="M2 2 0 0 1-2.009 0c-1 22 7-8.991 5.727"/></svg>
        <script>self.__next_f.push([1,"{\\\"email\\\":\\\"hello@horizonlabs.co.za\\\"}"])</script>
        <style>.a{content:"7 8 9 0 1 2 3 4 5"}</style>
        </body></html>"##;

    /// Script payloads and SVG coordinates are not prose, however much text
    /// they contain. Mining them yielded "emails" like
    /// `dangerouslysetinnerhtml":{"__html":...` and "phone numbers" like
    /// `2 2 0 0 1-2.009 0`, which then read as facts about the business.
    #[test]
    fn script_and_svg_content_is_not_treated_as_readable_text() {
        let evidence = extract_page(NEXT_JS_PAGE, "https://example.test/");

        assert!(evidence.text.contains("See your new website"));
        assert!(evidence.text.contains("Live in 5 business days"));
        assert!(
            !evidence.text.contains("__next_f"),
            "a body script is not readable text"
        );
        assert!(
            !evidence.text.contains("M2 2 0 0 1-2.009"),
            "svg path coordinates are not readable text"
        );
        assert!(
            !evidence.text.contains("content:"),
            "css is not readable text"
        );
    }

    /// A business that publishes schema.org markup is stating its contact
    /// details rather than leaving them to be recognised, so that is what gets
    /// reported, and it is reported as stated rather than inferred.
    #[test]
    fn contact_details_come_from_the_markup_the_business_published() {
        let evidence = extract_page(NEXT_JS_PAGE, "https://example.test/");

        assert_eq!(evidence.contact.emails, ["hello@horizonlabs.co.za"]);
        assert_eq!(evidence.contact.phones, ["+27683735905"]);
        assert!(
            !evidence.contact.emails_inferred,
            "a stated address is not a guess"
        );
        assert!(!evidence.contact.phones_inferred);
    }

    /// Nested objects count. A business can publish its details on itself or
    /// on a nested address, and both are equally stated.
    #[test]
    fn structured_values_are_found_however_deeply_they_are_nested() {
        let blocks = vec![serde_json::json!({
            "@type": "Organization",
            "subOrganization": {
                "@type": "Organization",
                "contactPoint": [{"telephone": "+27110000000"}],
            },
        })];
        assert_eq!(structured_strings(&blocks, "telephone"), ["+27110000000"]);
        assert!(structured_strings(&blocks, "email").is_empty());
    }

    #[test]
    fn stylesheet_hrefs_are_absolute_and_deduplicated() {
        let html = r#"<html><head>
            <link rel="stylesheet" href="/assets/site.css">
            <link rel="stylesheet" href="https://cdn.example.test/theme.css">
            <link rel="stylesheet" href="/assets/site.css">
            <link rel="icon" href="/favicon.ico">
        </head></html>"#;
        assert_eq!(
            stylesheet_hrefs(html, "https://acme.test/home"),
            vec![
                "https://acme.test/assets/site.css".to_owned(),
                "https://cdn.example.test/theme.css".to_owned(),
            ]
        );
    }

    /// Brand evidence must reach colours that live only in a linked sheet.
    #[test]
    fn extra_css_feeds_brand_extraction() {
        let evidence = extract_page_with_styles(
            "<html><body>hi</body></html>",
            "https://acme.test/",
            ":root { --brand: #c026d3; font-family: \"Sohne\", sans-serif; }",
        );
        assert_eq!(
            evidence
                .brand
                .colors
                .first()
                .map(|colour| colour.value.clone()),
            Some("#c026d3".to_owned())
        );
        assert_eq!(evidence.brand.fonts, ["Sohne"]);
    }
}
