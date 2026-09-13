use super::*;
use rustls::pki_types::{pem::PemObject, PrivateKeyDer};
use std::{process::Command, sync::Mutex};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_rustls::TlsAcceptor;

const HOST: &str = "business.run.invalid";
struct Certificates {
    ca: String,
    server: Arc<rustls::ServerConfig>,
}
static CERTIFICATES: OnceLock<Certificates> = OnceLock::new();
static OTHER_CERTIFICATES: OnceLock<Certificates> = OnceLock::new();

fn certificates() -> &'static Certificates {
    CERTIFICATES.get_or_init(make_certificates)
}

fn make_certificates() -> Certificates {
    let directory = tempfile::tempdir().expect("fixture certificate directory");
    let run = |args: &[&str]| {
        let output = Command::new("openssl")
            .args(args)
            .current_dir(directory.path())
            .output()
            .expect("openssl available for local TLS fixture");
        assert!(output.status.success(), "fixture certificate generation");
    };
    std::fs::write(directory.path().join("ca.cnf"), "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Onboarding test CA\n[ca]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n").expect("CA configuration");
    std::fs::write(directory.path().join("leaf.cnf"), format!("[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN={HOST}\n[leaf]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:{HOST}\n")).expect("leaf configuration");
    run(&[
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2", "-config",
        "ca.cnf", "-keyout", "ca.key", "-out", "ca.pem",
    ]);
    run(&[
        "req", "-new", "-newkey", "rsa:2048", "-nodes", "-config", "leaf.cnf", "-keyout",
        "leaf.key", "-out", "leaf.csr",
    ]);
    run(&[
        "x509",
        "-req",
        "-in",
        "leaf.csr",
        "-CA",
        "ca.pem",
        "-CAkey",
        "ca.key",
        "-CAcreateserial",
        "-days",
        "2",
        "-sha256",
        "-extfile",
        "leaf.cnf",
        "-extensions",
        "leaf",
        "-out",
        "leaf.pem",
    ]);
    let ca = CertificateDer::from_pem_file(directory.path().join("ca.pem")).expect("CA DER");
    let leaf = CertificateDer::from_pem_file(directory.path().join("leaf.pem")).expect("leaf DER");
    let key = PrivateKeyDer::from_pem_file(directory.path().join("leaf.key")).expect("leaf key");
    let server = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .expect("TLS versions")
    .with_no_client_auth()
    .with_single_cert(vec![leaf], key)
    .expect("server TLS");
    // TempDir removes both private keys before any test opens a listener.
    Certificates {
        ca: STANDARD.encode(ca.as_ref()),
        server: Arc::new(server),
    }
}

fn config(host: &str, address: SocketAddr, ca: &str) -> serde_json::Value {
    serde_json::json!({"version": 1, "ca_der_base64": ca,
        "routes": [{"host": host, "address": address.to_string()}]})
}

fn transport(host: &str, address: SocketAddr) -> FixtureTransport {
    FixtureTransport::from_json(&config(host, address, &certificates().ca).to_string())
        .expect("valid transport")
}

struct Server {
    address: SocketAddr,
    requests: Arc<Mutex<Vec<String>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

// tungstenite fixes the handshake callback's error type.
#[allow(clippy::result_large_err)]
async fn server(websocket: bool, redirect: Option<String>) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind TLS fixture");
    let address = listener.local_addr().expect("listener address");
    let acceptor = TlsAcceptor::from(Arc::clone(&certificates().server));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&requests);
    let task = tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.expect("accept local connection");
            let Ok(mut stream) = acceptor.accept(stream).await else {
                continue;
            };
            if websocket {
                let seen = Arc::clone(&seen);
                let handshake = tokio_tungstenite::accept_hdr_async(
                    stream,
                    move |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                          response| {
                        seen.lock().expect("request lock").push(format!(
                            "{} {}",
                            request.uri(),
                            request
                                .headers()
                                .get("host")
                                .expect("Host")
                                .to_str()
                                .expect("Host text")
                        ));
                        Ok(response)
                    },
                )
                .await;
                if let Ok(mut socket) = handshake {
                    let _ = socket.close(None).await;
                }
            } else {
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") && header.len() < 8192 {
                    match stream.read_u8().await {
                        Ok(byte) => header.push(byte),
                        Err(_) => break,
                    }
                }
                seen.lock()
                    .expect("request lock")
                    .push(String::from_utf8(header).expect("HTTP header"));
                let response = match &redirect {
                    Some(url) => format!("HTTP/1.1 302 Found\r\nLocation: {url}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
                    None => "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".into(),
                };
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;
            }
        }
    });
    Server {
        address,
        requests,
        task,
    }
}

