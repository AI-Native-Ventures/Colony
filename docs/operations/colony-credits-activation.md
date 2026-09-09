# Activate Colony Credits for a bounded pilot

Prepared 2026-09-09. This is an activation plan, not evidence of activation.
No account, key, purchase, ledger grant or deployment was created while preparing it.

## Current blocker and acceptance gate

The owner confirmed that no Vercel AI Gateway account has been set up yet.
The September 9 deployment inspection found no `VERCEL_AI_GATEWAY_KEY` on
Fly app `colony-relay`; the public account route returned an empty HTTP 404.
The relay deliberately omits all Credits gateway routes without that key.
Recheck deployment metadata before acting; this is a dated observation.

Done means an installed beta can load the actual business's Credits balance and
served models, start an isolated teammate, return one approved draft, and show a
matching provider charge and Colony ledger debit. A green CI run, saved key or
healthy relay alone does not pass this gate.

## Owner decisions before activation

Approve these concrete choices together, then execute the steps below:

| Decision | Recommended initial pilot |
| --- | --- |
| Account | Company-controlled Vercel account/team, with the owner controlling billing and recovery; no plan upgrade or extra paid seats without approval |
| New cash purchase | $0 initially: use eligible Vercel free credits if the chosen model is available; adding the required payment method still needs the owner's action |
| Gateway budget | Dedicated `colony-credits-pilot` key, $1 cumulative budget, no reset, seven-day expiry; alerts at 50%, 75% and 100% |
| Colony grant | One $1 promotional ledger seed for the verified pilot owner's public key, with a unique idempotency reference |
| Work | One business, one active teammate at a time, short draft-only work; no schedules or external publishing |
| Production scope | Explicitly approve enabling the shared Fly relay; see the access boundary below |

