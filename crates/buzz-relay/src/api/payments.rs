//! Paystack card top-ups: the routes a client calls around hosted checkout,
//! plus the signature-verified provider webhook that is the only thing
//! allowed to move money.
//!
//! Four routes live here:
//!
//! - `POST /api/payments/initialize`: NIP-98 signed. Writes a pending intent,
//!   asks Paystack to open checkout, returns the URL and the reference.
//! - `POST /api/payments/verify`: NIP-98 signed. Reads our own intent row and
//!   nothing else. It never credits the ledger: a client-callable route that
//!   moves money is exactly the failure this design exists to prevent.
//! - `POST /api/payments/balance`: NIP-98 signed. Converts the ledger's
//!   nanoUSD balance into contract cents so the conversion stays server side.
//! - `POST /api/payments/webhook`: unauthenticated by design, verified by the
//!   HMAC-SHA512 signature over the raw body bytes. This is the only path
//!   that credits the ledger.
//!
//! On all three client routes the pubkey comes from the NIP-98 signature,
//! never from a body field. Every error carries a typed string from the set
//! the desktop client maps to screen states (`amount_too_small`,
//! `rate_limited`, `unknown_reference`, `payment_unavailable`); anything
//! unrecognized falls through to the client's `unreachable` bucket, so no
//! new string can break a screen.
//!
//! ## Why credit precedes settle, and why the gap between them is safe
//!
//! `buzz_db::credits::credit` owns its transaction by documented design (its
//! idempotency resolution must share one transaction with its re-select) and
//! the merged intent store exposes free functions over the pool, so the
//! credit and the intent settlement cannot share one transaction from this
//! crate. Ordering closes the gap instead:
//!
//! 1. Credit first. It is idempotent on the ledger's `UNIQUE (pubkey, ref)`.
//! 2. Settle second. It is a conditional UPDATE only a still-pending row
//!    survives, so concurrent deliveries cannot both act.
//!
//! A crash between the two leaves our 200 unsent, so Paystack re-delivers.
//! The replayed credit lands on the ledger's uniqueness and changes nothing,
//! and the settle then completes. Settling first would lose money
//! permanently, because the retry would see a settled intent and stop. Any
//! store error answers 5xx rather than 200 so that retry actually happens.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use buzz_auth::account_crypto::normalise_email;
use buzz_core::tenant::TenantContext;
use buzz_core::CommunityId;
use buzz_db::credits;
use buzz_db::payment_intents::{self, PaymentIntent};
use buzz_db::DbError;

use crate::paystack::{
    nano_usd_from_cents, verify_signature, LivePaystack, PaystackApi, NANO_USD_PER_CENT,
};
use crate::state::AppState;

use super::{api_error, internal_error};

/// Thread-safe shared client handle. `PaystackApi` carries no supertraits of
/// its own, so the bounds are named here where the object is stored and sent
/// across await points.
type SharedPaystack = Arc<dyn PaystackApi + Send + Sync>;

/// The smallest top-up accepted, in USD cents ($5.00).
pub(crate) const MIN_TOPUP_CENTS: i64 = 500;

/// RFC 5321 caps an address at 254 octets.
const MAX_EMAIL_LEN: usize = 254;

/// Longest reference accepted on a verify lookup. Minted references are far
/// shorter; the cap keeps a caller from probing arbitrary-length strings.
const MAX_REFERENCE_LEN: usize = 200;

/// How long Paystack names its signature header.
const SIGNATURE_HEADER: &str = "x-paystack-signature";

/// Body for `POST /api/payments/initialize`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeRequest {
    /// Amount to collect, in USD cents. Minimum [`MIN_TOPUP_CENTS`].
    pub usd_cents: i64,
    /// Receipt email passed through to the hosted checkout.
    pub email: String,
}

/// Body for `POST /api/payments/verify`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyRequest {
    /// The reference `initialize` returned.
    pub reference: String,
}

fn is_plausible_email(email: &str) -> bool {
    email.len() <= MAX_EMAIL_LEN
        && email.contains('@')
        && !email.starts_with('@')
        && !email.ends_with('@')
}

