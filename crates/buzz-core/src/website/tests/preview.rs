//! Shared preview-manifest vectors.

use serde::Deserialize;
use serde_json::Value;

use crate::website::parse_preview_manifest;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vectors {
    schema: String,
    cases: Vec<VectorCase>,
}

#[derive(Deserialize)]
struct VectorCase {
    name: String,
    expect: String,
    manifest: Value,
}

#[test]
fn preview_manifest_vectors() {
    let vectors: Vectors = serde_json::from_str(include_str!(
        "../../../testdata/website/preview_manifest_vectors.json"
    ))
    .expect("preview vectors are valid JSON");
    assert_eq!(vectors.schema, "colony.website-test-vectors/1");
    assert!(
        vectors.cases.len() >= 30,
        "expected at least 30 preview vectors, found {}",
        vectors.cases.len()
    );
    for case in &vectors.cases {
        let bytes = serde_json::to_vec(&case.manifest).expect("vector manifest serializes");
        let result = parse_preview_manifest(&bytes);
        match case.expect.as_str() {
            "ok" => {
                if let Err(error) = result {
                    panic!("case {}: expected ok, found {}", case.name, error.code());
                }
            }
            expected => match result {
                Ok(_) => panic!("case {}: expected {expected}, parsed ok", case.name),
                Err(error) => assert_eq!(error.code(), expected, "case {}", case.name),
            },
        }
    }
}
