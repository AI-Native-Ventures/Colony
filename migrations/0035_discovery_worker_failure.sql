-- Let a fenced local worker terminate a run after a provider failure without
-- persisting credentials, response bodies, or provider-specific error text.

ALTER TABLE discovery_worker_action_claims
    DROP CONSTRAINT discovery_worker_action_claims_operation_check,
    ADD CONSTRAINT discovery_worker_action_claims_operation_check
        CHECK (operation IN (
            'claim', 'heartbeat', 'checkpoint', 'store_observations', 'fail', 'complete'
        ));