/// Validate an initialize request against the typed error strings the client
/// maps. Never returns free text: the client must not parse prose.
pub(crate) fn validate_initialize(request: &InitializeRequest) -> Result<(), &'static str> {
    if request.usd_cents < MIN_TOPUP_CENTS {
        return Err("amount_too_small");
    }
    // Refused here rather than at credit time so a nonsense amount never
    // becomes a stored intent.
    if nano_usd_from_cents(request.usd_cents).is_err() {
        return Err("amount_too_large");
    }
    if !is_plausible_email(&normalise_email(&request.email)) {
        return Err("invalid_email");
    }
    Ok(())
}

/// Storage and ledger seams the payment flows need.
///
/// A trait rather than direct calls so handler-level tests can fake the
/// store and assert on credits without Postgres. The production impl wraps
/// `buzz-db` verbatim; it adds no behaviour of its own.
#[async_trait::async_trait]
pub(crate) trait PaymentStore: Send + Sync {
    /// Write a pending intent for one member's checkout attempt.
    async fn create_intent(
        &self,
        community: CommunityId,
        reference: &str,
        pubkey: &[u8],
        usd_cents: i64,
    ) -> Result<(), DbError>;

    /// Look up one intent by reference inside one tenant.
    async fn find_intent(
        &self,
        community: CommunityId,
        reference: &str,
    ) -> Result<Option<PaymentIntent>, DbError>;

    /// Mark one pending intent paid exactly once; `true` when this call won.
    async fn settle_intent(
        &self,
        community: CommunityId,
        reference: &str,
        paid_cents: i64,
    ) -> Result<bool, DbError>;

    /// The account balance in nanoUSD.
    async fn balance_nanousd(&self, pubkey: &[u8]) -> Result<i64, DbError>;

    /// Credit the ledger idempotently on `reference`.
    async fn credit(
        &self,
        pubkey: &[u8],
        delta_nanousd: i64,
        reference: &str,
    ) -> Result<(), DbError>;
}

/// Production [`PaymentStore`] over the shared pool.
struct RealStore {
    pool: sqlx::PgPool,
}

impl RealStore {
    fn new(pool: sqlx::PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait::async_trait]
impl PaymentStore for RealStore {
    async fn create_intent(
        &self,
        community: CommunityId,
        reference: &str,
        pubkey: &[u8],
        usd_cents: i64,
    ) -> Result<(), DbError> {
        payment_intents::create_intent(&self.pool, community, reference, pubkey, usd_cents).await
    }

    async fn find_intent(
        &self,
        community: CommunityId,
        reference: &str,
    ) -> Result<Option<PaymentIntent>, DbError> {
        payment_intents::find_intent(&self.pool, community, reference).await
    }

    async fn settle_intent(
        &self,
        community: CommunityId,
        reference: &str,
        paid_cents: i64,
    ) -> Result<bool, DbError> {
        payment_intents::settle_intent(&self.pool, community, reference, paid_cents).await
    }

    async fn balance_nanousd(&self, pubkey: &[u8]) -> Result<i64, DbError> {
        credits::balance(&self.pool, pubkey).await
    }

