-- Colony-funded Discovery keeps provider credentials outside user devices and
-- charges a fixed amount only for newly retained, deduplicated Leads.
-- Campaign budgets are approved once, reserved before work starts, and settled
-- exactly once when a run reaches a terminal state.

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
            'update_lead'
        ));

ALTER TABLE discovery_campaigns
    ADD COLUMN budget_payer_pubkey BYTEA
        CHECK (budget_payer_pubkey IS NULL OR octet_length(budget_payer_pubkey) = 32),
    ADD COLUMN budget_approved_nanousd BIGINT NOT NULL DEFAULT 0
        CHECK (budget_approved_nanousd >= 0),
    ADD COLUMN budget_spent_nanousd BIGINT NOT NULL DEFAULT 0
        CHECK (budget_spent_nanousd >= 0),
    ADD COLUMN budget_reserved_nanousd BIGINT NOT NULL DEFAULT 0
        CHECK (budget_reserved_nanousd >= 0),
    ADD COLUMN budget_state TEXT NOT NULL DEFAULT 'unapproved'
        CHECK (budget_state IN ('unapproved', 'active', 'paused', 'revoked', 'exhausted')),
    ADD COLUMN budget_approval_event_id BYTEA
        CHECK (budget_approval_event_id IS NULL OR octet_length(budget_approval_event_id) = 32),
    ADD COLUMN budget_approved_at TIMESTAMPTZ,
    ADD COLUMN budget_fingerprint BYTEA
        CHECK (budget_fingerprint IS NULL OR octet_length(budget_fingerprint) = 32),
    ADD COLUMN price_per_retained_lead_nanousd BIGINT
        CHECK (price_per_retained_lead_nanousd IS NULL OR price_per_retained_lead_nanousd > 0),
    ADD CONSTRAINT discovery_campaigns_spent_and_reserved_within_approved CHECK (
        budget_spent_nanousd::NUMERIC + budget_reserved_nanousd::NUMERIC
            <= budget_approved_nanousd::NUMERIC
    ),
    ADD CONSTRAINT discovery_campaigns_budget_approval_complete CHECK (
        (
            budget_state = 'unapproved'
            AND budget_payer_pubkey IS NULL
            AND budget_approved_nanousd = 0
            AND budget_spent_nanousd = 0
            AND budget_reserved_nanousd = 0
            AND budget_approval_event_id IS NULL
            AND budget_approved_at IS NULL
            AND budget_fingerprint IS NULL
            AND price_per_retained_lead_nanousd IS NULL
        ) OR (
            budget_state <> 'unapproved'
            AND budget_payer_pubkey IS NOT NULL
            AND budget_approved_nanousd > 0
            AND budget_approval_event_id IS NOT NULL
            AND budget_approved_at IS NOT NULL
            AND budget_fingerprint IS NOT NULL
            AND price_per_retained_lead_nanousd IS NOT NULL
        )
    );

CREATE INDEX discovery_campaigns_budget_payer_active_idx
    ON discovery_campaigns (budget_payer_pubkey, budget_state)
    INCLUDE (budget_reserved_nanousd)
    WHERE budget_payer_pubkey IS NOT NULL;

CREATE UNIQUE INDEX discovery_campaign_budget_approval_event_unique
    ON discovery_campaigns (community_id, budget_approval_event_id)
    WHERE budget_approval_event_id IS NOT NULL;

CREATE INDEX discovery_runs_community_campaign_idx
    ON discovery_runs (community_id, campaign_id, created_at DESC);