#[test]
fn rejects_invalid_configuration_without_network() {
    let valid = config(
        HOST,
        "127.0.0.1:45678".parse().expect("address"),
        &certificates().ca,
    );
    assert!(FixtureTransport::from_json(&valid.to_string()).is_ok());
    for host in [
        "example.com",
        "*.run.invalid",
        "Upper.invalid",
        "a..invalid",
        "-a.invalid",
        "a-.invalid",
        "a.invalid.",
        "a.invalid:443",
        "https://a.invalid",
    ] {
        let mut invalid = valid.clone();
        invalid["routes"][0]["host"] = host.into();
        assert!(
            FixtureTransport::from_json(&invalid.to_string()).is_err(),
            "host {host}"
        );
    }
    for address in [
        "127.0.0.1:0",
        "0.0.0.0:443",
        "10.0.0.1:1234",
        "192.0.2.1:443",
        "[::]:443",
    ] {
        let mut invalid = valid.clone();
        invalid["routes"][0]["address"] = address.into();
        assert!(
            FixtureTransport::from_json(&invalid.to_string()).is_err(),
            "address {address}"
        );
    }
    for patch in [
        serde_json::json!({"version":2}),
        serde_json::json!({"unknown":true}),
        serde_json::json!({"routes":[]}),
        serde_json::json!({"ca_der_base64":"not DER"}),
        serde_json::json!({"ca_der_base64":STANDARD.encode(b"not a certificate")}),
    ] {
        let mut invalid = valid.clone();
        invalid
            .as_object_mut()
            .expect("object")
            .extend(patch.as_object().expect("patch").clone());
        assert!(FixtureTransport::from_json(&invalid.to_string()).is_err());
    }
    let mut duplicate = valid.clone();
    duplicate["routes"] = serde_json::json!([valid["routes"][0], valid["routes"][0]]);
    assert!(FixtureTransport::from_json(&duplicate.to_string()).is_err());
    assert!(FixtureTransport::from_json("").is_err());
    assert!(FixtureTransport::from_json(&" ".repeat(MAX_CONFIG_BYTES + 1)).is_err());
}

#[test]
fn missing_process_configuration_fails_closed() {
    if std::env::var_os("BUZZ_FIXTURE_MISSING_CHILD").is_some() {
        assert!(matches!(
            FixtureTransport::from_env(),
            Err(FixtureError::MissingConfig)
        ));
        assert!(configure_process_http(reqwest::Client::builder()).is_err());
        assert!(validate_process_url("https://business.run.invalid/").is_err());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let error = runtime
            .block_on(crate::transport::connect("wss://business.run.invalid/"))
            .err()
            .expect("fixture configuration is required");
        assert!(error.to_string().contains("configuration is missing"));
        return;
    }
    let output = Command::new(std::env::current_exe().expect("test executable"))
        .args([
            "--exact",
            "onboarding_fixture::tests::missing_process_configuration_fails_closed",
        ])
        .env_remove(CONFIG_ENV)
        .env("BUZZ_FIXTURE_MISSING_CHILD", "1")
        .output()
        .expect("isolated config test");
    assert!(
        output.status.success(),
        "child must reject absent fixture configuration"
    );
}

#[tokio::test]
async fn destination_and_resolver_never_fall_back_for_unmapped_names() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("uncontacted destination");
    let fixture = transport(HOST, listener.local_addr().expect("address"));
    for url in [
        "https://unlisted.run.invalid",
        "https://127.0.0.1",
        "http://business.run.invalid",
        "https://user@business.run.invalid",
        "https://business.run.invalid:444",
        "https://business.run.invalid/#fragment",
    ] {
        assert!(matches!(
            fixture.destination(url),
            Err(FixtureError::UnmappedDestinationDetail(_))
        ));
        assert!(fixture.connect_websocket(url).await.is_err());
    }
    assert!(fixture
        .resolver
        .resolve("unlisted.run.invalid".parse().expect("DNS name"))
        .await
        .is_err());
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err(),
        "rejected names must not dial even a configured destination"
    );
}

