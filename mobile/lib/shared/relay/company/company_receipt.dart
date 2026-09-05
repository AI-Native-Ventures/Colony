import 'dart:convert';
import 'dart:typed_data';

import 'package:nostr/nostr.dart' as nostr;
import 'package:pointycastle/digests/sha256.dart';

import '../nostr_models.dart';
import 'canonical_json.dart';

/// Reading what the relay did with a Company Action.
///
/// Treating a successful publish as a successful write reports "done" for
/// actions the relay went on to refuse, so the outcome is only ever read out
/// of the relay's own signed receipt (kind 40014). A receipt is evidence
/// because the tenant relay signed it; one signed by anyone else is a member
/// claiming an outcome the relay never reached.

/// Exact content schema identifier, matching `RECEIPT_SCHEMA`.
const companyReceiptSchema = 'colony.company-receipt/v1';

const _receiptOutcomes = {'applied', 'rejected', 'conflict', 'failed'};

final _uuidPattern = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  caseSensitive: false,
);

/// What one relay-signed receipt says.
class CompanyReceipt {
  final String receiptEventId;
  final String actionEventId;
  final String target;
  final String requestId;
  final String idempotencyKey;

  /// One of `applied`, `rejected`, `conflict`, `failed`.
  final String outcome;

  /// The head the action produced, non-null only when it applied.
  final String? headEventId;

  const CompanyReceipt({
    required this.receiptEventId,
    required this.actionEventId,
    required this.target,
    required this.requestId,
    required this.idempotencyKey,
    required this.outcome,
    required this.headEventId,
  });
}

/// The NIP-01 id an event's own fields hash to.
String computeEventId(NostrEvent event) {
  final serialized = jsonEncode([
    0,
    event.pubkey.toLowerCase(),
    event.createdAt,
    event.kind,
    event.tags,
    event.content,
  ]);
  final digest = SHA256Digest().process(
    Uint8List.fromList(utf8.encode(serialized)),
  );
  return [
    for (final byte in digest) byte.toRadixString(16).padLeft(2, '0'),
  ].join();
}

/// Whether an event's id and signature both hold up.
///
/// Checked rather than assumed: the receipt is the only proof the relay
/// applied anything, so a forged one would let any member claim a task id the
/// relay never issued.
bool verifyEventSignature(NostrEvent event) {
  final id = computeEventId(event);
  if (id != normalizeHex(event.id)) return false;
  try {
    return nostr.Schnorr.verify(
      publicKey: event.pubkey.toLowerCase(),
      message: id,
      signature: event.sig,
    );
  } catch (_) {
    return false;
  }
}

List<List<String>> _tagValues(NostrEvent event, String name) => [
  for (final tag in event.tags)
    if (tag.isNotEmpty && tag[0] == name) tag,
];

/// Read a relay-signed receipt for [actionEventId], or null.
CompanyReceipt? parseCompanyReceipt(
  NostrEvent event,
  String relaySelfPubkey,
  String actionEventId,
) {
  final relay = normalizeHex(relaySelfPubkey);
  if (event.kind != EventKind.companyReceipt ||
      relay.isEmpty ||
      normalizeHex(event.pubkey) != relay) {
    return null;
  }
  if (!verifyEventSignature(event)) return null;

  final actionTags = [
    for (final tag in _tagValues(event, 'e'))
      if (tag.length >= 4 && tag[3] == 'company-action') tag,
  ];
  final targets = _tagValues(event, 'a');
  final tuples = _tagValues(event, 'company-receipt');
  if (actionTags.length != 1 ||
      targets.length != 1 ||
      tuples.length != 1 ||
      _tagValues(event, 'p').length != 1) {
    return null;
  }
  final tuple = tuples.first;
  final referenced = normalizeHex(
    actionTags.first.length > 1 ? actionTags.first[1] : '',
  );
  final target = targets.first.length > 1 ? targets.first[1] : '';
  if (referenced != normalizeHex(actionEventId) ||
      target.isEmpty ||
      tuple.length != 5 ||
      tuple[1] != '1' ||
      !_uuidPattern.hasMatch(tuple[2]) ||
      !_uuidPattern.hasMatch(tuple[3]) ||
      !_receiptOutcomes.contains(tuple[4])) {
    return null;
  }

  final Object? decoded;
  try {
    decoded = jsonDecode(event.content);
  } catch (_) {
    return null;
  }
  if (decoded is! Map<String, dynamic> ||
      canonicalCompanyJson(decoded) != event.content ||
      decoded.length != 2 ||
      decoded['schema'] != companyReceiptSchema) {
    return null;
  }
  final head = decoded['headEventId'];
  if (head != null && head is! String) return null;

  final outcome = tuple[4];
  // Only an applied action names a head, and it must name a real event id.
  if (outcome == 'applied') {
    if (head is! String || !isEventId(head)) return null;
  } else if (head != null) {
    return null;
  }

  return CompanyReceipt(
    receiptEventId: event.id,
    actionEventId: referenced,
    target: target,
    requestId: tuple[2].toLowerCase(),
    idempotencyKey: tuple[3].toLowerCase(),
    outcome: outcome,
    headEventId: head is String ? normalizeHex(head) : null,
  );
}
