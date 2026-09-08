#![deny(unsafe_code)]

pub mod connection;
pub mod error;
pub mod message;
#[cfg(feature = "onboarding-fixture")]
pub mod onboarding_fixture;
pub mod pin;
pub mod transport;

pub use connection::{publish_event, NostrWsConnection};
pub use error::WsClientError;
pub use message::{build_auth_event, parse_relay_message, OkResponse, RelayMessage};
pub use pin::RelayPin;
