use super::*;
use std::path::PathBuf;

fn config() -> Config {
    Config {
        runtime: "codex".into(),
        vendor_binary: PathBuf::from("/synthetic/vendor/codex"),
        profile: PathBuf::from("/synthetic/private/subscription"),
        workspace: PathBuf::from("/synthetic/workspace"),
        model: "fixture-model".into(),
        mcp_servers: json!({"colony_work":{
            "command":"/usr/bin/sandbox-exec",
            "args":["-f","/synthetic/native.sb","/synthetic/tool"],
            "required":false,"enabled":false,"cwd":"/synthetic/untrusted-cwd"
        }}),
        host_login: None,
    }
}

fn thread_response(config: &Config) -> Value {
    json!({"thread":{"id":"fixture-thread"},"model":config.model,
        "modelProvider":"openai","approvalPolicy":"never",
        "sandbox":{"type":"readOnly"},"cwd":config.profile,
        "instructionSources":[]})
}

#[test]
fn coordinator_has_no_native_work_environment_and_required_tools_use_only_the_workspace() {
    let config = config();
    let params = thread_parameters(&config, "Follow the owner brief.").expect("thread parameters");
    assert_eq!(params["environments"], json!([]));
    assert_eq!(params["cwd"], json!(config.profile));
    assert_eq!(params["model"], config.model);
    assert_eq!(params["approvalPolicy"], "never");
    assert_eq!(params["sandbox"], "read-only");
    assert_eq!(params["ephemeral"], true);
    let tool = &params["config"]["mcp_servers"]["colony_work"];
    assert_eq!(tool["command"], "/usr/bin/sandbox-exec");
    assert_eq!(tool["args"], config.mcp_servers["colony_work"]["args"]);
    assert_eq!(tool["cwd"], json!(config.workspace));
    assert_eq!(tool["required"], true);
    assert_eq!(tool["enabled"], true);
    assert_eq!(
        config.mcp_servers["colony_work"]["required"], false,
        "policy must not mutate the captured config"
    );
}

#[test]
fn every_turn_resets_policy_and_rejects_file_image_and_other_host_inputs() {
    let config = config();
    let params = turn_parameters(&config, "fixture-thread", vec![json!({"type":"text","text":"Read via the isolated work tool.","path":"/synthetic/host/secret","text_elements":[{"type":"file","path":"/synthetic/host"}]})]).expect("text turn");
    assert_eq!(
        params["input"],
        json!([{"type":"text","text":"Read via the isolated work tool."}])
    );
    assert_eq!(params["environments"], json!([]));
    assert_eq!(params["cwd"], json!(config.profile));
    assert_eq!(params["model"], config.model);
    assert_eq!(params["threadId"], "fixture-thread");
    assert_eq!(params["approvalPolicy"], "never");
    assert_eq!(
        params["sandboxPolicy"],
        json!({"type":"readOnly","networkAccess":false})
    );
    for input in [
        json!({"type":"localImage","path":"/synthetic/host/image.png"}),
        json!({"type":"image","url":"file:///synthetic/host/image.png"}),
        json!({"type":"resource_link","uri":"file:///synthetic/host/secret"}),
        json!({"type":"file","path":"/synthetic/host/secret"}),
        json!({"type":"skill","path":"/synthetic/host/SKILL.md"}),
        json!({"type":"text","text":null}),
    ] {
        assert!(turn_parameters(&config, "fixture-thread", vec![input]).is_err());
    }
    assert!(turn_parameters(&config, "fixture-thread", Vec::new()).is_err());
}

#[test]
fn changed_or_incomplete_thread_policy_is_rejected() {
    let config = config();
    assert_eq!(
        validate_thread(&config, &thread_response(&config)).expect("accepted policy"),
        "fixture-thread"
    );
    for (field, changed) in [
        ("model", json!("other-model")),
        ("modelProvider", json!("other-provider")),
        ("approvalPolicy", json!("on-request")),
        ("sandbox", json!({"type":"dangerFullAccess"})),
        ("cwd", json!(config.workspace)),
        ("instructionSources", json!(["/synthetic/host/AGENTS.md"])),
        ("instructionSources", Value::Null),
        ("thread", json!({"id":""})),
        ("thread", json!({})),
    ] {
        let mut response = thread_response(&config);
        response[field] = changed;
        assert!(validate_thread(&config, &response).is_err(), "{field}");
    }
}

