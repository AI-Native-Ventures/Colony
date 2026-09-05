import 'dart:async';
import 'dart:convert';

import '../nostr_models.dart';
import 'canonical_json.dart';
import 'company_action.dart';
import 'company_action_broker.dart';
import 'company_task.dart';
import 'thread_attach.dart';

/// Charging one send to its thread's task, and closing that task.
///
/// A paid turn with no work context is money spent that no cost centre, team,
/// or commercial purpose can be traced to, and the classification cannot be
/// recovered afterwards. So the task is confirmed by the relay *before* the
/// instruction is sent, and the message carries references to the canonical
/// record rather than to what this client hoped it would be.
///
/// Which task that is, is the relay's decision. A thread holds at most one
/// open task, and a phone and a desktop preparing the same send would each
/// read "no open task" and each open one. Nothing here proposes a task id: it
/// asks, publishes the question, and reads the answer out of the receipt.

/// A send that could not be charged, and therefore must not go out.
class WorkContextError implements Exception {
  final String message;

  const WorkContextError(this.message);

  @override
  String toString() => message;
}

/// How long the whole attach round trip may take before the send fails.
///
/// Bounded rather than open-ended: a composer that waits forever on a relay
/// that never answers looks to the person using it exactly like a message that
/// was sent, and the instruction would sit unsent with nothing said about it.
const threadAttachTimeout = Duration(seconds: 20);

const _readBackAttempts = 8;
const _readBackInterval = Duration(milliseconds: 150);
const _maxReadBackInterval = Duration(seconds: 2);

/// Read-after-write backoff: doubles, capped, never below the interval.
Duration taskReadBackDelay(int attempt) {
  final millis = _readBackInterval.inMilliseconds * (1 << attempt);
  return Duration(
    milliseconds: millis.clamp(
      _readBackInterval.inMilliseconds,
      _maxReadBackInterval.inMilliseconds,
    ),
  );
}

/// Ceiling on a task list read. A thread's tasks are narrowed client-side
/// because neither the thread root nor the channel is an indexed mirror on a
/// task head.
const _maxTaskRecords = 500;

class ThreadTaskClient {
  final Future<String?> Function() _relaySelf;
  final NostrEvent Function(CompanyAction action) _signAction;
  final Future<List<NostrEvent>> Function(NostrFilter filter) _query;
  final CompanyActionBroker _broker;
  final Future<void> Function(Duration delay) _delay;

  ThreadTaskClient({
    required Future<String?> Function() relaySelf,
    required NostrEvent Function(CompanyAction action) signAction,
    required Future<List<NostrEvent>> Function(NostrFilter filter) query,
    required CompanyActionBroker broker,
    Future<void> Function(Duration delay)? delay,
  }) : _relaySelf = relaySelf,
       _signAction = signAction,
       _query = query,
       _broker = broker,
       _delay = delay ?? Future<void>.delayed;

  Future<String> _requireRelaySelf() async {
    final relaySelfPubkey = await _relaySelf();
    if (relaySelfPubkey == null || relaySelfPubkey.isEmpty) {
      throw const WorkContextError(
        "This community's relay has no stable identity, so agent work cannot "
        'be recorded against it.',
      );
    }
    return relaySelfPubkey;
  }

  /// Ask the relay which task this send is charged to.
  ///
  /// Throws [WorkContextError] rather than returning null on every path where
  /// the answer is unknown. Sending the instruction anyway would buy an agent
  /// turn nothing can account for, so a failure here is a failure to send.
  Future<CompanyTask> resolveWorkContext({
    required String channelId,
    required String sendId,
    required String ownerPubkey,
    required String title,
    required ThreadAttachMode mode,
    String? threadRoot,
    bool conversationScope = false,
    String? agentPersonaId,
    String? clientOrganizationId,
    String? parentTaskId,
    Duration timeout = threadAttachTimeout,
  }) =>
      _resolveWorkContext(
        channelId: channelId,
        sendId: sendId,
        ownerPubkey: ownerPubkey,
        title: title,
        mode: mode,
        threadRoot: threadRoot,
        conversationScope: conversationScope,
        agentPersonaId: agentPersonaId,
        clientOrganizationId: clientOrganizationId,
        parentTaskId: parentTaskId,
      ).timeout(
        timeout,
        onTimeout: () => throw const WorkContextError(
          'The relay has not said which task this message belongs to, so it has '
          'not been sent. Trying again is safe.',
        ),
      );

