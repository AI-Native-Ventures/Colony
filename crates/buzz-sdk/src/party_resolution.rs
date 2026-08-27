//! Deciding whether an observation is someone the company already knows.
//!
//! This is the function Discovery leans on, and the one that decides whether a
//! business ends up as one record or two. It is deliberately conservative:
//!
//! - A match is an exact agreement on a **typed** identifier. Text that happens
//!   to appear under two different schemes is two different claims.
//! - Names are never evidence. Two businesses can share a name, and a merge
//!   undertaken on that basis is far more expensive to undo than a duplicate is
//!   to merge.
//! - More than one candidate is `Ambiguous`, never a pick. A wrong automatic
//!   merge quietly fuses two customers' histories, and nothing downstream can
//!   tell that it happened.
//!
//! Pure: no clock, no randomness, no I/O. The same inputs always produce the
//! same answer, so a disputed resolution can be re-run and argued about.

use std::collections::BTreeSet;

use buzz_core::party::{Party, PartyIdentifier};

/// What an observation resolved to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PartyResolution {
    /// Nothing known shares a typed identifier with the observation.
    NoMatch,
    /// Exactly one known party shares a typed identifier.
    Resolved {
        /// The handle the observation belongs to.
        handle: String,
        /// The claim that settled it, for the record and for the audit trail.
        on: PartyIdentifier,
    },
    /// Several known parties share identifiers with the observation.
    ///
    /// A human decides. Either the candidates are genuinely the same party and
    /// should be merged first, or the observation carries an identifier that
    /// does not belong to it.
    Ambiguous {
        /// Every candidate handle, ordered so the answer is stable.
        candidates: Vec<String>,
    },
}

