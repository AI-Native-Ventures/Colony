//! End-to-end integration tests for the email and password account routes.
//!
//! These tests require a running relay instance with Postgres and Redis.
//! They are marked `#[ignore]` so that `cargo test` does not fail when the
//! relay is not available.
//!
//! # Running
//!
//! Start the isolated relay, then run:
//!
//! ```text
//! RELAY_URL=ws://localhost:3030 \
//! DATABASE_URL=postgres://buzz:buzz_dev@localhost:5471/buzz \
//! cargo test -p buzz-test-client --test e2e_accounts -- --ignored
//! ```

use std::time::Instant;

use serde_json::{json, Value};
use uuid::Uuid;

// ── Harness (copied from e2e_relay.rs) ──────────────────────────────────────

fn relay_url() -> String {
    std::env::var("RELAY_URL").unwrap_or_else(|_| "ws://localhost:3000".to_string())
}

fn relay_http_url() -> String {
    relay_url()
        .replace("wss://", "https://")
        .replace("ws://", "http://")
        .trim_end_matches('/')
        .to_string()
}

async fn e2e_db_pool() -> sqlx::Pool<sqlx::Postgres> {
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://buzz:buzz_dev@localhost:5432/buzz".to_string());
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&database_url)
        .await
        .expect("connect to e2e Postgres")
}

async fn ensure_test_community(host: &str) -> Uuid {
    let pool = e2e_db_pool().await;
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO communities (id, host) \
         VALUES ($1, $2) \
         ON CONFLICT (lower(host)) DO NOTHING",
    )
    .bind(id)
    .bind(host)
    .execute(&pool)
    .await
    .unwrap_or_else(|e| panic!("seed community {host}: {e}"));

    sqlx::query_scalar("SELECT id FROM communities WHERE lower(host) = lower($1)")
        .bind(host)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("lookup community {host}: {e}"))
}

// ── Account test helpers ─────────────────────────────────────────────────────

fn unique_host() -> String {
    format!("accounts-{}.example", Uuid::new_v4().simple())
}

fn unique_email() -> String {
    format!("user-{}@example.com", Uuid::new_v4().simple())
}

/// A 64-character lowercase hex string, as required for pubkey, authKey, and
/// recoveryCodeHash.
fn unique_hex64() -> String {
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    format!("{}{}", a.simple(), b.simple())
}

/// A plausible NIP-49 blob: starts with the ncryptsec1 prefix and stays well
/// under the 512-character cap.
fn ncryptsec_blob(seed: char) -> String {
    format!("ncryptsec1{}", seed.to_string().repeat(40))
}

/// POST to an account route. The Host header sets the community; the
/// fly-client-ip header gives each test its own rate-limit IP so the
/// process-local limiter does not accumulate across tests.
async fn accounts_post(host: &str, path: &str, body: &Value, ip: &str) -> reqwest::Response {
    let client = reqwest::Client::new();
    let url = format!("{}{}", relay_http_url(), path);
    client
        .post(&url)
        .header(reqwest::header::HOST, host)
        .header("fly-client-ip", ip)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .unwrap_or_else(|e| panic!("POST {path} failed: {e}"))
}

/// A complete signup body with overridable fields.
fn signup_body(
    email: &str,
    pubkey: &str,
    auth_key: &str,
    password_blob: &str,
    recovery_blob: &str,
    recovery_code_hash: &str,
) -> Value {
    json!({
        "email": email,
        "pubkey": pubkey,
        "authKey": auth_key,
        "passwordBlob": password_blob,
        "recoveryBlob": recovery_blob,
        "recoveryCodeHash": recovery_code_hash,
        "kdfVersion": 1
    })
}

/// Signup a fresh account and return the email, pubkey, auth_key, blobs, and
/// recovery code hash for downstream assertions.
struct TestAccount {
    email: String,
    pubkey: String,
    auth_key: String,
    password_blob: String,
    recovery_blob: String,
    recovery_code_hash: String,
}

