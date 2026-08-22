//! Relay-bundled Core Block manifests.
//!
//! These manifests are immutable product assets. They are parsed and validated
//! through the shared Block contract before the relay signs or publishes them.

use anyhow::Context;
use buzz_core::{
    block::{
        parse_manifest, validate_manifest, BlockCatalogEntry, BlockCatalogStatus, BlockError,
        BlockManifest,
    },
    CommunityId,
};
use nostr::{Event, Timestamp};

use crate::state::AppState;

const CORE_BLOCK_ASSETS: [(&str, &str); 23] = [
    (
        "primitives/section.json",
        include_str!("core_blocks/primitives/section.json"),
    ),
    (
        "primitives/metric.json",
        include_str!("core_blocks/primitives/metric.json"),
    ),
    (
        "primitives/details.json",
        include_str!("core_blocks/primitives/details.json"),
    ),
    (
        "primitives/table.json",
        include_str!("core_blocks/primitives/table.json"),
    ),
    (
        "primitives/card.json",
        include_str!("core_blocks/primitives/card.json"),
    ),
    (
        "primitives/card-list.json",
        include_str!("core_blocks/primitives/card-list.json"),
    ),
    (
        "primitives/chart.json",
        include_str!("core_blocks/primitives/chart.json"),
    ),
    (
        "primitives/media.json",
        include_str!("core_blocks/primitives/media.json"),
    ),
    (
        "primitives/status.json",
        include_str!("core_blocks/primitives/status.json"),
    ),
    (
        "primitives/actions.json",
        include_str!("core_blocks/primitives/actions.json"),
    ),
    (
        "primitives/question.json",
        include_str!("core_blocks/primitives/question.json"),
    ),
    (
        "composites/lead-card.json",
        include_str!("core_blocks/composites/lead-card.json"),
    ),
    (
        "composites/approval.json",
        include_str!("core_blocks/composites/approval.json"),
    ),
    (
        "composites/agent-proposal.json",
        include_str!("core_blocks/composites/agent-proposal.json"),
    ),
    (
        "composites/report.json",
        include_str!("core_blocks/composites/report.json"),
    ),
    (
        "composites/artifact.json",
        include_str!("core_blocks/composites/artifact.json"),
    ),
    (
        "composites/receipt.json",
        include_str!("core_blocks/composites/receipt.json"),
    ),
    (
        "composites/brainstorm.json",
        include_str!("core_blocks/composites/brainstorm.json"),
    ),
    (
        "composites/company-brief.json",
        include_str!("core_blocks/composites/company-brief.json"),
    ),
    (
        "composites/company-blueprint.json",
        include_str!("core_blocks/composites/company-blueprint.json"),
    ),
    (
        "composites/interview.json",
        include_str!("core_blocks/composites/interview.json"),
    ),
    (
        "composites/initiative.json",
        include_str!("core_blocks/composites/initiative.json"),
    ),
    (
        "composites/handover.json",
        include_str!("core_blocks/composites/handover.json"),
    ),
];

/// Parse and validate all manifests bundled with the relay.
pub fn core_block_manifests() -> Result<Vec<BlockManifest>, BlockError> {
    CORE_BLOCK_ASSETS
        .iter()
        .map(|(_, source)| {
            let manifest = parse_manifest(source)?;
            validate_manifest(&manifest)?;
            Ok(manifest)
        })
        .collect()
}

/// Ensure all relay-bundled Core manifests and initial catalog heads exist for
/// one community.
///
/// Immutable manifests use their asset timestamp, so every pod with the same
/// relay key produces the same signed event ID. Catalog heads use that same
/// fixed timestamp and normal NIP-33 replacement ordering. A later
/// broker-selected head therefore dominates this seed and is never rolled
/// back during restart.
pub async fn ensure_core_blocks(state: &AppState, community: CommunityId) -> anyhow::Result<usize> {
    ensure_core_blocks_with(&state.db, &state.relay_keypair, community).await
}

