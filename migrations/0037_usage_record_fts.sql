-- NIP-CL kind:44210 usage records carry NIP-44 ciphertext addressed to the
-- owner, and together they disclose the company's entire spend history.
-- Exclude them from full-text search without changing the search policy of
-- existing installations, exactly as 0014 did for kind:30350.
--
-- Fresh installations already reach NULL through the positive allowlist that
-- 0008 installs on empty databases. Populated databases keep the older
-- denylist expression, where an unlisted kind IS indexed, so the exclusion
-- has to be stated rather than assumed.
--
-- PostgreSQL cannot alter a generated expression in place. Capture the current
-- expression before replacing the column, then wrap it with the new exclusion.
-- This preserves both the fresh-install allowlist and any brownfield or
-- operator-managed expression for every kind other than 44210.
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
        'ALTER TABLE events ADD COLUMN search_tsv TSVECTOR GENERATED ALWAYS AS (CASE WHEN kind = 44210 THEN NULL::tsvector ELSE (%s) END) STORED',
        existing_expression
    );
    CREATE INDEX idx_events_search_tsv ON events USING GIN (search_tsv);
END $$;
