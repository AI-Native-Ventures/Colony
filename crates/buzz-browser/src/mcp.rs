//! rmcp stdio MCP server exposing snapshot-first browser tools.

/// Temporary entry point; the real stdio server lands in Task 8.
pub fn run_stdio_server() -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn module_loads() {}
}