Vercel currently provides $5 monthly free credit for eligible models, starting
with the first request. Free credit requires a valid team payment method.
Buying credits switches the team to paid usage and ends the monthly free
allowance. If a verified model requires paid access, propose a separate one-time
purchase of **up to $10 in Gateway credits**, show the exact checkout total
including fees/taxes, and obtain approval before paying. If the offered minimum
exceeds $10, stop at checkout. Keep auto top-up off; leave BYOK and optional paid
add-ons off for this pilot. Token charges follow the selected model's current
rates. [Pricing](https://vercel.com/docs/ai-gateway/pricing),
[payment-method prerequisite](https://vercel.com/docs/ai-gateway/getting-started).

The $1 key budget is a **soft cap**: an admitted request can complete above it.
Do not promise an exact $1 maximum invoice. Expiry and a non-resetting budget
avoid an unattended recurring pilot; alerts do not themselves stop requests.
Record the owner's acceptance of request-completion overshoot, including any
concurrent calls already admitted.
[Vercel budget behavior](https://vercel.com/docs/ai-gateway/observability-and-spend/budgets).

## 1. Create the company connection

In Vercel, select the intended company team before opening AI Gateway → API Keys.
Create the dedicated key with the approved budget and expiry. Confirm its team,
spend attribution and budget in the dashboard; keys default to creator
attribution, which can also encounter that member's budget. Store the one-time
key value in the company's approved secret store. Use the dashboard for creation
so the raw key is not printed into an agent transcript.
[Key creation and attribution](https://vercel.com/docs/ai-gateway/authentication-and-byok/api-keys).

The relay remains hosted on Fly. Do not migrate it to Vercel or create a Vercel
website deployment as part of this activation. Record any account-plan charge
shown by Vercel before accepting it; Gateway credit purchases and platform
subscriptions are different costs.

## 2. Verify models and the activation boundary

Read `model_catalog` from the target relay database through the approved operator
connection, selecting only `model_id`, `vercel_slug`, `enabled` and
`display_price_nanousd`. Compare each enabled slug with the current
[Vercel model catalogue](https://vercel.com/ai-gateway/models), including free-tier
eligibility, tool support, price and provider data terms. Database defaults are
historical seeds, not proof that a model is usable today. No usable model ID is
asserted by this plan.

Choose one verified, inexpensive, tools-capable model for the initial pilot.
If a catalogue correction is needed, prepare a reviewed, reversible database
change and check the gateway price book's fallback estimate too. Do not silently
substitute a model behind an existing Colony ID. Read the enabled catalogue back
after the approved change. Display prices are estimates; they do not set debits.

**Shared access boundary:** enabling this key mounts the gateway for the whole
relay. The model allowlist is deployment-global, and funded members can use it;
there is no pilot-owner allowlist. Inventory other funded accounts and existing
Credits agents before the change. Do not erase their balances to limit a pilot.
If activation must be inaccessible to everyone else, use an independently
approved staging relay/database or implement an explicit access gate first.
Seeding only one owner does not create such a gate.

## 3. Stage the secret and bounded relay settings

Colony expects the Vercel key under **`VERCEL_AI_GATEWAY_KEY`**, even though Vercel
examples call it `AI_GATEWAY_API_KEY`. Do not place either key in the desktop,
agent defaults, source control, PR text or logs. Leave
`VERCEL_AI_GATEWAY_BASE_URL` unset so the existing default
`https://ai-gateway.vercel.sh` is used; Colony appends `/v1/chat/completions`.

An approved operator can transfer the key from the secret store through a
protected stdin stream to `flyctl secrets import --stage --app colony-relay`.
Input is a `NAME=VALUE` pair. Never put the value in shell arguments/history,
enable shell tracing, or ask the owner to paste it into chat. If a temporary
file is unavoidable, use mode 0600 and remove it after transfer. `--stage`
stores the secret without deploying it.
[Fly secret import](https://fly.io/docs/flyctl/secrets-import/).

Prepare these nonsecret deployment settings for review:

```text
BUZZ_GATEWAY_DEFAULT_MAX_IN_FLIGHT=1
BUZZ_GATEWAY_DEFAULT_HOURLY_BURN_CAP_NANOUSD=500000000
BUZZ_GATEWAY_DEFAULT_TYPICAL_CALL_COST_NANOUSD=50000000
```

These mean one in-flight call and a $0.50 rolling hourly admission cap per
account, with the existing $0.05 typical-call guard. Check existing per-account
overrides, which can replace these defaults. These guards are not an exact
maximum request-cost guarantee; Vercel's dedicated key budget gates new shared
requests independently. The native worker sandbox remains enabled.

## 4. Deploy the reviewed relay artifact

Use GitHub CI only. Identify the exact reviewed source SHA, successful required
checks, published relay version tag and image digest. Desktop releases do not
publish relay images. Confirm the artifact contains the gateway, account-route
and settlement migrations required by the beta before choosing it.

After deployment approval, use
[Deploy relay to Fly](../../.github/workflows/fly-deploy-relay.yml) with the
verified relay image tag. This workflow deploys `colony-relay` using the existing
`immediate` strategy; arrange a suitable interruption window. It also runs
`scripts/verify-relay-live.sh`. Record the final Fly image digest/version and
health result. Do not treat the earlier 0.11.7 inspection as the deployment target.

Verify secret **names/status only**, startup's gateway-enabled message, and
successful migrations. Keep the single gateway admission authority: do not add
replicas during activation. If startup fails, inspect the redacted failure and
return to the known deployment; do not bypass migration or admission checks.

## 5. Fund the correct Colony account

Vercel credits fund Colony's upstream vendor bill. Colony Credits are a separate
ledger balance for the owner; buying one does not populate the other.

Before granting funds, record the $0 metadata proof in step 6. For the approved
promotional pilot, use the existing operator binary inside the
target relay's trusted environment, where its database connection is already
configured. Verify the owner's public key from the installed app, not a private
key or a stale screenshot. The following is an operator template, not a command
already executed:

```sh
buzz-admin credits balance --pubkey "$PILOT_OWNER_PUBKEY"
buzz-admin credits seed --pubkey "$PILOT_OWNER_PUBKEY" --usd 1 --ref "$PILOT_GRANT_REFERENCE"
buzz-admin credits balance --pubkey "$PILOT_OWNER_PUBKEY"
```

Record the grant as promotional, not customer money received. Reuse the same
reference when retrying an uncertain result; a new reference creates another
grant. Record the before/after ledger entry and verify the installed app reads
the same owner's available balance from its actual business host.

Customer top-ups already have a separate Paystack/PayFast checkout and verified
webhook path (`COLONY_PAYMENT_PROVIDER` plus that provider's credentials).
Its live readiness is unproven by this plan. Do not promise working purchases
until a separately approved real checkout, verified webhook, exactly-once ledger
credit and app refresh pass. A successful return URL alone must never credit an
account. Avoid creating or changing payment-provider accounts for this pilot.

## 6. Prove the installed experience and reconcile

Capture redacted evidence against the **actual business hostname** and verified
owner identity, rather than relying on the relay's base hostname:

1. Before funding, native account lookup succeeds at $0 and model discovery shows the
   served catalogue. These metadata reads must not create inference charges.
2. After the approved grant, save a served model using Colony Credits, without
   asking for an OpenAI key. Reload the app and confirm the choice persists.
3. Start the isolated teammate and approve one short draft-only job. Record the
   actual number of upstream calls; one job can contain several model calls.
4. Match the completed output, provider usage/reference, and Colony ledger debit.
   Check available balance and outstanding settlement reservations. The gateway
   settles before delivering its final response; an unresolved intent is not a
   proven charge.
5. Reconcile the same UTC-day/account/reference scope. The existing
   `buzz-admin credits reconcile --date <UTC-day> --vercel-csv <private-export>`
   sums **all database debits** for that day, not just this key or owner. Use it
   only when that scope matches the export; otherwise compare attributable
   gateway rows with matching provider records. Investigate any drift; use
   `credits resolve-gateway` only with exact account/reference/model/cost evidence
   and approval for any ledger mutation. Do not use aggregate totals to guess
   attribution.
6. Keep exhausted-balance, revoked-token, tenant-scope, retry and crash behavior
   covered by GitHub CI. If fault injection is needed against a deployment, use
   the approved pilot/staging identities; never drain money just to test a cap.

Finish by stopping the pilot agent and recording whether the key stays active
until its approved expiry. To stop upstream use immediately, revoke only the
dedicated Vercel pilot key. Disabling the relay gateway or changing its secret
also requires a deployment decision; preserve financial records and reconcile
outstanding requests before closing the pilot.

## Implementation references

- [Gateway configuration, model routing, account reads and settlement](../../crates/buzz-relay/src/gateway/mod.rs)
- [Deployment-global model allowlist](../../crates/buzz-db/src/gateway.rs)
- [Operator seed, balance and reconciliation commands](../../crates/buzz-admin/src/main.rs)
- [Customer payments and verified webhooks](../../crates/buzz-relay/src/api/payments.rs)
- [Native private Credits lease and model discovery](../../desktop/src-tauri/src/commands/agent_models_credits.rs)
- [Fly configuration](../../deploy/fly/fly.toml)

Record account setup, key staging, purchase approval, relay deployment, installed
beta proof and reconciliation as separate completed gates. This document completes
only the preparation gate.
