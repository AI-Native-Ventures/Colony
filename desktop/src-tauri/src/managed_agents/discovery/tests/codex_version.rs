use super::super::probe_codex_acp_version_with_path;

#[cfg(unix)]
#[test]
fn probe_codex_acp_version_does_not_inherit_parent_stdin() {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use std::process::{Command, Stdio};

    const CHILD_SCRIPT: &str = "COLONY_TEST_CODEX_PROBE_STDIN_CHILD";
    if let Some(script) = std::env::var_os(CHILD_SCRIPT) {
        assert_eq!(
            probe_codex_acp_version_with_path(std::path::Path::new(&script), None),
            Some((1, 1, 7)),
            "the version probe must see EOF, not the parent's transport bytes"
        );
        return;
    }

    let temp = tempfile::tempdir().expect("temp dir");
    let script = temp.path().join("codex-acp");
    std::fs::write(
        &script,
        "#!/bin/sh\nif read -r line; then exit 42; fi\necho '@agentclientprotocol/codex-acp 1.1.7'\n",
    )
    .expect("write probe");
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("chmod probe");

    // Run the probe in a test subprocess with known nonempty stdin. An ordinary
    // cargo test stdin is often /dev/null and would falsely pass the old code.
    let mut child = Command::new(std::env::current_exe().expect("test executable"))
        .args([
            "--exact",
            "managed_agents::discovery::tests::codex_version::probe_codex_acp_version_does_not_inherit_parent_stdin",
            "--nocapture",
        ])
        .env(CHILD_SCRIPT, &script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn test subprocess");
    child
        .stdin
        .take()
        .expect("subprocess stdin")
        .write_all(b"synthetic-private-transport-frame\n")
        .expect("seed parent stdin");
    let output = child.wait_with_output().expect("wait for test subprocess");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
}

#[cfg(unix)]
#[test]
fn probe_codex_acp_version_uses_augmented_path_for_env_shebang_interpreter() {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().expect("temp dir");
    let script_dir = temp.path().join("script-bin");
    let interpreter_dir = temp.path().join("interpreter-bin");
    let empty_path_dir = temp.path().join("empty-bin");
    fs::create_dir_all(&script_dir).expect("script dir");
    fs::create_dir_all(&interpreter_dir).expect("interpreter dir");
    fs::create_dir_all(&empty_path_dir).expect("empty path dir");

    let interpreter_path = interpreter_dir.join("node");
    fs::write(
        &interpreter_path,
        "#!/bin/sh\necho '@agentclientprotocol/codex-acp 1.1.2'\n",
    )
    .expect("write interpreter");
    fs::set_permissions(&interpreter_path, fs::Permissions::from_mode(0o755))
        .expect("chmod interpreter");

    let shim_path = script_dir.join("codex-acp");
    fs::write(&shim_path, "#!/usr/bin/env node\n").expect("write shim");
    fs::set_permissions(&shim_path, fs::Permissions::from_mode(0o755)).expect("chmod shim");

    let scrubbed_path = std::env::join_paths([empty_path_dir.as_path()])
        .expect("join scrubbed PATH")
        .to_string_lossy()
        .into_owned();
    assert_eq!(
        probe_codex_acp_version_with_path(&shim_path, Some(&scrubbed_path)),
        None,
        "with a scrubbed PATH, /usr/bin/env should not find node"
    );

    let augmented_path = std::env::join_paths([interpreter_dir.as_path()])
        .expect("join augmented PATH")
        .to_string_lossy()
        .into_owned();
    assert_eq!(
        probe_codex_acp_version_with_path(&shim_path, Some(&augmented_path)),
        Some((1, 1, 2)),
        "the injected augmented PATH should allow /usr/bin/env to find node"
    );
}