ALTER TABLE discovery_runs
    DROP CONSTRAINT discovery_runs_discovery_protocol_version_check,
    DROP CONSTRAINT discovery_runs_lease_worker_protocol_version_check,
    ADD CONSTRAINT discovery_runs_discovery_protocol_version_check
        CHECK (discovery_protocol_version IN (1, 2, 3)),
    ADD CONSTRAINT discovery_runs_lease_worker_protocol_version_check
        CHECK (lease_worker_protocol_version IN (1, 2, 3)),
    ADD COLUMN payer_pubkey BYTEA
        CHECK (payer_pubkey IS NULL OR octet_length(payer_pubkey) = 32),
    ADD COLUMN price_per_retained_lead_nanousd BIGINT
        CHECK (price_per_retained_lead_nanousd IS NULL OR price_per_retained_lead_nanousd > 0),
    ADD COLUMN billable_lead_limit SMALLINT
        CHECK (billable_lead_limit IS NULL OR billable_lead_limit BETWEEN 1 AND 500),
    ADD COLUMN reserved_nanousd BIGINT
        CHECK (reserved_nanousd IS NULL OR reserved_nanousd >= 0),
    ADD COLUMN settled_nanousd BIGINT
        CHECK (settled_nanousd IS NULL OR settled_nanousd >= 0),
    ADD COLUMN released_nanousd BIGINT
        CHECK (released_nanousd IS NULL OR released_nanousd >= 0),
    ADD COLUMN billed_retained_lead_count SMALLINT
        CHECK (
            billed_retained_lead_count IS NULL
            OR billed_retained_lead_count BETWEEN 0 AND 500
        ),
    ADD COLUMN settlement_ref TEXT
        CHECK (
            settlement_ref IS NULL OR (
                octet_length(settlement_ref) BETWEEN 1 AND 256
                AND settlement_ref = btrim(settlement_ref)
                AND settlement_ref !~ '[[:cntrl:]]'
            )
        ),
    ADD COLUMN settled_at TIMESTAMPTZ,
    ADD CONSTRAINT discovery_runs_billing_snapshot_complete CHECK (
        (
            discovery_protocol_version < 3
            AND payer_pubkey IS NULL
            AND price_per_retained_lead_nanousd IS NULL
            AND billable_lead_limit IS NULL
            AND reserved_nanousd IS NULL
            AND settled_nanousd IS NULL
            AND released_nanousd IS NULL
            AND billed_retained_lead_count IS NULL
            AND settlement_ref IS NULL
            AND settled_at IS NULL
        ) OR (
            discovery_protocol_version = 3
            AND payer_pubkey IS NOT NULL
            AND price_per_retained_lead_nanousd IS NOT NULL
            AND billable_lead_limit IS NOT NULL
            AND reserved_nanousd IS NOT NULL
            AND reserved_nanousd::NUMERIC =
                price_per_retained_lead_nanousd::NUMERIC * billable_lead_limit::NUMERIC
            AND (
                (
                    state IN ('queued', 'running')
                    AND
                    settled_nanousd IS NULL
                    AND released_nanousd IS NULL
                    AND billed_retained_lead_count IS NULL
                    AND settlement_ref IS NULL
                    AND settled_at IS NULL
                ) OR (
                    state IN ('succeeded', 'cancelled', 'failed')
                    AND
                    settled_nanousd IS NOT NULL
                    AND released_nanousd IS NOT NULL
                    AND billed_retained_lead_count IS NOT NULL
                    AND billed_retained_lead_count <= billable_lead_limit
                    AND settlement_ref IS NOT NULL
                    AND settled_at IS NOT NULL
                    AND settled_nanousd::NUMERIC + released_nanousd::NUMERIC
                        = reserved_nanousd::NUMERIC
                    AND settled_nanousd::NUMERIC =
                        price_per_retained_lead_nanousd::NUMERIC
                            * billed_retained_lead_count::NUMERIC
                )
            )
        )
    );

ALTER TABLE discovery_run_sources
    ADD COLUMN provider_poll_after TIMESTAMPTZ;

-- Every Colony-funded provider attempt is durable before the request leaves
-- the relay. One Campaign can spend at most once per provider, and a lost
-- client acknowledgement can replay the exact stored result without buying
-- the same search twice.
CREATE TABLE discovery_gateway_attempts (
    community_id UUID NOT NULL,
    campaign_id UUID NOT NULL,
    run_id UUID NOT NULL,
    payer_pubkey BYTEA NOT NULL CHECK (octet_length(payer_pubkey) = 32),
    provider TEXT NOT NULL CHECK (provider IN ('outscraper','brave_search','exa_search')),
    intent_id TEXT NOT NULL CHECK (
        octet_length(intent_id) BETWEEN 1 AND 128
        AND intent_id = btrim(intent_id)
        AND intent_id !~ '[[:cntrl:]]'
    ),
    provider_request_id TEXT CHECK (
        provider_request_id IS NULL OR (
            octet_length(provider_request_id) BETWEEN 1 AND 128
            AND provider_request_id = btrim(provider_request_id)
            AND provider_request_id !~ '[[:cntrl:]]'
        )
    ),
    status TEXT NOT NULL CHECK (status IN ('intent','pending','ready')),
    observations JSONB NOT NULL DEFAULT '[]'::JSONB
        CHECK (jsonb_typeof(observations) = 'array'),
    returned_count INTEGER NOT NULL DEFAULT 0 CHECK (returned_count BETWEEN 0 AND 500),
    retained_count INTEGER NOT NULL DEFAULT 0 CHECK (retained_count BETWEEN 0 AND 500),
    duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count BETWEEN 0 AND 500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, campaign_id, provider),
    UNIQUE (community_id, run_id, provider),
    FOREIGN KEY (community_id, campaign_id)
        REFERENCES discovery_campaigns(community_id, id) ON DELETE CASCADE,
    FOREIGN KEY (community_id, run_id)
        REFERENCES discovery_runs(community_id, id) ON DELETE CASCADE
);

CREATE INDEX discovery_gateway_attempts_payer_recent_idx
    ON discovery_gateway_attempts (payer_pubkey, created_at DESC);

