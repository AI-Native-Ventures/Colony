//! Tenant-scoped private Blossom Website lifecycle proof.
//!
//! This feature-gated module is ignored by the ordinary localhost website
//! suite and must be run only against the dedicated WSS-configured,
//! Host-routed relay fixture. The files are included into one integration-test
//! module so Cargo does not discover them as independent test targets.

use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use sha2::{Digest, Sha256};

include!("tenant_transport.rs");
include!("artifacts.rs");
include!("lifecycle.rs");
