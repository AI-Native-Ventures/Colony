#[test]
fn managed_spawn_explicitly_removes_ambient_no_meter_for_byok() {
    let mut command = std::process::Command::new("buzz-acp");
    command.env("BUZZ_ACP_NO_METER", "true");

    super::apply_spend_env_policy(&mut command, false);

    let env = command
        .get_envs()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(
        env.get(std::ffi::OsStr::new("BUZZ_ACP_NO_METER")),
        Some(&None)
    );
    assert_eq!(
        env.get(std::ffi::OsStr::new("BUZZ_ACP_PROVISIONED")),
        Some(&None)
    );
}

#[test]
fn managed_spawn_explicitly_removes_ambient_no_meter_for_provisioned() {
    let mut command = std::process::Command::new("buzz-acp");
    command.env("BUZZ_ACP_NO_METER", "true");

    super::apply_spend_env_policy(&mut command, true);

    let env = command
        .get_envs()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(
        env.get(std::ffi::OsStr::new("BUZZ_ACP_NO_METER")),
        Some(&None)
    );
    assert_eq!(
        env.get(std::ffi::OsStr::new("BUZZ_ACP_PROVISIONED")),
        Some(&Some(std::ffi::OsStr::new("true")))
    );
}
