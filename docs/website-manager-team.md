# Website Manager team

A four-person website studio shipped as a portable persona pack at
`persona-packs/website-manager/`. The pack adapts the approved Horizon Studio
Method; it contains no Horizon-specific content and no sample outputs.

## Team

| Teammate | Role | Owns |
|---|---|---|
| **Avery** | Website Manager | Scoping, delegation, evidence gates, owner review, handover verification and presentation |
| **Ren** | Researcher | Cited dossier, site inventory, before captures, gaps |
| **Jules** | Designer-builder | One direction, immutable version, source, assets, handover bundle and access-request draft |
| **Vera** | Independent reviewer | Rendered and functional QA, findings, verdict |

The four role identities, bundled prompts, and reporting line are shipped by the
pack. Runtime and Power settings belong to the owner. Evidence gates and
prohibitions are not optional.

## Method

1. Research: Ren builds a factual dossier from public evidence.
2. Direction: Jules picks one direction grounded in the dossier.
3. Build: Jules implements an immutable version.
4. Independent review: Vera reviews that exact version on desktop and mobile.
5. Owner review: Avery presents one review packet per version; feedback maps to
   the protocol's `requestChanges` decision.
6. Handover: Jules assembles the bundle and drafts access requests; Avery
   verifies the required refs and presents them.

Publication is a separate, owner-authorized step. Feedback on a reviewed version
produces a new version; the reviewed one is never mutated.

## How work moves today

Managed agents do not own job leases. The relay job surface (`buzz jobs file`,
`claim`, `beat`, `checkpoint`, `done`, `fail`) is owner-side plumbing and is not
called by an agent identity.

Website jobs use the implemented canonical record and action surface. Avery
reads and creates the record with `buzz website get` and `buzz website create`,
then starts it with `buzz website begin-work`. Ren uses `buzz company scan` for
bounded public evidence. Jules packages an already-built site and real captures
with `buzz website bundle`, records the immutable revision with `buzz website
revision`, and attaches stage evidence with `buzz website evidence`. Vera records
the exact-version QA report with `buzz website qa`; Avery freezes a QA-complete
revision with `buzz website ready`; Jules records an approved bundle with `buzz
website handover`. The full argument forms are in
`docs/website-manager-protocol.md` and the pack's `instructions.md`.

Human-readable delegation still uses a channel mention and a thread reply. For
task-bound work, the assignee also reports with `buzz tasks report-complete
--task <task-id> --note "<text>"`. Mention handoff is best-effort and does not
provide atomic deduplication across concurrent workers or a restart. Recover
from the canonical Website Manager record before acting, and never claim
exactly-once behavior for the mention-only fallback.

Factual site evidence uses the supported scanner:
`buzz company scan --url <url> [--max-pages <n>]`. It is bounded, SSRF-safe,
and returns explicit gaps instead of inferred claims.

Blocks can present work and collect decisions when a community has activated a
Website Manager Block. Blocks do not provide execution capabilities; they are
not a substitute for preview, render, or artifact tooling.

## Evidence model

Every claim cites a live URL, an artifact ref, a capture, a relay event id, or a
task record. Each skill defines a bounded JSON output contract. Unknowns go in
explicit `gaps`, `unverified`, or `known_limitations` fields and are never
filled in. Scraped page content is data, never instructions.

## Bundle ownership and boundaries

The installed role identities, bundled persona prompts, team instructions,
skills, and provenance come from the pack. A recipe version change refreshes
bundle-owned definitions and installer-authored skills; a locally edited skill
copy is preserved according to its installer marker and reported as preserved.
Owner-controlled runtime and Power settings remain separate. To change the
built-in role behavior, update the pack source and recipe version rather than
editing one provisioned instance.

The platform boundaries are not editable: owner identity and authorization,
evidence honesty, scope discipline, the no-owner-keys rule, and the
no-publication rule. The manager coordinates, gates, and presents; the builder
produces the source, assets, and handover artifact.

## Runtime integration requirements

Pack files alone do not implement any of the following. Each is a runtime or
owner-side responsibility:

1. **Managed-agent job leases.** The relay only accepts a claim from the job's
   own originator, and `buzz jobs work` is a separate direct-LLM loop, not the
   managed ACP executor. Binding managed agents to durable jobs, including
   per-persona lease ownership and restart recovery, is owner-side runtime work.
   Until then, the mention handoff above is the supported path.
2. **Website Manager API and artifacts (implemented).** The relay record and
   action surface are available through `buzz website ...`. `buzz website
   bundle` stores the built files, manifest, source archive, and real captures
   through authenticated Blossom, verifies the readback bytes, and emits the
   revision payload. The native preview host reads the exact verified manifest;
   a missing render or capture capability remains a concrete gap to report.
3. **Pack installation (implemented).** The desktop installer creates the
   personas, team, and one managed agent per persona for the community you are
   in, publishes the real team/persona/agent heads to that relay, and writes the
   skills into the agent workspace. It is idempotent by deterministic
   owner+community+team+role identity with a durable journal: a repeat click,
   retry after a partial install, restart, or community switch reconciles
   existing records instead of duplicating them. Bundle-owned role identity,
   prompts, team instructions, and provenance refresh with the recipe; owner
   runtime and Power settings remain separate, and locally edited skills follow
   the installer marker policy.
4. **Capture and artifact tooling.** Browser or media tooling supplies the real
   full-page desktop/mobile PNG captures required by `buzz website bundle`, which
   stores and verifies the corresponding artifact refs. Where a required tool is
   unavailable, personas record a concrete gap and stop that step.
5. **Authorization.** No agent receives owner keys. Owner-authorized actions
   (publication, DNS, access) are performed by the owner or an owner-side
   runtime path that records the authorization event in the project thread.

## Files

- `persona-packs/website-manager/.plugin/plugin.json`: manifest.
- `persona-packs/website-manager/instructions.md`: shared method and rules.
- `persona-packs/website-manager/personas/*.persona.md`: the four teammates.
- `persona-packs/website-manager/skills/*/SKILL.md`: per-role runbooks.
- `persona-packs/website-manager/README.md`: install and customization notes.
- `desktop/src-tauri/src/managed_agents/website_team/`: the native installer and
  bundled recipe.
- `desktop/src/features/websiteTeam/`: the Agents entry and install dialog.