#[tokio::test]
async fn https_and_wss_preserve_canonical_host_path_and_query() {
    let http = server(false, None).await;
    let ambient_proxy = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("unused proxy");
    let fixture = transport(HOST, http.address);
    let url = format!("https://{HOST}/api/query?limit=1");
    fixture.destination(&url).expect("guard initial URL");
    let proxy = reqwest::Proxy::all(format!(
        "http://{}",
        ambient_proxy.local_addr().expect("proxy address")
    ))
    .expect("proxy");
    let client = fixture
        .configure_http(reqwest::Client::builder().proxy(proxy))
        .build()
        .expect("fixture HTTP");
    assert_eq!(
        client
            .get(&url)
            .send()
            .await
            .expect("verified HTTPS")
            .text()
            .await
            .expect("body"),
        "ok"
    );
    let requests = http.requests.lock().expect("requests").clone();
    assert!(requests[0].starts_with("GET /api/query?limit=1 HTTP/1.1\r\n"));
    assert!(requests[0]
        .to_lowercase()
        .contains(&format!("host: {HOST}\r\n")));
    assert!(!requests[0].contains("127.0.0.1"));
    assert!(
        tokio::time::timeout(Duration::from_millis(50), ambient_proxy.accept())
            .await
            .is_err(),
        "input proxy must be discarded"
    );

    let ws = server(true, None).await;
    let fixture = transport(HOST, ws.address);
    let (mut socket, _) = fixture
        .connect_websocket(&format!("wss://{HOST}/relay?scope=one"))
        .await
        .expect("verified WSS");
    let _ = socket.close(None).await;
    assert_eq!(
        *ws.requests.lock().expect("requests"),
        vec![format!("/relay?scope=one {HOST}")]
    );
}

#[tokio::test]
async fn blocking_https_uses_the_same_verified_fixture_transport() {
    let http = server(false, None).await;
    let fixture = transport(HOST, http.address);
    let body = tokio::task::spawn_blocking(move || {
        let url = format!("https://{HOST}/api/gateway/tokens");
        fixture.destination(&url).expect("guard initial URL");
        fixture
            .configure_blocking_http(reqwest::blocking::Client::builder())
            .build()
            .expect("blocking client")
            .get(url)
            .send()
            .expect("verified blocking HTTPS")
            .text()
            .expect("blocking body")
    })
    .await
    .expect("blocking task");
    assert_eq!(body, "ok");
    assert!(http.requests.lock().expect("requests")[0].contains("/api/gateway/tokens"));
}

#[tokio::test]
async fn worker_https_uses_authenticated_connect_instead_of_direct_mapping() {
    let http = server(false, None).await;
    let forbidden_direct = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("direct sentinel");
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("worker gateway");
    let gateway = format!(
        "http://colony:00000000000000000000000000000000@{}",
        listener.local_addr().expect("gateway address")
    );
    let header = Arc::new(Mutex::new(String::new()));
    let seen = Arc::clone(&header);
    let upstream_address = http.address;
    let gateway_task = tokio::spawn(async move {
        let (mut client, _) = listener.accept().await.expect("gateway connection");
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") && request.len() < 8192 {
            request.push(client.read_u8().await.expect("CONNECT header"));
        }
        *seen.lock().expect("header lock") = String::from_utf8(request).expect("CONNECT text");
        let mut upstream = TcpStream::connect(upstream_address)
            .await
            .expect("mapped upstream");
        client
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await
            .expect("tunnel accepted");
        let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
    });
    // Drop guard aborts the gateway even if an assertion below fails.
    let gateway_guard = Server {
        address: http.address,
        requests: Arc::new(Mutex::new(Vec::new())),
        task: gateway_task,
    };
    let fixture = transport(
        HOST,
        forbidden_direct.local_addr().expect("sentinel address"),
    );
    let url = format!("https://{HOST}/api/query");
    fixture.destination(&url).expect("guard initial URL");
    let client = fixture
        .configure_gateway_http(
            reqwest::Client::builder().timeout(Duration::from_secs(3)),
            &gateway,
        )
        .expect("gateway adapter")
        .build()
        .expect("worker client");
    assert_eq!(
        client
            .get(url)
            .send()
            .await
            .expect("HTTPS through gateway")
            .text()
            .await
            .expect("body"),
        "ok"
    );
    let header = header.lock().expect("CONNECT header").to_lowercase();
    assert!(header.starts_with(&format!("connect {HOST}:443 http/1.1\r\n")));
    assert!(header.contains(&format!(
        "proxy-authorization: basic {}\r\n",
        STANDARD
            .encode("colony:00000000000000000000000000000000")
            .to_lowercase()
    )));
    assert!(
        tokio::time::timeout(Duration::from_millis(50), forbidden_direct.accept())
            .await
            .is_err(),
        "worker must not bypass the gateway"
    );
    drop(gateway_guard);
}