async fn signup_fresh(host: &str, ip: &str) -> TestAccount {
    let email = unique_email();
    let pubkey = unique_hex64();
    let auth_key = unique_hex64();
    let password_blob = ncryptsec_blob('a');
    let recovery_blob = ncryptsec_blob('b');
    let recovery_code_hash = unique_hex64();

    let resp = accounts_post(
        host,
        "/api/accounts/signup",
        &signup_body(
            &email,
            &pubkey,
            &auth_key,
            &password_blob,
            &recovery_blob,
            &recovery_code_hash,
        ),
        ip,
    )
    .await;
    assert_eq!(
        resp.status(),
        reqwest::StatusCode::CREATED,
        "signup should succeed, got {}",
        resp.text().await.unwrap_or_default()
    );

    TestAccount {
        email,
        pubkey,
        auth_key,
        password_blob,
        recovery_blob,
        recovery_code_hash,
    }
}

/// Recover a reset token for a known account.
async fn recover_token(host: &str, ip: &str, email: &str, recovery_code_hash: &str) -> String {
    let body = json!({ "email": email, "recoveryCodeHash": recovery_code_hash });
    let resp = accounts_post(host, "/api/accounts/recover", &body, ip).await;
    assert_eq!(
        resp.status(),
        reqwest::StatusCode::OK,
        "recover should succeed, got {}",
        resp.text().await.unwrap_or_default()
    );
    let json: Value = resp.json().await.expect("recover JSON");
    json["resetToken"]
        .as_str()
        .expect("resetToken present")
        .to_string()
}

// ── Tests ────────────────────────────────────────────────────────────────────

/// 1. Signup then signin round-trip returns the same pubkey and the stored blob.
#[tokio::test]
#[ignore]
async fn signup_then_signin_returns_pubkey_and_blob() {
    let host = unique_host();
    let ip = "10.1.0.1";
    ensure_test_community(&host).await;

    let acct = signup_fresh(&host, ip).await;

    let signin = json!({ "email": acct.email, "authKey": acct.auth_key });
    let resp = accounts_post(&host, "/api/accounts/signin", &signin, ip).await;
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let body: Value = resp.json().await.expect("signin JSON");
    assert_eq!(body["pubkey"], acct.pubkey);
    assert_eq!(body["passwordBlob"], acct.password_blob);
    assert_eq!(body["kdfVersion"], 1);
}

/// 2. A duplicate address is 409 email_taken.
#[tokio::test]
#[ignore]
async fn duplicate_email_returns_409_email_taken() {
    let host = unique_host();
    let ip = "10.2.0.1";
    ensure_test_community(&host).await;

    let acct = signup_fresh(&host, ip).await;

    // Same email, different pubkey so the conflict is on email not pubkey.
    let second = signup_body(
        &acct.email,
        &unique_hex64(),
        &acct.auth_key,
        &acct.password_blob,
        &acct.recovery_blob,
        &acct.recovery_code_hash,
    );
    let resp = accounts_post(&host, "/api/accounts/signup", &second, ip).await;
    assert_eq!(resp.status(), reqwest::StatusCode::CONFLICT);
    let body: Value = resp.json().await.expect("error JSON");
    assert_eq!(body["error"], "email_taken");
}

/// 3. A wrong auth key is 401 invalid_credentials.
#[tokio::test]
#[ignore]
async fn wrong_auth_key_returns_401_invalid_credentials() {
    let host = unique_host();
    let ip = "10.3.0.1";
    ensure_test_community(&host).await;

    let acct = signup_fresh(&host, ip).await;

    let wrong = json!({ "email": acct.email, "authKey": unique_hex64() });
    let resp = accounts_post(&host, "/api/accounts/signin", &wrong, ip).await;
    assert_eq!(resp.status(), reqwest::StatusCode::UNAUTHORIZED);
    let body: Value = resp.json().await.expect("error JSON");
    assert_eq!(body["error"], "invalid_credentials");
}

