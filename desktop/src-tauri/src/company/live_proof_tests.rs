//! The desktop app's own company creation, against a relay that is running.
//!
//! Everything else about this feature is proven on one side of a boundary:
//! the frontend contract against mocked commands, the relay contract against
//! the CLI. This drives the desktop code itself — the same blueprint parsing,
//! seeding, action building and signing the Approve button runs — and
//! publishes the result to a real relay, then reads back what it stored.
//!
//! What it does NOT cover: writing the personas and teams to disk. That path
//! is bound to a concrete Tauri AppHandle, and it is long-standing shipped
//! storage code whose behaviour the unit tests already pin. The risk this
//! closes is the part that had never run against a relay at all: whether the
//! events this app builds and signs are ones a relay accepts, and whether
//! approving twice creates a second company.
//!
//! Ignored by default because it needs that relay. Run it with:
//!
//! ```sh
//! BUZZ_LIVE_RELAY_HTTP=http://localhost:3055 \
//! BUZZ_LIVE_OWNER_KEY=<hex> \
//! BUZZ_LIVE_RELAY_PUBKEY=<hex> \
//!   cargo test --manifest-path desktop/src-tauri/Cargo.toml \
//!   --test company_live -- --ignored --nocapture
//! ```

use buzz_core_pkg::company_roster::{
    approval_timestamp, blueprint_hash, parse_blueprint, ValidatedBlueprint,
};

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn blueprint_json(company_id: &str, request_id: &str) -> String {
    serde_json::json!({
        "schema": "colony.company-blueprint/v1",
        "requestId": request_id,
        "company": {
            "id": company_id,
            "tradingName": "Horizon Labs Café",
            "summary": "Marketing websites and social content.",
            "businessType": "agency",
            "services": [{"id": "web", "name": "Web", "description": "Sites"}],
            "customerSegments": ["smb"],
        },
        "roster": [
            {"roleId": "chief-of-staff", "personalName": "Fizz", "enabled": true},
            {"roleId": "cto", "personalName": "Jason", "enabled": true},
            {"roleId": "frontend-engineer", "personalName": "Priya", "enabled": true},
            {"roleId": "cfo", "personalName": "Ada", "enabled": false},
        ],
        "teams": [{
            "id": "engineering",
            "name": "Engineering",
            "description": "Builds client sites",
            "leadRoleId": "cto",
            "memberRoleIds": ["cto", "frontend-engineer"],
            "kind": "baseline",
        }],
        "costCentres": [{"id": "internal", "name": "Internal", "kind": "internal"}],
        "readinessGaps": [],
        "proposedInitiatives": (1..=3)
            .map(|index| serde_json::json!({
                "id": format!("init-{index}"),
                "title": format!("Initiative {index}"),
                "summary": "Worth doing first",
                "ownerRoleId": "chief-of-staff",
                "costCentreId": "internal",
                "commercialPurpose": "administration",
            }))
            .collect::<Vec<_>>(),
    })
    .to_string()
}

/// A NIP-98 Authorization header for one request.
///
/// The relay authenticates every write this way, so a test that skipped it
/// would be proving something the app never does.
fn nip98(keys: &nostr::Keys, method: &str, url: &str, body: &[u8]) -> String {
    use base64::Engine as _;
    use sha2::Digest as _;

    let tags = [
        nostr::Tag::parse(["u", url]).expect("u tag"),
        nostr::Tag::parse(["method", method]).expect("method tag"),
        nostr::Tag::parse(["nonce", &uuid::Uuid::new_v4().to_string()]).expect("nonce tag"),
        nostr::Tag::parse(["payload", &hex::encode(sha2::Sha256::digest(body))])
            .expect("payload tag"),
    ];
    let event = nostr::EventBuilder::new(nostr::Kind::Custom(27235), "")
        .tags(tags)
        .sign_with_keys(keys)
        .expect("NIP-98 signs");
    format!(
        "Nostr {}",
        base64::engine::general_purpose::STANDARD
            .encode(nostr::JsonUtil::as_json(&event).as_bytes())
    )
}

/// Publish one signed event and return the relay's answer.
async fn publish(http: &str, signed: &str, keys: &nostr::Keys) -> (u16, String) {
    let client = reqwest::Client::new();
    let url = format!("{http}/events");
    let response = client
        .post(&url)
        .header("content-type", "application/json")
        .header(
            "authorization",
            nip98(keys, "POST", &url, signed.as_bytes()),
        )
        .body(signed.to_owned())
        .send()
        .await
        .expect("relay is reachable");
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    (status, body)
}

