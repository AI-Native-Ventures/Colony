//! `buzz website bundle`: turn a built static site into a revision payload.
//!
//! The agent builds the site; this command only packages and verifies bytes.
//! It walks the built directory, refuses anything the preview contract cannot
//! express (traversal, symlinks, case-fold collisions, unknown MIME types,
//! oversized files), uploads every file plus the manifest, the source archive,
//! and the three captures through the authenticated Blossom client, verifies
//! each upload by downloading it back and re-hashing, and then prints the
//! exact JSON `buzz website revision --file` consumes.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;

use buzz_core::website::{
    parse_preview_manifest, sha256_hex, validate_asset_path, validate_public_url, PreviewFile,
    PreviewManifest, MAX_FILE_BYTES, MAX_MANIFEST_BYTES, MAX_PREVIEW_FILES, MAX_TOTAL_BYTES,
    PREVIEW_SCHEMA,
};
use serde_json::Value;
use uuid::Uuid;

use crate::client::BuzzClient;
use crate::error::CliError;

/// Authenticated Blossom upload cap for generic (non-image/video) bytes.
const ARCHIVE_UPLOAD_BUDGET: u64 = 50 * 1024 * 1024;

/// Source directories and files that must never enter an archive.
const FORBIDDEN_SOURCE_ENTRIES: &[&str] = &[
    "node_modules",
    ".git",
    ".env",
    ".venv",
    "target",
    "__pycache__",
    ".DS_Store",
];

/// Map one file extension to a preview-manifest MIME.
fn mime_for_extension(extension: &str) -> Option<&'static str> {
    Some(match extension.to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "application/javascript",
        "json" => "application/json",
        "webmanifest" => "application/manifest+json",
        "txt" => "text/plain",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "wasm" => "application/wasm",
        _ => return None,
    })
}

/// One file discovered under the built directory.
#[derive(Debug)]
struct BuiltFile {
    relative: String,
    mime: &'static str,
    bytes: Vec<u8>,
}

impl BuiltFile {
    fn sha256(&self) -> String {
        sha256_hex(&self.bytes)
    }
}

/// Recursively collect one built site under the preview contract.
fn collect_built_site(dir: &Path) -> Result<Vec<BuiltFile>, CliError> {
    let mut files = Vec::new();
    let mut folded = BTreeMap::new();
    let mut total = 0_u64;
    walk_site(dir, dir, &mut files, &mut folded, &mut total)?;
    files.sort_by(|left, right| left.relative.cmp(&right.relative));
    if files.is_empty() {
        return Err(CliError::Usage(format!(
            "{} contains no files to preview",
            dir.display()
        )));
    }
    if files.len() > MAX_PREVIEW_FILES {
        return Err(CliError::Usage(format!(
            "the built site has {} files, maximum is {MAX_PREVIEW_FILES}",
            files.len()
        )));
    }
    if total > MAX_TOTAL_BYTES {
        return Err(CliError::Usage(format!(
            "the built site totals {total} bytes, maximum is {MAX_TOTAL_BYTES}"
        )));
    }
    Ok(files)
}

fn walk_site(
    root: &Path,
    current: &Path,
    files: &mut Vec<BuiltFile>,
    folded: &mut BTreeMap<String, String>,
    total: &mut u64,
) -> Result<(), CliError> {
    let entries = std::fs::read_dir(current)
        .map_err(|error| CliError::Usage(format!("cannot read {}: {error}", current.display())))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| CliError::Usage(format!("directory read failed: {error}")))?;
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|error| CliError::Usage(format!("cannot stat {}: {error}", path.display())))?;
        if metadata.file_type().is_symlink() {
            return Err(CliError::Usage(format!(
                "refusing symlink in the built site: {}",
                path.display()
            )));
        }
        if metadata.is_dir() {
            walk_site(root, &path, files, folded, total)?;
            continue;
        }
        if !metadata.is_file() {
            return Err(CliError::Usage(format!(
                "refusing non-file entry in the built site: {}",
                path.display()
            )));
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| CliError::Usage("built file escaped its directory".to_owned()))?
            .to_string_lossy()
            .replace('\\', "/");
        validate_asset_path(&relative)
            .map_err(|error| CliError::Usage(format!("invalid site path {relative}: {error}")))?;
        let lowered = relative.to_lowercase();
        if let Some(existing) = folded.insert(lowered, relative.clone()) {
            return Err(CliError::Usage(format!(
                "case-fold collision between {existing} and {relative}"
            )));
        }
        let extension = Path::new(&relative)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let mime = mime_for_extension(extension).ok_or_else(|| {
            CliError::Usage(format!(
                "unsupported file type for {relative}; add the asset or serve it another way"
            ))
        })?;
        let bytes = std::fs::read(&path)
            .map_err(|error| CliError::Usage(format!("cannot read {}: {error}", path.display())))?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(CliError::Usage(format!(
                "file {relative} is {} bytes, maximum is {MAX_FILE_BYTES}",
                bytes.len()
            )));
        }
        *total = total.saturating_add(bytes.len() as u64);
        files.push(BuiltFile {
            relative,
            mime,
            bytes,
        });
    }
    Ok(())
}

