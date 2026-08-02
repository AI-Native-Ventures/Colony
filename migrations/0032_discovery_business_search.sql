-- Immutable, non-secret provider input for new Businesses Discovery runs.
--
-- Historical foundation runs remain readable without a search row. External
-- workers claim only runs that have one, so no worker invents provider input.

CREATE TABLE discovery_run_business_searches (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    run_id UUID NOT NULL,
    query TEXT NOT NULL
        CHECK (
            octet_length(query) BETWEEN 1 AND 256
            AND query = btrim(query)
            AND query !~ '[[:cntrl:]]'
        ),
    location TEXT NOT NULL
        CHECK (
            octet_length(location) BETWEEN 1 AND 256
            AND location = btrim(location)
            AND location !~ '[[:cntrl:]]'
        ),
    result_limit SMALLINT NOT NULL CHECK (result_limit BETWEEN 1 AND 500),
    language TEXT NOT NULL CHECK (language ~ '^[a-z]{2}$'),
    region TEXT CHECK (region IS NULL OR region ~ '^[A-Z]{2}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, run_id),
    FOREIGN KEY (community_id, run_id)
        REFERENCES discovery_runs(community_id, id) ON DELETE CASCADE
);
