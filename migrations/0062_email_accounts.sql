-- Email and password accounts with zero-knowledge key escrow.
--
-- The relay stores two opaque NIP-49 blobs per account. Both encrypt the same
-- private key: one under the user's password, one under their recovery code.
-- Neither the password nor the key is ever transmitted, so neither can be
-- recovered from this table.
--
-- Named email_accounts because migration 0050 already owns `accounts` for
-- identity-global credit balances. These rows are tenant scoped instead.

CREATE TABLE email_accounts (
    community_id       UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    id                 UUID NOT NULL DEFAULT gen_random_uuid(),
    email              TEXT NOT NULL,
    pubkey             TEXT NOT NULL CHECK (length(pubkey) = 64),
    auth_hash          TEXT NOT NULL,
    password_blob      TEXT NOT NULL,
    recovery_blob      TEXT NOT NULL,
    recovery_code_hash TEXT NOT NULL CHECK (length(recovery_code_hash) = 64),
    kdf_version        SMALLINT NOT NULL DEFAULT 1 CHECK (kdf_version > 0),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_signin_at     TIMESTAMPTZ,
    failed_attempts    INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
    locked_until       TIMESTAMPTZ,
    PRIMARY KEY (community_id, id)
);

-- Uniqueness is per community, and lower() in the index means the database
-- enforces normalisation rather than trusting every caller to apply it.
CREATE UNIQUE INDEX email_accounts_community_email_idx
    ON email_accounts (community_id, lower(email));
CREATE UNIQUE INDEX email_accounts_community_pubkey_idx
    ON email_accounts (community_id, pubkey);

-- Single-use, short-lived proof that a recovery code was presented, so the
-- password reset that follows does not have to carry the code again. Tenant
-- scoped like its parent so the write fence and the deletion purge cover it
-- directly instead of relying on cascade timing.
CREATE TABLE account_reset_tokens (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    account_id   UUID NOT NULL,
    token_hash   TEXT NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, token_hash),
    FOREIGN KEY (community_id, account_id)
        REFERENCES email_accounts (community_id, id) ON DELETE CASCADE
);

CREATE INDEX account_reset_tokens_expiry_idx
    ON account_reset_tokens (expires_at);

SELECT attach_community_write_fence('email_accounts');
SELECT attach_community_write_fence('account_reset_tokens');
