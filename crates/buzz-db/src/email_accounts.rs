//! Email and password account persistence.
//!
//! Accounts are tenant scoped like every table here: the same address may
//! exist in two communities, and every query binds `community_id` so one
//! tenant's rows can never answer another tenant's question.
//!
//! Secrets are stored opaque and hashed. `auth_hash` is an Argon2id PHC string
//! over a client derived key, the two blobs are NIP-49 encryptions of the
//! member key, and only SHA-256 hashes of recovery codes and reset tokens are
//! ever stored. Uniqueness runs through `lower(email)` in the database, so
//! normalisation does not depend on caller discipline.
//!
//! Expected conflicts are typed outcomes ([`CreateAccountOutcome`]) rather
//! than parsed driver errors, and concurrent signups race through the unique
//! indexes instead of a racy pre-check. Anything that must be atomic shares
//! one transaction, following `relay_invite`.

use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row as _};
use uuid::Uuid;

use crate::error::Result;
use crate::{deletion::DeletionStore, CommunityId};

/// A stored email account row.
#[derive(Debug)]
pub struct AccountRecord {
    /// Database-generated account id, unique within one community.
    pub id: Uuid,
    /// The member's Nostr public key, 64 lowercase hex characters.
    pub pubkey: String,
    /// Argon2id PHC string over the client derived `auth_key`.
    pub auth_hash: String,
    /// Opaque NIP-49 blob encrypting the member key under the password.
    pub password_blob: String,
    /// Opaque NIP-49 blob encrypting the member key under the recovery code.
    pub recovery_blob: String,
    /// Lowercase hex SHA-256 of the normalised recovery code.
    pub recovery_code_hash: String,
    /// KDF parameter set version the client used when producing `auth_hash`
    /// and the blobs. Stored as a plain value: the storage layer never
    /// interprets it. The relay validates it against
    /// `buzz_auth::account_verifier::CURRENT_KDF_VERSION` before writing.
    pub kdf_version: i16,
    /// Consecutive failed signins since the last success.
    pub failed_attempts: i32,
    /// When the lockout ends, if the account is locked.
    pub locked_until: Option<DateTime<Utc>>,
}

/// A new account to insert. The database fills id, counters and timestamps.
#[derive(Debug)]
pub struct NewAccount {
    /// The member's Nostr public key, 64 lowercase hex characters.
    pub pubkey: String,
    /// Argon2id PHC string over the client derived `auth_key`.
    pub auth_hash: String,
    /// Opaque NIP-49 blob encrypting the member key under the password.
    pub password_blob: String,
    /// Opaque NIP-49 blob encrypting the member key under the recovery code.
    pub recovery_blob: String,
    /// Lowercase hex SHA-256 of the normalised recovery code.
    pub recovery_code_hash: String,
    /// KDF parameter set version, validated by the relay against
    /// `buzz_auth::account_verifier::CURRENT_KDF_VERSION` before it calls.
    pub kdf_version: i16,
}

/// Replacement credential set applied by a successful password reset. The
/// pubkey is absent on purpose: a reset never changes which key the account
/// holds.
#[derive(Debug)]
pub struct PasswordReset {
    /// Argon2id PHC string over the new client derived `auth_key`.
    pub auth_hash: String,
    /// New NIP-49 blob under the new password.
    pub password_blob: String,
    /// New NIP-49 blob under the fresh recovery code.
    pub recovery_blob: String,
    /// Lowercase hex SHA-256 of the fresh recovery code.
    pub recovery_code_hash: String,
    /// KDF parameter set version of the new credentials.
    pub kdf_version: i16,
}

/// Outcome of a signup insert. Expected conflicts are variants so the relay
/// layer can map them to distinct HTTP responses without inspecting database
/// errors.
#[derive(Debug, PartialEq)]
pub enum CreateAccountOutcome {
    /// The account row was inserted. Carries the new account id.
    Created(Uuid),
    /// `(community_id, lower(email))` is already claimed in this tenant.
    EmailTaken,
    /// `(community_id, pubkey)` is already claimed in this tenant.
    PubkeyTaken,
}

