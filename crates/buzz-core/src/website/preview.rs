//! Preview manifest parsing and validation.
//!
//! A preview manifest is an immutable JSON document identified by the SHA-256
//! of its exact published bytes. It lists a relative HTML entrypoint and a
//! bounded set of files, each with a literal relative path, a public HTTPS URL,
//! an allowlisted MIME type, a byte size, and the SHA-256 of the exact bytes.
//!
//! Everything in this module is pure validation. It never resolves a hostname,
//! follows a redirect, or downloads a byte; those checks are Phase 2
//! obligations listed in `docs/website-manager-protocol.md`.

use std::collections::{BTreeMap, BTreeSet};
use std::net::IpAddr;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::{Host, Url};

use crate::network::is_private_ip;

use super::error::WebsiteError;

/// Exact `schema` value for preview manifests.
pub const PREVIEW_SCHEMA: &str = "colony.website-preview/1";

/// Maximum accepted raw manifest size in bytes (256 KiB).
pub const MAX_MANIFEST_BYTES: usize = 262_144;

/// Maximum number of files in one manifest.
pub const MAX_PREVIEW_FILES: usize = 512;

/// Maximum size of one preview file in bytes (16 MiB).
pub const MAX_FILE_BYTES: u64 = 16_777_216;

/// Maximum total size of all preview files in bytes (64 MiB).
pub const MAX_TOTAL_BYTES: u64 = 67_108_864;

/// Maximum length of an asset path in bytes.
pub const MAX_PATH_LEN: usize = 1024;

/// Maximum length of any URL in bytes.
pub const MAX_URL_LEN: usize = 2048;

/// Maximum length of a decision note in characters.
pub const MAX_NOTE_LEN: usize = 2000;

/// MIME types a preview file may declare, in allowlist order.
pub const ALLOWED_MIMES: [&str; 18] = [
    "text/html",
    "text/css",
    "text/plain",
    "text/javascript",
    "application/javascript",
    "application/json",
    "application/manifest+json",
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/svg+xml",
    "image/webp",
    "image/avif",
    "image/x-icon",
    "image/vnd.microsoft.icon",
    "font/woff",
    "font/woff2",
    "application/wasm",
];

/// An immutable reference to artifact bytes: a public URL plus the SHA-256 of
/// the exact bytes behind it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewArtifactRef {
    /// Public HTTPS URL serving the exact bytes.
    pub url: String,
    /// SHA-256 of the exact bytes, 64 lowercase hex characters.
    pub sha256: String,
}

/// One file listed in a preview manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewFile {
    /// Literal relative asset path inside the site.
    pub path: String,
    /// Public HTTPS URL serving the exact bytes of this file.
    pub url: String,
    /// SHA-256 of the exact file bytes, 64 lowercase hex characters.
    pub sha256: String,
    /// Bare MIME type from [`ALLOWED_MIMES`].
    pub mime: String,
    /// Byte length of the exact file bytes.
    pub size: u64,
}

/// A preview manifest: the immutable description of one built site.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewManifest {
    /// Exactly [`PREVIEW_SCHEMA`].
    pub schema: String,
    /// Path of the entry document; must exist in `files` with `text/html`.
    pub entrypoint: String,
    /// Bounded list of files that make up the site.
    pub files: Vec<PreviewFile>,
}

/// Parse and fully validate a preview manifest from its raw bytes.
///
/// The size limit applies to the raw byte slice before any JSON decoding, and
/// the manifest is validated structurally afterwards. A caller that needs the
/// manifest hash hashes the same byte slice with [`sha256_hex`].
pub fn parse_preview_manifest(bytes: &[u8]) -> Result<PreviewManifest, WebsiteError> {
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(WebsiteError::ManifestTooLarge(
            bytes.len(),
            MAX_MANIFEST_BYTES,
        ));
    }
    let manifest: PreviewManifest = serde_json::from_slice(bytes)
        .map_err(|error| WebsiteError::ManifestJson(error.to_string()))?;
    validate_preview_manifest(&manifest)?;
    Ok(manifest)
}

