use std::time::Duration;

use buzz_cli_pkg::company_scan::fetch::{scan_site, CompanyScanResult, ScanError, ScanLimits};
use serde::Serialize;

const ONBOARDING_SCAN_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum OnboardingCompanyScanResult {
    Success { result: CompanyScanResult },
    Invalid { message: String },
    Failed { message: String },
    Timeout { message: String },
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

