//! Shell-agnostic browser engine spike: CDP host, snapshot-first tools,
//! and a token budget for agent browser use.

pub mod budget;
pub mod cdp;
pub mod contracts;
pub mod host;
pub mod input;
pub mod journey;
pub mod mcp;
pub mod snapshot;
