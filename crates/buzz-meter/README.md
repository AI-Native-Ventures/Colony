# The metering checkpoint

Every provider call an agent makes is forwarded through a loopback proxy that
reads the token counts off the provider's own response. That is what the cost
ledger is built on: it does not take an agent's word for what it spent.

Provider response parsing (usage blocks, stated cost, SSE reading) is
transport-independent and lives in `buzz-meter-core`, shared with the hosted
gateway so both paths compute the same number.

## The two routes are wire formats, not vendors

There is a `/anthropic` route and an `/openai` route. They exist because
providers speak one of two request dialects, not because there are two
companies. Vertex, Bedrock, DeepSeek, OpenRouter, Alibaba and a local runtime
all speak one of those two dialects while each sending its own invoice.

So the vendor is configured separately from the route:

| Setting | Meaning |
|---|---|
| `BUZZ_METER_ANTHROPIC_UPSTREAM` | Where Anthropic-dialect calls go. Default `https://api.anthropic.com`. |
| `BUZZ_METER_ANTHROPIC_PROVIDER` | Vendor slug recorded for them. Default: derived from the upstream host. |
| `BUZZ_METER_OPENAI_UPSTREAM` | Where OpenAI-dialect calls go. Default `https://api.openai.com`. |
| `BUZZ_METER_OPENAI_PROVIDER` | Vendor slug recorded for them. Default: derived from the upstream host. |
| `BUZZ_METER_ANTHROPIC_KEY` / `BUZZ_METER_OPENAI_KEY` | The real credential. Held here, never placed in an agent's environment. |

The slug is not cosmetic. Spend is **priced per provider and reconciled
against that provider's invoice**, so a call recorded under the wrong name is
priced from the wrong rate card and checked against a bill that never
contained it.

## Metering a provider that is not the default

Point the route at it, name it, and give the checkpoint the credential:

```sh
# DeepSeek direct. The slug is derived from the host, so naming it is optional.
BUZZ_METER_OPENAI_UPSTREAM=https://api.deepseek.com
BUZZ_METER_OPENAI_KEY=sk-...

# OpenRouter.
BUZZ_METER_OPENAI_UPSTREAM=https://openrouter.ai/api/v1
BUZZ_METER_OPENAI_KEY=sk-or-...

# Claude bought through Bedrock. The host says "amazonaws", so say what bills.
BUZZ_METER_ANTHROPIC_UPSTREAM=https://bedrock-runtime.us-east-1.amazonaws.com
BUZZ_METER_ANTHROPIC_PROVIDER=bedrock

# A local runtime. An address names no vendor, so this one must be stated.
BUZZ_METER_OPENAI_UPSTREAM=http://127.0.0.1:11434/v1
BUZZ_METER_OPENAI_PROVIDER=ollama
```

Agents must be configured for the **dialect**, not the vendor: an OpenRouter
or Ollama call is `provider=openai` from the agent's point of view, because
what it is really pointed at is the checkpoint's OpenAI-dialect route.

The checkpoint logs both recorded slugs at startup. Read that line once after
changing any of this; spending under the wrong name is silent, and the spend
still appears, just under a vendor whose invoice will never match it.

## Why the slug is stated and never guessed

By default the slug is derived from the upstream host: `api.deepseek.com`
becomes `deepseek`. That is a good default and a bad rule, because a host name
does not always name the seller. Bedrock and Vertex serve Anthropic's models
under Amazon's and Google's domains. A gateway, a private endpoint or a vanity
domain bills under a name the URL never mentions. And an IP address names
nothing at all.

Where the host yields no vendor, the call is recorded under the route's own
dialect (`openai` or `anthropic`) rather than under an invented name. That is
deliberately a **visibly wrong** answer rather than a plausible one: the price
book will eventually carry a zero-rate row for local runtimes, and if a
loopback address were silently read as "local and therefore free", anyone
tunnelling to a real vendor through `127.0.0.1` would have their spend read as
zero. Free is a claim someone has to make, not something inferred from an
octet.

## When the provider states what it charged

Some providers report the cost of a call on the call itself. The checkpoint
reads that figure, records it in nanoUSD alongside the token counts, and the
ledger uses it in preference to any rate in the price book. Such an entry
reports a price basis of `observed`.

This matters most for routers. OpenRouter picks a serving provider per request,
and the cost depends on which one it picked, so no rate table of ours could be
right in advance. It states `usage.cost` on every response, streaming included,
where it arrives in the terminal chunk.

The token counts are still recorded. The money comes from the provider; the
counts are what unit economics are built on.

**BYOK is handled separately and deliberately.** When a call runs on your own
key at the upstream provider, OpenRouter's `cost` narrows to its own 5% routing
fee, while the model itself is billed to your account with that provider under
`cost_details.upstream_inference_cost`. Both are your money, so the checkpoint
records the sum. If the upstream figure is absent, no observed cost is recorded
at all and the price book answers instead: the fee alone would understate the
call by roughly twentyfold, and an estimate that knows it is an estimate beats a
precise-looking figure that is wrong.

A stated cost of exactly zero is kept as zero. That is a provider saying the
call was free, which is a fact, unlike a zero the ledger inferred.

## Providers that are not routed through the checkpoint

An agent configured to call a provider directly (for example
`provider=openrouter` in its own config, which reads `OPENROUTER_BASE_URL`
rather than the checkpoint's) does not pass through here. Metering **fails
closed** for these: the checkpoint overwrites the credential env vars it knows
about, so the agent cannot spend money the ledger would never see. The call
fails rather than going unmetered.

To meter such a provider, route it through the checkpoint as above instead of
letting the agent reach it directly.

## Turning it off

`BUZZ_ACP_NO_METER` disables the checkpoint entirely. Agents then hold real
provider credentials and their spend is invisible to the cost ledger, which is
why it is an explicit opt-out rather than a side effect of configuration.