    async fn credit(
        &self,
        pubkey: &[u8],
        delta_nanousd: i64,
        reference: &str,
    ) -> Result<(), DbError> {
        credits::credit(&self.pool, pubkey, delta_nanousd, reference)
            .await
            .map(|_| ())
    }
}

/// Per-pubkey fixed-window counter. Keyed by community too, because the same
/// Nostr key may hold accounts in several tenants and one tenant's spend must
/// never consume another tenant's allowance.
struct PubkeyWindow {
    count: AtomicU32,
    started_at: Instant,
}

impl PubkeyWindow {
    fn new() -> Self {
        Self {
            count: AtomicU32::new(0),
            started_at: Instant::now(),
        }
    }
}

type PubkeyRateCache = moka::sync::Cache<(CommunityId, [u8; 32]), Arc<PubkeyWindow>>;

/// Window length shared by every payment route.
const RATE_WINDOW_SECS: u64 = 3600;

/// `initialize` opens a real charge attempt, so the allowance is tight.
const INITIALIZE_PER_HOUR: u64 = 10;

/// `verify` is polled while the user is away paying; generous but bounded.
const VERIFY_PER_HOUR: u64 = 300;

/// `balance` is the recovery path a stuck payer hits a handful of times.
const BALANCE_PER_HOUR: u64 = 120;

/// Upper bound on tracked keys, mirroring the account routes: legitimate
/// traffic stays far below this, and the cap turns a flood of distinct keys
/// into bounded memory rather than unbounded growth.
const RATE_CACHE_CAPACITY: u64 = 100_000;

fn rate_cache() -> &'static PubkeyRateCache {
    static CACHE: OnceLock<PubkeyRateCache> = OnceLock::new();
    CACHE.get_or_init(|| {
        moka::sync::Cache::builder()
            .max_capacity(RATE_CACHE_CAPACITY)
            .time_to_live(std::time::Duration::from_secs(RATE_WINDOW_SECS))
            .build()
    })
}

/// Count one attempt against a fixed window, returning seconds until the
/// window resets once the allowance is spent.
fn charge_pubkey_window(
    cache: &PubkeyRateCache,
    key: (CommunityId, [u8; 32]),
    limit: u64,
) -> Option<u64> {
    let entry = cache.get_with(key, || Arc::new(PubkeyWindow::new()));
    let seen = entry.count.fetch_add(1, Ordering::Relaxed);
    if u64::from(seen) < limit {
        None
    } else {
        Some(RATE_WINDOW_SECS.saturating_sub(entry.started_at.elapsed().as_secs()))
    }
}

fn rate_limited_error(retry_after_secs: u64) -> (StatusCode, Json<Value>) {
    (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({
            "error": "rate_limited",
            "retryAfterSecs": retry_after_secs,
        })),
    )
}

/// Shared NIP-98 prelude for the client routes: bind the tenant from the
/// Host header, verify the NIP-98 signature over method, URL, and body, and
/// refuse replays. Returns the tenant and the *signing* pubkey, which is the
/// only identity these routes trust.
///
/// Dev-mode X-Pubkey fallback is disabled: unlike the account routes, money
/// is at stake and every caller here already owns a key.
async fn authenticate(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    path: &str,
    body: &[u8],
) -> Result<(TenantContext, nostr::PublicKey), (StatusCode, Json<Value>)> {
    let raw_host = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let tenant = crate::tenant::bind_community(&state.db, raw_host)
        .await
        .map_err(|_| api_error(StatusCode::NOT_FOUND, "unknown_community"))?;

    let url = super::bridge::nip98_expected_url(&state.config.relay_url, &tenant, path);
    let (pubkey, event_id_bytes) = super::bridge::verify_bridge_auth_with_options(
        headers,
        "POST",
        &url,
        Some(body),
        true, // always require NIP-98; no dev fallback on money routes
        true, // POST bodies must be covered by a payload tag
    )?;
    super::bridge::check_nip98_replay(state, &tenant, event_id_bytes).await?;

    Ok((tenant, pubkey))
}

/// The live Paystack client, built once from the deployment environment.
///
/// Absent `PAYSTACK_SECRET_KEY` means the initialize route refuses rather
/// than half-working; there is deliberately no default secret.
fn shared_paystack() -> Option<SharedPaystack> {
    static CLIENT: OnceLock<Option<SharedPaystack>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            let secret = std::env::var("PAYSTACK_SECRET_KEY")
                .ok()
                .filter(|secret| !secret.is_empty())?;
            // LivePaystack's Debug impl is redacted, so the secret cannot
            // reach a log line through the cached Arc either.
            LivePaystack::new(secret)
                .ok()
                .map(|client| Arc::new(client) as SharedPaystack)
        })
        .clone()
}

