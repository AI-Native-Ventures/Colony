//! Bounded, zero-I/O validation of declarative SVG artwork shared by native and relay.
//!
//! Accepted bytes are not rewritten. Consumers must retain attachment, nosniff
//! and restrictive CSP headers, and render previews only as an image resource.

use std::collections::HashMap;

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;

/// Maximum size of SVG artwork accepted for preview (2 MiB).
pub const MAX_SVG_BYTES: usize = 2 * 1024 * 1024;
const MAX_ELEMENTS: usize = 5_000;
const MAX_DEPTH: usize = 64;
const SVG_NAMESPACE: &str = "http://www.w3.org/2000/svg";
const ELEMENTS: &[&str] = &[
    "svg",
    "g",
    "defs",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "text",
    "tspan",
    "title",
    "desc",
    "linearGradient",
    "radialGradient",
    "stop",
    "clipPath",
    "marker",
];
const ATTRIBUTES: &[&str] = &[
    "id",
    "x",
    "y",
    "x1",
    "x2",
    "y1",
    "y2",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "width",
    "height",
    "viewBox",
    "preserveAspectRatio",
    "d",
    "points",
    "pathLength",
    "transform",
    "fill",
    "fill-opacity",
    "fill-rule",
    "stroke",
    "stroke-width",
    "stroke-opacity",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
    "stroke-dasharray",
    "stroke-dashoffset",
    "opacity",
    "color",
    "clip-path",
    "clip-rule",
    "vector-effect",
    "paint-order",
    "display",
    "visibility",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "text-anchor",
    "dominant-baseline",
    "letter-spacing",
    "word-spacing",
    "textLength",
    "lengthAdjust",
    "dx",
    "dy",
    "rotate",
    "offset",
    "stop-color",
    "stop-opacity",
    "gradientUnits",
    "gradientTransform",
    "spreadMethod",
    "fx",
    "fy",
    "fr",
    "clipPathUnits",
    "markerWidth",
    "markerHeight",
    "refX",
    "refY",
    "orient",
    "markerUnits",
    "marker-start",
    "marker-mid",
    "marker-end",
    "role",
    "aria-label",
];

/// A SVG failed the deliberately small static-artwork contract.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("SVG preview requires bounded, declarative artwork without active content or external resources")]
pub struct SvgValidationError;

/// Identify an SVG root independently of MIME sniffers (including XML declarations).
/// This is only a routing hint; callers must run [`validate_svg`] before accepting it.
pub fn is_svg_candidate(bytes: &[u8]) -> bool {
    let mut reader = Reader::from_reader(bytes);
    loop {
        match reader.read_event() {
            Ok(Event::Start(element) | Event::Empty(element)) => {
                return element.local_name().as_ref() == b"svg";
            }
            Ok(Event::Eof) | Err(_) => return false,
            _ => {}
        }
    }
}

fn safe_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn text_element(name: &str) -> bool {
    matches!(name, "text" | "tspan" | "title" | "desc")
}

fn dimension(value: &str) -> Result<f64, SvgValidationError> {
    let value = value.trim().strip_suffix("px").unwrap_or(value.trim());
    let value = value.parse::<f64>().map_err(|_| SvgValidationError)?;
    if !value.is_finite() || value <= 0.0 || value > 8192.0 {
        return Err(SvgValidationError);
    }
    Ok(value)
}

#[derive(Clone, Copy)]
enum ReferenceKind {
    Paint,
    Clip,
    Marker,
}

fn validate_element(
    element: &BytesStart<'_>,
    reader: &Reader<&[u8]>,
    stack: &[String],
    ids: &mut HashMap<String, String>,
    references: &mut Vec<(String, ReferenceKind)>,
) -> Result<String, SvgValidationError> {
    let name = std::str::from_utf8(element.name().as_ref())
        .map_err(|_| SvgValidationError)?
        .to_string();
    if !ELEMENTS.contains(&name.as_str()) || (stack.is_empty() && name != "svg") {
        return Err(SvgValidationError);
    }
    let root = stack.is_empty();
    let mut namespace = false;
    let mut width = None;
    let mut height = None;
    let mut view_box = None;
    for (index, attribute) in element.attributes().enumerate() {
        if index >= 64 {
            return Err(SvgValidationError);
        }
        let attribute = attribute.map_err(|_| SvgValidationError)?;
        let key = std::str::from_utf8(attribute.key.as_ref()).map_err(|_| SvgValidationError)?;
        let value = attribute
            .decode_and_unescape_value(reader.decoder())
            .map_err(|_| SvgValidationError)?;
        if key == "xmlns" {
            if !root || value != SVG_NAMESPACE {
                return Err(SvgValidationError);
            }
            namespace = true;
            continue;
        }
        if !ATTRIBUTES.contains(&key)
            || value.contains(['\\', ';'])
            || value.contains("/*")
            || value.contains("*/")
            || value
                .chars()
                .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
        {
            return Err(SvgValidationError);
        }
        if key == "id"
            && (!safe_identifier(&value) || ids.insert(value.to_string(), name.clone()).is_some())
        {
            return Err(SvgValidationError);
        }
        let normalized = value.trim().to_ascii_lowercase();
        if normalized.contains("url(") {
            let target = value
                .trim()
                .strip_prefix("url(#")
                .and_then(|value| value.strip_suffix(')'))
                .filter(|value| safe_identifier(value))
                .ok_or(SvgValidationError)?;
            let kind = match key {
                "fill" | "stroke" => ReferenceKind::Paint,
                "clip-path" => ReferenceKind::Clip,
                "marker-start" | "marker-mid" | "marker-end" => ReferenceKind::Marker,
                _ => return Err(SvgValidationError),
            };
            // References within clipping/marker definitions could create recursive paint trees.
            if !matches!(kind, ReferenceKind::Paint)
                && (matches!(name.as_str(), "clipPath" | "marker")
                    || stack
                        .iter()
                        .any(|name| matches!(name.as_str(), "clipPath" | "marker")))
            {
                return Err(SvgValidationError);
            }
            if references.len() >= 1024 {
                return Err(SvgValidationError);
            }
            references.push((target.to_string(), kind));
        }
        if root {
            match key {
                "width" => width = Some(dimension(&value)?),
                "height" => height = Some(dimension(&value)?),
                "viewBox" => {
                    let numbers: Vec<f64> = value
                        .split(|character: char| {
                            character.is_ascii_whitespace() || character == ','
                        })
                        .filter(|part| !part.is_empty())
                        .map(str::parse)
                        .collect::<Result<_, _>>()
                        .map_err(|_| SvgValidationError)?;
                    if numbers.len() != 4
                        || numbers.iter().any(|number| !number.is_finite())
                        || numbers[2] <= 0.0
                        || numbers[3] <= 0.0
                        || numbers[2] > 8192.0
                        || numbers[3] > 8192.0
                    {
                        return Err(SvgValidationError);
                    }
                    view_box = Some((numbers[2], numbers[3]));
                }
                _ => {}
            }
        }
    }
    if root {
        if !namespace {
            return Err(SvgValidationError);
        }
        let (fallback_width, fallback_height) = view_box.unwrap_or((300.0, 150.0));
        if width.unwrap_or(fallback_width) * height.unwrap_or(fallback_height) > 25_000_000.0 {
            return Err(SvgValidationError);
        }
    }
    Ok(name)
}