/// SHA-256 of `bytes`, lowercase hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// `true` when `value` is exactly 64 lowercase hexadecimal characters.
pub(crate) fn is_lower_hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Validate a SHA-256 value: exactly 64 lowercase hex characters.
pub fn validate_sha256(value: &str) -> Result<(), WebsiteError> {
    if !is_lower_hex64(value) {
        return Err(WebsiteError::InvalidSha256(value.to_string()));
    }
    Ok(())
}

/// Validate a decoded preview manifest against every structural rule.
///
/// Enforced here: schema, file count, path rules and collisions, URL rules,
/// SHA-256 shape, MIME allowlist, per-file and total size limits, and the
/// entrypoint existing with `text/html`.
pub fn validate_preview_manifest(manifest: &PreviewManifest) -> Result<(), WebsiteError> {
    if manifest.schema != PREVIEW_SCHEMA {
        return Err(WebsiteError::ManifestSchema(manifest.schema.clone()));
    }
    if manifest.files.len() > MAX_PREVIEW_FILES {
        return Err(WebsiteError::TooManyFiles(
            manifest.files.len(),
            MAX_PREVIEW_FILES,
        ));
    }
    validate_asset_path(&manifest.entrypoint)?;

    let mut exact_paths: BTreeSet<String> = BTreeSet::new();
    let mut folded_paths: BTreeMap<String, String> = BTreeMap::new();
    let mut total: u64 = 0;
    for file in &manifest.files {
        validate_asset_path(&file.path)?;
        if !exact_paths.insert(file.path.clone()) {
            return Err(WebsiteError::DuplicatePath(file.path.clone()));
        }
        let folded = file.path.to_lowercase();
        if let Some(existing) = folded_paths.get(&folded) {
            return Err(WebsiteError::AmbiguousPath(
                file.path.clone(),
                existing.clone(),
            ));
        }
        folded_paths.insert(folded, file.path.clone());

        validate_public_url(&file.url)?;
        validate_sha256(&file.sha256)?;
        validate_mime(&file.mime)?;
        if file.size > MAX_FILE_BYTES {
            return Err(WebsiteError::FileTooLarge(
                file.path.clone(),
                file.size,
                MAX_FILE_BYTES,
            ));
        }
        total = total
            .checked_add(file.size)
            .ok_or(WebsiteError::TotalTooLarge(u64::MAX, MAX_TOTAL_BYTES))?;
        if total > MAX_TOTAL_BYTES {
            return Err(WebsiteError::TotalTooLarge(total, MAX_TOTAL_BYTES));
        }
    }

    match manifest
        .files
        .iter()
        .find(|file| file.path == manifest.entrypoint)
    {
        Some(entrypoint) => {
            if entrypoint.mime != "text/html" {
                return Err(WebsiteError::EntrypointNotHtml(
                    manifest.entrypoint.clone(),
                    entrypoint.mime.clone(),
                ));
            }
        }
        None => return Err(WebsiteError::EntrypointMissing(manifest.entrypoint.clone())),
    }
    Ok(())
}

/// Validate a literal relative asset path.
///
/// Rejected: empty paths, paths over 1024 bytes, leading or trailing slashes,
/// backslashes, `%`, `?`, `#`, control characters, empty or `.` or `..`
/// segments, and segments ending in a space or dot.
pub fn validate_asset_path(path: &str) -> Result<(), WebsiteError> {
    if path.is_empty() {
        return Err(WebsiteError::InvalidPath(
            path.to_string(),
            "must not be empty",
        ));
    }
    if path.len() > MAX_PATH_LEN {
        return Err(WebsiteError::InvalidPath(
            path.to_string(),
            "must be at most 1024 bytes",
        ));
    }
    if path.starts_with('/') || path.ends_with('/') {
        return Err(WebsiteError::InvalidPath(
            path.to_string(),
            "must be relative without a leading or trailing slash",
        ));
    }
    if path.contains('\\') {
        return Err(WebsiteError::InvalidPath(
            path.to_string(),
            "must not contain a backslash",
        ));
    }
    if path.contains('%') {
        return Err(WebsiteError::InvalidPath(
            path.to_string(),
            "must not contain percent encoding",
        ));
    }
    if path.contains('?') {
        return Err(WebsiteError::InvalidPath(
            path.to_string(),
            "must not contain a query",
        ));
    }
    if path.contains('#') {
        return Err(WebsiteError::InvalidPath(
            path.to_string(),
            "must not contain a fragment",
        ));
    }
    if path.chars().any(char::is_control) {
        return Err(WebsiteError::InvalidPath(
            path.to_string(),
            "must not contain control characters",
        ));
    }
    for segment in path.split('/') {
        if segment.is_empty() {
            return Err(WebsiteError::InvalidPath(
                path.to_string(),
                "must not contain an empty segment",
            ));
        }
        if segment == "." {
            return Err(WebsiteError::InvalidPath(
                path.to_string(),
                "must not contain a dot segment",
            ));
        }
        if segment == ".." {
            return Err(WebsiteError::InvalidPath(
                path.to_string(),
                "must not contain a parent segment",
            ));
        }
        if segment.ends_with(' ') || segment.ends_with('.') {
            return Err(WebsiteError::InvalidPath(
                path.to_string(),
                "segments must not end in a space or dot",
            ));
        }
    }
    Ok(())
}