  Future<CompanyTask> _resolveWorkContext({
    required String channelId,
    required String sendId,
    required String ownerPubkey,
    required String title,
    required ThreadAttachMode mode,
    required String? threadRoot,
    required bool conversationScope,
    required String? agentPersonaId,
    required String? clientOrganizationId,
    required String? parentTaskId,
  }) async {
    final relaySelfPubkey = await _requireRelaySelf();

    final CompanyAction action;
    try {
      action = planThreadAttach(
        ThreadAttachRequest(
          channelId: channelId,
          threadRoot: threadRoot,
          conversationScope: conversationScope,
          sendId: sendId,
          mode: mode,
          title: title,
          ownerPubkey: ownerPubkey,
          relayPubkey: relaySelfPubkey,
          agentPersonaId: agentPersonaId,
          clientOrganizationId: clientOrganizationId,
          parentTaskId: parentTaskId,
        ),
      );
    } on ThreadAttachError catch (error) {
      throw WorkContextError(
        '${error.message}. The message has not been sent.',
      );
    }

    final outcome = await _broker.submit(_signAction(action), action);

    // An applied receipt names the task head this send resolved to, including
    // when the relay attached to a task that already existed: rewriting that
    // head to say the same thing would churn a record nobody asked to change,
    // so the receipt points at the head that is already stored.
    //
    // A superseded submission means an earlier attempt at this exact send
    // already won the idempotency claim. That is the same goal state reached a
    // different way, and the winning action's own receipt names the task it
    // was answered with.
    final String? headEventId = switch (outcome) {
      CompanyActionApplied(:final headEventId) => headEventId,
      CompanyActionSuperseded(:final winnerEventId) =>
        await _broker.headForAction(winnerEventId),
      CompanyActionRefused(:final message) => throw WorkContextError(
        '$message The message has not been sent.',
      ),
      CompanyActionNoReceipt(:final message) => throw WorkContextError(
        '$message The message has not been sent.',
      ),
    };

    if (headEventId == null || headEventId.isEmpty) {
      throw const WorkContextError(
        'The relay did not say which task this message belongs to, so it has '
        'not been sent. Trying again is safe.',
      );
    }

    final task = await getTaskByHeadEvent(headEventId);
    if (task == null) {
      throw const WorkContextError(
        'The work record for this message could not be read back, so the '
        'message has not been sent. Trying again is safe.',
      );
    }
    return task;
  }

  /// Read the task a receipt named, without knowing its id.
  ///
  /// A thread attach is answered with a head event id and nothing else, so
  /// there is no coordinate to read by. Hidden tasks come back here on
  /// purpose: the message still has to carry the id of whatever it was charged
  /// to, even when that is the thread's hidden chat task.
  ///
  /// Retried on a backoff because the receipt already proved the write landed,
  /// so a miss is the read side lagging it.
  Future<CompanyTask?> getTaskByHeadEvent(String headEventId) async {
    final relaySelfPubkey = await _requireRelaySelf();
    for (var attempt = 0; attempt < _readBackAttempts; attempt += 1) {
      final events = await _query(
        NostrFilter(
          kinds: const [EventKind.task],
          authors: [relaySelfPubkey],
          ids: [headEventId],
          limit: 1,
        ),
      );
      for (final event in events) {
        final task = parseTaskHead(event, relaySelfPubkey);
        if (task != null) return task;
      }
      if (attempt < _readBackAttempts - 1) {
        await _delay(taskReadBackDelay(attempt));
      }
    }
    return null;
  }

  /// The persona one managed agent's public key belongs to.
  ///
  /// Read from the agent's own kind:30177 head, the same record the relay
  /// reads. Without it the relay charges the turn to the community's
  /// coordination team and assigns the task to nobody, so the work is recorded
  /// but cannot close itself when the agent reports done.
  ///
  /// Null is not a failure: an agent that predates persona linking has none,
  /// and a send that names no agent asks for none.
  Future<String?> resolveAgentPersonaId(String agentPubkey) async {
    final pubkey = normalizeHex(agentPubkey);
    if (pubkey.isEmpty) return null;
    final events = await _query(
      NostrFilter(
        kinds: const [EventKind.managedAgent],
        tags: {
          '#d': [pubkey],
        },
        limit: 4,
      ),
    );
    for (final event in events) {
      final Object? decoded;
      try {
        decoded = jsonDecode(event.content);
      } catch (_) {
        continue;
      }
      if (decoded is! Map<String, dynamic>) continue;
      // `persona_id` on the wire: the managed-agent content is the one
      // company record that is not camelCase, and reading the camelCase
      // spelling here found nothing while looking exactly like an agent that
      // had no persona.
      final personaId = decoded['persona_id'];
      if (personaId is String && personaId.trim().isNotEmpty) return personaId;
    }
    return null;
  }

  /// The current head of one task, by its id.
  Future<CompanyTask?> getTaskById(String taskId) async {
    final relaySelfPubkey = await _requireRelaySelf();
    final events = await _query(
      NostrFilter(
        kinds: const [EventKind.task],
        authors: [relaySelfPubkey],
        tags: {
          '#d': [taskId],
        },
        limit: 1,
      ),
    );
    for (final event in events) {
      final task = parseTaskHead(event, relaySelfPubkey);
      if (task != null) return task;
    }
    return null;
  }

