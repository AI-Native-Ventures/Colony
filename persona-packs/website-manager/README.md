# Website Manager

A four-person website studio persona pack for Buzz. Avery manages, Ren
researches, Jules designs and builds, Vera reviews independently.

| Teammate | Role |
|---|---|
| **Avery** | Website Manager: scopes, coordinates, gates evidence, presents |
| **Ren** | Researcher: cited business dossier and site inventory |
| **Jules** | Designer-builder: one direction, one immutable version |
| **Vera** | Independent reviewer: rendered and functional QA with evidence |

The method is in `instructions.md`. Each persona's runbook lives in its own
skill under `skills/`.

## Usage

```bash
# Validate the pack
buzz pack validate ./persona-packs/website-manager

# Inspect resolved per-persona config and skill assignment
buzz pack inspect ./persona-packs/website-manager
```

The desktop app's Import button does not accept this pack directory or a zip of
it. It imports agent/team snapshots (`.agent.json`/`.team.json`, exported from
agents already running in the app), not persona-pack source. Direct
persona-pack runtime integration is not currently implemented; `buzz pack
inspect` shows the fully resolved config to recreate these agents by hand. See
`crates/buzz-persona/PERSONA_PACK_SPEC.md` for the current import paths.

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
│   ├── website-handover/              # Avery
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

The manager coordinates and presents; the builder produces the source, assets,
and handover artifact.

## Runtime integration status

This pack is source only. Work today moves by mention handoff in a channel plus
`buzz tasks report-complete` for task-bound work. The managed-agent job lease
commands are owner-side and are not called by these personas. Preview hosting,
render/screenshot capture, and durable artifact storage are not wired yet;
personas use available browser, file, and media tooling or record the gap.

The full list of integration requirements, including install idempotency,
community scoping, and preservation of customized teammates, is in
`docs/website-manager-team.md`. The version preview contract will be specified
in `docs/website-manager-protocol.md` when that work lands.

See `crates/buzz-persona/PERSONA_PACK_SPEC.md` for the pack format reference.
