//! `--discovery <kind>:<id>` references attached to an outgoing message.
//!
//! A message carries one `["discovery", "<kind>", "<id>", "<label>"]` tag per
//! referenced entity, exactly the shape the composer writes and the shape the
//! ACP harness hydrates back into agent context. The kind and the id are
//! authoritative; the label travels with the message for presentation only and
//! is never trusted to identify anything.

use buzz_core::discovery_workspace::{
    DiscoveryEntityKind, DiscoveryEntityRef, ResolvedDiscoveryEntity, DISCOVERY_MENTION_MAX_REFS,
};

use crate::error::CliError;

/// Wire spelling of a kind, as written into the tag's second element.
pub fn discovery_kind_wire(kind: DiscoveryEntityKind) -> &'static str {
    match kind {
        DiscoveryEntityKind::Industry => "industry",
        DiscoveryEntityKind::Vertical => "vertical",
        DiscoveryEntityKind::Campaign => "campaign",
        DiscoveryEntityKind::CampaignLeads => "campaign_leads",
        DiscoveryEntityKind::Lead => "lead",
        DiscoveryEntityKind::Run => "run",
    }
}

/// Parse one `<kind>:<id>` value into a validated reference.
///
/// Only the first `:` separates the two halves: a Vertical id is the composite
/// `<industry-id>/<vertical-id>`, and the other kinds carry a UUID, so nothing
/// past the first separator is ours to split. Every value is validated through
/// the buzz-core reference contract, so a reference that would be refused at
/// ingest is refused here instead.
pub fn parse_discovery_ref(value: &str) -> Result<DiscoveryEntityRef, CliError> {
    let trimmed = value.trim();
    let Some((raw_kind, raw_id)) = trimmed.split_once(':') else {
        return Err(CliError::Usage(format!(
            "invalid --discovery value `{value}`: expected <kind>:<id>, \
             one of industry, vertical, campaign, campaign_leads, lead, run"
        )));
    };
    let Some(kind) = DiscoveryEntityKind::parse(raw_kind.trim()) else {
        return Err(CliError::Usage(format!(
            "invalid --discovery value `{value}`: unknown kind `{}`; \
             expected industry, vertical, campaign, campaign_leads, lead, or run",
            raw_kind.trim()
        )));
    };
    let reference = DiscoveryEntityRef {
        kind,
        id: raw_id.trim().to_owned(),
    };
    reference.validate().map_err(|error| {
        CliError::Usage(format!(
            "invalid --discovery value `{value}`: {error}. \
             Verticals are <industry-id>/<vertical-id>; campaigns, campaign_leads, \
             leads and runs are UUIDs. `buzz discovery search` prints the stable ids"
        ))
    })?;
    Ok(reference)
}

/// Parse every `--discovery` value, deduplicating by kind plus id and keeping
/// first-seen order.
pub fn parse_discovery_refs(values: &[String]) -> Result<Vec<DiscoveryEntityRef>, CliError> {
    let mut refs: Vec<DiscoveryEntityRef> = Vec::new();
    for value in values {
        let reference = parse_discovery_ref(value)?;
        if !refs
            .iter()
            .any(|existing| existing.kind == reference.kind && existing.id == reference.id)
        {
            refs.push(reference);
        }
    }
    if refs.len() > DISCOVERY_MENTION_MAX_REFS {
        return Err(CliError::Usage(format!(
            "too many --discovery references ({}, max {DISCOVERY_MENTION_MAX_REFS})",
            refs.len()
        )));
    }
    Ok(refs)
}

