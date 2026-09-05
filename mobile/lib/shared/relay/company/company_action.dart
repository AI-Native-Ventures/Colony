import '../nostr_models.dart';
import 'canonical_json.dart';

/// The owner-signable Company Action envelope (kind 40013).
///
/// Ported from `build_company_action` in `buzz-sdk`. The desktop builds this
/// in Rust and hands the frontend a signed event; mobile has no such backend,
/// so the envelope is built here. The relay validates it exactly, which means
/// the three tags, their order-independent names, and the canonical content
/// are the contract rather than an implementation detail.

/// Exact content schema identifier, matching `ACTION_SCHEMA`.
const companyActionSchema = 'colony.company-action/v1';

/// Mutation requested of the relay.
enum CompanyActionOperation {
  create('create'),
  update('update'),
  transition('transition'),

  /// Ask which task a send in one thread is charged to. The request names no
  /// task, so nothing is replaced and no head is asserted.
  attach('attach');

  const CompanyActionOperation(this.tagValue);

  /// The exact string the `company-action` tuple and the content agree on.
  final String tagValue;
}

/// One request to create or replace a relay-authored company head.
class CompanyAction {
  /// Tenant relay public key that must receive and author the resulting head.
  final String relayPubkey;
  final CompanyActionOperation operation;
  final String requestId;
  final String idempotencyKey;

  /// NIP-33 coordinate this action addresses.
  final String target;

  /// Head this replacement is pinned to, absent when nothing is replaced.
  final String? expectedHead;

  /// Typed payload, already in its `{kind, record}` wire form.
  final Map<String, Object?> payload;

  const CompanyAction({
    required this.relayPubkey,
    required this.operation,
    required this.requestId,
    required this.idempotencyKey,
    required this.target,
    required this.expectedHead,
    required this.payload,
  });

  /// The canonical content the relay re-encodes and compares against.
  String get content => canonicalCompanyJson({
    'schema': companyActionSchema,
    'operation': operation.tagValue,
    'requestId': requestId,
    'idempotencyKey': idempotencyKey,
    'target': target,
    'expectedHead': expectedHead,
    'expectedReferences': const <Object?>[],
    'payload': payload,
  });

  /// The exact three-tag envelope. A fourth tag, or a missing one, is refused
  /// by the relay before the content is read.
  List<List<String>> get tags => [
    ['p', relayPubkey],
    ['a', target],
    ['company-action', '1', operation.tagValue, requestId, idempotencyKey],
  ];
}

/// The NIP-33 coordinate one company record lives at.
String companyCoordinate(int kind, String relayPubkey, String id) =>
    '$kind:$relayPubkey:$id';

/// The coordinate of one task, or of one thread slot, which shares the task
/// coordinate space so a single target grammar covers every company request.
String taskCoordinate(String relayPubkey, String id) =>
    companyCoordinate(EventKind.task, relayPubkey, id);
