-- 0061: employee reporting lines.
--
-- Adds the authoritative `manager` column to `employees`: the pubkey of the
-- agent this employee reports to, one rung up the interrupt ladder
-- (worker -> leader, leader -> executive). NULL means no manager -- the root
-- marker for executives and for workers/leaders waiting in the Unassigned
-- tray; absence is the state, not a sentinel value.
--
-- The column is read by `interrupt_gate::agent_manager` BEFORE any event is
-- looked at (the same precedence `agent_tier` gives `employees.rank`), so a
-- reporting-line change that only republished the 30190 head would be
-- invisible to the relay. Kind 9046 updates this column and the head
-- together.
--
-- The event-side copy of the same fact lives in a `manager` tag on kinds
-- 30190 and 30177 (tags are indexed, so an owner's delete-protection query --
-- "who reports to X?" -- can find an agent's reports); this column is what
-- the gate trusts for employees.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS manager BYTEA;
ALTER TABLE employees ADD CONSTRAINT employees_manager_len
    CHECK (manager IS NULL OR LENGTH(manager) = 32);
