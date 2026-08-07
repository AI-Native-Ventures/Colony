-- Phase B: mutable lead state for the Discovery CRM surface. The observation
-- row stays immutable; this profile carries human/agent edits and the funnel
-- status, whose vocabulary and transitions come from the Party contract.
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
            'list_lead_counts',
            'get_lead',
            'update_lead'
        ));

CREATE TABLE discovery_lead_profiles (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    lead_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'candidate'
        CHECK (status IN (
            'candidate', 'accepted', 'qualified', 'dormant', 'disqualified',
            'client_active'
        )),
    owner_persona_id TEXT,
    website TEXT,
    email TEXT,
    phone TEXT,
    linkedin_url TEXT,
    contact_name TEXT,
    contact_title TEXT,
    notes TEXT CHECK (notes IS NULL OR octet_length(notes) <= 8000),
    score SMALLINT CHECK (score IS NULL OR score BETWEEN 0 AND 100),
    updated_by BYTEA NOT NULL CHECK (octet_length(updated_by) = 32),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, lead_id),
    FOREIGN KEY (community_id, lead_id)
        REFERENCES discovery_business_observations(community_id, id)
        ON DELETE CASCADE
);

CREATE INDEX discovery_lead_profiles_status_idx
    ON discovery_lead_profiles (community_id, status);