/// The webhook signing secret from the deployment environment.
///
/// Never logged. Absent means fail closed: every delivery is refused until
/// the operator configures the key, because without it nothing can be
/// verified.
fn webhook_secret() -> Option<String> {
    std::env::var("PAYSTACK_SECRET_KEY")
        .ok()
        .filter(|secret| !secret.is_empty())
}

/// `initialize` core: validate, write the pending intent, then open checkout.
///
/// The intent is written before Paystack is called so a crash mid-call still
/// leaves the reference resolvable. A Paystack failure leaves the intent
/// pending; it is dead weight, never money, and the next attempt mints a
/// fresh reference.
pub(crate) async fn initialize_payment(
    store: &dyn PaymentStore,
    paystack: &(dyn PaystackApi + Send + Sync),
    tenant: &TenantContext,
    signer_pubkey: [u8; 32],
    request: &InitializeRequest,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if let Err(reason) = validate_initialize(request) {
        return Err(api_error(StatusCode::BAD_REQUEST, reason));
    }

    let reference = format!("topup-{}", uuid::Uuid::new_v4());
    store
        .create_intent(
            tenant.community(),
            &reference,
            &signer_pubkey,
            request.usd_cents,
        )
        .await
        .map_err(|error| internal_error(&format!("create payment intent: {error}")))?;

    let email = normalise_email(&request.email);
    match paystack
        .initialize(request.usd_cents, &email, &reference)
        .await
    {
        Ok(authorization_url) => Ok(Json(json!({
            "authorizationUrl": authorization_url,
            "reference": reference,
        }))),
        Err(error) => {
            tracing::error!(reference = %reference, error = %error, "paystack initialize failed");
            Err(api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "payment_unavailable",
            ))
        }
    }
}

/// `verify` core: read our own intent row and answer from it.
///
/// Deliberately does nothing else. No credit, no settle, no provider call: a
/// read of our own record must never be able to move money, and the browser
/// return URL that usually triggers this call is attacker-controlled.
pub(crate) async fn verify_payment(
    store: &dyn PaymentStore,
    tenant: &TenantContext,
    signer_pubkey: [u8; 32],
    request: &VerifyRequest,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if request.reference.is_empty() || request.reference.len() > MAX_REFERENCE_LEN {
        return Err(api_error(StatusCode::BAD_REQUEST, "invalid_request"));
    }

    let intent = match store
        .find_intent(tenant.community(), &request.reference)
        .await
    {
        Ok(Some(intent)) => intent,
        Ok(None) => return Err(api_error(StatusCode::NOT_FOUND, "unknown_reference")),
        Err(error) => return Err(internal_error(&format!("find payment intent: {error}"))),
    };

    // A member may read only their own payment. The uniform answer gives no
    // hint whether the reference exists but belongs to someone else.
    if intent.pubkey.as_slice() != signer_pubkey {
        return Err(api_error(StatusCode::NOT_FOUND, "unknown_reference"));
    }

    let paid = intent.status == "paid";
    let usd_cents = intent.paid_cents.unwrap_or(intent.usd_cents);
    Ok(Json(json!({
        "paid": paid,
        "usdCents": usd_cents,
    })))
}

/// `balance` core: read the ledger balance and convert nanoUSD to cents.
///
/// The conversion lives here, on the server, so the client never learns the
/// nanoUSD unit exists and `NANO_USD_PER_CENT` stays the only scale factor
/// in the codebase. Integer division truncates toward zero, which keeps an
/// overdrafted (negative) balance symmetric with a positive one.
pub(crate) async fn balance_payment(
    store: &dyn PaymentStore,
    signer_pubkey: [u8; 32],
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let nanousd = store
        .balance_nanousd(&signer_pubkey)
        .await
        .map_err(|error| internal_error(&format!("read balance: {error}")))?;
    let usd_cents = nanousd / NANO_USD_PER_CENT;
    Ok(Json(json!({ "usdCents": usd_cents })))
}