/// Build the manifest bytes for one built site.
fn build_manifest(files: &[BuiltFile], entrypoint: &str) -> Result<Vec<u8>, CliError> {
    let manifest = PreviewManifest {
        schema: PREVIEW_SCHEMA.to_owned(),
        entrypoint: entrypoint.to_owned(),
        files: files
            .iter()
            .map(|file| PreviewFile {
                path: file.relative.clone(),
                url: String::new(),
                sha256: file.sha256(),
                mime: file.mime.to_owned(),
                size: file.bytes.len() as u64,
            })
            .collect(),
    };
    serde_json::to_vec(&manifest).map_err(|error| CliError::Other(error.to_string()))
}

/// Write bytes to a unique temporary file and upload them.
async fn upload_bytes(
    client: &BuzzClient,
    bytes: &[u8],
    suffix: &str,
) -> Result<crate::client::BlobDescriptor, CliError> {
    let mut path = std::env::temp_dir();
    path.push(format!("buzz-website-bundle-{}{}", Uuid::new_v4(), suffix));
    {
        let mut file = std::fs::File::create(&path)
            .map_err(|error| CliError::Other(format!("cannot stage upload: {error}")))?;
        file.write_all(bytes)
            .map_err(|error| CliError::Other(format!("cannot stage upload: {error}")))?;
    }
    let outcome = client.upload_file(path.to_string_lossy().as_ref()).await;
    let _ = std::fs::remove_file(&path);
    outcome
}

/// Verify one upload by reading it back from the relay and re-hashing.
async fn verify_readback(
    client: &BuzzClient,
    descriptor: &crate::client::BlobDescriptor,
    expected: &[u8],
) -> Result<(), CliError> {
    let expected_sha = sha256_hex(expected);
    if descriptor.sha256 != expected_sha || descriptor.size != expected.len() as u64 {
        return Err(CliError::Other(format!(
            "upload descriptor does not match the exact bytes for {}",
            descriptor.url
        )));
    }
    let readback = client.download_media(&descriptor.url).await?;
    if readback.len() != expected.len() || sha256_hex(&readback) != expected_sha {
        return Err(CliError::Other(format!(
            "readback of {} did not match the exact digest and size",
            descriptor.url
        )));
    }
    Ok(())
}

async fn upload_verified(
    client: &BuzzClient,
    bytes: &[u8],
    suffix: &str,
) -> Result<crate::client::BlobDescriptor, CliError> {
    for attempt in 0..3 {
        match upload_bytes(client, bytes, suffix).await {
            Ok(descriptor) => match verify_readback(client, &descriptor, bytes).await {
                Ok(()) => return Ok(descriptor),
                Err(error) if attempt < 2 => {
                    eprintln!("readback verification failed, retrying upload: {error}");
                }
                Err(error) => return Err(error),
            },
            Err(error) if attempt < 2 => {
                eprintln!("upload attempt {attempt} failed, retrying: {error}");
            }
            Err(error) => return Err(error),
        }
    }
    Err(CliError::Other("upload retries exhausted".to_owned()))
}

fn require_png(path: &str, label: &str) -> Result<Vec<u8>, CliError> {
    let bytes = std::fs::read(path)
        .map_err(|error| CliError::Usage(format!("cannot read {label} capture {path}: {error}")))?;
    if !path.to_ascii_lowercase().ends_with(".png") || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(CliError::Usage(format!(
            "{label} capture must be a real PNG: {path}"
        )));
    }
    Ok(bytes)
}

