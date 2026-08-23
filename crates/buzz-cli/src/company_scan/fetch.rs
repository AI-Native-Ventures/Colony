//! The bounded fetch loop.
//!
//! Ties the guard and the extractors together under budgets that hold whatever
//! the scanned site does. A company scan is a background action taken on a
//! user's behalf, so it must terminate: an unbounded crawl of a hostile or
//! merely enormous site would hang the Chief of Staff mid-conversation.
//!
//! Three properties this file is responsible for:
//!
//! 1. **Every request is re-validated.** Redirects are followed manually, one
//!    hop at a time, each through the same guard as the seed.
//! 2. **Addresses are pinned.** The host is resolved once, checked, and the
//!    resolved address is handed to the connector — so a name cannot answer
//!    safely for the check and dangerously for the connection.
//! 3. **Bodies are capped while streaming.** The limit is enforced chunk by
//!    chunk, before the whole response is in memory, so a declared-small
//!    response that streams forever cannot exhaust it.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::time::Instant;

use super::extract::{extract_page_with_styles, LinkCategory, PageEvidence};
use super::sitemap::{parse_sitemap, sitemap_urls_in_robots};
use super::url_guard::{check_redirect, check_url_shape, resolve_public, CheckedUrl, UrlRejection};

/// Budgets for one scan.
///
/// Defaults are deliberately larger than a minimal scan — a company brief is
/// only as good as the evidence behind it — but every one is a hard ceiling,
/// not a target, and the total byte and time budgets bound the whole run
/// regardless of how the per-page numbers are set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanLimits {
    /// Most pages fetched in one scan.
    pub max_pages: usize,
    /// Most redirect hops followed for a single page.
    pub max_redirects: usize,
    /// Most bytes read from one response.
    pub max_page_bytes: usize,
    /// Most bytes read across the whole scan.
    pub max_total_bytes: usize,
    /// Timeout for one request.
    pub request_timeout: Duration,
    /// Wall-clock ceiling for the whole scan.
    pub total_timeout: Duration,
}

impl Default for ScanLimits {
    fn default() -> Self {
        Self {
            max_pages: 25,
            max_redirects: 5,
            max_page_bytes: 2 * 1024 * 1024,
            max_total_bytes: 16 * 1024 * 1024,
            request_timeout: Duration::from_secs(10),
            total_timeout: Duration::from_secs(60),
        }
    }
}

/// Absolute ceilings a caller cannot raise.
///
/// `--max-pages` is user input, and user input that sets a resource bound has
/// to have a bound of its own.
pub const HARD_MAX_PAGES: usize = 60;

impl ScanLimits {
    /// Clamp caller-supplied values into the permitted range.
    pub fn with_max_pages(mut self, pages: usize) -> Self {
        self.max_pages = pages.clamp(1, HARD_MAX_PAGES);
        self
    }
}

/// Why a scan produced nothing usable.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ScanError {
    /// The supplied URL was refused before any request.
    #[error("{0}")]
    Rejected(#[from] UrlRejection),
    /// The site could not be reached at all.
    #[error("could not reach {url}: {reason}")]
    Unreachable {
        /// URL that failed.
        url: String,
        /// Display-safe reason.
        reason: String,
    },
    /// The site was reachable but served no readable page.
    #[error("no readable pages were found at {0}")]
    NoReadablePages(String),
}

/// Everything one scan collected.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyScanResult {
    /// URL as supplied.
    pub requested_url: String,
    /// URL after redirects, which is what the site considers canonical.
    pub canonical_url: String,
    /// Evidence from each page read, in fetch order.
    pub pages: Vec<PageEvidence>,
    /// Same-origin URLs discovered but not fetched, because a budget ran out.
    pub not_fetched: Vec<String>,
    /// Notes about what could not be read, and why.
    pub warnings: Vec<String>,
    /// Budgets this scan ran under.
    pub limits: ScanLimits,
    /// Total bytes read.
    pub bytes_read: usize,
}

/// What a single successful fetch produced.
struct Fetched {
    final_url: CheckedUrl,
    body: String,
    bytes: usize,
}

const USER_AGENT: &str = "ColonyCompanyScanner/1 (+https://colony.ainative.ventures)";

