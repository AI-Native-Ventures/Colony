-- Split the `events` catch-all partition into real monthly partitions.
--
-- Run through deploy/fly/split-events-catch-all.sh, which sets
-- `colony.split_dry_run` and ships this file to the production database.
-- Executed on its own, this file does nothing: an unset `colony.split_dry_run`
-- means dry run.
--
-- Why this exists: `migrations/0001_initial_schema.sql` fixes the lower bound
-- of `events_p_future` at 2026-07-01, and until the buzz-db partition manager
-- learned to roll it forward, every month from July 2026 onwards landed in it.
-- The manager can only roll a catch-all that is empty below the month it is
-- carving out, because ATTACH PARTITION validates every remaining row against
-- the new lower bound. Once rows are in there, moving them is an operator job,
-- and this is that job.
--
-- What it costs: one ACCESS EXCLUSIVE lock on `events` held for the whole
-- transaction, so every read and write of `events` blocks for its duration
-- (one to three minutes at 314k rows). Run it in a window the owner picked.
--
-- `session_replication_role = replica` is the point of the transaction, not a
-- detail: `events` carries 8 user triggers, and the row move must fire none of
-- them. `community_write_fence_events` would reject the insert outright,
-- `events_enqueue_push_match` would enqueue a push job per row,
-- `events_refresh_channel_ttl` would rewrite every channel's TTL, and
-- `events_created_at_floor` would reject every row older than the replica
-- fence floor. A plain INSERT here would not be slow, it would be wrong.
--
-- `delivery_log` has the same catch-all shape but is empty, so the partition
-- manager rolls it forward at relay startup without any operator step.

\set ON_ERROR_STOP on

BEGIN;

-- Partition bounds were written as UTC dates. `date_trunc` and `to_char`
-- resolve against the session time zone, so pin it rather than inherit it.
SET LOCAL TimeZone = 'UTC';
SET LOCAL lock_timeout = '10s';

DO $split$
DECLARE
    catch_all     CONSTANT text := 'events_p_future';
    parked        CONSTANT text := 'events_p_future_old';
    dry_run       boolean;
    bound_expr    text;
    lower_bound   timestamptz;
    last_month    timestamptz;
    new_lower     timestamptz;
    month_start   timestamptz;
    part_name     text;
    column_list   text;
    rows_in_tree  bigint;
    rows_in_catch bigint;
    rows_moved    bigint;
    rec           record;