/// Ensure Core Blocks for every active community on this relay.
///
/// All communities are attempted even if one fails. The returned error names
/// every failed community so startup can report the fault loudly while
/// remaining available to already-provisioned tenants.
pub async fn ensure_core_blocks_for_all_communities(state: &AppState) -> anyhow::Result<usize> {
    let communities = state
        .db
        .list_active_communities()
        .await
        .context("failed to list active communities for Core Block seeding")?;
    let mut inserted = 0usize;
    let mut failures = Vec::new();

    for community in communities {
        match ensure_core_blocks(state, community.id).await {
            Ok(count) => inserted += count,
            Err(error) => {
                tracing::error!(
                    community = %community.id,
                    host = %community.host,
                    error = %error,
                    "Core Block seeding failed for community"
                );
                failures.push(format!("{} ({}): {error}", community.host, community.id));
            }
        }
    }

    if failures.is_empty() {
        Ok(inserted)
    } else {
        anyhow::bail!(
            "Core Block seeding failed for {} community(s): {}",
            failures.len(),
            failures.join("; ")
        )
    }
}

async fn ensure_core_blocks_with(
    db: &buzz_db::Db,
    relay_keypair: &nostr::Keys,
    community: CommunityId,
) -> anyhow::Result<usize> {
    let manifests = core_block_manifests().context("bundled Core Block manifests are invalid")?;
    let mut inserted = 0usize;

    for manifest in manifests {
        let manifest_event = build_core_manifest_event(&manifest, relay_keypair)?;
        let (_, manifest_inserted) = db
            .insert_event(community, &manifest_event, None)
            .await
            .with_context(|| format!("failed to store Core manifest {}", manifest.handle))?;
        inserted += usize::from(manifest_inserted);

        let catalog_event = build_core_catalog_event(&manifest, &manifest_event, relay_keypair)?;
        let (_, catalog_inserted) = db
            .replace_parameterized_event(community, &catalog_event, &manifest.handle, None)
            .await
            .with_context(|| format!("failed to store Core catalog head {}", manifest.handle))?;
        inserted += usize::from(catalog_inserted.was_inserted());
    }

    Ok(inserted)
}

fn build_core_manifest_event(
    manifest: &BlockManifest,
    relay_keypair: &nostr::Keys,
) -> anyhow::Result<Event> {
    buzz_sdk::blocks::build_block_manifest(manifest)
        .with_context(|| format!("failed to build Core manifest {}", manifest.handle))?
        .sign_with_keys(relay_keypair)
        .with_context(|| format!("failed to sign Core manifest {}", manifest.handle))
}