/// Fetch one URL, following redirects manually and re-validating every hop.
async fn fetch_once(
    target: &CheckedUrl,
    limits: &ScanLimits,
    remaining_bytes: usize,
) -> Result<Fetched, ScanError> {
    let mut current = target.clone();

    for _hop in 0..=limits.max_redirects {
        let addresses = resolve_public(&current).await?;

        // Pin the checked addresses onto the client so the connector cannot
        // re-resolve the name to something else. This is what closes the DNS
        // rebinding window between validation and connection.
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(limits.request_timeout)
            .user_agent(USER_AGENT);
        for address in &addresses {
            builder = builder.resolve(&current.host, *address);
        }
        let client = builder.build().map_err(|error| ScanError::Unreachable {
            url: current.url.to_string(),
            reason: error.to_string(),
        })?;

        let response = client
            .get(current.url.clone())
            .send()
            .await
            .map_err(|error| ScanError::Unreachable {
                url: current.url.to_string(),
                reason: error.to_string(),
            })?;

        let status = response.status();
        if status.is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| ScanError::Unreachable {
                    url: current.url.to_string(),
                    reason: "redirect without a location".to_owned(),
                })?
                .to_owned();
            current = check_redirect(&location, &current)?;
            continue;
        }

        if !status.is_success() {
            return Err(ScanError::Unreachable {
                url: current.url.to_string(),
                reason: format!("HTTP {}", status.as_u16()),
            });
        }

        // Content-Type is a hint, not a promise, so the body cap below is what
        // actually protects us — but skipping obvious binaries early avoids
        // spending budget on an image.
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let readable = content_type.is_empty()
            || content_type.contains("text/html")
            || content_type.contains("application/xhtml")
            || content_type.contains("text/plain")
            || content_type.contains("xml");
        if !readable {
            return Err(ScanError::Unreachable {
                url: current.url.to_string(),
                reason: format!("unreadable content type `{content_type}`"),
            });
        }

        let cap = limits.max_page_bytes.min(remaining_bytes);
        let (body, bytes) = read_capped(response, cap).await?;
        return Ok(Fetched {
            final_url: current,
            body,
            bytes,
        });
    }

    Err(ScanError::Unreachable {
        url: target.url.to_string(),
        reason: format!("more than {} redirects", limits.max_redirects),
    })
}

/// Read a response body, stopping at `cap` bytes.
///
/// Enforced per chunk rather than by trusting `Content-Length`, because a
/// response can declare a small length and then stream indefinitely.
async fn read_capped(
    mut response: reqwest::Response,
    cap: usize,
) -> Result<(String, usize), ScanError> {
    let url = response.url().to_string();
    let mut buffer: Vec<u8> = Vec::new();
    loop {
        let chunk = response
            .chunk()
            .await
            .map_err(|error| ScanError::Unreachable {
                url: url.clone(),
                reason: error.to_string(),
            })?;
        let Some(chunk) = chunk else { break };
        let room = cap.saturating_sub(buffer.len());
        if room == 0 {
            break;
        }
        let take = room.min(chunk.len());
        buffer.extend_from_slice(&chunk[..take]);
        if buffer.len() >= cap {
            break;
        }
    }
    let bytes = buffer.len();
    Ok((String::from_utf8_lossy(&buffer).into_owned(), bytes))
}

