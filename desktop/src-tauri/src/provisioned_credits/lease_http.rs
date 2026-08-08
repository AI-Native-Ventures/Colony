fn deduplicate_leases(leases: &mut Vec<GatewayLease>) {
    let mut unique = Vec::with_capacity(leases.len());
    for lease in leases.drain(..) {
        if !unique
            .iter()
            .any(|existing: &GatewayLease| existing.token == lease.token)
        {
            unique.push(lease);
        }
    }
    *leases = unique;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GatewayHttpErrorKind {
    Unauthorized,
    Depleted,
    NotFound,
}

fn gateway_http_error(status: reqwest::StatusCode) -> Result<(), GatewayHttpErrorKind> {
    match status {
        reqwest::StatusCode::UNAUTHORIZED => Err(GatewayHttpErrorKind::Unauthorized),
        reqwest::StatusCode::PAYMENT_REQUIRED => Err(GatewayHttpErrorKind::Depleted),
        reqwest::StatusCode::NOT_FOUND => Err(GatewayHttpErrorKind::NotFound),
        _ => Ok(()),
    }
}

fn stable_http_error(kind: GatewayHttpErrorKind) -> String {
    match kind {
        GatewayHttpErrorKind::Unauthorized => {
            "Colony Credits gateway authorization expired — reconnect".to_string()
        }
        GatewayHttpErrorKind::Depleted => {
            "Colony Credits depleted — top up, then reconnect".to_string()
        }
        GatewayHttpErrorKind::NotFound => {
            "Colony Credits gateway is unavailable on this relay".to_string()
        }
    }
}

fn blocking_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("gateway client setup failed: {error}"))
}

fn capture_owner_signer(
    app: &AppHandle,
    explicit: Option<&str>,
) -> Result<(String, Arc<Keys>), String> {
    let state = app.state::<AppState>();
    let keys = Arc::new(state.signing_keys()?);
    let owner = keys.public_key().to_hex();
    if let Some(explicit) = explicit.map(str::trim).filter(|owner| !owner.is_empty()) {
        if !owner.eq_ignore_ascii_case(explicit) {
            return Err("Colony Credits owner does not match the active identity".to_string());
        }
    }
    Ok((owner, keys))
}

fn mint_lease(
    _app: &AppHandle,
    key: GatewayLeaseKey,
    generation: u64,
    signer: Arc<Keys>,
) -> Result<GatewayLease, String> {
    mint_lease_with_client(&blocking_client()?, key, generation, signer)
}

fn mint_lease_with_client(
    client: &reqwest::blocking::Client,
    key: GatewayLeaseKey,
    generation: u64,
    signer: Arc<Keys>,
) -> Result<GatewayLease, String> {
    if !signer
        .public_key()
        .to_hex()
        .eq_ignore_ascii_case(&key.owner_pubkey)
    {
        return Err("Colony Credits lease signer does not match its owner".to_string());
    }
    let url = format!("{}/api/gateway/tokens", key.relay_origin);
    let body = serde_json::to_vec(&serde_json::json!({
        "ttl_secs": GATEWAY_TOKEN_TTL_SECS,
    }))
    .map_err(|error| format!("gateway request serialization failed: {error}"))?;
    let auth = build_nip98_auth_header_for_keys(&signer, &Method::POST, &url, &body)?;
    let response = client
        .post(&url)
        .header("Authorization", auth)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .map_err(|error| format!("gateway unreachable: {error}"))?;
    let status = response.status();
    if let Err(kind) = gateway_http_error(status) {
        return Err(stable_http_error(kind));
    }
    if !status.is_success() {
        return Err(format!("gateway returned HTTP {status}"));
    }
    let payload = response
        .json::<MintTokenResponse>()
        .map_err(|_| "gateway returned malformed token response".to_string())?;
    validate_lease_expiry(payload.expires_at)?;
    let issued_at = Utc::now();
    let token = RedactedToken::new(payload.token)?;
    Ok(GatewayLease {
        key,
        token,
        generation,
        expires_at: payload.expires_at,
        refresh_at: lease_refresh_at(issued_at, payload.expires_at),
        signer,
    })
}

#[derive(Deserialize)]
struct MintTokenResponse {
    token: String,
    expires_at: DateTime<Utc>,
}

fn validate_lease_expiry(expires_at: DateTime<Utc>) -> Result<(), String> {
    let now = Utc::now();
    if expires_at <= now {
        return Err("gateway returned an expired token".to_string());
    }
    let max = now + chrono::Duration::seconds(GATEWAY_TOKEN_TTL_SECS as i64);
    if expires_at > max + chrono::Duration::seconds(5) {
        return Err("gateway returned a token longer than the desktop lease bound".to_string());
    }
    Ok(())
}

fn lease_refresh_at(issued_at: DateTime<Utc>, expires_at: DateTime<Utc>) -> DateTime<Utc> {
    let t_minus_lead = expires_at - chrono::Duration::seconds(GATEWAY_REFRESH_LEAD_SECS);
    if t_minus_lead > issued_at {
        return t_minus_lead;
    }
    // Phase 1 leases are bounded to 24h, so `expires_at - 24h` would be at or
    // before mint time and cause an immediate refresh loop. Refresh at the
    // midpoint instead; an overdue lease is rotated immediately on ensure.
    let lifetime_secs = (expires_at - issued_at).num_seconds().max(1);
    issued_at + chrono::Duration::seconds(lifetime_secs / 2)
}

fn revoke_lease(_app: &AppHandle, lease: &GatewayLease) -> Result<(), String> {
    revoke_lease_with_client(&blocking_client()?, lease)
}

fn revoke_lease_with_client(
    client: &reqwest::blocking::Client,
    lease: &GatewayLease,
) -> Result<(), String> {
    if !lease
        .signer
        .public_key()
        .to_hex()
        .eq_ignore_ascii_case(&lease.key.owner_pubkey)
    {
        return Err("Colony Credits lease signer does not match its owner".to_string());
    }
    let url = format!("{}/api/gateway/tokens", lease.key.relay_origin);
    let body = serde_json::to_vec(&serde_json::json!({"token": lease.token.as_str()}))
        .map_err(|error| format!("gateway request serialization failed: {error}"))?;
    let auth = build_nip98_auth_header_for_keys(&lease.signer, &Method::DELETE, &url, &body)?;
    let response = client
        .delete(&url)
        .header("Authorization", auth)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .map_err(|error| format!("gateway unreachable: {error}"))?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::NO_CONTENT {
        return Ok(());
    }
    if let Err(kind) = gateway_http_error(status) {
        return Err(stable_http_error(kind));
    }
    if !status.is_success() {
        return Err(format!("gateway returned HTTP {status}"));
    }
    Ok(())
}
