-- Give every Colony community real, relay-enforced Discovery access for a
-- 30-day trial. Existing manual activations remain permanent; workspaces that
-- were inactive receive a trial beginning when this migration is deployed.

ALTER TABLE discovery_entitlements
    ADD COLUMN expires_at TIMESTAMPTZ;

INSERT INTO discovery_entitlements (community_id, active, expires_at, updated_at)
SELECT id, TRUE, now() + interval '30 days', now()
FROM communities
ON CONFLICT (community_id) DO UPDATE
SET active = TRUE,
    expires_at = CASE
        WHEN discovery_entitlements.active THEN discovery_entitlements.expires_at
        ELSE now() + interval '30 days'
    END,
    updated_at = now();

CREATE FUNCTION provision_discovery_trial() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO discovery_entitlements
        (community_id, active, expires_at, updated_at)
    VALUES (NEW.id, TRUE, now() + interval '30 days', now());
    RETURN NEW;
END;
$$;

CREATE TRIGGER communities_provision_discovery_trial
AFTER INSERT ON communities
FOR EACH ROW EXECUTE FUNCTION provision_discovery_trial();