/// 4. An unknown address and a wrong password both return invalid_credentials,
/// and take comparable time. The handler calls dummy_verify() on the unknown
/// path for exactly this reason. Timing is asserted as a loose sanity bound.
#[tokio::test]
#[ignore]
async fn unknown_address_and_wrong_password_are_indistinguishable() {
    let host = unique_host();
    let ip = "10.4.0.1";
    ensure_test_community(&host).await;

    let acct = signup_fresh(&host, ip).await;

    // Wrong password (account exists, Argon2 verify runs).
    let wrong_signin = json!({ "email": acct.email, "authKey": unique_hex64() });
    let start = Instant::now();
    let resp = accounts_post(&host, "/api/accounts/signin", &wrong_signin, ip).await;
    let wrong_time = start.elapsed();
    assert_eq!(resp.status(), reqwest::StatusCode::UNAUTHORIZED);
    let wrong_body: Value = resp.json().await.expect("error JSON");
    assert_eq!(wrong_body["error"], "invalid_credentials");

    // Unknown address (dummy_verify burns the same work).
    let unknown_email = format!("no-such-{}@example.com", Uuid::new_v4().simple());
    let unknown_signin = json!({ "email": unknown_email, "authKey": acct.auth_key });
    let start = Instant::now();
    let resp = accounts_post(&host, "/api/accounts/signin", &unknown_signin, ip).await;
    let unknown_time = start.elapsed();
    assert_eq!(resp.status(), reqwest::StatusCode::UNAUTHORIZED);
    let unknown_body: Value = resp.json().await.expect("error JSON");
    assert_eq!(unknown_body["error"], "invalid_credentials");

    // Both return the same body.
    assert_eq!(wrong_body, unknown_body);

    // Loose timing sanity: the slower path should not be more than 20x the
    // faster one. Without dummy_verify the unknown path would be
    // near-instant (sub-millisecond), making the ratio enormous.
    let slower = wrong_time.max(unknown_time);
    let faster = wrong_time.min(unknown_time);
    assert!(
        slower.as_secs_f64() < faster.as_secs_f64() * 20.0,
        "timing not comparable: wrong={wrong_time:?}, unknown={unknown_time:?}"
    );
}

/// 5. Ten failures produce 423 temporarily_locked with a retryAfterSecs.
#[tokio::test]
#[ignore]
async fn ten_failures_produce_423_locked() {
    let host = unique_host();
    let ip = "10.5.0.1";
    ensure_test_community(&host).await;

    let acct = signup_fresh(&host, ip).await;

    let wrong = json!({ "email": acct.email, "authKey": unique_hex64() });

    // Nine failures return 401.
    for _ in 0..9 {
        let resp = accounts_post(&host, "/api/accounts/signin", &wrong, ip).await;
        assert_eq!(
            resp.status(),
            reqwest::StatusCode::UNAUTHORIZED,
            "first nine failures should be 401"
        );
    }

    // Tenth failure locks the account.
    let resp = accounts_post(&host, "/api/accounts/signin", &wrong, ip).await;
    assert_eq!(resp.status(), reqwest::StatusCode::LOCKED);
    let body: Value = resp.json().await.expect("locked JSON");
    assert_eq!(body["error"], "temporarily_locked");
    let retry_after = body["retryAfterSecs"]
        .as_u64()
        .expect("retryAfterSecs present");
    assert!(retry_after > 0, "retryAfterSecs must be positive");
    assert!(
        retry_after <= 900,
        "retryAfterSecs should be at most 15 minutes, got {retry_after}"
    );
}

