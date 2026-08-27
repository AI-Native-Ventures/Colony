-- Discovery entity mentions: the workspace broker accepts search_entities and
-- resolve_entities actions, so the claims table must admit their operation
-- names. Without this, every entity search or mention hydration resolve dies
-- as an internal error when its claim row is inserted.

ALTER TABLE discovery_workspace_action_claims
    DROP CONSTRAINT discovery_workspace_action_claims_operation_check,
    ADD CONSTRAINT discovery_workspace_action_claims_operation_check
        CHECK (operation IN (
            'access',
            'create_campaign',
            'update_campaign_sources',
            'approve_campaign_budget',
            'pause_campaign_budget',
            'revoke_campaign_budget',
            'get_campaign_budget',
            'get_campaign',
            'list_campaigns',
            'list_leads',
            'list_lead_counts',
            'get_lead',
            'update_lead',
            'search_entities',
            'resolve_entities'
        ));