/// Insert a new account, mapping unique-index races to typed outcomes.
///
/// The conflict mapping inspects the violated index name rather than
/// pre-checking with a SELECT: a pre-check races, and two concurrent signups
/// would both pass it. The insert runs inside the community lifecycle gate,
/// mirroring `mint_relay_invite` for this admission-style write.
pub async fn create_account(
    pool: &PgPool,
    community: CommunityId,
    email: &str,
    account: NewAccount,
) -> Result<CreateAccountOutcome> {
    let mut tx = pool.begin().await?;
    DeletionStore::new(pool.clone())
        .guard_transaction(&mut tx, community)
        .await?;
    let inserted = sqlx::query(
        "INSERT INTO email_accounts \
         (community_id, email, pubkey, auth_hash, password_blob, recovery_blob, \
          recovery_code_hash, kdf_version) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
         RETURNING id",
    )
    .bind(community.as_uuid())
    .bind(email)
    .bind(account.pubkey)
    .bind(account.auth_hash)
    .bind(account.password_blob)
    .bind(account.recovery_blob)
    .bind(account.recovery_code_hash)
    .bind(account.kdf_version)
    .fetch_one(&mut *tx)
    .await;

    let row = match inserted {
        Ok(row) => row,
        Err(error) => {
            let conflict = error
                .as_database_error()
                .filter(|db_error| db_error.is_unique_violation())
                .and_then(|db_error| db_error.constraint().map(str::to_owned));
            match conflict {
                Some(index) => {
                    tx.rollback().await?;
                    return Ok(match index.as_str() {
                        "email_accounts_community_email_idx" => CreateAccountOutcome::EmailTaken,
                        "email_accounts_community_pubkey_idx" => CreateAccountOutcome::PubkeyTaken,
                        _ => return Err(error.into()),
                    });
                }
                None => return Err(error.into()),
            }
        }
    };
    let id: Uuid = row.try_get("id")?;
    tx.commit().await?;
    Ok(CreateAccountOutcome::Created(id))
}

/// Look up one account by normalised email inside one tenant.
///
/// The comparison runs through `lower()` on both sides so the lookup matches
/// the unique index exactly, whatever case the caller presents.
pub async fn find_account(
    pool: &PgPool,
    community: CommunityId,
    email: &str,
) -> Result<Option<AccountRecord>> {
    let row = sqlx::query(
        "SELECT id, pubkey, auth_hash, password_blob, recovery_blob, recovery_code_hash, \
                kdf_version, failed_attempts, locked_until \
         FROM email_accounts \
         WHERE community_id = $1 AND lower(email) = lower($2)",
    )
    .bind(community.as_uuid())
    .bind(email)
    .fetch_optional(pool)
    .await?;
    match row {
        Some(row) => Ok(Some(AccountRecord {
            id: row.try_get("id")?,
            pubkey: row.try_get("pubkey")?,
            auth_hash: row.try_get("auth_hash")?,
            password_blob: row.try_get("password_blob")?,
            recovery_blob: row.try_get("recovery_blob")?,
            recovery_code_hash: row.try_get("recovery_code_hash")?,
            kdf_version: row.try_get("kdf_version")?,
            failed_attempts: row.try_get("failed_attempts")?,
            locked_until: row.try_get("locked_until")?,
        })),
        None => Ok(None),
    }
}

