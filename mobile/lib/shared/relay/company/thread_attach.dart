import 'dart:convert';

import 'canonical_json.dart';
import 'company_action.dart';

/// One open task per thread, decided by the relay.
///
/// A Dart port of `buzz-sdk/src/thread_task.rs`. Every agent-directed send
/// used to mint its own task, so one piece of work discussed over five
/// messages produced five tasks. A thread is one conversation about one piece
/// of work, so it holds at most one open task: the first work-implying message
/// opens it, and every later turn in that thread attaches to it.
///
/// The client never proposes a task id. It computes the thread's slot
/// coordinate, which is derivable without any relay state, and asks the relay
/// to attach or open. That is what makes a phone and a desktop racing on the
/// same thread produce one task rather than two: the arbitration is a single
/// row in one database, not an agreement between clients.

/// Exact content schema identifier, matching `THREAD_ATTACH_SCHEMA`.
const threadAttachSchema = 'colony.thread-attach/v1';

/// Prefix every thread slot id carries, matching `THREAD_SLOT_PREFIX`.
const threadSlotPrefix = 'thread-slot:';

/// Prefix every relay-minted thread task id carries.
const threadTaskPrefix = 'thread-task:';

/// The longest a task title may be, in UTF-8 bytes, mirroring the SDK's clamp.
const maxTaskTitleBytes = 200;

/// What a send asks its thread for.
enum ThreadAttachMode {
  /// This send implies work. Attach to the thread's open task, or open one
  /// titled with this instruction when the thread has none.
  open('open'),

  /// This send does not imply work. Attach to the thread's open task if it
  /// has one, otherwise to the hidden chat task. Never opens a visible task.
  attach('attach'),

  /// Open a second task even though one is open, and make it the thread's
  /// current task.
  createNew('new');

  const ThreadAttachMode(this.wireValue);

  final String wireValue;
}

/// Which of a thread's two slots a request is addressed to.
enum ThreadSlot {
  /// The thread's visible work task.
  work('work'),

  /// The thread's hidden task, which carries the cost of turns that were not
  /// work so that no turn goes unattributed.
  chat('chat');

  const ThreadSlot(this.key);

  final String key;
}

/// The key a thread is claimed under.
///
/// A send that starts its own thread has no root event id yet, because the
/// event does not exist until after the task is confirmed. Such a send is
/// claimed under its own send id, and the relay rebinds that claim to the real
/// root the moment the message it belongs to arrives. A conversation scope (a
/// DM) is one thread for its whole life, so it is keyed by neither.
String threadKey({
  required String? threadRoot,
  required String sendId,
  required bool conversationScope,
}) {
  if (conversationScope) return 'conversation';
  final root = threadRoot?.trim() ?? '';
  return root.isEmpty ? 'send:$sendId' : 'root:$root';
}

/// The stable coordinate one thread's slot is addressed at.
///
/// Computable by a client that holds no company state: it names the channel,
/// the thread, the member asking, and which slot, and nothing else. Two
/// clients preparing the same send therefore address the same slot, which is
/// what lets the relay recognise the race at all.
String threadSlotId({
  required String channelId,
  required String threadKey,
  required String ownerPubkey,
  ThreadSlot slot = ThreadSlot.work,
}) {
  final derived = stepIdempotencyKey(
    'thread-slot',
    '$channelId:$threadKey:${ownerPubkey.toLowerCase()}:${slot.key}',
  );
  return '$threadSlotPrefix$derived';
}

/// Clamp a title to what the relay will accept.
///
/// Byte-bounded like the SDK's clamp, and cut on a rune boundary so a
/// multi-byte character is never split in half.
String clampTaskTitle(String value) {
  if (utf8.encode(value).length <= maxTaskTitleBytes) return value;
  final buffer = StringBuffer();
  var bytes = 0;
  for (final rune in value.runes) {
    final character = String.fromCharCode(rune);
    final size = utf8.encode(character).length;
    if (bytes + size > maxTaskTitleBytes) break;
    buffer.write(character);
    bytes += size;
  }
  return buffer.toString().trimRight();
}

/// What a client supplies to charge one send to its thread's task.
class ThreadAttachRequest {
  /// Channel the send happens in.
  final String channelId;

