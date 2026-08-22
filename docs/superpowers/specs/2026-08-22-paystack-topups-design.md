# Paystack top-ups into the existing credit ledger

**Status:** draft, not yet implemented
**Implements:** the `payments.*` contract left open by
[the onboarding redesign spec](2026-08-21-onboarding-redesign-design.md).
Screen 9 asks a user for money; nothing behind that screen exists yet.

## What already exists, and what does not

This is smaller than it looks. Most of the machinery is built:

| Piece | State |
|---|---|
| `accounts` table (pubkey to balance) | exists, migration 0050 |
| `credit_ledger` with `UNIQUE (pubkey, ref)` | exists, migration 0050 |
| `credits::credit(pool, pubkey, delta, reference)` | exists, idempotent, doc says "used for purchase webhooks" |
| `credits::balance(pool, pubkey)` | exists |
| Debit and settlement paths | exist and are in use |
| `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY` on `colony-relay` | deployed |
| Anything that talks to Paystack | **does not exist** |
| Any route a client can call to add money | **does not exist** |

So the work is a Paystack client, three routes, and one desktop service. The
ledger is not being designed here; it is being connected.

## Units, stated once because getting this wrong is expensive

Three units are in play and they are not interchangeable:

- **The ledger stores nanoUSD.** `credit_ledger.delta` is nanoUSD.
- **The onboarding contract speaks USD cents.** `$5.00` is `500`.
- **Paystack speaks the currency's minor unit.** For USD that is cents, so
  `$5.00` is `500`.

Therefore: Paystack amount and contract amount are the same number, and the
ledger amount is `usd_cents * 10_000_000`. That multiplication happens in
exactly one function, `nano_usd_from_cents`, and nowhere else.

**Currency is USD, end to end, with no conversion anywhere.** That is the only
reason Paystack was chosen over the incumbent. Any code path that introduces a
second currency or an exchange rate is wrong.

## Security posture

**Colony never touches card data.** Paystack hosts the checkout page; the user
leaves the app, pays on Paystack's domain, and returns. No card number, expiry
or CVV field exists anywhere in Colony, and none may be added.

**The webhook is the only thing that moves money.** The browser return URL is a
hint that the user came back, nothing more: it is attacker-controlled, arrives
before Paystack has necessarily settled anything, and can be replayed by
anyone who reads a URL. The ledger is credited from a signature-verified
webhook and from nothing else.

**Webhook verification is mandatory and constant-time.** Paystack signs the raw
request body with HMAC-SHA512 under the secret key and sends it as
`x-paystack-signature`. The relay must:

1. Verify against the **raw bytes** of the body, before any JSON parsing.
   Re-serialising the parsed JSON produces different bytes and the signature
   will never match.
2. Compare with a constant-time equality, never `==`.
3. Reject unverified requests with `401` and process nothing.

**Amount is verified against our own record, not trusted from the callback.**
An intent row written at initialize time holds what we asked for. If the
webhook reports a different amount, the ledger is credited with the amount
actually paid and the mismatch is logged, never the amount we hoped for.

## Data model

`migrations/00NN_payment_intents.sql`. Check
`git ls-tree -r --name-only origin/develop migrations/` for the next free
number immediately before writing the file: parallel branches collide here.

```sql
CREATE TABLE payment_intents (
    community_id  UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    reference     TEXT NOT NULL,
    pubkey        BYTEA NOT NULL CHECK (octet_length(pubkey) = 32),
    usd_cents     BIGINT NOT NULL CHECK (usd_cents >= 500),
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'paid', 'failed', 'abandoned')),
    paid_cents    BIGINT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at    TIMESTAMPTZ,
    PRIMARY KEY (community_id, reference)
);

CREATE INDEX payment_intents_pubkey_idx ON payment_intents (community_id, pubkey);

SELECT attach_community_write_fence('payment_intents');
```

Tenant-scoped like every other table here, so it must also be registered in the
deletion catalogs in `crates/buzz-db/src/deletion.rs`. That is a retention
requirement, not a lint: an unregistered table survives community deletion
still holding payment records.

**Why an intent row rather than Paystack metadata.** The reference has to map
back to a pubkey when the webhook arrives, and the amount has to be checkable
against something we wrote. Metadata round-tripped through a third party is
neither.

## HTTP API

Two authenticated routes and one unauthenticated webhook, in
`crates/buzz-relay/src/api/payments.rs`.

The two client routes are NIP-98 signed, because by this point in onboarding
the user has a key: screen 9 comes after screen 1. That differs from the
account routes, which could not be signed because they precede key ownership.

### `POST /api/payments/initialize`

```jsonc
// request
{ "usdCents": 500, "email": "founder@example.com" }
// 200
{ "authorizationUrl": "https://checkout.paystack.com/...", "reference": "..." }
// 400
{ "error": "amount_too_small" }
```