/// Resolve an observation against the parties a company already holds.
///
/// `known` must contain live parties only. A retired handle is an alias, not a
/// party, and resolving onto one would write to a coordinate that now only
/// redirects.
pub fn resolve_observation(observed: &[PartyIdentifier], known: &[Party]) -> PartyResolution {
    let mut candidates: BTreeSet<&str> = BTreeSet::new();
    let mut first_match: Option<(&str, &PartyIdentifier)> = None;

    for party in known {
        for claim in &party.identifiers {
            let matched = observed.iter().find(|candidate| {
                // Scheme first: this is the whole point. `acme.example` as a
                // domain and as an email are different assertions about the
                // world, and only one of them may be true.
                candidate.scheme == claim.scheme && candidate.value == claim.value
            });
            if let Some(matched) = matched {
                if candidates.insert(party.id.as_str()) && first_match.is_none() {
                    first_match = Some((party.id.as_str(), matched));
                }
            }
        }
    }

    match candidates.len() {
        0 => PartyResolution::NoMatch,
        1 => {
            let handle = candidates.iter().next().copied().unwrap_or_default();
            // `first_match` is the claim that produced the single candidate, so
            // the reason for the decision travels with it.
            let on = first_match
                .filter(|(id, _)| *id == handle)
                .map(|(_, claim)| claim.clone());
            match on {
                Some(on) => PartyResolution::Resolved {
                    handle: handle.to_owned(),
                    on,
                },
                None => PartyResolution::NoMatch,
            }
        }
        _ => PartyResolution::Ambiguous {
            candidates: candidates.into_iter().map(str::to_owned).collect(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::party::{
        IdentifierConfidence, IdentifierScheme, PartyKind, ProvenanceEntry, PARTY_SCHEMA,
    };

    fn identifier(scheme: IdentifierScheme, value: &str) -> PartyIdentifier {
        PartyIdentifier {
            scheme,
            value: value.to_string(),
            confidence: IdentifierConfidence::Asserted,
        }
    }

    fn party(id: &str, display_name: &str, identifiers: Vec<PartyIdentifier>) -> Party {
        Party {
            schema: PARTY_SCHEMA.to_string(),
            id: id.to_string(),
            kind: PartyKind::Organization,
            display_name: display_name.to_string(),
            legal_name: None,
            identifiers,
            provenance: vec![ProvenanceEntry {
                id: "prov-01".to_string(),
                source: "discovery:google-maps".to_string(),
                observed_at: 1_785_369_600,
                source_ref: None,
                fields: vec!["displayName".to_string()],
            }],
            retired_handles: Vec::new(),
            created_at: 1_785_369_600,
            updated_at: 1_785_369_600,
        }
    }

    #[test]
    fn an_exact_typed_match_resolves_and_says_what_settled_it() {
        let known = vec![party(
            "acme-industries",
            "Acme Industries",
            vec![identifier(IdentifierScheme::Domain, "acme.example")],
        )];
        let observed = vec![
            identifier(IdentifierScheme::Domain, "acme.example"),
            identifier(IdentifierScheme::Phone, "+27115550000"),
        ];
        assert_eq!(
            resolve_observation(&observed, &known),
            PartyResolution::Resolved {
                handle: "acme-industries".to_string(),
                on: identifier(IdentifierScheme::Domain, "acme.example"),
            }
        );
    }

    /// The same text under two schemes is two assertions about the world, and
    /// treating them as one is how a supplier's domain merges a customer into it.
    #[test]
    fn matching_text_under_a_different_scheme_is_not_a_match() {
        let known = vec![party(
            "acme-industries",
            "Acme Industries",
            vec![identifier(IdentifierScheme::Domain, "acme.example")],
        )];
        let observed = vec![identifier(IdentifierScheme::Email, "acme.example")];
        assert_eq!(
            resolve_observation(&observed, &known),
            PartyResolution::NoMatch
        );
    }

    /// Two businesses can share a name. A merge made on that basis fuses two
    /// customers' histories, and nothing downstream can tell it happened.
    #[test]
    fn an_identical_name_is_never_evidence() {
        let known = vec![party(
            "acme-industries",
            "Acme Industries",
            vec![identifier(IdentifierScheme::Domain, "acme.example")],
        )];
        let observed = vec![identifier(IdentifierScheme::Domain, "acme-other.example")];
        assert_eq!(
            resolve_observation(&observed, &known),
            PartyResolution::NoMatch
        );
    }

    #[test]
    fn several_candidates_are_a_decision_not_a_pick() {
        let known = vec![
            party(
                "acme-industries",
                "Acme Industries",
                vec![identifier(IdentifierScheme::Domain, "acme.example")],
            ),
            party(
                "acme-holdings",
                "Acme Holdings",
                vec![identifier(IdentifierScheme::Phone, "+27115550000")],
            ),
        ];
        let observed = vec![
            identifier(IdentifierScheme::Domain, "acme.example"),
            identifier(IdentifierScheme::Phone, "+27115550000"),
        ];
        assert_eq!(
            resolve_observation(&observed, &known),
            PartyResolution::Ambiguous {
                candidates: vec!["acme-holdings".to_string(), "acme-industries".to_string(),],
            }
        );
    }

    #[test]
    fn nothing_known_and_nothing_observed_both_resolve_to_nothing() {
        let known = vec![party(
            "acme-industries",
            "Acme Industries",
            vec![identifier(IdentifierScheme::Domain, "acme.example")],
        )];
        assert_eq!(resolve_observation(&[], &known), PartyResolution::NoMatch);
        assert_eq!(
            resolve_observation(&[identifier(IdentifierScheme::Domain, "acme.example")], &[]),
            PartyResolution::NoMatch
        );
    }

    /// A disputed resolution has to be re-runnable and argued about, so the
    /// answer cannot depend on iteration order or on when it was asked.
    #[test]
    fn resolution_is_deterministic_regardless_of_input_order() {
        let a = party(
            "acme-industries",
            "Acme Industries",
            vec![identifier(IdentifierScheme::Domain, "acme.example")],
        );
        let b = party(
            "acme-holdings",
            "Acme Holdings",
            vec![identifier(IdentifierScheme::Phone, "+27115550000")],
        );
        let observed = vec![
            identifier(IdentifierScheme::Phone, "+27115550000"),
            identifier(IdentifierScheme::Domain, "acme.example"),
        ];
        assert_eq!(
            resolve_observation(&observed, &[a.clone(), b.clone()]),
            resolve_observation(&observed, &[b, a]),
        );
    }

    #[test]
    fn one_party_matching_on_several_claims_is_still_one_candidate() {
        let known = vec![party(
            "acme-industries",
            "Acme Industries",
            vec![
                identifier(IdentifierScheme::Domain, "acme.example"),
                identifier(IdentifierScheme::Phone, "+27115550000"),
            ],
        )];
        let observed = vec![
            identifier(IdentifierScheme::Domain, "acme.example"),
            identifier(IdentifierScheme::Phone, "+27115550000"),
        ];
        assert!(matches!(
            resolve_observation(&observed, &known),
            PartyResolution::Resolved { .. }
        ));
    }
}
