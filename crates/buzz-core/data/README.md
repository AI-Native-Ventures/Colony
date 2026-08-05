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
- A rate finer than the stored unit is refused rather than rounded. See
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

## Rates are per million tokens

Stored rates are integer nanoUSD **per million tokens**, the unit vendors
quote. `"0.0028"` in this file is stored as `2800000`, exactly.

They used to be nanoUSD per *token*, which put a floor of $0.001 per million
tokens under every rate and refused anything finer rather than rounding it.
That was not theoretical: it kept `deepseek-v4-flash` and `deepseek-v4-pro`
out of the catalog entirely, because their cache-hit rates are $0.0028 and
$0.003625 per million tokens, or 2.8 and 3.625 nanoUSD per token.

Nine decimal places of dollars still survive without loss, and anything finer
is refused rather than rounded. No vendor publishes anything close.

Cost is computed by summing every category first and dividing once at the end,
so a record is rounded at most half a nanoUSD ($0.0000000005). Rates are never
rounded. A rounded rate is wrong in the same direction on every call forever;
a rounded total is off by less than a billionth of a dollar, once.

Books published before this change hold per-token rates. They are read and
scaled exactly (1 per token = 1,000,000 per million tokens) and price to the
identical total, so nothing that was already reported is restated. Writing
always uses the new unit, so a book converts the next time anything appends to
it.

## What this book still cannot express

**Time-of-day pricing.** DeepSeek has announced peak/off-peak rates: 2x during
09:00-12:00 and 14:00-18:00 Beijing time, daily. Entries are effective-dated by
instant, which models a step change and not a recurring daily pattern. The
DeepSeek entries here carry off-peak list prices and say so. When that policy
takes effect, peak-hour spend will be understated until the book learns
recurrence.

**`deepseek-chat` is stale.** The row dated 2025-09-05 is the price that was in
force then. DeepSeek no longer lists that model; V4 Flash is $0.14 against that
row's $0.56. It is left in place because removing a published row restates
history, and no corrected row is appended because it is not clear what, if
anything, that name resolves to now. If usage ever appears under it, treat the
cost as suspect.

## Staleness

A missing price is visible: spend using that model is flagged as unpriced
rather than counted as zero. A **wrong** price is not visible, which is what
`buzz ledger reconcile --from-provider` exists to catch, by comparing the
ledger against the provider's own invoice.