/// 6. A successful signin clears the failure counter.
#[tokio::test]
#[ignore]
async fn successful_signin_clears_failure_counter() {
    let host = unique_host();
    let ip = "10.6.0.1";
    let community_id = ensure_test_community(&host).await;
    let pool = e2e_db_pool().await;

    let acct = signup_fresh(&host, ip).await;

    // One failure.
    let wrong = json!({ "email": acct.email, "authKey": unique_hex64() });
    let resp = accounts_post(&host, "/api/accounts/signin", &wrong, ip).await;
    assert_eq!(resp.status(), reqwest::StatusCode::UNAUTHORIZED);

    // Verify the counter is 1.
    let count: i32 =
        sqlx::query_scalar("SELECT failed_attempts FROM email_accounts WHERE community_id = $1 AND lower(email) = lower($2)")
            .bind(community_id)
            .bind(&acct.email)
            .fetch_one(&pool)
            .await
            .expect("query failed_attempts");
    assert_eq!(count, 1);

    // Successful signin.
    let good = json!({ "email": acct.email, "authKey": acct.auth_key });
    let resp = accounts_post(&host, "/api/accounts/signin", &good, ip).await;
    assert_eq!(resp.status(), reqwest::StatusCode::OK);

    // Verify the counter is reset and the lock is gone.
    let (count, locked): (i32, Option<chrono::DateTime<chrono::Utc>>) = sqlx::query_as(
        "SELECT failed_attempts, locked_until FROM email_accounts \
         WHERE community_id = $1 AND lower(email) = lower($2)",
    )
    .bind(community_id)
    .bind(&acct.email)
    .fetch_one(&pool)
    .await
    .expect("query account state after success");
    assert_eq!(count, 0, "failed_attempts must reset to 0");
    assert!(locked.is_none(), "locked_until must be cleared");
}

/// 7. Recover returns the recovery blob and a reset token.
#[tokio::test]
#[ignore]
async fn recover_returns_recovery_blob_and_reset_token() {
    let host = unique_host();
    let ip = "10.7.0.1";
    ensure_test_community(&host).await;

    let acct = signup_fresh(&host, ip).await;

    let body = json!({ "email": acct.email, "recoveryCodeHash": acct.recovery_code_hash });
    let resp = accounts_post(&host, "/api/accounts/recover", &body, ip).await;
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let body: Value = resp.json().await.expect("recover JSON");
    assert_eq!(body["pubkey"], acct.pubkey);
    assert_eq!(body["recoveryBlob"], acct.recovery_blob);
    let token = body["resetToken"].as_str().expect("resetToken present");
    assert!(!token.is_empty(), "resetToken must not be empty");
}

/// 8. A replayed reset token is 401.
#[tokio::test]
#[ignore]
async fn replayed_reset_token_fails() {
    let host = unique_host();
    let ip = "10.8.0.1";
    ensure_test_community(&host).await;

    let acct = signup_fresh(&host, ip).await;

    let token = recover_token(&host, ip, &acct.email, &acct.recovery_code_hash).await;

    let reset = json!({
        "email": acct.email,
        "resetToken": token,
        "authKey": unique_hex64(),
        "passwordBlob": ncryptsec_blob('c'),
        "recoveryBlob": ncryptsec_blob('d'),
        "recoveryCodeHash": unique_hex64(),
        "kdfVersion": 1
    });

    // First reset succeeds.
    let resp = accounts_post(&host, "/api/accounts/reset-password", &reset, ip).await;
    assert_eq!(
        resp.status(),
        reqwest::StatusCode::OK,
        "first reset should succeed, got {}",
        resp.text().await.unwrap_or_default()
    );

    // Replayed reset fails.
    let resp = accounts_post(&host, "/api/accounts/reset-password", &reset, ip).await;
    assert_eq!(resp.status(), reqwest::StatusCode::UNAUTHORIZED);
    let body: Value = resp.json().await.expect("error JSON");
    assert_eq!(body["error"], "invalid_reset_token");
}