#[tokio::test]
async fn wrong_ca_and_wrong_hostname_fail_actual_https_and_wss() {
    let wrong_ca = &OTHER_CERTIFICATES.get_or_init(make_certificates).ca;
    for (host, ca) in [(HOST, wrong_ca), ("wrong.run.invalid", &certificates().ca)] {
        let http = server(false, None).await;
        let fixture = FixtureTransport::from_json(&config(host, http.address, ca).to_string())
            .expect("syntactically valid fixture");
        let url = format!("https://{host}/");
        fixture.destination(&url).expect("configured initial URL");
        // A permissive input builder must not weaken the fixture's own TLS config.
        let client = fixture
            .configure_http(
                reqwest::Client::builder()
                    .danger_accept_invalid_certs(true)
                    .danger_accept_invalid_hostnames(true),
            )
            .build()
            .expect("HTTP client");
        assert!(
            client.get(url).send().await.is_err(),
            "TLS must reject {host}"
        );
        assert!(http.requests.lock().expect("requests").is_empty());
        let ws = server(true, None).await;
        let fixture = FixtureTransport::from_json(&config(host, ws.address, ca).to_string())
            .expect("fixture");
        assert!(
            fixture
                .connect_websocket(&format!("wss://{host}/"))
                .await
                .is_err(),
            "WSS must reject {host}"
        );
        assert!(ws.requests.lock().expect("requests").is_empty());
    }
}

#[tokio::test]
async fn redirects_cannot_reach_a_literal_ip_destination() {
    let forbidden = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("redirect sentinel");
    let http = server(
        false,
        Some(format!(
            "http://{}/private",
            forbidden.local_addr().expect("address")
        )),
    )
    .await;
    let fixture = transport(HOST, http.address);
    let url = format!("https://{HOST}/redirect");
    fixture.destination(&url).expect("guard initial URL");
    let client = fixture
        .configure_http(reqwest::Client::builder().redirect(reqwest::redirect::Policy::limited(10)))
        .build()
        .expect("HTTP client");
    assert_eq!(
        client
            .get(url)
            .send()
            .await
            .expect("redirect response")
            .status(),
        reqwest::StatusCode::FOUND
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(50), forbidden.accept())
            .await
            .is_err(),
        "must not follow redirect to literal IP"
    );
}

#[test]
fn only_explicit_authenticated_worker_gateways_are_accepted() {
    let fixture = transport(HOST, "127.0.0.1:1234".parse().expect("address"));
    for gateway in [
        "http://127.0.0.1:1234",
        "http://colony:abcd@127.0.0.1:1234",
        "http://colony:00000000000000000000000000000000@example.invalid:1234",
        "http://colony:00000000000000000000000000000000@127.0.0.1:1234/path",
    ] {
        assert!(fixture
            .configure_gateway_http(reqwest::Client::builder(), gateway)
            .is_err());
    }
    assert!(fixture
        .configure_gateway_http(
            reqwest::Client::builder(),
            "http://colony:00000000000000000000000000000000@127.0.0.1:1234"
        )
        .is_ok());
}