/// Fetch a stylesheet the scanned site links, as text.
///
/// Unlike pages, sheets are frequently served from a CDN on another origin,
/// so this validates the URL's shape and public reachability without a
/// same-origin requirement. Every redirect hop is still re-validated, and the
/// body is still capped while streaming.
async fn fetch_stylesheet(
    raw_url: &str,
    limits: &ScanLimits,
) -> Result<(String, usize), ScanError> {
    let mut current = check_url_shape(raw_url)?;

    for _hop in 0..=limits.max_redirects {
        let addresses = resolve_public(&current).await?;

        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(limits.request_timeout)
            .user_agent(USER_AGENT);
        for address in &addresses {
            builder = builder.resolve(&current.host, *address);
        }
        let client = builder.build().map_err(|error| ScanError::Unreachable {
            url: current.url.to_string(),
            reason: error.to_string(),
        })?;

        let response = client
            .get(current.url.clone())
            .send()
            .await
            .map_err(|error| ScanError::Unreachable {
                url: current.url.to_string(),
                reason: error.to_string(),
            })?;

        let status = response.status();
        if status.is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| ScanError::Unreachable {
                    url: current.url.to_string(),
                    reason: "redirect without a location".to_owned(),
                })?
                .to_owned();
            current = check_redirect(&location, &current)?;
            continue;
        }
        if !status.is_success() {
            return Err(ScanError::Unreachable {
                url: current.url.to_string(),
                reason: format!("HTTP {}", status.as_u16()),
            });
        }
        return read_capped(response, limits.max_page_bytes.min(512 * 1024)).await;
    }

    Err(ScanError::Unreachable {
        url: raw_url.to_owned(),
        reason: format!("more than {} redirects", limits.max_redirects),
    })
}

/// Fetch up to [`MAX_STYLESHEETS_PER_PAGE`] linked sheets and concatenate
/// their CSS, charging every byte to the scan's total budget.
///
/// Failures are silent here by design: a sheet that will not load is one
/// fewer colour source, not a broken scan.
async fn stylesheets_for(
    html: &str,
    page_url: &str,
    limits: &ScanLimits,
    seen: &mut std::collections::BTreeSet<String>,
    result: &mut CompanyScanResult,
) -> String {
    const MAX_STYLESHEETS_PER_PAGE: usize = 3;
    let mut css = String::new();
    for href in super::extract::stylesheet_hrefs(html, page_url)
        .into_iter()
        .take(MAX_STYLESHEETS_PER_PAGE)
    {
        if css.len() >= 512 * 1024 || result.bytes_read >= limits.max_total_bytes {
            break;
        }
        if !seen.insert(href.clone()) {
            continue;
        }
        if let Ok((text, bytes)) = fetch_stylesheet(&href, limits).await {
            result.bytes_read += bytes;
            css.push_str(&text);
            css.push('\n');
        }
    }
    css
}

/// Order pages so the most informative are read before a budget runs out.
///
/// Services and pricing first because they become the company's services and
/// cost centres; a scan truncated after five pages should have spent them on
/// what the business sells, not on a blog index.
fn crawl_priority(category: LinkCategory) -> u8 {
    match category {
        LinkCategory::Services => 0,
        LinkCategory::Pricing => 1,
        LinkCategory::About => 2,
        LinkCategory::Work => 3,
        LinkCategory::Contact => 4,
        LinkCategory::Careers => 5,
        LinkCategory::Other => 6,
        // Read last, if at all. A single terms page can be 340 KB of text that
        // says nothing about what the business sells.
        LinkCategory::Legal => 7,
    }
}

/// How many path segments deep a URL is.
///
/// Used only to break ties within a crawl category, so a section page outranks
/// the leaves beneath it.
fn path_depth(url: &str) -> usize {
    url::Url::parse(url)
        .map(|parsed| {
            parsed
                .path_segments()
                .map(|segments| segments.filter(|segment| !segment.is_empty()).count())
                .unwrap_or(0)
        })
        .unwrap_or(usize::MAX)
}

/// Fetch one page and return its raw body.
///
/// The claim verifier's transport: a single guarded GET with the same
/// properties as a scan — the URL shape check, redirects re-validated hop by
/// hop, resolved addresses pinned against DNS rebinding, and the body capped
/// while streaming. No crawl, no extraction; the caller gets the bytes and
/// isolates what it needs.
pub async fn fetch_page(raw_url: &str, limits: ScanLimits) -> Result<String, ScanError> {
    let seed = check_url_shape(raw_url)?;
    let fetched = fetch_once(&seed, &limits, limits.max_page_bytes).await?;
    Ok(fetched.body)
}

