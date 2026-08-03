use buzz_core_pkg::discovery_worker::DiscoveryRunSourceFailureClass;

use super::{brave::BraveError, exa::ExaError, outscraper::OutscraperError};

pub(super) const fn brave_is_uncertain(error: BraveError) -> bool {
    matches!(
        error,
        BraveError::ProviderUnavailable | BraveError::RequestTimedOut
    )
}

pub(super) const fn exa_is_uncertain(error: ExaError) -> bool {
    matches!(
        error,
        ExaError::ProviderUnavailable | ExaError::RequestTimedOut
    )
}

pub(super) const fn brave_failure(error: BraveError) -> DiscoveryRunSourceFailureClass {
    match error {
        BraveError::CredentialRejected => DiscoveryRunSourceFailureClass::CredentialRejected,
        BraveError::BillingRequired => DiscoveryRunSourceFailureClass::BillingRequired,
        BraveError::InvalidRequest => DiscoveryRunSourceFailureClass::InvalidRequest,
        BraveError::RateLimited => DiscoveryRunSourceFailureClass::RateLimited,
        BraveError::ProviderUnavailable | BraveError::ProviderFailed => {
            DiscoveryRunSourceFailureClass::ProviderUnavailable
        }
        BraveError::MalformedResponse => DiscoveryRunSourceFailureClass::MalformedResponse,
        BraveError::ResponseTooLarge => DiscoveryRunSourceFailureClass::ResponseTooLarge,
        BraveError::RequestTimedOut => DiscoveryRunSourceFailureClass::RequestTimedOut,
        BraveError::Cancelled => DiscoveryRunSourceFailureClass::Cancelled,
    }
}

pub(super) const fn exa_failure(error: ExaError) -> DiscoveryRunSourceFailureClass {
    match error {
        ExaError::CredentialRejected => DiscoveryRunSourceFailureClass::CredentialRejected,
        ExaError::BillingRequired => DiscoveryRunSourceFailureClass::BillingRequired,
        ExaError::InvalidRequest => DiscoveryRunSourceFailureClass::InvalidRequest,
        ExaError::RateLimited => DiscoveryRunSourceFailureClass::RateLimited,
        ExaError::ProviderUnavailable | ExaError::ProviderFailed => {
            DiscoveryRunSourceFailureClass::ProviderUnavailable
        }
        ExaError::MalformedResponse => DiscoveryRunSourceFailureClass::MalformedResponse,
        ExaError::ResponseTooLarge => DiscoveryRunSourceFailureClass::ResponseTooLarge,
        ExaError::RequestTimedOut => DiscoveryRunSourceFailureClass::RequestTimedOut,
        ExaError::Cancelled => DiscoveryRunSourceFailureClass::Cancelled,
    }
}

pub(super) const fn outscraper_failure(error: OutscraperError) -> DiscoveryRunSourceFailureClass {
    match error {
        OutscraperError::CredentialRejected => DiscoveryRunSourceFailureClass::CredentialRejected,
        OutscraperError::BillingRequired => DiscoveryRunSourceFailureClass::BillingRequired,
        OutscraperError::InvalidRequest => DiscoveryRunSourceFailureClass::InvalidRequest,
        OutscraperError::RateLimited => DiscoveryRunSourceFailureClass::RateLimited,
        OutscraperError::ProviderUnavailable | OutscraperError::ProviderFailed => {
            DiscoveryRunSourceFailureClass::ProviderUnavailable
        }
        OutscraperError::MalformedResponse => DiscoveryRunSourceFailureClass::MalformedResponse,
        OutscraperError::ResponseTooLarge => DiscoveryRunSourceFailureClass::ResponseTooLarge,
        OutscraperError::RequestTimedOut | OutscraperError::PollExhausted => {
            DiscoveryRunSourceFailureClass::RequestTimedOut
        }
        OutscraperError::Cancelled => DiscoveryRunSourceFailureClass::Cancelled,
    }
}
