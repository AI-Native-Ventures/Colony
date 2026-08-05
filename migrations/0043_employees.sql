-- 0043: company employees — workspace-owned agent identities.
--
-- An employee is a role the company employs rather than a process a member
-- runs. Its identity keypair is minted here and held by the relay, so every
-- member's machine can produce work as one colleague without a private key
-- being copied between laptops or rotated when somebody leaves
-- (docs/design/company-employees.html).
--
-- This is the first table in the schema holding private key material, so the
-- column is sealed, never plaintext: AES-256-GCM under an operator-held KEK,
-- with the community id and the employee pubkey bound in as associated data
-- (crates/buzz-relay/src/employee_key.rs). A database dump without the KEK
-- yields no ability to speak as anyone, and a sealed key lifted from one row
-- will not open in another employee's row or another tenant's.
CREATE TABLE IF NOT EXISTS employees (
    community_id  UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    pubkey        BYTEA NOT NULL,
    -- nonce || ciphertext from the sealer above. Never a bare secret key.
    sealed_key    BYTEA NOT NULL,
    role_id       TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    rank          TEXT NOT NULL CHECK (rank IN ('worker','leader','executive')),
    -- The owner who hired this employee, and the hire request that asked for
    -- it. The request is owner-signed, so anyone can re-derive authority from
    -- events alone rather than trusting this table.
    hired_by      BYTEA NOT NULL,
    hire_event    BYTEA NOT NULL,
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
    created_at    BIGINT NOT NULL,
    updated_at    BIGINT NOT NULL,
    PRIMARY KEY (community_id, pubkey),
    CHECK (LENGTH(pubkey) = 32),
    CHECK (LENGTH(hired_by) = 32),
    CHECK (LENGTH(hire_event) = 32)
);

-- Hiring is driven by a best-effort side effect, which may run more than once
-- for the same request. One employee per hire request makes a repeat run a
-- no-op instead of a second identity for the same role.
CREATE UNIQUE INDEX IF NOT EXISTS employees_hire_event_uniq
    ON employees (community_id, hire_event);

-- One active employee per role: a workspace employs one Chief of Staff, not
-- one per member who asked. Retired rows are excluded so a role can be
-- refilled after its holder is retired.
CREATE UNIQUE INDEX IF NOT EXISTS employees_active_role_uniq
    ON employees (community_id, role_id) WHERE status = 'active';
