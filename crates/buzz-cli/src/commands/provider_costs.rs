//! Fetching what a provider says it billed, for reconciliation.
//!
//! Reconciliation compares the ledger's own metered total against the
//! provider's, per provider-day. That only means something if the provider
//! side is the provider's *money* figure. Both vendors also expose usage
//! endpoints reporting token counts, and it is tempting to price those with
//! our own price book — but then both sides of the comparison come from the
//! same price book, and the check passes by construction while a stale or
//! wrong price sails through. So this reads the cost endpoints, which return
//! the amounts the invoice is built from.
//!
//! These are organisation-wide figures. They cover every key on the account,
//! including keys used outside Colony, so the provider side legitimately
//! sits above the ledger when the same account is shared. That is a real
//! finding rather than noise: the drift direction is the diagnosis, and
//! "provider above ledger" is what a key used outside Colony looks like.

use std::collections::BTreeMap;

use buzz_core::ledger::reconcile::ProviderDailyCost;
use serde::Deserialize;
use serde_json::Value;

use crate::error::CliError;

/// Which vendor's cost report to read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CostProvider {
    Anthropic,
    OpenAi,
}

impl CostProvider {
    /// Parse the `--from-provider` value.
    pub fn parse(value: &str) -> Result<Self, CliError> {
        match value.trim().to_ascii_lowercase().as_str() {
            "anthropic" => Ok(Self::Anthropic),
            "openai" => Ok(Self::OpenAi),
            other => Err(CliError::Usage(format!(
                "unknown provider {other}; expected anthropic or openai"
            ))),
        }
    }

    /// The slug recorded on usage records for this vendor, so the two sides
    /// of the comparison key on the same string.
    pub fn slug(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::OpenAi => "openai",
        }
    }

    /// Environment variable holding the admin credential.
    pub fn key_var(self) -> &'static str {
        match self {
            Self::Anthropic => "BUZZ_LEDGER_ANTHROPIC_ADMIN_KEY",
            Self::OpenAi => "BUZZ_LEDGER_OPENAI_ADMIN_KEY",
        }
    }

    /// Where to get the credential, named precisely enough to act on.
    fn key_hint(self) -> &'static str {
        match self {
            Self::Anthropic => {
                "an Anthropic Admin API key (`sk-ant-admin-…`), created at \
                 console.anthropic.com under Settings → Admin keys. An ordinary \
                 `sk-ant-api…` key cannot read organisation cost and the API \
                 rejects it"
            }
            Self::OpenAi => {
                "an OpenAI Admin key (`sk-admin-…`), created at \
                 platform.openai.com under Settings → Organization → Admin keys. \
                 An ordinary project key cannot read organisation cost"
            }
        }
    }
}

/// Read the admin credential, or explain exactly what is missing.
fn admin_key(provider: CostProvider) -> Result<String, CliError> {
    match std::env::var(provider.key_var()) {
        Ok(value) if !value.trim().is_empty() => Ok(value.trim().to_owned()),
        _ => Err(CliError::Usage(format!(
            "{} is not set. Reconciling against {} needs {}.",
            provider.key_var(),
            provider.slug(),
            provider.key_hint()
        ))),
    }
}

/// Convert a decimal dollar amount to nanoUSD without going through a float.
///
/// Refuses sub-nanoUSD precision rather than rounding it away: a ledger that
/// silently rounds is a ledger that silently lies.
fn dollars_to_nanousd(value: &str) -> Result<u128, CliError> {
    let trimmed = value.trim();
    let bad = || CliError::Other(format!("provider reported an unreadable amount: {value}"));
    // A negative line is a credit or refund. Netting it into a day's cost
    // would silently reduce what the provider is said to have billed, so it
    // is surfaced instead of absorbed.
    if trimmed.is_empty() || trimmed.starts_with('-') {
        return Err(bad());
    }
    let (whole, fraction) = trimmed.split_once('.').unwrap_or((trimmed, ""));
    if whole.is_empty() || !whole.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }
    if !fraction.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }
    if fraction.len() > 9 {
        return Err(CliError::Other(format!(
            "provider reported {value}, which is finer than one nanoUSD"
        )));
    }
    let dollars: u128 = whole.parse().map_err(|_| bad())?;
    let mut padded = fraction.to_owned();
    while padded.len() < 9 {
        padded.push('0');
    }
    let nanos: u128 = padded.parse().map_err(|_| bad())?;
    dollars
        .checked_mul(1_000_000_000)
        .and_then(|scaled| scaled.checked_add(nanos))
        .ok_or_else(bad)
}