/// Take the display name of one resolved entity as the reference's label.
///
/// A reference the sender cannot resolve is fatal: publishing a tile the
/// reader cannot open is worse than not sending, the same rule the `--mention`
/// preflight applies to visible mention text.
pub fn resolved_entity_label(
    reference: &DiscoveryEntityRef,
    resolved: &ResolvedDiscoveryEntity,
) -> Result<String, CliError> {
    let label = match resolved {
        ResolvedDiscoveryEntity::Industry { taxonomy } => taxonomy.industry_label.clone(),
        ResolvedDiscoveryEntity::Vertical { taxonomy } => taxonomy
            .vertical_label
            .clone()
            .unwrap_or_else(|| taxonomy.industry_label.clone()),
        ResolvedDiscoveryEntity::Campaign { campaign } => campaign.name.clone(),
        ResolvedDiscoveryEntity::CampaignLeads { collection } => {
            format!("{} leads", collection.total)
        }
        ResolvedDiscoveryEntity::Lead { lead } => lead.lead.name.clone(),
        ResolvedDiscoveryEntity::Run { run } => {
            let short: String = run.run_id.to_string().chars().take(8).collect();
            format!("Run {short}")
        }
        ResolvedDiscoveryEntity::Unavailable { kind, id } => {
            return Err(CliError::Usage(format!(
                "Discovery reference `{}:{}` did not resolve: it is unknown, deleted, \
                 in another community, or outside this identity's Discovery permissions. \
                 Nothing was sent",
                discovery_kind_wire(*kind),
                id
            )));
        }
    };
    let label = label.trim();
    if label.is_empty() {
        // The label is presentation only, so a blank display name is not fatal:
        // fall back to the id the reader can still act on.
        return Ok(reference.id.clone());
    }
    Ok(label.to_owned())
}