/// Scan a company website and return the evidence collected.
pub async fn scan_site(raw_url: &str, limits: ScanLimits) -> Result<CompanyScanResult, ScanError> {
    let started = Instant::now();
    let seed = check_url_shape(raw_url)?;

    let mut result = CompanyScanResult {
        requested_url: raw_url.trim().to_owned(),
        canonical_url: seed.url.to_string(),
        limits,
        ..CompanyScanResult::default()
    };

    // The homepage must succeed; without it there is no scan and no origin to
    // anchor same-origin checks against.
    let home = fetch_once(&seed, &limits, limits.max_total_bytes).await?;
    result.canonical_url = home.final_url.url.to_string();
    result.bytes_read += home.bytes;
    let origin = home.final_url.clone();
    let mut seen_sheets: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let canonical = result.canonical_url.clone();
    let home_css = stylesheets_for(
        &home.body,
        &canonical,
        &limits,
        &mut seen_sheets,
        &mut result,
    )
    .await;
    let home_evidence = extract_page_with_styles(&home.body, &canonical, &home_css);

    let mut queue: Vec<(u8, usize, String)> = home_evidence
        .links
        .iter()
        .map(|link| {
            (
                crawl_priority(link.category),
                path_depth(&link.url),
                link.url.clone(),
            )
        })
        .collect();
    let home_url = result.canonical_url.clone();
    result.pages.push(home_evidence);

    // The site's own inventory reaches pages navigation never links.
    for discovered in discover_from_sitemap(&origin, &limits, &mut result).await {
        let depth = path_depth(&discovered);
        queue.push((crawl_priority(LinkCategory::Other), depth, discovered));
    }

    // Shallower first within a category. A sitemap lists every leaf a site
    // has, all of them uncategorised, and sorting those by URL alone lets one
    // deep branch that happens to sort early take the whole budget: scanning a
    // real site spent twenty of twenty-five pages on add-on detail pages and
    // never reached the rest. What a business does is described near its root.
    queue.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then(left.1.cmp(&right.1))
            .then(left.2.cmp(&right.2))
    });
    queue.dedup_by(|left, right| left.2 == right.2);
    let mut seen: std::collections::BTreeSet<String> =
        result.pages.iter().map(|page| page.url.clone()).collect();
    // The homepage is already read; the sitemap almost always lists it again.
    seen.insert(home_url);

    for (_, _, candidate) in queue {
        if result.pages.len() >= limits.max_pages {
            result.not_fetched.push(candidate);
            continue;
        }
        if result.bytes_read >= limits.max_total_bytes {
            result.not_fetched.push(candidate);
            continue;
        }
        if started.elapsed() >= limits.total_timeout {
            result.not_fetched.push(candidate);
            continue;
        }
        if !seen.insert(candidate.clone()) {
            continue;
        }

        // Every discovered URL is site-controlled, so it goes through the same
        // guard and same-origin check as a redirect would.
        let checked = match check_redirect(&candidate, &origin) {
            Ok(checked) => checked,
            Err(_) => continue,
        };
        let remaining = limits.max_total_bytes.saturating_sub(result.bytes_read);
        match fetch_once(&checked, &limits, remaining).await {
            Ok(fetched) => {
                result.bytes_read += fetched.bytes;
                let url = fetched.final_url.url.to_string();
                // Dedupe on where the fetch landed, not where it was aimed. A
                // site that redirects several URLs to one page would otherwise
                // spend the budget reading that page again and again; the
                // homepage came back twice in a real scan for exactly this
                // reason.
                // The candidate is already in `seen`; only a redirect can make
                // this land somewhere else, and only then is there anything to
                // check. A site that points several URLs at one page would
                // otherwise spend the budget reading it again and again, which
                // is how the homepage came back twice in a real scan.
                let landed_elsewhere = url != candidate;
                if !landed_elsewhere || seen.insert(url.clone()) {
                    let css = stylesheets_for(
                        &fetched.body,
                        &url,
                        &limits,
                        &mut seen_sheets,
                        &mut result,
                    )
                    .await;
                    result
                        .pages
                        .push(extract_page_with_styles(&fetched.body, &url, &css));
                }
            }
            Err(error) => result.warnings.push(format!("{candidate}: {error}")),
        }
    }

    if !result.not_fetched.is_empty() {
        result.warnings.push(format!(
            "stopped after {} pages and {} bytes; {} discovered pages were not read",
            result.pages.len(),
            result.bytes_read,
            result.not_fetched.len()
        ));
    }
    if result.pages.iter().all(|page| page.text.len() < 200) {
        result.warnings.push(
            "the site served almost no readable text; it may require JavaScript to render"
                .to_owned(),
        );
    }
    Ok(result)
}

