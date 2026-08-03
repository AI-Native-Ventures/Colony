-- Allow trusted local workers to persist privacy-safe per-source execution state.
-- Source progress uses the existing signed worker action kind and idempotency table.

ALTER TABLE discovery_worker_action_claims
    DROP CONSTRAINT discovery_worker_action_claims_operation_check,
    ADD CONSTRAINT discovery_worker_action_claims_operation_check
        CHECK (operation IN (
            'claim', 'heartbeat', 'checkpoint', 'source_progress',
            'store_observations', 'salvage_observations', 'fail', 'complete'
        ));