  /// Root event id of the thread the send replies in, absent when the send
  /// starts its own thread.
  final String? threadRoot;

  /// Whether the whole conversation is the thread, which is what a DM is.
  final bool conversationScope;

  /// This client's stable identity for this send. A retry reuses it.
  final String sendId;

  final ThreadAttachMode mode;

  /// The instruction being sent, used as the title when a task is opened.
  final String title;

  /// Persona of the agent the send names, when it names one.
  final String? agentPersonaId;

  /// Explicit client-delivery context, when the composer had any.
  final String? clientOrganizationId;

  /// Parent task, when this request opens a sub-task under one.
  final String? parentTaskId;

  /// Public key of the member asking. Their own slot, so a second member
  /// working in the same thread opens their own task rather than spending
  /// against the thread starter's.
  final String ownerPubkey;

  /// Tenant relay public key that must author the resulting head.
  final String relayPubkey;

  const ThreadAttachRequest({
    required this.channelId,
    required this.threadRoot,
    required this.conversationScope,
    required this.sendId,
    required this.mode,
    required this.title,
    required this.ownerPubkey,
    required this.relayPubkey,
    this.agentPersonaId,
    this.clientOrganizationId,
    this.parentTaskId,
  });
}

/// Raised when a request could never be a valid thread attach.
class ThreadAttachError implements Exception {
  final String message;

  const ThreadAttachError(this.message);

  @override
  String toString() => message;
}

/// Build the Company Action that asks the relay to charge this send.
///
/// The action's target names the thread's slot, not a task: the client cannot
/// know which task it will be given, and a target it invented would be a claim
/// about company state rather than a question about it.
CompanyAction planThreadAttach(ThreadAttachRequest request) {
  if (request.channelId.trim().isEmpty || request.sendId.trim().isEmpty) {
    throw const ThreadAttachError(
      'a thread attach needs the channel and send it came from',
    );
  }
  if (request.ownerPubkey.trim().isEmpty) {
    throw const ThreadAttachError(
      'a thread attach needs the member asking for it',
    );
  }
  if (!isEventId(request.relayPubkey)) {
    throw const ThreadAttachError(
      'a thread attach needs the relay that will author the task',
    );
  }

  final key = threadKey(
    threadRoot: request.threadRoot,
    sendId: request.sendId,
    conversationScope: request.conversationScope,
  );
  // Addressed to the work slot even when the mode may land on the chat slot:
  // which slot answers is the relay's decision, and a client that addressed
  // the chat slot directly could route real work into the hidden task nobody
  // ever sees.
  final slotId = threadSlotId(
    channelId: request.channelId,
    threadKey: key,
    ownerPubkey: request.ownerPubkey,
  );
  final root = request.threadRoot?.trim();

  final record = <String, Object?>{
    'schema': threadAttachSchema,
    'id': slotId,
    'channelId': request.channelId,
    'threadRoot': (root == null || root.isEmpty) ? null : root,
    'conversationScope': request.conversationScope,
    'mode': request.mode.wireValue,
    'title': clampTaskTitle(request.title),
    'sendId': request.sendId,
    'agentPersonaId': request.agentPersonaId,
    'clientOrganizationId':
        (request.clientOrganizationId?.trim().isEmpty ?? true)
        ? null
        : request.clientOrganizationId,
    'parentTaskId': request.parentTaskId,
    'createdAt': approvalTimestamp('${request.channelId}:${request.sendId}'),
  };

  return CompanyAction(
    relayPubkey: request.relayPubkey,
    operation: CompanyActionOperation.attach,
    requestId: stepIdempotencyKey(slotId, 'attach-request:${request.sendId}'),
    // Keyed by the send and the mode, so a retry of one send replays and a
    // deliberate second "new task" on the same send is still a second request
    // rather than a silently swallowed replay.
    idempotencyKey: stepIdempotencyKey(
      slotId,
      'attach:${request.sendId}:${request.mode.wireValue}',
    ),
    target: taskCoordinate(request.relayPubkey, slotId),
    // Nothing is being replaced: the request asks a question about the thread,
    // and asserting a head would make a safe retry a conflict.
    expectedHead: null,
    payload: {'kind': 'threadAttach', 'record': record},
  );
}
