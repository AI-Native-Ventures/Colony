use super::*;

#[test]
fn safe_svg_uses_generic_exact_byte_upload_and_forced_download() {
    let svg = include_bytes!("../../../desktop/public/rich-previews/launch-01.svg");
    let config = super::tests::test_config();
    assert_eq!(
        validate_file_content(svg, &config).unwrap(),
        ("image/svg+xml".to_string(), "svg".to_string())
    );
    assert!(!serve_inline("image/svg+xml"));
    // SVG must never enter the raster decoder/thumbnail pipeline.
    assert!(validate_content(svg, &config).is_err());
}

#[test]
fn active_svg_is_rejected_even_when_infer_classifies_it_as_xml() {
    let config = super::tests::test_config();
    for body in [
        "<script>alert(1)</script>",
        "<foreignObject/>",
        "<image href='https://external.example/x'/>",
    ] {
        let svg = format!(
            "<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\">{body}</svg>"
        );
        assert!(validate_file_content(svg.as_bytes(), &config).is_err());
    }
}