/// Build the message tags for already-resolved references, in order.
pub fn discovery_tags(
    labelled: &[(DiscoveryEntityRef, String)],
) -> Result<Vec<nostr::Tag>, CliError> {
    labelled
        .iter()
        .map(|(reference, label)| {
            nostr::Tag::parse([
                "discovery",
                discovery_kind_wire(reference.kind),
                reference.id.as_str(),
                label.as_str(),
            ])
            .map_err(|error| CliError::Other(format!("discovery tag: {error}")))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::discovery::{DiscoveryProvider, DiscoveryRunProjection, DiscoveryRunState};
    use buzz_core::discovery_workspace::{
        DiscoveryBusinessLeadProjection, DiscoveryLeadCollectionProjection, DiscoveryLeadStatus,
        DiscoveryTaxonomyProjection,
    };
    use chrono::Utc;
    use uuid::Uuid;

    const CAMPAIGN: &str = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

    fn values(raw: &[&str]) -> Vec<String> {
        raw.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn every_wire_kind_parses_with_its_stable_id() {
        let cases = [
            ("industry:healthcare", DiscoveryEntityKind::Industry),
            (
                "vertical:healthcare/dentists",
                DiscoveryEntityKind::Vertical,
            ),
            (
                "campaign:3f2504e0-4f89-41d3-9a0c-0305e82c3301",
                DiscoveryEntityKind::Campaign,
            ),
            (
                "campaign_leads:3f2504e0-4f89-41d3-9a0c-0305e82c3301",
                DiscoveryEntityKind::CampaignLeads,
            ),
            (
                "lead:3f2504e0-4f89-41d3-9a0c-0305e82c3301",
                DiscoveryEntityKind::Lead,
            ),
            (
                "run:3f2504e0-4f89-41d3-9a0c-0305e82c3301",
                DiscoveryEntityKind::Run,
            ),
        ];
        for (value, kind) in cases {
            let parsed = parse_discovery_ref(value).expect("valid reference");
            assert_eq!(parsed.kind, kind, "{value}");
        }
    }

    // A vertical id carries its parent industry, so only the first `:` splits.
    #[test]
    fn a_vertical_keeps_its_composite_id() {
        let parsed = parse_discovery_ref("vertical:healthcare/dentists").expect("valid vertical");
        assert_eq!(parsed.id, "healthcare/dentists");
        assert_eq!(
            parsed.vertical_components(),
            Some(("healthcare", "dentists"))
        );
    }

    #[test]
    fn a_malformed_value_is_a_usage_error_naming_the_value() {
        for value in [
            "healthcare",
            "industries:healthcare",
            "vertical:dentists",
            "campaign:not-a-uuid",
            "lead:",
            ":healthcare",
            "industry:Healthcare",
        ] {
            let error = parse_discovery_ref(value).expect_err("must be refused");
            assert!(
                matches!(error, CliError::Usage(_)),
                "{value} must be a usage error"
            );
            assert!(
                error.to_string().contains(value),
                "{value} must be named in: {error}"
            );
        }
    }

    #[test]
    fn duplicates_collapse_to_their_first_occurrence_in_order() {
        let parsed = parse_discovery_refs(&values(&[
            "industry:healthcare",
            "vertical:healthcare/dentists",
            "industry:healthcare",
        ]))
        .expect("valid references");
        assert_eq!(
            parsed
                .iter()
                .map(|reference| reference.id.as_str())
                .collect::<Vec<_>>(),
            vec!["healthcare", "healthcare/dentists"]
        );
    }

    #[test]
    fn the_reference_cap_is_enforced_after_deduplication() {
        let at_cap: Vec<String> = (0..DISCOVERY_MENTION_MAX_REFS)
            .map(|index| format!("industry:industry-{index}"))
            .collect();
        assert_eq!(
            parse_discovery_refs(&at_cap).expect("at the cap").len(),
            DISCOVERY_MENTION_MAX_REFS
        );

        let mut duplicated = at_cap.clone();
        duplicated.push("industry:industry-0".to_owned());
        assert_eq!(
            parse_discovery_refs(&duplicated)
                .expect("a duplicate does not push past the cap")
                .len(),
            DISCOVERY_MENTION_MAX_REFS
        );

        let mut over_cap = at_cap;
        over_cap.push(format!("industry:industry-{DISCOVERY_MENTION_MAX_REFS}"));
        assert!(matches!(
            parse_discovery_refs(&over_cap),
            Err(CliError::Usage(_))
        ));
    }

    fn taxonomy(vertical: Option<&str>) -> Box<DiscoveryTaxonomyProjection> {
        Box::new(DiscoveryTaxonomyProjection {
            industry_id: "healthcare".into(),
            industry_label: "Healthcare".into(),
            vertical_id: vertical.map(|_| "dentists".to_owned()),
            vertical_label: vertical.map(str::to_owned),
            description: None,
            lead_count: 3,
        })
    }

    fn lead_projection(name: &str) -> DiscoveryBusinessLeadProjection {
        DiscoveryBusinessLeadProjection {
            lead_id: Uuid::nil(),
            campaign_id: Uuid::nil(),
            industry_id: "healthcare".into(),
            vertical_id: "dentists".into(),
            status: DiscoveryLeadStatus::Candidate,
            provider: DiscoveryProvider::Outscraper,
            name: name.into(),
            website: None,
            phone: None,
            full_address: None,
            city: None,
            state: None,
            country: None,
            category: None,
            subtypes: Vec::new(),
            rating_hundredths: None,
            reviews_count: None,
            source_url: None,
            image_url: None,
            added_at: Utc::now(),
        }
    }

    #[test]
    fn a_resolved_entity_supplies_its_display_name_as_the_label() {
        let industry = parse_discovery_ref("industry:healthcare").expect("valid");
        assert_eq!(
            resolved_entity_label(
                &industry,
                &ResolvedDiscoveryEntity::Industry {
                    taxonomy: taxonomy(None)
                }
            )
            .expect("label"),
            "Healthcare"
        );

        let vertical = parse_discovery_ref("vertical:healthcare/dentists").expect("valid");
        assert_eq!(
            resolved_entity_label(
                &vertical,
                &ResolvedDiscoveryEntity::Vertical {
                    taxonomy: taxonomy(Some("Dentists"))
                }
            )
            .expect("label"),
            "Dentists"
        );

        let lead = parse_discovery_ref(&format!("lead:{CAMPAIGN}")).expect("valid");
        assert_eq!(
            resolved_entity_label(
                &lead,
                &ResolvedDiscoveryEntity::Lead {
                    lead: Box::new(buzz_core::discovery_workspace::DiscoveryLeadDetail {
                        lead: lead_projection("Bright Smile Dental"),
                        owner_persona_id: None,
                        website_override: None,
                        email: None,
                        phone_override: None,
                        linkedin_url: None,
                        contact_name: None,
                        contact_title: None,
                        notes: None,
                        score: None,
                        updated_by: None,
                        updated_at: None,
                    })
                }
            )
            .expect("label"),
            "Bright Smile Dental"
        );
    }

    #[test]
    fn a_collection_and_a_run_get_a_readable_presentation_label() {
        let collection = parse_discovery_ref(&format!("campaign_leads:{CAMPAIGN}")).expect("valid");
        assert_eq!(
            resolved_entity_label(
                &collection,
                &ResolvedDiscoveryEntity::CampaignLeads {
                    collection: Box::new(DiscoveryLeadCollectionProjection {
                        campaign_id: Uuid::nil(),
                        total: 42,
                        leads: Vec::new(),
                    })
                }
            )
            .expect("label"),
            "42 leads"
        );

        let run = parse_discovery_ref(&format!("run:{CAMPAIGN}")).expect("valid");
        assert_eq!(
            resolved_entity_label(
                &run,
                &ResolvedDiscoveryEntity::Run {
                    run: Box::new(DiscoveryRunProjection {
                        run_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
                            .parse()
                            .expect("uuid"),
                        campaign_id: Uuid::nil(),
                        protocol_version: 2,
                        state: DiscoveryRunState::Running,
                        completed_steps: 1,
                        total_steps: 4,
                        cancel_requested: false,
                        terminal_reason: None,
                        billing: None,
                        created_at: Utc::now(),
                        updated_at: Utc::now(),
                    })
                }
            )
            .expect("label"),
            "Run 3f2504e0"
        );
    }

    // Publishing a tile the reader cannot open is worse than not sending, so
    // one unresolved reference fails the whole send.
    #[test]
    fn an_unresolved_reference_aborts_the_send() {
        let reference = parse_discovery_ref(&format!("campaign:{CAMPAIGN}")).expect("valid");
        let error = resolved_entity_label(
            &reference,
            &ResolvedDiscoveryEntity::Unavailable {
                kind: DiscoveryEntityKind::Campaign,
                id: CAMPAIGN.to_owned(),
            },
        )
        .expect_err("an unavailable reference is fatal");
        assert!(matches!(error, CliError::Usage(_)));
        assert!(error.to_string().contains(CAMPAIGN), "{error}");
        assert!(error.to_string().contains("campaign"), "{error}");
    }

    #[test]
    fn each_reference_becomes_one_four_element_tag() {
        let refs = parse_discovery_refs(&values(&[
            "industry:healthcare",
            &format!("campaign_leads:{CAMPAIGN}"),
        ]))
        .expect("valid references");
        let labelled: Vec<(DiscoveryEntityRef, String)> = refs
            .into_iter()
            .zip(["Healthcare".to_owned(), "42 leads".to_owned()])
            .collect();
        let tags = discovery_tags(&labelled).expect("tags");
        let rendered: Vec<Vec<String>> = tags.iter().map(|tag| tag.as_slice().to_vec()).collect();
        assert_eq!(
            rendered,
            vec![
                vec![
                    "discovery".to_owned(),
                    "industry".to_owned(),
                    "healthcare".to_owned(),
                    "Healthcare".to_owned()
                ],
                vec![
                    "discovery".to_owned(),
                    "campaign_leads".to_owned(),
                    CAMPAIGN.to_owned(),
                    "42 leads".to_owned()
                ],
            ]
        );
    }
}
