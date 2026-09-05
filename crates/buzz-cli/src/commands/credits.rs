//! `buzz credits`: what a top-up costs, what the workspace holds, and the
//! checkout link to hand a founder.
//!
//! Colony Credits are bought on a hosted gateway page (Paystack in USD,
//! PayFast in ZAR), so the agent's job here stops at handing over a URL. It
//! never sees card details and it never pays: `pay` opens a checkout and
//! prints where the founder must go, and only the gateway's webhook can
//! actually credit an account. `verify` reports whether that has happened
//! yet.
//!
//! Every subcommand prints the relay's JSON body verbatim, matching
//! `buzz communities`. `pay` prints one extra line before the JSON, the
//! checkout URL on its own, so a caller can take it with `head -1` rather
//! than parsing.
//!
//! The relay is the authority on price throughout: no subcommand here sends
//! an amount, because a client that could name its own price could name zero
//! (see `crates/buzz-relay/src/credit_packs.rs`).

use crate::client::BuzzClient;
use crate::error::CliError;
use crate::CreditsCmd;

/// Pull the hosted checkout URL out of an `initialize` response.
///
/// The relay answers `{"authorizationUrl": ..., "reference": ...}`; the field
/// name is the gateway's, mirrored in
/// `desktop/src/features/onboarding/paymentsService.ts`.
fn checkout_url(body: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()?
        .get("authorizationUrl")?
        .as_str()
        .map(str::to_string)
}

/// Tag a balance body with the route that answered it.
///
/// A JSON object gains a `source` field; anything else is passed through
/// untouched, because rewriting a body we did not understand would be worse
/// than printing the relay's own answer verbatim.
fn tag_source(body: &str, source: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(serde_json::Value::Object(mut map)) => {
            map.insert("source".into(), serde_json::Value::String(source.into()));
            serde_json::to_string(&serde_json::Value::Object(map)).unwrap_or_else(|_| body.into())
        }
        _ => body.to_string(),
    }
}

/// Print the prepaid balance of the CLI's key, from whichever route answers.
///
/// Two relays answer this question and a given relay usually mounts only
/// one. `GET /api/gateway/account` exists when a gateway is configured and
/// reports the gateway account; `POST /api/payments/balance` is always
/// mounted and reports the payments ledger in `usdCents`. So the gateway is
/// asked first and a `404` from it means "no gateway here", not "no
/// credits", and the payments route is asked instead.
///
/// The printed JSON carries a `source` field naming which one answered:
/// `"gateway"` or `"payments"`. Any error other than a gateway `404`
/// surfaces as before, and when both routes are absent the payments error is
/// the one reported, because that is the route the relay was expected to
/// have.
pub async fn cmd_balance(client: &BuzzClient) -> Result<(), CliError> {
    let resp = resolve_balance(client).await?;
    println!("{resp}");
    Ok(())
}

/// Ask both balance routes in order and return the tagged JSON that
/// [`cmd_balance`] prints. Split out so the fallback can be tested against a
/// stand-in relay without capturing stdout.
pub(crate) async fn resolve_balance(client: &BuzzClient) -> Result<String, CliError> {
    match client.credits_balance().await {
        Ok(body) => Ok(tag_source(&body, "gateway")),
        Err(CliError::Relay { status: 404, .. }) => {
            Ok(tag_source(&client.payments_balance().await?, "payments"))
        }
        Err(err) => Err(err),
    }
}

/// Print the credit packs this relay sells.
///
/// `currency` is passed through as a query hint. The relay decides the
/// charging currency from its configured gateway and reports it in the
/// response's `currency` field, which is absent when payments are disabled.
pub async fn cmd_packs(client: &BuzzClient, currency: Option<&str>) -> Result<(), CliError> {
    let resp = client.credit_packs(currency).await?;
    println!("{resp}");
    Ok(())
}

/// Open a hosted checkout for `pack_id` and print its URL, then the JSON.
///
/// The URL goes first and alone so the agent can hand exactly that line to
/// the founder. A response without one is an error rather than a half
/// answer: the whole point of the call is the link, and printing JSON that
/// lacks it would read as success.
pub async fn cmd_pay(client: &BuzzClient, pack_id: &str, email: &str) -> Result<(), CliError> {
    let resp = client.initialize_payment(pack_id, email).await?;
    let url = checkout_url(&resp).ok_or_else(|| {
        CliError::Other(format!(
            "relay response carries no authorizationUrl to open: {resp}"
        ))
    })?;
    println!("{url}");
    println!("{resp}");
    Ok(())
}

/// Report whether one checkout reference has been paid.
///
/// This never credits anything. Only the gateway webhooks do
/// (`crates/buzz-relay/src/api/payments.rs`), so an unpaid answer means keep
/// waiting, not retry the payment.
pub async fn cmd_verify(client: &BuzzClient, reference: &str) -> Result<(), CliError> {
    let resp = client.verify_payment(reference).await?;
    println!("{resp}");
    Ok(())
}

/// Route `buzz credits <sub>`.
pub async fn dispatch(cmd: CreditsCmd, client: &BuzzClient) -> Result<(), CliError> {
    match cmd {
        CreditsCmd::Balance => cmd_balance(client).await,
        CreditsCmd::Packs { currency } => cmd_packs(client, currency.as_deref()).await,
        CreditsCmd::Pay { pack_id, email } => cmd_pay(client, &pack_id, &email).await,
        CreditsCmd::Verify { reference } => cmd_verify(client, &reference).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_checkout_url_from_an_initialize_response() {
        let body = r#"{"authorizationUrl":"https://checkout.example/x","reference":"ref_1"}"#;
        assert_eq!(
            checkout_url(body).as_deref(),
            Some("https://checkout.example/x")
        );
    }

    /// Anything that is not a string URL must read as absent, so `pay` fails
    /// loudly instead of printing `null` as if it were a link.
    #[test]
    fn rejects_a_missing_or_non_string_url() {
        for body in [
            r#"{"reference":"ref_1"}"#,
            r#"{"authorizationUrl":null}"#,
            r#"{"authorizationUrl":42}"#,
            r#"{"authorizationUrl":{"href":"https://x"}}"#,
            "[]",
            "not json",
            "",
        ] {
            assert!(
                checkout_url(body).is_none(),
                "{body:?} should not yield a URL"
            );
        }
    }

    #[test]
    fn tags_a_balance_object_with_the_route_that_answered() {
        assert_eq!(
            tag_source(r#"{"usdCents":1234}"#, "payments"),
            r#"{"source":"payments","usdCents":1234}"#
        );
        assert_eq!(
            tag_source(r#"{"balance_nanousd":"0"}"#, "gateway"),
            r#"{"balance_nanousd":"0","source":"gateway"}"#
        );
    }

    /// An existing `source` field is the relay's, and ours is the truthful
    /// one: the caller needs to know which route answered.
    #[test]
    fn overwrites_a_source_field_the_relay_already_sent() {
        assert_eq!(
            tag_source(r#"{"source":"elsewhere","usdCents":1}"#, "payments"),
            r#"{"source":"payments","usdCents":1}"#
        );
    }

    /// Anything that is not a JSON object is printed as the relay sent it.
    #[test]
    fn passes_a_non_object_body_through_untouched() {
        for body in ["[]", "null", "not json", ""] {
            assert_eq!(tag_source(body, "payments"), body);
        }
    }
}
