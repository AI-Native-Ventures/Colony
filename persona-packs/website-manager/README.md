# Website Manager

A four-person website studio persona pack for Buzz. Avery manages, Ren
researches, Jules designs and builds, Vera reviews independently.

| Teammate | Role |
|---|---|
| **Avery** | Website Manager: scopes, coordinates, gates evidence, verifies, records and presents the handover |
| **Ren** | Researcher: cited business dossier and site inventory |
| **Jules** | Designer-builder: one direction, one immutable version, handover bundle and access-request draft for Avery to verify |
| **Vera** | Independent reviewer: rendered and functional QA with evidence |

The method is in `instructions.md`. Each persona's runbook lives in its own
skill under `skills/`.

## Install from the desktop app

In Colony, open **Agents**, choose **New team -> Website Manager**, pick the
channel this community should use, and run the install. The installer provisions
the team for the community you are in:

- seeds the four bundle-owned persona definitions and refreshes their bundled
  role configuration when the recipe version advances,
- creates one managed agent per persona, owned by you and pinned to that
  community, with Avery as the leader and Ren, Jules, and Vera reporting to her,
- writes each persona's skill into the agent workspace so the runtimes actually
  load it, and
- publishes the team, personas, and agents to that community's relay.

Installation is idempotent: clicking again, retrying after a partial install, or
restarting reconciles the existing records instead of creating duplicates. Agent
Power inherits your saved defaults; nothing here pins a model, provider, or
credential. Built-in role identity, prompts, team instructions, and provenance
come from the bundle and are refreshed on a recipe version change. Owner-owned
runtime and Power settings remain separate. Installer-authored skills can be
updated with the bundle; a locally edited skill copy is preserved and reported
as preserved.

## Pack source

The pack source stays valid for inspection:

```bash
# Validate the pack
buzz pack validate ./persona-packs/website-manager

# Inspect resolved per-persona config and skill assignment
buzz pack inspect ./persona-packs/website-manager
```

`buzz pack inspect` is useful for reviewing the recipe the installer bundles; it
is not required to install the team.

## Structure

```
website-manager/
├── .plugin/
│   └── plugin.json                    # Pack manifest
├── personas/
│   ├── avery.persona.md               # Manager
│   ├── ren.persona.md                 # Researcher
│   ├── jules.persona.md               # Designer-builder
│   └── vera.persona.md                # Independent reviewer
├── skills/
│   ├── website-team-workflow/         # Avery
│   ├── website-owner-review/          # Avery
│   ├── website-handover/              # Jules
│   ├── website-research/              # Ren
│   ├── website-direction-build/       # Jules
│   └── website-independent-review/    # Vera
├── instructions.md                    # Shared method and rules
└── README.md
```

Every skill is claimed by exactly one persona, so none falls through as shared.

## Customizing

Customize the pack source before installing it: change the persona bodies,
skills, method, branding, or house style, then advance the recipe version so an
installed team receives the bundled update. The pack does not pin a model or
provider; installed agents inherit the community's runtime defaults. A skill
copy edited locally after installation is preserved according to its installer
marker and is reported as preserved.

The platform boundaries are not optional:

- Owner identity and authorization stay with the owner.
- Evidence honesty: no fabricated progress, preview, capture, or test.
- Scope discipline and the no-publication rule.
- No agent requests, stores, or uses an owner key.

The manager coordinates, verifies, records, and presents; the builder produces
the source, assets, and handover artifact for the manager to verify.

## Runtime integration status

Website jobs use the implemented canonical record and relay action surface:

```text
buzz website get --channel <uuid> [--task <task-id>] [--job <uuid>]
buzz website create --channel <uuid> --task <task-id> --thread <root-hex> \
  --instance <event-id> --manifest <event-id> --coordinator <pubkey> \
  --source-url <https-url> [--research <persona>]... [--build <persona>]... \
  [--review <persona>]...
buzz website begin-work --channel <uuid> --task <task-id> --thread <root-hex> \
  [--generation N]
buzz website bundle --dir <built-site> --source <source-dir-or-archive> \
  --before <before.png> --desktop <desktop.png> --mobile <mobile.png> \
  [--entrypoint index.html] [--source-url <https-url>] [--out revision.json]
buzz website revision --channel <uuid> --task <task-id> --thread <root-hex> \
  [--generation N] --file revision.json
buzz website qa --channel <uuid> --task <task-id> --thread <root-hex> \
  [--generation N] --revision N [--passed] --report-url <https-url> \
  --report-file <path> [--report-event <hex>]
buzz website evidence --channel <uuid> --task <task-id> --thread <root-hex> \
  [--generation N] --stage <stage> [--revision N] --kind <kind> --event <hex>
buzz website ready --channel <uuid> --task <task-id> --thread <root-hex> \
  [--generation N]
buzz website request-changes --channel <uuid> --task <task-id> --thread <root-hex> \
  [--generation N] --revision N --hash <sha256> --note <text>
buzz website handover --channel <uuid> --task <task-id> --thread <root-hex> \
  [--generation N] --file handover.json
```

Jules prepares `handover.json` after owner approval and sends it to Avery.
Avery verifies the exact current revision, manifest hash, QA record, source and
asset refs, then records it as the pinned coordinator with the command above.
The relay does not authorize the builder persona to record a handover.

`buzz website bundle` packages an already-built site and uploads its files,
manifest, source archive, and real before/desktop/mobile PNG captures through
authenticated Blossom. It verifies every upload by reading it back and emits
the JSON consumed by `buzz website revision --file`; it does not run a build or
fetch resources linked from the HTML. Native preview rendering reads the exact
verified manifest, so a missing render or capture capability is reported as a
gap. Managed-agent job leases remain owner-side and are not called by these
personas.

Human-readable delegation still uses mentions in the project thread plus
`buzz tasks report-complete` for task-bound work. Mention handoff is best-effort
and does not provide atomic deduplication across concurrent workers or a
restart; recover from the canonical Website Manager record before acting and do
not claim exactly-once behavior for a mention-only fallback.

The full list of integration requirements is in `docs/website-manager-team.md`.
The preview manifest, review record, and derived decision identity are specified
in `docs/website-manager-protocol.md`.

See `crates/buzz-persona/PERSONA_PACK_SPEC.md` for the pack format reference.
