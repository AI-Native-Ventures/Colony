# Activate Colony Credits for a bounded pilot

Updated 2026-09-09 after secret-only activation. The live gateway is enabled and
healthy on the existing relay artifact. A completed, charged agent task remains
unproven. No credit purchase was made. The owner approved a $1 promotional
ledger grant, which was applied and verified below.

## Current blocker and acceptance gate

The owner initially believed a new Gateway account was needed. Browser inspection
on September 9 found the existing `basheers-projects-d36c90c8` team has $5 in
AI Gateway credit, a verified payment method and auto-reload off. The owner
authorized a dedicated Colony pilot key on this team. A new subscription or
credit purchase is not needed for the initial pilot. The dedicated key is stored
in Fly, and the Vercel dashboard confirms a $1 cumulative budget with no automatic
reset. Expiration remains Never. The key was adopted by the live relay at 09:01
UTC. No inference request was made as part of activation verification.

Before staging on September 9, Fly app `colony-relay` had no
`VERCEL_AI_GATEWAY_KEY`, and the public account route returned an empty HTTP 404.
The relay deliberately omits all Credits gateway routes without that key.
At 08:48 UTC, Fly confirmed the new secret was stored for the next deployment.
The value was transferred directly between the owner-authorized browser forms;
no exported key file, source-code change or desktop credential was used.
At 09:01 UTC, secret-only deployment succeeded; the key and all three admission
settings are Deployed and their nonsecret runtime values were verified.

A read-only production transaction at 08:41 UTC on September 9 found one funded
account with $5 available, no Discovery or gateway reservations, and no admission
overrides. Enabled mappings were `deepseek/deepseek-v4-flash` and
`deepseek/deepseek-v4-pro`. This does not yet establish that the funded account is
the current desktop owner. The public [Flash catalogue](https://vercel.com/ai-gateway/models/deepseek-v4-flash)
confirms its slug and tool support; authenticated model access remains unproven.

Activation evidence at 09:01 UTC:

- Fly release 37, machine `879093a065e4d8` started; the existing relay 0.11.7
  revision `21bb91c2601d227e4bfa836f434707930788611b` was preserved.
- Image digest remained
  `sha256:6a1cb1610da8729feaaf3148e51ff126c569e1e25f19e83c8dbd9905e21f166d`.
- Readiness returned HTTP 200 ready. The account and model routes returned
  HTTP 401 requiring authentication, replacing the previously absent routes.
- Runtime admission defaults are one in-flight request per account, a $0.50
  rolling hourly admission cap and the existing $0.05 typical-call guard.
- At 09:04 UTC the running Electron beta's Welcome card showed "Add credits
  before starting this job." This verifies that its missing-gateway error has
  cleared; it does not prove model execution or identify the existing funded
  account as the current owner.
- At 09:05 UTC, a read-only lookup of the beta's exact active channel mapped it
  to `colony-4.colony.ainative.ventures`. Its owner public key matches the beta's
  displayed abbreviated identity and has no Credits account row ($0 available).
  The existing $5 account belongs to another identity.
- After the owner approved the $1 promotional grant, the installed operator
  command confirmed a $0 starting balance, inserted ledger entry 2 with reference
  `promo:colony-4:2026-09-09:gateway-pilot-1`, and returned a $1 balance. The same
  reference must be reused for any retry; no new cash was received or purchased.

The installed beta subsequently displayed $1.00 in Agent defaults and the
sidebar. Scout was running but repeatedly replaced before producing output.
The local log recorded 349 starts; server metadata recorded 348 successive
24-hour leases, with normal revocation and no inference debits or settlement
intents. A server clock slightly ahead of the desktop put the old `expiry - 24h`
refresh deadline milliseconds in the future. The source fix caps the refresh
lead at half the remaining lifetime and includes clock-skew regressions; the
updated packaged beta still needs verification. Scout was stopped through the
UI at 09:16 UTC. At 09:18 UTC the full $1 remained available.

Done means an installed beta can load the actual business's Credits balance and
served models, start an isolated teammate, return one approved draft, and show a
matching provider charge and Colony ledger debit. A green CI run, saved key or
healthy relay alone does not pass this gate.

## Authorization and remaining decisions

The owner approved using the existing Vercel team and key for Colony, and signed
into Fly for the server connection. Activation stayed within that scope. A new
purchase or expanded pilot remains a separate decision. The owner subsequently
approved the $1 promotional grant to the new `colony-4` account:

| Decision | Recommended initial pilot |
| --- | --- |
| Account | Owner approved `basheers-projects-d36c90c8` for the pilot; dedicated Colony key, shared team credit balance; no new plan or paid seats |
| New cash purchase | $0: use the existing team credit and verified payment method; no new purchase or subscription is authorized |
| Gateway budget | Verified: dedicated `colony-credits-pilot` key, $1 cumulative budget, no reset. Expiration is Never; alerts were not configured. |
| Colony grant | Approved and applied: $1 promotional credit to the new `colony-4` owner, ledger entry 2, idempotency reference `promo:colony-4:2026-09-09:gateway-pilot-1` |
| Work | One business, one active teammate at a time, short draft-only work; no schedules or external publishing |
| Production scope | Activated the existing shared Fly relay after inventory showed one funded account, no reservations and no admission overrides; see the access boundary below |

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
Do not promise an exact $1 maximum invoice. The non-resetting budget limits new
requests after exhaustion; it does not buy or refill credits. Team auto-reload
remains off. The current key does not expire automatically.
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

## 4. Activate the existing artifact, or deploy a reviewed change

This activation used `flyctl secrets deploy --app colony-relay` after confirming
the running revision already contained the gateway and required routes. It did
not build or deploy PR #664. The existing image and source revision were preserved.
The following artifact workflow applies when a subsequent code change is needed.

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
3. Start Scout manually for one short draft-only task. The delegated first-job
   suggestion requires an approved worker as well as Scout and is a separate
   acceptance gate; a successful solo task does not prove that workflow. Record the
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
beta proof and reconciliation as separate completed gates. The current record proves
secret storage, runtime adoption, healthy gateway routes and the approved
promotional ledger balance; it does not prove successful inference, the first-job
workflow or reconciliation.