/// 9. Reset rewrites both blobs and the recovery code, and the old password
/// no longer signs in afterwards.
#[tokio::test]
#[ignore]
async fn reset_rewrites_blobs_and_old_password_fails() {
    let host = unique_host();
    let ip = "10.9.0.1";
    ensure_test_community(&host).await;

    let acct = signup_fresh(&host, ip).await;

    // Sign in with the original password to confirm the starting state.
    let signin_a = json!({ "email": acct.email, "authKey": acct.auth_key });
    let resp = accounts_post(&host, "/api/accounts/signin", &signin_a, ip).await;
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let body: Value = resp.json().await.expect("signin JSON");
    assert_eq!(body["passwordBlob"], acct.password_blob);

    // Recover to get a reset token.
    let token = recover_token(&host, ip, &acct.email, &acct.recovery_code_hash).await;

    // Reset with new credentials.
    let auth_key_b = unique_hex64();
    let password_blob_c = ncryptsec_blob('c');
    let recovery_blob_d = ncryptsec_blob('d');
    let recovery_code_hash_s = unique_hex64();

    let reset = json!({
        "email": acct.email,
        "resetToken": token,
        "authKey": auth_key_b,
        "passwordBlob": password_blob_c,
        "recoveryBlob": recovery_blob_d,
        "recoveryCodeHash": recovery_code_hash_s,
        "kdfVersion": 1
    });
    let resp = accounts_post(&host, "/api/accounts/reset-password", &reset, ip).await;
    assert_eq!(
        resp.status(),
        reqwest::StatusCode::OK,
        "reset should succeed, got {}",
        resp.text().await.unwrap_or_default()
    );

    // The old password no longer signs in.
    let resp = accounts_post(&host, "/api/accounts/signin", &signin_a, ip).await;
    assert_eq!(
        resp.status(),
        reqwest::StatusCode::UNAUTHORIZED,
        "old auth key must no longer sign in after reset"
    );

    // The new password signs in and returns the new blob.
    let signin_b = json!({ "email": acct.email, "authKey": auth_key_b });
    let resp = accounts_post(&host, "/api/accounts/signin", &signin_b, ip).await;
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let body: Value = resp.json().await.expect("signin JSON");
    assert_eq!(body["passwordBlob"], password_blob_c);

    // The new recovery code recovers and returns the new recovery blob.
    let recover_s = json!({ "email": acct.email, "recoveryCodeHash": recovery_code_hash_s });
    let resp = accounts_post(&host, "/api/accounts/recover", &recover_s, ip).await;
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let body: Value = resp.json().await.expect("recover JSON");
    assert_eq!(body["recoveryBlob"], recovery_blob_d);

    // The old recovery code no longer recovers.
    let recover_r = json!({ "email": acct.email, "recoveryCodeHash": acct.recovery_code_hash });
    let resp = accounts_post(&host, "/api/accounts/recover", &recover_r, ip).await;
    assert_eq!(resp.status(), reqwest::StatusCode::UNAUTHORIZED);
    let body: Value = resp.json().await.expect("error JSON");
    assert_eq!(body["error"], "invalid_recovery_code");
}

/// 10. An account created on community A is invisible on community B.
#[tokio::test]
#[ignore]
async fn account_on_community_a_is_invisible_from_community_b() {
    let host_a = unique_host();
    let host_b = unique_host();
    let ip = "10.10.0.1";
    ensure_test_community(&host_a).await;
    ensure_test_community(&host_b).await;

    let acct = signup_fresh(&host_a, ip).await;

    // Sign in on community B with the same email: the account must not be
    // found, so the response is the same invalid_credentials as a wrong
    // password, not a success.
    let signin = json!({ "email": acct.email, "authKey": acct.auth_key });
    let resp = accounts_post(&host_b, "/api/accounts/signin", &signin, ip).await;
    assert_eq!(resp.status(), reqwest::StatusCode::UNAUTHORIZED);
    let body: Value = resp.json().await.expect("error JSON");
    assert_eq!(body["error"], "invalid_credentials");

    // Sign in on community A: the same credentials succeed, proving the
    // account exists but is scoped to its community.
    let resp = accounts_post(&host_a, "/api/accounts/signin", &signin, ip).await;
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let body: Value = resp.json().await.expect("signin JSON");
    assert_eq!(body["pubkey"], acct.pubkey);
}
