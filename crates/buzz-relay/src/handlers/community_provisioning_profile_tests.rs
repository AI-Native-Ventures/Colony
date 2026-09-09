//! Real-database regression coverage for profiles created after relay startup.

use std::sync::Arc;

use buzz_core::company::{validate_company, CompanyProfile, COMMUNITY_PROFILE_ID};
use buzz_core::kind::KIND_COMPANY_PROFILE;
use buzz_core::tenant::TenantContext;
use buzz_core::CommunityId;
use buzz_sdk::company::CompanyActionPayload;
use nostr::{Event, Keys};

use super::{create_community_for_owner, provision_community, ProvisionCommunityRequest};
use crate::state::AppState;

async fn test_state(operator: &Keys) -> Arc<AppState> {
    let mut config = crate::config::Config::from_env().expect("test config loads");
    config.require_relay_membership = false;
    config.relay_operator_pubkeys = vec![operator.public_key().to_hex()];
    let pool = sqlx::PgPool::connect(&config.database_url)
        .await
        .expect("connect to test Postgres");
    buzz_db::migration::run_migrations_unless_provisioned(&pool)
        .await
        .expect("apply test migrations");
    let db = buzz_db::Db::from_pool(pool.clone());
    let redis_pool = deadpool_redis::Config::from_url(&config.redis_url)
        .create_pool(Some(deadpool_redis::Runtime::Tokio1))
        .expect("test Redis pool");
    let pubsub = Arc::new(
        buzz_pubsub::PubSubManager::new(&config.redis_url, redis_pool.clone())
            .await
            .expect("test pubsub manager"),
    );
    let audit = buzz_audit::AuditService::new(pool.clone());
    let auth = buzz_auth::AuthService::new(config.auth.clone());
    let search = buzz_search::SearchService::new(pool);
    let workflow_engine = Arc::new(buzz_workflow::WorkflowEngine::new(
        db.clone(),
        buzz_workflow::WorkflowConfig::default(),
    ));
    let media_storage = buzz_media::MediaStorage::new(&config.media).expect("test media storage");
    let (state, _audit_shutdown) = AppState::new(
        config,
        db,
        redis_pool,
        audit,
        pubsub,
        auth,
        search,
        workflow_engine,
        Keys::generate(),
        media_storage,
    );
    Arc::new(state)
}

async fn profile_head(state: &AppState, tenant: &TenantContext) -> Option<Event> {
    crate::company_broker::load_head(tenant, state, KIND_COMPANY_PROFILE, COMMUNITY_PROFILE_ID)
        .await
        .expect("load community profile")
}

fn profile_from(head: &Event) -> CompanyProfile {
    let profile: CompanyProfile = serde_json::from_str(&head.content).expect("valid profile JSON");
    validate_company(&profile).expect("profile satisfies the company contract");
    assert!(profile
        .cost_centres
        .iter()
        .any(|centre| centre.id == "general"));
    profile
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn newly_provisioned_community_has_a_work_profile_before_response() {
    let owner = Keys::generate();
    let state = test_state(&owner).await;
    let host = format!("new-profile-{}.example", uuid::Uuid::new_v4().simple());
    let owner_hex = owner.public_key().to_hex();

    // No startup backfill: this is the self-serve creation helper running after
    // the server is already up. Removing the provisioning hook makes this head
    // absent, reproducing the founder's first-job failure.
    let response = create_community_for_owner(&state, &host, &owner_hex, &owner_hex)
        .await
        .expect("provision fresh community");
    assert_eq!(response.status, "created");
    let tenant = TenantContext::resolved(
        CommunityId::from_uuid(
            uuid::Uuid::parse_str(&response.community_id).expect("community UUID"),
        ),
        host,
    );
    let head = profile_head(&state, &tenant)
        .await
        .expect("profile must exist as soon as creation succeeds");
    let profile = profile_from(&head);
    assert!(profile.summary.is_empty(), "do not invent business context");
    assert_eq!(head.pubkey, state.relay_keypair.public_key());

    let collision = create_community_for_owner(&state, tenant.host(), &owner_hex, &owner_hex).await;
    assert!(matches!(collision, Err(message) if message == "community already exists"));
    assert_eq!(
        profile_head(&state, &tenant).await.map(|event| event.id),
        Some(head.id)
    );
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn operator_provisioning_repairs_missing_profile_without_overwriting_owner_changes() {
    let operator = Keys::generate();
    let state = test_state(&operator).await;
    let host = format!("repair-profile-{}.example", uuid::Uuid::new_v4().simple());
    // Model an existing workspace from the affected beta: the community row
    // exists, but it was created after the boot sweep and has no profile.
    let record = state
        .db
        .ensure_configured_community(&host)
        .await
        .expect("seed old community");
    let tenant = TenantContext::resolved(record.id, &host);
    assert!(profile_head(&state, &tenant).await.is_none());
    let request = || ProvisionCommunityRequest {
        host: host.clone(),
        initial_owner_pubkey: Some(operator.public_key().to_hex()),
        create_only: false,
    };
    let response = provision_community(&state, &operator.public_key(), request())
        .await
        .expect("repair existing community");
    assert_eq!(response.status, "existed");
    let original = profile_head(&state, &tenant)
        .await
        .expect("profile is repaired");
    let mut customized = profile_from(&original);
    customized.trading_name = "Owner's chosen business name".to_owned();
    customized.summary = "Branding services for small businesses".to_owned();
    let updated = crate::company_broker::build_head(
        &state.relay_keypair,
        &CompanyActionPayload::Company(customized.clone()),
        Some(&original),
    )
    .expect("build owner-approved profile head");
    state
        .db
        .replace_parameterized_event(record.id, &updated, COMMUNITY_PROFILE_ID, None)
        .await
        .expect("save customized profile");

    provision_community(&state, &operator.public_key(), request())
        .await
        .expect("repeat provisioning");
    let retained = profile_head(&state, &tenant)
        .await
        .expect("retained profile");
    assert_eq!(
        retained.id, updated.id,
        "existing profiles must never be overwritten"
    );
    let retained_profile = profile_from(&retained);
    assert_eq!(retained_profile.trading_name, customized.trading_name);
    assert_eq!(retained_profile.summary, customized.summary);
}
