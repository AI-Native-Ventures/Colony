//! Owner-provided ("provisioned") records and their shared deletion guard.
//!
//! A record with `provisioned_by` set was written by a recipe this app ships
//! on the owner's behalf. The owner can use it and edit settings they own,
//! but the record itself cannot be deleted: the app updates its owned content
//! over time and guarantees its quality. The recipe id names the pack (for
//! example `website-manager`); the display name is product-level because
//! every pack the app ships is provided by Colony.

/// Product name shown in refusal copy and in the UI provenance marker.
pub const PROVISIONER_DISPLAY_NAME: &str = "Colony";

/// The delete-path refusal shared by personas, managed agents, and teams.
pub fn provisioned_deletion_error(display_name: &str) -> String {
    format!("{display_name} is provided by {PROVISIONER_DISPLAY_NAME} and cannot be deleted.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refusal_names_the_record_and_the_product() {
        assert_eq!(
            provisioned_deletion_error("Avery"),
            "Avery is provided by Colony and cannot be deleted."
        );
    }
}
