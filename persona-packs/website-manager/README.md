# Website Manager

A four-person website studio persona pack for Buzz. Avery manages, Ren
researches, Jules designs and builds, Vera reviews independently.

| Teammate | Role |
|---|---|
| **Avery** | Website Manager: scopes, coordinates, gates evidence, verifies and presents the handover |
| **Ren** | Researcher: cited business dossier and site inventory |
| **Jules** | Designer-builder: one direction, one immutable version, handover bundle and access-request draft |
| **Vera** | Independent reviewer: rendered and functional QA with evidence |

The method is in `instructions.md`. Each persona's runbook lives in its own
skill under `skills/`.

## Install from the desktop app

In Colony, open **Agents**, choose **New team -> Website Manager**, pick the
channel this community should use, and run the install. The installer provisions
the team for the community you are in:

- creates the four persona definitions (editable like any other agent),
- creates one managed agent per persona, owned by you and pinned to that
  community, with Avery as the leader and Ren, Jules, and Vera reporting to her,
- writes each persona's skill into the agent workspace so the runtimes actually
  load it, and
- publishes the team, personas, and agents to that community's relay.

Installation is idempotent: clicking again, retrying after a partial install, or
restarting reconciles the existing records instead of creating duplicates. Agent
power inherits your saved defaults; nothing here pins a model, provider, or
credential. Edit names, prompts, skills, or roles afterward and the installer
preserves your edits on the next run.

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

Edit any `.persona.md` file or `SKILL.md` to adapt the team: rename teammates,
rewrite wording, adjust the method, change branding and house style. The pack
does not pin a model or provider; installed agents inherit the community's
runtime defaults.

The platform boundaries are not optional:

- Owner identity and authorization stay with the owner.
- Evidence honesty: no fabricated progress, preview, capture, or test.
- Scope discipline and the no-publication rule.
- No agent requests, stores, or uses an owner key.

The manager coordinates, verifies, and presents; the builder produces the
source, assets, and handover artifact.

## Runtime integration status

Work today moves by mention handoff in a channel plus `buzz tasks
report-complete` for task-bound work. That handoff is best-effort and does not
provide atomic deduplication across concurrent workers or a restart; recover
from the canonical Website Manager record once the platform integration is
wired. The managed-agent job lease commands are owner-side and are not called by
these personas. Preview hosting, render/screenshot capture, and durable artifact
storage are not wired yet; personas use available browser, file, and media
tooling or record the gap.

The full list of integration requirements is in `docs/website-manager-team.md`.
The preview manifest, review record, and derived decision identity are specified
in `docs/website-manager-protocol.md`.

See `crates/buzz-persona/PERSONA_PACK_SPEC.md` for the pack format reference.
