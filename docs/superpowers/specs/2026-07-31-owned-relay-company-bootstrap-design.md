# Owned Relay Company Bootstrap Design

**Date:** 2026-07-31  
**Status:** Approved in conversation; awaiting written-spec review

## Purpose

Make the AI Native Office distribution open into a company workspace backed by
infrastructure we operate, without removing or replacing Buzz's Nostr identity
model, community tenancy, or optional Builderlab-hosted community support.

This phase proves one owned company on one owned relay. It does not build a
multi-company hosting business or a replacement for Builderlab.

## Architectural Finding

The fork contains three distinct layers that must remain separate:

1. **Nostr identity and protocol**
   - The desktop owns a local Nostr keypair.
   - The private key is stored in the OS keyring, with the existing guarded file
     fallback.
   - WebSocket and HTTP requests authenticate directly to the relay using signed
     Nostr events.
   - Managed agents receive their own Nostr keys and an owner-signed NIP-OA
     delegation.

2. **Buzz relay and communities**
   - A community is the relay's tenant boundary.
   - The request host maps to a server-resolved `community_id` before any
     tenant data is read or written.
   - The relay enforces community-scoped membership and owns messages, channels,
     profiles, DMs, blocks, workflows, media, repositories, and audit history.
   - A single-community deployment is a complete, self-hosted company workspace.

3. **Builderlab hosted provisioning**
   - Builderlab supplies an optional hosted account and provisioning journey.
   - It binds a Builderlab account to the user's Nostr public key, reserves a
     `*.communities.buzz.xyz` host, and manages Block-hosted communities.
   - After connection, the desktop and managed agents communicate directly with
     the returned Buzz relay.
   - Builderlab is not in the normal message, membership, or agent-runtime data
     path.

Builderlab's backend is not part of this repository and no public self-host
package is available here. The self-hostable component is the Buzz relay.

## Decision

Build an **owned single-company distribution** first:

- Operate one production Buzz relay under a domain we control.
- Use the existing community model as the internal company boundary.
- Supply the owned relay URL through the distribution's existing
  `BUZZ_RELAY_URL` configuration.
- Compile the distribution with
  `BUZZ_DESKTOP_BUILD_AUTO_CONNECT_DEFAULT_RELAY` so a fresh installation
  records that reviewed remote relay as its first community.
- Pre-provision the stable company-owner Nostr public key through
  `RELAY_OWNER_PUBKEY`.
- Enable relay membership and NIP-OA agent delegation using the relay's existing
  production configuration.
- Keep Builderlab-hosted community functionality intact and optional. It must
  not be called during the owned distribution's default startup or normal
  operation.

The app may present the internal community as the company in later
consumer-facing language work. Branding and terminology changes are outside
this phase.

## Alternatives Rejected for This Phase

### Bundle the relay inside the desktop application

Rejected because the production relay currently depends on Postgres, Redis,
S3-compatible object storage, and persistent git storage. Packaging that stack
inside a desktop application would introduce a second architecture and make
multi-device access harder.

### Build a Builderlab replacement now

Rejected because the current goal needs one company, not self-service creation
of many customer companies. The relay already has signed operator endpoints for
future multi-tenant provisioning, so building an account, DNS, billing, and
workspace-control service now would be premature.

### Remove Builderlab and multi-community code

Rejected because both are functioning optional capabilities. Removing them
would create unnecessary fork divergence and discard a future route for joining
or managing other relays.

## Components

### 1. Owned relay deployment

Use the repository's production Compose deployment:

- `buzz-relay`
- Postgres
- Redis
- MinIO or another supported S3-compatible service
- persistent git storage
- TLS and DNS in front of the relay

Cloudflare may provide DNS, TLS, and WebSocket proxying. The relay and its state
services remain an origin deployment; this design does not rewrite the relay as
a Cloudflare Worker.

Required production invariants:

- `RELAY_URL` resolves to the public WebSocket host.
- `RELAY_OWNER_PUBKEY` is the stable human owner identity.
- `BUZZ_RELAY_PRIVATE_KEY` is stable across restarts.
- `BUZZ_REQUIRE_RELAY_MEMBERSHIP=true`.
- `BUZZ_ALLOW_NIP_OA_AUTH=true`.
- database, Redis, object-storage, and git secrets persist across deployments.
- migrations are applied through the repository's supported migration path.

### 2. Owned desktop distribution profile

Reuse the existing desktop configuration boundary:

- `get_default_relay_url()` obtains the reviewed default from
  `BUZZ_RELAY_URL`.
- `auto_connect_default_relay_enabled()` exposes the compiled distribution
  opt-in.
- `useCommunityInit()` records the remote relay with `initFirstCommunity()`
  only when the explicit auto-connect build flag is present.
- `applyCommunity()` installs the selected relay in the Tauri backend without
  moving the human private key into browser storage.

No new authentication provider or company-selection page is introduced.

The normal first-run sequence is:

1. Resolve or generate the local human Nostr identity.
2. Load the owned relay supplied by the distribution.
3. Persist it as the first local community.
4. Connect and complete NIP-42 authentication.
5. Verify relay membership.
6. Complete the existing relay-local profile and welcome flow.
7. Enter chat.

Builderlab login is entered only when the user explicitly chooses the existing
Block-hosted community-management path.

### 3. Membership bootstrap

