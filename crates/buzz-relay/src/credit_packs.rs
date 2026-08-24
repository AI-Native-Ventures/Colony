//! Credit packs: what a top-up costs, per currency, with no conversion.
//!
//! Colony sells **Credits**, not dollars. That distinction is the whole
//! point of this module, and it is what keeps foreign exchange out of the
//! codebase entirely.
//!
//! A pack carries an explicit price in every currency Colony can be paid in,
//! plus the Credits it grants. None of those numbers is computed from any
//! other. PayFast is charged [`CreditPack::zar_cents`] because PayFast bills
//! only in Rands; Paystack is charged [`CreditPack::usd_cents`]. Settlement
//! grants [`CreditPack::grant_nanousd`] regardless of which was paid.
//!
//! The alternative, quoting one price and converting at a rate, puts the
//! currency risk on Colony: the Rand moves between the charge and the
//! settlement, and the difference is a loss nobody chose to take. Rates move
//! every second and can spike without warning, so there is no value of that
//! rate, however sourced, that makes it safe. Prices here are decisions,
//! changed deliberately, and a Rand move does not change any of them.
//!
//! ## Setting prices
//!
//! Each pack's ZAR price must comfortably exceed what its granted Credits
//! cost Colony to honour, because that spread is the only cushion against
//! the Rand moving between price reviews. The defaults below hold at least
//! R20 per granted dollar against a spot nearer R18, so the Rand would have
//! to move about 11% before the cheapest pack stopped covering itself.
//!
//! Review the spread when the Rand moves materially. It is a pricing
//! decision, not an operational one, and nothing breaks while it waits.

use serde::Serialize;

/// NanoUSD in one US cent. Mirrors `payments_provider::NANO_USD_PER_CENT`.
const NANO_USD_PER_CENT: i64 = 10_000_000;

/// What one top-up costs and what it grants.
///
/// Every price is stated, never derived. Two packs may have any relationship
/// between their prices; nothing here assumes a consistent ratio, because a
/// consistent ratio is exactly what an exchange rate is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditPack {
    /// Stable identifier the client sends at initialize time. The client
    /// names a pack, never a price: a client that could name its own price
    /// could name zero.
    pub id: &'static str,
    /// Shown above the price. Not parsed.
    pub name: &'static str,
    /// Price in ZAR cents, charged by PayFast.
    pub zar_cents: i64,
    /// Price in USD cents, charged by Paystack.
    pub usd_cents: i64,
    /// Credits granted on settlement, in ledger nanoUSD. Independent of
    /// which currency was actually paid.
    pub grant_nanousd: i64,
}

impl CreditPack {
    /// The price to charge a provider billing in `currency`.
    pub fn price_in(&self, currency: Currency) -> i64 {
        match currency {
            Currency::Zar => self.zar_cents,
            Currency::Usd => self.usd_cents,
        }
    }
}

/// A currency a provider bills in. Deliberately tiny: this exists so a
/// provider's billing currency is a type rather than a comment, after a
/// version of this code sent dollars into a field PayFast reads as Rands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Currency {
    /// South African Rand. PayFast bills only in this.
    Zar,
    /// US Dollar. Paystack bills Colony in this.
    Usd,
}

impl Currency {
    /// ISO 4217 code, for logs and for the intent row.
    pub fn code(self) -> &'static str {
        match self {
            Currency::Zar => "ZAR",
            Currency::Usd => "USD",
        }
    }
}

/// The packs on sale.
///
/// Ordered cheapest first; the client renders them in this order. Grants
/// step up faster than prices, so a larger pack is better value, which is
/// the only relationship between these numbers that is intentional.
pub const CREDIT_PACKS: &[CreditPack] = &[
    CreditPack {
        id: "starter",
        name: "Starter",
        zar_cents: 11_900,
        usd_cents: 699,
        grant_nanousd: 500 * NANO_USD_PER_CENT,
    },
    CreditPack {
        id: "growth",
        name: "Growth",
        zar_cents: 29_900,
        usd_cents: 1_799,
        grant_nanousd: 1_400 * NANO_USD_PER_CENT,
    },
    CreditPack {
        id: "scale",
        name: "Scale",
        zar_cents: 89_900,
        usd_cents: 5_499,
        grant_nanousd: 4_400 * NANO_USD_PER_CENT,
    },
];

