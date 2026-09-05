import 'dart:convert';

import '../nostr_models.dart';
import 'canonical_json.dart';

/// A relay-authored Company Task head (kind 30181).
///
/// Only the fields mobile reads are lifted out. The full record is kept as
/// [record] because a replacement has to carry every field back unchanged: the
/// relay validates the whole task, and a client that rebuilt it from a partial
/// model would silently drop whatever it did not know about.

/// Exact content schema identifier, matching `TASK_SCHEMA`.
const companyTaskSchema = 'colony.task/v1';

/// Statuses a task never leaves.
const terminalTaskStatuses = {'completed', 'cancelled'};

/// Whether a task has reached a state it never moves out of.
bool isTerminalTaskStatus(String status) =>
    terminalTaskStatuses.contains(status);

class CompanyTask {
  /// Event id of the head this was read from, which a replacement pins to.
  final String headEventId;

  /// The whole signed record, for building a replacement.
  final Map<String, Object?> record;

  final String id;
  final String title;
  final String status;
  final String owningTeamId;
  final String? initiativeId;
  final String sourceChannelId;

  /// Root event id of the thread this task is worked in, null in a DM, where
  /// the conversation is the thread.
  final String? threadRoot;

  /// Whether an agent or a person performs this task.
  final String doerKind;

  /// Personas assigned to perform it.
  final List<String> assigneePersonaIds;

  /// Assignees that have reported their own share complete.
  final List<String> reportedCompleteBy;

  /// Whether this task exists only to carry the cost of turns that were not
  /// work. Never rendered: it is an accounting record, not a piece of work.
  final bool hidden;

  /// The task this one was split out of, for parallel work in one thread.
  final String? parentTaskId;

  final int createdAt;
  final int updatedAt;

  const CompanyTask({
    required this.headEventId,
    required this.record,
    required this.id,
    required this.title,
    required this.status,
    required this.owningTeamId,
    required this.initiativeId,
    required this.sourceChannelId,
    required this.threadRoot,
    required this.doerKind,
    required this.assigneePersonaIds,
    required this.reportedCompleteBy,
    required this.hidden,
    required this.parentTaskId,
    required this.createdAt,
    required this.updatedAt,
  });

  bool get isTerminal => isTerminalTaskStatus(status);

  /// The reference tags a message carries to name the work it belongs to.
  ///
  /// Built from the relay-authored head, never from what the client asked
  /// for: the head is what the agent harness re-reads, and a message that
  /// disagreed with it would attribute a turn to work the relay never
  /// recorded. Cost centre, client, and commercial purpose are deliberately
  /// absent - they are properties of the task, and a message that carried them
  /// would be a message that could lie about them.
  List<List<String>> get workContextTags => [
    ['task', id],
    if (initiativeId case final initiative? when initiative.isNotEmpty)
      ['initiative', initiative],
    ['team', owningTeamId],
  ];
}

/// Parse one relay-authored task head, or null when it is not one.
///
/// [relaySelfPubkey] is the tenant relay's own key. A task head signed by
/// anybody else is a member claiming company state, so it is dropped rather
/// than read.
CompanyTask? parseTaskHead(NostrEvent event, String relaySelfPubkey) {
  final relay = normalizeHex(relaySelfPubkey);
  if (event.kind != EventKind.task ||
      relay.isEmpty ||
      normalizeHex(event.pubkey) != relay) {
    return null;
  }
  final coordinate = event.getTagValue('d');
  if (coordinate == null || coordinate.isEmpty) return null;

  final Object? decoded;
  try {
    decoded = jsonDecode(event.content);
  } catch (_) {
    return null;
  }
  if (decoded is! Map<String, dynamic>) return null;
  if (decoded['schema'] != companyTaskSchema) return null;

  final id = decoded['id'];
  final title = decoded['title'];
  final status = decoded['status'];
  final owningTeamId = decoded['owningTeamId'];
  final sourceChannelId = decoded['sourceChannelId'];
  if (id is! String ||
      id != coordinate ||
      title is! String ||
      status is! String ||
      owningTeamId is! String ||
      sourceChannelId is! String) {
    return null;
  }

  return CompanyTask(
    headEventId: event.id,
    record: Map<String, Object?>.from(decoded),
    id: id,
    title: title,
    status: status,
    owningTeamId: owningTeamId,
    initiativeId: _optionalString(decoded['initiativeId']),
    sourceChannelId: sourceChannelId,
    threadRoot: _optionalString(decoded['threadRoot']),
    doerKind: _optionalString(decoded['doerKind']) ?? 'agent',
    assigneePersonaIds: _stringList(decoded['assigneePersonaIds']),
    reportedCompleteBy: _stringList(decoded['reportedCompleteBy']),
    hidden: decoded['hidden'] == true,
    parentTaskId: _optionalString(decoded['parentTaskId']),
    createdAt: _integer(decoded['createdAt']),
    updatedAt: _integer(decoded['updatedAt']),
  );
}

String? _optionalString(Object? value) =>
    value is String && value.isNotEmpty ? value : null;

List<String> _stringList(Object? value) => value is List
    ? [
        for (final entry in value)
          if (entry is String) entry,
      ]
    : const [];

int _integer(Object? value) => value is int ? value : 0;

/// Newest first, then by id, so a thread's task history reads the same on
/// every client.
int threadHistoryOrder(CompanyTask left, CompanyTask right) {
  final byRecency = right.updatedAt.compareTo(left.updatedAt);
  return byRecency != 0 ? byRecency : left.id.compareTo(right.id);
}
