//! Company employees: workspace-owned agent identities.
//!
//! An employee is a role the company employs, not a process a member runs.
//! Its keypair is minted and held by the relay, so every member's machine can
//! produce work as that one colleague without a private key ever being copied
//! to a laptop or rotated when somebody leaves. Members supply execution; the
//! workspace supplies identity, memory, and accountability.
//!
//! This module owns the wire format for the two events that make that real:
//! an owner's hire request, and the employee head the relay publishes in
//! reply. Both are parsed here so the relay, the CLI, and the desktop agree on
//! one definition. See `docs/design/company-employees.html`.

use crate::event_tags::TagLookupError;
use crate::interrupt::AgentTier;

/// A role slug: lowercase, digits, `-` and `_`, starting alphanumeric.
///
/// Same grammar the persona role ids already use, so a hired agent and a
/// blueprint-materialized one land in the same namespace.
pub fn is_valid_role_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// Why a hire request or employee head could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmployeeParseError {
    /// A required tag is absent.
    MissingTag(&'static str),
    /// A tag that must appear exactly once appeared more than once. Duplicates
    /// are refused rather than resolved: two different values would otherwise
    /// let a filer show one thing to a reader and another to the relay.
    DuplicateTag(&'static str),
    /// The role slug does not match the accepted grammar.
    InvalidRoleSlug(String),
    /// The display name is empty or longer than the limit.
    InvalidDisplayName,
    /// The rank string is not a known tier.
    UnknownRank(String),
    /// A field that must be 64 hex characters is not.
    InvalidHex(&'static str),
}

impl std::fmt::Display for EmployeeParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingTag(tag) => write!(f, "missing required tag: {tag}"),
            Self::DuplicateTag(tag) => write!(f, "tag must appear exactly once: {tag}"),
            Self::InvalidRoleSlug(value) => write!(f, "invalid role slug: {value}"),
            Self::InvalidDisplayName => write!(f, "display name must be 1-100 characters"),
            Self::UnknownRank(value) => write!(f, "unknown rank: {value}"),
            Self::InvalidHex(field) => write!(f, "{field} must be 64 hex characters"),
        }
    }
}

impl std::error::Error for EmployeeParseError {}

const MAX_DISPLAY_NAME: usize = 100;

/// A community owner's request to employ a role.
///
/// The relay mints the keypair, so the request cannot name the pubkey it is
/// asking for: identity is the relay's answer, not the caller's assertion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedHireRequest {
    /// Stable role slug the workspace wants filled.
    pub role_id: String,
    /// The name this employee goes by.
    pub display_name: String,
    /// Where the employee sits on the interrupt ladder.
    pub rank: AgentTier,
}

/// The employee head, signed by the relay-held employee key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedEmployeeHead {
    /// The employee's own pubkey, carried in `d` so the head is a
    /// parameterized-replaceable record keyed by identity.
    pub pubkey_hex: String,
    /// Stable role slug this employee fills.
    pub role_id: String,
    /// The name this employee goes by.
    pub display_name: String,
    /// Where the employee sits on the interrupt ladder.
    pub rank: AgentTier,
    /// The owner who hired this employee.
    pub hired_by_hex: String,
    /// The hire request this head answers. Anyone can fetch it and confirm an
    /// owner asked for this employee, without trusting the head alone.
    pub hire_event_hex: String,
}

fn hex64(field: &'static str, value: &str) -> Result<String, EmployeeParseError> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.len() != 64 || !normalized.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(EmployeeParseError::InvalidHex(field));
    }
    Ok(normalized)
}

fn single_tag(event: &nostr::Event, name: &'static str) -> Result<String, EmployeeParseError> {
    crate::event_tags::single_tag(event, name).map_err(|error| match error {
        TagLookupError::Missing => EmployeeParseError::MissingTag(name),
        TagLookupError::Duplicate => EmployeeParseError::DuplicateTag(name),
    })
}

fn role_and_name(event: &nostr::Event) -> Result<(String, String), EmployeeParseError> {
    let role_id = single_tag(event, "role")?.trim().to_ascii_lowercase();
    if !is_valid_role_slug(&role_id) {
        return Err(EmployeeParseError::InvalidRoleSlug(role_id));
    }
    let display_name = single_tag(event, "name")?.trim().to_string();
    if display_name.is_empty() || display_name.chars().count() > MAX_DISPLAY_NAME {
        return Err(EmployeeParseError::InvalidDisplayName);
    }
    Ok((role_id, display_name))
}

fn rank(event: &nostr::Event) -> Result<AgentTier, EmployeeParseError> {
    let raw = single_tag(event, "rank")?;
    AgentTier::parse(&raw).ok_or(EmployeeParseError::UnknownRank(raw))
}

/// Read a hire request. Does not check that the signer is an owner: that is
/// the relay's decision, made against its own membership table.
pub fn parse_hire_request(event: &nostr::Event) -> Result<ParsedHireRequest, EmployeeParseError> {
    let (role_id, display_name) = role_and_name(event)?;
    Ok(ParsedHireRequest {
        role_id,
        display_name,
        rank: rank(event)?,
    })
}