/// Accept only finite, bounded SVG primitives with presentation attributes.
/// Scripts, foreignObject, image/use/href, CSS, animation, DTDs, custom entities,
/// processing instructions, namespace changes and external resources are rejected.
/// Original bytes remain unchanged; this is validation, not sanitizing by deletion.
pub fn validate_svg(bytes: &[u8]) -> Result<(), SvgValidationError> {
    if bytes.is_empty() || bytes.len() > MAX_SVG_BYTES {
        return Err(SvgValidationError);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| SvgValidationError)?;
    if text
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(SvgValidationError);
    }
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().check_comments = true;
    let mut stack: Vec<String> = Vec::new();
    let mut ids = HashMap::new();
    let mut references = Vec::new();
    let mut elements = 0;
    let mut seen_root = false;
    let mut declaration = false;
    loop {
        let event = reader.read_event().map_err(|_| SvgValidationError)?;
        let empty = matches!(&event, Event::Empty(_));
        match event {
            Event::Start(element) | Event::Empty(element) => {
                if stack.is_empty() && seen_root {
                    return Err(SvgValidationError);
                }
                elements += 1;
                if elements > MAX_ELEMENTS || stack.len() >= MAX_DEPTH {
                    return Err(SvgValidationError);
                }
                let name = validate_element(&element, &reader, &stack, &mut ids, &mut references)?;
                seen_root = true;
                if !empty {
                    stack.push(name);
                }
            }
            Event::End(_) => {
                stack.pop().ok_or(SvgValidationError)?;
            }
            Event::Decl(value) => {
                if declaration
                    || seen_root
                    || value.version().map_err(|_| SvgValidationError)?.as_ref() != b"1.0"
                    || value
                        .encoding()
                        .transpose()
                        .map_err(|_| SvgValidationError)?
                        .is_some_and(|encoding| !encoding.eq_ignore_ascii_case(b"utf-8"))
                {
                    return Err(SvgValidationError);
                }
                declaration = true;
            }
            Event::Text(value) => {
                let value = value.decode().map_err(|_| SvgValidationError)?;
                if !value.trim().is_empty() && !stack.last().is_some_and(|name| text_element(name))
                {
                    return Err(SvgValidationError);
                }
            }
            Event::CData(_) => {
                if !stack.last().is_some_and(|name| text_element(name)) {
                    return Err(SvgValidationError);
                }
            }
            Event::GeneralRef(value) => {
                if !stack.last().is_some_and(|name| text_element(name)) {
                    return Err(SvgValidationError);
                }
                match value.resolve_char_ref().map_err(|_| SvgValidationError)? {
                    Some(character)
                        if !character.is_control() || matches!(character, '\n' | '\r' | '\t') => {}
                    None if matches!(
                        value.as_ref(),
                        b"amp" | b"lt" | b"gt" | b"quot" | b"apos"
                    ) => {}
                    _ => return Err(SvgValidationError),
                }
            }
            Event::Comment(_) => {}
            Event::Eof => break,
            Event::PI(_) | Event::DocType(_) => return Err(SvgValidationError),
        }
    }
    if !seen_root || !stack.is_empty() {
        return Err(SvgValidationError);
    }
    for (id, kind) in references {
        let Some(name) = ids.get(&id) else {
            return Err(SvgValidationError);
        };
        if !match kind {
            ReferenceKind::Paint => matches!(name.as_str(), "linearGradient" | "radialGradient"),
            ReferenceKind::Clip => name == "clipPath",
            ReferenceKind::Marker => name == "marker",
        } {
            return Err(SvgValidationError);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
