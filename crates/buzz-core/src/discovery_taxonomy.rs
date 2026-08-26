//! Canonical Business Discovery taxonomy shared by relay, CLI, and desktop.
//!
//! `assets/discovery/business_taxonomy.json` is the single source of truth.
//! The desktop bundle loads the same file (see
//! `desktop/src/features/discovery/data/businessTaxonomy`), so an industry or
//! vertical ID minted on one side is valid everywhere. Editing the JSON by
//! hand is fine; the `parity_hash` test pins the exact bytes both runtimes
//! compile against, so a one-sided edit fails CI instead of drifting.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

/// Canonical taxonomy bytes embedded verbatim into every consumer.
pub const BUSINESS_TAXONOMY_JSON: &str =
    include_str!("../../../assets/discovery/business_taxonomy.json");

/// SHA-256 of [`BUSINESS_TAXONOMY_JSON`]. Any edit to the canonical JSON must
/// update this constant in the same commit, which forces a deliberate,
/// reviewed change instead of silent drift between runtimes.
pub const BUSINESS_TAXONOMY_PARITY_HASH: &str =
    "a763d97e0a27e1cac76d2a1061b3a825f8ed6f3ce75937d96e566bd3dc17f8f8";

/// Upper bound shared by every mention-facing search page.
pub const DISCOVERY_ENTITY_SEARCH_LIMIT: usize = 20;

const MAX_QUERY_BYTES: usize = 128;

/// One vertical inside the canonical business taxonomy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryTaxonomyVertical {
    /// Stable lowercase identifier (also the campaign `vertical_id`).
    pub id: String,
    /// Human-readable label.
    pub label: String,
    /// Optional human-readable description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// One industry row of the canonical business taxonomy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryTaxonomyIndustry {
    /// Stable lowercase identifier (also the campaign `industry_id`).
    pub id: String,
    /// Human-readable label.
    pub label: String,
    /// Optional human-readable description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Verticals nested under this industry, in canonical order.
    pub verticals: Vec<DiscoveryTaxonomyVertical>,
}

fn taxonomy() -> &'static Vec<DiscoveryTaxonomyIndustry> {
    static TAXONOMY: OnceLock<Vec<DiscoveryTaxonomyIndustry>> = OnceLock::new();
    TAXONOMY.get_or_init(|| {
        serde_json::from_str(BUSINESS_TAXONOMY_JSON)
            .expect("embedded business taxonomy JSON parses")
    })
}

/// Borrow the full parsed taxonomy in canonical order.
pub fn business_taxonomy() -> &'static [DiscoveryTaxonomyIndustry] {
    taxonomy()
}

