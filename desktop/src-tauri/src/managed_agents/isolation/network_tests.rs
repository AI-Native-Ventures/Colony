use super::*;

#[test]
fn route_rejects_unknown_hosts_and_cannot_override_the_upstream_with_host_header() {
    let allowed = Destination::resolve("http://127.0.0.1:54321").unwrap();
    assert!(route(
        b"CONNECT 127.0.0.1:54322 HTTP/1.1\r\n\r\n",
        std::slice::from_ref(&allowed)
    )
    .is_none());
    for target in [
        "user@127.0.0.1:54321",
        "127.0.0.1:54321/path",
        "127.0.0.1:54321?x",
        "127.0.0.1:54321#x",
    ] {
        assert!(route(
            format!("CONNECT {target} HTTP/1.1\r\n\r\n").as_bytes(),
            std::slice::from_ref(&allowed)
        )
        .is_none());
    }
    let (_, forwarded) = route(b"GET http://127.0.0.1:54321/ok?q=1 HTTP/1.1\r\nHost: evil.invalid\r\nProxy-Authorization: secret\r\n\r\n", &[allowed]).unwrap();
    let forwarded = String::from_utf8(forwarded.unwrap()).unwrap();
    assert!(forwarded.contains("GET /ok?q=1 HTTP/1.1\r\nHost: 127.0.0.1:54321\r\n"));
    assert!(!forwarded.contains("evil.invalid"));
    assert!(!forwarded.contains("secret"));
    assert!(Destination::resolve("file:///tmp/secret").is_err());
    assert!(Destination::resolve("http://user:secret@127.0.0.1").is_err());
    for ip in [
        "127.0.0.1",
        "10.0.0.1",
        "169.254.169.254",
        "100.64.0.1",
        "::ffff:127.0.0.1",
        "fc00::1",
    ] {
        assert!(private_ip(ip.parse().unwrap()), "{ip}");
    }
}

#[tokio::test]
async fn real_gateway_forwards_http_and_connect_but_denies_another_live_server() {
    let allowed = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let forbidden = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", allowed.local_addr().unwrap());
    let gateway = WorkerNetwork::start(vec![Destination::resolve(&url).unwrap()]).unwrap();
    assert!(gateway.port() > 0);
    assert!(gateway
        .proxy_url()
        .ends_with(&format!("@127.0.0.1:{}", gateway.port())));
    for tunnel in [false, true] {
        let worker = async {
            let mut client = TcpStream::connect(("127.0.0.1", gateway.port()))
                .await
                .unwrap();
            if tunnel {
                client
                    .write_all(
                        authenticate(
                            &gateway,
                            &format!("CONNECT {} HTTP/1.1\r\n\r\n", allowed.local_addr().unwrap()),
                        )
                        .as_slice(),
                    )
                    .await
                    .unwrap();
                assert!(String::from_utf8(read_header(&mut client).await.unwrap())
                    .unwrap()
                    .contains("200 Connection Established"));
                client
                    .write_all(b"GET /tunnel HTTP/1.1\r\nHost: local\r\n\r\n")
                    .await
                    .unwrap();
            } else {
                client
                    .write_all(
                        authenticate(
                            &gateway,
                            &format!("GET {url}/plain HTTP/1.1\r\nHost: local\r\n\r\n"),
                        )
                        .as_slice(),
                    )
                    .await
                    .unwrap();
            }
            let mut output = String::new();
            client.read_to_string(&mut output).await.unwrap();
            assert!(output.ends_with("OK"), "{output}");
        };
        let server = async {
            let (mut socket, _) = allowed.accept().await.unwrap();
            let request = read_header(&mut socket).await.unwrap();
            assert!(String::from_utf8(request).unwrap().contains(if tunnel {
                "/tunnel"
            } else {
                "/plain"
            }));
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK")
                .await
                .unwrap();
        };
        tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(worker, server);
        })
        .await
        .unwrap();
    }
    let mut client = TcpStream::connect(("127.0.0.1", gateway.port()))
        .await
        .unwrap();
    client
        .write_all(
            authenticate(
                &gateway,
                &format!(
                    "CONNECT {} HTTP/1.1\r\n\r\n",
                    forbidden.local_addr().unwrap()
                ),
            )
            .as_slice(),
        )
        .await
        .unwrap();
    let mut response = String::new();
    client.read_to_string(&mut response).await.unwrap();
    assert!(response.contains("403 Forbidden"));
    assert!(
        tokio::time::timeout(Duration::from_millis(100), forbidden.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn stopping_worker_closes_listener_and_existing_tunnels() {
    let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gateway = WorkerNetwork::start(vec![Destination::resolve(&format!(
        "http://{}",
        upstream.local_addr().unwrap()
    ))
    .unwrap()])
    .unwrap();
    let port = gateway.port();
    let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    client
        .write_all(
            authenticate(
                &gateway,
                &format!(
                    "CONNECT {} HTTP/1.1\r\n\r\n",
                    upstream.local_addr().unwrap()
                ),
            )
            .as_slice(),
        )
        .await
        .unwrap();
    let (mut server, _) = upstream.accept().await.unwrap();
    read_header(&mut client).await.unwrap();
    drop(gateway);
    let mut byte = [0];
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), server.read(&mut byte))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), client.read(&mut byte))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
}

fn authenticate(gateway: &WorkerNetwork, request: &str) -> Vec<u8> {
    let credential =
        base64::engine::general_purpose::STANDARD.encode(format!("colony:{}", gateway.token));
    request
        .replacen(
            "\r\n",
            &format!("\r\nProxy-Authorization: Basic {credential}\r\n"),
            1,
        )
        .into_bytes()
}

#[tokio::test]
async fn a_port_permission_without_the_current_gateway_credential_is_denied() {
    let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gateway = WorkerNetwork::start(vec![Destination::resolve(&format!(
        "http://{}",
        upstream.local_addr().unwrap()
    ))
    .unwrap()])
    .unwrap();
    for authentication in ["", "Proxy-Authorization: Basic old-generation\r\n"] {
        let mut socket = TcpStream::connect(("127.0.0.1", gateway.port()))
            .await
            .unwrap();
        socket
            .write_all(
                format!(
                    "CONNECT {} HTTP/1.1\r\n{authentication}\r\n",
                    upstream.local_addr().unwrap()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let header = read_header(&mut socket).await.unwrap();
        assert!(String::from_utf8(header)
            .unwrap()
            .contains("407 Proxy Authentication Required"));
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(50), upstream.accept())
            .await
            .is_err()
    );
}