/// Validate a bare MIME type against [`ALLOWED_MIMES`].
pub fn validate_mime(mime: &str) -> Result<(), WebsiteError> {
    if !ALLOWED_MIMES.contains(&mime) {
        return Err(WebsiteError::InvalidMime(mime.to_string()));
    }
    Ok(())
}

/// Validate a public artifact or source URL.
///
/// Required: absolute HTTPS, at most 2048 bytes, no userinfo, no fragment, and
/// a host that core can prove is public. Trailing dots are normalized away
/// before classification, so `localhost.` and `127.0.0.1.` cannot slip past as
/// plain domains. IP literals are classified with
/// [`crate::network::is_private_ip`]; DNS names must contain a dot and must not
/// be `localhost`, `*.localhost`, `*.local`, `*.internal`, or `*.home.arpa`.
/// Core cannot resolve DNS or follow redirects; the native preview worker
/// re-checks the resolved address and every redirect hop before download.
pub fn validate_public_url(url: &str) -> Result<(), WebsiteError> {
    if url.len() > MAX_URL_LEN {
        return Err(WebsiteError::InvalidUrl(
            url.to_string(),
            "url exceeds 2048 bytes",
        ));
    }
    let parsed = Url::parse(url)
        .map_err(|_| WebsiteError::InvalidUrl(url.to_string(), "must be an absolute url"))?;
    if parsed.scheme() != "https" {
        return Err(WebsiteError::InsecureUrl(url.to_string()));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(WebsiteError::UrlCredentials(url.to_string()));
    }
    if parsed.fragment().is_some() {
        return Err(WebsiteError::InvalidUrl(
            url.to_string(),
            "must not include a fragment",
        ));
    }
    match parsed.host() {
        Some(Host::Ipv4(address)) => {
            if is_private_ip(&IpAddr::V4(address)) {
                return Err(WebsiteError::BlockedHost(address.to_string()));
            }
        }
        Some(Host::Ipv6(address)) => {
            if is_private_ip(&IpAddr::V6(address)) {
                return Err(WebsiteError::BlockedHost(address.to_string()));
            }
        }
        Some(Host::Domain(name)) => {
            let name = name.to_ascii_lowercase();
            let normalized = name.trim_end_matches('.');
            if normalized.is_empty() {
                return Err(WebsiteError::BlockedHost(name));
            }
            if let Ok(address) = normalized.parse::<IpAddr>() {
                if is_private_ip(&address) {
                    return Err(WebsiteError::BlockedHost(normalized.to_string()));
                }
            }
            let blocked = normalized == "localhost"
                || normalized.ends_with(".localhost")
                || normalized.ends_with(".local")
                || normalized.ends_with(".internal")
                || normalized.ends_with(".home.arpa")
                || !normalized.contains('.');
            if blocked {
                return Err(WebsiteError::BlockedHost(normalized.to_string()));
            }
        }
        None => {
            return Err(WebsiteError::InvalidUrl(
                url.to_string(),
                "must include a host",
            ));
        }
    }
    Ok(())
}
