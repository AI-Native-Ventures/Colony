# Email and password accounts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a non-technical user create a Colony account with an email and a password, and get back into it on another computer or after forgetting the password, without the relay ever holding their private key or their password.

**Architecture:** The device keeps generating its own Nostr keypair as it does today. The password and a generated recovery code each encrypt that key into a NIP-49 `ncryptsec` blob using the Tauri commands that already exist. Both blobs go to the relay, which stores them opaquely against a normalised email. A separately derived `auth_key` proves password knowledge without transmitting the password. Four new unauthenticated HTTP routes on the relay carry signup, signin, recovery and password reset.

**Tech Stack:** Rust (axum, sqlx, argon2), Postgres, Redis, TypeScript (WebCrypto PBKDF2), `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-22-auth-accounts-design.md`

## Global Constraints

- **Never run `just ci`.** It saturates the owner's machine. Verify with the narrow gates: `cargo test -p <crate>`, `pnpm check`, `pnpm typecheck`, or a single desktop test file. Push and let GitHub CI run the matrix.
- **Commit with `git commit -s`.** The DCO check fails any commit without a `Signed-off-by` trailer.
- **Activate hermit before any git or cargo command:** `. ./bin/activate-hermit`.
- **No `unsafe`.** No new `unwrap()` or `expect()` in production paths; use `?` and typed errors.
- **New public API needs doc comments.**
- **No em dashes** anywhere: not in code, comments, commit messages, or user-facing copy.
- **No developer jargon in any user-visible string.** Never key, keypair, nsec, pubkey, encrypt, blob, escrow, relay, token, or terminal. Never "your Mac"; say "your computer".
- **The relay must never receive a password or a private key.** Any task that would transmit either is wrong; stop and raise it.
- **Constant-time comparison** for every secret comparison. Never `==` on a hash.
- **Email normalisation is `lower(trim(email))`** at every boundary, including the database index.
- Desktop text sizes must be rem-based tokens, never px or arbitrary rem literals.
- Run single desktop test files directly, never the whole suite, and never with `--test-name-pattern` (it loads the entire suite and matches almost nothing).

---

## File Structure

| File | Responsibility |
|---|---|
| `crates/buzz-auth/src/account_crypto.rs` | recovery-code generation, Crockford base32, email normalisation, hash comparison |
| `crates/buzz-auth/src/account_verifier.rs` | Argon2id hashing and verification of `auth_key`, KDF version gate |
| `migrations/0061_accounts.sql` | `accounts` and `account_reset_tokens` tables |
| `crates/buzz-db/src/accounts.rs` | all SQL for accounts: create, lookup, failure counters, reset transaction |
| `crates/buzz-relay/src/api/accounts.rs` | the four HTTP handlers, validation, rate limiting |
| `crates/buzz-relay/src/router.rs` | route registration |
| `desktop/src/features/onboarding/authCrypto.ts` | PBKDF2 `auth_key` derivation, recovery-code generation |
| `desktop/src/features/onboarding/authService.ts` | real `OnboardingServices["auth"]`, error mapping |
| `desktop/src/features/onboarding/contracts.ts` | contract grows `signIn` and `recover` |
| `desktop/src/features/onboarding/contracts.fake.ts` | fakes for the two new methods |
| `crates/buzz-test-client/tests/e2e_accounts.rs` | full round-trip integration coverage |

---

### Task 1: Account crypto primitives

Pure functions, no database, no network. Everything here is unit testable and everything downstream depends on it.

