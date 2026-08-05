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

## Conditional rates

Vendors do not charge one rate per model. Reading their published pages in
August 2026:

| Vendor | Variation | Size |
|---|---|---|
| OpenAI | prompts over 272K input tokens | 2x input, 1.5x output |
| OpenAI | Batch / Flex service tiers | 0.5x |
| OpenAI | Fast mode (was Priority) | 2.5x |
| Anthropic | Batch API | 0.5x |
| Anthropic | Fast mode on Opus 5 / 4.8 | 2x |
| Anthropic | US-only inference (`inference_geo`) | 1.1x |
| DeepSeek | peak hours, announced, no start date yet | 2x |
| Any model | which provider served it | up to 1.7x |

Each is a silent mispricing if the book cannot express it, so a row can carry
conditions. Optional, and absent means "always", which is what every row
written before this means.

```json
{
  "model": "gpt-5.6-sol",
  "effectiveFrom": "2026-08-05T00:00:00Z",
  "inputPerMtok": "10",
  "outputPerMtok": "45",
  "minInputTokens": 272001
}
```

- `minInputTokens` / `maxInputTokens`: a context tier. `min` is inclusive,
  `max` exclusive, so two rows meet without overlapping. Counted over the
  **whole prompt**, cached tokens included, because that is what the vendor
  charges the premium on.
- `provider`: the slug of whoever served the call. See below.
- `tier`: `batch`, `flex`, `fast`, matched case-insensitively against what the
  meter recorded.
- `hours`: recurring local-time windows, e.g.
  `[{"start": "09:00", "end": "12:00", "utcOffsetMinutes": 480}]`. The offset
  is part of the window because vendors publish in their own timezone. An end
  earlier than its start wraps midnight.

**The most specific matching row wins**, then the later effective date, then
the owner over the catalog. Specificity outranks the date on purpose: a vendor
introducing a long-context tier publishes it after the base rate, and a newer
unconditional row must not start pricing long calls at the short rate. The
date decides which generation of a rate applies; conditions decide which rate
within it.

You do not need to bound the base row. An unconditional row matches
everything, and a conditional row outranks it whenever it applies.

A row nothing could satisfy (`minInputTokens` at or above `maxInputTokens`, an
empty tier, a window that starts and ends at the same minute) is refused at
parse time. It would otherwise look like the price was covered while every
call fell through to something else.

## Which provider served the call

The same model is sold by the lab that trained it and by everyone reselling or
rehosting it, each at their own price. Read on 2026-08-05,
`deepseek-v4-flash` was served by **21 providers between $0.084 and $0.14 per
million input tokens**: a 67% spread on one model string. Keyed on the model
alone, a call DigitalOcean served and invoiced was charged at DeepSeek's rate.

A row without a `provider` is the **vendor's list price**, and it prices calls
from everyone. That is what every row in this file is today, and what every row
published before this field existed continues to mean, so no stored book
changes value. Add a `provider` only to state what a specific provider charges:

```json
{
  "model": "deepseek-v4-flash",
  "provider": "digitalocean",
  "effectiveFrom": "2026-08-05T00:00:00Z",
  "inputPerMtok": "0.084",
  "outputPerMtok": "0.168"
}
```

**The provider is whoever invoices you, not whoever trained the model.** Claude
served through Vertex is `vertex`, because Google issues the invoice and
Google's price applies. A call through a router is the router, whichever
upstream it happened to pick, because the router's charge is the cost. This is
the only definition under which reconciliation against a provider's invoice can
balance.

Provider outranks every other condition, and is settled before model matching
rather than alongside it. Model matching is a hard gate (an exact row is chosen
without the alias rows being looked at), so ranked the other way round an exact
list row would beat an alias row naming the provider, and a Bedrock call would
price at Anthropic's list rate with a Bedrock rate sitting in the book. The
order is: rows naming the call's provider, then list rows; within each, exact
model before alias, then most specific, then later effective date, then owner
over catalog.

The other conditions describe variations *within one seller's list*: a batch
discount, a long-context premium, an off-peak window. The provider decides whose
list is read at all. Applying DeepSeek's peak-hour multiplier to a call Alibaba
served is not a more precise answer, it is the wrong list.

A row naming a provider **never** matches a call whose provider is unknown, on
the same reasoning as `tier`: a call we cannot place must not collect whichever
reseller's rate happens to be cheapest.

Every priced line records which kind of row supplied its rate, list or
provider, and that reaches the Spend screen. A rate wrong by a reseller's margin
looks exactly like a right one, so the basis is what lets anyone notice. A line
priced from list for a provider known to resell is the prompt to add a row.

## What this book still cannot express

**Service tiers are not yet observed.** `tier` rows parse and match, but the
meter does not record which tier a call used, and a row conditioned on a tier
never matches a call whose tier is unknown. That is deliberate: matching an
unknown tier would hand every call a 50% batch discount on no evidence. Batch
and Flex rates are therefore not in this file yet. Capturing `service_tier` at
the checkpoint is what unblocks them.

**No provider rows are in this file yet.** The dimension exists and is tested,
but every row here is still a list price. Adding rows for Bedrock, Vertex,
Alibaba and the rest means reading each provider's own page, and until that
happens a resold call prices at list and says so on the line.

**Local models are not priced at zero yet.** They cost nothing, and a `local`
row with all-zero rates is the right way to say so, but a zero row is the most
dangerous row in the book: if the slug matches more calls than intended, real
spend reads as free. It waits until the meter emits canonical provider slugs,
so the row and the thing it matches are written together. Until then local
calls report as unpriced, which is visible, rather than free, which is not.

**Anthropic's long-context premium** is not here either. Sonnet 4.5's row is
the list price for prompts up to 200K tokens, and the rate above that has not
been verified. Models from Claude 4.6 on include the full 1M window at
standard pricing, so this only affects the older rows.

**Multipliers are not a concept.** Anthropic's 1.1x US-only inference and the
10% regional-endpoint premium would each need their own row rather than a
factor applied to an existing one, and the request-side facts they depend on
are not recorded.

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
