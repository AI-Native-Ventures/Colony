use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use tauri::{
    ipc::{InvokeBody, Request},
    State,
};

use crate::app_state::AppState;

use super::{
    media::{
        detect_and_validate_mime, do_upload, sanitize_filename, upload_media_bytes_inner,
        BlobDescriptor,
    },
    media_upload_progress::{
        begin_media_upload, cancel_media_upload as cancel_registered_media_upload,
        finish_media_upload,
    },
};

/// Upload raw bytes directly (for paste and drag-drop).
///
/// The renderer already has the bytes in memory from the clipboard/drag event.
/// If the bytes are a video, they're written to a temp file, transcoded via
/// ffmpeg, and the transcoded output is uploaded instead.
#[tauri::command]
pub async fn upload_media_bytes(
    data: Vec<u8>,
    filename: Option<String>,
    progress_id: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<BlobDescriptor, String> {
    upload_media_bytes_inner(data, filename, progress_id, app, state, None).await
}

/// Upload a PNG this app rendered, byte for byte.
///
/// `upload_media_bytes` strips metadata by decoding the image and encoding it
/// again, which changes every byte of a PNG. That is right for a file a
/// person picked and wrong for a card this app rasterised itself: the content
/// renderer measures the card's pixels and binds a gate report to their hash,
/// so a re-encode between the measurement and the upload leaves the report
/// naming bytes the relay never stored. There is nothing to strip either --
/// the bytes come from the app's own canvas, not a camera.
///
/// Restricted to PNG, the only format the renderer produces, and the mime is
/// still sniffed and validated so this cannot become a hole for anything
/// else.
#[tauri::command]
pub async fn upload_png_verbatim(
    data: Vec<u8>,
    filename: Option<String>,
    state: State<'_, AppState>,
) -> Result<BlobDescriptor, String> {
    if data.is_empty() {
        return Err("empty upload".to_string());
    }
    let mime = detect_and_validate_mime(&data)?;
    if mime != "image/png" {
        return Err(format!(
            "a verbatim upload must be a PNG, and these bytes are {mime}"
        ));
    }
    let mut descriptor = do_upload(data, &mime, &state, None, None).await?;
    descriptor.filename = filename.as_deref().map(sanitize_filename);
    Ok(descriptor)
}

fn decode_raw_upload_header(value: &str) -> Result<String, String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|error| format!("invalid raw upload header: {error}"))?;
    String::from_utf8(bytes).map_err(|error| format!("invalid raw upload header text: {error}"))
}

fn optional_raw_upload_header(request: &Request<'_>, name: &str) -> Result<Option<String>, String> {
    request
        .headers()
        .get(name)
        .map(|value| {
            value
                .to_str()
                .map_err(|error| format!("invalid {name} header: {error}"))
                .and_then(decode_raw_upload_header)
        })
        .transpose()
}

/// Cancel the native upload associated with a background progress ID.
#[tauri::command]
pub fn cancel_media_upload(progress_id: String) {
    cancel_registered_media_upload(&progress_id);
}

/// Upload raw IPC bytes without expanding a large browser File into JSON.
#[tauri::command]
pub async fn upload_media_bytes_raw(
    request: Request<'_>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<BlobDescriptor, String> {
    let data = match request.body() {
        InvokeBody::Raw(data) => data.clone(),
        InvokeBody::Json(_) => return Err("raw upload requires a byte body".to_string()),
    };
    let filename = optional_raw_upload_header(&request, "x-buzz-filename")?;
    let progress_id = optional_raw_upload_header(&request, "x-buzz-progress-id")?;

    let cancellation = begin_media_upload(progress_id.as_deref());
    let result = upload_media_bytes_inner(
        data,
        filename,
        progress_id.clone(),
        app,
        state,
        cancellation.as_ref(),
    )
    .await;
    finish_media_upload(progress_id.as_deref());
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A PNG whose pixels are a solid red 4x4, stored with level-0 deflate.
    ///
    /// The compression is the point: no re-encoder reproduces it, which is
    /// exactly the situation a card rasterised by WKWebView is in.
    const STORED_DEFLATE_PNG: &[u8] = &[
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 4, 0, 0, 0, 4, 8, 6,
        0, 0, 0, 169, 241, 158, 126, 0, 0, 0, 79, 73, 68, 65, 84, 120, 1, 1, 68, 0, 187, 255, 0,
        255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 0, 255, 255, 0,
        0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
        255, 0, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 60, 64,
        31, 225, 82, 237, 255, 162, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ];

    /// The bug behind "the relay stored different bytes than were measured".
    ///
    /// The content renderer measures a card's pixels, hashes the PNG, and
    /// binds a gate report to that hash. Sanitizing re-encodes the image, so
    /// the blob the relay stores hashes differently and no report can name
    /// it. `upload_png_verbatim` exists to skip this step for the app's own
    /// renders; this test is what makes the skip necessary rather than
    /// merely convenient.
    #[test]
    fn test_sanitize_png_changes_bytes_but_not_pixels() {
        let original = STORED_DEFLATE_PNG.to_vec();
        let sanitized =
            crate::commands::media::sanitize_image_for_upload(original.clone(), "image/png")
                .expect("a valid PNG sanitizes");
        assert_ne!(
            sanitized, original,
            "sanitizing must be what changes the bytes; if it stopped, the verbatim upload path is no longer needed"
        );

        // The pixels survive, which is why this reads as a mystery rather
        // than a corrupt image: the card looks right and only the hash moves.
        let decode = |bytes: &[u8]| {
            image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
                .expect("decodes")
                .to_rgba8()
                .into_raw()
        };
        assert_eq!(decode(&sanitized), decode(&original));
    }

    #[test]
    fn test_decode_raw_upload_header_preserves_unicode() {
        let encoded = URL_SAFE_NO_PAD.encode("clip 🎬.mp4");
        assert_eq!(decode_raw_upload_header(&encoded).unwrap(), "clip 🎬.mp4");
    }
}