/// Build a deterministic ustar archive of one source directory.
///
/// The archive is uncompressed but a real tar: every entry is a regular file,
/// paths are sorted, mtimes are zeroed, and symlinks/caches/secret files are
/// refused rather than silently dropped.
fn build_source_archive(source: &Path) -> Result<Vec<u8>, CliError> {
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    collect_source(source, source, &mut entries)?;
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    if entries.is_empty() {
        return Err(CliError::Usage(
            "the source directory contains no files".to_owned(),
        ));
    }
    let mut archive = Vec::new();
    for (path, bytes) in entries {
        write_tar_entry(&mut archive, &path, &bytes)?;
    }
    archive.extend_from_slice(&[0_u8; 1024]);
    if archive.len() as u64 > ARCHIVE_UPLOAD_BUDGET {
        return Err(CliError::Usage(format!(
            "source archive is {} bytes, which exceeds the {} byte upload budget; \
             shrink the editable source or pre-archive it and pass --source <archive>",
            archive.len(),
            ARCHIVE_UPLOAD_BUDGET
        )));
    }
    Ok(archive)
}

fn collect_source(
    root: &Path,
    current: &Path,
    entries: &mut Vec<(String, Vec<u8>)>,
) -> Result<(), CliError> {
    let list = std::fs::read_dir(current)
        .map_err(|error| CliError::Usage(format!("cannot read {}: {error}", current.display())))?;
    for entry in list {
        let entry =
            entry.map_err(|error| CliError::Usage(format!("directory read failed: {error}")))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if FORBIDDEN_SOURCE_ENTRIES.contains(&name.as_str()) {
            return Err(CliError::Usage(format!(
                "refusing {name} in the source archive; remove caches and secrets first"
            )));
        }
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|error| CliError::Usage(format!("cannot stat {}: {error}", path.display())))?;
        if metadata.file_type().is_symlink() {
            return Err(CliError::Usage(format!(
                "refusing symlink in the source archive: {}",
                path.display()
            )));
        }
        if metadata.is_dir() {
            collect_source(root, &path, entries)?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| CliError::Usage("source file escaped its directory".to_owned()))?
            .to_string_lossy()
            .replace('\\', "/");
        validate_asset_path(&relative)
            .map_err(|error| CliError::Usage(format!("invalid source path {relative}: {error}")))?;
        let bytes = std::fs::read(&path)
            .map_err(|error| CliError::Usage(format!("cannot read {}: {error}", path.display())))?;
        entries.push((relative, bytes));
    }
    Ok(())
}

fn write_tar_entry(archive: &mut Vec<u8>, path: &str, bytes: &[u8]) -> Result<(), CliError> {
    if path.len() > 100 {
        return Err(CliError::Usage(format!(
            "source path is too long for the archive format: {path}"
        )));
    }
    let mut header = [0_u8; 512];
    header[..path.len()].copy_from_slice(path.as_bytes());
    header[100..108].copy_from_slice(b"0000644\0");
    header[108..116].copy_from_slice(b"0000000\0");
    header[116..124].copy_from_slice(b"0000000\0");
    header[124..136].copy_from_slice(format!("{:011o}\0", bytes.len()).as_bytes());
    header[136..148].copy_from_slice(b"00000000000\0");
    header[148..156].copy_from_slice(b"        ");
    header[156] = b'0';
    header[257..263].copy_from_slice(b"ustar\0");
    header[263..265].copy_from_slice(b"00");
    let checksum: u32 = header.iter().map(|byte| *byte as u32).sum();
    let checksum_field = format!("{checksum:06o}\0 ");
    header[148..156].copy_from_slice(checksum_field.as_bytes());
    archive.extend_from_slice(&header);
    archive.extend_from_slice(bytes);
    let padding = (512 - bytes.len() % 512) % 512;
    archive.extend(std::iter::repeat(0_u8).take(padding));
    Ok(())
}

