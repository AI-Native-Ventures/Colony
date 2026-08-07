//! AX-tree outline with element refs and caps.

use std::collections::HashMap;

use serde_json::Value;

use crate::budget::estimate_tokens;
use crate::contracts::{
    BrowserError, SnapshotCaps, ACTIONABLE_ROLES, LABEL_ONLY_ROLES, SKIP_ROLES,
};

/// A snapshot result: the outline text plus refs the input layer can use.
#[derive(Debug, Clone)]
pub struct Snapshot {
    pub outline: String,
    pub refs: HashMap<String, RefTarget>,
    pub stats: SnapshotStats,
    pub chars: usize,
    pub est_tokens: usize,
}

/// Where a ref's element is on screen (center, CSS pixels).
#[derive(Debug, Clone, PartialEq)]
pub struct RefTarget {
    pub backend_node_id: i64,
    pub x: f64,
    pub y: f64,
    pub offscreen: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SnapshotStats {
    pub nodes: usize,
    pub hidden: usize,
    pub offscreen: usize,
}

struct AxNode {
    node_id: String,
    role: String,
    name: String,
    value: Option<String>,
    child_ids: Vec<String>,
    backend_node_id: Option<i64>,
    ignored: bool,
}

fn parse_ax_nodes(tree: &Value) -> Vec<AxNode> {
    tree["nodes"]
        .as_array()
        .map(|nodes| {
            nodes
                .iter()
                .map(|n| AxNode {
                    node_id: n["nodeId"].as_str().unwrap_or_default().to_string(),
                    role: n["role"]["value"].as_str().unwrap_or_default().to_string(),
                    name: n["name"]["value"].as_str().unwrap_or_default().to_string(),
                    value: n["value"]["value"].as_str().map(|s| s.to_string()),
                    child_ids: n["childIds"]
                        .as_array()
                        .map(|ids| {
                            ids.iter()
                                .filter_map(|id| id.as_str().map(|s| s.to_string()))
                                .collect()
                        })
                        .unwrap_or_default(),
                    backend_node_id: n["backendDOMNodeId"].as_i64(),
                    ignored: n["ignored"].as_bool().unwrap_or(false),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn skip(role: &str) -> bool {
    SKIP_ROLES.contains(&role) || role.is_empty()
}

fn actionable(role: &str) -> bool {
    ACTIONABLE_ROLES.contains(&role)
}

/// Build the compact outline. Offscreen actionable nodes are marked but still
/// get refs.
pub fn build_outline(
    ax_tree: &Value,
    caps: &SnapshotCaps,
) -> (String, HashMap<String, RefTarget>, SnapshotStats) {
    let nodes = parse_ax_nodes(ax_tree);
    let by_id: HashMap<&str, &AxNode> = nodes.iter().map(|n| (n.node_id.as_str(), n)).collect();
    let mut refs: HashMap<String, RefTarget> = HashMap::new();
    let mut stats = SnapshotStats::default();
    let mut lines: Vec<String> = Vec::new();
    let mut ref_counter = 0usize;

    fn walk(
        id: &str,
        depth: usize,
        _nodes: &[AxNode],
        by_id: &HashMap<&str, &AxNode>,
        refs: &mut HashMap<String, RefTarget>,
        lines: &mut Vec<String>,
        stats: &mut SnapshotStats,
        ref_counter: &mut usize,
        caps: &SnapshotCaps,
    ) {
        if stats.nodes >= caps.max_nodes || lines.join("\n").len() >= caps.max_chars {
            return;
        }
        let Some(node) = by_id.get(id).copied() else {
            return;
        };
        if node.ignored {
            // Ignored AX nodes (e.g. generic containers) can still hold
            // meaningful descendants — descend without emitting the node.
            for child in &node.child_ids {
                walk(
                    child,
                    depth,
                    _nodes,
                    by_id,
                    refs,
                    lines,
                    stats,
                    ref_counter,
                    caps,
                );
            }
            return;
        }
        if skip(&node.role) {
            for child in &node.child_ids {
                walk(
                    child,
                    depth,
                    _nodes,
                    by_id,
                    refs,
                    lines,
                    stats,
                    ref_counter,
                    caps,
                );
            }
            return;
        }
        stats.nodes += 1;
        let mut line = format!("{}- {}", "  ".repeat(depth), node.role);
        let mut ref_id = None;
        if actionable(&node.role) {
            *ref_counter += 1;
            ref_id = Some(format!("r{ref_counter}"));
            if let Some(backend) = node.backend_node_id {
                refs.insert(
                    ref_id.clone().unwrap(),
                    RefTarget {
                        backend_node_id: backend,
                        x: 0.0,
                        y: 0.0,
                        offscreen: false,
                    },
                );
            }
            line.push_str(&format!(" [{}]", ref_id.as_deref().unwrap_or("")));
        }
        if !node.name.is_empty() {
            let name = node.name.replace('\n', " ");
            line.push_str(&format!(" {name}"));
        }
        if let Some(value) = &node.value {
            if !value.is_empty() {
                line.push_str(&format!(" (value: {value})"));
            }
        }
        lines.push(line);
        let label_only = LABEL_ONLY_ROLES.contains(&node.role.as_str());
        if !label_only {
            for child in &node.child_ids {
                walk(
                    child,
                    depth + 1,
                    _nodes,
                    by_id,
                    refs,
                    lines,
                    stats,
                    ref_counter,
                    caps,
                );
            }
        }
    }

    let roots: Vec<String> = nodes
        .iter()
        .filter(|n| !nodes.iter().any(|p| p.child_ids.contains(&n.node_id)))
        .map(|n| n.node_id.clone())
        .collect();
    for root in roots {
        walk(
            &root,
            0,
            &nodes,
            &by_id,
            &mut refs,
            &mut lines,
            &mut stats,
            &mut ref_counter,
            caps,
        );
    }
    let outline = lines.join("\n");
    (outline, refs, stats)
}

/// Take a live snapshot: AX tree + box centers for actionable refs.
pub async fn take_snapshot(
    client: &mut crate::cdp::CdpClient,
    caps: &SnapshotCaps,
) -> Result<Snapshot, BrowserError> {
    let ax = client.get_ax_tree().await?;
    let (mut outline, mut refs, stats) = build_outline(&ax, caps);
    let viewport = client
        .evaluate("({w: innerWidth, h: innerHeight})")
        .await
        .unwrap_or(serde_json::json!({ "w": 1280, "h": 720 }));
    let w = viewport["w"].as_f64().unwrap_or(1280.0);
    let h = viewport["h"].as_f64().unwrap_or(720.0);
    for (ref_id, target) in refs.iter_mut() {
        if let Some((x, y)) = client.get_box_center(target.backend_node_id).await? {
            target.x = x;
            target.y = y;
            target.offscreen = x < 0.0 || y < 0.0 || x > w || y > h;
            if target.offscreen {
                outline.push_str(&format!(
                    "\n[ref {ref_id} is offscreen - scroll to reach it]"
                ));
            }
        }
    }
    if outline.len() > caps.max_chars {
        outline.truncate(caps.max_chars);
    }
    let chars = outline.len();
    Ok(Snapshot {
        outline,
        refs,
        stats,
        chars,
        est_tokens: estimate_tokens(chars),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_ax() -> Value {
        serde_json::json!({
            "nodes": [
                {
                    "nodeId": "1",
                    "ignored": false,
                    "role": { "value": "button" },
                    "name": { "value": "Add to cart" },
                    "childIds": [],
                    "backendDOMNodeId": 11
                },
                {
                    "nodeId": "2",
                    "ignored": false,
                    "role": { "value": "generic" },
                    "name": { "value": "" },
                    "childIds": ["1"]
                }
            ]
        })
    }

    #[test]
    fn outline_emits_actionable_refs_and_skips_generic() {
        let (outline, refs, stats) = build_outline(&sample_ax(), &SnapshotCaps::default());
        assert!(outline.contains("[r1]"));
        assert!(outline.contains("Add to cart"));
        assert!(!outline.contains("generic"));
        assert_eq!(refs.len(), 1);
        assert_eq!(stats.nodes, 1);
    }

    #[test]
    fn outline_respects_node_cap() {
        let mut caps = SnapshotCaps::default();
        caps.max_nodes = 1;
        let (outline, _, stats) = build_outline(&sample_ax(), &caps);
        assert_eq!(stats.nodes, 1);
        assert!(outline.len() <= caps.max_chars);
    }

    #[tokio::test]
    #[ignore = "requires a real browser; run with BUZZ_BROWSER_REAL=1"]
    async fn real_snapshot_of_data_url() {
        use crate::{
            cdp::CdpClient,
            host::{launch, HostConfig},
        };
        let host = launch(&HostConfig::default()).await.unwrap();
        let target = host
            .list_targets()
            .await
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        let mut client = CdpClient::connect(&target.ws_url).await.unwrap();
        client
            .navigate("data:text/html,<html><body><button>Hi</button></body></html>")
            .await
            .unwrap();
        let snap = take_snapshot(&mut client, &SnapshotCaps::default())
            .await
            .unwrap();
        assert!(snap.outline.contains("button"));
    }

    #[test]
    fn module_loads() {}
}
