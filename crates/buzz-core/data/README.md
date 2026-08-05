# Model price catalog

`price-catalog.json` is the list of public vendor prices Colony ships. The
relay applies it to every community's price book at provisioning and again on
every startup, so an owner never has to look up what a public model costs.

This file is the **offline floor**: no network, always present, and what a
relay prices from when nothing else is available. It only changes when the
relay is deployed. Vendors do not schedule promotions around our release
train, so relays can also fetch the same document signed and served over
HTTPS. See [Publishing the signed feed](#publishing-the-signed-feed).

## Adding or changing a price

A price change is a **new entry**, never an edit to an existing one. Editing a
shipped entry restates spend that has already been reported.

```json
{
  "model": "claude-sonnet-4-5",
  "effectiveFrom": "2026-09-01T00:00:00Z",
  "inputPerMtok": "2.40",
  "cacheReadPerMtok": "0.24",
  "cacheWrite5mPerMtok": "3",
  "cacheWrite1hPerMtok": "4.80",
  "outputPerMtok": "12",
  "note": "20% cut"
}
```

**`effectiveFrom` is the date the vendor's price changed, not the date you
edited this file.** A promotion that began on the 1st and reaches this file on
the 10th must still price the 1st through the 9th at the promotional rate.
Dating it by publication silently misprices every day in between.

The end of a promotion is its own entry, at the vendor's list price, effective
the day the promotion ended.

- `model` should be the **undated alias** (`claude-sonnet-4-5`, not
  `claude-sonnet-4-5-20250929`). See [Aliases and snapshots](#aliases-and-snapshots).
- Rates are dollars per million tokens, as vendors quote them.
- Use `"0"` for a rate a provider does not charge for (OpenAI does not bill
  cache writes).
- A rate finer than one nanoUSD per token is refused rather than rounded. See
  [What cannot be priced yet](#what-cannot-be-priced-yet).
- Two entries for one model at one instant are refused: there would be no
  defined winner.

## Aliases and snapshots

The meter records the `model` string from the **provider's response body**,
and providers resolve an undated alias to a dated snapshot: a call to
`claude-sonnet-4-5` is recorded as `claude-sonnet-4-5-20250929`, and `gpt-4o`
as `gpt-4o-2024-08-06`.

So a row is matched exactly, or by its alias with a date suffix stripped. Write
the **alias**: it prices both the alias and every dated snapshot of it. A dated
row prices only that snapshot.

The suffix has to be entirely a date (`-20250929` or `-2024-08-06`). That is
what stops a `gpt-4` row from pricing `gpt-4o`, or a `claude-sonnet-4` row from
pricing `claude-sonnet-4-5-20250929`. Charging one model at another's rate is
worse than leaving it unpriced, because unpriced is visible.

## What cannot be priced yet

Rates are integer **nanoUSD per token**, which is $0.001 per million tokens.
A vendor rate finer than that cannot be represented and is refused rather than
rounded, so it stays out of the catalog.

This is not hypothetical. DeepSeek V4 cache hits are **$0.0028 / MTok**, which
is 2.8 nanoUSD per token:

```
$ buzz ledger feed-sign --catalog deepseek.json --key …
deepseek-v4-flash: cache read 0.0028 is finer than one nanoUSD per token
```

`deepseek-v4-flash` and `deepseek-v4-pro` are therefore absent. Spend on them
reports as **unpriced**, which is visible, rather than rounded, which would be
silently wrong by 7% on every cache read. Pricing them needs sub-nanoUSD
resolution across the ledger, the desktop app, and every stored price book:
a units change, not a catalog edit.

## What this catalog must not contain

Anything a company negotiated for itself. Those are published by the owner
from the Spend screen or `buzz ledger prices-add`, and an owner's row beats a
catalog row at the same instant precisely so a refresh cannot overwrite it.

## Publishing the signed feed

The feed is this same document, signed once and served as a static file. A
relay fetches it at startup and on an interval, merges it over the file it
shipped with, and applies it through the same seeding path, so a price change
reaches running relays without a deploy.

```bash
# 1. Edit price-catalog.json as above, or keep a superset elsewhere.
# 2. Sign it. COLONY_PRICE_FEED_KEY holds the publisher's secret key.
buzz ledger feed-sign \
  --catalog crates/buzz-core/data/price-catalog.json \
  --out price-feed.json

# 3. Serve price-feed.json over HTTPS as a static file.
# 4. Point relays at it:
#      BUZZ_LEDGER_PRICE_FEED_URL=https://…/price-feed.json
#      BUZZ_LEDGER_PRICE_FEED_PUBKEY=<the pubkey feed-sign printed>
```

The catalog is parsed before it is signed, so a document relays cannot read is
refused here rather than discovered by every relay in production.

### The publisher key

It decides what every Colony company is billed. It is a maintainer secret, not
an agent identity, and `feed-sign` deliberately does not read
`BUZZ_PRIVATE_KEY`, because an agent key that leaked must not also be able to set
prices.

### What a relay refuses

- A document signed by any key other than the pinned one, even a valid
  signature.
- A document whose `id` does not cover its content. Signature alone is not
  enough: a Nostr signature covers the event's *stated* id, so checking only
  the signature would let whoever can edit the response body rewrite every
  price in it.
- A body over 1 MiB, refused while downloading rather than after buffering.
- A document older than `BUZZ_LEDGER_PRICE_FEED_MAX_AGE_SECS` (30 days by
  default). A publisher that stopped publishing otherwise looks exactly like a
  market where no price ever changed.
- A URL configured without a pinned pubkey. That is fatal at startup, not a
  warning.

An unreachable or refused feed is **not** fatal. The relay logs it and prices
from the shipped file.

## Staleness

A missing price is visible: spend using that model is flagged as unpriced
rather than counted as zero. A **wrong** price is not visible, which is what
`buzz ledger reconcile --from-provider` exists to catch, by comparing the
ledger against the provider's own invoice.