/// Validate a user-typed search query for taxonomy or entity search.
///
/// Trimming rejects pure-whitespace queries; control characters never enter
/// prompts or logs through this path.
pub fn validate_search_query(
    query: &str,
) -> Result<(), crate::discovery_workspace::DiscoveryWorkspaceValidationError> {
    if query.is_empty()
        || query != query.trim()
        || query.len() > MAX_QUERY_BYTES
        || query.chars().any(char::is_control)
    {
        return Err(
            crate::discovery_workspace::DiscoveryWorkspaceValidationError::InvalidField("query"),
        );
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum MatchRank {
    Equal,
    Prefix,
    Substring,
}

impl MatchRank {
    fn of(haystack_lower: &str, needle_lower: &str) -> Option<Self> {
        if haystack_lower == needle_lower {
            Some(Self::Equal)
        } else if haystack_lower.starts_with(needle_lower) {
            Some(Self::Prefix)
        } else if haystack_lower.contains(needle_lower) {
            Some(Self::Substring)
        } else {
            None
        }
    }
}

/// One searchable taxonomy row: an Industry or a Vertical.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaxonomySearchRow {
    pub industry_id: String,
    pub industry_label: String,
    /// Present when this row is a vertical.
    pub vertical_id: Option<String>,
    pub vertical_label: Option<String>,
    pub description: Option<String>,
}

impl TaxonomySearchRow {
    /// Identifier referenced by a `discovery` mention tag.
    ///
    /// Verticals repeat across industries, so a Vertical's stable mention ID
    /// is the composite `<industry_id>/<vertical_id>`; Industries use their
    /// plain ID.
    pub fn entity_id(&self) -> String {
        match &self.vertical_id {
            None => self.industry_id.clone(),
            Some(vertical_id) => format!("{}/{vertical_id}", self.industry_id),
        }
    }

    /// Display label surfaced to people and agents.
    pub fn entity_label(&self) -> &str {
        self.vertical_label
            .as_deref()
            .unwrap_or(&self.industry_label)
    }
}

/// Case-insensitive, bounded, deterministic taxonomy search.
///
/// Rows are ranked equal → prefix → substring over label first, then ID, and
/// ties keep canonical order. Matching a search's available rows without any
/// provider spend is free per the approved product decisions.
pub fn search_taxonomy(query: &str, limit: usize) -> Vec<TaxonomySearchRow> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    // Every row carries (rank, industry index, slot) where slot 0 is the
    // industry itself and 1.. are its verticals in canonical order, so equal
    // ranks interleave deterministically without depending on hash iteration.
    let mut rows: Vec<(MatchRank, usize, usize, TaxonomySearchRow)> = Vec::new();
    for (industry_index, industry) in taxonomy().iter().enumerate() {
        let industry_rank = MatchRank::of(&industry.label.to_lowercase(), &needle)
            .or_else(|| MatchRank::of(&industry.id, &needle));
        if let Some(rank) = industry_rank {
            rows.push((
                rank,
                industry_index,
                0,
                TaxonomySearchRow {
                    industry_id: industry.id.clone(),
                    industry_label: industry.label.clone(),
                    vertical_id: None,
                    vertical_label: None,
                    description: industry.description.clone(),
                },
            ));
        }
        for (vertical_index, vertical) in industry.verticals.iter().enumerate() {
            let own = MatchRank::of(&vertical.label.to_lowercase(), &needle)
                .or_else(|| MatchRank::of(&vertical.id, &needle));
            if let Some(rank) = own {
                rows.push((
                    rank,
                    industry_index,
                    vertical_index + 1,
                    TaxonomySearchRow {
                        industry_id: industry.id.clone(),
                        industry_label: industry.label.clone(),
                        vertical_id: Some(vertical.id.clone()),
                        vertical_label: Some(vertical.label.clone()),
                        description: vertical.description.clone(),
                    },
                ));
            }
        }
    }
    rows.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then(left.1.cmp(&right.1))
            .then(left.2.cmp(&right.2))
    });
    rows.truncate(limit.min(DISCOVERY_ENTITY_SEARCH_LIMIT));
    rows.into_iter().map(|(_, _, _, row)| row).collect()
}

