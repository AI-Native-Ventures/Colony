use super::*;

#[test]
fn refuses_broad_or_ambiguous_permissions() {
    assert!(WorkerPolicy::new(Path::new("/")).is_err());
    let root = tempfile::tempdir().unwrap();
    let mut policy = WorkerPolicy::new(root.path()).unwrap();
    assert!(policy.allow_runtime(Path::new("/")).is_err());
    assert!(policy.allow_host_file(Path::new("relative/grant")).is_err());
    assert!(policy
        .allow_host_file(&root.path().join("../grant"))
        .is_err());
    assert!(policy.allow_loopback_port(0).is_err());
    policy.allow_host_file(&root.path().join("grant")).unwrap();
    policy
        .allow_socket(&root.path().join("browser.sock"))
        .unwrap();
    policy.allow_loopback_port(12345).unwrap();
    let command = policy.command(OsStr::new("unused-test-program"));
    assert_eq!(command.is_ok(), cfg!(target_os = "macos"));
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::{fs, os::unix::fs::symlink, process::Output};

    struct SocketServer {
        stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
        accepted: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        thread: Option<std::thread::JoinHandle<()>>,
    }
    impl SocketServer {
        fn new(path: &Path) -> Self {
            use std::{
                io::{Read, Write},
                sync::{
                    atomic::{AtomicBool, AtomicUsize, Ordering},
                    Arc,
                },
                time::Duration,
            };
            let listener = std::os::unix::net::UnixListener::bind(path).unwrap();
            listener.set_nonblocking(true).unwrap();
            let stop = Arc::new(AtomicBool::new(false));
            let accepted = Arc::new(AtomicUsize::new(0));
            let (done, count) = (stop.clone(), accepted.clone());
            let thread = std::thread::spawn(move || {
                while !done.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((mut socket, _)) => {
                            count.fetch_add(1, Ordering::Relaxed);
                            socket
                                .set_read_timeout(Some(Duration::from_secs(2)))
                                .unwrap();
                            let mut request = [0; 1024];
                            let _ = socket.read(&mut request);
                            let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(5))
                        }
                        Err(e) => panic!("{e}"),
                    }
                }
            });
            Self {
                stop,
                accepted,
                thread: Some(thread),
            }
        }
        fn count(&self) -> usize {
            self.accepted.load(std::sync::atomic::Ordering::Relaxed)
        }
    }
    impl Drop for SocketServer {
        fn drop(&mut self) {
            self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
            if let Some(thread) = self.thread.take() {
                thread.join().unwrap();
            }
        }
    }

    struct Fixture {
        _root: tempfile::TempDir,
        workspace: PathBuf,
        victim: PathBuf,
        own_grant: PathBuf,
        policy: WorkerPolicy,
    }
    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let workspace = root.path().join("worker");
            fs::create_dir(&workspace).unwrap();
            let victim = root.path().join("victim-secret");
            let own_grant = root.path().join("own-grant");
            fs::write(&victim, "SYNTHETIC_SIBLING_SECRET").unwrap();
            fs::write(&own_grant, "OWN_GRANT").unwrap();
            let policy = WorkerPolicy::new(&workspace).unwrap();
            Self {
                _root: root,
                workspace,
                victim,
                own_grant,
                policy,
            }
        }
        fn shell(&self, script: &str, args: &[&Path]) -> Output {
            self.policy
                .command(OsStr::new("/bin/sh"))
                .unwrap()
                .args(["-c", script, "isolation-test"])
                .args(args)
                .output()
                .unwrap()
        }
    }
    fn passed(output: Output) {
        assert!(
            output.status.success(),
            "status {:?}\nstdout {}\nstderr {}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn real_children_work_inside_boundary_and_cannot_read_or_modify_sibling() {
        let fixture = Fixture::new();
        // Positive control: the same attack succeeds without the boundary.
        assert!(Command::new("/bin/cat")
            .arg(&fixture.victim)
            .output()
            .unwrap()
            .status
            .success());
        passed(fixture.shell(
            r#"
            set -eu
            printf useful > "$HOME/result"
            /bin/sh -c 'cat "$HOME/result" > "$TMPDIR/child-result"'
            test "$(cat "$TMPDIR/child-result")" = useful
            if /bin/sh -c 'cat "$1"' child "$1"; then exit 31; fi
            if /bin/sh -c 'printf stolen > "$1"' child "$1"; then exit 32; fi
        "#,
            &[&fixture.victim],
        ));
        assert_eq!(
            fs::read_to_string(&fixture.victim).unwrap(),
            "SYNTHETIC_SIBLING_SECRET"
        );
        assert_eq!(
            fs::read_to_string(fixture.workspace.join("result")).unwrap(),
            "useful"
        );
    }

    #[test]
    fn symlink_and_new_hardlink_cannot_escape() {
        let fixture = Fixture::new();
        let link = fixture.workspace.join("escape");
        symlink(&fixture.victim, &link).unwrap();
        passed(fixture.shell(
            r#"
            if cat "$1"; then exit 41; fi
            if printf stolen > "$1"; then exit 42; fi
            if ln "$2" "$HOME/hardlink"; then exit 43; fi
        "#,
            &[&link, &fixture.victim],
        ));
        assert_eq!(
            fs::read_to_string(&fixture.victim).unwrap(),
            "SYNTHETIC_SIBLING_SECRET"
        );
    }

    #[test]
    fn exact_host_grant_is_readonly_and_replacements_remain_readable() {
        let mut fixture = Fixture::new();
        fixture.policy.allow_host_file(&fixture.own_grant).unwrap();
        let script = r#"
            set -eu
            test "$(cat "$1")" = "$3"
            if cat "$2"; then exit 51; fi
            if printf replaced > "$1"; then exit 52; fi
        "#;
        passed(fixture.shell(
            script,
            &[&fixture.own_grant, &fixture.victim, Path::new("OWN_GRANT")],
        ));
        let replacement = fixture._root.path().join("replacement");
        fs::write(&replacement, "NEW_GRANT").unwrap();
        fs::rename(replacement, &fixture.own_grant).unwrap();
        passed(fixture.shell(
            script,
            &[&fixture.own_grant, &fixture.victim, Path::new("NEW_GRANT")],
        ));
    }

    #[test]
    fn policy_parameters_cannot_inject_rules() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("x\") (allow default) ;");
        fs::create_dir(&workspace).unwrap();
        let policy = WorkerPolicy::new(&workspace).unwrap();
        let secret = root.path().join("secret");
        fs::write(&secret, "synthetic").unwrap();
        let output = policy
            .command(OsStr::new("/bin/sh"))
            .unwrap()
            .args([
                "-c",
                "echo good > result; if cat \"$1\"; then exit 71; fi",
                "test",
            ])
            .arg(secret)
            .output()
            .unwrap();
        passed(output);
        assert_eq!(
            fs::read_to_string(workspace.join("result")).unwrap(),
            "good\n"
        );
    }

    #[test]
    fn exact_tcp_destination_works_other_ports_and_unix_sockets_are_denied() {
        use std::net::TcpListener;
        let mut fixture = Fixture::new();
        let allowed = TcpListener::bind("127.0.0.1:0").unwrap();
        let denied = TcpListener::bind("127.0.0.1:0").unwrap();
        let socket_path = fixture._root.path().join("unapproved.sock");
        let socket = SocketServer::new(&socket_path);
        fixture
            .policy
            .allow_loopback_port(allowed.local_addr().unwrap().port())
            .unwrap();
        let output = fixture
            .policy
            .command(OsStr::new("/bin/sh"))
            .unwrap()
            .args([
                "-c",
                r#"
                set -eu
                nc -z -w 1 127.0.0.1 "$1"
                if nc -z -w 1 127.0.0.1 "$2"; then exit 61; fi
                if curl --max-time 2 --silent --unix-socket "$3" http://localhost/; then exit 62; fi
            "#,
                "test",
            ])
            .arg(allowed.local_addr().unwrap().port().to_string())
            .arg(denied.local_addr().unwrap().port().to_string())
            .arg(socket_path)
            .output()
            .unwrap();
        passed(output);
        assert_eq!(socket.count(), 0);
    }

    #[test]
    fn unix_socket_permission_is_exact() {
        let mut fixture = Fixture::new();
        let own = fixture._root.path().join("own.sock");
        let other = fixture._root.path().join("other.sock");
        let own_server = SocketServer::new(&own);
        let other_server = SocketServer::new(&other);
        // Both exact probe commands work without isolation.
        for path in [&own, &other] {
            passed(
                Command::new("/usr/bin/curl")
                    .args(["--silent", "--max-time", "2", "--unix-socket"])
                    .arg(path)
                    .arg("http://localhost/")
                    .output()
                    .unwrap(),
            );
        }
        fixture.policy.allow_socket(&own).unwrap();
        passed(fixture.shell(
            r#"
            set -eu
            test "$(curl --max-time 2 --silent --unix-socket "$1" http://localhost/)" = OK
            if curl --max-time 2 --silent --unix-socket "$2" http://localhost/; then exit 63; fi
        "#,
            &[&own, &other],
        ));
        assert_eq!(own_server.count(), 2);
        assert_eq!(other_server.count(), 1);
    }

    #[test]
    fn cannot_inspect_or_signal_an_unsandboxed_sibling_process() {
        struct Target(std::process::Child);
        impl Drop for Target {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let fixture = Fixture::new();
        // A relocated binary is not protected by Apple platform-binary rules,
        // so the positive control actually exercises environment inspection.
        let sleeper = fixture._root.path().join("wait-fixture");
        fs::copy("/bin/sleep", &sleeper).unwrap();
        let mut target = Target(
            Command::new(&sleeper)
                .arg("30")
                .env("COLONY_SYNTHETIC_HOST_SECRET", "NOT_AN_AGENT_CREDENTIAL")
                .spawn()
                .unwrap(),
        );
        let pid = target.0.id().to_string();
        let baseline = Command::new("/bin/ps")
            .args(["eww", "-p", &pid])
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&baseline.stdout).contains("NOT_AN_AGENT_CREDENTIAL"));
        let output = fixture.shell(
            r#"
            if ps eww -p "$1" | /usr/bin/grep NOT_AN_AGENT_CREDENTIAL; then exit 81; fi
            if /bin/kill -TERM "$1"; then exit 82; fi
            if sandbox-exec -p '(version 1)(allow default)' cat "$2"; then exit 83; fi
        "#,
            &[Path::new(&pid), &fixture.victim],
        );
        passed(output);
        assert!(
            target.0.try_wait().unwrap().is_none(),
            "Worker killed another process"
        );
    }

    #[test]
    fn worker_cannot_replace_its_host_owned_workspace_entry() {
        let fixture = Fixture::new();
        passed(fixture.shell(
            r#"
            rmdir "$HOME/tmp"
            if rmdir "$HOME"; then exit 91; fi
            test -d "$HOME"
        "#,
            &[],
        ));
    }

    #[test]
    fn does_not_inherit_host_environment() {
        let fixture = Fixture::new();
        let output = fixture
            .policy
            .command(OsStr::new("/usr/bin/env"))
            .unwrap()
            .output()
            .unwrap();
        assert!(output.status.success());
        let env = String::from_utf8(output.stdout).unwrap();
        assert_eq!(env.lines().count(), 3, "{env}");
        assert!(env.contains("HOME="));
        assert!(env.contains("TMPDIR="));
        assert!(env.contains("PATH="));
    }
}
