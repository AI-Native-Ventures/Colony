# Public Onboarding Membership Gate Fix

## Problem

The public Colony desktop release compiles the production relay URLs and also
sets `BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY`. On a fresh install,
`useCommunityInit` therefore persists the root production relay as the user's
first community before `WelcomeSetup` can render. The next profile write goes
through the root relay's normal membership gate, fails, and sends the user to
`MembershipDenied`. Public `POST /api/communities` is never attempted.

This is distinct from the earlier missing-relay build defect and the legacy
managed-agent relative-URL defect. The v0.10.13 binary contains the correct
production URLs, and the live relay v0.8.1 advertises public self-provisioning.

## Decision

Keep `BUZZ_RELAY_URL` and `BUZZ_RELAY_HTTP` compiled into both public Colony
artifacts, but stop setting `BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY` in the
public release workflow. The build-time auto-connect capability remains
available for private distributions whose default relay admits a tokenless
first connection.

Fresh public installs will stay in `WelcomeSetup`. Both the initial
"Create a community" path and recovery through "Change community" can then
reach the self-provisioning surface without first joining the root relay. After
creation, the existing transaction connects to the returned community host,
where the signer is already the owner and a relay member.

## Rejected Alternatives

- Fetch provisioning configuration inside `useCommunityInit` before deciding
  whether to auto-connect. This adds a network dependency and failure mode to
  cold boot for behavior the public release already knows at build time.
- Permit pre-membership profile writes on the root relay. This weakens the
  relay authorization boundary and still models a provisioning host as a user
  community.

## Release Scope

- Remove the auto-connect build variable from macOS and Windows public release
  build steps.
- Change the release contract to require production WS/HTTP URLs and forbid
  public auto-connect.
- Add fresh-install E2E coverage for the initial creation choice and the
  change-community recovery route.
- Bump the desktop release to v0.10.14.
- Do not change relay authorization, provisioning APIs, provider UX, or
  managed-agent relay resolution.

## Proof Gates

1. The new release/onboarding regression fails against the v0.10.13 contract.
2. Focused release-contract and desktop E2E checks pass after the change.
3. The normal local release gates pass for the changed paths.
4. PR CI and merge-queue CI pass before merge.
5. The develop-to-main promotion passes its full matrix before merge.
6. The v0.10.14 release workflow succeeds for both platforms.
7. The published macOS binary contains both production relay URLs, contains no
   localhost default, and does not contain the auto-connect marker.
8. A reset v0.10.14 build reaches community creation without displaying the
   membership-required gate. If live UI proof needs a human-owned machine
   action, stop and request that exact action rather than inferring success.

