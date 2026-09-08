use super::minimal_record;

pub(super) fn make_pair_runtime_placeholder() -> crate::managed_agents::ManagedAgentPairRuntime {
    use std::process::{Command, Stdio};
    // Spawn a real child so ManagedAgentProcess's Child field is satisfied.
    // `true` exits immediately with 0 — just a handle we need for type purposes.
    //
    // Absolute `/usr/bin/true` on unix (present on both macOS and Linux):
    // parallel tests holding `lock_path_mutex` swap PATH to a tempdir, and a
    // bare `true` lookup during that window fails with NotFound (observed
    // flake). Windows keeps the PATH lookup — no test there swaps PATH.
    #[cfg(unix)]
    let program = "/usr/bin/true";
    #[cfg(windows)]
    let program = "true";
    let child = Command::new(program)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn true for placeholder");
    let process = crate::managed_agents::ManagedAgentProcess {
        isolation_network: None,
        provisioned_lease: None,
        child,
        log_path: std::path::PathBuf::new(),
        spawn_config: crate::managed_agents::spawn_snapshot::prospective_spawn_config_snapshot(
            &minimal_record(&"cc".repeat(32)),
            &[],
            &[],
            "wss://relay.example",
            &Default::default(),
        ),
        setup_mode: false,
        adapter_availability: None,
        start_nonce: "test-nonce".to_string(),
        #[cfg(windows)]
        job: None,
    };
    crate::managed_agents::ManagedAgentPairRuntime::starting(process)
}