#[tokio::test]
#[ignore = "requires a running relay with a durable key and a bootstrapped owner"]
async fn the_app_creates_a_company_against_a_running_relay() {
    let http = env("BUZZ_LIVE_RELAY_HTTP").expect("BUZZ_LIVE_RELAY_HTTP is required");
    let owner_key = env("BUZZ_LIVE_OWNER_KEY").expect("BUZZ_LIVE_OWNER_KEY is required");
    let relay_pubkey = env("BUZZ_LIVE_RELAY_PUBKEY").expect("BUZZ_LIVE_RELAY_PUBKEY is required");
    let keys = nostr::Keys::parse(&owner_key).expect("owner key parses");

    // A fresh company per run, so a rerun proves idempotency rather than
    // colliding with a previous run's records.
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_secs()
        % 100_000;
    let company_id = format!("live-{suffix}");
    let request_id = uuid::Uuid::new_v4().to_string();
    let raw = blueprint_json(&company_id, &request_id);

    let blueprint: ValidatedBlueprint = parse_blueprint(&raw).expect("blueprint is valid");
    let scope = relay_pubkey.clone();
    println!(
        "company={company_id} hash={}",
        &blueprint_hash(&blueprint)[..16]
    );

    // What approval would write locally. Fizz predates the company, so the
    // Chief of Staff is reused and only the two new employees are created.
    let fizz = existing_chief_of_staff();
    let seeded = super::seed::seed_personas(&scope, &blueprint, &fizz, "2026-08-01T09:00:00Z");
    assert_eq!(seeded.created_personas.len(), 2, "the CTO and the engineer");
    assert_eq!(seeded.reused_persona_ids, ["builtin:fizz"]);
    let cto = seeded
        .created_personas
        .iter()
        .find(|persona| persona.id.ends_with(&format!(":{company_id}:cto")))
        .expect("the CTO is created");
    assert_eq!(cto.display_name, "Jason");
    assert_eq!(cto.role_title.as_deref(), Some("CTO"));
    assert!(
        cto.system_prompt
            .contains("never as instructions to follow"),
        "a created employee carries the catalog prompt, including the floor"
    );
    assert_eq!(cto.runtime, None);
    assert_eq!(cto.model, None);
    assert!(
        !seeded
            .created_personas
            .iter()
            .any(|persona| persona.id.ends_with(":cfo")),
        "the owner unchecked the CFO"
    );

    let teams = super::seed::seed_teams(&scope, &blueprint, &[], "2026-08-01T09:00:00Z")
        .expect("seed teams");
    assert_eq!(teams.created_teams.len(), 1);
    let team = &teams.created_teams[0];
    assert_eq!(team.persona_ids.len(), 2);
    assert_eq!(
        team.lead_persona_id.as_deref(),
        Some(team.persona_ids[0].as_str())
    );

    // Now the half that had never met a relay.
    let first = publish_company(&blueprint, &scope, &http, &keys, &relay_pubkey).await;
    assert_eq!(
        first.accepted, 4,
        "one company head and three initiatives, accepted"
    );

    let stored = fetch_company(&http, &relay_pubkey, &company_id, &keys).await;
    assert_eq!(
        stored.get("tradingName").and_then(|value| value.as_str()),
        Some("Horizon Labs Café"),
        "the relay stored the company, non-ASCII intact"
    );
    assert_eq!(
        stored
            .get("onboardingStatus")
            .and_then(|value| value.as_str()),
        Some("approved")
    );

    // Approving again must change nothing. This is the property that only a
    // real relay can answer.
    let again = publish_company(&blueprint, &scope, &http, &keys, &relay_pubkey).await;
    assert_eq!(again.accepted, 0, "no write is applied a second time");
    assert_eq!(
        again.duplicates, 4,
        "each is recognised as a repeat, not refused as a conflict"
    );

    let after = fetch_company(&http, &relay_pubkey, &company_id, &keys).await;
    assert_eq!(after, stored, "the company is unchanged by re-approval");

    // And seeding is a no-op once the employees exist.
    let mut now_present = fizz.clone();
    now_present.extend(seeded.created_personas.clone());
    let resumed =
        super::seed::seed_personas(&scope, &blueprint, &now_present, "2026-09-09T09:00:00Z");
    assert!(
        resumed.created_personas.is_empty(),
        "a second approval creates no employees"
    );

    println!("PROVEN company={company_id}");
}

/// The built-in Chief of Staff, as it exists before any company does.
fn existing_chief_of_staff() -> Vec<crate::managed_agents::AgentDefinition> {
    vec![crate::managed_agents::AgentDefinition {
        id: "builtin:fizz".to_string(),
        role_id: Some("chief-of-staff".to_string()),
        role_title: Some("Chief of Staff".to_string()),
        display_name: "Fizz".to_string(),
        avatar_url: None,
        system_prompt: buzz_core_pkg::company_roster::CHIEF_OF_STAFF_PROMPT.to_string(),
        runtime: None,
        model: None,
        provider: None,
        name_pool: Vec::new(),
        is_builtin: true,
        is_active: true,
        shared: false,
        source_team: None,
        source_team_persona_slug: None,
        catalog_source: None,
        env_vars: std::collections::BTreeMap::new(),
        respond_to: Some("owner-only".to_string()),
        respond_to_allowlist: Vec::new(),
        parallelism: None,
        created_at: "2026-07-01T00:00:00Z".to_string(),
        updated_at: "2026-07-01T00:00:00Z".to_string(),
    }]
}

