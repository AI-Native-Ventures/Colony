# Colony

Design context for `impeccable`. Derived from committed sources: `docs/BRAND.md`
(brand source of truth), `VISION.md`, `desktop/src/shared/ui/colony-logo/palette.ts`,
`desktop/tailwind.config.js`. Where this file and code disagree, the code wins.

register: product

## Product purpose

Colony is a workspace where humans and AI agents work in the same rooms. Agents
sit in channels, watch the work, and act: finding leads, doing outreach,
researching, running jobs in the background. The workspace is the relay, so
conversation, agents, automation, docs and artifacts live in one place under one
identity rather than being stitched across five services.

Colony is built on Buzz, Block's open-source relay and app platform. Internals
keep the Buzz name. Everything a user sees is Colony.

## Users

Two populations, and the tension between them is the central design problem.

**Non-technical founders and operators.** The majority, and the ones the product
is being rebuilt for. They run real businesses. They do not know what a CLI is, a
terminal is, an API key is, or what ACP means. They have no AI subscription. They
arrived because Colony promised agents that do work, not a tool they configure.
The first cohort of testers was overwhelmingly this population and overwhelmingly
could not get started.

**Technical users.** Arrived from the Buzz lineage. Already have Claude Code,
Codex, OpenCode or Pi installed and configured. They bring their own model
access. They are not the constraint, and the interface must never optimise for
them at the expense of the first group.

The rule that falls out: nothing developer-facing on screen. No key, no nsec, no
terminal, no API key, no runtime name the user did not already have installed.
Where a technical concept is unavoidable, it gets a human word. An agent runtime
is a "brain".

## Brand

The mark is a geometric minimal ant, side profile, drawn in `currentColor`.
Colony, not hive: a colony is many small agents whose coordination is the point.

Violet leads at `hsl(258 90% 66%)`. Blue, pink, amber and green are accent hues
used for scatter and multi-agent surfaces, never as UI status colors.

Three motion primitives carry the identity, all already implemented:

- **Walking gait**, alternating leg-tripod, 0.42s cycle, used for loading.
- **Pheromone trails**, animated dashed paths connecting points, used to show
  agents coordinating.
- **Scatter field**, a multi-hue field of ants with pointer repel, used on
  landing and onboarding surfaces.

Do not stretch, outline, or gradient the mark. Do not reintroduce bee assets or
bee-themed naming in anything user-visible.

## Tone

Plain, direct, and short. Say what is happening, in the words the user would use.
"Checking what's already on your computer", not "Provisioning runtime
environment". Never explain an internal concept the user did not ask about: a
site behind a bot wall is "We couldn't reach that site", not a lecture on
Cloudflare.

Confidence without hype. Colony does real work, so the copy describes work, not
adjectives about work.

No em dashes anywhere in user-facing copy. This is a hard rule, not a preference.

## Anti-references

- **Developer tools that leak their plumbing.** The thing being fixed. A screen
  that names a runtime, a key, or a config path has failed.
- **Onboarding that asks before it gives.** Forms that collect demographics and
  payment before the user has seen anything work.
- **Fake progress theatre.** Loading copy that describes work the app is not
  doing. If the app is reading the filesystem, the copy says so.
- **Enterprise SaaS neutrality.** Grey cards on a grey background, an icon and
  two lines of text, repeated. Colony has an actual visual identity and should
  look like it.
- **Bee and hive metaphors.** Retired.

## Strategic principles

1. Never trap the user. Every blocking step has a timeout and a way forward.
2. Ask for money after value, never before it.
3. Who pays for inference decides who sees a wall. Users on their own model
   access cost nothing and are not walled.
4. Motion earns its place by explaining something: what is happening, how long it
   will take, or what just changed. Decoration that explains nothing gets cut.
5. Every animation has a `prefers-reduced-motion: reduce` fallback to a static
   state. Not optional polish.
