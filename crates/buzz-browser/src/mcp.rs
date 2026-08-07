//! rmcp stdio MCP server exposing snapshot-first browser tools.

use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, Content, ServerCapabilities, ServerInfo},
    service::{RequestContext, RoleServer},
    tool, tool_handler, tool_router,
    transport::stdio,
    ErrorData, ServerHandler, ServiceExt,
};
use schemars::JsonSchema;
use serde::Deserialize;

use crate::budget::BudgetLedger;
use crate::cdp::CdpClient;
use crate::contracts::{BrowserError, SnapshotCaps};
use crate::host::{launch, HostConfig};
use crate::snapshot::Snapshot;

pub const TOOL_CONNECT: &str = "browser_connect";
pub const TOOL_NAVIGATE: &str = "browser_navigate";
pub const TOOL_SNAPSHOT: &str = "browser_snapshot";
pub const TOOL_CLICK: &str = "browser_click";
pub const TOOL_TYPE: &str = "browser_type";
pub const TOOL_SCROLL: &str = "browser_scroll";
pub const TOOL_WAIT: &str = "browser_wait_for";
pub const TOOL_SCREENSHOT: &str = "browser_screenshot";
pub const TOOL_TABS: &str = "browser_tabs_list";
pub const TOOL_BUDGET: &str = "context_budget_report";

/// Shared state for one browser daemon session.
#[derive(Default)]
pub struct BrowserState {
    pub host: Option<crate::host::BrowserHost>,
    pub client: Option<CdpClient>,
    pub snapshot: Option<Snapshot>,
    pub ledger: BudgetLedger,
}

pub struct BuzzBrowserMcp {
    state: Arc<Mutex<BrowserState>>,
    tool_router: ToolRouter<BuzzBrowserMcp>,
}

impl BuzzBrowserMcp {
    pub fn new(state: Arc<Mutex<BrowserState>>) -> Self {
        Self {
            state,
            tool_router: Self::tool_router(),
        }
    }

    fn text_result(text: String) -> Result<CallToolResult, ErrorData> {
        Ok(CallToolResult::success(vec![Content::text(text)]))
    }

    fn err_result(err: BrowserError) -> ErrorData {
        ErrorData::internal_error(format!("error: {err}"), None)
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ConnectParams {
    pub binary: Option<String>,
    pub headless: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct NavigateParams {
    pub url: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ClickParams {
    pub r#ref: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TypeParams {
    pub text: String,
    pub submit: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ScrollParams {
    pub delta_y: i64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct WaitParams {
    pub selector: String,
    pub timeout_ms: Option<u64>,
}

#[tool_router]
impl BuzzBrowserMcp {
    #[tool(
        name = "browser_connect",
        description = "Launch a browser and connect the daemon to the first page target."
    )]
    async fn connect(
        &self,
        Parameters(p): Parameters<ConnectParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut state = self.state.lock().await;
        if state.client.is_some() {
            return Err(BuzzBrowserMcp::err_result(BrowserError::Host(
                "already connected".into(),
            )));
        }
        let cfg = HostConfig {
            binary: p.binary.map(PathBuf::from),
            headless: p.headless.unwrap_or(true),
            ..HostConfig::default()
        };
        let host = launch(&cfg).await.map_err(BuzzBrowserMcp::err_result)?;
        let Some(target) = host
            .list_targets()
            .await
            .map_err(BuzzBrowserMcp::err_result)?
            .into_iter()
            .next()
        else {
            return Err(BuzzBrowserMcp::err_result(BrowserError::Host(
                "no page target".into(),
            )));
        };
        let client = CdpClient::connect(&target.ws_url)
            .await
            .map_err(BuzzBrowserMcp::err_result)?;
        state.host = Some(host);
        state.client = Some(client);
        Self::text_result("connected".into())
    }

    #[tool(
        name = "browser_tabs_list",
        description = "List open page targets with id, title, and url."
    )]
    async fn tabs_list(
        &self,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let state = self.state.lock().await;
        let Some(host) = &state.host else {
            return Err(BuzzBrowserMcp::err_result(BrowserError::Host(
                "no browser connected".into(),
            )));
        };
        let targets = host
            .list_targets()
            .await
            .map_err(BuzzBrowserMcp::err_result)?;
        let text = targets
            .iter()
            .map(|t| format!("{} | {} | {}", t.id, t.title, t.url))
            .collect::<Vec<_>>()
            .join("\n");
        Self::text_result(text)
    }

    #[tool(
        name = "browser_navigate",
        description = "Navigate the active browser tab to a URL and return a fresh snapshot."
    )]
    async fn navigate(
        &self,
        Parameters(p): Parameters<NavigateParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut state = self.state.lock().await;
        let client = state
            .client
            .as_mut()
            .ok_or_else(|| ErrorData::invalid_request("no browser connected", None))?;
        client
            .navigate(&p.url)
            .await
            .map_err(BuzzBrowserMcp::err_result)?;
        let snap = take_snapshot_budgeted(client)
            .await
            .map_err(BuzzBrowserMcp::err_result)?;
        state.ledger.record("browser_navigate", snap.chars);
        state.snapshot = Some(snap.clone());
        Self::text_result(format!("navigated to {}\n\n{snap}", p.url))
    }