/// Read an employee head.
pub fn parse_employee_head(event: &nostr::Event) -> Result<ParsedEmployeeHead, EmployeeParseError> {
    let (role_id, display_name) = role_and_name(event)?;
    Ok(ParsedEmployeeHead {
        pubkey_hex: hex64("d", &single_tag(event, "d")?)?,
        role_id,
        display_name,
        rank: rank(event)?,
        hired_by_hex: hex64("hired-by", &single_tag(event, "hired-by")?)?,
        hire_event_hex: hex64("e", &single_tag(event, "e")?)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    fn event(tags: Vec<Vec<&str>>) -> nostr::Event {
        let keys = Keys::generate();
        EventBuilder::new(Kind::Custom(9045), "")
            .tags(tags.into_iter().map(|t| Tag::parse(t).unwrap()))
            .sign_with_keys(&keys)
            .unwrap()
    }

    fn hire_tags() -> Vec<Vec<&'static str>> {
        vec![
            vec!["role", "sales-lead"],
            vec!["name", "Sift"],
            vec!["rank", "worker"],
        ]
    }

    #[test]
    fn reads_a_well_formed_hire_request() {
        let parsed = parse_hire_request(&event(hire_tags())).unwrap();
        assert_eq!(parsed.role_id, "sales-lead");
        assert_eq!(parsed.display_name, "Sift");
        assert_eq!(parsed.rank, AgentTier::Worker);
    }

    #[test]
    fn normalizes_role_case_so_one_role_is_one_role() {
        let parsed = parse_hire_request(&event(vec![
            vec!["role", "Sales-Lead"],
            vec!["name", "Sift"],
            vec!["rank", "worker"],
        ]))
        .unwrap();
        assert_eq!(parsed.role_id, "sales-lead");
    }

    #[test]
    fn rejects_a_role_slug_outside_the_grammar() {
        let err = parse_hire_request(&event(vec![
            vec!["role", "sales lead!"],
            vec!["name", "Sift"],
            vec!["rank", "worker"],
        ]))
        .unwrap_err();
        assert!(matches!(err, EmployeeParseError::InvalidRoleSlug(_)));
    }

    #[test]
    fn rejects_an_empty_display_name() {
        let err = parse_hire_request(&event(vec![
            vec!["role", "sales-lead"],
            vec!["name", "   "],
            vec!["rank", "worker"],
        ]))
        .unwrap_err();
        assert_eq!(err, EmployeeParseError::InvalidDisplayName);
    }

    #[test]
    fn rejects_an_unknown_rank() {
        let err = parse_hire_request(&event(vec![
            vec!["role", "sales-lead"],
            vec!["name", "Sift"],
            vec!["rank", "founder"],
        ]))
        .unwrap_err();
        assert!(matches!(err, EmployeeParseError::UnknownRank(_)));
    }

    #[test]
    fn rejects_a_duplicated_single_value_tag() {
        // Two roles in one request would let the filer show a reader one role
        // and the relay another.
        let err = parse_hire_request(&event(vec![
            vec!["role", "sales-lead"],
            vec!["role", "engineer"],
            vec!["name", "Sift"],
            vec!["rank", "worker"],
        ]))
        .unwrap_err();
        assert_eq!(err, EmployeeParseError::DuplicateTag("role"));
    }

    #[test]
    fn reports_each_missing_tag_by_name() {
        for (tags, missing) in [
            (vec![vec!["name", "Sift"], vec!["rank", "worker"]], "role"),
            (
                vec![vec!["role", "sales-lead"], vec!["rank", "worker"]],
                "name",
            ),
            (
                vec![vec!["role", "sales-lead"], vec!["name", "Sift"]],
                "rank",
            ),
        ] {
            assert_eq!(
                parse_hire_request(&event(tags)).unwrap_err(),
                EmployeeParseError::MissingTag(missing)
            );
        }
    }

    fn head_tags(
        pubkey: &'static str,
        owner: &'static str,
        hire: &'static str,
    ) -> Vec<Vec<&'static str>> {
        vec![
            vec!["d", pubkey],
            vec!["role", "sales-lead"],
            vec!["name", "Sift"],
            vec!["rank", "executive"],
            vec!["hired-by", owner],
            vec!["e", hire],
        ]
    }

    const PK: &str = "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22aa33bb44cc55dd66";
    const OWNER: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const HIRE: &str = "2222222222222222222222222222222222222222222222222222222222222222";

    #[test]
    fn reads_a_well_formed_employee_head() {
        let parsed = parse_employee_head(&event(head_tags(PK, OWNER, HIRE))).unwrap();
        assert_eq!(parsed.pubkey_hex, PK);
        assert_eq!(parsed.hired_by_hex, OWNER);
        assert_eq!(parsed.hire_event_hex, HIRE);
        assert_eq!(parsed.rank, AgentTier::Executive);
    }

    #[test]
    fn rejects_head_identity_that_is_not_a_pubkey() {
        let err = parse_employee_head(&event(head_tags("not-a-key", OWNER, HIRE))).unwrap_err();
        assert_eq!(err, EmployeeParseError::InvalidHex("d"));
    }

    #[test]
    fn rejects_a_head_with_no_hire_request_to_check() {
        // Without the referenced request nobody can confirm an owner asked
        // for this employee, so the head alone must never be enough.
        let mut tags = head_tags(PK, OWNER, HIRE);
        tags.retain(|tag| tag[0] != "e");
        assert_eq!(
            parse_employee_head(&event(tags)).unwrap_err(),
            EmployeeParseError::MissingTag("e")
        );
    }

    #[test]
    fn role_slug_grammar() {
        for good in ["a", "sales-lead", "chief_of_staff", "r2", "9lives"] {
            assert!(is_valid_role_slug(good), "{good} should be valid");
        }
        for bad in ["", "-lead", "_lead", "Sales", "sales lead", "sales.lead"] {
            assert!(!is_valid_role_slug(bad), "{bad} should be invalid");
        }
        assert!(is_valid_role_slug(&"a".repeat(64)));
        assert!(!is_valid_role_slug(&"a".repeat(65)));
    }
}