Minimum is `500` (five dollars), matching the onboarding spec. The pubkey comes
from the NIP-98 signature, never from the body. Writes the intent row, then
calls Paystack's transaction initialize.

### `POST /api/payments/verify`

```jsonc
// request
{ "reference": "..." }
// 200
{ "paid": true, "usdCents": 500 }
```

A read of our own intent row. It exists so the screen can stop showing a
spinner, and it deliberately does **not** credit anything: a client-triggered
route must never move money. If the webhook has not arrived yet this returns
`{ "paid": false }` and the screen keeps waiting.

### `POST /api/payments/balance`

```jsonc
// request
{}
// 200
{ "usdCents": 500 }
```

The pubkey comes from the NIP-98 signature, so the body is empty.

**This route exists so the conversion stays on one side of the wire.** The
ledger stores nanoUSD and `GET /api/gateway/account` returns nanoUSD as a
string; consuming that from the client would drag a nanoUSD-to-cents conversion
into TypeScript and break the rule that the multiplication lives in exactly one
place. This route converts and answers in cents.

It is also screen 9's recovery path. If a user pays and the confirmation is
slow, or the callback never arrives, the balance still answers with what the
workspace actually holds, so nobody is stranded staring at a spinner over money
they have already spent.

### `POST /api/payments/webhook`

Unauthenticated by design, verified by signature. Returns `200` for every
event it understands and ignores, so Paystack stops retrying. On
`charge.success`:

1. Verify the signature against raw bytes.
2. Look up the intent by reference. Unknown reference is a `200` with a warning
   logged, not an error: it may belong to another environment sharing the key.
3. If the intent is already `paid`, return `200` and do nothing. Paystack
   retries, so this path will be hit.
4. Credit `credits::credit(pubkey, nano_usd_from_cents(paid_cents), reference)`.
   The ledger's `UNIQUE (pubkey, ref)` is the second idempotency layer.
5. Mark the intent `paid`, recording `paid_cents` and `settled_at`.

Steps 4 and 5 run in one transaction. A crash between them would otherwise
leave money credited with an intent that still reads pending, and the next
retry would try to credit again. The ledger's uniqueness would refuse the
double credit, but the intent would stay wrong forever.

## Desktop integration

`desktop/src/features/onboarding/paymentsService.ts` implements the real
`payments` contract, replacing the fake. It follows `authService.ts`: injected
dependencies, typed failures, no HTTP status ever reaching a screen.

The flow on screen 9:

1. User picks or types an amount. Minimum five dollars, enforced in the UI with
   plain copy, not a validation code.
2. `initialize` returns a URL. Open it in the system browser, not in the app.
3. The screen polls `verify` while the user is away, with a visible "waiting
   for your payment" state and a way to continue without paying.
4. On `paid`, show the new balance and move on.

**Never trap the user here.** Payment is the step most likely to fail for
reasons Colony cannot see: a declined card, a closed tab, a bank prompt never
answered. Every state has a way forward, and the flow must remain completable
without paying, because the onboarding spec's principle is to ask for money
after value, never before it.

## Copy

No jargon. Never "transaction", "gateway", "webhook", "reference" or
"authorization URL" on screen. The user is adding money to their workspace.
Errors say what happened and what to do: "That payment did not go through. You
can try again, or continue and add money later."

No em dashes.

## Testing

**Rust unit:** `nano_usd_from_cents` conversion, including that it rejects
negatives; signature verification accepts a known-good body and rejects a
tampered one; verification runs on raw bytes, proven by a test whose body has
whitespace that re-serialisation would change.

**Rust integration** (Postgres, no Paystack): initialize writes a pending
intent; a webhook credits exactly once; a replayed webhook credits zero more
times; an unknown reference is a `200` and no credit; a tampered signature is
`401` and no credit; an intent in community A is invisible from community B.

**Never call the live Paystack API from a test.** Fake the client at the trait
boundary. A test that spends real money, or that fails when Paystack is slow,
is worse than no test.

**Prove each regression test fails first.** Repo policy, and it has caught
tests here that passed without exercising anything.

## Out of scope

- Refunds, and what happens to recouped costs on a refund.
- Subscriptions or recurring billing.
- Invoices and receipts.
- Any currency other than USD.
- Showing spend history inside the app.

## Open questions

1. **Which Paystack channels to enable.** Card is certain. Whether to offer
   bank transfer or mobile money depends on where the first users actually are,
   and it changes the checkout experience. Defaulting to card only until there
   is a reason not to.
2. **Test mode versus live.** The deployed keys need checking: a `pk_test_`
   public key means the account is not yet approved for live charges, and
   shipping against test keys would take real money nowhere. Verify before the
   flow is enabled for anyone.