    #[tool(
        name = "browser_snapshot",
        description = "Return a compact accessibility outline of the current page with refs."
    )]
    async fn snapshot(
        &self,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut state = self.state.lock().await;
        let client = state
            .client
            .as_mut()
            .ok_or_else(|| ErrorData::invalid_request("no browser connected", None))?;
        let snap = take_snapshot_budgeted(client)
            .await
            .map_err(BuzzBrowserMcp::err_result)?;
        state.ledger.record(TOOL_SNAPSHOT, snap.chars);
        state.snapshot = Some(snap.clone());
        Self::text_result(format!("{snap}"))
    }

    #[tool(
        name = "browser_click",
        description = "Click a snapshot ref (e.g. r1). Returns a fresh snapshot."
    )]
    async fn click(
        &self,
        Parameters(p): Parameters<ClickParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let snapshot = self
            .state
            .lock()
            .await
            .snapshot
            .clone()
            .ok_or_else(|| ErrorData::invalid_request("take browser_snapshot first", None))?;
        let mut state = self.state.lock().await;
        let client = state
            .client
            .as_mut()
            .ok_or_else(|| ErrorData::invalid_request("no browser connected", None))?;
        crate::input::click_ref(client, &snapshot, &p.r#ref)
            .await
            .map_err(BuzzBrowserMcp::err_result)?;
        let snap = take_snapshot_budgeted(client)
            .await
            .map_err(BuzzBrowserMcp::err_result)?;
        state.ledger.record(TOOL_CLICK, snap.chars);
        state.snapshot = Some(snap.clone());
        Self::text_result(format!("clicked {}\n\n{snap}", p.r#ref))
    }

    #[tool(
        name = "browser_type",
        description = "Type text into the focused element. submit=true presses Enter."
    )]
    async fn type_text(
        &self,
        Parameters(p): Parameters<TypeParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut state = self.state.lock().await;
        let client = state
            .client
            .as_mut()
            .ok_or_else(|| ErrorData::invalid_request("no browser connected", None))?;
        crate::input::type_text(client, &p.text)
            .await
            .map_err(BuzzBrowserMcp::err_result)?;
        if p.submit.unwrap_or(false) {
            crate::input::press_enter(client)
                .await
                .map_err(BuzzBrowserMcp::err_result)?;
        }
        let snap = take_snapshot_budgeted(client)
            .await
            .map_err(BuzzBrowserMcp::err_result)?;
        state.ledger.record(TOOL_TYPE, snap.chars);
        state.snapshot = Some(snap.clone());
        Self::text_result(format!("typed {:?}\n\n{snap}", p.text))
    }

    #[tool(
        name = "browser_scroll",
        description = "Scroll the page by deltaY pixels. Returns a fresh snapshot."
    )]
    async fn scroll(
        &self,
        Parameters(p): Parameters<ScrollParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut state = self.state.lock().await;
        let client = state
            .client
            .as_mut()
            .ok_or_else(|| ErrorData::invalid_request("no browser connected", None))?;
        crate::input::scroll_by(client, p.delta_y)
            .await
            .map_err(BuzzBrowserMcp::err_result)?;
        let snap = take_snapshot_budgeted(client)
            .await
            .map_err(BuzzBrowserMcp::err_result)?;
        state.ledger.record(TOOL_SCROLL, snap.chars);
        state.snapshot = Some(snap.clone());
        Self::text_result(format!("scrolled {}\n\n{snap}", p.delta_y))
    }

    #[tool(
        name = "browser_wait_for",
        description = "Wait until a CSS selector exists on the page."
    )]
    async fn wait_for(
        &self,
        Parameters(p): Parameters<WaitParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut state = self.state.lock().await;
        let client = state
            .client
            .as_mut()
            .ok_or_else(|| ErrorData::invalid_request("no browser connected", None))?;
        crate::input::wait_for_selector(client, &p.selector, p.timeout_ms.unwrap_or(10_000))
            .await
            .map_err(BuzzBrowserMcp::err_result)?;
        Self::text_result(format!("selector {} present", p.selector))
    }

    #[tool(
        name = "browser_screenshot",
        description = "Capture a PNG screenshot of the current viewport."
    )]
    async fn screenshot(
        &self,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut state = self.state.lock().await;
        let client = state
            .client
            .as_mut()
            .ok_or_else(|| ErrorData::invalid_request("no browser connected", None))?;
        let png = client
            .capture_screenshot()
            .await
            .map_err(BuzzBrowserMcp::err_result)?;
        state.ledger.record(TOOL_SCREENSHOT, png.len() / 10);
        Ok(CallToolResult::success(vec![Content::image(
            png,
            "image/png".to_string(),
        )]))
    }

    #[tool(
        name = "context_budget_report",
        description = "Return the per-task context budget ledger."
    )]
    async fn budget(
        &self,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let state = self.state.lock().await;
        let report = state.ledger.report();
        Self::text_result(serde_json::to_string_pretty(&report).unwrap_or_default())
    }
}

async fn take_snapshot_budgeted(client: &mut CdpClient) -> Result<Snapshot, BrowserError> {
    let caps = SnapshotCaps::default();
    crate::snapshot::take_snapshot(client, &caps).await
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for BuzzBrowserMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build()).with_server_info(
            rmcp::model::Implementation::new("buzz-browser", env!("CARGO_PKG_VERSION")),
        )
    }
}

/// Entry point used by `buzz-browserd`: serve MCP over stdio.
pub fn run_stdio_server() -> Result<(), Box<dyn std::error::Error>> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    rt.block_on(async_main())
}

async fn async_main() -> Result<(), Box<dyn std::error::Error>> {
    let state = Arc::new(Mutex::new(BrowserState::default()));
    let service = BuzzBrowserMcp::new(state).serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_names_are_stable() {
        assert_eq!(TOOL_CONNECT, "browser_connect");
        assert_eq!(TOOL_NAVIGATE, "browser_navigate");
        assert_eq!(TOOL_SNAPSHOT, "browser_snapshot");
        assert_eq!(TOOL_CLICK, "browser_click");
        assert_eq!(TOOL_TYPE, "browser_type");
        assert_eq!(TOOL_BUDGET, "context_budget_report");
    }

    #[test]
    fn module_loads() {}
}
