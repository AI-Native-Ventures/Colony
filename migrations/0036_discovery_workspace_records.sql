-- Private campaigns and requester-private reads for the native Discovery UI
-- and the same agent-facing primitive. No credentials or raw provider payloads
-- enter these tables or their signed receipt events.

CREATE TABLE discovery_campaigns (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    id UUID NOT NULL,
    created_by BYTEA NOT NULL CHECK (octet_length(created_by) = 32),
    name TEXT NOT NULL CHECK (
        octet_length(name) BETWEEN 1 AND 256
        AND name = btrim(name)
        AND name !~ '[[:cntrl:]]'
    ),
    industry_id TEXT NOT NULL CHECK (
        octet_length(industry_id) BETWEEN 1 AND 128
        AND industry_id ~ '^[a-z0-9-]+$'
    ),
    industry_name TEXT NOT NULL CHECK (
        octet_length(industry_name) BETWEEN 1 AND 256
        AND industry_name = btrim(industry_name)
        AND industry_name !~ '[[:cntrl:]]'
    ),
    vertical_id TEXT NOT NULL CHECK (
        octet_length(vertical_id) BETWEEN 1 AND 128
        AND vertical_id ~ '^[a-z0-9-]+$'
    ),
    vertical_name TEXT NOT NULL CHECK (
        octet_length(vertical_name) BETWEEN 1 AND 256
        AND vertical_name = btrim(vertical_name)
        AND vertical_name !~ '[[:cntrl:]]'
    ),
    query TEXT NOT NULL CHECK (
        octet_length(query) BETWEEN 1 AND 256
        AND query = btrim(query)
        AND query !~ '[[:cntrl:]]'
    ),
    location TEXT NOT NULL CHECK (
        octet_length(location) BETWEEN 1 AND 256
        AND location = btrim(location)
        AND location !~ '[[:cntrl:]]'
    ),
    target SMALLINT NOT NULL CHECK (target BETWEEN 1 AND 500),
    description TEXT CHECK (
        description IS NULL OR (
            octet_length(description) BETWEEN 1 AND 2048
            AND description = btrim(description)
            AND description !~ '[[:cntrl:]]'
        )
    ),
    language TEXT NOT NULL CHECK (language ~ '^[a-z]{2}$'),
    region TEXT CHECK (region IS NULL OR region ~ '^[A-Z]{2}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, id)
);

CREATE INDEX discovery_campaigns_taxonomy_created_idx
    ON discovery_campaigns (community_id, industry_id, vertical_id, created_at DESC, id DESC);

CREATE TABLE discovery_workspace_action_claims (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    idempotency_key UUID NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN (
        'access', 'create_campaign', 'get_campaign', 'list_campaigns', 'list_leads'
    )),
    request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    action_event_id BYTEA NOT NULL CHECK (octet_length(action_event_id) = 32),
    receipt_event_id BYTEA NOT NULL CHECK (octet_length(receipt_event_id) = 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, idempotency_key),
    UNIQUE (community_id, action_event_id)
);

-- Keep private workspace actions and receipts outside NIP-50 full-text search
-- while preserving every previously installed exclusion expression.
DO $$
DECLARE
    existing_expression TEXT;
BEGIN
    SELECT pg_get_expr(d.adbin, d.adrelid)
      INTO existing_expression
      FROM pg_attrdef d
      JOIN pg_attribute a
        ON a.attrelid = d.adrelid
       AND a.attnum = d.adnum
     WHERE d.adrelid = 'events'::regclass
       AND a.attname = 'search_tsv';

    IF existing_expression IS NULL THEN
        RAISE EXCEPTION 'events.search_tsv generated expression not found';
    END IF;

    ALTER TABLE events DROP COLUMN search_tsv;
    EXECUTE format(
        'ALTER TABLE events ADD COLUMN search_tsv TSVECTOR GENERATED ALWAYS AS (CASE WHEN kind IN (40021, 40022) THEN NULL::tsvector ELSE (%s) END) STORED',
        existing_expression
    );
    CREATE INDEX idx_events_search_tsv ON events USING GIN (search_tsv);
END $$;
