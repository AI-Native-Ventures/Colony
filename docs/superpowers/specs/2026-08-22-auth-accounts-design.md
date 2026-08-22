# Email and password accounts with zero-knowledge key escrow

**Status:** approved, ready for planning
**Implements:** the `auth.*` contract left open by
[the onboarding redesign spec](2026-08-21-onboarding-redesign-design.md),
whose "Out of scope" section named "auth service internals, key escrow,
password reset flow". This spec is that scope.

## Why this exists

Colony identity is a Nostr keypair. That works for the Buzz-era technical
audience and fails for everyone else: a keypair cannot be remembered, cannot be
typed on a second device, and has no concept a non-technical founder already
holds. The onboarding redesign therefore asks for email and password on screen
1, and a recovery code on screen 2. Nothing behind those two screens exists yet.

The relay has no notion of an email address anywhere today. This is a new
subsystem, not a wiring job.

## The constraint that shapes everything

**Signup happens before the user has a key.** Every Nostr event must be signed,
so no event kind can carry a signup. This is the rare case the repo's
"prefer Nostr events over new HTTP endpoints" rule explicitly reserves an
exception for, and it must be stated in the code so a future reader does not
"fix" it into an event kind.

The precedent is `POST /api/invites/claim`, which is likewise exempt from the
membership gate because the caller is not a member yet.

## Security posture

**The relay never learns the password and never learns the private key.**

The user's password stays on their computer. What reaches the relay is an
opaque encrypted blob plus a derived authentication value, neither of which
can be turned back into the password or the key without a brute-force attack
against a memory-hard KDF.

