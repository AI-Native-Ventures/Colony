//! Sitemap and robots.txt reading.
//!
//! A sitemap is the site's own inventory of its pages, so it beats guessing
//! from navigation links: it reaches pages the homepage never links, and it
//! reports last-modified dates, which is how a scan knows what is current
//! rather than abandoned.
//!
//! It is also entirely attacker-controlled. A hostile site can list internal
//! addresses, thousands of entries, or point at another host — so parsing here
//! only ever *proposes* URLs. Every one still passes the SSRF guard and the
//! same-origin check before it is fetched, and the entry count is capped so a
//! sitemap bomb cannot exhaust the crawl budget or memory.

use std::collections::BTreeSet;

use url::Url;

/// Hard ceiling on entries taken from one sitemap document.
///
/// The sitemap protocol permits 50,000 URLs. Accepting that many from an
/// untrusted document would let one site dictate our memory use, and no
/// company brief needs more than a few dozen pages of evidence.
pub const MAX_SITEMAP_ENTRIES: usize = 200;

/// A page the site says it has.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SitemapEntry {
    /// Absolute URL as listed.
    pub url: String,
    /// `<lastmod>` verbatim, when present — evidence of freshness.
    pub last_modified: Option<String>,
}

/// Extract sitemap URLs advertised by robots.txt.
///
/// Sites commonly point at a sitemap that lives somewhere other than the
/// conventional `/sitemap.xml`, and robots.txt is where they say so.
pub fn sitemap_urls_in_robots(robots: &str, base: &Url) -> Vec<String> {
    let mut found = BTreeSet::new();
    for line in robots.lines().take(1_000) {
        let line = line.trim();
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if !key.trim().eq_ignore_ascii_case("sitemap") {
            continue;
        }
        if let Ok(url) = base.join(value.trim()) {
            if url.scheme() == "https" {
                found.insert(url.to_string());
            }
        }
    }
    found.into_iter().take(10).collect()
}

/// Parse a sitemap or sitemap index.
///
/// Handles both because the two share a shape and a site may serve either at
/// the conventional path. Returns `(page entries, nested sitemap URLs)`.
///
/// Deliberately a small hand-rolled reader rather than a full XML parser: the
/// input is untrusted, and a strict `<loc>`/`<lastmod>` scan cannot be steered
/// into entity expansion or external DTD fetches the way a general parser can.
pub fn parse_sitemap(xml: &str) -> (Vec<SitemapEntry>, Vec<String>) {
    let is_index = xml.contains("<sitemapindex");
    let mut entries = Vec::new();
    let mut nested = Vec::new();
    let mut seen = BTreeSet::new();

    for block in xml
        .split("<url")
        .skip(1)
        .chain(xml.split("<sitemap").skip(1))
    {
        let Some(loc) = tag_text(block, "loc") else {
            continue;
        };
        let loc = loc.trim().to_owned();
        if loc.is_empty() || !seen.insert(loc.clone()) {
            continue;
        }
        if is_index && block_is_nested_sitemap(block) {
            if nested.len() < 10 {
                nested.push(loc);
            }
            continue;
        }
        if entries.len() >= MAX_SITEMAP_ENTRIES {
            break;
        }
        entries.push(SitemapEntry {
            url: loc,
            last_modified: tag_text(block, "lastmod").map(|value| value.trim().to_owned()),
        });
    }
    (entries, nested)
}

/// Whether this block came from the `<sitemap>` split rather than `<url>`.
fn block_is_nested_sitemap(block: &str) -> bool {
    // A `<sitemap>` entry is closed by `</sitemap>`; a `<url>` entry is not.
    block.find("</sitemap>").is_some_and(|close| {
        block
            .find("</url>")
            .is_none_or(|url_close| close < url_close)
    })
}

fn tag_text(block: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = block.find(&open)? + open.len();
    let end = block[start..].find(&close)? + start;
    let raw = &block[start..end];
    Some(decode_entities(raw))
}