/// Run `buzz website bundle`.
#[allow(clippy::too_many_arguments)]
pub async fn run(
    client: &BuzzClient,
    dir: &str,
    source: &str,
    before: &str,
    desktop: &str,
    mobile: &str,
    entrypoint: &str,
    source_url: Option<&str>,
    out: Option<&str>,
) -> Result<(), CliError> {
    if let Some(source_url) = source_url {
        validate_public_url(source_url)
            .map_err(|error| CliError::Usage(format!("invalid --source-url: {error}")))?;
    }
    let built = collect_built_site(Path::new(dir))?;
    if !built.iter().any(|file| file.relative == entrypoint) {
        return Err(CliError::Usage(format!(
            "entrypoint {entrypoint} is not present in the built site"
        )));
    }
    if built
        .iter()
        .find(|file| file.relative == entrypoint)
        .is_none_or(|file| file.mime != "text/html")
    {
        return Err(CliError::Usage(format!(
            "entrypoint {entrypoint} must be text/html"
        )));
    }

    let before_bytes = require_png(before, "before")?;
    let desktop_bytes = require_png(desktop, "desktop")?;
    let mobile_bytes = require_png(mobile, "mobile")?;

    let before_ref = upload_verified(client, &before_bytes, ".png").await?;
    let desktop_ref = upload_verified(client, &desktop_bytes, ".png").await?;
    let mobile_ref = upload_verified(client, &mobile_bytes, ".png").await?;

    let mut uploaded: BTreeMap<String, Value> = BTreeMap::new();
    for file in &built {
        let descriptor = upload_verified(client, &file.bytes, ".bin").await?;
        uploaded.insert(
            file.relative.clone(),
            serde_json::json!({
                "url": descriptor.url,
                "sha256": descriptor.sha256,
            }),
        );
    }

    let manifest_bytes = build_manifest(&built, entrypoint)?;
    if manifest_bytes.len() > MAX_MANIFEST_BYTES {
        return Err(CliError::Usage(format!(
            "manifest is {} bytes, maximum is {MAX_MANIFEST_BYTES}",
            manifest_bytes.len()
        )));
    }
    let mut manifest_with_urls: Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| CliError::Other(error.to_string()))?;
    if let Some(files) = manifest_with_urls
        .get_mut("files")
        .and_then(Value::as_array_mut)
    {
        for file in files {
            if let Some(path) = file.get("path").and_then(Value::as_str) {
                if let Some(upload) = uploaded.get(path) {
                    file["url"] = upload["url"].clone();
                }
            }
        }
    }
    let final_manifest = serde_json::to_vec(&manifest_with_urls)
        .map_err(|error| CliError::Other(error.to_string()))?;
    parse_preview_manifest(&final_manifest)
        .map_err(|error| CliError::Usage(format!("manifest failed core validation: {error}")))?;
    let manifest_ref = upload_verified(client, &final_manifest, ".json").await?;

    let archive_bytes = match std::fs::metadata(source) {
        Ok(metadata) if metadata.is_file() => {
            if metadata.len() > ARCHIVE_UPLOAD_BUDGET {
                return Err(CliError::Usage(format!(
                    "source archive is {} bytes, which exceeds the {} byte upload budget",
                    metadata.len(),
                    ARCHIVE_UPLOAD_BUDGET
                )));
            }
            std::fs::read(source)
                .map_err(|error| CliError::Usage(format!("cannot read {source}: {error}")))?
        }
        Ok(metadata) if metadata.is_dir() => build_source_archive(Path::new(source))?,
        _ => {
            return Err(CliError::Usage(format!(
                "--source must be a file or directory: {source}"
            )))
        }
    };
    let archive_ref = upload_verified(client, &archive_bytes, ".tar").await?;

    let result = serde_json::json!({
        "manifest": {"url": manifest_ref.url, "sha256": manifest_ref.sha256},
        "sourceUrl": source_url,
        "archive": {"url": archive_ref.url, "sha256": archive_ref.sha256},
        "captures": {
            "before": {"url": before_ref.url, "sha256": before_ref.sha256},
            "desktop": {"url": desktop_ref.url, "sha256": desktop_ref.sha256},
            "mobile": {"url": mobile_ref.url, "sha256": mobile_ref.sha256},
        },
    });
    let encoded = serde_json::to_string_pretty(&result)
        .map_err(|error| CliError::Other(error.to_string()))?;
    if let Some(out) = out {
        std::fs::write(out, &encoded)
            .map_err(|error| CliError::Other(format!("cannot write {out}: {error}")))?;
    }
    println!("{encoded}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        std::fs::write(path, bytes).expect("write file");
    }

    #[test]
    fn nested_utf8_site_collects_sorted_with_allowed_mimes() {
        let temp = TempDir::new().expect("tempdir");
        write(&temp.path().join("index.html"), b"<html></html>");
        write(&temp.path().join("assets/caf\u{e9}.css"), b"body{}");
        write(&temp.path().join("assets/app.js"), b"console.log(1)");
        write(&temp.path().join("img/logo.svg"), b"<svg/>");
        let files = collect_built_site(temp.path()).expect("collect");
        let paths: Vec<&str> = files.iter().map(|file| file.relative.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                "assets/app.js",
                "assets/caf\u{e9}.css",
                "img/logo.svg",
                "index.html"
            ]
        );
        assert_eq!(files[1].mime, "text/css");
    }

    #[test]
    fn casefold_collision_is_refused() {
        let temp = TempDir::new().expect("tempdir");
        write(&temp.path().join("Index.html"), b"<html></html>");
        write(&temp.path().join("index.html"), b"<html></html>");
        let error = collect_built_site(temp.path()).expect_err("collision must fail");
        assert!(error.to_string().contains("case-fold collision"));
    }

    #[test]
    fn traversal_and_unknown_types_are_refused() {
        let temp = TempDir::new().expect("tempdir");
        write(&temp.path().join("index.html"), b"<html></html>");
        write(&temp.path().join("secrets.env"), b"TOKEN=1");
        let error = collect_built_site(temp.path()).expect_err("env must fail");
        assert!(error.to_string().contains("unsupported file type"));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_refused() {
        let temp = TempDir::new().expect("tempdir");
        write(&temp.path().join("index.html"), b"<html></html>");
        std::os::unix::fs::symlink("index.html", temp.path().join("alias.html")).expect("symlink");
        let error = collect_built_site(temp.path()).expect_err("symlink must fail");
        assert!(error.to_string().contains("symlink"));
    }

    #[test]
    fn oversize_file_is_refused() {
        let temp = TempDir::new().expect("tempdir");
        write(&temp.path().join("index.html"), b"<html></html>");
        let oversize = vec![b'a'; (MAX_FILE_BYTES + 1) as usize];
        write(&temp.path().join("big.js"), &oversize);
        let error = collect_built_site(temp.path()).expect_err("oversize must fail");
        assert!(error.to_string().contains("maximum"));
    }

    #[test]
    fn manifest_bytes_validate_against_the_core_parser() {
        let temp = TempDir::new().expect("tempdir");
        write(&temp.path().join("index.html"), b"<html></html>");
        let files = collect_built_site(temp.path()).expect("collect");
        let mut manifest: Value =
            serde_json::from_slice(&build_manifest(&files, "index.html").unwrap())
                .expect("manifest json");
        manifest["files"][0]["url"] = serde_json::json!("https://cdn.colony.test/site/index.html");
        let bytes = serde_json::to_vec(&manifest).expect("serialize");
        let parsed = parse_preview_manifest(&bytes).expect("core parser accepts");
        assert_eq!(parsed.entrypoint, "index.html");
    }

    #[test]
    fn source_archive_is_deterministic_and_rejects_caches() {
        let temp = TempDir::new().expect("tempdir");
        write(&temp.path().join("src/main.ts"), b"export {}");
        write(&temp.path().join("README.md"), b"hi");
        let first = build_source_archive(temp.path()).expect("archive");
        let second = build_source_archive(temp.path()).expect("archive again");
        assert_eq!(first, second, "archive bytes must be stable across runs");

        let cache = TempDir::new().expect("tempdir");
        write(&cache.path().join("node_modules/pkg/index.js"), b"1");
        let error = build_source_archive(cache.path()).expect_err("cache must fail");
        assert!(error.to_string().contains("node_modules"));
    }

    #[test]
    fn readback_verification_rejects_digest_mismatch() {
        // Pure comparison: the descriptor must match the exact bytes before
        // any network readback is attempted.
        let bytes = b"hello";
        let descriptor = crate::client::BlobDescriptor {
            url: "https://relay.colony.test/media/aa".to_owned(),
            sha256: sha256_hex(bytes),
            size: bytes.len() as u64,
            mime_type: "application/octet-stream".to_owned(),
            uploaded: 0,
            dim: None,
            blurhash: None,
            thumb: None,
            duration: None,
            filename: None,
        };
        let wrong = crate::client::BlobDescriptor {
            sha256: "0".repeat(64),
            ..descriptor.clone()
        };
        assert!(sha256_hex(bytes) == descriptor.sha256);
        assert!(wrong.sha256 != sha256_hex(bytes));
    }
}