/// Record a successful signin: clear the failure counter and any lock, and
/// stamp `last_signin_at`.
pub async fn record_signin_success(pool: &PgPool, community: CommunityId, id: Uuid) -> Result<()> {
    sqlx::query(
        "UPDATE email_accounts \
         SET failed_attempts = 0, locked_until = NULL, \
             last_signin_at = now(), updated_at = now() \
         WHERE community_id = $1 AND id = $2",
    )
    .bind(community.as_uuid())
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Record one failed signin and lock the account at the threshold.
///
/// The increment and the conditional lock are one UPDATE with RETURNING, so
/// the row lock serialises concurrent failures and two simultaneous attempts
/// cannot both read the same count. Every branch keys off the pre-update row.
///
/// When the stored `locked_until` is already in the past, the lockout has
/// been served and the counter restarts at 1 instead of incrementing.
/// Without that reset a served lockout could never end: each later failure
/// would stack on the old full counter and re-lock on every single mistake.
///
/// Returns the lock deadline in force after the update: `Some` when this
/// call crossed the threshold or an existing lock still stands, `None` when
/// the account is unlocked, including immediately after a served window.
pub async fn record_signin_failure(
    pool: &PgPool,
    community: CommunityId,
    id: Uuid,
    lock_threshold: i32,
    lock_for: chrono::Duration,
) -> Result<Option<DateTime<Utc>>> {
    let lock_expires_at = Utc::now() + lock_for;
    let row = sqlx::query(
        "UPDATE email_accounts \
         SET failed_attempts = CASE \
                 WHEN email_accounts.locked_until IS NOT NULL \
                      AND email_accounts.locked_until <= now() THEN 1 \
                 ELSE email_accounts.failed_attempts + 1 \
             END, \
             locked_until = CASE \
                 WHEN email_accounts.locked_until IS NOT NULL \
                      AND email_accounts.locked_until <= now() THEN NULL \
                 WHEN email_accounts.locked_until IS NOT NULL \
                      THEN email_accounts.locked_until \
                 WHEN email_accounts.failed_attempts + 1 >= $3 THEN $4 \
                 ELSE NULL \
             END, \
             updated_at = now() \
         WHERE community_id = $1 AND id = $2 \
         RETURNING locked_until",
    )
    .bind(community.as_uuid())
    .bind(id)
    .bind(lock_threshold)
    .bind(lock_expires_at)
    .fetch_optional(pool)
    .await?;
    row.map(|row| row.try_get::<Option<DateTime<Utc>>, _>("locked_until"))
        .transpose()
        .map_err(Into::into)
        .map(|locked| locked.flatten())
}

/// Store a single-use, short-lived password reset token for one account.
///
/// `token_hash` is the SHA-256 of the opaque token the caller returned to the
/// user. The plaintext is never stored.
pub async fn issue_reset_token(
    pool: &PgPool,
    community: CommunityId,
    account_id: Uuid,
    token_hash: &str,
    ttl: chrono::Duration,
) -> Result<()> {
    let expires_at = Utc::now() + ttl;
    sqlx::query(
        "INSERT INTO account_reset_tokens (community_id, account_id, token_hash, expires_at) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(community.as_uuid())
    .bind(account_id)
    .bind(token_hash)
    .bind(expires_at)
    .execute(pool)
    .await?;
    Ok(())
}

/// Consume a reset token and rewrite the account credentials atomically.
///
/// The token row is deleted first, inside the transaction, and the account is
/// rewritten only if that delete returned a row. Deleting first is what makes
/// a replay impossible rather than merely unlikely: a second consumer finds
/// nothing to delete. If the account update matches nothing, the rollback
/// restores the token so a transient failure does not burn a valid reset.
///
/// Returns whether the reset was applied.
pub async fn consume_reset_and_rewrite(
    pool: &PgPool,
    community: CommunityId,
    email: &str,
    token_hash: &str,
    update: PasswordReset,
) -> Result<bool> {
    let mut tx = pool.begin().await?;
    let deleted: Option<Uuid> = sqlx::query_scalar(
        "DELETE FROM account_reset_tokens \
         WHERE community_id = $1 AND token_hash = $2 AND expires_at > now() \
         RETURNING account_id",
    )
    .bind(community.as_uuid())
    .bind(token_hash)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(account_id) = deleted else {
        tx.rollback().await?;
        return Ok(false);
    };

    let rewritten = sqlx::query(
        "UPDATE email_accounts \
         SET auth_hash = $3, password_blob = $4, recovery_blob = $5, \
             recovery_code_hash = $6, kdf_version = $7, updated_at = now() \
         WHERE community_id = $1 AND id = $2 AND lower(email) = lower($8)",
    )
    .bind(community.as_uuid())
    .bind(account_id)
    .bind(update.auth_hash)
    .bind(update.password_blob)
    .bind(update.recovery_blob)
    .bind(update.recovery_code_hash)
    .bind(update.kdf_version)
    .bind(email)
    .execute(&mut *tx)
    .await?
    .rows_affected();

    if rewritten == 1 {
        tx.commit().await?;
        Ok(true)
    } else {
        tx.rollback().await?;
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;
    use sqlx::PgPool;
    use uuid::Uuid;

    const TEST_DB_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz"; // sadscan:disable np.postgres.1

    async fn setup_pool() -> PgPool {
        PgPool::connect(&test_database_url())
            .await
            .expect("connect to test DB")
    }

    fn test_database_url() -> String {
        std::env::var("BUZZ_TEST_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .unwrap_or_else(|_| TEST_DB_URL.to_owned())
    }

    // Mirrors relay_invite.rs verbatim. Do not write a second fixture: a
    // second fixture drifts from the first.
    async fn make_test_community(pool: &PgPool) -> CommunityId {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(id)
            .bind(format!("email-accounts-test-{}.example", id.simple()))
            .execute(pool)
            .await
            .expect("insert test community");
        CommunityId::from_uuid(id)
    }

    async fn delete_test_community(pool: &PgPool, community: CommunityId) {
        let mut tx = pool.begin().await.expect("begin test cleanup");
        // Community rows are permanent tombstones. Authorize this fixture-only
        // cleanup with the initial fence generation, then leave the host row in
        // place instead of bypassing the tombstone contract with DELETE.
        sqlx::query(
            "SELECT set_config('buzz.deletion_executor_community', $1, true), \
                    set_config('buzz.deletion_fence_generation', '0', true)",
        )
        .bind(community.to_string())
        .execute(&mut *tx)
        .await
        .expect("authorize test cleanup");
        // Reset tokens cascade from their accounts.
        sqlx::query("DELETE FROM email_accounts WHERE community_id = $1")
            .bind(community.as_uuid())
            .execute(&mut *tx)
            .await
            .expect("delete test accounts");
        sqlx::query(
            "UPDATE communities SET deletion_state = 'tombstone', \
                    deleted_at = COALESCE(deleted_at, now()), \
                    archived_at = COALESCE(archived_at, now()), \
                    signing_key = NULL \
             WHERE id = $1 AND deletion_state = 'active'",
        )
        .bind(community.as_uuid())
        .execute(&mut *tx)
        .await
        .expect("tombstone test community");
        tx.commit().await.expect("commit test cleanup");
    }

    fn sample_account() -> NewAccount {
        NewAccount {
            pubkey: "a".repeat(64),
            auth_hash: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$testauthhashvalue"
                .to_string(),
            password_blob: format!("ncryptsec1{}", "c".repeat(40)),
            recovery_blob: format!("ncryptsec1{}", "d".repeat(40)),
            recovery_code_hash: "e".repeat(64),
            kdf_version: 1,
        }
    }

    fn sample_reset() -> PasswordReset {
        PasswordReset {
            auth_hash: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$newauthhashvalu3"
                .to_string(),
            password_blob: format!("ncryptsec1{}", "f".repeat(40)),
            recovery_blob: format!("ncryptsec1{}", "0".repeat(40)),
            recovery_code_hash: "9".repeat(64),
            kdf_version: 1,
        }
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn creates_then_finds_an_account() {
        let pool = setup_pool().await;
        let community = make_test_community(&pool).await;
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
        assert!(found.locked_until.is_none());
        delete_test_community(&pool, community).await;
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn rejects_a_duplicate_email_regardless_of_case() {
        let pool = setup_pool().await;
        let community = make_test_community(&pool).await;
        create_account(&pool, community, "a@x.com", sample_account())
            .await
            .expect("first insert");
        let mut second = sample_account();
        second.pubkey = "b".repeat(64);
        let outcome = create_account(&pool, community, "A@X.COM", second).await;
        assert!(
            matches!(outcome, Ok(CreateAccountOutcome::EmailTaken)),
            "{outcome:?}"
        );
        delete_test_community(&pool, community).await;
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn rejects_a_duplicate_pubkey() {
        let pool = setup_pool().await;
        let community = make_test_community(&pool).await;
        create_account(&pool, community, "a@x.com", sample_account())
            .await
            .expect("first insert");
        let outcome = create_account(&pool, community, "other@x.com", sample_account()).await;
        assert!(
            matches!(outcome, Ok(CreateAccountOutcome::PubkeyTaken)),
            "{outcome:?}"
        );
        delete_test_community(&pool, community).await;
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn the_same_email_may_exist_in_two_communities() {
        let pool = setup_pool().await;
        let first = make_test_community(&pool).await;
        let second = make_test_community(&pool).await;
        create_account(&pool, first, "a@x.com", sample_account())
            .await
            .expect("first community");
        let outcome = create_account(&pool, second, "a@x.com", sample_account()).await;
        assert!(matches!(outcome, Ok(CreateAccountOutcome::Created(_))));
        delete_test_community(&pool, first).await;
        delete_test_community(&pool, second).await;
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn an_account_is_invisible_from_another_community() {
        let pool = setup_pool().await;
        let first = make_test_community(&pool).await;
        let second = make_test_community(&pool).await;
        create_account(&pool, first, "a@x.com", sample_account())
            .await
            .expect("first community");
        let found = find_account(&pool, second, "a@x.com")
            .await
            .expect("cross-tenant lookup");
        assert!(found.is_none(), "accounts must not leak across tenants");
        delete_test_community(&pool, first).await;
        delete_test_community(&pool, second).await;
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn failures_accumulate_then_lock() {
        let pool = setup_pool().await;
        let community = make_test_community(&pool).await;
        let outcome = create_account(&pool, community, "a@x.com", sample_account())
            .await
            .expect("create");
        let CreateAccountOutcome::Created(id) = outcome else {
            panic!("expected a created account");
        };

        for _ in 0..9 {
            let locked = record_signin_failure(&pool, community, id, 10, Duration::minutes(15))
                .await
                .expect("record failure");
            assert!(locked.is_none(), "should not lock before the threshold");
        }
        let locked = record_signin_failure(&pool, community, id, 10, Duration::minutes(15))
            .await
            .expect("record tenth failure");
        assert!(
            locked.is_some_and(|until| until > Utc::now()),
            "the tenth failure must lock the account"
        );
        delete_test_community(&pool, community).await;
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn an_expired_lock_restarts_the_counter_instead_of_relocking() {
        let pool = setup_pool().await;
        let community = make_test_community(&pool).await;
        let outcome = create_account(&pool, community, "a@x.com", sample_account())
            .await
            .expect("create");
        let CreateAccountOutcome::Created(id) = outcome else {
            panic!("expected a created account");
        };

        for _ in 0..10 {
            record_signin_failure(&pool, community, id, 10, Duration::minutes(15))
                .await
                .expect("record failure");
        }
        // Serve the lockout: force the window into the past, as time would.
        sqlx::query(
            "UPDATE email_accounts SET locked_until = now() - interval '1 second' \
             WHERE community_id = $1 AND id = $2",
        )
        .bind(community.as_uuid())
        .bind(id)
        .execute(&pool)
        .await
        .expect("expire the lock");

        let locked = record_signin_failure(&pool, community, id, 10, Duration::minutes(15))
            .await
            .expect("record failure after the window");
        assert!(
            locked.is_none(),
            "one mistake after a served lockout must not re-lock"
        );
        let found = find_account(&pool, community, "a@x.com")
            .await
            .expect("lookup")
            .expect("account exists");
        assert_eq!(
            found.failed_attempts, 1,
            "the count must restart when the window ends"
        );
        assert!(found.locked_until.is_none());

        // From the restarted count the normal threshold applies again.
        for _ in 0..8 {
            record_signin_failure(&pool, community, id, 10, Duration::minutes(15))
                .await
                .expect("record failure");
        }
        let locked = record_signin_failure(&pool, community, id, 10, Duration::minutes(15))
            .await
            .expect("record tenth fresh failure");
        assert!(locked.is_some(), "ten fresh failures must lock again");
        delete_test_community(&pool, community).await;
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn a_success_clears_the_failure_counter() {
        let pool = setup_pool().await;
        let community = make_test_community(&pool).await;
        let outcome = create_account(&pool, community, "a@x.com", sample_account())
            .await
            .expect("create");
        let CreateAccountOutcome::Created(id) = outcome else {
            panic!("expected a created account");
        };
        record_signin_failure(&pool, community, id, 10, Duration::minutes(15))
            .await
            .expect("record failure");
        record_signin_success(&pool, community, id)
            .await
            .expect("record success");
        let found = find_account(&pool, community, "a@x.com")
            .await
            .expect("lookup")
            .expect("account exists");
        assert_eq!(found.failed_attempts, 0);
        assert!(found.locked_until.is_none());
        delete_test_community(&pool, community).await;
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn a_reset_token_works_once() {
        let pool = setup_pool().await;
        let community = make_test_community(&pool).await;
        let outcome = create_account(&pool, community, "a@x.com", sample_account())
            .await
            .expect("create");
        let CreateAccountOutcome::Created(id) = outcome else {
            panic!("expected a created account");
        };
        issue_reset_token(&pool, community, id, "tokenhash", Duration::minutes(15))
            .await
            .expect("issue token");

        let first =
            consume_reset_and_rewrite(&pool, community, "a@x.com", "tokenhash", sample_reset())
                .await
                .expect("first consume");
        assert!(first, "the first use must succeed");

        let rewritten = find_account(&pool, community, "a@x.com")
            .await
            .expect("lookup")
            .expect("account exists");
        assert_eq!(rewritten.password_blob, sample_reset().password_blob);

        let second =
            consume_reset_and_rewrite(&pool, community, "a@x.com", "tokenhash", sample_reset())
                .await
                .expect("replayed consume");
        assert!(!second, "a replayed token must fail");
        delete_test_community(&pool, community).await;
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn an_expired_reset_token_is_refused() {
        let pool = setup_pool().await;
        let community = make_test_community(&pool).await;
        let outcome = create_account(&pool, community, "a@x.com", sample_account())
            .await
            .expect("create");
        let CreateAccountOutcome::Created(id) = outcome else {
            panic!("expected a created account");
        };
        issue_reset_token(&pool, community, id, "tokenhash", Duration::minutes(-1))
            .await
            .expect("issue expired token");
        let used =
            consume_reset_and_rewrite(&pool, community, "a@x.com", "tokenhash", sample_reset())
                .await
                .expect("consume expired token");
        assert!(!used);
        delete_test_community(&pool, community).await;
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn a_token_from_one_tenant_cannot_open_another_tenants_account() {
        let pool = setup_pool().await;
        let first = make_test_community(&pool).await;
        let second = make_test_community(&pool).await;
        let mut ids = Vec::new();
        for community in [first, second] {
            let outcome = create_account(&pool, community, "a@x.com", sample_account())
                .await
                .expect("create");
            let CreateAccountOutcome::Created(id) = outcome else {
                panic!("expected a created account");
            };
            ids.push(id);
        }
        // Only the second tenant issues a token. Presenting its hash against
        // the first tenant's same-address account must refuse and leave that
        // account untouched.
        issue_reset_token(&pool, second, ids[1], "sharedhash", Duration::minutes(15))
            .await
            .expect("issue token in second tenant");
        let cross =
            consume_reset_and_rewrite(&pool, first, "a@x.com", "sharedhash", sample_reset())
                .await
                .expect("cross-tenant consume");
        assert!(!cross, "one tenant's token must not open another tenant");
        let untouched = find_account(&pool, first, "a@x.com")
            .await
            .expect("lookup")
            .expect("account exists");
        assert_eq!(untouched.password_blob, sample_account().password_blob);
        // The rightful tenant still gets its reset, exactly once.
        let own = consume_reset_and_rewrite(&pool, second, "a@x.com", "sharedhash", sample_reset())
            .await
            .expect("own-tenant consume");
        assert!(own);
        let replay =
            consume_reset_and_rewrite(&pool, second, "a@x.com", "sharedhash", sample_reset())
                .await
                .expect("replayed consume");
        assert!(!replay);
        delete_test_community(&pool, first).await;
        delete_test_community(&pool, second).await;
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn the_write_fence_covers_both_tables() {
        let pool = setup_pool().await;
        let fenced: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pg_trigger trigger \
             JOIN pg_class c ON c.oid = trigger.tgrelid \
             JOIN pg_proc p ON p.oid = trigger.tgfoid \
             WHERE c.relname IN ('email_accounts', 'account_reset_tokens') \
               AND p.proname = 'enforce_community_write_fence' \
               AND NOT trigger.tgisinternal",
        )
        .fetch_one(&pool)
        .await
        .expect("count write fences");
        assert_eq!(fenced, 2, "every new tenant table must carry the fence");
    }
}
