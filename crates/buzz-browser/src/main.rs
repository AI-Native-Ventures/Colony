fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|s| s.as_str()) == Some("journey") {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        return rt.block_on(journey_main(args));
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