-- A workspace-unique Lead can belong to every Campaign that finds it. This
-- keeps cross-provider dedupe from making a valid Campaign result disappear.
CREATE TABLE discovery_campaign_leads (
    community_id UUID NOT NULL,
    campaign_id UUID NOT NULL,
    lead_id UUID NOT NULL,
    discovered_run_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, campaign_id, lead_id),
    FOREIGN KEY (community_id, campaign_id)
        REFERENCES discovery_campaigns(community_id, id) ON DELETE CASCADE,
    FOREIGN KEY (community_id, lead_id)
        REFERENCES discovery_business_observations(community_id, id) ON DELETE CASCADE,
    FOREIGN KEY (community_id, discovered_run_id)
        REFERENCES discovery_runs(community_id, id) ON DELETE CASCADE
);

CREATE INDEX discovery_campaign_leads_lead_idx
    ON discovery_campaign_leads (community_id, lead_id);

INSERT INTO discovery_campaign_leads
    (community_id,campaign_id,lead_id,discovered_run_id,created_at)
SELECT o.community_id,r.campaign_id,o.id,o.first_run_id,o.first_observed_at
FROM discovery_business_observations o
JOIN discovery_runs r ON r.community_id=o.community_id AND r.id=o.first_run_id
ON CONFLICT DO NOTHING;

-- Migration 0059 attached the universal community write fence to every
-- tenant table that existed at that point. These tables are newer, so attach
-- the same fence explicitly before the relay can serve writes through them.
SELECT attach_community_write_fence('discovery_gateway_attempts'::REGCLASS);
SELECT attach_community_write_fence('discovery_campaign_leads'::REGCLASS);

CREATE UNIQUE INDEX discovery_runs_settlement_ref_idx
    ON discovery_runs (community_id, settlement_ref)
    WHERE settlement_ref IS NOT NULL;

-- Protocol 3 workers must bind their version to the exact active claim, just
-- as protocol 2 workers do. Older workers cannot claim paid runs.
CREATE OR REPLACE FUNCTION discovery_guard_lease_worker_protocol() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.claim_id IS NULL THEN
        NEW.lease_worker_protocol_version := NULL;
        NEW.lease_worker_protocol_claim_id := NULL;
        RETURN NEW;
    END IF;
    IF NEW.lease_worker_protocol_version IN (2, 3)
       AND NEW.lease_worker_protocol_claim_id=NEW.claim_id
    THEN
        IF NEW.lease_worker_protocol_version <> NEW.discovery_protocol_version THEN
            RAISE EXCEPTION
                'Discovery worker protocol does not match the run protocol'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    NEW.lease_worker_protocol_version := 1;
    NEW.lease_worker_protocol_claim_id := NEW.claim_id;
    IF NEW.discovery_protocol_version <> 1 THEN
        RAISE EXCEPTION
            'Discovery protocol V1 worker cannot claim a newer protocol run'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE credit_ledger
    ADD COLUMN service TEXT CHECK (service IN ('model', 'discovery')),
    ADD COLUMN quantity BIGINT CHECK (quantity IS NULL OR quantity > 0),
    ADD COLUMN unit_price_nanousd BIGINT
        CHECK (unit_price_nanousd IS NULL OR unit_price_nanousd > 0),
    ADD COLUMN discovery_community_id UUID,
    ADD COLUMN discovery_campaign_id UUID,
    ADD COLUMN discovery_run_id UUID;

UPDATE credit_ledger
SET service = 'model'
WHERE kind = 'debit' AND model IS NOT NULL;

ALTER TABLE credit_ledger
    ADD CONSTRAINT discovery_ledger_attribution_complete CHECK (
        (
            service IS NULL
            AND model IS NULL
            AND quantity IS NULL
            AND unit_price_nanousd IS NULL
            AND discovery_community_id IS NULL
            AND discovery_campaign_id IS NULL
            AND discovery_run_id IS NULL
        ) OR (
            service = 'model'
            AND model IS NOT NULL
            AND quantity IS NULL
            AND unit_price_nanousd IS NULL
            AND discovery_community_id IS NULL
            AND discovery_campaign_id IS NULL
            AND discovery_run_id IS NULL
        ) OR (
            service = 'discovery'
            AND kind = 'debit'
            AND delta < 0
            AND model IS NULL
            AND observed_cost IS NULL
            AND request_id IS NULL
            AND settle_basis IS NULL
            AND quantity IS NOT NULL
            AND unit_price_nanousd IS NOT NULL
            AND discovery_community_id IS NOT NULL
            AND discovery_campaign_id IS NOT NULL
            AND discovery_run_id IS NOT NULL
            AND (-delta::NUMERIC) = quantity::NUMERIC * unit_price_nanousd::NUMERIC
        )
    ),
    ADD CONSTRAINT credit_ledger_model_service_complete CHECK (
        model IS NULL OR (service IS NOT NULL AND service = 'model')
    );

CREATE UNIQUE INDEX credit_ledger_discovery_run_idx
    ON credit_ledger (pubkey, discovery_run_id)
    WHERE service = 'discovery';
