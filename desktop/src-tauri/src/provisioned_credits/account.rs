use super::{parse_balance_nanousd, GatewayAccount, GatewayAccountStatus};

impl GatewayAccount {
    pub fn balance_nanousd_i128(&self) -> Result<i128, String> {
        if self.currency != "USD" {
            return Err("gateway account returned an unsupported currency".to_string());
        }
        let balance = parse_balance_nanousd(&self.balance_nanousd)?;
        let total = optional_balance(&self.total_balance_nanousd, balance)?;
        let reserved = optional_balance(&self.discovery_reserved_nanousd, 0)?;
        let gateway_reserved = optional_balance(&self.gateway_reserved_nanousd, 0)?;
        let available = optional_balance(&self.available_balance_nanousd, balance)?;
        let expected = total
            .saturating_sub(reserved)
            .saturating_sub(gateway_reserved);
        if reserved < 0 || gateway_reserved < 0
            || available != expected
            || balance != available
        {
            return Err("gateway account balance breakdown is inconsistent".to_string());
        }
        let computed = if balance > 0 {
            GatewayAccountStatus::Active
        } else {
            GatewayAccountStatus::Depleted
        };
        if self.status != computed {
            return Err("gateway account status does not match its balance".to_string());
        }
        Ok(balance)
    }
}

fn optional_balance(value: &str, default: i128) -> Result<i128, String> {
    if value.is_empty() {
        Ok(default)
    } else {
        parse_balance_nanousd(value)
    }
}