The direct consequence, which is a product decision and not an implementation
detail: **Colony cannot reset a password.** A user who loses both their
password and their recovery code has permanently lost that account and the
workspace behind it. There is no admin override, no support path, and no
mechanism that could be added later without abandoning this model. The
onboarding spec already commits to this wording on screen 2 ("Colony cannot
reset it for you"), and screen 2 exists solely to make it survivable.

This is a deliberate trade. The alternative, holding decryptable keys
server-side, would make Colony able to read every user's private messages and
sign as any user, which for a product whose whole premise is agents acting
with your identity is not acceptable.

### What the relay can see

| Value | Relay sees | Notes |
|---|---|---|
| Email address | yes | needed to look an account up |
| Public key | yes | already public by definition |
| Password | **no** | never transmitted in any form |
| Private key | **no** | only ever inside an encrypted blob |
| Recovery code | **no** | only its SHA-256, and only the escrow blob it opens |
| `auth_key` | transiently | verified against a stored Argon2id hash, never stored raw |

### Residual risks, named

1. **Offline attack on a stolen blob.** A database breach yields ncryptsec
   blobs. A weak password is then brute-forceable offline at scrypt cost. The
   10-character minimum plus zxcvbn score >= 2 from the onboarding spec is the
   mitigation, and it is a real limit, not a guarantee.
2. **Email enumeration.** Signup must tell the user "that email already has a
   Colony account" (onboarding spec, screen 1 states). That is an enumeration
   oracle, accepted on purpose because the alternative silently traps users on
   the one screen we are rebuilding *because* people got stuck. Rate limiting
   bounds bulk harvesting; it does not eliminate the oracle.
3. **A malicious relay build could serve tampered client code.** Out of scope:
   the desktop app is a signed binary, not served by the relay.
4. **No email verification at signup.** An attacker can register an address
   they do not own, which denies that address to its real owner. Accepted for
   now, tracked as open question 1.

## Cryptographic design

Three independent secrets, derived on the device:

```
password ──scrypt (NIP-49, log_n=16)──> blob A = ncryptsec1…   (encrypts nsec)
recovery ──scrypt (NIP-49, log_n=16)──> blob B = ncryptsec1…   (encrypts nsec)
password ──PBKDF2-SHA256, 600k iters──> auth_key               (proves identity to relay)
```

**Blobs A and B encrypt the same private key.** Either one opens the account.
That is what makes the recovery code a genuine second path and not a hint.

**Blob format is NIP-49 `ncryptsec`**, produced by the existing
`create_ncryptsec_backup` Tauri command (`desktop/src-tauri/src/key_backup.rs`)
and consumed by the existing `import_identity` command. No new client-side
crypto is written. The relay treats both blobs as opaque strings and never
parses them.

**`auth_key` derivation** (WebCrypto, no new dependency):

```
auth_key = PBKDF2-SHA256(
    password  = password,
    salt      = SHA-256("colony-auth-v1:" || normalised_email),
    iterations= 600_000,
    length    = 32 bytes
) |> hex
```

The salt is derived deterministically from the email so a second device can
recompute `auth_key` from the password alone, with no server round trip before
the password is entered. `auth_key` is a *different* value from the scrypt
output that opens blob A, so the relay holding `auth_key` material grants no
progress toward decrypting the blob.

**Server-side storage of `auth_key`:** Argon2id, `m=19456 KiB, t=2, p=1`
(OWASP's current minimum), random 16-byte salt per account, encoded in PHC
string format. The relay stores that hash, never `auth_key` itself.

**Recovery code format:** 20 characters from Crockford base32 (excludes I, L,
O, U), grouped `XXXXX-XXXXX-XXXXX-XXXXX`, generated with
`crypto.getRandomValues`. That is 100 bits of entropy. The relay stores only
`SHA-256(recovery_code)`, matching the discipline already used for v2 invite
codes in `crates/buzz-db/src/relay_invite.rs` ("stores only SHA-256(code),
never the reusable bearer secret").

**Constant-time comparison** for every hash check. Argon2id verification is
constant-time by construction; the recovery-code hash comparison must use an
explicit constant-time equality, not `==`.

### Version field

Every account row carries `kdf_version = 1`. The parameters above are pinned to
that version. Raising KDF cost later means writing version 2 and upgrading a
row on next successful signin, when the plaintext password is briefly in hand.
Without this field that migration is impossible, which is why it ships now
rather than when it is needed.

## Data model

`migrations/0061_accounts.sql`:

```sql
CREATE TABLE accounts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    community_id        UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    email               TEXT NOT NULL,
    pubkey              TEXT NOT NULL,
    auth_hash           TEXT NOT NULL,
    password_blob       TEXT NOT NULL,
    recovery_blob       TEXT NOT NULL,
    recovery_code_hash  TEXT NOT NULL,
    kdf_version         SMALLINT NOT NULL DEFAULT 1,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_signin_at      TIMESTAMPTZ,
    failed_attempts     INTEGER NOT NULL DEFAULT 0,
    locked_until        TIMESTAMPTZ
);

CREATE UNIQUE INDEX accounts_community_email_idx
    ON accounts (community_id, lower(email));
CREATE UNIQUE INDEX accounts_community_pubkey_idx
    ON accounts (community_id, pubkey);
```

**`community_id` is not optional.** Every table in this relay is tenant-scoped,
and an account table without it would be the one cross-tenant seam in the
system. Uniqueness is per community: the same person may hold accounts on two
Colony communities, exactly as they may hold two workspaces.

The value comes from the request host, never from a request field, using the
same call every other tenant-scoped HTTP path already makes:
`crate::tenant::bind_community(&state.db, raw_host)` returns a
`buzz_core::TenantContext` (see `api/self_provisioning.rs:162`). A host with no
community row is a `404`, matching the existing behaviour rather than inventing
a new one. Accepting a community id from the client would let a caller create an
account in a tenant they were never pointed at, so no route in this spec takes
one.

**Email normalisation** is `lower(trim(email))` at every boundary, and the
unique index enforces it in the database rather than trusting callers.
Plus-addressing is *not* stripped: `a+b@x.com` is a distinct account from
`a@x.com`, because treating them as one surprises users who deliberately use
tagged addresses.

## HTTP API

Four routes, registered in `crates/buzz-relay/src/router.rs`, implemented in
`crates/buzz-relay/src/api/accounts.rs`. All unauthenticated (they precede
identity), all rate limited, all JSON.

### `POST /api/accounts/signup`

```jsonc
// request
{
  "email": "founder@example.com",
  "pubkey": "<64 hex chars>",
  "authKey": "<64 hex chars>",
  "passwordBlob": "ncryptsec1...",
  "recoveryBlob": "ncryptsec1...",
  "recoveryCodeHash": "<64 hex chars>",
  "kdfVersion": 1
}
// 201
{ "pubkey": "<64 hex>", "accountId": "<uuid>" }
// 409
{ "error": "email_taken" }
```

Validation: email parses and is <= 254 chars; `pubkey` is 64 lowercase hex;
`authKey` and `recoveryCodeHash` are 64 hex; both blobs start `ncryptsec1` and
are <= 512 chars; `kdfVersion` is 1. Anything else is `400` with a typed
`error` string, never a free-text message the client has to parse.

### `POST /api/accounts/signin`

```jsonc
// request
{ "email": "...", "authKey": "<64 hex>" }
// 200
{ "pubkey": "<64 hex>", "passwordBlob": "ncryptsec1...", "kdfVersion": 1 }
// 401
{ "error": "invalid_credentials" }
```

`invalid_credentials` is returned for both "no such account" and "wrong
password", and the handler performs a dummy Argon2id verification on the
no-such-account path so the two cases take the same time. Note this deliberately
differs from signup, which does disclose existence: signup's disclosure is a
usability requirement, signin's would be a gift to credential stuffing.

On success: reset `failed_attempts` to 0, set `last_signin_at`.
On failure: increment `failed_attempts`; at 10, set `locked_until = now() +
15 minutes` and return `423` with `{ "error": "temporarily_locked",
"retryAfterSecs": <n> }`.

### `POST /api/accounts/recover`

```jsonc
// request
{ "email": "...", "recoveryCodeHash": "<64 hex>" }
// 200
{ "pubkey": "<64 hex>", "recoveryBlob": "ncryptsec1...", "resetToken": "<opaque>" }
// 401
{ "error": "invalid_recovery_code" }
```

`resetToken` is a random 32-byte value, stored as its SHA-256 with a 15-minute
expiry, single use. It exists so the immediately following password reset does
not have to re-present the recovery code.

Recovery is rate limited harder than signin: 5 attempts per email per hour.
100 bits of entropy does not need a tight limit to be safe, but a tight limit
costs nothing and bounds the damage if a future code format is weaker.

### `POST /api/accounts/reset-password`

```jsonc
// request
{
  "email": "...",
  "resetToken": "<opaque>",
  "authKey": "<new, 64 hex>",
  "passwordBlob": "ncryptsec1...",
  "recoveryBlob": "ncryptsec1...",
  "recoveryCodeHash": "<64 hex>",
  "kdfVersion": 1
}
// 200
{ "ok": true }
```

A reset rewrites **both** blobs and issues a **new recovery code**, because the
old code was just used and typed into a form, which is exactly when it is most
likely to have been observed. The whole update runs in one transaction, and
the `resetToken` row is consumed inside it so a replay finds nothing.

### Rate limits

| Route | Per IP | Per email |
|---|---|---|
| signup | 5 / hour | n/a |
| signin | 30 / hour | 10 / hour |
| recover | 20 / hour | 5 / hour |
| reset-password | 10 / hour | 5 / hour |

Implemented with the existing `RateLimiter` trait in
`crates/buzz-auth/src/rate_limit.rs` (Redis-backed fixed window). The trait's
own doc comment warns fixed windows allow up to 2x burst at boundaries; that is
acceptable at these magnitudes, and the account lockout is the real defence
against credential stuffing.

Per-email limits key on the SHA-256 of the normalised email, so the rate-limit
keyspace in Redis does not become a plaintext list of every Colony user's email
address.

## Desktop integration

New file `desktop/src/features/onboarding/authService.ts` implements the real
`OnboardingServices["auth"]`. It is the only new client code of substance.

**Signup** (the app already generated and persisted an identity on first
launch, so there is a key to escrow):

1. Generate recovery code, `crypto.getRandomValues` + Crockford base32.
2. `createNcryptsecBackup(password)` -> blob A.
3. `createNcryptsecBackup(recoveryCode)` -> blob B.
4. Derive `authKey` via WebCrypto PBKDF2.
5. `POST /api/accounts/signup`.
6. Return `{ pubkey, recoveryCode }` to the flow. The recovery code is held in
   memory only, never persisted, and screen 2 is the sole place it is shown.

**Signin** (second device, not part of the onboarding flow but part of this
contract):

1. Derive `authKey` from password and email.
2. `POST /api/accounts/signin` -> blob A.
3. `importIdentity(blobA, password)` — existing command, decrypts in Rust and
   writes to the OS keyring.

No new Tauri command is required. `create_ncryptsec_backup`,
`verify_ncryptsec_backup` and `import_identity` already exist and are already
bound in `desktop/src/shared/api/tauriIdentity.ts`.

### Contract change

`desktop/src/features/onboarding/contracts.ts` grows two methods. The current
`SignUpResult` is unchanged, so no onboarding screen changes:

```ts
auth: {
  signUp: (email: string, password: string) => Promise<SignUpResult>;
  signIn: (email: string, password: string) => Promise<{ pubkey: string }>;
  recover: (email: string, code: string) => Promise<{ pubkey: string; resetToken: string }>;
};
```

`contracts.fake.ts` gains matching fakes so the existing tests keep running
against fakes and only the real wiring switches.

### Error mapping

The screen never sees an HTTP status. `authService` maps the typed `error`
strings to a discriminated union the screen already knows how to render:

| Wire | Client | Screen 1 behaviour |
|---|---|---|
| `email_taken` | `{ kind: "email-taken" }` | inline error on email field |
| `invalid_credentials` | `{ kind: "invalid-credentials" }` | inline, both fields kept |
| `temporarily_locked` | `{ kind: "locked", retryAfterSecs }` | banner with countdown |
| network / 5xx | `{ kind: "unreachable" }` | banner + retry, **password field preserved** |

The last row is a requirement lifted verbatim from the onboarding spec: "Never
clear the password field on a network error."

## Copy

Onboarding's language rules apply without exception. Nothing in any
user-visible string may say key, keypair, nsec, pubkey, encrypt, blob, escrow,
relay, or token. The password screen talks about a password; screen 2 talks
about a recovery code. No em dashes anywhere.

## Testing

**Rust unit** (`buzz-auth`): `auth_key` hashing round-trip; wrong key rejected;
recovery-code hash comparison is constant-time; Crockford alphabet rejects
ambiguous characters; email normalisation collapses case and whitespace but
keeps plus-addressing distinct; `kdf_version` other than 1 rejected.

**Rust integration** (`buzz-test-client`, requires Postgres + Redis): signup
then signin round-trip; duplicate email is `409`; wrong password is `401` and
takes comparable time to an unknown email; lockout at 10 failures then `423`;
recover returns blob B and a single-use `resetToken`; a replayed `resetToken`
fails; reset-password rewrites both blobs in one transaction; an account on
community A is invisible to community B.

**Desktop unit** (`node:test`): `authService` maps every typed error to its
union member; PBKDF2 derivation is stable for the same email and password and
differs across emails; recovery-code generation produces 100 bits from the
Crockford alphabet in the grouped format.

**Prove the failure first.** Each regression test runs against unfixed code and
is observed to fail before the fix lands. This is repo policy and it has caught
tests here that passed without exercising anything.

**Never run `just ci` locally.** Verify with the narrow gates (`pnpm check`,
`pnpm typecheck`, `cargo test -p buzz-auth`, single test files) and let GitHub
CI run the matrix.

## Out of scope

- Email verification and any outbound email. Nothing in this spec sends mail.
- Password change while signed in, which is a settings surface, not onboarding.
- Migrating Buzz-era key-only accounts to email and password (onboarding spec,
  open question 1).
- Session tokens. Signin yields the private key, and every subsequent request
  is NIP-42 or NIP-98 signed exactly as it is today. No session layer is added.
- Social or SSO sign-in.
- Mobile. The Flutter app has no ncryptsec support yet.

## Open questions

1. **Unverified email squatting.** A user can register an address they do not
   control, denying it to the real owner. Fixing it needs outbound email, which
   is a vendor decision with recurring cost. Recommended resolution: ship
   without verification, and when the invites contract brings an email provider
   in, add verification as a non-blocking prompt rather than a signup gate.
2. **Blob size ceiling.** 512 characters comfortably fits a NIP-49 payload
   today. If the format ever grows, the check rejects valid accounts. Low risk,
   worth a named constant rather than a literal.
