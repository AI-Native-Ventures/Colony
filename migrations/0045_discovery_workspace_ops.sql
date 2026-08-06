-- Phase A: extend the private Discovery workspace contract with lead-count
-- aggregation. The operation check must admit every current operation plus
-- the new list_lead_counts read.
ALTER TABLE discovery_workspace_action_claims
    DROP CONSTRAINT discovery_workspace_action_claims_operation_check,
    ADD CONSTRAINT discovery_workspace_action_claims_operation_check
        CHECK (operation IN (
            'access',
            'create_campaign',
            'update_campaign_sources',
            'get_campaign',
            'list_campaigns',
            'list_leads',
            'list_lead_counts'
        ));
