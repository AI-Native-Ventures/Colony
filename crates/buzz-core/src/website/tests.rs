//! Shared-vector tests for the website manager contract.
//!
//! The JSON files under `testdata/website/` are the language-neutral vectors:
//! a non-Rust consumer can run the same inputs through its own implementation
//! and compare `WebsiteError::code()` values.

mod command;
mod invariants;
mod preview;
mod qa_report;
mod review;
