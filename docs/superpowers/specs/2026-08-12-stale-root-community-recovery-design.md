# Stale Root Community Recovery

## Problem

Colony 0.10.14 stopped public builds from automatically persisting the root
production relay as a user's first community. It did not remove records already
written by 0.10.13. An affected installation therefore keeps applying the root
relay on restart and reaches the normal membership denial when first-run profile
setup checks or writes membership.

The stored record has no explicit provenance marker. Recovery must therefore be
based on both persisted shape and a live, confirmed membership denial. Startup
alone is not enough evidence to delete anything.

## Decision

Recover reactively from the existing onboarding membership check. When the relay
has confirmed that the active identity is not a member, treat the saved community
as the obsolete 0.10.13 auto-connect record only when every condition below is
true:

- the public build reports default-relay auto-connect disabled;
- exactly one community is saved and active;
- its relay URL equals the compiled default relay URL after canonicalization;
- it has no invite token or repository override;
- its name equals the name derived by the old `initFirstCommunity` path.

For that exact state, clear community and community-navigation storage, disconnect
from the relay, and reload. The persisted identity, keyring item, machine-onboarding
completion, provider configuration, and unrelated local data remain untouched.
The reload must land on `WelcomeSetup`, where Create and Join are both available.

If any condition does not match, preserve the current `MembershipDenied` recovery
screen and all existing choices. This includes invited/token-bearing communities,
private distributions that still opt into auto-connect, a differently named
community, and any multi-community installation.

## Rejected Alternatives

- Delete a default-relay record at boot. Without a confirmed denial this can erase
  a valid private or invited configuration.
- Probe provisioning configuration before boot. That adds a network dependency to
  every startup and still does not prove the saved community is obsolete.
- Keep only the manual Change Community action. That leaves the already-affected
  cohort trapped in the same failure they received the patch to escape.

## Proof Gates

1. A fresh E2E fixture matching the 0.10.13 record reaches
   `MembershipDenied` before the fix.
2. After the fix, the same fixture clears only community state, reloads into
   Create/Join, and retains the identity override.
3. Unit coverage rejects token-bearing, renamed, multi-community, mismatched-relay,
   and auto-connect-enabled inputs.
4. Existing membership-denial recovery tests remain green.
5. The next public release artifact keeps the 0.10.14 relay contract: production
   provisioning URLs present and automatic default-relay connection absent.
6. Live proof uses an already-affected or equivalent reset fixture and creates no
   production community solely for verification.

## Scope

This patch changes only desktop recovery behavior and its tests. It does not alter
relay authorization, provisioning APIs, private distribution behavior, provider
UX, identity storage, or community creation semantics.
