-- 0071: provisioned employees -- the employees Colony provides.
--
-- A provisioned employee is an ordinary `employees` row, not a parallel
-- concept: the relay already mints and seals employee keys, resolves tier and
-- reporting line from this table, and dispatches their work through the job
-- queue. The only difference is where the row comes from. An owner hires an
-- employee with a signed kind 9045 request; a provisioned employee is seeded
-- from a manifest bundled in the relay binary
-- (crates/buzz-relay/src/core_employees.rs), the same way Core Blocks are.
--
-- That is what the two new columns record. `provisioned_handle` is the stable
-- identity of a bundled entry across every workspace and every relay version:
-- seeding is idempotent on it, and it is what every refusal path keys on to
-- know a row is not a user's to change. `provisioned_version` is the bundled
-- version that last wrote the row, so a newer manifest can update an older
-- seed while an unchanged one does nothing.
--
-- NULL in both columns means a user's own employee, hired the normal way.
-- Nothing in this migration changes those rows or how they behave.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS provisioned_handle TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS provisioned_version INTEGER;

-- A seeded row answers no hire request, because no owner signed one. The two
-- hire columns therefore have to admit NULL, and the check below keeps that
-- narrow: only a provisioned row may leave them empty, so an ordinary hire
-- still cannot be written without the owner-signed request that authorises
-- it.
ALTER TABLE employees ALTER COLUMN hired_by DROP NOT NULL;
ALTER TABLE employees ALTER COLUMN hire_event DROP NOT NULL;

ALTER TABLE employees ADD CONSTRAINT employees_provisioned_pair
    CHECK (
        (provisioned_handle IS NULL AND provisioned_version IS NULL)
        OR (provisioned_handle IS NOT NULL AND provisioned_version IS NOT NULL)
    );

ALTER TABLE employees ADD CONSTRAINT employees_hire_provenance
    CHECK (
        provisioned_handle IS NOT NULL
        OR (hired_by IS NOT NULL AND hire_event IS NOT NULL)
    );

-- One row per bundled entry per workspace. Seeding relies on this: a second
-- startup, or a second relay pod starting at the same moment, cannot mint a
-- second identity for the same employee.
CREATE UNIQUE INDEX IF NOT EXISTS employees_provisioned_handle_uniq
    ON employees (community_id, provisioned_handle)
    WHERE provisioned_handle IS NOT NULL;
