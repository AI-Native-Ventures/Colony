-- Provider attribution for payment intents.
--
-- A reference must resolve back to the gateway that issued it. After a
-- switch between providers, a callback arriving from the retired gateway
-- has to be tellable apart from a forgery; without this column neither the
-- initialize route nor the webhook could say which gateway a row belongs
-- to, and a relay that cannot attribute money must never accept it.
--
-- Historical rows were Paystack by definition: it was the only provider
-- that existed, so the backfill default is 'paystack'.
ALTER TABLE payment_intents
    ADD COLUMN provider TEXT NOT NULL DEFAULT 'paystack'
    CHECK (provider IN ('paystack', 'payfast'));