**Files:**
- Create: `crates/buzz-auth/src/account_crypto.rs`
- Modify: `crates/buzz-auth/src/lib.rs`
- Modify: `crates/buzz-auth/Cargo.toml`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pub fn normalise_email(raw: &str) -> String`
  - `pub fn generate_recovery_code() -> String`
  - `pub fn is_valid_recovery_code(code: &str) -> bool`
  - `pub fn hash_recovery_code(code: &str) -> String` (lowercase hex SHA-256)
  - `pub fn constant_time_eq_hex(a: &str, b: &str) -> bool`
  - `pub const CROCKFORD_ALPHABET: &str`

- [ ] **Step 1: Write the failing test**

Append to `crates/buzz-auth/src/account_crypto.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises_case_and_surrounding_whitespace() {
        assert_eq!(normalise_email("  Founder@Example.COM "), "founder@example.com");
    }

    #[test]
    fn keeps_plus_addressing_distinct() {
        // Tagged addresses are deliberately separate accounts. Stripping the
        // tag would silently merge two accounts a user believes are separate.
        assert_ne!(normalise_email("a+work@x.com"), normalise_email("a@x.com"));
    }

    #[test]
    fn recovery_code_is_grouped_crockford() {
        let code = generate_recovery_code();
        assert_eq!(code.len(), 23, "four groups of five plus three dashes");
        let groups: Vec<&str> = code.split('-').collect();
        assert_eq!(groups.len(), 4);
        for group in groups {
            assert_eq!(group.len(), 5);
            for character in group.chars() {
                assert!(
                    CROCKFORD_ALPHABET.contains(character),
                    "{character} is outside the Crockford alphabet"
                );
            }
        }
    }

    #[test]
    fn recovery_codes_do_not_repeat() {
        let first = generate_recovery_code();
        let second = generate_recovery_code();
        assert_ne!(first, second);
    }

    #[test]
    fn rejects_ambiguous_characters() {
        // I, L, O and U are excluded so a handwritten code cannot be misread.
        assert!(!is_valid_recovery_code("IIIII-IIIII-IIIII-IIIII"));
        assert!(!is_valid_recovery_code("ABCDE-FGHJK-MNPQR-STVWX"[..10].into()));
        assert!(is_valid_recovery_code(&generate_recovery_code()));
    }

    #[test]
    fn recovery_code_validation_ignores_case_and_spacing() {
        let code = generate_recovery_code();
        assert!(is_valid_recovery_code(&code.to_lowercase()));
        assert!(is_valid_recovery_code(&format!(" {code} ")));
    }

    #[test]
    fn hashing_is_stable_and_hex() {
        let hash = hash_recovery_code("ABCDE-FGHJK-MNPQR-STVWX");
        assert_eq!(hash.len(), 64);
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_eq!(hash, hash_recovery_code("abcde-fghjk-mnpqr-stvwx"));
    }

    #[test]
    fn constant_time_compare_matches_equality() {
        assert!(constant_time_eq_hex("abcd", "abcd"));
        assert!(!constant_time_eq_hex("abcd", "abce"));
        assert!(!constant_time_eq_hex("abcd", "abcde"));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
. ./bin/activate-hermit && cargo test -p buzz-auth account_crypto
```

Expected: compile failure, the module does not exist.

- [ ] **Step 3: Write the implementation**

Add to `crates/buzz-auth/Cargo.toml` under `[dependencies]`:

```toml
subtle = "2"
```

Create `crates/buzz-auth/src/account_crypto.rs` above the test module:

```rust
//! Pure primitives for email and password accounts.
//!
//! Nothing here touches the database or the network, so every rule the account
//! system depends on is unit testable in isolation.

use rand::RngCore;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// Crockford base32, which excludes I, L, O and U so a code read aloud or
/// written by hand cannot be transcribed into a different valid code.
pub const CROCKFORD_ALPHABET: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Characters per group in a displayed recovery code.
const GROUP_LEN: usize = 5;
/// Number of groups. Four groups of five Crockford characters is 100 bits.
const GROUP_COUNT: usize = 4;

/// Canonical form of an email address: trimmed and lowercased.
///
/// Plus-addressing is preserved on purpose. `a+work@x.com` and `a@x.com` are
/// different accounts, because a user who tags an address expects it to stay
/// separate.
pub fn normalise_email(raw: &str) -> String {
    raw.trim().to_lowercase()
}

/// Generate a fresh recovery code in `XXXXX-XXXXX-XXXXX-XXXXX` form.
///
/// Drawn from the operating system's cryptographic random source. The modulo
/// below is unbiased because the alphabet is exactly 32 characters, so every
/// 5-bit slice maps to one character.
pub fn generate_recovery_code() -> String {
    let alphabet: Vec<char> = CROCKFORD_ALPHABET.chars().collect();
    let mut bytes = [0u8; GROUP_LEN * GROUP_COUNT];
    rand::thread_rng().fill_bytes(&mut bytes);

    let mut groups: Vec<String> = Vec::with_capacity(GROUP_COUNT);
    for group in bytes.chunks(GROUP_LEN) {
        let text: String = group
            .iter()
            .map(|byte| alphabet[(byte & 0b0001_1111) as usize])
            .collect();
        groups.push(text);
    }
    groups.join("-")
}

/// Whether `code` could be a recovery code this system issued.
///
/// Case and surrounding whitespace are forgiven because users retype these by
/// hand. Ambiguous characters are not.
pub fn is_valid_recovery_code(code: &str) -> bool {
    let normalised = code.trim().to_uppercase();
    let groups: Vec<&str> = normalised.split('-').collect();
    if groups.len() != GROUP_COUNT {
        return false;
    }
    groups.iter().all(|group| {
        group.len() == GROUP_LEN && group.chars().all(|c| CROCKFORD_ALPHABET.contains(c))
    })
}

/// Lowercase hex SHA-256 of a recovery code, after the same normalisation
/// [`is_valid_recovery_code`] applies.
///
/// Only this hash is ever stored or transmitted. The code itself is a bearer
/// secret, held by the user and nobody else.
pub fn hash_recovery_code(code: &str) -> String {
    let normalised = code.trim().to_uppercase();
    let digest = Sha256::digest(normalised.as_bytes());
    hex::encode(digest)
}

/// Compare two hex strings without leaking their contents through timing.
///
/// Length inequality returns early, which reveals only the length. Both inputs
/// here are fixed-width hashes, so that leaks nothing.
pub fn constant_time_eq_hex(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.as_bytes().ct_eq(b.as_bytes()).into()
}
```

Add to `crates/buzz-auth/src/lib.rs` beside the other module declarations:

```rust
pub mod account_crypto;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
. ./bin/activate-hermit && cargo test -p buzz-auth account_crypto
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-auth/src/account_crypto.rs crates/buzz-auth/src/lib.rs crates/buzz-auth/Cargo.toml
git commit -s -m "feat(auth): add account crypto primitives

Recovery codes are 100 bits of Crockford base32, which excludes the four
characters a person can misread. Only the SHA-256 is ever stored, matching
the discipline relay_invite already uses for v2 invite codes."
```

---

### Task 2: Argon2id verifier for `auth_key`

**Files:**
- Create: `crates/buzz-auth/src/account_verifier.rs`
- Modify: `crates/buzz-auth/src/lib.rs`
- Modify: `crates/buzz-auth/Cargo.toml`
- Modify: `Cargo.toml` (workspace dependency)

**Interfaces:**
- Consumes: Task 1's `constant_time_eq_hex` is not used here; Argon2 verification is constant-time by construction.
- Produces:
  - `pub const CURRENT_KDF_VERSION: i16 = 1`
  - `pub fn hash_auth_key(auth_key: &str) -> Result<String, AuthError>` (PHC string)
  - `pub fn verify_auth_key(auth_key: &str, phc: &str) -> bool`
  - `pub fn dummy_verify()` — burns equivalent time when no account exists
  - `pub fn is_supported_kdf_version(version: i16) -> bool`

- [ ] **Step 1: Write the failing test**

Append to `crates/buzz-auth/src/account_verifier.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "5f4dcc3b5aa765d61d8327deb882cf995f4dcc3b5aa765d61d8327deb882cf99";

    #[test]
    fn round_trips_a_correct_key() {
        let phc = hash_auth_key(KEY).expect("hashing should succeed");
        assert!(verify_auth_key(KEY, &phc));
    }

    #[test]
    fn rejects_a_wrong_key() {
        let phc = hash_auth_key(KEY).expect("hashing should succeed");
        let wrong = format!("{}00", &KEY[..62]);
        assert!(!verify_auth_key(&wrong, &phc));
    }

    #[test]
    fn salts_differ_between_hashes_of_the_same_key() {
        let first = hash_auth_key(KEY).expect("hashing should succeed");
        let second = hash_auth_key(KEY).expect("hashing should succeed");
        assert_ne!(first, second, "each hash must carry its own random salt");
        assert!(verify_auth_key(KEY, &first));
        assert!(verify_auth_key(KEY, &second));
    }

    #[test]
    fn rejects_a_malformed_stored_hash() {
        assert!(!verify_auth_key(KEY, "not-a-phc-string"));
    }

    #[test]
    fn only_version_one_is_supported() {
        assert!(is_supported_kdf_version(CURRENT_KDF_VERSION));
        assert!(!is_supported_kdf_version(0));
        assert!(!is_supported_kdf_version(2));
    }

    #[test]
    fn dummy_verify_does_not_panic() {
        dummy_verify();
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
. ./bin/activate-hermit && cargo test -p buzz-auth account_verifier
```

Expected: compile failure, the module does not exist.

- [ ] **Step 3: Write the implementation**

Add to the workspace `Cargo.toml` under `[workspace.dependencies]`:

```toml
argon2      = { version = "0.5", features = ["std"] }
```

Add to `crates/buzz-auth/Cargo.toml` under `[dependencies]`:

```toml
argon2 = { workspace = true }
```

Create `crates/buzz-auth/src/account_verifier.rs` above the test module:

```rust
//! Server-side verification of the client-derived `auth_key`.
//!
//! The client never sends a password. It sends `auth_key`, a value derived
//! from the password by a client-side KDF. This module hashes that value again
//! with Argon2id before storage, so a database breach yields neither the
//! password nor a directly replayable credential.

use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};

use crate::error::AuthError;

/// The only KDF parameter set this build understands.
///
/// Stored per account so cost can be raised later: a version 2 row would be
/// written on the next successful signin, while the password is briefly in
/// hand. Without this field that migration is impossible.
pub const CURRENT_KDF_VERSION: i16 = 1;

/// OWASP's current Argon2id minimum: 19 MiB, two passes, one lane.
const MEMORY_KIB: u32 = 19_456;
const ITERATIONS: u32 = 2;
const PARALLELISM: u32 = 1;

fn hasher() -> Result<Argon2<'static>, AuthError> {
    let params = Params::new(MEMORY_KIB, ITERATIONS, PARALLELISM, None)
        .map_err(|error| AuthError::Internal(format!("argon2 params: {error}")))?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

/// Hash a client-supplied `auth_key` for storage, returning a PHC string.
///
/// The PHC string carries the algorithm, parameters and a fresh random salt,
/// so verification needs nothing else from the caller.
pub fn hash_auth_key(auth_key: &str) -> Result<String, AuthError> {
    let salt = SaltString::generate(&mut OsRng);
    let hash = hasher()?
        .hash_password(auth_key.as_bytes(), &salt)
        .map_err(|error| AuthError::Internal(format!("argon2 hash: {error}")))?;
    Ok(hash.to_string())
}

/// Verify a client-supplied `auth_key` against a stored PHC string.
///
/// A malformed stored hash returns `false` rather than an error: from the
/// caller's point of view a corrupt row and a wrong key are the same outcome,
/// and collapsing them keeps the wrong-credentials response uniform.
pub fn verify_auth_key(auth_key: &str, phc: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(phc) else {
        return false;
    };
    let Ok(argon) = hasher() else {
        return false;
    };
    argon.verify_password(auth_key.as_bytes(), &parsed).is_ok()
}

/// Burn the same work a real verification costs.
///
/// Called on the no-such-account path so an attacker cannot tell a registered
/// email from an unregistered one by timing the response.
pub fn dummy_verify() {
    const DUMMY_PHC: &str = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2E$\
                             3S8vKGRLbnZoYmVzdGltZWNvbnN0YW50dmFsdWVoZXJl";
    let _ = verify_auth_key("dummy", DUMMY_PHC);
}

/// Whether this build can verify accounts written at `version`.
pub fn is_supported_kdf_version(version: i16) -> bool {
    version == CURRENT_KDF_VERSION
}
```

Add to `crates/buzz-auth/src/lib.rs`:

```rust
pub mod account_verifier;
```

If `AuthError` has no `Internal(String)` variant, add one to
`crates/buzz-auth/src/error.rs`:

```rust
    /// An unexpected internal failure that is not the caller's fault.
    #[error("internal auth error: {0}")]
    Internal(String),
```

**Note on `dummy_verify`:** the constant above must be a real PHC string that
parses. If `verify_auth_key` returns early because the string is malformed, the
timing defence does nothing. Prove it: temporarily assert inside the test that
`PasswordHash::new(DUMMY_PHC).is_ok()`. If it is not, generate a real one with
`hash_auth_key("dummy")` and paste that value in.

- [ ] **Step 4: Run the test to verify it passes**

```bash
. ./bin/activate-hermit && cargo test -p buzz-auth account_verifier
```

Expected: 6 tests pass. Argon2id at 19 MiB takes roughly 50 ms per hash, so the suite takes a couple of seconds.

- [ ] **Step 5: Verify the timing defence actually works**

Add this test and keep it:

```rust
    #[test]
    fn dummy_verify_parses_its_placeholder_hash() {
        // A malformed placeholder makes verify_auth_key return early, which
        // would silently remove the timing defence on the unknown-email path.
        assert!(PasswordHash::new(DUMMY_PHC_FOR_TEST).is_ok());
    }
```

Expose the constant as `pub(crate) const DUMMY_PHC_FOR_TEST` so the test can
reach it. Run the test. If it fails, replace the constant with real output from
`hash_auth_key("dummy")`.

- [ ] **Step 6: Commit**

```bash
git add crates/buzz-auth/src/account_verifier.rs crates/buzz-auth/src/lib.rs crates/buzz-auth/src/error.rs crates/buzz-auth/Cargo.toml Cargo.toml
git commit -s -m "feat(auth): verify client-derived auth keys with Argon2id

Stores a PHC string at OWASP's current minimum parameters. The unknown-email
path burns equivalent work so signin cannot be used to enumerate accounts by
response time."
```

---

### Task 3: Migration and account store

**Files:**
- Create: `migrations/0061_accounts.sql`
- Create: `crates/buzz-db/src/accounts.rs`
- Modify: `crates/buzz-db/src/lib.rs`

**Interfaces:**
- Consumes: `buzz_auth::account_verifier::CURRENT_KDF_VERSION`.
- Produces:
  - `pub struct AccountRecord { pub id: Uuid, pub pubkey: String, pub auth_hash: String, pub password_blob: String, pub recovery_blob: String, pub recovery_code_hash: String, pub kdf_version: i16, pub failed_attempts: i32, pub locked_until: Option<DateTime<Utc>> }`
  - `pub struct NewAccount { ... same minus id, failed_attempts, locked_until ... }`
  - `pub enum CreateAccountOutcome { Created(Uuid), EmailTaken, PubkeyTaken }`
  - `pub async fn create_account(pool: &PgPool, community_id: CommunityId, email: &str, account: NewAccount) -> Result<CreateAccountOutcome>`
  - `pub async fn find_account(pool: &PgPool, community_id: CommunityId, email: &str) -> Result<Option<AccountRecord>>`
  - `pub async fn record_signin_success(pool: &PgPool, id: Uuid) -> Result<()>`
  - `pub async fn record_signin_failure(pool: &PgPool, id: Uuid, lock_threshold: i32, lock_for: Duration) -> Result<Option<DateTime<Utc>>>`
  - `pub async fn issue_reset_token(pool: &PgPool, account_id: Uuid, token_hash: &str, ttl: Duration) -> Result<()>`
  - `pub async fn consume_reset_and_rewrite(pool: &PgPool, community_id: CommunityId, email: &str, token_hash: &str, update: PasswordReset) -> Result<bool>`

- [ ] **Step 1: Write the migration**

Create `migrations/0061_accounts.sql`:

```sql
-- Email and password accounts with zero-knowledge key escrow.
--
-- The relay stores two opaque NIP-49 blobs per account. Both encrypt the same
-- private key: one under the user's password, one under their recovery code.
-- Neither the password nor the key is ever transmitted, so neither can be
-- recovered from this table.

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

-- Uniqueness is per community, and lower() in the index means the database
-- enforces normalisation rather than trusting every caller to apply it.
CREATE UNIQUE INDEX accounts_community_email_idx
    ON accounts (community_id, lower(email));
CREATE UNIQUE INDEX accounts_community_pubkey_idx
    ON accounts (community_id, pubkey);

-- Single-use, short-lived proof that a recovery code was presented, so the
-- password reset that follows does not have to carry the code again.
CREATE TABLE account_reset_tokens (
    token_hash  TEXT PRIMARY KEY,
    account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX account_reset_tokens_expiry_idx
    ON account_reset_tokens (expires_at);
```

- [ ] **Step 2: Write the failing test**

Create `crates/buzz-db/src/accounts.rs` with the test module. These tests need
Postgres, so they are `#[sqlx::test]` following the pattern already used in
`crates/buzz-db/src/relay_invite.rs`. Read that file's test module first and
match its fixture helpers exactly rather than inventing new ones.

```rust
#[cfg(test)]
mod tests {
    use super::*;

    // Mirror the community fixture helper relay_invite.rs uses. Do not write a
    // new one: a second fixture drifts from the first.

    #[sqlx::test]
    async fn creates_then_finds_an_account(pool: PgPool) {
        let community = seed_community(&pool).await;
        let outcome = create_account(&pool, community, "Founder@Example.com", sample_account())
            .await
            .expect("create should succeed");
        assert!(matches!(outcome, CreateAccountOutcome::Created(_)));

        let found = find_account(&pool, community, "founder@example.com")
            .await
            .expect("lookup should succeed")
            .expect("account should exist");
        assert_eq!(found.pubkey, sample_account().pubkey);
        assert_eq!(found.failed_attempts, 0);
    }

    #[sqlx::test]
    async fn rejects_a_duplicate_email_regardless_of_case(pool: PgPool) {
        let community = seed_community(&pool).await;
        create_account(&pool, community, "a@x.com", sample_account()).await.unwrap();
        let mut second = sample_account();
        second.pubkey = "b".repeat(64);
        let outcome = create_account(&pool, community, "A@X.COM", second).await.unwrap();
        assert!(matches!(outcome, CreateAccountOutcome::EmailTaken));
    }

    #[sqlx::test]
    async fn the_same_email_may_exist_in_two_communities(pool: PgPool) {
        let first = seed_community(&pool).await;
        let second = seed_community(&pool).await;
        create_account(&pool, first, "a@x.com", sample_account()).await.unwrap();
        let outcome = create_account(&pool, second, "a@x.com", sample_account()).await.unwrap();
        assert!(matches!(outcome, CreateAccountOutcome::Created(_)));
    }

    #[sqlx::test]
    async fn an_account_is_invisible_from_another_community(pool: PgPool) {
        let first = seed_community(&pool).await;
        let second = seed_community(&pool).await;
        create_account(&pool, first, "a@x.com", sample_account()).await.unwrap();
        let found = find_account(&pool, second, "a@x.com").await.unwrap();
        assert!(found.is_none(), "accounts must not leak across tenants");
    }

    #[sqlx::test]
    async fn failures_accumulate_then_lock(pool: PgPool) {
        let community = seed_community(&pool).await;
        let CreateAccountOutcome::Created(id) =
            create_account(&pool, community, "a@x.com", sample_account()).await.unwrap()
        else {
            panic!("expected a created account");
        };

        for _ in 0..9 {
            let locked = record_signin_failure(&pool, id, 10, Duration::minutes(15)).await.unwrap();
            assert!(locked.is_none(), "should not lock before the threshold");
        }
        let locked = record_signin_failure(&pool, id, 10, Duration::minutes(15)).await.unwrap();
        assert!(locked.is_some(), "the tenth failure must lock the account");
    }

    #[sqlx::test]
    async fn a_success_clears_the_failure_counter(pool: PgPool) {
        let community = seed_community(&pool).await;
        let CreateAccountOutcome::Created(id) =
            create_account(&pool, community, "a@x.com", sample_account()).await.unwrap()
        else {
            panic!("expected a created account");
        };
        record_signin_failure(&pool, id, 10, Duration::minutes(15)).await.unwrap();
        record_signin_success(&pool, id).await.unwrap();
        let found = find_account(&pool, community, "a@x.com").await.unwrap().unwrap();
        assert_eq!(found.failed_attempts, 0);
        assert!(found.locked_until.is_none());
    }

    #[sqlx::test]
    async fn a_reset_token_works_once(pool: PgPool) {
        let community = seed_community(&pool).await;
        let CreateAccountOutcome::Created(id) =
            create_account(&pool, community, "a@x.com", sample_account()).await.unwrap()
        else {
            panic!("expected a created account");
        };
        issue_reset_token(&pool, id, "tokenhash", Duration::minutes(15)).await.unwrap();

        let first = consume_reset_and_rewrite(&pool, community, "a@x.com", "tokenhash", sample_reset())
            .await
            .unwrap();
        assert!(first, "the first use must succeed");

        let second = consume_reset_and_rewrite(&pool, community, "a@x.com", "tokenhash", sample_reset())
            .await
            .unwrap();
        assert!(!second, "a replayed token must fail");
    }

    #[sqlx::test]
    async fn an_expired_reset_token_is_refused(pool: PgPool) {
        let community = seed_community(&pool).await;
        let CreateAccountOutcome::Created(id) =
            create_account(&pool, community, "a@x.com", sample_account()).await.unwrap()
        else {
            panic!("expected a created account");
        };
        issue_reset_token(&pool, id, "tokenhash", Duration::minutes(-1)).await.unwrap();
        let used = consume_reset_and_rewrite(&pool, community, "a@x.com", "tokenhash", sample_reset())
            .await
            .unwrap();
        assert!(!used);
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

The isolated harness gives a fresh database, which these tests require. A
re-run against an accumulated database produces false results.

```bash
. ./bin/activate-hermit && ./scripts/start-isolated-test-relay.sh
. ./bin/activate-hermit && cargo test -p buzz-db accounts
```

Expected: compile failure, the module does not exist.

- [ ] **Step 4: Write the implementation**

Write `crates/buzz-db/src/accounts.rs` above the tests. Follow
`relay_invite.rs` for style: free functions taking `&PgPool`, a typed outcome
enum rather than parsing driver errors, and one transaction for anything that
must be atomic.

Key requirements the tests above pin down:

- `create_account` maps the unique-violation SQLSTATE `23505` to
  `EmailTaken` or `PubkeyTaken` by inspecting the constraint name, never by
  pre-checking with a SELECT (which races).
- `find_account` filters `community_id = $1 AND lower(email) = lower($2)`.
- `record_signin_failure` runs one `UPDATE ... RETURNING locked_until` that
  increments and conditionally sets the lock in a single statement, so two
  concurrent failures cannot both read the same count.
- `consume_reset_and_rewrite` opens a transaction, deletes the token row with
  `DELETE ... WHERE token_hash = $1 AND expires_at > now() RETURNING account_id`,
  and only rewrites the account if that delete returned a row. Deleting first is
  what makes replay impossible.

Add to `crates/buzz-db/src/lib.rs`:

```rust
pub mod accounts;
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
. ./bin/activate-hermit && cargo test -p buzz-db accounts
```

Expected: 8 tests pass.

- [ ] **Step 6: Commit**

```bash
git add migrations/0061_accounts.sql crates/buzz-db/src/accounts.rs crates/buzz-db/src/lib.rs
git commit -s -m "feat(db): add accounts table and store

Accounts are tenant-scoped like every other table here, and uniqueness runs
through lower(email) in the index so normalisation is enforced by the database
rather than by every caller. Reset tokens are deleted before the rewrite, which
is what makes a replay impossible rather than merely unlikely."
```

---

### Task 4: Signup route

**Files:**
- Create: `crates/buzz-relay/src/api/accounts.rs`
- Modify: `crates/buzz-relay/src/api/mod.rs`
- Modify: `crates/buzz-relay/src/router.rs`

**Interfaces:**
- Consumes: Task 1 (`normalise_email`), Task 2 (`hash_auth_key`, `is_supported_kdf_version`), Task 3 (`create_account`, `NewAccount`, `CreateAccountOutcome`).
- Produces: `pub async fn signup(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(body): Json<SignupRequest>) -> Result<(StatusCode, Json<Value>), (StatusCode, Json<Value>)>` and the shared `fn tenant_from_host` helper the later routes reuse.

- [ ] **Step 1: Write the failing test**

Validation is pure, so it is unit tested inside the module. Append to
`crates/buzz-relay/src/api/accounts.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn valid() -> SignupRequest {
        SignupRequest {
            email: "founder@example.com".into(),
            pubkey: "a".repeat(64),
            auth_key: "b".repeat(64),
            password_blob: format!("ncryptsec1{}", "c".repeat(40)),
            recovery_blob: format!("ncryptsec1{}", "d".repeat(40)),
            recovery_code_hash: "e".repeat(64),
            kdf_version: 1,
        }
    }

    #[test]
    fn accepts_a_well_formed_request() {
        assert!(validate_signup(&valid()).is_ok());
    }

    #[test]
    fn rejects_an_address_without_an_at_sign() {
        let mut request = valid();
        request.email = "founder".into();
        assert_eq!(validate_signup(&request).unwrap_err(), "invalid_email");
    }

    #[test]
    fn rejects_an_overlong_address() {
        let mut request = valid();
        request.email = format!("{}@x.com", "a".repeat(250));
        assert_eq!(validate_signup(&request).unwrap_err(), "invalid_email");
    }

    #[test]
    fn rejects_a_pubkey_that_is_not_64_hex() {
        let mut request = valid();
        request.pubkey = "ZZZ".into();
        assert_eq!(validate_signup(&request).unwrap_err(), "invalid_pubkey");
    }

    #[test]
    fn rejects_an_uppercase_pubkey() {
        // Hex pubkeys are lowercase everywhere in this codebase. Accepting both
        // cases would let one key occupy two rows under the unique index.
        let mut request = valid();
        request.pubkey = "A".repeat(64);
        assert_eq!(validate_signup(&request).unwrap_err(), "invalid_pubkey");
    }

    #[test]
    fn rejects_a_blob_without_the_ncryptsec_prefix() {
        let mut request = valid();
        request.password_blob = "nsec1abc".into();
        assert_eq!(validate_signup(&request).unwrap_err(), "invalid_blob");
    }

    #[test]
    fn rejects_an_oversized_blob() {
        let mut request = valid();
        request.recovery_blob = format!("ncryptsec1{}", "c".repeat(MAX_BLOB_LEN));
        assert_eq!(validate_signup(&request).unwrap_err(), "invalid_blob");
    }

    #[test]
    fn rejects_an_unsupported_kdf_version() {
        let mut request = valid();
        request.kdf_version = 2;
        assert_eq!(validate_signup(&request).unwrap_err(), "unsupported_kdf_version");
    }

    #[test]
    fn rejects_identical_password_and_recovery_blobs() {
        // Identical blobs mean the client encrypted under one secret twice, so
        // the recovery code opens nothing the password does not already open.
        let mut request = valid();
        request.recovery_blob = request.password_blob.clone();
        assert_eq!(validate_signup(&request).unwrap_err(), "invalid_blob");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
. ./bin/activate-hermit && cargo test -p buzz-relay api::accounts
```

Expected: compile failure, the module does not exist.

- [ ] **Step 3: Write the implementation**

Create `crates/buzz-relay/src/api/accounts.rs`:

```rust
//! Email and password accounts.
//!
//! **These routes are HTTP rather than Nostr events on purpose.** Signup
//! happens before the caller owns a key, so there is nothing to sign and no
//! event kind could carry it. This is the same exemption
//! `POST /api/invites/claim` takes, and it should not be "fixed" into an event
//! kind by a later reader.
//!
//! The relay never receives a password or a private key. It receives two
//! opaque NIP-49 blobs and a client-derived `auth_key`. See
//! `docs/superpowers/specs/2026-08-22-auth-accounts-design.md`.

use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use buzz_auth::account_crypto::normalise_email;
use buzz_auth::account_verifier::{hash_auth_key, is_supported_kdf_version};
use buzz_db::accounts::{create_account, CreateAccountOutcome, NewAccount};

use crate::state::AppState;

use super::{api_error, internal_error};

/// Longest NIP-49 payload accepted. Today's format is far shorter; the cap
/// exists so a caller cannot use this table as arbitrary storage.
pub(crate) const MAX_BLOB_LEN: usize = 512;
/// RFC 5321 caps an address at 254 octets.
const MAX_EMAIL_LEN: usize = 254;
const NCRYPTSEC_PREFIX: &str = "ncryptsec1";

/// Body for `POST /api/accounts/signup`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignupRequest {
    pub email: String,
    pub pubkey: String,
    pub auth_key: String,
    pub password_blob: String,
    pub recovery_blob: String,
    pub recovery_code_hash: String,
    pub kdf_version: i16,
}

fn is_lowercase_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

fn is_valid_blob(value: &str) -> bool {
    value.starts_with(NCRYPTSEC_PREFIX) && value.len() <= MAX_BLOB_LEN
}

/// Validate a signup body, returning a typed error string the client maps to a
/// screen state. Never returns free text: the client must not parse prose.
pub(crate) fn validate_signup(request: &SignupRequest) -> Result<(), &'static str> {
    let email = normalise_email(&request.email);
    if email.len() > MAX_EMAIL_LEN || !email.contains('@') || email.starts_with('@')
        || email.ends_with('@')
    {
        return Err("invalid_email");
    }
    if !is_lowercase_hex(&request.pubkey, 64) {
        return Err("invalid_pubkey");
    }
    if !is_lowercase_hex(&request.auth_key, 64) {
        return Err("invalid_auth_key");
    }
    if !is_lowercase_hex(&request.recovery_code_hash, 64) {
        return Err("invalid_recovery_code_hash");
    }
    if !is_valid_blob(&request.password_blob) || !is_valid_blob(&request.recovery_blob) {
        return Err("invalid_blob");
    }
    if request.password_blob == request.recovery_blob {
        return Err("invalid_blob");
    }
    if !is_supported_kdf_version(request.kdf_version) {
        return Err("unsupported_kdf_version");
    }
    Ok(())
}
```

Then the handler. It resolves the tenant from the request host using the same
call every other tenant-scoped path makes, hashes `auth_key`, and writes the
row:

```rust
/// Resolve the tenant from the request host.
///
/// The community is never taken from a request field: accepting one would let
/// a caller create an account in a tenant they were never pointed at.
pub(crate) async fn tenant_from_host(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<buzz_core::TenantContext, (StatusCode, Json<Value>)> {
    let raw_host = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    crate::tenant::bind_community(&state.db, raw_host)
        .await
        .map_err(|_| api_error(StatusCode::NOT_FOUND, "unknown_community"))
}

/// `POST /api/accounts/signup`
pub async fn signup(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<SignupRequest>,
) -> Result<(StatusCode, Json<Value>), (StatusCode, Json<Value>)> {
    if let Err(reason) = validate_signup(&request) {
        return Err(api_error(StatusCode::BAD_REQUEST, reason));
    }
    let tenant = tenant_from_host(&state, &headers).await?;

    let auth_hash = hash_auth_key(&request.auth_key)
        .map_err(|error| internal_error(&format!("hash auth key: {error}")))?;

    let account = NewAccount {
        pubkey: request.pubkey.clone(),
        auth_hash,
        password_blob: request.password_blob.clone(),
        recovery_blob: request.recovery_blob.clone(),
        recovery_code_hash: request.recovery_code_hash.clone(),
        kdf_version: request.kdf_version,
    };

    match create_account(
        state.db.pool(),
        tenant.community_id,
        &normalise_email(&request.email),
        account,
    )
    .await
    {
        Ok(CreateAccountOutcome::Created(id)) => Ok((
            StatusCode::CREATED,
            Json(json!({ "pubkey": request.pubkey, "accountId": id })),
        )),
        Ok(CreateAccountOutcome::EmailTaken) => {
            Err(api_error(StatusCode::CONFLICT, "email_taken"))
        }
        Ok(CreateAccountOutcome::PubkeyTaken) => {
            Err(api_error(StatusCode::CONFLICT, "pubkey_taken"))
        }
        Err(error) => Err(internal_error(&format!("create account: {error}"))),
    }
}
```

Register the module in `crates/buzz-relay/src/api/mod.rs`:

```rust
pub mod accounts;
```

Register the route in `crates/buzz-relay/src/router.rs`, beside the existing
`/api/invites` line:

```rust
        .route("/api/accounts/signup", post(api::accounts::signup))
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
. ./bin/activate-hermit && cargo test -p buzz-relay api::accounts
```

Expected: 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-relay/src/api/accounts.rs crates/buzz-relay/src/api/mod.rs crates/buzz-relay/src/router.rs
git commit -s -m "feat(relay): add account signup route

HTTP rather than an event kind because signup precedes key ownership, the
same exemption /api/invites/claim takes. The community comes from the request
host, never from the body, so a caller cannot create an account in a tenant
they were never pointed at."
```

---

### Task 5: Signin route with lockout

**Files:**
- Modify: `crates/buzz-relay/src/api/accounts.rs`
- Modify: `crates/buzz-relay/src/router.rs`

**Interfaces:**
- Consumes: Task 2 (`verify_auth_key`, `dummy_verify`), Task 3 (`find_account`, `record_signin_success`, `record_signin_failure`).
- Produces: `pub async fn signin(...)`, `pub const LOCK_THRESHOLD: i32 = 10`, `pub const LOCK_DURATION_MINS: i64 = 15`.

- [ ] **Step 1: Write the failing test**

Append to the test module in `crates/buzz-relay/src/api/accounts.rs`:

```rust
    #[test]
    fn signin_validation_accepts_a_well_formed_body() {
        let request = SigninRequest {
            email: "founder@example.com".into(),
            auth_key: "b".repeat(64),
        };
        assert!(validate_signin(&request).is_ok());
    }

    #[test]
    fn signin_validation_rejects_a_malformed_auth_key() {
        let request = SigninRequest {
            email: "founder@example.com".into(),
            auth_key: "short".into(),
        };
        assert_eq!(validate_signin(&request).unwrap_err(), "invalid_auth_key");
    }

    #[test]
    fn lock_expiry_is_reported_in_whole_seconds_remaining() {
        let until = chrono::Utc::now() + chrono::Duration::seconds(90);
        let secs = retry_after_secs(until);
        assert!((85..=90).contains(&secs), "got {secs}");
    }

    #[test]
    fn a_lock_already_in_the_past_reports_zero() {
        let until = chrono::Utc::now() - chrono::Duration::seconds(30);
        assert_eq!(retry_after_secs(until), 0);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
. ./bin/activate-hermit && cargo test -p buzz-relay api::accounts
```

Expected: compile failure, `SigninRequest` does not exist.

- [ ] **Step 3: Write the implementation**

Append to `crates/buzz-relay/src/api/accounts.rs`:

```rust
/// Failed signins before the account locks.
pub const LOCK_THRESHOLD: i32 = 10;
/// How long a locked account stays locked.
pub const LOCK_DURATION_MINS: i64 = 15;

/// Body for `POST /api/accounts/signin`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SigninRequest {
    pub email: String,
    pub auth_key: String,
}

pub(crate) fn validate_signin(request: &SigninRequest) -> Result<(), &'static str> {
    let email = normalise_email(&request.email);
    if email.len() > MAX_EMAIL_LEN || !email.contains('@') {
        return Err("invalid_email");
    }
    if !is_lowercase_hex(&request.auth_key, 64) {
        return Err("invalid_auth_key");
    }
    Ok(())
}

/// Whole seconds until `until`, floored at zero.
pub(crate) fn retry_after_secs(until: chrono::DateTime<chrono::Utc>) -> i64 {
    (until - chrono::Utc::now()).num_seconds().max(0)
}

/// `POST /api/accounts/signin`
///
/// Returns `invalid_credentials` for both an unknown address and a wrong
/// password, and burns equivalent work on the unknown path so the two cannot
/// be told apart by timing. Signup deliberately does disclose existence; that
/// is a usability requirement on one screen, and repeating it here would hand
/// credential stuffing a free oracle.
pub async fn signin(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<SigninRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if let Err(reason) = validate_signin(&request) {
        return Err(api_error(StatusCode::BAD_REQUEST, reason));
    }
    let tenant = tenant_from_host(&state, &headers).await?;
    let email = normalise_email(&request.email);

    let account = buzz_db::accounts::find_account(state.db.pool(), tenant.community_id, &email)
        .await
        .map_err(|error| internal_error(&format!("find account: {error}")))?;

    let Some(account) = account else {
        dummy_verify();
        return Err(api_error(StatusCode::UNAUTHORIZED, "invalid_credentials"));
    };

    if let Some(until) = account.locked_until {
        if until > chrono::Utc::now() {
            return Err((
                StatusCode::LOCKED,
                Json(json!({
                    "error": "temporarily_locked",
                    "retryAfterSecs": retry_after_secs(until),
                })),
            ));
        }
    }

    if !verify_auth_key(&request.auth_key, &account.auth_hash) {
        let locked = buzz_db::accounts::record_signin_failure(
            state.db.pool(),
            account.id,
            LOCK_THRESHOLD,
            chrono::Duration::minutes(LOCK_DURATION_MINS),
        )
        .await
        .map_err(|error| internal_error(&format!("record failure: {error}")))?;

        if let Some(until) = locked {
            return Err((
                StatusCode::LOCKED,
                Json(json!({
                    "error": "temporarily_locked",
                    "retryAfterSecs": retry_after_secs(until),
                })),
            ));
        }
        return Err(api_error(StatusCode::UNAUTHORIZED, "invalid_credentials"));
    }

    buzz_db::accounts::record_signin_success(state.db.pool(), account.id)
        .await
        .map_err(|error| internal_error(&format!("record success: {error}")))?;

    Ok(Json(json!({
        "pubkey": account.pubkey,
        "passwordBlob": account.password_blob,
        "kdfVersion": account.kdf_version,
    })))
}
```

Add the import of `verify_auth_key` and `dummy_verify` to the existing
`buzz_auth::account_verifier` use statement, and register the route:

```rust
        .route("/api/accounts/signin", post(api::accounts::signin))
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
. ./bin/activate-hermit && cargo test -p buzz-relay api::accounts
```

Expected: 13 tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-relay/src/api/accounts.rs crates/buzz-relay/src/router.rs
git commit -s -m "feat(relay): add account signin with lockout

Unknown addresses and wrong passwords return the same error and burn the same
work, so signin cannot be used to enumerate accounts. Ten failures lock the
account for fifteen minutes, which is the real defence against credential
stuffing since fixed-window rate limits allow burst at boundaries."
```

---

### Task 6: Recover and reset-password routes

**Files:**
- Modify: `crates/buzz-relay/src/api/accounts.rs`
- Modify: `crates/buzz-relay/src/router.rs`

**Interfaces:**
- Consumes: Task 1 (`constant_time_eq_hex`), Task 3 (`issue_reset_token`, `consume_reset_and_rewrite`, `PasswordReset`).
- Produces: `pub async fn recover(...)`, `pub async fn reset_password(...)`.

- [ ] **Step 1: Write the failing test**

Append to the test module:

```rust
    #[test]
    fn recover_validation_requires_a_hex_hash() {
        let request = RecoverRequest {
            email: "a@x.com".into(),
            recovery_code_hash: "nothex".into(),
        };
        assert_eq!(validate_recover(&request).unwrap_err(), "invalid_recovery_code_hash");
    }

    #[test]
    fn reset_validation_requires_a_new_recovery_code() {
        // A reset must issue a fresh code: the old one was just typed into a
        // form, which is exactly when it is most likely to have been seen.
        let mut request = valid_reset();
        request.recovery_code_hash = String::new();
        assert_eq!(validate_reset(&request).unwrap_err(), "invalid_recovery_code_hash");
    }

    #[test]
    fn reset_validation_rejects_identical_blobs() {
        let mut request = valid_reset();
        request.recovery_blob = request.password_blob.clone();
        assert_eq!(validate_reset(&request).unwrap_err(), "invalid_blob");
    }

    #[test]
    fn reset_validation_accepts_a_well_formed_body() {
        assert!(validate_reset(&valid_reset()).is_ok());
    }
```

Add a `valid_reset()` helper to the test module mirroring `valid()`, with a
`reset_token` of 64 hex characters.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
. ./bin/activate-hermit && cargo test -p buzz-relay api::accounts
```

Expected: compile failure, `RecoverRequest` does not exist.

- [ ] **Step 3: Write the implementation**

Append to `crates/buzz-relay/src/api/accounts.rs`. The two handlers follow the
shape of `signin`. Specific requirements:

- `recover` compares the stored `recovery_code_hash` with
  `constant_time_eq_hex`, never `==`.
- On success it generates a 32-byte random `reset_token`, stores
  `SHA-256(reset_token)` via `issue_reset_token` with a 15-minute expiry, and
  returns the plaintext token once. The plaintext is never stored.
- A wrong code returns `401 invalid_recovery_code` and increments the same
  failure counter signin uses, so a recovery-code guesser hits the same lock.
- `reset_password` calls `consume_reset_and_rewrite`, which deletes the token
  row and rewrites the account in one transaction. A `false` return is
  `401 invalid_reset_token`, covering expired, already used, and never issued
  without distinguishing them.
- `reset_password` rewrites **both** blobs and the recovery code hash. Rejecting
  a body that omits the new recovery code is what the validation test above
  pins down.

Register both routes:

```rust
        .route("/api/accounts/recover", post(api::accounts::recover))
        .route("/api/accounts/reset-password", post(api::accounts::reset_password))
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
. ./bin/activate-hermit && cargo test -p buzz-relay api::accounts
```

Expected: 17 tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-relay/src/api/accounts.rs crates/buzz-relay/src/router.rs
git commit -s -m "feat(relay): add account recovery and password reset

A reset issues a fresh recovery code as well as rewriting both blobs, because
the old code was just typed into a form. The reset token is deleted inside the
same transaction that rewrites the account, so a replay finds nothing."
```

---

### Task 7: Rate limiting

**Files:**
- Modify: `crates/buzz-relay/src/api/accounts.rs`

**Interfaces:**
- Consumes: the existing `RateLimiter` trait in `crates/buzz-auth/src/rate_limit.rs` and whichever Redis implementation `AppState` already holds. Read how `invites.rs` limits claims and follow it rather than introducing a second mechanism.
- Produces: `async fn enforce_limits(state, headers, email, route) -> Result<(), (StatusCode, Json<Value>)>`.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn rate_limit_keys_hash_the_email() {
        // The Redis keyspace must not become a plaintext list of every user's
        // address. Anyone with Redis access would otherwise have the mailing
        // list.
        let key = email_rate_key("signin", "founder@example.com");
        assert!(!key.contains("founder"));
        assert!(!key.contains('@'));
        assert!(key.starts_with("acct:signin:"));
    }

    #[test]
    fn rate_limit_keys_normalise_before_hashing() {
        assert_eq!(
            email_rate_key("signin", " Founder@Example.COM "),
            email_rate_key("signin", "founder@example.com")
        );
    }

    #[test]
    fn every_route_has_a_configured_limit() {
        for route in ["signup", "signin", "recover", "reset-password"] {
            let limits = limits_for(route).expect("every route needs limits");
            assert!(limits.per_ip > 0, "{route} has no IP limit");
        }
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
. ./bin/activate-hermit && cargo test -p buzz-relay api::accounts
```

Expected: compile failure, `email_rate_key` does not exist.

- [ ] **Step 3: Write the implementation**

```rust
/// Per-route limits, all fixed-window over one hour.
///
/// The `RateLimiter` trait's own documentation warns fixed windows allow up to
/// 2x burst at boundaries. That is acceptable here: the account lockout in
/// `signin` is the real defence against credential stuffing, and these limits
/// exist to bound bulk probing.
pub(crate) struct RouteLimits {
    pub per_ip: u64,
    pub per_email: Option<u64>,
}

pub(crate) fn limits_for(route: &str) -> Option<RouteLimits> {
    Some(match route {
        "signup" => RouteLimits { per_ip: 5, per_email: None },
        "signin" => RouteLimits { per_ip: 30, per_email: Some(10) },
        "recover" => RouteLimits { per_ip: 20, per_email: Some(5) },
        "reset-password" => RouteLimits { per_ip: 10, per_email: Some(5) },
        _ => return None,
    })
}

/// Rate-limit key for an address, hashed so Redis never holds a plaintext
/// list of every Colony user's email address.
pub(crate) fn email_rate_key(route: &str, email: &str) -> String {
    let digest = sha2::Sha256::digest(normalise_email(email).as_bytes());
    format!("acct:{route}:{}", hex::encode(digest))
}
```

Then wire `enforce_limits` into all four handlers as their first action after
validation, returning `429` with `{"error": "rate_limited", "retryAfterSecs": n}`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
. ./bin/activate-hermit && cargo test -p buzz-relay api::accounts
```

Expected: 20 tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-relay/src/api/accounts.rs
git commit -s -m "feat(relay): rate limit the account routes

Per-email keys are hashed so the Redis keyspace does not become a plaintext
roster of every user's address."
```

---

### Task 8: Client-side auth crypto

**Files:**
- Create: `desktop/src/features/onboarding/authCrypto.ts`
- Create: `desktop/src/features/onboarding/authCrypto.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export async function deriveAuthKey(email: string, password: string): Promise<string>`
  - `export function generateRecoveryCode(): string`
  - `export async function hashRecoveryCode(code: string): Promise<string>`
  - `export function normaliseEmail(raw: string): string`
  - `export const CROCKFORD_ALPHABET: string`

- [ ] **Step 1: Write the failing test**

Create `desktop/src/features/onboarding/authCrypto.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CROCKFORD_ALPHABET,
  deriveAuthKey,
  generateRecoveryCode,
  hashRecoveryCode,
  normaliseEmail,
} from "./authCrypto.ts";

test("normalises case and surrounding whitespace", () => {
  assert.equal(normaliseEmail("  Founder@Example.COM "), "founder@example.com");
});

test("derives a stable 64 character key for the same inputs", async () => {
  const first = await deriveAuthKey("founder@example.com", "correct horse battery");
  const second = await deriveAuthKey("founder@example.com", "correct horse battery");
  assert.equal(first, second);
  assert.equal(first.length, 64);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("the same password on a different address derives a different key", async () => {
  const first = await deriveAuthKey("a@x.com", "correct horse battery");
  const second = await deriveAuthKey("b@x.com", "correct horse battery");
  assert.notEqual(first, second);
});

test("email case does not change the derived key", async () => {
  const lower = await deriveAuthKey("founder@example.com", "correct horse battery");
  const upper = await deriveAuthKey("FOUNDER@EXAMPLE.COM", "correct horse battery");
  assert.equal(lower, upper);
});

test("a different password derives a different key", async () => {
  const first = await deriveAuthKey("a@x.com", "correct horse battery");
  const second = await deriveAuthKey("a@x.com", "correct horse batteries");
  assert.notEqual(first, second);
});

test("recovery codes are four groups of five Crockford characters", () => {
  const code = generateRecoveryCode();
  assert.equal(code.length, 23);
  const groups = code.split("-");
  assert.equal(groups.length, 4);
  for (const group of groups) {
    assert.equal(group.length, 5);
    for (const character of group) {
      assert.ok(CROCKFORD_ALPHABET.includes(character), `${character} is outside the alphabet`);
    }
  }
});

test("recovery codes do not repeat", () => {
  assert.notEqual(generateRecoveryCode(), generateRecoveryCode());
});

test("recovery code hashing ignores case and spacing", async () => {
  const code = generateRecoveryCode();
  assert.equal(await hashRecoveryCode(code), await hashRecoveryCode(` ${code.toLowerCase()} `));
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/authCrypto.test.mjs
```

Expected: FAIL, the module does not exist.

- [ ] **Step 3: Write the implementation**

Create `desktop/src/features/onboarding/authCrypto.ts`:

```ts
/**
 * Client-side derivation for email and password accounts.
 *
 * The password never leaves this computer. What goes to the relay is
 * `deriveAuthKey`'s output, which proves the password is known without
 * revealing it, and which is a different value from the one that unlocks the
 * saved account, so the relay learns nothing that helps it open the account.
 */

/** Crockford base32: no I, L, O or U, so a code cannot be misread. */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const PBKDF2_ITERATIONS = 600_000;
const GROUP_LEN = 5;
const GROUP_COUNT = 4;

/** Canonical form of an address: trimmed and lowercased. */
export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

/**
 * Derive the value the relay checks against its stored hash.
 *
 * The salt comes from the address rather than the server, so a second computer
 * can derive this from the password alone with no round trip before the user
 * has typed anything.
 */
export async function deriveAuthKey(email: string, password: string): Promise<string> {
  const salt = await sha256(`colony-auth-v1:${normaliseEmail(email)}`);
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    material,
    256,
  );
  return toHex(bits);
}

/** Generate a recovery code in `XXXXX-XXXXX-XXXXX-XXXXX` form. */
export function generateRecoveryCode(): string {
  const bytes = new Uint8Array(GROUP_LEN * GROUP_COUNT);
  crypto.getRandomValues(bytes);
  const groups: string[] = [];
  for (let index = 0; index < GROUP_COUNT; index += 1) {
    let group = "";
    for (let offset = 0; offset < GROUP_LEN; offset += 1) {
      // The alphabet is exactly 32 characters, so a 5-bit slice is unbiased.
      group += CROCKFORD_ALPHABET[bytes[index * GROUP_LEN + offset] & 0b0001_1111];
    }
    groups.push(group);
  }
  return groups.join("-");
}

/** Lowercase hex SHA-256 of a recovery code, after the same normalisation the relay applies. */
export async function hashRecoveryCode(code: string): Promise<string> {
  return toHex(await sha256(code.trim().toUpperCase()));
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/authCrypto.test.mjs
```

Expected: 8 tests pass. PBKDF2 at 600k iterations takes roughly 300 ms per
derivation, so this file takes a few seconds.

- [ ] **Step 5: Prove the Rust and TypeScript hashes agree**

A recovery code hashed in TypeScript must match the same code hashed in Rust,
or recovery silently never works. Verify by hand once:

```bash
cd desktop && node --import ./test-loader.mjs --experimental-strip-types -e \
  'import("./src/features/onboarding/authCrypto.ts").then(async (m) => console.log(await m.hashRecoveryCode("ABCDE-FGHJK-MNPQR-STVWX")))'
```

Then add a Rust test in `account_crypto.rs` asserting
`hash_recovery_code("ABCDE-FGHJK-MNPQR-STVWX")` equals that exact string, with a
comment saying where the value came from. This is the only cross-language
invariant in the system and it deserves a pinned value, not two independent
implementations that are assumed to agree.

- [ ] **Step 6: Commit**

```bash
git add desktop/src/features/onboarding/authCrypto.ts desktop/src/features/onboarding/authCrypto.test.mjs crates/buzz-auth/src/account_crypto.rs
git commit -s -m "feat(onboarding): derive auth keys and recovery codes on device

The password is turned into an auth key here and never sent. The salt comes
from the address rather than the server so a second computer can derive it
before any round trip. A pinned cross-language test proves the Rust and
TypeScript recovery-code hashes agree, which is the one invariant that would
otherwise fail silently."
```

---

### Task 9: The real auth service

**Files:**
- Create: `desktop/src/features/onboarding/authService.ts`
- Create: `desktop/src/features/onboarding/authService.test.mjs`
- Modify: `desktop/src/features/onboarding/contracts.ts`
- Modify: `desktop/src/features/onboarding/contracts.fake.ts`

**Interfaces:**
- Consumes: Task 8 (`deriveAuthKey`, `generateRecoveryCode`, `hashRecoveryCode`), the existing `createNcryptsecBackup` and `importIdentity` in `desktop/src/shared/api/tauriIdentity.ts`.
- Produces: `export function createAuthService(deps: AuthDeps): OnboardingServices["auth"]` and `export type AuthFailure`.

`deps` is injected so the tests never touch Tauri:

```ts
export type AuthDeps = {
  post: (path: string, body: unknown) => Promise<{ status: number; body: unknown }>;
  createBackup: (password: string) => Promise<string>;
  importIdentity: (blob: string, password: string) => Promise<void>;
  generateCode?: () => string;
};
```

- [ ] **Step 1: Write the failing test**

Create `desktop/src/features/onboarding/authService.test.mjs`. Cover every row
of the error-mapping table in the spec, plus the three behaviours that matter:

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import { createAuthService } from "./authService.ts";

function deps(overrides = {}) {
  return {
    post: async () => ({ status: 201, body: { pubkey: "a".repeat(64), accountId: "id" } }),
    createBackup: async (secret) => `ncryptsec1${secret}`,
    importIdentity: async () => {},
    generateCode: () => "ABCDE-FGHJK-MNPQR-STVWX",
    ...overrides,
  };
}

test("signUp returns the pubkey and the recovery code", async () => {
  const auth = createAuthService(deps());
  const result = await auth.signUp("founder@example.com", "correct horse battery");
  assert.equal(result.pubkey, "a".repeat(64));
  assert.equal(result.recoveryCode, "ABCDE-FGHJK-MNPQR-STVWX");
});

test("signUp sends two different blobs and never sends the password", async () => {
  let sent;
  const auth = createAuthService(
    deps({
      post: async (_path, body) => {
        sent = body;
        return { status: 201, body: { pubkey: "a".repeat(64), accountId: "id" } };
      },
    }),
  );
  await auth.signUp("founder@example.com", "correct horse battery");
  assert.notEqual(sent.passwordBlob, sent.recoveryBlob);
  const serialised = JSON.stringify(sent);
  assert.ok(!serialised.includes("correct horse battery"), "the password must never be sent");
});

test("a taken address maps to email-taken", async () => {
  const auth = createAuthService(
    deps({ post: async () => ({ status: 409, body: { error: "email_taken" } }) }),
  );
  await assert.rejects(
    () => auth.signUp("founder@example.com", "correct horse battery"),
    (error) => error.kind === "email-taken",
  );
});

test("a lockout carries its retry delay", async () => {
  const auth = createAuthService(
    deps({
      post: async () => ({
        status: 423,
        body: { error: "temporarily_locked", retryAfterSecs: 900 },
      }),
    }),
  );
  await assert.rejects(
    () => auth.signIn("founder@example.com", "wrong"),
    (error) => error.kind === "locked" && error.retryAfterSecs === 900,
  );
});

test("a network failure maps to unreachable", async () => {
  const auth = createAuthService(
    deps({
      post: async () => {
        throw new TypeError("Failed to fetch");
      },
    }),
  );
  await assert.rejects(
    () => auth.signUp("founder@example.com", "correct horse battery"),
    (error) => error.kind === "unreachable",
  );
});

test("a 500 maps to unreachable rather than leaking a status", async () => {
  const auth = createAuthService(
    deps({ post: async () => ({ status: 500, body: { error: "internal server error" } }) }),
  );
  await assert.rejects(
    () => auth.signUp("founder@example.com", "correct horse battery"),
    (error) => error.kind === "unreachable",
  );
});

test("signIn imports the returned blob with the password", async () => {
  let imported;
  const auth = createAuthService(
    deps({
      post: async () => ({
        status: 200,
        body: { pubkey: "a".repeat(64), passwordBlob: "ncryptsec1abc", kdfVersion: 1 },
      }),
      importIdentity: async (blob, password) => {
        imported = { blob, password };
      },
    }),
  );
  await auth.signIn("founder@example.com", "correct horse battery");
  assert.deepEqual(imported, { blob: "ncryptsec1abc", password: "correct horse battery" });
});

test("wrong credentials map to invalid-credentials", async () => {
  const auth = createAuthService(
    deps({ post: async () => ({ status: 401, body: { error: "invalid_credentials" } }) }),
  );
  await assert.rejects(
    () => auth.signIn("founder@example.com", "wrong"),
    (error) => error.kind === "invalid-credentials",
  );
});

test("an unsupported kdf version is surfaced, not ignored", async () => {
  // A newer relay could return a version this build cannot open. Silently
  // continuing would leave the user signed in with no working key.
  const auth = createAuthService(
    deps({
      post: async () => ({
        status: 200,
        body: { pubkey: "a".repeat(64), passwordBlob: "ncryptsec1abc", kdfVersion: 99 },
      }),
    }),
  );
  await assert.rejects(
    () => auth.signIn("founder@example.com", "correct horse battery"),
    (error) => error.kind === "update-required",
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/authService.test.mjs
```

Expected: FAIL, the module does not exist.

- [ ] **Step 3: Write the implementation**

Create `desktop/src/features/onboarding/authService.ts`. It must:

- Build the signup body from `deriveAuthKey`, two `createBackup` calls (one
  with the password, one with the recovery code), and `hashRecoveryCode`.
- Throw an `AuthFailure` object with a `kind` discriminant, never a bare
  `Error` with a parsed message.
- Map exactly per the spec's table: `email_taken` to `email-taken`,
  `invalid_credentials` to `invalid-credentials`, `temporarily_locked` to
  `locked` carrying `retryAfterSecs`, anything else including throws and 5xx to
  `unreachable`, and an unknown `kdfVersion` to `update-required`.
- Never log, store, or return the password.

Then extend `contracts.ts`:

```ts
  auth: {
    signUp: (email: string, password: string) => Promise<SignUpResult>;
    signIn: (email: string, password: string) => Promise<{ pubkey: string }>;
    recover: (
      email: string,
      code: string,
    ) => Promise<{ pubkey: string; resetToken: string }>;
  };
```

and add matching fakes to `contracts.fake.ts` so every existing onboarding test
keeps passing unchanged.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/authService.test.mjs
```

Expected: 9 tests pass.

- [ ] **Step 5: Check the contract change broke nothing**

```bash
cd desktop && pnpm typecheck && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/contracts.test.mjs
```

Expected: clean typecheck, existing contract tests pass.

- [ ] **Step 6: Commit**

```bash
git add desktop/src/features/onboarding/authService.ts desktop/src/features/onboarding/authService.test.mjs desktop/src/features/onboarding/contracts.ts desktop/src/features/onboarding/contracts.fake.ts
git commit -s -m "feat(onboarding): implement the real auth service

Maps every relay error to a typed union the screens already render, so no
screen parses an error string or sees an HTTP status. A test asserts the
password never appears in the request body."
```

---

### Task 10: Wire the service into the flow

**Files:**
- Modify: `desktop/src/features/onboarding/ui/new/NewOnboardingFlow.tsx`
- Modify: `desktop/src/features/onboarding/ui/new/screens/Account.tsx`

**Interfaces:**
- Consumes: Task 9 (`createAuthService`, `AuthFailure`).
- Produces: nothing new; the flow now accepts real services where it previously only took fakes.

- [ ] **Step 1: Read what exists before changing it**

The screens were built against fakes and already render every state. Read
`Account.tsx` and confirm which of `email-taken`, `invalid-credentials`,
`locked` and `unreachable` it already handles. Only add what is missing. Do not
restructure a screen that works.

- [ ] **Step 2: Write the failing test**

Add to `desktop/tests/e2e/onboarding-redesign.spec.ts` a case that drives
screen 1 with a service whose `signUp` rejects with `{ kind: "email-taken" }`
and asserts the inline error appears on the email field and the password field
still holds its value.

- [ ] **Step 3: Run it to verify it fails**

```bash
cd desktop && pnpm test:e2e:smoke
```

Expected: FAIL on the new case.

- [ ] **Step 4: Wire it up**

Pass the real service when `VITE_NEW_ONBOARDING` is on and the app is not in
`e2e` mode; keep fakes for `e2e`. The existing `newOnboardingFlag.ts` already
draws that line, so read it and follow it rather than adding a second flag.

- [ ] **Step 5: Run it to verify it passes**

```bash
cd desktop && pnpm test:e2e:smoke
```

Expected: all smoke specs pass.

- [ ] **Step 6: Commit**

```bash
git add desktop/src/features/onboarding/ui/new desktop/tests/e2e/onboarding-redesign.spec.ts
git commit -s -m "feat(onboarding): use the real auth service behind the flag

E2E keeps its fakes so the existing specs stay hermetic."
```

---

### Task 11: End-to-end integration coverage

**Files:**
- Create: `crates/buzz-test-client/tests/e2e_accounts.rs`

**Interfaces:**
- Consumes: every route from Tasks 4 to 7.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Read `crates/buzz-test-client/tests/e2e_relay.rs` first and copy its harness
setup exactly. Cover:

1. signup then signin round-trip returns the same pubkey and the stored blob
2. a duplicate address is `409 email_taken`
3. a wrong auth key is `401 invalid_credentials`
4. an unknown address is `401 invalid_credentials` and takes comparable time
5. ten failures produce `423 temporarily_locked` with a `retryAfterSecs`
6. a successful signin clears the failure counter
7. recover returns the recovery blob and a reset token
8. a replayed reset token is `401`
9. reset-password rewrites both blobs, and the old password no longer signs in
10. an account created on community A is invisible on community B

- [ ] **Step 2: Run it to verify it fails**

Use the isolated harness so the database is fresh. An accumulated database
produces false passes here.

```bash
. ./bin/activate-hermit && ./scripts/start-isolated-test-relay.sh
. ./bin/activate-hermit && cargo test -p buzz-test-client --test e2e_accounts
```

Expected: FAIL, the routes return 404 if any task was skipped.

- [ ] **Step 3: Fix whatever the round-trip exposes**

This is the first time client and relay meet. Expect field-name casing
mismatches between `serde(rename_all = "camelCase")` and the TypeScript body.
Fix them in the relay, not by renaming TypeScript fields, since the wire format
in the spec is camelCase.

- [ ] **Step 4: Run it to verify it passes**

```bash
. ./bin/activate-hermit && cargo test -p buzz-test-client --test e2e_accounts
```

Expected: 10 tests pass.

- [ ] **Step 5: Commit and open the PR**

```bash
git add crates/buzz-test-client/tests/e2e_accounts.rs
git commit -s -m "test: end-to-end coverage for email and password accounts

Includes the cross-tenant case, which is the one seam a new top-level table
could introduce."
git push -u origin feat/auth-accounts
gh pr create --repo AI-Native-Ventures/Colony --base develop \
  --title "Email and password accounts with zero-knowledge key escrow" \
  --body "Implements the auth contract the onboarding redesign left open. See docs/superpowers/specs/2026-08-22-auth-accounts-design.md."
gh pr merge <number> --repo AI-Native-Ventures/Colony --merge --auto
```

---

## Self-Review

**Spec coverage:** signup, signin, recover and reset-password all have routes
(Tasks 4 to 6). Crypto design is Tasks 1, 2 and 8. Data model is Task 3. Rate
limits are Task 7. Desktop integration and error mapping are Tasks 9 and 10.
Testing strategy is spread across every task plus Task 11. The cross-language
hash invariant, which the spec implies but does not call out, is pinned in Task
8 Step 5.

**Type consistency:** `NewAccount`, `AccountRecord` and `CreateAccountOutcome`
are defined in Task 3 and used unchanged in Tasks 4 to 6. `AuthFailure` kinds
are the same four strings in the spec table, Task 9's tests, and Task 10's
wiring. `MAX_BLOB_LEN` is defined once in Task 4 and referenced by Task 6.

**Known gap, stated rather than hidden:** `PasswordReset` is named in Task 3's
interface block but its fields are only implied by Task 6. Its shape is
`{ auth_hash, password_blob, recovery_blob, recovery_code_hash, kdf_version }`,
the same five fields `NewAccount` carries minus `pubkey`, since a reset never
changes which key the account holds.