/// `POST /api/payments/initialize`.
///
/// NIP-98 signed. Rate limited per pubkey: opening checkout starts a real
/// charge attempt, so the allowance is tight.
pub async fn initialize(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let (tenant, pubkey) =
        authenticate(&state, &headers, "/api/payments/initialize", &body).await?;
    let key = (tenant.community(), pubkey.to_bytes());
    if let Some(retry) = charge_pubkey_window(rate_cache(), key, INITIALIZE_PER_HOUR) {
        return Err(rate_limited_error(retry));
    }

    let request: InitializeRequest = serde_json::from_slice(&body)
        .map_err(|_| api_error(StatusCode::BAD_REQUEST, "invalid_request"))?;

    let paystack = shared_paystack()
        .ok_or_else(|| api_error(StatusCode::SERVICE_UNAVAILABLE, "payment_unavailable"))?;

    let store = RealStore::new(state.db.pool().clone());
    initialize_payment(
        &store,
        paystack.as_ref(),
        &tenant,
        pubkey.to_bytes(),
        &request,
    )
    .await
}

/// `POST /api/payments/verify`.
///
/// NIP-98 signed. Rate limited per pubkey with a polling-sized allowance.
pub async fn verify(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let (tenant, pubkey) = authenticate(&state, &headers, "/api/payments/verify", &body).await?;
    let key = (tenant.community(), pubkey.to_bytes());
    if let Some(retry) = charge_pubkey_window(rate_cache(), key, VERIFY_PER_HOUR) {
        return Err(rate_limited_error(retry));
    }

    let request: VerifyRequest = serde_json::from_slice(&body)
        .map_err(|_| api_error(StatusCode::BAD_REQUEST, "invalid_request"))?;

    let store = RealStore::new(state.db.pool().clone());
    verify_payment(&store, &tenant, pubkey.to_bytes(), &request).await
}

