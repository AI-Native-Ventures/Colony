fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|s| s.as_str()) == Some("journey") {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        return rt.block_on(journey_main(args));
    }
    if args.get(1).map(|s| s.as_str()) == Some("agent-proof") {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        return rt.block_on(agent_proof_main(args));
    }
    buzz_browser::mcp::run_stdio_server()
}

async fn journey_main(args: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    use std::path::PathBuf;
    let base_url = args
        .iter()
        .position(|a| a == "--base-url")
        .and_then(|i| args.get(i + 1))
        .cloned()
        .unwrap_or_else(|| "http://127.0.0.1:8777".into());
    let naive = args.iter().any(|a| a == "--naive");
    let cfg = buzz_browser::journey::JourneyConfig {
        binary: std::env::var("BUZZ_BROWSER_BINARY").ok().map(PathBuf::from),
        base_url,
        naive,
    };
    let report = buzz_browser::journey::run_reference_journey(&cfg).await?;
    std::fs::create_dir_all("target/browser-spike")?;
    std::fs::write(
        "target/browser-spike/budget-report.json",
        serde_json::to_string_pretty(&report)?,
    )?;
    println!(
        "PASS calls={} tokens={}",
        report.total_calls, report.total_tokens
    );
    Ok(())
}

async fn agent_proof_main(args: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    let agent = args
        .iter()
        .position(|a| a == "--agent")
        .and_then(|i| args.get(i + 1))
        .cloned()
        .ok_or("--agent is required (e.g. codex-acp)")?;
    let mut agent_args: Vec<String> = Vec::new();
    if std::path::Path::new(&agent)
        .file_name()
        .and_then(|n| n.to_str())
        == Some("goose")
    {
        agent_args.push("acp".into());
        std::env::set_var("GOOSE_MODE", "auto");
    }
    let daemon = std::env::current_exe()?.to_string_lossy().to_string();
    let result = buzz_browser::agent_proof::run_agent_proof(daemon, agent, agent_args).await?;
    println!("AGENT PROOF: {result}");
    Ok(())
}
