//! Signing Colony's model price feed.
//!
//! The relay ships a price catalog and re-applies it on every startup, which
//! means a vendor's price change reaches companies when we deploy. Vendors do
//! not schedule promotions around our release train, so relays can also fetch
//! a signed feed: the same catalog document, signed once here and served as a
//! static file.
//!
//! This command is the publishing half. It is deliberately local: it never
//! touches a relay, and it does not use `BUZZ_PRIVATE_KEY`. The publisher key
//! decides what every Colony company is billed, so it is a maintainer secret
//! rather than an agent identity. Conflating the two would mean any agent key
//! that leaked could also set prices.
//!
//! The document format, signing and verifying alike, lives in
//! [`buzz_core::ledger::feed`]. What is here is the file and key handling
//! around it.

use buzz_core::ledger::feed::sign_feed_document;
use nostr::Keys;

use crate::error::CliError;

/// Environment variable holding the publisher's secret key.
const KEY_ENV: &str = "COLONY_PRICE_FEED_KEY";

/// Sign a catalog file into a feed document.
///
/// Writes the signed event JSON to `out`, or to stdout when `out` is `None`.
/// The publisher pubkey goes to stderr, because it is what an operator pins
/// in `BUZZ_LEDGER_PRICE_FEED_PUBKEY` and they need it in front of them.
pub fn sign_feed(
    catalog_path: &str,
    key: Option<String>,
    out: Option<String>,
) -> Result<(), CliError> {
    let catalog = std::fs::read_to_string(catalog_path)
        .map_err(|error| CliError::Usage(format!("cannot read {catalog_path}: {error}")))?;

    let secret = match key {
        Some(value) => value,
        None => std::env::var(KEY_ENV).map_err(|_| {
            CliError::Auth(format!(
                "no publisher key: pass --key or set {KEY_ENV}. This is the price publisher's \
                 key, not BUZZ_PRIVATE_KEY"
            ))
        })?,
    };
    let keys = Keys::parse(secret.trim())
        .map_err(|error| CliError::Key(format!("invalid publisher key: {error}")))?;

    // Signing parses the catalog first, so a document relays cannot read is
    // refused here rather than discovered by every relay in production.
    let signed = sign_feed_document(&catalog, &keys)
        .map_err(|error| CliError::Usage(format!("{catalog_path}: {error}")))?;

    match out {
        Some(path) => {
            std::fs::write(&path, format!("{signed}\n"))
                .map_err(|error| CliError::Other(format!("cannot write {path}: {error}")))?;
            eprintln!("wrote the signed price feed to {path}");
        }
        None => println!("{signed}"),
    }
    eprintln!(
        "publisher pubkey: {} (pin this as BUZZ_LEDGER_PRICE_FEED_PUBKEY)",
        keys.public_key().to_hex()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::ledger::feed::verify_feed_document;

    const CATALOG: &str = r#"{"version":1,"entries":[{"model":"m",
        "effectiveFrom":"2026-01-01T00:00:00Z","inputPerMtok":"3","cacheReadPerMtok":"0.30",
        "cacheWrite5mPerMtok":"3.75","cacheWrite1hPerMtok":"6","outputPerMtok":"15"}]}"#;

    fn write_temp(name: &str, body: &str) -> String {
        let path = std::env::temp_dir().join(name);
        std::fs::write(&path, body).unwrap();
        path.to_string_lossy().into_owned()
    }

    /// What this command writes is what a relay accepts, checked by the
    /// relay's own verifier rather than by re-asserting the format here.
    #[test]
    fn the_written_document_passes_relay_verification() {
        let path = write_temp("colony-feed-ok.json", CATALOG);
        let out = write_temp("colony-feed-ok.signed.json", "");
        let keys = Keys::generate();
        sign_feed(
            &path,
            Some(keys.secret_key().to_secret_hex()),
            Some(out.clone()),
        )
        .unwrap();

        let signed = std::fs::read_to_string(&out).unwrap();
        let now = nostr::Timestamp::now().as_secs();
        let entries =
            verify_feed_document(signed.trim(), &keys.public_key().to_hex(), now, 86_400).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].rates.input_nanousd_per_mtok, 3_000_000_000);
    }

    /// Publishing the catalog we ship is the runbook's first step; it must
    /// work without editing anything.
    #[test]
    fn the_shipped_catalog_can_be_signed_as_it_stands() {
        let path = write_temp(
            "colony-feed-shipped.json",
            include_str!("../../../buzz-core/data/price-catalog.json"),
        );
        let keys = Keys::generate();
        assert!(sign_feed(&path, Some(keys.secret_key().to_secret_hex()), None).is_ok());
    }

    /// Signing a document relays will reject is the failure worth blocking:
    /// it looks published and prices nothing.
    #[test]
    fn a_malformed_catalog_is_refused_before_signing() {
        let path = write_temp("colony-feed-bad.json", r#"{"version":1,"oops":[]}"#);
        let keys = Keys::generate();
        let error = sign_feed(&path, Some(keys.secret_key().to_secret_hex()), None).unwrap_err();
        assert!(format!("{error}").contains("catalog is invalid"), "{error}");
    }

    #[test]
    fn an_empty_catalog_is_refused() {
        let path = write_temp("colony-feed-empty.json", r#"{"version":1,"entries":[]}"#);
        let keys = Keys::generate();
        let error = sign_feed(&path, Some(keys.secret_key().to_secret_hex()), None).unwrap_err();
        assert!(format!("{error}").contains("carries no prices"), "{error}");
    }

    #[test]
    fn a_missing_file_is_reported_by_name() {
        let error = sign_feed("/nonexistent/colony-feed.json", Some("x".into()), None).unwrap_err();
        assert!(
            format!("{error}").contains("/nonexistent/colony-feed.json"),
            "{error}"
        );
    }
}
