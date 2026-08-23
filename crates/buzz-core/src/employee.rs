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
    /// The `retire` tag on an update request carries a value other than
    /// `true`. Presence with any other value would let one surface read the
    /// request as a retirement and another as a rank change.
    InvalidRetireFlag(String),
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
            Self::InvalidRetireFlag(value) => {
                write!(
                    f,
                    "retire must be the literal `true` when present, got: {value}"
                )
            }
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
    /// The agent this employee reports to (64-char lowercase hex pubkey), or
    /// `None` when the hire starts with no manager. A tag, not content: the
    /// relay's delete-protection rule has to query for an agent's reports,
    /// and tags are what the relay indexes. Validated by the broker against
    /// the ladder (one rung up, resolvable in this community); parsing here
    /// only enforces shape.
    pub manager: Option<String>,
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
    /// The agent this employee reports to (64-char lowercase hex pubkey), or
    /// `None` when there is no manager. The tag is authoritative; any content
    /// mirror is for client convenience only.
    pub manager: Option<String>,
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

/// The optional `manager` tag shared by hire requests (9045), employee heads
/// (30190), owner-authored managed-agent heads (30177) and update requests
/// (9046): at most one, 64 hex characters. Absent means no manager.
fn manager(event: &nostr::Event) -> Result<Option<String>, EmployeeParseError> {
    match crate::event_tags::optional_tag(event, "manager") {
        Ok(Some(value)) => Ok(Some(hex64("manager", &value)?)),
        Ok(None) | Err(TagLookupError::Missing) => Ok(None),
        Err(TagLookupError::Duplicate) => Err(EmployeeParseError::DuplicateTag("manager")),
    }
}

/// Read a hire request. Does not check that the signer is an owner: that is
/// the relay's decision, made against its own membership table.
pub fn parse_hire_request(event: &nostr::Event) -> Result<ParsedHireRequest, EmployeeParseError> {
    let (role_id, display_name) = role_and_name(event)?;
    Ok(ParsedHireRequest {
        role_id,
        display_name,
        rank: rank(event)?,
        manager: manager(event)?,
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
        manager: manager(event)?,
    })
}

/// A community owner's request to change an existing employee: kind 9046.
///
/// Carries the employee's pubkey in the `p` tag and AT LEAST ONE of a new
/// `rank` or a new `manager`; a bare no-op request would make "did my update
/// land?" undecidable for the caller. `retire` is mutually exclusive with
/// both -- retiring an employee is not also a re-rank -- and must be the
/// literal `true` so no surface can read the same event two ways.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedEmployeeUpdate {
    /// The employee being changed, from the `p` tag.
    pub pubkey_hex: String,
    /// The new rank, when the request changes it.
    pub rank: Option<AgentTier>,
    /// The new manager (64-char lowercase hex), when the request sets one.
    /// Clearing happens implicitly: promoting to executive drops any current
    /// manager, because an executive must never carry one.
    pub manager: Option<String>,
    /// Retire the employee instead of re-ranking or re-assigning them.
    pub retire: bool,
}

/// Read an employee-update request. Does not check that the signer is an
/// owner, that the target exists, or that the new edge sits on the ladder:
/// those are relay decisions with access to membership and the employees
/// table (`employee_broker::enforce_employee_update`).
pub fn parse_employee_update(
    event: &nostr::Event,
) -> Result<ParsedEmployeeUpdate, EmployeeParseError> {
    let pubkey_hex = hex64("p", &single_tag(event, "p")?)?;
    let parsed_rank = optional_rank(event)?;
    let parsed_manager = manager(event)?;
    let retire = match crate::event_tags::optional_tag(event, "retire")
        .map_err(|_| EmployeeParseError::DuplicateTag("retire"))?
    {
        Some(value) if value == "true" => true,
        Some(value) => return Err(EmployeeParseError::InvalidRetireFlag(value)),
        None => false,
    };

    if !retire && parsed_rank.is_none() && parsed_manager.is_none() {
        // A bare no-op request would make "did my update land?" undecidable;
        // naming `rank` (the first field the caller should have set) matches
        // how a missing required tag is reported elsewhere.
        return Err(EmployeeParseError::MissingTag("rank"));
    }
    if retire && (parsed_rank.is_some() || parsed_manager.is_some()) {
        // Retiring is not also a re-rank or a re-assignment: one request,
        // one decision about one person.
        return Err(EmployeeParseError::DuplicateTag("rank"));
    }

    Ok(ParsedEmployeeUpdate {
        pubkey_hex,
        rank: parsed_rank,
        manager: parsed_manager,
        retire,
    })
}