#[test]
fn compatibility_requires_an_explicit_array_environment_capability() {
    for property in [
        json!({"type":"array"}),
        json!({"type":["array","null"]}),
        json!({"anyOf":[{"type":"null"},{"type":"array"}]}),
    ] {
        assert!(
            require_environment_property(&json!({"properties":{"environments":property}})).is_ok()
        );
    }
    for schema in [
        json!({}),
        json!({"properties":{"environments":{"type":"object"}}}),
        json!({"properties":{"environment":{"type":"array"}}}),
        json!({"properties":{"environments":{"anyOf":[{"type":"null"}]}}}),
    ] {
        assert!(require_environment_property(&schema).is_err());
    }
}

#[test]
fn vendor_command_disables_host_tools_hooks_skills_and_environment_inheritance() {
    let config = config();
    let command = command(&config);
    let command = command.as_std();
    assert_eq!(command.get_current_dir(), Some(config.profile.as_path()));
    let args: Vec<_> = command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    let overrides: Vec<_> = args
        .chunks_exact(2)
        .map(|pair| {
            assert_eq!(pair[0], "-c");
            pair[1].as_str()
        })
        .collect();
    for required in [
        "approval_policy=\"never\"",
        "sandbox_mode=\"read-only\"",
        "forced_login_method=\"chatgpt\"",
        "cli_auth_credentials_store=\"file\"",
        "project_doc_max_bytes=0",
        "web_search=\"disabled\"",
        "notify=[]",
        "features.skip_host_skill_discovery=true",
        "skills.include_instructions=false",
        "history.persistence=\"none\"",
        "shell_environment_policy.inherit=\"none\"",
        "features.shell_tool=false",
        "features.view_image=false",
        "features.multi_agent=false",
        "features.plugins=false",
        "features.hooks=false",
        "features.apps=false",
        "features.browser_use=false",
        "features.computer_use=false",
        "features.js_repl=false",
        "features.request_permissions=false",
        "features.request_permissions_tool=false",
    ] {
        assert!(overrides.contains(&required), "missing policy: {required}");
    }
    let env: std::collections::HashMap<_, _> = command.get_envs().collect();
    assert_eq!(
        env.get(std::ffi::OsStr::new("HOME")),
        Some(&Some(config.profile.as_os_str()))
    );
    assert_eq!(
        env.get(std::ffi::OsStr::new("CODEX_HOME")),
        Some(&Some(config.profile.as_os_str()))
    );
    for key in [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "BUZZ_PRIVATE_KEY",
        "BUZZ_SUBSCRIPTION_BRIDGE_CONFIG",
    ] {
        assert!(
            !env.contains_key(std::ffi::OsStr::new(key)),
            "must not add {key}"
        );
    }
}

#[test]
fn native_tool_map_must_be_structured() {
    let mut config = config();
    for invalid in [Value::Null, json!([]), json!({"colony_work":false})] {
        config.mcp_servers = invalid;
        assert!(thread_parameters(&config, "owner brief").is_err());
    }
}

#[test]
fn compatibility_schema_reader_rejects_invalid_and_oversized_files() {
    let directory = tempfile::tempdir().expect("synthetic schema directory");
    let path = directory.path().join("schema.json");
    assert!(read_schema(&path).is_err());
    std::fs::write(&path, "not-json").expect("invalid synthetic schema");
    assert!(read_schema(&path).is_err());
    let file = std::fs::File::create(&path).expect("large synthetic schema");
    file.set_len(8 * 1024 * 1024 + 1)
        .expect("synthetic schema size");
    assert!(read_schema(&path).is_err());
    assert!(read_schema(directory.path()).is_err());
}

#[cfg(unix)]
#[test]
fn compatibility_schema_reader_does_not_follow_a_file_symlink() {
    let directory = tempfile::tempdir().expect("synthetic schema directory");
    let target = directory.path().join("target.json");
    let link = directory.path().join("schema.json");
    std::fs::write(&target, "{}").expect("synthetic target");
    std::os::unix::fs::symlink(target, &link).expect("synthetic symlink");
    assert!(read_schema(&link).is_err());
}