/// The UTC day of a unix timestamp.
fn day_of_unix(seconds: i64) -> Result<String, CliError> {
    chrono::DateTime::from_timestamp(seconds, 0)
        .map(|at| at.format("%Y-%m-%d").to_string())
        .ok_or_else(|| CliError::Other(format!("provider reported an impossible time: {seconds}")))
}

/// The UTC day of an RFC 3339 instant.
fn day_of_rfc3339(value: &str) -> Result<String, CliError> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|at| {
            at.with_timezone(&chrono::Utc)
                .format("%Y-%m-%d")
                .to_string()
        })
        .map_err(|_| CliError::Other(format!("provider reported an unreadable time: {value}")))
}

/// Refuse a currency other than USD.
///
/// The ledger is denominated in USD. Converting here would mean inventing an
/// exchange rate and presenting the result as what the provider billed.
fn require_usd(currency: &str) -> Result<(), CliError> {
    if currency.trim().eq_ignore_ascii_case("usd") {
        return Ok(());
    }
    Err(CliError::Other(format!(
        "provider reported cost in {currency}; the ledger is USD and will not invent a rate"
    )))
}

#[derive(Debug, Deserialize)]
struct AnthropicPage {
    #[serde(default)]
    data: Vec<AnthropicBucket>,
    #[serde(default)]
    has_more: bool,
    #[serde(default)]
    next_page: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AnthropicBucket {
    starting_at: String,
    #[serde(default)]
    results: Vec<AnthropicResult>,
}

#[derive(Debug, Deserialize)]
struct AnthropicResult {
    amount: Value,
    currency: String,
}

#[derive(Debug, Deserialize)]
struct OpenAiPage {
    #[serde(default)]
    data: Vec<OpenAiBucket>,
    #[serde(default)]
    has_more: bool,
    #[serde(default)]
    next_page: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiBucket {
    start_time: i64,
    #[serde(default)]
    results: Vec<OpenAiResult>,
}

#[derive(Debug, Deserialize)]
struct OpenAiResult {
    amount: Option<OpenAiAmount>,
}

#[derive(Debug, Deserialize)]
struct OpenAiAmount {
    value: Value,
    currency: String,
}

/// A JSON amount as an exact decimal string.
///
/// Anthropic sends a string. OpenAI sends a JSON number, which `serde_json`
/// has already parsed into an `f64`; `Number::to_string` gives the shortest
/// decimal that round-trips it, which is the original literal for any figure
/// with fewer than ~15 significant digits — every real invoice line. Anything
/// that comes back finer than a nanoUSD is refused by `dollars_to_nanousd`
/// rather than rounded.
fn amount_text(value: &Value) -> Result<String, CliError> {
    match value {
        Value::String(text) => Ok(text.clone()),
        Value::Number(number) => Ok(number.to_string()),
        other => Err(CliError::Other(format!(
            "provider reported an amount that is neither a number nor a string: {other}"
        ))),
    }
}

/// Fold per-line results into one total per day.
fn accumulate(totals: &mut BTreeMap<String, u128>, day: String, amount: u128) {
    *totals.entry(day).or_default() += amount;
}

fn into_rows(provider: CostProvider, totals: BTreeMap<String, u128>) -> Vec<ProviderDailyCost> {
    totals
        .into_iter()
        .map(|(day, amount_nanousd)| ProviderDailyCost {
            provider: provider.slug().to_owned(),
            day,
            amount_nanousd,
        })
        .collect()
}

/// Percent-encode a query-parameter value.
///
/// The workspace builds reqwest without default features, so
/// `RequestBuilder::query` is unavailable and URLs are assembled here.
/// Timestamps carry `:` and may carry `+`, and an unencoded `+` is read by a
/// server as a space, which silently shifts the requested window.
fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// Guard against a paginating loop that never terminates.
const MAX_PAGES: usize = 200;

/// Fold one Anthropic page into the running totals, returning the next
/// cursor when the report continues.
fn absorb_anthropic_page(
    body: &str,
    totals: &mut BTreeMap<String, u128>,
) -> Result<Option<String>, CliError> {
    let parsed: AnthropicPage = serde_json::from_str(body).map_err(|error| {
        CliError::Other(format!("anthropic cost report was unreadable: {error}"))
    })?;
    for bucket in parsed.data {
        let day = day_of_rfc3339(&bucket.starting_at)?;
        for result in bucket.results {
            require_usd(&result.currency)?;
            let amount = dollars_to_nanousd(&amount_text(&result.amount)?)?;
            accumulate(totals, day.clone(), amount);
        }
    }
    // `next_page` is only meaningful alongside `has_more`; following a stale
    // cursor after the last page would loop forever.
    Ok(parsed.has_more.then_some(parsed.next_page).flatten())
}

/// Fold one OpenAI page into the running totals, returning the next cursor
/// when the report continues.
fn absorb_openai_page(
    body: &str,
    totals: &mut BTreeMap<String, u128>,
) -> Result<Option<String>, CliError> {
    let parsed: OpenAiPage = serde_json::from_str(body)
        .map_err(|error| CliError::Other(format!("openai cost report was unreadable: {error}")))?;
    for bucket in parsed.data {
        let day = day_of_unix(bucket.start_time)?;
        for result in bucket.results {
            // A bucket with no spend carries a result with a null amount
            // rather than no result at all.
            let Some(amount) = result.amount else {
                continue;
            };
            require_usd(&amount.currency)?;
            let value = dollars_to_nanousd(&amount_text(&amount.value)?)?;
            accumulate(totals, day.clone(), value);
        }
    }
    Ok(parsed.has_more.then_some(parsed.next_page).flatten())
}

/// Fetch a provider's own daily cost for a date range.
///
/// `starting_at` and `ending_at` are RFC 3339 instants. Both vendors page;
/// every page is followed so a long range is not silently truncated to its
/// first page, which would understate the provider side and read as the
/// ledger over-counting.
pub async fn fetch_provider_costs(
    provider: CostProvider,
    starting_at: &str,
    ending_at: &str,
) -> Result<Vec<ProviderDailyCost>, CliError> {
    let key = admin_key(provider)?;
    let client = reqwest::Client::new();
    let mut totals: BTreeMap<String, u128> = BTreeMap::new();
    let mut page: Option<String> = None;

    for _ in 0..MAX_PAGES {
        let body = match provider {
            CostProvider::Anthropic => {
                let mut url = format!(
                    "https://api.anthropic.com/v1/organizations/cost_report\
                     ?starting_at={}&ending_at={}&bucket_width=1d",
                    encode(starting_at),
                    encode(ending_at)
                );
                if let Some(cursor) = page.as_deref() {
                    url.push_str(&format!("&page={}", encode(cursor)));
                }
                let request = client
                    .get(url)
                    .header("x-api-key", &key)
                    .header("anthropic-version", "2023-06-01");
                send(request, provider).await?
            }
            CostProvider::OpenAi => {
                let mut url = format!(
                    "https://api.openai.com/v1/organization/costs\
                     ?start_time={}&end_time={}&bucket_width=1d&limit=180",
                    day_start_unix(starting_at)?,
                    day_start_unix(ending_at)?
                );
                if let Some(cursor) = page.as_deref() {
                    url.push_str(&format!("&page={}", encode(cursor)));
                }
                let request = client.get(url).bearer_auth(&key);
                send(request, provider).await?
            }
        };

        let next = match provider {
            CostProvider::Anthropic => absorb_anthropic_page(&body, &mut totals)?,
            CostProvider::OpenAi => absorb_openai_page(&body, &mut totals)?,
        };

        match next {
            Some(cursor) => page = Some(cursor),
            None => return Ok(into_rows(provider, totals)),
        }
    }

    Err(CliError::Other(format!(
        "{} cost report did not stop paginating after {MAX_PAGES} pages",
        provider.slug()
    )))
}

/// Midnight-UTC unix seconds for an RFC 3339 instant.
fn day_start_unix(value: &str) -> Result<i64, CliError> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|at| at.timestamp())
        .map_err(|_| CliError::Usage(format!("{value} is not an RFC 3339 instant")))
}