/// Decode the five XML predefined entities.
///
/// Only these five: a sitemap needs nothing more, and refusing numeric and
/// custom entities keeps expansion attacks out by construction.
fn decode_entities(raw: &str) -> String {
    raw.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_urlset_yields_pages_with_freshness() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/</loc><lastmod>2026-01-04</lastmod></url>
  <url><loc>https://example.com/services</loc></url>
  <url><loc>https://example.com/a?x=1&amp;y=2</loc></url>
</urlset>"#;
        let (entries, nested) = parse_sitemap(xml);

        assert!(nested.is_empty());
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].url, "https://example.com/");
        assert_eq!(entries[0].last_modified.as_deref(), Some("2026-01-04"));
        assert_eq!(entries[1].last_modified, None);
        // Entities decode, so the URL is the one the site meant.
        assert_eq!(entries[2].url, "https://example.com/a?x=1&y=2");
    }

    #[test]
    fn a_sitemap_index_yields_nested_documents_not_pages() {
        let xml = r#"<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sitemap-posts.xml</loc></sitemap>
</sitemapindex>"#;
        let (entries, nested) = parse_sitemap(xml);

        assert!(entries.is_empty());
        assert_eq!(
            nested,
            vec![
                "https://example.com/sitemap-pages.xml".to_owned(),
                "https://example.com/sitemap-posts.xml".to_owned()
            ]
        );
    }

    /// The protocol permits 50,000 URLs. Accepting that from an untrusted
    /// document would let one site dictate our memory use.
    #[test]
    fn an_oversized_sitemap_is_capped_rather_than_trusted() {
        let mut xml = String::from("<urlset>");
        for index in 0..5_000 {
            xml.push_str(&format!(
                "<url><loc>https://example.com/p{index}</loc></url>"
            ));
        }
        xml.push_str("</urlset>");

        let (entries, _) = parse_sitemap(&xml);
        assert_eq!(entries.len(), MAX_SITEMAP_ENTRIES);
    }

    /// Parsing only ever proposes URLs. A sitemap listing internal addresses
    /// or another host is parsed without complaint — the SSRF guard and the
    /// same-origin check are what refuse them before any fetch.
    #[test]
    fn hostile_entries_are_returned_for_the_guard_to_reject_not_silently_kept() {
        let xml = r#"<urlset>
  <url><loc>https://example.com/ok</loc></url>
  <url><loc>http://169.254.169.254/latest/meta-data/</loc></url>
  <url><loc>https://evil.example/steal</loc></url>
</urlset>"#;
        let (entries, _) = parse_sitemap(xml);
        assert_eq!(entries.len(), 3);

        // Proof that the guard is what stops them.
        let seed =
            crate::company_scan::url_guard::check_url_shape("https://example.com/").expect("seed");
        assert!(crate::company_scan::url_guard::check_redirect(&entries[1].url, &seed).is_err());
        assert!(crate::company_scan::url_guard::check_redirect(&entries[2].url, &seed).is_err());
        assert!(crate::company_scan::url_guard::check_redirect(&entries[0].url, &seed).is_ok());
    }

    #[test]
    fn duplicate_locations_collapse() {
        let xml = r#"<urlset>
  <url><loc>https://example.com/a</loc></url>
  <url><loc>https://example.com/a</loc></url>
</urlset>"#;
        let (entries, _) = parse_sitemap(xml);
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn robots_advertises_sitemaps_wherever_they_live() {
        let base = Url::parse("https://example.com/").expect("base");
        let robots = "User-agent: *\nDisallow: /admin\nSitemap: https://example.com/custom-sitemap.xml\nsitemap: /also-here.xml\n";
        let found = sitemap_urls_in_robots(robots, &base);

        assert_eq!(
            found,
            vec![
                "https://example.com/also-here.xml".to_owned(),
                "https://example.com/custom-sitemap.xml".to_owned(),
            ]
        );
    }

    #[test]
    fn robots_without_a_sitemap_yields_nothing() {
        let base = Url::parse("https://example.com/").expect("base");
        assert!(sitemap_urls_in_robots("User-agent: *\nDisallow:\n", &base).is_empty());
    }

    /// A general XML parser can be steered into entity expansion; this reader
    /// decodes exactly the five predefined entities and nothing else.
    #[test]
    fn custom_and_numeric_entities_are_left_untouched() {
        let xml = r#"<urlset><url><loc>https://example.com/&bomb;&#88;</loc></url></urlset>"#;
        let (entries, _) = parse_sitemap(xml);
        assert_eq!(entries[0].url, "https://example.com/&bomb;&#88;");
    }
}
