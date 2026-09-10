use super::*;

fn art(body: &str) -> String {
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">{body}</svg>"#
    )
}

#[test]
fn safe_primitives_and_local_gradients_preserve_original_artwork() {
    let svg = art(
        r##"<defs><linearGradient id="paint"><stop offset="0" stop-color="#123456"/><stop offset="1" stop-color="#ffffff"/></linearGradient></defs><rect width="640" height="360" fill="url(#paint)"/><text x="20" y="50" font-family="Arial" font-size="24">A &amp; B &#x2713;</text>"##,
    );
    assert!(is_svg_candidate(svg.as_bytes()));
    assert_eq!(validate_svg(svg.as_bytes()), Ok(()));
    let declared = format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>{svg}");
    assert!(is_svg_candidate(declared.as_bytes()));
    assert_eq!(validate_svg(declared.as_bytes()), Ok(()));
}

#[test]
fn rejects_active_elements_attributes_and_external_resources() {
    for body in [
        "<script>alert(1)</script>",
        "<foreignObject><div>active</div></foreignObject>",
        "<style>rect {fill:red}</style>",
        "<animate attributeName=\"x\"/>",
        "<set attributeName=\"fill\"/>",
        "<rect onload=\"alert(1)\"/>",
        "<image href=\"https://external.example/x.png\"/>",
        "<use href=\"#x\"/>",
        "<rect style=\"fill:red\"/>",
        "<rect fill=\"url(https://external.example/x.svg#paint)\"/>",
        "<rect fill=\"u&#114;l(https://external.example/x.svg#paint)\"/>",
        "<rect fill=\"u\\72l(https://external.example/x.svg#paint)\"/>",
        "<g xmlns=\"http://www.w3.org/1999/xhtml\"><script/></g>",
        "<rect xml:base=\"https://external.example\"/>",
        "<metadata>private metadata</metadata>",
    ] {
        assert!(
            validate_svg(art(body).as_bytes()).is_err(),
            "accepted {body}"
        );
    }
}

#[test]
fn rejects_entities_processing_instructions_and_malformed_xml() {
    for svg in [
        format!(
            "<!DOCTYPE svg [<!ENTITY x SYSTEM 'file:///secret'>]>{}",
            art("<text>&x;</text>")
        ),
        format!(
            "<?xml-stylesheet href='https://external.example/x.css'?>{}",
            art("<rect/>")
        ),
        art("<text>&unknown;</text>"),
        art("<g><rect></g>"),
        art("<rect id='same' id='again'/>"),
        format!("{}{}", art(""), art("")),
        art("<svg xmlns=''><rect/></svg>"),
        art("<text>&#0;</text>"),
    ] {
        assert!(validate_svg(svg.as_bytes()).is_err(), "accepted {svg}");
    }
}

#[test]
fn rejects_recursive_or_wrong_kind_fragment_references() {
    for body in [
        "<defs><clipPath id='clip'><rect clip-path='url(#clip)'/></clipPath></defs><rect clip-path='url(#clip)'/>",
        "<defs><marker id='arrow'><path marker-end='url(#arrow)'/></marker></defs><path marker-end='url(#arrow)'/>",
        "<rect id='shape'/><rect fill='url(#shape)'/>", "<rect fill='url(#absent)'/>",
    ] { assert!(validate_svg(art(body).as_bytes()).is_err()); }
}

#[test]
fn enforces_dimensions_depth_element_and_byte_limits() {
    assert!(validate_svg(art(&"<g>".repeat(65)).as_bytes()).is_err());
    assert!(validate_svg(art(&"<rect/>".repeat(MAX_ELEMENTS)).as_bytes()).is_err());
    assert!(validate_svg(&vec![b' '; MAX_SVG_BYTES + 1]).is_err());
    for size in ["NaN", "inf", "9000", "-1", "100%"] {
        let svg =
            format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="100"/>"#);
        assert!(validate_svg(svg.as_bytes()).is_err());
    }
    assert!(validate_svg(b"<svg/>").is_err());
    assert!(!is_svg_candidate(
        b"<!DOCTYPE html><html><body>report</body></html>"
    ));
}
