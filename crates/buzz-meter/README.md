# The metering checkpoint

Every provider call an agent makes is forwarded through a loopback proxy that
reads the token counts off the provider's own response. That is what the cost
ledger is built on: it does not take an agent's word for what it spent.

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
