use buzz_core_pkg::discovery::DiscoveryProvider;
use zeroize::Zeroizing;

use super::{brave::BraveSearchClient, exa::ExaSearchClient, outscraper::OutscraperClient};
use crate::discovery_credentials::{self, DiscoveryCredentialProvider};

pub(super) struct ProductionProviderClients {
    pub(super) outscraper: OutscraperClient,
    pub(super) brave: BraveSearchClient,
    pub(super) exa: ExaSearchClient,
}

impl ProductionProviderClients {
    pub(super) fn new() -> Result<Self, String> {
        Ok(Self {
            outscraper: OutscraperClient::production().map_err(|error| error.to_string())?,
            brave: BraveSearchClient::production().map_err(|error| error.to_string())?,
            exa: ExaSearchClient::production().map_err(|error| error.to_string())?,
        })
    }

    #[cfg(test)]
    pub(super) fn for_test(
        outscraper: OutscraperClient,
        brave: BraveSearchClient,
        exa: ExaSearchClient,
    ) -> Self {
        Self {
            outscraper,
            brave,
            exa,
        }
    }
}

pub(super) struct LocalProviderCredentials {
    outscraper: Option<Zeroizing<String>>,
    brave: Option<Zeroizing<String>>,
    exa: Option<Zeroizing<String>>,
}

impl LocalProviderCredentials {
    pub(super) fn load() -> Result<Self, String> {
        Ok(Self {
            outscraper: discovery_credentials::load_discovery_credential(
                DiscoveryCredentialProvider::Outscraper,
            )?,
            brave: discovery_credentials::load_discovery_credential(
                DiscoveryCredentialProvider::BraveSearch,
            )?,
            exa: discovery_credentials::load_discovery_credential(
                DiscoveryCredentialProvider::ExaSearch,
            )?,
        })
    }

    #[cfg(test)]
    pub(super) fn for_test(
        outscraper: Option<&str>,
        brave: Option<&str>,
        exa: Option<&str>,
    ) -> Self {
        Self {
            outscraper: outscraper.map(|value| Zeroizing::new(value.to_owned())),
            brave: brave.map(|value| Zeroizing::new(value.to_owned())),
            exa: exa.map(|value| Zeroizing::new(value.to_owned())),
        }
    }

    pub(super) fn available_providers(&self) -> Vec<DiscoveryProvider> {
        [
            (DiscoveryProvider::Outscraper, self.outscraper.is_some()),
            (DiscoveryProvider::BraveSearch, self.brave.is_some()),
            (DiscoveryProvider::ExaSearch, self.exa.is_some()),
        ]
        .into_iter()
        .filter_map(|(provider, available)| available.then_some(provider))
        .collect()
    }

    pub(super) fn credential(&self, provider: DiscoveryProvider) -> Option<&Zeroizing<String>> {
        match provider {
            DiscoveryProvider::Outscraper => self.outscraper.as_ref(),
            DiscoveryProvider::BraveSearch => self.brave.as_ref(),
            DiscoveryProvider::ExaSearch => self.exa.as_ref(),
        }
    }
}