/// An OPTIONAL `rank` tag on an update request: absent means "keep the
/// current rank", present-but-unknown is refused rather than ignored.
fn optional_rank(event: &nostr::Event) -> Result<Option<AgentTier>, EmployeeParseError> {
    match single_tag(event, "rank") {
        Ok(raw) => AgentTier::parse(&raw)
            .map(Some)
            .ok_or(EmployeeParseError::UnknownRank(raw)),
        Err(EmployeeParseError::MissingTag(_)) => Ok(None),
        Err(other) => Err(other),
    }
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

    const MANAGER: &str = "3333333333333333333333333333333333333333333333333333333333333333";

    #[test]
    fn reads_an_optional_manager_tag_on_a_hire_request() {
        let mut tags = hire_tags();
        tags.push(vec!["manager", MANAGER]);
        let parsed = parse_hire_request(&event(tags)).unwrap();
        assert_eq!(parsed.manager.as_deref(), Some(MANAGER));
    }

    #[test]
    fn a_hire_request_without_a_manager_has_none() {
        let parsed = parse_hire_request(&event(hire_tags())).unwrap();
        assert_eq!(parsed.manager, None);
    }

    #[test]
    fn normalizes_and_validates_the_manager_hex_on_a_hire_request() {
        // Uppercase is accepted and folded, matching `hex64` everywhere else.
        let upper = MANAGER.to_ascii_uppercase();
        let mut tags = hire_tags();
        tags.push(vec!["manager", &upper]);
        let parsed = parse_hire_request(&event(tags)).unwrap();
        assert_eq!(parsed.manager.as_deref(), Some(MANAGER));

        let mut short = hire_tags();
        short.push(vec!["manager", "abcd"]);
        assert_eq!(
            parse_hire_request(&event(short)).unwrap_err(),
            EmployeeParseError::InvalidHex("manager")
        );
    }

    #[test]
    fn rejects_two_manager_tags_on_one_hire_request() {
        let mut tags = hire_tags();
        tags.push(vec!["manager", MANAGER]);
        tags.push(vec!["manager", PK]);
        assert_eq!(
            parse_hire_request(&event(tags)).unwrap_err(),
            EmployeeParseError::DuplicateTag("manager")
        );
    }

    #[test]
    fn reads_a_well_formed_employee_head_with_a_manager_tag() {
        let mut tags = head_tags(PK, OWNER, HIRE);
        tags.push(vec!["manager", MANAGER]);
        let parsed = parse_employee_head(&event(tags)).unwrap();
        assert_eq!(parsed.rank, AgentTier::Executive);
        assert_eq!(parsed.manager.as_deref(), Some(MANAGER));
    }

    fn update_event(tags: Vec<Vec<&str>>) -> nostr::Event {
        event(tags)
    }

    fn update_tags() -> Vec<Vec<&'static str>> {
        vec![vec!["p", PK], vec!["rank", "leader"]]
    }

    #[test]
    fn reads_a_rank_only_update_request() {
        let parsed = parse_employee_update(&update_event(update_tags())).unwrap();
        assert_eq!(parsed.pubkey_hex, PK);
        assert_eq!(parsed.rank, Some(AgentTier::Leader));
        assert_eq!(parsed.manager, None);
        assert!(!parsed.retire);
    }

    #[test]
    fn reads_a_manager_only_update_request() {
        let parsed =
            parse_employee_update(&update_event(vec![vec!["p", PK], vec!["manager", MANAGER]]))
                .unwrap();
        assert_eq!(parsed.rank, None);
        assert_eq!(parsed.manager.as_deref(), Some(MANAGER));
        assert!(!parsed.retire);
    }

    #[test]
    fn refuses_an_update_that_changes_nothing() {
        let err = parse_employee_update(&update_event(vec![vec!["p", PK]])).unwrap_err();
        assert_eq!(err, EmployeeParseError::MissingTag("rank"));
    }

    #[test]
    fn reads_a_retirement_request() {
        let parsed =
            parse_employee_update(&update_event(vec![vec!["p", PK], vec!["retire", "true"]]))
                .unwrap();
        assert!(parsed.retire);
        assert_eq!(parsed.rank, None);
        assert_eq!(parsed.manager, None);
    }

    #[test]
    fn a_retirement_is_not_also_a_re_rank_or_reassignment() {
        for extra in [vec!["rank", "leader"], vec!["manager", MANAGER]] {
            let mut tags = vec![vec!["p", PK], vec!["retire", "true"]];
            tags.push(extra);
            assert_eq!(
                parse_employee_update(&update_event(tags)).unwrap_err(),
                EmployeeParseError::DuplicateTag("rank")
            );
        }
    }

    #[test]
    fn refuses_a_retire_flag_that_is_not_true() {
        // A truthy-looking value would let one surface read this as a
        // retirement and another as a no-op.
        let err = parse_employee_update(&update_event(vec![vec!["p", PK], vec!["retire", "1"]]))
            .unwrap_err();
        assert!(matches!(err, EmployeeParseError::InvalidRetireFlag(_)));
    }

    #[test]
    fn refuses_an_update_target_that_is_not_a_pubkey() {
        let err = parse_employee_update(&update_event(vec![
            vec!["p", "sift"],
            vec!["rank", "leader"],
        ]))
        .unwrap_err();
        assert_eq!(err, EmployeeParseError::InvalidHex("p"));
    }

    #[test]
    fn refuses_an_unknown_new_rank_on_an_update() {
        let err =
            parse_employee_update(&update_event(vec![vec!["p", PK], vec!["rank", "founder"]]))
                .unwrap_err();
        assert_eq!(err, EmployeeParseError::UnknownRank("founder".to_string()));
    }
}
