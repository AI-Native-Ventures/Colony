//! Company creation: turning an approved Blueprint into a real company.

pub mod actions;
pub mod seed;
pub mod transaction;

/// Drives materialization against a relay that is actually running. Ignored
/// unless the environment names one; see the module for how to run it.
#[cfg(test)]
mod live_proof_tests;
