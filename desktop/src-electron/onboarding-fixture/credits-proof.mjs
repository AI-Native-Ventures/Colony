import assert from "node:assert/strict";

/** Read only public accounting columns for the isolated synthetic owner in one snapshot. */
export function creditsProofQuery(owner) {
  assert.match(owner, /^[a-f0-9]{64}$/);
  assert.equal(owner, owner.trim());
  return `SELECT json_build_object(
    'balance', (SELECT balance::text FROM accounts WHERE pubkey=decode('${owner}','hex')),
    'catalog', (SELECT json_build_object('modelId',model_id,'upstreamModel',vercel_slug,'enabled',enabled)
      FROM model_catalog WHERE model_id='deepseek-v4-flash'),
    'intents', (SELECT coalesce(json_agg(json_build_object(
      'id',id::text,'providerId',provider_request_id,'model',model,'state',state,
      'status',provider_status,'reserved',reserved_nanousd::text)), '[]'::json)
      FROM gateway_settlement_intents WHERE pubkey=decode('${owner}','hex')),
    'debits', (SELECT coalesce(json_agg(json_build_object(
      'id',id::text,'providerId',request_id,'reference',ref,'model',model,
      'delta',delta::text,'cost',observed_cost::text,'basis',settle_basis)), '[]'::json)
      FROM credit_ledger WHERE pubkey=decode('${owner}','hex') AND kind='debit')
  );`;
}

/** Every successful synthetic response must have its own terminal intent and exact debit. */
export function assertCreditsProof(snapshot, requests, initialAmount) {
  assert.ok(requests.length > 0);
  assert.deepEqual(snapshot.catalog, {
    modelId: "deepseek-v4-flash",
    upstreamModel: "deepseek/deepseek-v4-flash",
    enabled: true,
  });
  const ids = requests.map((request) => request.responseId);
  assert.equal(
    new Set(ids).size,
    requests.length,
    "Provider response IDs are unique",
  );
  assert.equal(
    snapshot.intents.length,
    requests.length,
    "Every admitted call is accounted for",
  );
  assert.equal(
    snapshot.debits.length,
    requests.length,
    "One distinct debit per model response",
  );
  assert.equal(
    new Set(snapshot.intents.map((row) => row.id)).size,
    requests.length,
  );
  assert.equal(
    new Set(snapshot.debits.map((row) => row.id)).size,
    requests.length,
  );
  let total = 0n;
  for (const request of requests) {
    assert.match(request.responseId, /^onboarding-[1-9][0-9]*$/);
    assert.deepEqual(request.usage, {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
    assert.equal(request.model, "deepseek/deepseek-v4-flash");
    const intents = snapshot.intents.filter(
      (row) => row.providerId === request.responseId,
    );
    const debits = snapshot.debits.filter(
      (row) => row.providerId === request.responseId,
    );
    assert.equal(intents.length, 1, "Exact provider ID has one intent");
    assert.equal(debits.length, 1, "Exact provider ID has one debit");
    const [intent] = intents;
    const [debit] = debits;
    assert.equal(intent.model, snapshot.catalog.modelId);
    assert.equal(intent.state, "debited");
    assert.equal(intent.status, 200);
    assert.equal(intent.reserved, "0");
    assert.equal(debit.model, snapshot.catalog.modelId);
    assert.equal(debit.reference, request.responseId);
    // Token-only fixture responses use the checked-in model tariff, not provider monetary cost.
    assert.equal(debit.basis, "estimated");
    assert.equal(debit.cost, "2800");
    assert.equal(debit.delta, "-2800");
    total -= BigInt(debit.delta);
  }
  assert.equal(BigInt(snapshot.balance), BigInt(initialAmount) - total);
  assert.ok(BigInt(snapshot.balance) >= 0n);
  return { count: snapshot.debits.length, nanousd: total.toString() };
}