/// Send a request and return its body, turning a refusal into a message that
/// names the likely cause rather than only the status code.
async fn send(
    request: reqwest::RequestBuilder,
    provider: CostProvider,
) -> Result<String, CliError> {
    let response = request.send().await?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if status.is_success() {
        return Ok(body);
    }
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(CliError::Auth(format!(
            "{} refused the credential in {} ({status}). This endpoint needs {}.",
            provider.slug(),
            provider.key_var(),
            provider.key_hint()
        )));
    }
    Err(CliError::Other(format!(
        "{} cost report failed ({status}): {body}",
        provider.slug()
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dollars_convert_exactly_without_a_float() {
        assert_eq!(dollars_to_nanousd("0").unwrap(), 0);
        assert_eq!(dollars_to_nanousd("0.06").unwrap(), 60_000_000);
        assert_eq!(dollars_to_nanousd("12.34").unwrap(), 12_340_000_000);
        // Past what an f64 represents exactly, and still exact.
        assert_eq!(
            dollars_to_nanousd("90071992.547409937").unwrap(),
            90_071_992_547_409_937
        );
    }

    #[test]
    fn precision_finer_than_a_nanousd_is_refused_not_rounded() {
        let error = dollars_to_nanousd("0.0000000001").unwrap_err();
        assert!(format!("{error}").contains("finer than one nanoUSD"));
    }

    #[test]
    fn a_credit_is_surfaced_rather_than_netted_away() {
        // Netting a refund into the day would quietly reduce what the
        // provider is said to have billed, and the ledger would look like it
        // over-counted.
        assert!(dollars_to_nanousd("-1.00").is_err());
    }

    #[test]
    fn a_non_usd_currency_is_refused_rather_than_converted() {
        assert!(require_usd("usd").is_ok());
        assert!(require_usd("USD").is_ok());
        let error = require_usd("eur").unwrap_err();
        assert!(format!("{error}").contains("will not invent a rate"));
    }

    #[test]
    fn an_amount_may_arrive_as_a_string_or_a_number() {
        assert_eq!(amount_text(&serde_json::json!("1.25")).unwrap(), "1.25");
        assert_eq!(amount_text(&serde_json::json!(0.06)).unwrap(), "0.06");
        assert!(amount_text(&serde_json::json!(null)).is_err());
    }

    /// The whole point of the reconciliation is comparing against the
    /// provider's own money, so the slug must match what usage records carry
    /// or every day looks like it exists on one side only.
    #[test]
    fn the_slug_matches_the_usage_record_provider() {
        assert_eq!(CostProvider::Anthropic.slug(), "anthropic");
        assert_eq!(CostProvider::OpenAi.slug(), "openai");
        assert!(CostProvider::parse("Anthropic").is_ok());
        assert!(CostProvider::parse("bedrock").is_err());
    }

    #[test]
    fn a_missing_admin_key_names_the_variable_and_the_key_kind() {
        // The commonest failure is reaching for an ordinary API key, so the
        // message has to say that outright.
        let error = admin_key(CostProvider::Anthropic).unwrap_err();
        let message = format!("{error}");
        assert!(message.contains("BUZZ_LEDGER_ANTHROPIC_ADMIN_KEY"));
        assert!(message.contains("sk-ant-admin"));
    }

    #[test]
    fn per_line_results_fold_into_one_total_per_day() {
        let mut totals = BTreeMap::new();
        accumulate(&mut totals, "2026-08-03".to_string(), 100);
        accumulate(&mut totals, "2026-08-03".to_string(), 250);
        accumulate(&mut totals, "2026-08-04".to_string(), 7);
        let rows = into_rows(CostProvider::Anthropic, totals);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].day, "2026-08-03");
        assert_eq!(rows[0].amount_nanousd, 350);
        assert_eq!(rows[1].amount_nanousd, 7);
    }

    /// A real Anthropic cost-report page, in the documented shape: buckets
    /// with many per-line results that must sum into one figure per day.
    #[test]
    fn an_anthropic_page_sums_its_lines_into_one_total_per_day() {
        let body = r#"{
          "data": [
            {
              "starting_at": "2026-08-03T00:00:00Z",
              "ending_at": "2026-08-04T00:00:00Z",
              "results": [
                {"currency": "USD", "amount": "12.50", "model": "claude-sonnet-4-5", "token_type": "input"},
                {"currency": "USD", "amount": "3.25", "model": "claude-sonnet-4-5", "token_type": "output"}
              ]
            },
            {
              "starting_at": "2026-08-04T00:00:00Z",
              "ending_at": "2026-08-05T00:00:00Z",
              "results": [
                {"currency": "USD", "amount": "0.000000001", "model": "claude-opus-5", "token_type": "input"}
              ]
            }
          ],
          "has_more": false,
          "next_page": null
        }"#;
        let mut totals = BTreeMap::new();
        let next = absorb_anthropic_page(body, &mut totals).expect("page must parse");
        assert_eq!(next, None);
        assert_eq!(totals.get("2026-08-03"), Some(&15_750_000_000));
        // One nanoUSD survives as one nanoUSD.
        assert_eq!(totals.get("2026-08-04"), Some(&1));
    }

    /// A real OpenAI costs page: unix-second buckets, amount as a nested
    /// object with a JSON number.
    #[test]
    fn an_openai_page_reads_unix_buckets_and_nested_amounts() {
        let body = r#"{
          "object": "page",
          "data": [
            {
              "object": "bucket",
              "start_time": 1785628800,
              "end_time": 1785715200,
              "results": [
                {"object": "organization.costs.result", "amount": {"value": 0.06, "currency": "usd"}, "line_item": null},
                {"object": "organization.costs.result", "amount": {"value": 1.5, "currency": "usd"}, "line_item": null}
              ]
            },
            {
              "object": "bucket",
              "start_time": 1785715200,
              "end_time": 1785801600,
              "results": [
                {"object": "organization.costs.result", "amount": null, "line_item": null}
              ]
            }
          ],
          "has_more": false,
          "next_page": null
        }"#;
        let mut totals = BTreeMap::new();
        absorb_openai_page(body, &mut totals).expect("page must parse");
        assert_eq!(totals.get("2026-08-02"), Some(&1_560_000_000));
        // A day the provider billed nothing for carries a null amount, not a
        // missing result; it must not become a phantom zero-cost day.
        assert_eq!(totals.get("2026-08-03"), None);
    }

    /// Following the cursor only while `has_more` is set.
    ///
    /// Both vendors keep returning a `next_page` value on the final page. A
    /// fetcher that followed it regardless would request the same page
    /// forever and never terminate.
    #[test]
    fn a_cursor_is_followed_only_while_more_pages_remain() {
        let more = r#"{"data": [], "has_more": true, "next_page": "cursor-2"}"#;
        let last = r#"{"data": [], "has_more": false, "next_page": "cursor-2"}"#;
        let mut totals = BTreeMap::new();
        assert_eq!(
            absorb_anthropic_page(more, &mut totals).unwrap(),
            Some("cursor-2".to_string())
        );
        assert_eq!(absorb_anthropic_page(last, &mut totals).unwrap(), None);
        assert_eq!(
            absorb_openai_page(more, &mut totals).unwrap(),
            Some("cursor-2".to_string())
        );
        assert_eq!(absorb_openai_page(last, &mut totals).unwrap(), None);
    }

    /// Totals accumulate across pages rather than resetting per page.
    #[test]
    fn totals_carry_across_pages() {
        let page = r#"{
          "data": [{"starting_at": "2026-08-03T00:00:00Z", "results": [{"currency": "USD", "amount": "1.00"}]}],
          "has_more": false, "next_page": null
        }"#;
        let mut totals = BTreeMap::new();
        absorb_anthropic_page(page, &mut totals).unwrap();
        absorb_anthropic_page(page, &mut totals).unwrap();
        assert_eq!(totals.get("2026-08-03"), Some(&2_000_000_000));
    }

    /// A currency the ledger cannot hold stops the whole run.
    #[test]
    fn a_foreign_currency_line_fails_the_page() {
        let body = r#"{
          "data": [{"starting_at": "2026-08-03T00:00:00Z", "results": [{"currency": "EUR", "amount": "1.00"}]}],
          "has_more": false, "next_page": null
        }"#;
        let mut totals = BTreeMap::new();
        assert!(absorb_anthropic_page(body, &mut totals).is_err());
    }

    #[test]
    fn a_query_value_is_encoded_so_the_window_is_not_shifted() {
        // An unencoded `+` reads as a space server-side, which moves the
        // requested window without any error.
        assert_eq!(encode("2026-08-03T00:00:00Z"), "2026-08-03T00%3A00%3A00Z");
        assert_eq!(
            encode("2026-08-03T00:00:00+02:00"),
            "2026-08-03T00%3A00%3A00%2B02%3A00"
        );
        assert_eq!(encode("abc-123_x.y~z"), "abc-123_x.y~z");
    }

    #[test]
    fn days_are_read_from_both_time_formats() {
        assert_eq!(
            day_of_rfc3339("2026-08-03T00:00:00Z").unwrap(),
            "2026-08-03"
        );
        // A non-UTC offset is normalised rather than taken at face value.
        assert_eq!(
            day_of_rfc3339("2026-08-03T23:30:00-05:00").unwrap(),
            "2026-08-04"
        );
        assert_eq!(day_of_unix(1_785_628_800).unwrap(), "2026-08-02");
    }
}
