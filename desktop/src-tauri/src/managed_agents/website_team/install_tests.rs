use super::find_scoped_chief_of_staff;
use crate::managed_agents::ManagedAgentRecord;

fn record(
    pubkey: &str,
    role_id: Option<&str>,
    provisioned: Option<&str>,
    owner: &str,
    relay: &str,
) -> ManagedAgentRecord {
    ManagedAgentRecord {
        pubkey: pubkey.to_string(),
        role_id: role_id.map(str::to_string),
        provisioned: provisioned.map(str::to_string),
        owner_pubkey: Some(owner.to_string()),
        relay_url: relay.to_string(),
        ..Default::default()
    }
}

#[test]
fn scoped_chief_lookup_reuses_the_existing_role_holder() {
    let owner = "a".repeat(64);
    let mut holder = record(
        &"b".repeat(64),
        Some("chief-of-staff"),
        None,
        &owner,
        "wss://relay.example/",
    );
    holder.tier = Some("executive".to_owned());
    let records = [holder];

    assert_eq!(
        find_scoped_chief_of_staff(&records, &owner, "wss://relay.example"),
        Ok(Some("b".repeat(64)))
    );
}

#[test]
fn scoped_chief_lookup_rejects_duplicates_and_cross_scope_rows() {
    let owner = "a".repeat(64);
    let records = [
        record(
            &"b".repeat(64),
            Some("chief-of-staff"),
            None,
            &owner,
            "wss://relay.example",
        ),
        record(
            &"c".repeat(64),
            None,
            Some("chief-of-staff"),
            &owner,
            "wss://other.example",
        ),
        record(
            &"d".repeat(64),
            None,
            Some("chief-of-staff"),
            &owner,
            "wss://relay.example",
        ),
    ];

    let error = find_scoped_chief_of_staff(&records, &owner, "wss://relay.example")
        .expect_err("two same-scope candidates must fail closed");
    assert!(error.contains("more than one Chief of Staff"), "{error}");
}

#[test]
fn scoped_chief_lookup_does_not_guess_when_the_scope_has_no_holder() {
    let owner = "a".repeat(64);
    let records = [record(
        &"b".repeat(64),
        Some("chief-of-staff"),
        None,
        &owner,
        "wss://other.example",
    )];

    assert_eq!(
        find_scoped_chief_of_staff(&records, &owner, "wss://relay.example"),
        Ok(None)
    );
}

#[test]
fn scoped_chief_lookup_refuses_an_untiered_or_nonexecutive_holder() {
    let owner = "a".repeat(64);
    let untiered = [record(
        &"b".repeat(64),
        Some("chief-of-staff"),
        None,
        &owner,
        "wss://relay.example",
    )];
    assert_eq!(
        find_scoped_chief_of_staff(&untiered, &owner, "wss://relay.example"),
        Ok(None)
    );

    let mut nonexecutive = untiered[0].clone();
    nonexecutive.tier = Some("leader".to_owned());
    assert_eq!(
        find_scoped_chief_of_staff(&[nonexecutive], &owner, "wss://relay.example"),
        Ok(None)
    );
}

#[test]
fn scoped_chief_lookup_rejects_conflicting_provenance_and_invalid_keys() {
    let owner = "a".repeat(64);
    let conflicting = [record(
        &"b".repeat(64),
        Some("website-manager"),
        Some("chief-of-staff"),
        &owner,
        "wss://relay.example",
    )];
    let error = find_scoped_chief_of_staff(&conflicting, &owner, "wss://relay.example")
        .expect_err("conflicting role and handle must fail closed");
    assert!(error.contains("conflicting"), "{error}");

    let invalid = [record(
        "not-a-pubkey",
        Some("chief-of-staff"),
        None,
        &owner,
        "wss://relay.example",
    )];
    let error = find_scoped_chief_of_staff(&invalid, &owner, "wss://relay.example")
        .expect_err("an invalid role-holder identity must fail closed");
    assert!(error.contains("setup is incomplete"), "{error}");
}
