fn main() -> Result<(), Box<dyn std::error::Error>> {
    buzz_browser::mcp::run_stdio_server()
}