fn build_core_catalog_event(
    manifest: &BlockManifest,
    manifest_event: &Event,
    relay_keypair: &nostr::Keys,
) -> anyhow::Result<Event> {
    let preview = manifest
        .examples
        .first()
        .map(|example| example.data.clone())
        .unwrap_or(serde_json::Value::Null);
    let entry = BlockCatalogEntry {
        schema: "ai-native-office/block-catalog-entry/v1".to_owned(),
        handle: manifest.handle.clone(),
        active_manifest_id: manifest_event.id.to_hex(),
        status: BlockCatalogStatus::Active,
        summary: manifest.description.clone(),
        origin: manifest.origin,
        preview,
        permissions: manifest.permissions.clone(),
        workshop: None,
    };
    buzz_sdk::blocks::build_block_catalog_entry(&entry)
        .with_context(|| format!("failed to build Core catalog head {}", manifest.handle))?
        .custom_created_at(Timestamp::from(manifest.created_at))
        .sign_with_keys(relay_keypair)
        .with_context(|| format!("failed to sign Core catalog head {}", manifest.handle))
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};

    use buzz_core::block::{validate_instance, BlockValidationState};
    use buzz_core::kind::{KIND_BLOCK_CATALOG_ENTRY, KIND_BLOCK_MANIFEST};
    use buzz_db::event::EventQuery;
    use serde_json::Value;

    use super::{
        build_core_catalog_event, build_core_manifest_event, core_block_manifests,
        ensure_core_blocks_with, CORE_BLOCK_ASSETS,
    };

    const PRIMITIVE_HANDLES: [&str; 11] = [
        "section",
        "metric",
        "details",
        "table",
        "card",
        "card-list",
        "chart",
        "media",
        "status",
        "actions",
        "question",
    ];
    const COMPOSITE_HANDLES: [&str; 12] = [
        "lead-card",
        "approval",
        "agent-proposal",
        "report",
        "artifact",
        "receipt",
        "brainstorm",
        "company-brief",
        "company-blueprint",
        "interview",
        "initiative",
        "handover",
    ];

    fn raw_assets() -> BTreeMap<String, Value> {
        CORE_BLOCK_ASSETS
            .iter()
            .map(|(path, source)| {
                (
                    (*path).to_owned(),
                    serde_json::from_str(source)
                        .unwrap_or_else(|error| panic!("{path} is invalid JSON: {error}")),
                )
            })
            .collect()
    }

    fn visit_nodes<'a>(node: &'a Value, visitor: &mut impl FnMut(&'a Value)) {
        visitor(node);
        match node.get("type").and_then(Value::as_str) {
            Some("stack" | "grid") => {
                if let Some(children) = node.get("children").and_then(Value::as_array) {
                    for child in children {
                        visit_nodes(child, visitor);
                    }
                }
            }
            Some("card") => {
                if let Some(children) = node.get("children").and_then(Value::as_array) {
                    for child in children {
                        visit_nodes(child, visitor);
                    }
                }
            }
            Some("card-list") => {
                if let Some(card) = node.get("card") {
                    visit_nodes(card, visitor);
                }
            }
            _ => {}
        }
    }

    fn manifest_for_handle<'a>(assets: &'a BTreeMap<String, Value>, handle: &str) -> &'a Value {
        assets
            .values()
            .find(|asset| asset.get("handle").and_then(Value::as_str) == Some(handle))
            .unwrap_or_else(|| panic!("missing bundled manifest for {handle}"))
    }

    /// The Blueprint Block is what an owner reads before approving. Every role
    /// it names must exist in the trusted catalog, or the Block would advertise
    /// an employee that materialization then refuses to create, and the owner
    /// would have approved something that cannot happen.
    #[test]
    fn the_blueprint_block_only_offers_roles_from_the_trusted_catalog() {
        let known: Vec<String> = buzz_core::company_roster::BASELINE_ROLES
            .iter()
            .map(|role| buzz_core::company_roster::role_slug(role.id))
            .collect();

        let manifest = core_block_manifests()
            .expect("bundled manifests")
            .into_iter()
            .find(|manifest| manifest.handle == "company-blueprint")
            .expect("company-blueprint is bundled");

        let mut checked = 0;
        for example in &manifest.examples {
            let roster = example
                .data
                .get("roster")
                .and_then(|value| value.as_array())
                .expect("every example has a roster");
            assert!(!roster.is_empty(), "an empty roster proposes no company");
            for entry in roster {
                let role_id = entry
                    .get("role_id")
                    .and_then(|value| value.as_str())
                    .expect("every roster entry names a role");
                assert!(
                    known.iter().any(|candidate| candidate == role_id),
                    "`{role_id}` is not in the trusted catalog"
                );
                checked += 1;
            }
        }
        assert!(checked >= 2, "the examples must actually exercise roles");
    }

    /// Three is enough to show direction and few enough that an owner reads
    /// them all before approving. The Block and the executable document have
    /// to agree on that, since the transaction refuses any other count.
    #[test]
    fn the_blueprint_block_proposes_exactly_three_initiatives() {
        let manifest = core_block_manifests()
            .expect("bundled manifests")
            .into_iter()
            .find(|manifest| manifest.handle == "company-blueprint")
            .expect("company-blueprint is bundled");

        for example in &manifest.examples {
            let initiatives = example
                .data
                .get("initiatives")
                .and_then(|value| value.as_array())
                .expect("every example proposes initiatives");
            assert_eq!(initiatives.len(), 3, "example `{}`", example.name);
        }
    }

    /// An owner is entitled to know what was not answered. A blueprint that
    /// hides its gaps is worse than one with none, because the owner cannot
    /// correct what was never admitted.
    #[test]
    fn the_blueprint_block_always_carries_its_gaps() {
        let manifest = core_block_manifests()
            .expect("bundled manifests")
            .into_iter()
            .find(|manifest| manifest.handle == "company-blueprint")
            .expect("company-blueprint is bundled");

        assert!(
            manifest
                .input_schema
                .get("required")
                .and_then(|value| value.as_array())
                .is_some_and(|required| required.iter().any(|field| field == "gaps")),
            "gaps must be required, not optional"
        );
        for example in &manifest.examples {
            let gaps = example
                .data
                .get("gaps")
                .and_then(|value| value.as_array())
                .expect("every example states its gaps");
            assert!(
                !gaps.is_empty(),
                "example `{}` hides its gaps",
                example.name
            );
        }
    }

    #[test]
    fn handover_carries_both_ends_of_the_link_and_one_resolving_pickup() {
        let assets = raw_assets();
        let manifest = manifest_for_handle(&assets, "handover");

        let required: BTreeSet<_> = manifest
            .pointer("/input_schema/required")
            .and_then(Value::as_array)
            .expect("handover required fields")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        for field in [
            "source_channel",
            "source_event_id",
            "target_channel",
            "assignee",
            "links",
        ] {
            assert!(
                required.contains(field),
                "a handover without {field} cannot be linked back to its origin"
            );
        }

        let links = manifest
            .pointer("/input_schema/properties/links")
            .expect("handover links schema");
        assert_eq!(
            links.get("minItems").and_then(Value::as_u64),
            Some(1),
            "a handover with no links hands over nothing"
        );
        assert_eq!(
            links
                .pointer("/contains/properties/role/const")
                .and_then(Value::as_str),
            Some("deliverable"),
            "the finished work itself must be one of the links, not an optional extra"
        );
        let roles: BTreeSet<_> = links
            .pointer("/items/properties/role/enum")
            .and_then(Value::as_array)
            .expect("link role enum")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(
            roles,
            BTreeSet::from(["deliverable", "reference", "source"]),
            "link roles must be typed, or the assignee cannot tell one URL from another"
        );
        let link_required: BTreeSet<_> = links
            .pointer("/items/required")
            .and_then(Value::as_array)
            .expect("link required fields")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert!(link_required.contains("role"));

        let states: BTreeSet<_> = manifest
            .pointer("/input_schema/properties/status/enum")
            .and_then(Value::as_array)
            .expect("handover status enum")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(states, BTreeSet::from(["declined", "open", "picked-up"]));

        assert_eq!(
            manifest
                .pointer("/validation/requires_attention")
                .and_then(Value::as_bool),
            Some(true),
            "an unclaimed handover must stay in the assignee's attention"
        );

        let actions = manifest["actions"].as_array().expect("handover actions");
        let ids: BTreeSet<_> = actions
            .iter()
            .filter_map(|action| action.get("id").and_then(Value::as_str))
            .collect();
        assert_eq!(
            ids,
            BTreeSet::from(["handover.decline", "handover.pick-up"])
        );

        for action in actions {
            assert_eq!(
                action.pointer("/interaction/type").and_then(Value::as_str),
                Some("signed"),
                "handover actions must be signed by the person taking them"
            );
            assert_eq!(
                action
                    .pointer("/interaction/resolves_attention")
                    .and_then(Value::as_bool),
                Some(true)
            );
            assert_eq!(
                action.get("permissions").and_then(Value::as_array),
                Some(&vec![]),
                "picking up work must not require an escalated capability"
            );
        }

        let pick_up = actions
            .iter()
            .find(|action| action.get("id").and_then(Value::as_str) == Some("handover.pick-up"))
            .expect("pick-up declaration");
        let pick_up_required: BTreeSet<_> = pick_up
            .pointer("/input_schema/required")
            .and_then(Value::as_array)
            .expect("pick-up required fields")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert!(
            pick_up_required.contains("target_event_id"),
            "pick-up must carry the thread it opened, or the forward link is lost"
        );

        assert_eq!(
            manifest["permissions"].as_array(),
            Some(&vec![]),
            "handover grants nothing"
        );
    }

    #[test]
    fn loads_twenty_three_unique_valid_manifests_and_examples() {
        let manifests = core_block_manifests().expect("Core manifests should validate");
        assert_eq!(manifests.len(), 23);

        let handles: BTreeSet<_> = manifests
            .iter()
            .map(|manifest| manifest.handle.as_str())
            .collect();
        assert_eq!(handles.len(), 23);

        let expected: BTreeSet<_> = PRIMITIVE_HANDLES
            .into_iter()
            .chain(COMPOSITE_HANDLES)
            .collect();
        assert_eq!(handles, expected);

        for manifest in &manifests {
            assert_eq!(
                manifest.validation.state,
                BlockValidationState::Tested,
                "{} must be explicitly tested before it is seeded active",
                manifest.handle
            );
            assert!(
                !manifest.examples.is_empty(),
                "{} needs at least one preview example",
                manifest.handle
            );
            for example in &manifest.examples {
                validate_instance(&manifest.input_schema, &example.data).unwrap_or_else(|error| {
                    panic!(
                        "{} example {} failed validation: {error}",
                        manifest.handle, example.name
                    )
                });
            }
        }
    }

    #[test]
    fn each_primitive_asset_has_its_matching_root_node() {
        let assets = raw_assets();
        for handle in PRIMITIVE_HANDLES {
            let manifest = manifest_for_handle(&assets, handle);
            assert_eq!(
                manifest
                    .pointer("/tree/type")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                handle
            );
        }
    }

    /// The brief exists so the owner can correct it. That only works if it
    /// distinguishes what the site actually said from what we guessed, cites a
    /// source for each claim, and never quietly omits what it could not find.
    #[test]
    fn company_brief_separates_evidence_from_guesswork_and_keeps_gaps() {
        let manifest = core_block_manifests()
            .expect("Core manifests")
            .into_iter()
            .find(|manifest| manifest.handle == "company-brief")
            .expect("company-brief is bundled");

        let schema = serde_json::to_value(&manifest.input_schema).expect("schema");
        let required: Vec<&str> = schema["required"]
            .as_array()
            .expect("required list")
            .iter()
            .filter_map(|value| value.as_str())
            .collect();
        // Gaps are required, so a brief cannot be published that hides them.
        for field in [
            "trading_name",
            "summary",
            "scanned_at",
            "source_url",
            "findings",
            "gaps",
        ] {
            assert!(required.contains(&field), "`{field}` must be required");
        }

        let finding = &schema["properties"]["findings"]["items"];
        let finding_required: Vec<&str> = finding["required"]
            .as_array()
            .expect("finding required")
            .iter()
            .filter_map(|value| value.as_str())
            .collect();
        // Every claim carries how strongly it is attested and where it came
        // from, so the owner can weigh it rather than take it on trust.
        for field in ["label", "value", "confidence", "source"] {
            assert!(finding_required.contains(&field), "finding needs `{field}`");
        }
        let confidence: Vec<&str> = finding["properties"]["confidence"]["enum"]
            .as_array()
            .expect("confidence enum")
            .iter()
            .filter_map(|value| value.as_str())
            .collect();
        assert_eq!(confidence, ["confirmed", "inferred", "unknown"]);

        // A gap has to say why it matters, or it reads as a nag rather than a
        // reason to answer.
        let gap_required: Vec<&str> = schema["properties"]["gaps"]["items"]["required"]
            .as_array()
            .expect("gap required")
            .iter()
            .filter_map(|value| value.as_str())
            .collect();
        assert!(gap_required.contains(&"why_it_matters"));

        // The brief only presents; it never mutates company state.
        assert!(
            manifest.actions.is_empty(),
            "the brief is presentation only — approval belongs to the blueprint"
        );

        // A site that said almost nothing must still produce a usable brief.
        let sparse = manifest
            .examples
            .iter()
            .find(|example| example.name.contains("said almost nothing"))
            .expect("sparse example");
        let gaps = sparse.data["gaps"].as_array().expect("gaps");
        assert!(
            gaps.len() >= 3,
            "an empty site should surface more gaps, not fewer"
        );
    }

    #[test]
    fn brainstorm_is_multi_select_with_optional_custom_input() {
        let assets = raw_assets();
        let manifest = manifest_for_handle(&assets, "brainstorm");
        let mut question = None;
        visit_nodes(&manifest["tree"], &mut |node| {
            if node.get("type").and_then(Value::as_str) == Some("question") {
                question = Some(node);
            }
        });
        let question = question.expect("brainstorm must contain a Question");

        assert_eq!(
            question.get("mode").and_then(Value::as_str),
            Some("multi-select")
        );
        assert_eq!(
            question.get("allow_custom").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            question
                .get("require_custom_input")
                .and_then(Value::as_bool),
            Some(false)
        );
        assert!(question
            .get("max_selections")
            .and_then(Value::as_u64)
            .is_some_and(|maximum| maximum > 1));
        assert_eq!(
            question.get("options_path").and_then(Value::as_str),
            Some("/choices")
        );
        assert!(question.get("options").is_none());
        let mut card_list_count = 0;
        visit_nodes(&manifest["tree"], &mut |node| {
            if node.get("type").and_then(Value::as_str) == Some("card-list") {
                card_list_count += 1;
            }
        });
        assert_eq!(
            card_list_count, 0,
            "Brainstorm choices must render only as selectable Question cards"
        );
    }

    #[test]
    fn agent_proposal_is_a_safe_native_composite() {
        let assets = raw_assets();
        let manifest = manifest_for_handle(&assets, "agent-proposal");
        assert!(
            !manifest["tree"].to_string().contains("channelId"),
            "agent-proposal presentation must not expose the internal channel UUID"
        );

        let mut node_types = BTreeSet::new();
        let mut has_review_presentation = false;
        visit_nodes(&manifest["tree"], &mut |node| {
            if let Some(node_type) = node.get("type").and_then(Value::as_str) {
                node_types.insert(node_type);
            }
            if node.pointer("/interaction/type").and_then(Value::as_str) == Some("presentation")
                && node.pointer("/interaction/surface").and_then(Value::as_str)
                    == Some("agent-review")
            {
                has_review_presentation = true;
            }
            if let Some(controls) = node.get("controls").and_then(Value::as_array) {
                has_review_presentation |= controls.iter().any(|control| {
                    control.pointer("/interaction/type").and_then(Value::as_str)
                        == Some("presentation")
                        && control
                            .pointer("/interaction/surface")
                            .and_then(Value::as_str)
                            == Some("agent-review")
                });
            }
        });
        assert_eq!(
            node_types,
            BTreeSet::from(["actions", "card", "details", "status"])
        );
        assert!(has_review_presentation);

        let actions = manifest["actions"]
            .as_array()
            .expect("agent-proposal actions");
        assert!(actions.iter().any(|action| {
            action.get("id").and_then(Value::as_str) == Some("agent.review")
                && action.pointer("/interaction/type").and_then(Value::as_str)
                    == Some("presentation")
                && action
                    .pointer("/interaction/surface")
                    .and_then(Value::as_str)
                    == Some("agent-review")
        }));
        for action_id in ["agent.create", "agent.update", "agent.decline"] {
            assert!(actions.iter().any(|action| {
                action.get("id").and_then(Value::as_str) == Some(action_id)
                    && action.pointer("/interaction/type").and_then(Value::as_str) == Some("signed")
                    && action
                        .pointer("/interaction/resolves_attention")
                        .and_then(Value::as_bool)
                        == Some(true)
            }));
        }

        let schemas = std::iter::once(&manifest["input_schema"]).chain(
            actions
                .iter()
                .filter_map(|action| action.get("input_schema")),
        );
        let forbidden = [
            "privatekey",
            "private_key",
            "envvars",
            "env_vars",
            "credentials",
            "credential",
            "secret",
            "backendconfig",
            "backend_config",
        ];
        for schema in schemas {
            let serialized = serde_json::to_string(schema)
                .expect("schema values should always serialize")
                .to_ascii_lowercase();
            for field in forbidden {
                assert!(
                    !serialized.contains(&format!("\"{field}\"")),
                    "agent-proposal schema contains forbidden field {field}"
                );
            }
        }
    }

    async fn postgres_test_db() -> Option<buzz_db::Db> {
        const TEST_DB_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz"; // sadscan:disable np.postgres.1
        let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| TEST_DB_URL.to_owned());
        let pool = sqlx::PgPool::connect(&database_url).await.ok()?;
        sqlx::query("SELECT 1 FROM communities LIMIT 1")
            .execute(&pool)
            .await
            .ok()?;
        Some(buzz_db::Db::from_pool(pool))
    }

    #[tokio::test]
    async fn seeding_is_idempotent_and_preserves_a_newer_catalog_head() {
        let Some(db) = postgres_test_db().await else {
            eprintln!("skipping Core Block seed integration test: Postgres unavailable");
            return;
        };
        let host = format!("core-blocks-{}.example", uuid::Uuid::new_v4().simple());
        let community = db
            .ensure_configured_community(&host)
            .await
            .expect("test community")
            .id;
        let relay_keys = nostr::Keys::generate();

        assert_eq!(
            ensure_core_blocks_with(&db, &relay_keys, community)
                .await
                .expect("first seed"),
            46,
            "the first seed inserts twenty-three manifests and twenty-three heads"
        );
        assert_eq!(
            ensure_core_blocks_with(&db, &relay_keys, community)
                .await
                .expect("idempotent seed"),
            0
        );

        let relay_pubkey = relay_keys.public_key().to_bytes().to_vec();
        let manifests = db
            .query_events(&EventQuery {
                kinds: Some(vec![KIND_BLOCK_MANIFEST as i32]),
                pubkey: Some(relay_pubkey.clone()),
                global_only: true,
                limit: Some(100),
                ..EventQuery::for_community(community)
            })
            .await
            .expect("stored manifests");
        let heads = db
            .query_events(&EventQuery {
                kinds: Some(vec![KIND_BLOCK_CATALOG_ENTRY as i32]),
                pubkey: Some(relay_pubkey.clone()),
                global_only: true,
                limit: Some(100),
                ..EventQuery::for_community(community)
            })
            .await
            .expect("stored heads");
        assert_eq!(manifests.len(), 23);
        assert_eq!(heads.len(), 23);

        let mut newer_manifest = core_block_manifests()
            .expect("bundled manifests")
            .into_iter()
            .find(|manifest| manifest.handle == "section")
            .expect("section manifest");
        newer_manifest.version = "2.0.0".parse().expect("version");
        newer_manifest.created_at += 60;
        newer_manifest.description = "Broker-selected Section v2".to_owned();
        let newer_manifest_event =
            build_core_manifest_event(&newer_manifest, &relay_keys).expect("newer manifest event");
        db.insert_event(community, &newer_manifest_event, None)
            .await
            .expect("store newer manifest");
        let newer_head =
            build_core_catalog_event(&newer_manifest, &newer_manifest_event, &relay_keys)
                .expect("newer catalog head");
        assert!(db
            .replace_parameterized_event(community, &newer_head, "section", None)
            .await
            .expect("select newer head")
            .1
            .was_inserted());

        assert_eq!(
            ensure_core_blocks_with(&db, &relay_keys, community)
                .await
                .expect("seed after broker selection"),
            0,
            "the fixed seed must not roll back a newer broker-selected head"
        );
        let current = db
            .query_events(&EventQuery {
                kinds: Some(vec![KIND_BLOCK_CATALOG_ENTRY as i32]),
                pubkey: Some(relay_pubkey),
                d_tag: Some("section".to_owned()),
                global_only: true,
                limit: Some(1),
                ..EventQuery::for_community(community)
            })
            .await
            .expect("current section head");
        assert_eq!(current.len(), 1);
        assert_eq!(current[0].event.id, newer_head.id);
    }
}
