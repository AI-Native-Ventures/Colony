# Additional Community Onboarding V2 Design

**Status:** Approved under Basheer's full product authority on 2026-08-21

## Goal

Make Create Community continue into the same Colony-branded onboarding language as first setup, without asking a returning founder to repeat identity, founder, or runtime configuration.

## Product decision

A newly hosted community gets a dedicated additional-community V2 journey:

1. The existing compact dialog claims the new hosted address.
2. Colony connects to the new community.
3. The full-screen chromatic journey asks for the new company's website, or a written description when there is no website.
4. Colony scans and presents an editable company summary.
5. Scout is introduced as the only starting agent.
6. The founder gives Scout the first task and enters the new Welcome workspace.

Joining an existing community keeps the current join and membership flow. It must not provision a new Scout or ask the joiner to define somebody else's company.

## Approaches considered

### 1. Recommended: a persisted additional-community V2 variant

Use a distinct `create-community` transaction source and initialize the existing durable V2 draft at the website stage. Reuse the scanner, company confirmation, Scout handoff, first-task marker, visual shell, and recovery behavior. Skip founder and runtime setup because both are machine-level state that already exists.

This fixes the complete user path while preserving restart safety and the approved visual system.

### 2. Replay the entire first-community journey

This would reuse more code but would make returning founders re-enter personal details and reinstall or reselect their runtime for every company. Rejected because it adds friction and can mutate working global runtime settings.

### 3. Reskin the legacy profile and team screens

This would make the old route look newer but would still omit website learning, editable company context, Scout's first task, and the durable V2 recovery contract. Rejected because it fixes appearance, not onboarding.

## Architecture

- `HostedCommunityCreateFlow` starts a `create-community` transaction after the relay provisions the hosted address.
- `startCommunityOnboarding` creates an additional-community V2 draft at `website` only for that source.
- `CommunityOnboardingFlow` selects the additional-community presentation from the persisted transaction source.
- `OnboardingV2Flow` uses a four-part business, context, Scout, and first-task trail. After company confirmation it moves directly to Scout.
- First-community behavior and join behavior remain unchanged.
- First-task copy omits founder fields when the additional-community draft does not contain them.

## Recovery and failure handling

- The transaction source and draft remain in local storage, so restart resumes the exact screen.
- Website validation, scan timeout, fallback description, finalization retry, and duplicate first-task protection reuse the existing V2 contracts.
- Failed hosted provisioning never starts onboarding.
- Failed community connection remains on the existing connection recovery screen.
- Failed Scout finalization preserves the company summary and first task for retry.

## Acceptance gates

1. Creating a hosted community starts `create-community`, persists a V2 draft at `website`, and never shows the legacy profile or starter-team screens.
2. The additional-community path shows the Colony V2 shell and drives website or description, editable context, Scout, first task, and Welcome entry.
3. Founder details, CLI detection, runtime installation, model selection, and payment setup do not repeat.
4. Joining an existing community keeps its current behavior.
5. Scout is the only starting agent and the first task remains exactly once across retry.
6. Unit, TypeScript, production build, native checks, and driven browser proof pass at the same commit.
