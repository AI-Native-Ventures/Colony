-- Provider-neutral Businesses records retained from user-funded Discovery.
-- Only normalized allowlisted fields enter Colony; raw provider payloads and
-- credentials remain outside relay storage.

ALTER TABLE discovery_run_checkpoints
    ADD CONSTRAINT discovery_run_checkpoints_bounded_results
        CHECK (item_count IS NULL OR item_count <= 500);

CREATE TABLE discovery_business_observations (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    id UUID NOT NULL,
    first_run_id UUID NOT NULL,
    provider TEXT NOT NULL CHECK (provider = 'outscraper'),
    provider_record_id TEXT NOT NULL CHECK (
        octet_length(provider_record_id) BETWEEN 1 AND 256
        AND provider_record_id ~ '^[A-Za-z0-9:_-]+$'
    ),
    place_id TEXT CHECK (
        place_id IS NULL OR (
            octet_length(place_id) BETWEEN 1 AND 256
            AND place_id ~ '^[A-Za-z0-9:_-]+$'
        )
    ),
    google_id TEXT CHECK (
        google_id IS NULL OR (
            octet_length(google_id) BETWEEN 1 AND 256
            AND google_id ~ '^[A-Za-z0-9:_-]+$'
        )
    ),
    name TEXT NOT NULL CHECK (
        octet_length(name) BETWEEN 1 AND 256
        AND name = btrim(name)
        AND name !~ '[[:cntrl:]]'
    ),
    website TEXT CHECK (
        website IS NULL OR (
            octet_length(website) BETWEEN 1 AND 2048
            AND website ~ '^https?://'
            AND website !~ '[[:cntrl:]]'
        )
    ),
    phone TEXT CHECK (
        phone IS NULL OR (
            octet_length(phone) BETWEEN 1 AND 64
            AND phone = btrim(phone)
            AND phone !~ '[[:cntrl:]]'
        )
    ),
    full_address TEXT CHECK (
        full_address IS NULL OR (
            octet_length(full_address) BETWEEN 1 AND 512
            AND full_address = btrim(full_address)
            AND full_address !~ '[[:cntrl:]]'
        )
    ),
    city TEXT CHECK (city IS NULL OR octet_length(city) BETWEEN 1 AND 128),
    state TEXT CHECK (state IS NULL OR octet_length(state) BETWEEN 1 AND 128),
    postal_code TEXT CHECK (postal_code IS NULL OR octet_length(postal_code) BETWEEN 1 AND 128),
    country TEXT CHECK (country IS NULL OR octet_length(country) BETWEEN 1 AND 128),
    country_code TEXT CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
    latitude_micros INTEGER CHECK (latitude_micros BETWEEN -90000000 AND 90000000),
    longitude_micros INTEGER CHECK (longitude_micros BETWEEN -180000000 AND 180000000),
    category TEXT CHECK (category IS NULL OR octet_length(category) BETWEEN 1 AND 128),
    subtypes TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(subtypes) <= 20),
    rating_hundredths SMALLINT CHECK (rating_hundredths BETWEEN 0 AND 500),
    reviews_count BIGINT CHECK (reviews_count >= 0),
    business_status TEXT CHECK (
        business_status IS NULL OR business_status IN (
            'operational', 'temporarily_closed', 'permanently_closed'
        )
    ),
    verified BOOLEAN,
    source_url TEXT CHECK (
        source_url IS NULL OR (
            octet_length(source_url) BETWEEN 1 AND 2048
            AND source_url ~ '^https?://'
            AND source_url !~ '[[:cntrl:]]'
        )
    ),
    image_url TEXT CHECK (
        image_url IS NULL OR (
            octet_length(image_url) BETWEEN 1 AND 2048
            AND image_url ~ '^https?://'
            AND image_url !~ '[[:cntrl:]]'
        )
    ),
    observation_fingerprint BYTEA NOT NULL CHECK (octet_length(observation_fingerprint) = 32),
    first_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, id),
    UNIQUE (community_id, provider, provider_record_id),
    FOREIGN KEY (community_id, first_run_id)
        REFERENCES discovery_runs(community_id, id)
);

CREATE INDEX discovery_business_observations_first_run_idx
    ON discovery_business_observations (community_id, first_run_id, first_observed_at);

-- Per-run source accounting uses counts only. The provider bills the user's
-- own account; Colony does not calculate or retain a platform credit cost.
CREATE TABLE discovery_usage (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    run_id UUID NOT NULL,
    provider TEXT NOT NULL CHECK (provider = 'outscraper'),
    provider_request_id TEXT NOT NULL CHECK (
        octet_length(provider_request_id) BETWEEN 1 AND 128
        AND provider_request_id ~ '^[A-Za-z0-9_-]+$'
    ),
    stored_count INTEGER NOT NULL DEFAULT 0 CHECK (stored_count >= 0),
    existing_count INTEGER NOT NULL DEFAULT 0 CHECK (existing_count >= 0),
    returned_count INTEGER CHECK (returned_count IS NULL OR returned_count >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, run_id),
    UNIQUE (community_id, provider, provider_request_id),
    FOREIGN KEY (community_id, run_id)
        REFERENCES discovery_runs(community_id, id) ON DELETE CASCADE
);

CREATE TABLE discovery_observation_batches (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    run_id UUID NOT NULL,
    provider_request_id TEXT NOT NULL CHECK (
        octet_length(provider_request_id) BETWEEN 1 AND 128
        AND provider_request_id ~ '^[A-Za-z0-9_-]+$'
    ),
    batch_index SMALLINT NOT NULL CHECK (batch_index BETWEEN 0 AND 19),
    batch_fingerprint BYTEA NOT NULL CHECK (octet_length(batch_fingerprint) = 32),
    accepted_count SMALLINT NOT NULL CHECK (accepted_count BETWEEN 0 AND 25),
    existing_count SMALLINT NOT NULL CHECK (existing_count BETWEEN 0 AND 25),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, run_id, provider_request_id, batch_index),
    FOREIGN KEY (community_id, run_id)
        REFERENCES discovery_runs(community_id, id) ON DELETE CASCADE,
    CHECK (accepted_count + existing_count BETWEEN 1 AND 25)
);

ALTER TABLE discovery_worker_action_claims
    DROP CONSTRAINT discovery_worker_action_claims_operation_check,
    ADD CONSTRAINT discovery_worker_action_claims_operation_check
        CHECK (operation IN ('claim', 'heartbeat', 'checkpoint', 'store_observations', 'complete'));
