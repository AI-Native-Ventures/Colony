//! Hiring: turning a community owner's request into a workspace employee.
//!
//! An employee is a role the company employs, not a process a member runs. The
//! relay mints and holds its keypair so every member can produce work as one
//! colleague without a private key being copied between laptops
//! (`docs/design/company-employees.html`).
//!
//! This runs as a side effect, which the ingest path treats as best effort: it
//! may run more than once for the same request and its errors are logged, not
//! returned to the client. Both properties are designed for rather than
//! tolerated. Hiring is keyed on the request event, so a repeat run recognises
//! its own prior work and re-publishes the head instead of minting a second
//! identity for one role.

use std::sync::Arc;

use buzz_core::employee::{parse_hire_request, ParsedHireRequest};
use buzz_core::kind::KIND_EMPLOYEE;
use buzz_core::tenant::TenantContext;
use nostr::{Event, EventBuilder, Keys, Kind, Tag};
use tracing::{info, warn};

use crate::employee_key::EmployeeKeyError;
use crate::state::AppState;
use buzz_pubsub::EventTopic;

/// What hiring did, so the caller can log one line that says which.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HireOutcome {
    /// A new employee was minted and its head published.
    Hired,
    /// This request had already produced an employee; the head was
    /// re-published so a lost fan-out heals.
    AlreadyHired,
    /// The role is already filled by a different employee.
    RoleTaken,
}

/// Hire an employee for `event`, an owner's hire request.
///
/// Refuses rather than guesses when the signer is not a community owner, when
/// no sealing key is configured, or when the request is malformed: an employee
/// nobody authorized is worse than a hire that did not happen.
pub async fn handle_hire_request(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
) -> Result<HireOutcome, String> {
    let request =
        parse_hire_request(event).map_err(|error| format!("invalid hire request: {error}"))?;

    // Only a community owner may add to the payroll. Checked against the
    // relay's own membership table rather than anything in the event, so a
    // forged tag cannot promote its author.
    let signer_hex = event.pubkey.to_hex();
    let is_owner = state
        .db
        .get_relay_member(tenant.community(), &signer_hex)
        .await
        .map_err(|error| format!("database error checking hire authority: {error}"))?
        .is_some_and(|member| member.role == "owner");
    if !is_owner {
        return Err(format!(
            "hire refused: {signer_hex} is not an owner of this community"
        ));
    }

    let sealer = state
        .employee_key_sealer
        .as_ref()
        .ok_or_else(|| EmployeeKeyError::NotConfigured.to_string())?;

    let hire_event_bytes = event.id.as_bytes().to_vec();

    // Idempotence: a re-run finds its own prior employee and republishes the
    // head rather than minting a second identity for the same request.
    if let Some(existing) = state
        .db
        .find_employee_by_hire_event(tenant.community(), &hire_event_bytes)
        .await
        .map_err(|error| format!("database error looking up prior hire: {error}"))?
    {
        let keys = open_employee_keys(state, tenant, &existing.pubkey, &existing.sealed_key)?;
        publish_employee_head(tenant, state, &keys, &request, &signer_hex, event).await;
        return Ok(HireOutcome::AlreadyHired);
    }

    // Mint independently of the relay's own keypair. Deriving from it would
    // make every dev install share employee identities, because the dev relay
    // key is a repo constant.
    let keys = Keys::generate();
    let pubkey_bytes = keys.public_key().to_bytes().to_vec();
    let secret: [u8; 32] = keys.secret_key().to_secret_bytes();
    let employee_pubkey: [u8; 32] = keys.public_key().to_bytes();
    let sealed = sealer
        .seal(*tenant.community().as_uuid(), &employee_pubkey, &secret)
        .map_err(|error| format!("could not seal the employee key: {error}"))?;

    let inserted = state
        .db
        .insert_employee(
            tenant.community(),
            buzz_db::employees::NewEmployee {
                pubkey: &pubkey_bytes,
                sealed_key: &sealed,
                role_id: &request.role_id,
                display_name: &request.display_name,
                rank: request.rank.as_str(),
                hired_by: &event.pubkey.to_bytes(),
                hire_event: &hire_event_bytes,
            },
        )
        .await
        .map_err(|error| format!("database error recording the hire: {error}"))?;

    // `None` means a unique index refused the row. The hire-event index is
    // handled above, so reaching here means the role is already filled.
    let Some(_row) = inserted else {
        return Ok(HireOutcome::RoleTaken);
    };

    publish_employee_head(tenant, state, &keys, &request, &signer_hex, event).await;
    info!(
        role = %request.role_id,
        employee = %keys.public_key().to_hex(),
        "employee hired"
    );
    Ok(HireOutcome::Hired)
}

/// Re-derive an employee's signing keys from its sealed column.
///
/// The only way to speak as an employee. `job_broker` uses it to sign job
/// heads, which is why an employee-signed event is in practice a relay-signed
/// one: nobody else can open the seal.
pub(crate) fn open_employee_keys(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    pubkey: &[u8],
    sealed_key: &[u8],
) -> Result<Keys, String> {
    let sealer = state
        .employee_key_sealer
        .as_ref()
        .ok_or_else(|| EmployeeKeyError::NotConfigured.to_string())?;
    let employee_pubkey: [u8; 32] = pubkey
        .try_into()
        .map_err(|_| "stored employee pubkey is not 32 bytes".to_string())?;
    let secret = sealer
        .open(*tenant.community().as_uuid(), &employee_pubkey, sealed_key)
        .map_err(|error| format!("could not open the employee key: {error}"))?;
    Keys::parse(&hex::encode(secret.as_slice()))
        .map_err(|error| format!("stored employee key is unusable: {error}"))
}

/// Publish the employee head, signed by the employee itself.
///
/// Relay-authored events bypass ingest, so this takes on ordinary storage's
/// job: insert, then fan out. Both are best effort and logged, because the
/// durable record of employment is the row plus the owner-signed request, not
/// this head; a lost head is re-published by the next run.
async fn publish_employee_head(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    keys: &Keys,
    request: &ParsedHireRequest,
    hired_by_hex: &str,
    hire_event: &Event,
) {
    let tags = [
        Tag::parse(["d", &keys.public_key().to_hex()]),
        Tag::parse(["role", &request.role_id]),
        Tag::parse(["name", &request.display_name]),
        Tag::parse(["rank", request.rank.as_str()]),
        Tag::parse(["hired-by", hired_by_hex]),
        Tag::parse(["e", &hire_event.id.to_hex()]),
    ];
    let tags = match tags.into_iter().collect::<Result<Vec<_>, _>>() {
        Ok(tags) => tags,
        Err(error) => {
            warn!(error = %error, "employee head tags could not be built");
            return;
        }
    };

    let event = match EventBuilder::new(Kind::Custom(KIND_EMPLOYEE as u16), "")
        .tags(tags)
        .sign_with_keys(keys)
    {
        Ok(event) => event,
        Err(error) => {
            warn!(error = %error, "employee head could not be signed");
            return;
        }
    };

    if let Err(error) = state
        .db
        .insert_event(tenant.community(), &event, None)
        .await
    {
        warn!(error = %error, "employee head insert failed");
    }
    if let Err(error) = state
        .pubsub
        .publish_event(tenant, EventTopic::Global, &event)
        .await
    {
        warn!(error = %error, "employee head fan-out failed");
    }
}