#[tokio::test]
async fn process_clients_preserve_verified_transport_and_worker_gateway() {
    const CHILD: &str = "BUZZ_FIXTURE_TRANSPORT_CHILD";
    if let Ok(kind) = std::env::var(CHILD) {
        // Mirror the packaged host's explicit provider installation so a missing
        // fixture connector fails certificate verification, not provider selection.
        let _ = rustls::crypto::ring::default_provider().install_default();
        assert!(validate_process_url("https://127.0.0.1:1/escape").is_err());
        assert!(validate_process_url("https://unlisted.invalid/escape").is_err());
        if kind == "wss" {
            let (mut socket, _) =
                crate::transport::connect(&format!("wss://{HOST}/real-worker?case=1"))
                    .await
                    .expect("configured shared WebSocket transport");
            let _ = socket.close(None).await;
        } else {
            let url = format!("https://{HOST}/real-worker?case=1");
            validate_process_url(&url).expect("request validation");
            let client =
                configure_process_http(reqwest::Client::builder().timeout(Duration::from_secs(3)))
                    .expect("configured process HTTP")
                    .build()
                    .expect("HTTP client");
            assert_eq!(
                client
                    .get(url)
                    .send()
                    .await
                    .expect("verified process HTTPS")
                    .status(),
                reqwest::StatusCode::OK
            );
        }
        return;
    }
    for kind in ["https", "wss"] {
        for through_gateway in [false, true] {
            let upstream = server(kind == "wss", None).await;
            let sentinel = TcpListener::bind("127.0.0.1:0")
                .await
                .expect("direct sentinel");
            let listener = TcpListener::bind("127.0.0.1:0").await.expect("gateway");
            let gateway = format!(
                "http://colony:{}@{}",
                "a".repeat(32),
                listener.local_addr().unwrap()
            );
            let seen = Arc::new(Mutex::new(String::new()));
            let captured = Arc::clone(&seen);
            let address = upstream.address;
            let gateway_task = tokio::spawn(async move {
                let (mut client, _) = listener.accept().await.expect("gateway accept");
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") && header.len() < 8192 {
                    header.push(client.read_u8().await.expect("CONNECT byte"));
                }
                *captured.lock().unwrap() = String::from_utf8(header).unwrap();
                let mut target = TcpStream::connect(address).await.expect("pinned upstream");
                client
                    .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                    .await
                    .unwrap();
                let _ = tokio::io::copy_bidirectional(&mut client, &mut target).await;
            });
            let gateway_guard = Server {
                address,
                requests: Arc::new(Mutex::new(Vec::new())),
                task: gateway_task,
            };
            let mapping = if through_gateway {
                sentinel.local_addr().unwrap()
            } else {
                address
            };
            let config = config(HOST, mapping, &certificates().ca).to_string();
            let output = tokio::task::spawn_blocking(move || {
                let mut command = Command::new(std::env::current_exe().unwrap());
                command.args(["--exact", "onboarding_fixture::tests::process_clients_preserve_verified_transport_and_worker_gateway"])
                    .env(CHILD, kind).env(CONFIG_ENV, config).env_remove("BUZZ_WORKER_PROXY");
                if through_gateway { command.env("BUZZ_WORKER_PROXY", gateway); }
                command.output().expect("isolated client process")
            }).await.unwrap();
            assert!(
                output.status.success(),
                "{kind} gateway={through_gateway}: {}",
                String::from_utf8_lossy(&output.stdout)
            );
            let requests = upstream.requests.lock().unwrap().clone();
            assert_eq!(requests.len(), 1, "one real request");
            assert!(requests[0].contains("/real-worker?case=1"));
            assert!(requests[0].to_lowercase().contains(HOST));
            if through_gateway {
                let header = seen.lock().unwrap().clone().to_lowercase();
                assert!(header.starts_with(&format!("connect {HOST}:443 http/1.1\r\n")));
                assert!(header.contains(&format!(
                    "proxy-authorization: basic {}",
                    STANDARD
                        .encode(format!("colony:{}", "a".repeat(32)))
                        .to_lowercase()
                )));
            } else {
                assert!(
                    seen.lock().unwrap().is_empty(),
                    "desktop must not use an unconfigured proxy"
                );
            }
            assert!(
                tokio::time::timeout(Duration::from_millis(50), sentinel.accept())
                    .await
                    .is_err(),
                "worker must not dial around the authenticated gateway"
            );
            drop(gateway_guard);
        }
    }
}
