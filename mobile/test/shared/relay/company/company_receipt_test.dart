import 'package:buzz/shared/relay/company/canonical_json.dart';
import 'package:buzz/shared/relay/company/company_receipt.dart';
import 'package:buzz/shared/relay/nostr_models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nostr/nostr.dart' as nostr;

import 'company_fixtures.dart';

void main() {
  final relay = nostr.Keys.generate();
  final impostor = nostr.Keys.generate();
  const actionId =
      'aa11000000000000000000000000000000000000000000000000000000000011';
  const headId =
      'bb22000000000000000000000000000000000000000000000000000000000022';

  test('an applied receipt names the head the action produced', () {
    final receipt = parseCompanyReceipt(
      signedReceipt(keys: relay, actionEventId: actionId, headEventId: headId),
      relay.public,
      actionId,
    );
    expect(receipt, isNotNull);
    expect(receipt!.outcome, 'applied');
    expect(receipt.headEventId, headId);
    expect(receipt.actionEventId, actionId);
    expect(receipt.requestId, sampleRequestId);
    expect(receipt.idempotencyKey, sampleIdempotencyKey);
  });

  test('a receipt signed by anybody but the relay is not evidence', () {
    expect(
      parseCompanyReceipt(
        signedReceipt(
          keys: impostor,
          actionEventId: actionId,
          headEventId: headId,
        ),
        relay.public,
        actionId,
      ),
      isNull,
    );
  });

  test('a receipt whose content was edited after signing is refused', () {
    final genuine = signedReceipt(
      keys: relay,
      actionEventId: actionId,
      headEventId: headId,
    );
    final forged = NostrEvent(
      id: genuine.id,
      pubkey: genuine.pubkey,
      createdAt: genuine.createdAt,
      kind: genuine.kind,
      tags: genuine.tags,
      content: canonicalCompanyJson({
        'schema': companyReceiptSchema,
        'headEventId':
            'cc33000000000000000000000000000000000000000000000000000000000033',
      }),
      sig: genuine.sig,
    );
    expect(parseCompanyReceipt(forged, relay.public, actionId), isNull);
  });

  test('a receipt for some other action is not this action’s answer', () {
    expect(
      parseCompanyReceipt(
        signedReceipt(
          keys: relay,
          actionEventId: actionId,
          headEventId: headId,
        ),
        relay.public,
        'dd44000000000000000000000000000000000000000000000000000000000044',
      ),
      isNull,
    );
  });

  test('a refusal names no head, and one that does is malformed', () {
    final refused = parseCompanyReceipt(
      signedReceipt(
        keys: relay,
        actionEventId: actionId,
        headEventId: null,
        outcome: 'conflict',
      ),
      relay.public,
      actionId,
    );
    expect(refused, isNotNull);
    expect(refused!.outcome, 'conflict');
    expect(refused.headEventId, isNull);

    expect(
      parseCompanyReceipt(
        signedReceipt(
          keys: relay,
          actionEventId: actionId,
          headEventId: headId,
          outcome: 'rejected',
        ),
        relay.public,
        actionId,
      ),
      isNull,
    );
  });

  test('an applied receipt with no head is malformed', () {
    expect(
      parseCompanyReceipt(
        signedReceipt(keys: relay, actionEventId: actionId, headEventId: null),
        relay.public,
        actionId,
      ),
      isNull,
    );
  });
}