/// Resolve a client-supplied pack id.
///
/// `None` for anything unrecognised: an unknown id is a client bug or a
/// tampered request, and both must fail rather than fall back to a default
/// that charges someone the wrong amount.
pub fn find_pack(id: &str) -> Option<&'static CreditPack> {
    CREDIT_PACKS.iter().find(|pack| pack.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pack_covers_what_it_grants() {
        // The guard that makes this table safe without an exchange rate:
        // each pack must take in at least R20 for every granted dollar, so
        // the Rand can move against us before any pack sells at a loss.
        // A price edit that breaks this fails here rather than in banking.
        const MIN_ZAR_CENTS_PER_GRANTED_USD: i64 = 2_000;
        for pack in CREDIT_PACKS {
            let granted_usd = pack.grant_nanousd / (NANO_USD_PER_CENT * 100);
            assert!(
                granted_usd > 0,
                "{}: grants less than a dollar; the ratio below is meaningless",
                pack.id
            );
            let cover = pack.zar_cents / granted_usd;
            assert!(
                cover >= MIN_ZAR_CENTS_PER_GRANTED_USD,
                "{}: R{:.2} per granted dollar is below the R20.00 floor",
                pack.id,
                cover as f64 / 100.0
            );
        }
    }

    #[test]
    fn a_bigger_pack_is_never_worse_value() {
        // Packs are listed cheapest first and must improve as they grow,
        // or the table quietly punishes the customers who spend most.
        let mut previous: Option<(i64, &str)> = None;
        for pack in CREDIT_PACKS {
            let granted_cents = pack.grant_nanousd / NANO_USD_PER_CENT;
            let zar_per_credit_cent = pack.zar_cents * 1_000 / granted_cents;
            if let Some((previous_rate, previous_id)) = previous {
                assert!(
                    zar_per_credit_cent <= previous_rate,
                    "{} is worse value than {}",
                    pack.id,
                    previous_id
                );
            }
            previous = Some((zar_per_credit_cent, pack.id));
        }
    }

    #[test]
    fn prices_are_positive_and_ids_unique() {
        let mut seen = std::collections::HashSet::new();
        for pack in CREDIT_PACKS {
            assert!(pack.zar_cents > 0, "{}: non-positive ZAR price", pack.id);
            assert!(pack.usd_cents > 0, "{}: non-positive USD price", pack.id);
            assert!(pack.grant_nanousd > 0, "{}: grants nothing", pack.id);
            assert!(seen.insert(pack.id), "{}: duplicate pack id", pack.id);
        }
    }

    #[test]
    fn an_unknown_pack_id_resolves_to_nothing() {
        assert_eq!(find_pack("starter").map(|pack| pack.id), Some("starter"));
        // No default, no nearest match: charging the wrong pack is worse
        // than refusing the request.
        assert!(find_pack("").is_none());
        assert!(find_pack("STARTER").is_none());
        assert!(find_pack("enterprise").is_none());
    }

    #[test]
    fn a_pack_is_priced_in_the_currency_the_provider_bills() {
        let pack = find_pack("growth").expect("growth exists");
        assert_eq!(pack.price_in(Currency::Zar), 29_900);
        assert_eq!(pack.price_in(Currency::Usd), 1_799);
        // The two prices are unrelated numbers. If this ever holds, someone
        // has reintroduced a conversion.
        assert_ne!(pack.price_in(Currency::Zar), pack.price_in(Currency::Usd));
    }
}