/// `POST /api/payments/balance`.
///
/// NIP-98 signed; the body is empty because identity travels in the
/// signature. Answers in cents so the nanoUSD-to-cents conversion stays on
/// this side of the wire.
pub async fn balance(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let (tenant, pubkey) = authenticate(&state, &headers, "/api/payments/balance", &body).await?;
    let key = (tenant.community(), pubkey.to_bytes());
    if let Some(retry) = charge_pubkey_window(rate_cache(), key, BALANCE_PER_HOUR) {
        return Err(rate_limited_error(retry));
    }

    let store = RealStore::new(state.db.pool().clone());
    balance_payment(&store, pubkey.to_bytes()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::HashMap;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Mutex;

    fn community() -> CommunityId {
        CommunityId::from_uuid(uuid::Uuid::new_v4())
    }

    fn signer() -> [u8; 32] {
        nostr::Keys::generate().public_key().to_bytes()
    }

    fn tenant_of(community: CommunityId) -> TenantContext {
        TenantContext::resolved(community, "relay.example")
    }

    fn init_request(usd_cents: i64) -> InitializeRequest {
        InitializeRequest {
            usd_cents,
            email: "founder@example.com".into(),
        }
    }

    type HandlerResult = Result<Json<Value>, (StatusCode, Json<Value>)>;

    fn err_code(result: &HandlerResult) -> (StatusCode, String) {
        let (status, body) = result.as_ref().expect_err("expected an error response");
        let reason = body
            .0
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        (*status, reason)
    }

    fn assert_typed_error(result: &HandlerResult, status: StatusCode, code: &str) {
        assert_eq!(err_code(result), (status, code.to_string()));
    }

    fn ok_value(result: HandlerResult) -> Value {
        result.expect("expected a success response").0
    }

    #[derive(Default)]
    struct FakePaystack {
        calls: Mutex<Vec<(i64, String, String)>>,
        fail: bool,
    }

    impl FakePaystack {
        fn failing() -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                fail: true,
            }
        }

        fn url_for(&self, reference: &str) -> String {
            format!("https://checkout.paystack.com/{reference}")
        }
    }

    #[async_trait::async_trait]
    impl PaystackApi for FakePaystack {
        async fn initialize(
            &self,
            usd_cents: i64,
            email: &str,
            reference: &str,
        ) -> Result<String, crate::paystack::PaystackError> {
            self.calls
                .lock()
                .unwrap()
                .push((usd_cents, email.to_string(), reference.to_string()));
            if self.fail {
                return Err(crate::paystack::PaystackError::Status { status: 500 });
            }
            Ok(self.url_for(reference))
        }
    }

    /// In-memory store recording every credit and settle, which is how the
    /// tests prove money moved (or did not) without Postgres.
    struct FakeStore {
        community: CommunityId,
        intents: Mutex<HashMap<String, PaymentIntent>>,
        balances: HashMap<Vec<u8>, i64>,
        credits: Mutex<Vec<(Vec<u8>, i64, String)>>,
        settle_calls: AtomicUsize,
        fail_settle: bool,
    }

    impl FakeStore {
        fn new(community: CommunityId) -> Self {
            Self {
                community,
                intents: Mutex::new(HashMap::new()),
                balances: HashMap::new(),
                credits: Mutex::new(Vec::new()),
                settle_calls: AtomicUsize::new(0),
                fail_settle: false,
            }
        }

        fn failing_settle(mut self) -> Self {
            self.fail_settle = true;
            self
        }

        fn with_balance(mut self, pubkey: [u8; 32], nanousd: i64) -> Self {
            self.balances.insert(pubkey.to_vec(), nanousd);
            self
        }

        fn insert_pending(&self, reference: &str, pubkey: [u8; 32], usd_cents: i64) {
            self.intents.lock().unwrap().insert(
                reference.to_string(),
                PaymentIntent {
                    reference: reference.to_string(),
                    pubkey: pubkey.to_vec(),
                    usd_cents,
                    status: "pending".into(),
                    paid_cents: None,
                },
            );
        }

        fn insert_paid(&self, reference: &str, pubkey: [u8; 32], usd_cents: i64) {
            self.intents.lock().unwrap().insert(
                reference.to_string(),
                PaymentIntent {
                    reference: reference.to_string(),
                    pubkey: pubkey.to_vec(),
                    usd_cents,
                    status: "paid".into(),
                    paid_cents: Some(usd_cents),
                },
            );
        }

        fn credit_calls(&self) -> Vec<(Vec<u8>, i64, String)> {
            self.credits.lock().unwrap().clone()
        }

        fn get(&self, reference: &str) -> Option<PaymentIntent> {
            self.intents
                .lock()
                .unwrap()
                .get(reference)
                .map(|intent| PaymentIntent {
                    reference: intent.reference.clone(),
                    pubkey: intent.pubkey.clone(),
                    usd_cents: intent.usd_cents,
                    status: intent.status.clone(),
                    paid_cents: intent.paid_cents,
                })
        }
    }

    // Cross-tenant invisibility is asserted explicitly by handing the fake a
    // different community than the intent was written under, mirroring the
    // real primary-key scoping.
    #[async_trait::async_trait]
    impl PaymentStore for FakeStore {
        async fn create_intent(
            &self,
            _community: CommunityId,
            reference: &str,
            pubkey: &[u8],
            usd_cents: i64,
        ) -> Result<(), DbError> {
            self.insert_pending(
                reference,
                pubkey.try_into().expect("32-byte pubkey"),
                usd_cents,
            );
            Ok(())
        }

        async fn find_intent(
            &self,
            community: CommunityId,
            reference: &str,
        ) -> Result<Option<PaymentIntent>, DbError> {
            if community != self.community {
                return Ok(None);
            }
            Ok(self.get(reference))
        }

        async fn settle_intent(
            &self,
            community: CommunityId,
            reference: &str,
            paid_cents: i64,
        ) -> Result<bool, DbError> {
            if community != self.community {
                return Ok(false);
            }
            self.settle_calls.fetch_add(1, Ordering::SeqCst);
            if self.fail_settle {
                return Err(DbError::InvalidData("injected settle failure".into()));
            }
            let mut intents = self.intents.lock().unwrap();
            match intents.get_mut(reference) {
                Some(intent) if intent.status == "pending" => {
                    intent.status = "paid".into();
                    intent.paid_cents = Some(paid_cents);
                    Ok(true)
                }
                _ => Ok(false),
            }
        }

        async fn balance_nanousd(&self, pubkey: &[u8]) -> Result<i64, DbError> {
            Ok(self.balances.get(pubkey).copied().unwrap_or(0))
        }

        async fn credit(
            &self,
            pubkey: &[u8],
            delta_nanousd: i64,
            reference: &str,
        ) -> Result<(), DbError> {
            self.credits.lock().unwrap().push((
                pubkey.to_vec(),
                delta_nanousd,
                reference.to_string(),
            ));
            Ok(())
        }
    }

    #[test]
    fn rejects_an_amount_below_the_minimum() {
        assert_eq!(
            validate_initialize(&init_request(MIN_TOPUP_CENTS - 1)).unwrap_err(),
            "amount_too_small"
        );
    }

    #[test]
    fn accepts_exactly_the_minimum() {
        assert!(validate_initialize(&init_request(MIN_TOPUP_CENTS)).is_ok());
    }

    #[test]
    fn rejects_a_zero_or_negative_amount_as_below_the_minimum() {
        assert_eq!(
            validate_initialize(&init_request(0)).unwrap_err(),
            "amount_too_small"
        );
        assert_eq!(
            validate_initialize(&init_request(-500)).unwrap_err(),
            "amount_too_small"
        );
    }

    #[test]
    fn rejects_an_amount_that_would_overflow_nano_usd() {
        assert_eq!(
            validate_initialize(&init_request(i64::MAX)).unwrap_err(),
            "amount_too_large"
        );
    }

    #[test]
    fn rejects_an_implausible_email() {
        let mut request = init_request(500);
        request.email = "founder".into();
        assert_eq!(validate_initialize(&request).unwrap_err(), "invalid_email");
    }

    #[tokio::test]
    async fn initialize_writes_the_intent_before_asking_paystack() {
        let store = FakeStore::new(community());
        let paystack = FakePaystack::default();
        let tenant = tenant_of(store.community);
        let key = signer();

        let response =
            ok_value(initialize_payment(&store, &paystack, &tenant, key, &init_request(500)).await);

        let reference = response
            .get("reference")
            .and_then(Value::as_str)
            .expect("reference in response")
            .to_string();
        assert_eq!(
            response.get("authorizationUrl").and_then(Value::as_str),
            Some(paystack.url_for(&reference).as_str())
        );

        let stored = store.get(&reference).expect("intent stored");
        assert_eq!(stored.pubkey, key.to_vec());
        assert_eq!(stored.usd_cents, 500);
        assert_eq!(stored.status, "pending");
        assert_eq!(paystack.calls.lock().unwrap().len(), 1, "one checkout call");
    }

    #[tokio::test]
    async fn initialize_sends_the_normalised_email_and_amount_to_paystack() {
        let store = FakeStore::new(community());
        let paystack = FakePaystack::default();
        let mut request = init_request(1200);
        request.email = "Founder@Example.COM".into();

        let _response = initialize_payment(
            &store,
            &paystack,
            &tenant_of(store.community),
            signer(),
            &request,
        )
        .await
        .expect("initialize succeeds");

        let calls = paystack.calls.lock().unwrap();
        assert_eq!(calls[0].0, 1200, "cents pass through unchanged");
        assert_eq!(calls[0].1, "founder@example.com");
    }

    #[tokio::test]
    async fn a_paystack_failure_is_typed_not_prose() {
        let store = FakeStore::new(community());

        let result = initialize_payment(
            &store,
            &FakePaystack::failing(),
            &tenant_of(store.community),
            signer(),
            &init_request(500),
        )
        .await;

        assert_typed_error(
            &result,
            StatusCode::SERVICE_UNAVAILABLE,
            "payment_unavailable",
        );
    }

    #[tokio::test]
    async fn verify_reports_unpaid_while_pending() {
        let store = FakeStore::new(community());
        let key = signer();
        store.insert_pending("ref-1", key, 500);

        let response = ok_value(
            verify_payment(
                &store,
                &tenant_of(store.community),
                key,
                &VerifyRequest {
                    reference: "ref-1".into(),
                },
            )
            .await,
        );

        assert_eq!(response.get("paid"), Some(&Value::Bool(false)));
        assert_eq!(response.get("usdCents"), Some(&Value::from(500)));
    }

    #[tokio::test]
    async fn verify_reports_paid_with_what_was_actually_paid() {
        let store = FakeStore::new(community());
        let key = signer();
        // The provider collected more than we asked for; verify reports what
        // was paid, not what we hoped for.
        store.intents.lock().unwrap().insert(
            "ref-1".into(),
            PaymentIntent {
                reference: "ref-1".into(),
                pubkey: key.to_vec(),
                usd_cents: 500,
                status: "paid".into(),
                paid_cents: Some(700),
            },
        );

        let response = ok_value(
            verify_payment(
                &store,
                &tenant_of(store.community),
                key,
                &VerifyRequest {
                    reference: "ref-1".into(),
                },
            )
            .await,
        );

        assert_eq!(response.get("paid"), Some(&Value::Bool(true)));
        assert_eq!(response.get("usdCents"), Some(&Value::from(700)));
    }

    #[tokio::test]
    async fn verify_never_touches_the_ledger() {
        let store = FakeStore::new(community());
        let key = signer();
        store.insert_pending("ref-1", key, 500);

        let response = ok_value(
            verify_payment(
                &store,
                &tenant_of(store.community),
                key,
                &VerifyRequest {
                    reference: "ref-1".into(),
                },
            )
            .await,
        );
        assert_eq!(response.get("paid"), Some(&Value::Bool(false)));

        assert!(
            store.credit_calls().is_empty(),
            "a client-callable read must never credit"
        );
        assert_eq!(
            store.settle_calls.load(Ordering::SeqCst),
            0,
            "a client-callable read must never settle"
        );
    }

    #[tokio::test]
    async fn another_members_reference_reads_as_unknown() {
        let store = FakeStore::new(community());
        store.insert_pending("ref-1", signer(), 500);

        let result = verify_payment(
            &store,
            &tenant_of(store.community),
            signer(),
            &VerifyRequest {
                reference: "ref-1".into(),
            },
        )
        .await;

        assert_typed_error(&result, StatusCode::NOT_FOUND, "unknown_reference");
    }

    #[tokio::test]
    async fn another_communitys_reference_reads_as_unknown() {
        let store = FakeStore::new(community());
        let key = signer();
        store.insert_pending("ref-1", key, 500);

        let elsewhere = community();
        let result = verify_payment(
            &store,
            &tenant_of(elsewhere),
            key,
            &VerifyRequest {
                reference: "ref-1".into(),
            },
        )
        .await;

        assert_typed_error(&result, StatusCode::NOT_FOUND, "unknown_reference");
    }

    #[tokio::test]
    async fn balance_converts_nano_usd_to_cents() {
        let key = signer();
        let store = FakeStore::new(community()).with_balance(key, 5_000_000_000);

        let response = ok_value(balance_payment(&store, key).await);

        assert_eq!(response.get("usdCents"), Some(&Value::from(500)));
    }

    #[tokio::test]
    async fn balance_truncates_an_overdraft_toward_zero() {
        let key = signer();
        let store = FakeStore::new(community()).with_balance(key, -15_000_000);

        let response = ok_value(balance_payment(&store, key).await);

        assert_eq!(response.get("usdCents"), Some(&Value::from(-1)));
    }

    #[test]
    fn a_spent_pubkey_window_reports_retry_and_blocks() {
        let cache = moka::sync::Cache::builder().build();
        let key = (community(), signer());
        for _ in 0..3 {
            assert!(charge_pubkey_window(&cache, key, 3).is_none());
        }
        let retry =
            charge_pubkey_window(&cache, key, 3).expect("the fourth attempt must be blocked");
        assert!(retry > 0 && retry <= RATE_WINDOW_SECS, "got {retry}");
    }
}
