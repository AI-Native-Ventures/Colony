import 'package:buzz/shared/relay/company/canonical_json.dart';
import 'package:buzz/shared/relay/company/company_receipt.dart';
import 'package:buzz/shared/relay/company/company_task.dart';
import 'package:buzz/shared/relay/nostr_models.dart';
import 'package:nostr/nostr.dart' as nostr;

/// Relay-signed company records, built the way the relay builds them.
///
/// Signed for real rather than hand-assembled: the parsers refuse anything
/// whose signature does not hold, so a fixture that skipped signing would
/// prove only that the refusal works.

const sampleRequestId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const sampleIdempotencyKey = '3f2504e0-4f89-41d3-9a0c-0305e82c3302';

NostrEvent _signed({
  required nostr.Keys keys,
  required int kind,
  required String content,
  required List<List<String>> tags,
}) => NostrEvent.fromJson(
  nostr.Event.from(
    kind: kind,
    content: content,
    tags: tags,
    secretKey: keys.secret,
    verify: false,
  ).toMap(),
);

/// One relay-authored Company Receipt.
NostrEvent signedReceipt({
  required nostr.Keys keys,
  required String actionEventId,
  required String? headEventId,
  String outcome = 'applied',
  String target = '30181:relay:thread-slot:sample',
  String requestId = sampleRequestId,
  String idempotencyKey = sampleIdempotencyKey,
}) => _signed(
  keys: keys,
  kind: EventKind.companyReceipt,
  content: canonicalCompanyJson({
    'schema': companyReceiptSchema,
    'headEventId': headEventId,
  }),
  tags: [
    ['e', actionEventId, '', 'company-action'],
    ['a', target],
    ['p', keys.public],
    ['company-receipt', '1', requestId, idempotencyKey, outcome],
  ],
);

/// One relay-authored Company Task head.
NostrEvent signedTaskHead({
  required nostr.Keys keys,
  String id = 'thread-task:sample',
  String title = 'Cut the release video',
  String status = 'inProgress',
  String owningTeamId = 'team-coordination',
  String sourceChannelId = 'engineering',
  String? threadRoot = 'abc',
  String? initiativeId,
  bool hidden = false,
  List<String> assigneePersonaIds = const ['persona-cto'],
  List<String> reportedCompleteBy = const [],
  int updatedAt = 1767225600,
}) => _signed(
  keys: keys,
  kind: EventKind.task,
  content: canonicalCompanyJson({
    'schema': companyTaskSchema,
    'id': id,
    'initiativeId': initiativeId,
    'title': title,
    'status': status,
    'owningTeamId': owningTeamId,
    'assigneePersonaIds': assigneePersonaIds,
    'qaPersonaId': 'persona-cto',
    'costCentreId': 'cost-internal',
    'commercialPurpose': 'administration',
    'clientOrganizationId': null,
    'sourceChannelId': sourceChannelId,
    'sourceEventId': null,
    'implicit': true,
    'dependsOn': <String>[],
    'subject': null,
    'stage': null,
    'threadRoot': threadRoot,
    'doerKind': 'agent',
    'wakeAt': null,
    'outcomeReason': null,
    'bounceReason': null,
    'bounceCount': 0,
    'reportedCompleteBy': reportedCompleteBy,
    'hidden': hidden,
    'parentTaskId': null,
    'createdAt': 1767225600,
    'updatedAt': updatedAt,
  }),
  tags: [
    ['d', id],
  ],
);
