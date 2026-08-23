use std::time::Duration;

use buzz_cli_pkg::company_scan::fetch::{
    fetch_page, scan_site, CompanyScanResult, ScanError, ScanLimits,
};
use serde::Serialize;

const ONBOARDING_SCAN_TIMEOUT: Duration = Duration::from_secs(300);

/// Ceiling for one claim-source page fetch.
///
/// A claim verification runs before a render, so it must answer quickly; the
/// scan's ten-second request timeout doubled covers one slow redirect chain,
/// and the guard's byte cap bounds the read regardless.
const CLAIM_SOURCE_FETCH_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum OnboardingCompanyScanResult {
    Success { result: CompanyScanResult },
    Invalid { message: String },
    Failed { message: String },
    Timeout { message: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum ClaimSourcePageResult {
    Success { body: String },
    Invalid { message: String },
    Failed { message: String },
    Timeout { message: String },
}

#[tauri::command]
pub async fn fetch_claim_source_page(url: String) -> ClaimSourcePageResult {
    let limits = ScanLimits {
        request_timeout: CLAIM_SOURCE_FETCH_TIMEOUT,
        total_timeout: CLAIM_SOURCE_FETCH_TIMEOUT,
        ..ScanLimits::default()
    };

    match tokio::time::timeout(CLAIM_SOURCE_FETCH_TIMEOUT, fetch_page(&url, limits)).await {
        Err(_) => ClaimSourcePageResult::Timeout {
            message: "Colony stopped the page fetch after 20 seconds.".to_string(),
        },
        Ok(Ok(body)) => ClaimSourcePageResult::Success { body },
        Ok(Err(ScanError::Rejected(error))) => ClaimSourcePageResult::Invalid {
            message: error.to_string(),
        },
        Ok(Err(error)) => ClaimSourcePageResult::Failed {
            message: error.to_string(),
        },
    }
}

#[tauri::command]
pub async fn scan_onboarding_company_website(url: String) -> OnboardingCompanyScanResult {
    let limits = ScanLimits {
        total_timeout: ONBOARDING_SCAN_TIMEOUT,
        ..ScanLimits::default()
    };

    match tokio::time::timeout(ONBOARDING_SCAN_TIMEOUT, scan_site(&url, limits)).await {
        Err(_) => OnboardingCompanyScanResult::Timeout {
            message: "Colony stopped the website scan after 300 seconds.".to_string(),
        },
        Ok(Ok(result)) => OnboardingCompanyScanResult::Success { result },
        Ok(Err(ScanError::Rejected(error))) => OnboardingCompanyScanResult::Invalid {
            message: error.to_string(),
        },
        Ok(Err(error)) => OnboardingCompanyScanResult::Failed {
            message: error.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn onboarding_scan_uses_the_approved_five_minute_ceiling() {
        assert_eq!(ONBOARDING_SCAN_TIMEOUT, Duration::from_secs(300));
    }
}
