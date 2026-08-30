//! The Company Actions an approved Blueprint produces.
//!
//! Defined in the SDK, not here: the CLI publishes the same actions, and one
//! envelope built two ways is the failure this module was created to avoid.

pub use buzz_sdk_pkg::company_blueprint::{
    company_action, initiative_actions, sign_action, ExistingProfileHead,
};

#[cfg(test)]
#[path = "actions_tests.rs"]
mod actions_tests;
