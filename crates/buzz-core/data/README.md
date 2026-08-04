# Model price catalog

`price-catalog.json` is the list of public vendor prices Colony ships. The
relay applies it to every community's price book at provisioning and again on
every startup, so an owner never has to look up what a public model costs.

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

- `model` must match exactly what the provider reports in its responses, since
  that string is what recorded calls are matched against.
- Rates are dollars per million tokens, as vendors quote them.
- Use `"0"` for a rate a provider does not charge for (OpenAI does not bill
  cache writes).
- A rate finer than one nanoUSD per token is refused rather than rounded.
- Two entries for one model at one instant are refused: there would be no
  defined winner.

## What this catalog must not contain

Anything a company negotiated for itself. Those are published by the owner
from the Spend screen or `buzz ledger prices-add`, and an owner's row beats a
catalog row at the same instant precisely so a refresh cannot overwrite it.

## Staleness

A missing price is visible: spend using that model is flagged as unpriced
rather than counted as zero. A **wrong** price is not visible, which is what
`buzz ledger reconcile --from-provider` exists to catch, by comparing the
ledger against the provider's own invoice.
