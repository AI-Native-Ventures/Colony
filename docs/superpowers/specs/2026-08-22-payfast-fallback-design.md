# PayFast as a swappable second payment provider

**Status:** draft
**Extends:** [the Paystack top-ups spec](2026-08-22-paystack-topups-design.md)

## Why

The Paystack account is not approved for live charges yet. If approval does not
land, onboarding screen 9 cannot take money and the whole flow stops at a wall.
PayFast is the fallback, and an account already exists under another project.

The goal is not "add PayFast". It is **make the provider a setting**, so which
gateway is live becomes a config value rather than a rewrite, and so a failed
approval on either side is survivable.

## The currency problem, stated plainly

**PayFast settles in ZAR only.** It accepts internationally issued cards, but
converts and pays out in rand. That collides with a hard product rule: pricing
and the ledger are USD end to end, with no exchange rate anywhere.

The rule survives if, and only if, **Multi-Currency Pricing is enabled on the
PayFast account**. With it, the customer is shown and charged USD, PayFast
performs the conversion, and settlement to the bank happens in ZAR. The ledger
then credits exactly the USD charged, and no exchange rate enters Colony.

Without it, the customer is charged ZAR, and crediting the ledger would require
a ZAR-to-USD conversion inside Colony. **That is not acceptable and this spec
does not describe it.** If Multi-Currency Pricing turns out to be unavailable,
this design needs revisiting before implementation, not a quiet fallback to
converting rand.

The settlement currency of the bank account is a treasury matter and is out of
scope here. What is in scope is that nothing in Colony ever multiplies by an
exchange rate.

## Architecture

One trait, two implementations, chosen by config.

```rust
#[async_trait]
pub trait PaymentProvider: Send + Sync {
    /// Open a hosted checkout and return the URL to send the user to.
    async fn initialize(&self, usd_cents: i64, email: &str, reference: &str)
        -> Result<String, ProviderError>;

    /// Turn a raw inbound callback into a verified event, or reject it.
    async fn verify_callback(&self, raw_body: &[u8], headers: &HeaderMap)
        -> Result<ProviderEvent, ProviderError>;

    /// Name for logs and for the intent row.
    fn name(&self) -> &'static str;
}

pub enum ProviderEvent {
    /// A payment succeeded. `usd_cents` is what was actually paid.
    Paid { reference: String, usd_cents: i64 },
    /// Understood and deliberately ignored. Answer 200 so retries stop.
    Ignored,
}
```

The existing `PaystackApi` trait collapses into this. The webhook handler stops
knowing which gateway it is talking to: it verifies through the trait, and on
`Paid` it credits and settles exactly as it does today.

**The route stays one path per provider**, `/api/payments/webhook/paystack` and
`/api/payments/webhook/payfast`, because each gateway is configured with its own
callback URL and they arrive in different shapes. One path with sniffing would
be a worse contract for both.

`payment_intents` gains a `provider TEXT NOT NULL` column so a reference can be
resolved back to the gateway that issued it. Without it, a callback from a
retired provider after a switch cannot be told apart from a forgery.

## PayFast differs from Paystack in ways that matter

Do not assume the Paystack shape. Four differences:

1. **Form-encoded, not JSON.** The ITN arrives as
   `application/x-www-form-urlencoded`.
2. **MD5 signature, not HMAC-SHA512.** The signature is MD5 over the parameter
   string in the order received, with the passphrase appended. MD5 is PayFast's
   choice, not ours; it is why the other two checks below are not optional.
3. **Source must be validated.** The existing implementation in `nocode-hive`
   checks a hostname string from the request, which is trivially spoofable.
   Colony validates the **peer address** against PayFast's published ITN
   hostnames, forward-resolved, failing closed on any lookup error.

   An earlier draft of this spec said "reverse DNS". Forward resolution is the
   better primitive: a reverse lookup answers with whatever PTR record the
   address owner published, so on its own it is a claim by the party being
   checked. Resolving PayFast's own hostnames and testing membership asks DNS a
   question only PayFast's operator can answer.
4. **A server-to-server postback is required.** PayFast expects the ITN payload
   posted back to `/eng/query/validate` for confirmation. The existing
   implementation omits this. Skipping it means a forged ITN that happens to
   satisfy the signature is accepted.

All three of signature, source and postback must pass. Any one failing rejects
the notification and credits nothing.

**Constant-time comparison for the signature.** The reference implementation
uses `!==`, which leaks the expected value to a patient attacker. Use
`subtle::ConstantTimeEq`, as `paystack.rs` already does.

## Configuration

```
COLONY_PAYMENT_PROVIDER = paystack | payfast   # no default; unset disables payments
PAYSTACK_SECRET_KEY, PAYSTACK_PUBLIC_KEY
PAYFAST_MERCHANT_ID, PAYFAST_MERCHANT_KEY, PAYFAST_PASSPHRASE
```

Selection happens once at startup. An unset or unknown value fails closed:
`initialize` answers `503 payment_unavailable` and every webhook is rejected. A
misconfigured relay must never silently accept money it cannot attribute.

**Credentials for Colony are new values from the PayFast dashboard.** The ones
in `nocode-hive` belong to a different merchant account, which identifies the
business receiving the money. They are not reusable and must not be copied.

**Separately, and urgently:** that repository hardcodes a passphrase as a
fallback in tracked source, not merely in `.env`. It is a live secret in git
history and should be rotated regardless of what happens here.

## Testing

Everything at the trait boundary. **Never call either live API from a test.**

Per provider: a correct signature is accepted; a tampered body is rejected; a
wrong secret or passphrase is rejected; a malformed signature header is
rejected. For PayFast additionally: a valid signature from an unlisted source
address is rejected, and a valid signature whose postback returns anything
other than `VALID` is rejected.

Provider-agnostic, run against both: `Paid` credits exactly once; a replay
credits nothing further; `Ignored` credits nothing and answers 200.

**Prove each test fails first.** A signature test that passes against an
implementation which never checks the signature is the worst kind of green.

## Out of scope

- Running both providers live at once, or per-user provider selection.
- Migrating historical intents between providers.
- Refunds through either gateway.
- Any exchange rate arithmetic inside Colony.

## Open question

Whether Multi-Currency Pricing is enabled on the PayFast account. Everything
above depends on it. If it is not available, stop and revisit: the alternative
is charging in rand, which breaks the USD rule this product committed to.
