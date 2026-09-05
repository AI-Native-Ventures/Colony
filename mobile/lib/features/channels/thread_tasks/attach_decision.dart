import 'dart:convert';
import 'dart:typed_data';

import 'package:pointycastle/digests/sha256.dart';

import '../../../shared/relay/company/thread_attach.dart';
import 'implies_work.dart';

/// What a send asks its thread for, and whether it asks at all.
///
/// Pure on purpose: the composer owns the controls, the client owns the wire,
/// and this owns the rule. The rule is the part worth proving without a relay.

/// The stable identity of one send.
///
/// Derived from the channel, the instruction, and the agent rather than
/// generated, because it is what makes a retry reuse its task instead of
/// creating a second one. Two byte-identical instructions to the same agent in
/// the same channel therefore share a task, which is the honest reading: it is
/// the same request, asked again.
String sendIdentity(String channelId, String content, String agentPubkey) {
  final digest = SHA256Digest().process(
    Uint8List.fromList(utf8.encode('$channelId $content $agentPubkey')),
  );
  final hex = [
    for (final byte in digest) byte.toRadixString(16).padLeft(2, '0'),
  ].join();
  return hex.substring(0, 32);
}

/// What this send asks its thread for.
///
/// The switch wins over everything: a member who asked for a separate task
/// means it even when the message reads like small talk. Otherwise a
/// work-implying message opens the thread's task (or joins the one already
/// open), and everything else attaches, which charges the turn without putting
/// "are you there?" on the Tasks page.
ThreadAttachMode threadAttachModeFor({
  required String content,
  bool newTask = false,
}) {
  if (newTask) return ThreadAttachMode.createNew;
  return impliesWork(content) ? ThreadAttachMode.open : ThreadAttachMode.attach;
}

/// Whether this send has to ask the relay anything at all.
///
/// A send that names no agent in a thread where no work is open charges
/// nothing: no agent is going to answer it, so there is no turn to attribute,
/// and opening a hidden task for it would record two people talking as company
/// cost. Once a thread does hold work, every later message in it belongs to
/// that work whether or not it names anybody.
bool sendNeedsWorkContext({
  required String channelId,
  required bool mentionsAgent,
  required bool threadHasOpenTask,
  bool newTask = false,
}) {
  if (channelId.trim().isEmpty) return false;
  return mentionsAgent || threadHasOpenTask || newTask;
}

/// Merge work context into outgoing tags, refusing to duplicate any of them.
List<List<String>> mergeWorkContextTags(
  List<List<String>> outgoing,
  List<List<String>> context,
) {
  const reserved = {'task', 'initiative', 'team'};
  return [
    for (final tag in outgoing)
      if (tag.isEmpty || !reserved.contains(tag.first)) [...tag],
    ...context.map((tag) => [...tag]),
  ];
}

/// The conversation a "New task" request belongs to.
///
/// Remembered against its thread rather than as a bare boolean, so moving to
/// another thread drops the request without anything having to notice the
/// move.
String newTaskScope({
  required String? channelId,
  required String? threadRoot,
}) => '${channelId ?? ''}:${threadRoot ?? ''}';