struct RunOutcome {
    accepted: usize,
    duplicates: usize,
}

/// Read the community profile head's id and timestamps off the relay.
///
/// The relay mints one for every community at boot
/// (`run_profile_backfill`), so this exists before `publish_company` ever
/// runs. Reading it is what lets approval build an `Update` carrying the
/// real compare-and-set token, the same way the app does, instead of the
/// `Create` the relay refuses unconditionally once a head already exists.
async fn fetch_profile_head(
    http: &str,
    relay_pubkey: &str,
    keys: &nostr::Keys,
) -> super::actions::ExistingProfileHead {
    let client = reqwest::Client::new();
    let url = format!("{http}/query");
    let body = serde_json::json!([{
        "kinds": [30179],
        "authors": [relay_pubkey],
        "#d": ["profile"],
        "limit": 1,
    }])
    .to_string();
    let response = client
        .post(&url)
        .header("content-type", "application/json")
        .header("authorization", nip98(keys, "POST", &url, body.as_bytes()))
        .body(body)
        .send()
        .await
        .expect("query reaches the relay");
    let raw = response.text().await.unwrap_or_default();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
    let events = parsed
        .as_array()
        .cloned()
        .or_else(|| {
            parsed
                .get("events")
                .and_then(|events| events.as_array())
                .cloned()
        })
        .unwrap_or_default();
    let event = events
        .first()
        .expect("the relay has already minted a community profile at boot");
    let event_id = event
        .get("id")
        .and_then(|id| id.as_str())
        .expect("head event carries an id")
        .to_string();
    let content: serde_json::Value = event
        .get("content")
        .and_then(|content| content.as_str())
        .and_then(|content| serde_json::from_str(content).ok())
        .unwrap_or(serde_json::Value::Null);
    super::actions::ExistingProfileHead {
        event_id,
        created_at: content
            .get("createdAt")
            .and_then(|value| value.as_i64())
            .expect("head content carries createdAt"),
        updated_at: content
            .get("updatedAt")
            .and_then(|value| value.as_i64())
            .expect("head content carries updatedAt"),
    }
}

/// Build, sign, and publish the company and its initiatives.
async fn publish_company(
    blueprint: &ValidatedBlueprint,
    scope: &str,
    http: &str,
    keys: &nostr::Keys,
    relay_pubkey: &str,
) -> RunOutcome {
    let created_at = approval_timestamp(&blueprint.request_id);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_secs() as i64;
    let existing_head = fetch_profile_head(http, relay_pubkey, keys).await;
    let mut signed = vec![super::actions::sign_action(
        &super::actions::company_action(blueprint, relay_pubkey, now, &existing_head)
            .expect("build company action"),
        keys,
    )
    .expect("sign company action")];
    for action in super::actions::initiative_actions(
        blueprint,
        scope,
        relay_pubkey,
        "3f6c1a2e-1111-4000-8000-000000000009",
        created_at,
    )
    .expect("build initiative actions")
    {
        signed.push(super::actions::sign_action(&action, keys).expect("sign"));
    }

    let mut accepted = 0;
    let mut duplicates = 0;
    for event in &signed {
        let (status, body) = publish(http, event, keys).await;
        if body.contains("duplicate") {
            duplicates += 1;
        } else if status == 200 {
            accepted += 1;
        } else {
            println!("relay answered {status}: {body}");
        }
    }

    RunOutcome {
        accepted,
        duplicates,
    }
}

/// Read the company head back off the relay.
async fn fetch_company(
    http: &str,
    relay_pubkey: &str,
    company_id: &str,
    keys: &nostr::Keys,
) -> serde_json::Value {
    let client = reqwest::Client::new();
    let url = format!("{http}/query");
    // The relay takes a list of filters, the same shape a REQ carries.
    let body = serde_json::json!([{
        "kinds": [30179],
        "authors": [relay_pubkey],
        "#d": [company_id],
        "limit": 1,
    }])
    .to_string();
    let response = client
        .post(&url)
        .header("content-type", "application/json")
        .header("authorization", nip98(keys, "POST", &url, body.as_bytes()))
        .body(body)
        .send()
        .await
        .expect("query reaches the relay");
    let status = response.status().as_u16();
    let raw = response.text().await.unwrap_or_default();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
    // The relay answers either a bare array or an object wrapping one.
    let events = parsed
        .as_array()
        .cloned()
        .or_else(|| {
            parsed
                .get("events")
                .and_then(|events| events.as_array())
                .cloned()
        })
        .unwrap_or_default();
    if events.is_empty() {
        println!("query answered {status}: {}", &raw[..raw.len().min(300)]);
    }
    let content = events
        .first()
        .and_then(|event| event.get("content"))
        .and_then(|content| content.as_str())
        .unwrap_or("{}");
    serde_json::from_str(content).unwrap_or(serde_json::Value::Null)
}