The first company owner is an operator-provisioned identity, not "whoever
connects first."

For the initial Horizon dogfood deployment:

- Use one stable owner Nostr identity.
- Configure its public key as `RELAY_OWNER_PUBKEY` before admitting users.
- Keep the corresponding private key only in the owner's OS keyring and
  recoverable encrypted backup; never place it in relay configuration.
- Add additional humans through the relay's existing invite or member-management
  paths.

There is no unauthenticated endpoint that promotes the first connecting identity
to owner.

### 4. Managed agents

Managed agents remain independent Nostr identities:

- The desktop generates an agent keypair.
- The agent private key is stored under the existing agent-specific OS-keyring
  entry.
- The human owner identity signs the agent's NIP-OA authorization tag.
- The desktop starts the ACP harness with the owned relay URL, the agent private
  key, and the authorization tag.
- The relay admits the agent through the already-member owner when
  `BUZZ_ALLOW_NIP_OA_AUTH=true`.

Builderlab is not consulted during agent creation, startup, authentication,
message handling, or tool execution.

## Ownership Boundary

| Concern | Authority in this phase |
| --- | --- |
| Human Nostr private key | User device OS keyring |
| Agent Nostr private keys | User device OS keyring |
| Company URL and TLS | Our DNS and infrastructure account |
| Host-to-community mapping | Our Buzz relay database |
| Company owner and members | Our relay membership records |
| Messages and work history | Our relay event store |
| Media and repositories | Our object and git storage |
| Agent process execution | User's desktop and configured agent providers |
| Builderlab account | Optional external hosted path only |
| Self-service company provisioning | Not built in this phase |

## Failure Handling

### Relay unavailable

Keep the owned community selected and show the existing reconnect/error
experience. Never redirect the user to Builderlab or silently create a
different community.

### Owner is not provisioned

The closed relay rejects the connection. Deployment validation must catch a
missing or invalid `RELAY_OWNER_PUBKEY` before release. The client must not
weaken membership enforcement to recover.

### Keyring unavailable

Keep the existing identity-locked and managed-agent key-unavailable states.
Never generate replacement identities for persisted users or agents merely
because the keyring cannot be reached.

### Builderlab unavailable

Only the explicitly selected hosted-community management path is affected.
The owned relay, stored communities, messages, and agents continue operating.

### Domain or host mismatch

The relay fails closed because tenancy is host-derived. Deployment validation
must exercise the public hostname, not only the origin IP or localhost port.

## Security Requirements

- No private Nostr key is sent to Builderlab, the relay, or our deployment
  configuration.
- The relay owner is configured explicitly; first-connection ownership is
  forbidden.
- Unknown hosts never fall through to another community.
- Closed-relay membership remains enabled in production.
- NIP-OA agent delegation is verified by the relay and scoped through a member
  owner.
- The distribution cannot accept a user-supplied environment override that
  redirects managed agents away from the active company relay.
- Builderlab session credentials remain isolated from normal community state.

## Verification and Acceptance Gates

### Automated desktop proof

- A fresh owned-distribution state with a reviewed non-local default relay
  creates exactly one local community automatically.
- No Builderlab Tauri command is invoked during this startup.
- The generated community stores the current human public key and never stores
  an `nsec`.
- A relay failure preserves the selected company and exposes retry rather than
  opening hosted onboarding.
- Existing explicit Builderlab-hosted and custom-relay flows continue passing
  their current tests.

### Relay proof

- The public host resolves to exactly one community.
- An unknown host fails closed.
- The configured owner authenticates and is recorded as owner.
- An unprovisioned human identity is rejected.
- A valid invite admits a second human only to this community.
- A managed agent with a valid owner-signed NIP-OA tag authenticates.
- The same agent with a missing or invalid tag is rejected.

### Live product proof

Against the public owned relay:

1. Launch a fresh packaged owned distribution.
2. Confirm there is no Builderlab browser login or community chooser.
3. Complete the relay-local profile flow and enter chat.
4. Send and receive a message.
5. Create or restore a managed agent.
6. Start the agent and receive an agent response in chat.
7. Restart the desktop and confirm the human identity, community, and agent
   identity persist without replacement.
8. Record relay logs and screenshots proving the public hostname, membership,
   chat, and agent paths.

Passing unit tests or a successful build is not sufficient for this gate.

## Rollout

1. Establish the stable owner identity and protected recovery backup.
2. Deploy the production Compose stack behind our domain.
3. Validate relay health, host binding, owner membership, and persistence.
4. Produce the owned desktop distribution with the reviewed relay URL and
   auto-connect flag.
5. Run the automated and live acceptance gates.
6. Keep the release private to Horizon dogfooding until chat and managed-agent
   operation are live-proven.

Rollback disables the owned distribution's auto-connect build flag or points a
new build at the previous reviewed relay. It does not delete relay data or alter
the user's Nostr identity.

## Future Multi-Company Path

When separate customer companies require self-service creation, build an owned
control plane around the relay's existing signed operator APIs:

- authenticate the customer,
- prove control of their Nostr public key,
- reserve a host under our wildcard domain,
- call `POST /operator/communities` with `create_only=true`,
- assign the initial owner atomically,
- manage listing, availability, archive, unarchive, and transfer,
- configure DNS/TLS routing and operational limits.

That service is the future Builderlab-equivalent. It is intentionally not part
of the single-company proof.
