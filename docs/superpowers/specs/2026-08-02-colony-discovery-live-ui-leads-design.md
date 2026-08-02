# Colony Discovery live UI and Leads design

Date: 2026-08-02
Branch: `codex/discovery-next`
Worktree: `/Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-next`

## Outcome

Connect the existing Businesses Discovery interface to Colony's production
Discovery engine without replacing the provider-neutral UI contract or turning
Colony into a CRM. An entitled workspace can create a business campaign, run
Outscraper through the device-local worker, follow durable progress, and read
the unique normalized businesses retained as Leads. A workspace without an
active LAKA entitlement remains on the existing cost-free fixture demo and
cannot read real campaigns or Leads.

## Product boundary

- Businesses only. People Discovery remains a preview, not a live operation.
- Outscraper is the only production source in this phase. Brave, Exa, source
  waterfall, and concurrent execution remain visible only in fixture/demo
  states until their own provider gates pass.
- Every new, normalized, workspace-unique business observation becomes a Lead
  automatically. There is no manual import step.
- A business already retained anywhere in the workspace is counted as an
  existing result and is not saved or attached to a later campaign again.
- Paid records are retained. The LAKA entitlement controls access to them; it
  does not delete them.
- Revoking entitlement immediately cancels active runs and blocks subsequent
  campaign/Lead reads.
- Provider usage is BYOK and billed directly to the user's provider account.
  Colony stores returned/stored/existing counts, not monetary credits.
- LLM qualification is not required to preserve a user-funded result. Leads
  enter as `new`; optional BYOK LLM scoring is a later enhancement.
- Outreach and Conversations are outside this phase. The live campaign surface
  is Overview, Discovery, Leads, and source Settings. Existing fixture screens
  remain useful as product previews.

## System boundary

The relay remains the authority. The desktop and agents both submit signed
Nostr commands and trust only relay-signed, requester-private receipts. No new
feature-specific HTTP endpoint, Supabase dependency, browser local storage, or
direct desktop database access is introduced.

Two new strict event kinds separate workspace records from run execution:

- `40021` — member/agent-signed Discovery workspace action;
- `40022` — relay-signed, `p`-gated Discovery workspace receipt.

Run actions use `40017`/`40018`; worker actions use `40019`/`40020`.
The new kinds inherit the same author-only action storage, result-level read
gate, null full-text index, exact tag envelope, canonical JSON, signature
verification, membership check, entitlement check, and agent capability check.

## Workspace operations

The signed workspace contract supports five bounded operations:

1. `access` returns only whether the workspace entitlement is active. It is
   available to an authenticated member even when inactive so the UI can choose
   demo versus live mode.
2. `create_campaign` persists one validated Businesses campaign.
3. `get_campaign` returns one campaign plus its latest run and retained count.
4. `list_campaigns` returns at most 100 campaigns, optionally filtered by
   industry and vertical.
5. `list_leads` returns at most 100 normalized Leads with offset pagination,
   optionally scoped to the campaign that first retained them.

Every action has a request UUID and an idempotency UUID. Mutation retries are
atomic. Read retries are also bounded and auditable; receipts never contain
credentials, provider request IDs, raw provider JSON, or provider error bodies.

## Persistence

Migration `0035` adds:

- `discovery_campaigns`, community-scoped and immutable in the fields that
  determine a run: taxonomy IDs/names, provider query, location, target,
  language, and optional region;
- `discovery_workspace_action_claims`, binding one idempotency key to one
  request fingerprint, action event, and receipt event.

The existing observation table remains the canonical Lead store. Campaign
membership is derived through `first_run_id -> discovery_runs.campaign_id`.
This preserves the approved dedup behavior: a record retained by campaign A is
globally visible but is not attached to campaign B after a duplicate result.

Starting a run now requires an existing live campaign. The relay compares the
signed run search snapshot with the campaign's stored immutable search fields;
an actor cannot run an arbitrary query under another campaign ID.

## Desktop adapter

`DiscoveryRouteScreen` will instantiate one production-aware data source:

- `access=inactive` delegates all reads to the current fixture adapter with a
  not-entitled LAKA boundary;
- `access=active` uses fixture taxonomy/imagery but replaces campaign, Lead,
  entitlement, create, run, status, cancel, and retry operations with signed
  relay operations;
- People, Outreach, and Conversations do not silently call production APIs.

The adapter maps durable relay projections into the existing
`DiscoveryDataSource`, `CampaignDetail`, `DiscoveryRun`, and `Lead` contracts.
Run streaming is a bounded poll of signed status commands. Each poll refreshes
Lead counts; cancellation sends the existing signed cancel command. Community
switch resets any cached entitlement, campaign, receipt, and in-flight poll.

## Agent parity

`buzz discovery` gains workspace commands for access, campaign creation/list/
get, and Lead listing. The existing start/status/cancel commands continue to
operate the same durable runs. Any agent with the `discovery.run` capability
uses these commands; the Lead Specialist is a default capability assignment,
not a special backend identity.

Campaign, run, and Lead UUIDs are stable references suitable for chat output.
Rich chat cards are a later presentation layer over these same IDs.

## Acceptance gate

This phase passes only when deterministic and isolated-relay tests prove:

- inactive entitlement selects demo fixtures and cannot read real records;
- an entitled human and a granted agent can create/list/get the same campaign;
- a run can only start from the campaign's stored business search;
- three provider results become three `new` Leads automatically;
- rerunning the same or another campaign does not persist or attach duplicates;
- campaign/global pagination and counts are correct and bounded;
- live UI shows run progress and retained Leads after restart;
- cancellation and entitlement revocation stop progress and prevent reads;
- action/receipt/result paths contain no fixture credential or raw provider
  payload;
- existing Discovery settings/source proof and full `just ci` remain green.

A real Outscraper request remains a separate explicit spending gate. Pushing,
merging, deployment, subscription-provider integration, and customer proof are
also separate release states.