  /// One thread's task history, newest first.
  ///
  /// Hidden tasks are never listed. A hidden task exists so a turn that was
  /// not work still charges somewhere; putting it in front of the owner would
  /// put the greeting back on the Tasks page as if it were work.
  Future<List<CompanyTask>> listThreadTasks(String threadRoot) async {
    final root = normalizeHex(threadRoot);
    if (root.isEmpty) return const [];
    final tasks = await _listTasks();
    return tasks
        .where(
          (task) =>
              !task.hidden &&
              task.threadRoot != null &&
              normalizeHex(task.threadRoot) == root,
        )
        .toList()
      ..sort(threadHistoryOrder);
  }

  /// One DM conversation's task history, newest first.
  ///
  /// A DM is one thread for its whole life, so its tasks name no thread root
  /// at all. They are found by the channel they were opened in instead.
  Future<List<CompanyTask>> listConversationTasks(String channelId) async {
    if (channelId.trim().isEmpty) return const [];
    final tasks = await _listTasks();
    return tasks
        .where(
          (task) =>
              !task.hidden &&
              task.threadRoot == null &&
              task.sourceChannelId == channelId,
        )
        .toList()
      ..sort(threadHistoryOrder);
  }

  Future<List<CompanyTask>> _listTasks() async {
    final relaySelfPubkey = await _requireRelaySelf();
    final events = await _query(
      NostrFilter(
        kinds: const [EventKind.task],
        authors: [relaySelfPubkey],
        limit: _maxTaskRecords,
      ),
    );
    // One head per coordinate: the relay replaces a task in place, and a
    // stale copy still on the wire would resurrect a closed task.
    final newestById = <String, CompanyTask>{};
    for (final event in events) {
      final task = parseTaskHead(event, relaySelfPubkey);
      if (task == null) continue;
      final existing = newestById[task.id];
      if (existing == null || task.updatedAt >= existing.updatedAt) {
        newestById[task.id] = task;
      }
    }
    return newestById.values.toList();
  }

  /// The task a thread currently has open, or null.
  ///
  /// A thread holds at most one, so "the newest live one" is the whole rule.
  Future<CompanyTask?> openTaskFor({
    required String channelId,
    required bool conversationScope,
    required String? threadRoot,
  }) async {
    final tasks = conversationScope
        ? await listConversationTasks(channelId)
        : await listThreadTasks(threadRoot ?? '');
    for (final task in tasks) {
      if (!task.isTerminal) return task;
    }
    return null;
  }

  /// Close one task as the community owner.
  ///
  /// Compare-and-set against the head as it is right now, not as the caller
  /// last read it: the relay rewrites a thread task's head when it learns the
  /// thread's real root, so a client holding an older head id would have an
  /// ordinary close refused as a conflict.
  Future<void> markTaskDone(String taskId) async {
    final relaySelfPubkey = await _requireRelaySelf();
    final current = await getTaskById(taskId);
    if (current == null) {
      throw const WorkContextError(
        'That task could not be read, so it has not been closed.',
      );
    }
    if (current.isTerminal) return;

    final action = planTaskCompletion(current, relaySelfPubkey);
    final outcome = await _broker.submit(_signAction(action), action);
    switch (outcome) {
      case CompanyActionApplied():
      case CompanyActionSuperseded():
        return;
      case CompanyActionRefused(:final message):
        throw WorkContextError(message);
      case CompanyActionNoReceipt(:final message):
        throw WorkContextError(message);
    }
  }
}

/// The owner-signed replacement that closes one task.
///
/// The whole record is carried back with only the status and timestamp moved,
/// so nothing the relay validates is dropped by a client that does not model
/// every field. `updatedAt` advances by one from the head this is pinned to
/// rather than from the clock, so a retry against the same head produces
/// identical bytes and the relay recognises the replay.
CompanyAction planTaskCompletion(CompanyTask task, String relayPubkey) {
  final replacement = Map<String, Object?>.from(task.record)
    ..['status'] = 'completed'
    ..['updatedAt'] = task.updatedAt + 1;

  return CompanyAction(
    relayPubkey: relayPubkey,
    operation: CompanyActionOperation.transition,
    requestId: stepIdempotencyKey(task.id, 'queue-completion'),
    idempotencyKey: stepIdempotencyKey(
      task.id,
      'queue-completion:${task.headEventId}',
    ),
    target: taskCoordinate(relayPubkey, task.id),
    expectedHead: task.headEventId,
    payload: {'kind': 'task', 'record': replacement},
  );
}
