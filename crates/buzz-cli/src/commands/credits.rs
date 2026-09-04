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

/// Print the prepaid balance of the CLI's key.
///
/// A relay with no gateway configured does not mount this route at all, so
/// its refusal comes back as a relay error and exits 2 rather than reading
/// as an empty account.
pub async fn cmd_balance(client: &BuzzClient) -> Result<(), CliError> {
    let resp = client.credits_balance().await?;
    println!("{resp}");
    Ok(())
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
}