BEGIN
    -- Anything other than an explicit 'false' is a dry run, including unset.
    dry_run := COALESCE(current_setting('colony.split_dry_run', true), 'true') <> 'false';

    ----------------------------------------------------------------------
    -- Preconditions. Each one is a refusal, not a warning.
    ----------------------------------------------------------------------

    SELECT pg_catalog.pg_get_expr(c.relpartbound, c.oid)
      INTO bound_expr
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid
     WHERE i.inhparent = 'events'::regclass
       AND c.relname = catch_all;

    IF bound_expr IS NULL THEN
        RAISE EXCEPTION '% is not a partition of events; nothing to split', catch_all;
    END IF;
    IF bound_expr NOT LIKE '%TO (MAXVALUE)' THEN
        RAISE EXCEPTION '% is not the right-edge catch-all (bound: %)', catch_all, bound_expr;
    END IF;

    lower_bound := substring(bound_expr from 'FROM \(''([^'']+)''\)')::timestamptz;
    IF lower_bound IS NULL THEN
        RAISE EXCEPTION 'could not read the lower bound of % (bound: %)', catch_all, bound_expr;
    END IF;

    IF to_char(lower_bound, 'YYYY-MM-DD HH24:MI:SS') <> to_char(date_trunc('month', lower_bound), 'YYYY-MM-DD HH24:MI:SS') THEN
        RAISE EXCEPTION '% starts mid-month (%); this script only splits on month boundaries',
            catch_all, lower_bound;
    END IF;

    -- Every row at or after the catch-all's lower bound must be inside the
    -- catch-all. If some other partition also covers that span, the rebuild
    -- below would silently change where those rows live.
    EXECUTE format('SELECT count(*) FROM events WHERE created_at >= %L', lower_bound)
       INTO rows_in_tree;
    EXECUTE format('SELECT count(*) FROM ONLY %I', catch_all)
       INTO rows_in_catch;
    IF rows_in_tree <> rows_in_catch THEN
        RAISE EXCEPTION
            '% is not the only partition holding rows at or after %: % rows in the table, % in the catch-all',
            catch_all, lower_bound, rows_in_tree, rows_in_catch;
    END IF;

    IF to_regclass(parked) IS NOT NULL THEN
        RAISE EXCEPTION '% already exists; a previous run left it behind', parked;
    END IF;

    -- Without this the row move fires all 8 triggers. Proving it can be set is
    -- a precondition, so a run that cannot disable them refuses before locking.
    BEGIN
        SET session_replication_role = replica;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'cannot set session_replication_role = replica (needs superuser): %', SQLERRM;
    END;
    IF current_setting('session_replication_role') <> 'replica' THEN
        RAISE EXCEPTION 'session_replication_role did not take (is %)',
            current_setting('session_replication_role');
    END IF;

    ----------------------------------------------------------------------
    -- The months to create: the catch-all's own first month through four
    -- months past today, which leaves the partition manager's three-month
    -- lookahead a month of headroom before it has to roll anything.
    ----------------------------------------------------------------------

    last_month := date_trunc('month', now()) + interval '4 months';
    IF last_month < lower_bound THEN
        last_month := lower_bound;
    END IF;
    new_lower := last_month + interval '1 month';

    ----------------------------------------------------------------------
    -- Dry run: report and stop.
    ----------------------------------------------------------------------

    IF dry_run THEN
        RAISE NOTICE 'DRY RUN. Nothing is changed. Re-run with --apply to execute.';
        RAISE NOTICE '% covers % to MAXVALUE and holds % rows', catch_all, lower_bound, rows_in_catch;
        RAISE NOTICE 'total size %, indexes %',
            pg_size_pretty(pg_total_relation_size(catch_all::regclass)),
            pg_size_pretty(pg_indexes_size(catch_all::regclass));
        FOR rec IN
            EXECUTE format(
                'SELECT date_trunc(''month'', created_at) AS m, count(*) AS n
                   FROM ONLY %I GROUP BY 1 ORDER BY 1', catch_all)
        LOOP
            RAISE NOTICE '  % : % rows', to_char(rec.m, 'YYYY-MM'), rec.n;
        END LOOP;
        month_start := lower_bound;
        WHILE month_start <= last_month LOOP
            RAISE NOTICE 'would create events_p%', to_char(month_start, 'YYYY_MM');
            month_start := month_start + interval '1 month';
        END LOOP;
        RAISE NOTICE 'would rebuild % as FROM (%) TO (MAXVALUE)', catch_all, new_lower;
        RETURN;
    END IF;

    ----------------------------------------------------------------------
    -- The split.
    ----------------------------------------------------------------------

    -- DETACH takes this anyway; taking it up front means the whole rebuild
    -- happens behind one lock acquisition rather than several.
    LOCK TABLE events IN ACCESS EXCLUSIVE MODE;

    EXECUTE format('ALTER TABLE events DETACH PARTITION %I', catch_all);
    EXECUTE format('ALTER TABLE %I RENAME TO %I', catch_all, parked);

    month_start := lower_bound;
    WHILE month_start <= last_month LOOP
        part_name := 'events_p' || to_char(month_start, 'YYYY_MM');
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF events FOR VALUES FROM (%L) TO (%L)',
            part_name, month_start, month_start + interval '1 month');
        RAISE NOTICE 'created %', part_name;
        month_start := month_start + interval '1 month';
    END LOOP;

    EXECUTE format(
        'CREATE TABLE %I PARTITION OF events FOR VALUES FROM (%L) TO (MAXVALUE)',
        catch_all, new_lower);
    RAISE NOTICE 'rebuilt % as FROM (%) TO (MAXVALUE)', catch_all, new_lower;

    -- `search_tsv` is GENERATED ALWAYS STORED, so `SELECT *` would fail on it.
    -- Read the column list from the catalog rather than freezing it here: this
    -- script has to survive every column `events` gains after today.
    SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum)
      INTO column_list
      FROM pg_catalog.pg_attribute
     WHERE attrelid = 'events'::regclass
       AND attnum > 0
       AND NOT attisdropped
       AND attgenerated = '';

    EXECUTE format('INSERT INTO events (%s) SELECT %s FROM %I', column_list, column_list, parked);
    GET DIAGNOSTICS rows_moved = ROW_COUNT;
    IF rows_moved <> rows_in_catch THEN
        RAISE EXCEPTION 'moved % rows but the catch-all held %', rows_moved, rows_in_catch;
    END IF;

    EXECUTE format('SELECT count(*) FROM events WHERE created_at >= %L', lower_bound)
       INTO rows_in_tree;
    IF rows_in_tree <> rows_in_catch THEN
        RAISE EXCEPTION 'after the move the table holds % rows at or after %, expected %',
            rows_in_tree, lower_bound, rows_in_catch;
    END IF;

    EXECUTE format('DROP TABLE %I', parked);
    RAISE NOTICE 'moved % rows and dropped %', rows_moved, parked;

    ----------------------------------------------------------------------
    -- What the table looks like now.
    ----------------------------------------------------------------------

    FOR rec IN
        SELECT c.relname::text AS name,
               pg_catalog.pg_get_expr(c.relpartbound, c.oid) AS bound,
               pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
               pg_size_pretty(pg_indexes_size(c.oid)) AS indexes
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid
         WHERE i.inhparent = 'events'::regclass
         ORDER BY 1
    LOOP
        EXECUTE format('SELECT count(*) FROM ONLY %I', rec.name) INTO rows_in_catch;
        RAISE NOTICE '% : % rows, % total, % indexes  %',
            rec.name, rows_in_catch, rec.total, rec.indexes, rec.bound;
    END LOOP;
END
$split$;

COMMIT;

-- ANALYZE cannot run inside a function, so it sits outside the transaction.
-- It runs after a dry run too, where it only refreshes planner statistics.
ANALYZE events;