/// Resolve one taxonomy ID (Industry, or Vertical within its Industry).
pub fn resolve_taxonomy_row(
    industry_id: &str,
    vertical_id: Option<&str>,
) -> Option<TaxonomySearchRow> {
    let industry = taxonomy()
        .iter()
        .find(|candidate| candidate.id == industry_id)?;
    match vertical_id {
        None => Some(TaxonomySearchRow {
            industry_id: industry.id.clone(),
            industry_label: industry.label.clone(),
            vertical_id: None,
            vertical_label: None,
            description: industry.description.clone(),
        }),
        Some(vertical_id) => {
            let vertical = industry
                .verticals
                .iter()
                .find(|candidate| candidate.id == vertical_id)?;
            Some(TaxonomySearchRow {
                industry_id: industry.id.clone(),
                industry_label: industry.label.clone(),
                vertical_id: Some(vertical.id.clone()),
                vertical_label: Some(vertical.label.clone()),
                description: vertical.description.clone(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn parity_hash_pins_the_exact_canonical_bytes() {
        let digest = Sha256::digest(BUSINESS_TAXONOMY_JSON.as_bytes());
        assert_eq!(hex::encode(digest), BUSINESS_TAXONOMY_PARITY_HASH);
    }

    #[test]
    fn taxonomy_shape_is_bounded_and_nonempty() {
        let all = business_taxonomy();
        assert!(!all.is_empty());
        let verticals: usize = all.iter().map(|i| i.verticals.len()).sum();
        assert_eq!(all.len(), 34);
        assert_eq!(verticals, 531);
        for industry in all {
            assert!(
                !industry.id.is_empty()
                    && industry
                        .id
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            );
            assert!(!industry.label.is_empty());
            for vertical in &industry.verticals {
                assert!(!vertical.id.is_empty());
                assert!(!vertical.label.is_empty());
            }
        }
    }

    #[test]
    fn search_is_case_insensitive_prefix_then_substring() {
        let top = search_taxonomy("DEN", 20);
        assert!(!top.is_empty());
        assert!(top[0].entity_label().to_lowercase().contains("den"));
        // Deterministic across calls.
        assert_eq!(top, search_taxonomy("den", 20));
    }

    #[test]
    fn vertical_entity_ids_carry_their_parent_industry() {
        let first = &business_taxonomy()[0];
        let vertical = &first.verticals[0];
        let row = resolve_taxonomy_row(&first.id, Some(&vertical.id)).expect("vertical");
        assert_eq!(row.entity_id(), format!("{}/{}", first.id, vertical.id));
        let industry_row = resolve_taxonomy_row(&first.id, None).expect("industry");
        assert_eq!(industry_row.entity_id(), first.id);
        for industry in business_taxonomy() {
            for vertical in &industry.verticals {
                assert!(
                    !vertical.id.contains('/'),
                    "slash is the composite separator"
                );
            }
        }
    }

    #[test]
    fn search_is_bounded() {
        // "e" matches most rows; the result must stay at the bound.
        assert_eq!(search_taxonomy("e", 5).len(), 5);
        assert!(search_taxonomy("e", usize::MAX).len() <= DISCOVERY_ENTITY_SEARCH_LIMIT);
    }

    #[test]
    fn empty_query_returns_nothing() {
        assert!(search_taxonomy("", 10).is_empty());
        assert!(search_taxonomy("   ", 10).is_empty());
    }

    #[test]
    fn resolve_round_trips_industry_and_vertical_ids() {
        let first = &business_taxonomy()[0];
        let row = resolve_taxonomy_row(&first.id, None).expect("industry");
        assert_eq!(row.entity_id(), first.id);
        let vertical = &first.verticals[0];
        let row = resolve_taxonomy_row(&first.id, Some(&vertical.id)).expect("vertical");
        assert_eq!(row.industry_id, first.id);
        assert!(resolve_taxonomy_row("not-a-real-industry", None).is_none());
    }

    #[test]
    fn entity_ref_validation_accepts_only_strict_shapes() {
        use crate::discovery_workspace::{DiscoveryEntityKind, DiscoveryEntityRef};
        let good = |kind: DiscoveryEntityKind, id: &str| {
            DiscoveryEntityRef::validate(&DiscoveryEntityRef {
                kind,
                id: id.to_string(),
            })
            .is_ok()
        };
        assert!(good(DiscoveryEntityKind::Industry, "healthcare"));
        assert!(!good(DiscoveryEntityKind::Industry, "Healthcare"));
        assert!(!good(DiscoveryEntityKind::Vertical, "dentists"));
        assert!(good(DiscoveryEntityKind::Vertical, "healthcare/dentists"));
        assert!(!good(
            DiscoveryEntityKind::Vertical,
            "healthcare/dentists/x"
        ));
        assert!(!good(DiscoveryEntityKind::Lead, "healthcare"));
        assert!(good(
            DiscoveryEntityKind::Lead,
            &uuid::Uuid::new_v4().to_string()
        ));
        assert!(!good(DiscoveryEntityKind::Run, "zz"));
        // Invalid UTF-8-ish control characters never enter the strict shape.
        assert!(!good(DiscoveryEntityKind::CampaignLeads, "abc\n"));
    }

    #[test]
    fn invalid_query_is_rejected_not_swallowed() {
        assert!(validate_search_query("").is_err());
        assert!(validate_search_query(" lead ").is_err());
        assert!(validate_search_query(&"x".repeat(MAX_QUERY_BYTES + 1)).is_err());
        assert!(validate_search_query("dentists").is_ok());
    }
}