/// Read robots.txt and any sitemaps it advertises, plus the conventional path.
///
/// Failures here are not scan failures — most sites have no sitemap, and that
/// is ordinary rather than an error.
async fn discover_from_sitemap(
    origin: &CheckedUrl,
    limits: &ScanLimits,
    result: &mut CompanyScanResult,
) -> Vec<String> {
    let mut sitemap_urls = Vec::new();

    if let Ok(robots_url) = origin.url.join("/robots.txt") {
        if let Ok(checked) = check_url_shape(robots_url.as_str()) {
            if let Ok(fetched) = fetch_once(&checked, limits, 512 * 1024).await {
                result.bytes_read += fetched.bytes;
                sitemap_urls.extend(sitemap_urls_in_robots(&fetched.body, &origin.url));
            }
        }
    }
    if let Ok(conventional) = origin.url.join("/sitemap.xml") {
        sitemap_urls.push(conventional.to_string());
    }

    let mut discovered = Vec::new();
    for sitemap_url in sitemap_urls.into_iter().take(4) {
        let Ok(checked) = check_url_shape(&sitemap_url) else {
            continue;
        };
        if checked.origin_key() != origin.origin_key() {
            continue;
        }
        let Ok(fetched) = fetch_once(&checked, limits, 2 * 1024 * 1024).await else {
            continue;
        };
        result.bytes_read += fetched.bytes;
        let (entries, _nested) = parse_sitemap(&fetched.body);
        discovered.extend(entries.into_iter().map(|entry| entry.url));
    }
    discovered
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caller_supplied_page_counts_cannot_exceed_the_hard_ceiling() {
        // A user-supplied resource bound needs a bound of its own.
        assert_eq!(
            ScanLimits::default().with_max_pages(10_000).max_pages,
            HARD_MAX_PAGES
        );
        assert_eq!(ScanLimits::default().with_max_pages(0).max_pages, 1);
        assert_eq!(ScanLimits::default().with_max_pages(12).max_pages, 12);
    }

    /// A truncated scan should have spent its budget on what the business
    /// sells, not on a blog index.
    #[test]
    fn the_most_informative_pages_are_read_first() {
        let mut categories = vec![
            LinkCategory::Other,
            LinkCategory::Careers,
            LinkCategory::Pricing,
            LinkCategory::Services,
            LinkCategory::About,
            LinkCategory::Work,
            LinkCategory::Contact,
            LinkCategory::Legal,
        ];
        categories.sort_by_key(|category| crawl_priority(*category));

        assert_eq!(
            categories,
            vec![
                LinkCategory::Services,
                LinkCategory::Pricing,
                LinkCategory::About,
                LinkCategory::Work,
                LinkCategory::Contact,
                LinkCategory::Careers,
                LinkCategory::Other,
                LinkCategory::Legal,
            ]
        );
    }

    #[test]
    fn defaults_bound_every_dimension_of_a_scan() {
        let limits = ScanLimits::default();
        assert!(limits.max_pages <= HARD_MAX_PAGES);
        assert!(limits.max_redirects <= 5);
        assert!(limits.max_page_bytes <= limits.max_total_bytes);
        assert!(limits.request_timeout <= limits.total_timeout);
    }

    /// The seed is refused before any socket opens, so an invalid URL costs
    /// nothing and cannot be used to probe the network.
    #[tokio::test]
    async fn an_unsafe_seed_is_refused_without_a_request() {
        for raw in [
            "http://example.com/",
            "https://127.0.0.1/",
            "https://169.254.169.254/",
            "file:///etc/passwd",
            "https://user:pass@example.com/",
        ] {
            let error = scan_site(raw, ScanLimits::default())
                .await
                .expect_err(&format!("{raw} must be refused"));
            assert!(
                matches!(error, ScanError::Rejected(_)),
                "{raw} produced {error:?}"
            );
        }
    }
}
