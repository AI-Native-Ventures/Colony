//! Colony Credits gateway: provisioned-mode token storage and the model
//! allowlist.
//!
//! `gateway_tokens` holds the SHA-256 hash of each Colony gateway token,
//! bound to the account pubkey it debits, with an expiry and a revocation
//! marker. The raw token is minted and shown once by the relay; only the
//! hash ever reaches the database, so a leaked dump of this table cannot be
//! replayed. `model_catalog` is the deployment-global allowlist mapping a
//! Colony model id to its Vercel AI Gateway slug, with a display price that
//! is an estimate only — the catalog never drives a debit.

use crate::error::Result;
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};

/// One row of `gateway_tokens`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayToken {
    /// Account pubkey (32 raw bytes) the token debits.
    pub pubkey: Vec<u8>,
    /// Token expiry (UTC). Expired tokens are rejected at auth.
    pub expires_at: DateTime<Utc>,
    /// `session` or `provisioned` — what kind of session minted it.
    pub session_scope: String,
    /// When the token was revoked, if it was. `None` means still live.
    pub revoked_at: Option<DateTime<Utc>>,
}

/// One row of `model_catalog`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogModel {
    /// Colony-facing model id the gateway accepts on requests.
    pub model_id: String,
    /// Vercel AI Gateway slug the request is translated to.
    pub vercel_slug: String,
    /// Whether the gateway admits this model right now.
    pub enabled: bool,
    /// Pre-call display estimate in nanoUSD — never the basis of a debit.
    pub display_price_nanousd: i64,
}

/// Look up a token by its SHA-256 hash.
///
/// Returns `None` for an unknown hash. Liveness (expiry, revocation) is the
/// caller's decision — the row is returned with its markers so the caller
/// can distinguish "unknown" from "known but dead" without an extra query.
pub async fn token_by_hash(pool: &PgPool, token_hash: &[u8]) -> Result<Option<GatewayToken>> {
    let row = sqlx::query(
        "SELECT pubkey, expires_at, session_scope, revoked_at \
         FROM gateway_tokens WHERE token_hash = $1",
    )
    .bind(token_hash)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    Ok(Some(GatewayToken {
        pubkey: row.try_get("pubkey")?,
        expires_at: row.try_get("expires_at")?,
        session_scope: row.try_get("session_scope")?,
        revoked_at: row.try_get("revoked_at")?,
    }))
}

/// Insert a token hash bound to `pubkey`, expiring `ttl` from now.
///
/// Scope is the caller's choice (`session` or `provisioned`); the gateway
/// accepts either while live. A duplicate hash fails the primary key, which
/// is unreachable for a well-minted token (hashes are 32 random bytes) and
/// loud if it ever happens.
pub async fn insert_token(
    pool: &PgPool,
    token_hash: &[u8],
    pubkey: &[u8],
    ttl: std::time::Duration,
    session_scope: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO gateway_tokens (token_hash, pubkey, expires_at, session_scope) \
         VALUES ($1, $2, now() + make_interval(secs => $3), $4)",
    )
    .bind(token_hash)
    .bind(pubkey)
    .bind(ttl.as_secs_f64())
    .bind(session_scope)
    .execute(pool)
    .await?;
    Ok(())
}

/// Revoke a live token by hash. Returns whether a live token was revoked.
///
/// Revoking an already-revoked or unknown token is a no-op that reports
/// false, so a replay of a revoke request cannot error.
pub async fn revoke_token(pool: &PgPool, token_hash: &[u8]) -> Result<bool> {
    let result = sqlx::query(
        "UPDATE gateway_tokens SET revoked_at = now() \
         WHERE token_hash = $1 AND revoked_at IS NULL",
    )
    .bind(token_hash)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// Every enabled model in the catalog, in `model_id` order.
pub async fn enabled_models(pool: &PgPool) -> Result<Vec<CatalogModel>> {
    let rows = sqlx::query(
        "SELECT model_id, vercel_slug, enabled, display_price_nanousd \
         FROM model_catalog WHERE enabled ORDER BY model_id",
    )
    .fetch_all(pool)
    .await?;
    let mut models = Vec::with_capacity(rows.len());
    for row in rows {
        models.push(CatalogModel {
            model_id: row.try_get("model_id")?,
            vercel_slug: row.try_get("vercel_slug")?,
            enabled: row.try_get("enabled")?,
            display_price_nanousd: row.try_get("display_price_nanousd")?,
        });
    }
    Ok(models)
}

/// Look up one catalog row by Colony model id.
pub async fn model_by_id(pool: &PgPool, model_id: &str) -> Result<Option<CatalogModel>> {
    let row = sqlx::query(
        "SELECT model_id, vercel_slug, enabled, display_price_nanousd \
         FROM model_catalog WHERE model_id = $1",
    )
    .bind(model_id)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    Ok(Some(CatalogModel {
        model_id: row.try_get("model_id")?,
        vercel_slug: row.try_get("vercel_slug")?,
        enabled: row.try_get("enabled")?,
        display_price_nanousd: row.try_get("display_price_nanousd")?,
    }))
}
