import '../../../shared/relay/company/company_task.dart';
import '../../../shared/relay/company/thread_task_client.dart';
import 'attach_decision.dart';
import 'thread_task_providers.dart';

/// The seam a send goes through to learn which task it is charged to.
///
/// A function rather than the class below so a caller that has no company to
/// talk to - a test, or a surface that only sends - can hand over a
/// passthrough without standing up a relay.
typedef AttachWorkContext =
    Future<List<List<String>>> Function({
      required String channelId,
      required String content,
      required List<String> mentionPubkeys,
      required List<List<String>> outgoingTags,
      String? threadRoot,
    });

/// Attaching work context to an outgoing message.
///
/// The narrow seam between the composer and the company records. The composer
/// knows the channel, the instruction, and who it is addressed to; it knows
/// nothing about companies, tasks, or cost centres, and should not have to.
///
/// A community with no company records attributes nothing and sends unchanged.
/// That is every install that has not been through onboarding, and refusing to
/// send in those would break chat to record accounting nobody asked for yet.
/// A failure once the relay *has* answered is different: the send fails, and
/// the composer says so.
class WorkContextAttacher {
  final ThreadTaskClient _client;
  final String? Function() _ownerPubkey;
  final Set<String> Function(String channelId) _agentPubkeys;
  final bool Function(String channelId) _isConversation;
  final Future<CompanyTask?> Function(ThreadTaskScope scope) _openTask;
  final String? Function() _newTaskRequest;
  final void Function() _consumeNewTaskRequest;
  final void Function(ThreadTaskScope scope) _invalidateOpenTask;

  const WorkContextAttacher({
    required ThreadTaskClient client,
    required String? Function() ownerPubkey,
    required Set<String> Function(String channelId) agentPubkeys,
    required bool Function(String channelId) isConversation,
    required Future<CompanyTask?> Function(ThreadTaskScope scope) openTask,
    required String? Function() newTaskRequest,
    required void Function() consumeNewTaskRequest,
    required void Function(ThreadTaskScope scope) invalidateOpenTask,
  }) : _client = client,
       _ownerPubkey = ownerPubkey,
       _agentPubkeys = agentPubkeys,
       _isConversation = isConversation,
       _openTask = openTask,
       _newTaskRequest = newTaskRequest,
       _consumeNewTaskRequest = consumeNewTaskRequest,
       _invalidateOpenTask = invalidateOpenTask;

  /// The tags this message must carry, work context merged in.
  ///
  /// [threadRoot] is the root event id of the thread this send replies in, and
  /// null at channel root, where the relay claims the thread under the send's
  /// own id and rebinds it once the message arrives. It is ignored in a DM: a
  /// DM is one thread for its whole life, so the relay keys it by the
  /// conversation and a root would only ever narrow it.
  Future<List<List<String>>> call({
    required String channelId,
    required String content,
    required List<String> mentionPubkeys,
    required List<List<String>> outgoingTags,
    String? threadRoot,
  }) async {
    final outgoing = [
      for (final tag in outgoingTags) [...tag],
    ];
    if (channelId.trim().isEmpty) return outgoing;

    final conversationScope = _isConversation(channelId);
    final effectiveRoot = conversationScope ? null : threadRoot;
    final scope = ThreadTaskScope(
      channelId: channelId,
      conversationScope: conversationScope,
      threadRoot: effectiveRoot,
    );

    final agents = _agentPubkeys(channelId);
    String? agentPubkey;
    for (final mention in mentionPubkeys) {
      final normalized = mention.toLowerCase();
      if (agents.contains(normalized)) {
        agentPubkey = normalized;
        break;
      }
    }

    // Only a conversation that could already hold work is worth asking about.
    // A channel-root send starts its own thread, so there is nothing open to
    // join and nothing to be told about.
    CompanyTask? openTask;
    if (scope.isAddressable) {
      try {
        openTask = await _openTask(scope);
      } catch (_) {
        // No company on this community, or the read failed. Either way this
        // must not become a refusal to send an ordinary message; a send that
        // names an agent still asks below, and fails loudly if that fails.
        openTask = null;
      }
    }

    final requestedScope = _newTaskRequest();
    final newTask =
        openTask != null &&
        requestedScope ==
            newTaskScope(channelId: channelId, threadRoot: effectiveRoot);

    if (!sendNeedsWorkContext(
      channelId: channelId,
      mentionsAgent: agentPubkey != null,
      threadHasOpenTask: openTask != null,
      newTask: newTask,
    )) {
      return outgoing;
    }

    final ownerPubkey = _ownerPubkey();
    if (ownerPubkey == null || ownerPubkey.isEmpty) {
      throw const WorkContextError(
        'This device has no signing key, so this message cannot be charged to '
        'any work. It has not been sent.',
      );
    }

    final task = await _client.resolveWorkContext(
      channelId: channelId,
      sendId: sendIdentity(channelId, content, agentPubkey ?? ''),
      ownerPubkey: ownerPubkey,
      title: content,
      mode: threadAttachModeFor(content: content, newTask: newTask),
      threadRoot: effectiveRoot,
      conversationScope: conversationScope,
      agentPersonaId: agentPubkey == null
          ? null
          : await _client.resolveAgentPersonaId(agentPubkey),
    );

    // Per-send, not a mode: leaving it on would quietly open a task per
    // message, which is the behaviour thread-scoped tasks exist to end.
    if (newTask) _consumeNewTaskRequest();
    _invalidateOpenTask(scope);

    return mergeWorkContextTags(outgoing, task.workContextTags);
  }
}
