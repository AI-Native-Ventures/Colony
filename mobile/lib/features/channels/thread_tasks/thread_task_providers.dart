import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../../shared/relay/company/company_action_broker.dart';
import '../../../shared/relay/company/company_signer.dart';
import '../../../shared/relay/company/company_task.dart';
import '../../../shared/relay/company/relay_self.dart';
import '../../../shared/relay/company/thread_task_client.dart';
import '../../../shared/relay/relay.dart';
import 'attach_decision.dart';

/// Riverpod access to a thread's task.
///
/// Everything here is scoped to the active community by way of
/// [relayConfigProvider]: switching community rebuilds the config, which
/// rebuilds the client and drops every cached answer with it, so one
/// community's tasks can never be read against another's relay.

/// The active relay's own signing key, from its NIP-11 document.
///
/// Company records are only evidence because the tenant relay authored them,
/// so this is what every read is measured against. Null means untrusted, and
/// callers treat it exactly as they treat a failure.
final relaySelfProvider = FutureProvider<String?>((ref) async {
  final config = ref.watch(relayConfigProvider);
  return fetchRelaySelf(config.baseUrl);
});

/// The client that asks the relay which task a send belongs to.
final threadTaskClientProvider = Provider<ThreadTaskClient>((ref) {
  final config = ref.watch(relayConfigProvider);
  final session = ref.read(relaySessionProvider.notifier);
  Future<String?> relaySelf() => ref.read(relaySelfProvider.future);

  return ThreadTaskClient(
    relaySelf: relaySelf,
    signAction: (action) {
      final nsec = config.nsec;
      if (nsec == null || nsec.isEmpty) {
        throw const WorkContextError(
          'Recording company work requires this community’s signing key.',
        );
      }
      return signCompanyAction(nsec, action);
    },
    query: (filter) => session.queryRelay([filter]),
    broker: CompanyActionBroker(
      publish: session.publish,
      fetchFirstEvent: (filter) async {
        final events = await session.queryRelay([filter]);
        return events.isEmpty ? null : events.first;
      },
      relaySelf: relaySelf,
    ),
  );
});

/// The public key this device signs company actions as.
final companySignerPubkeyProvider = Provider<String?>(
  (ref) => companySignerPubkey(ref.watch(relayConfigProvider).nsec),
);

/// Which conversation a task lookup is about.
@immutable
class ThreadTaskScope {
  final String channelId;

  /// True in a DM, where the conversation itself is the thread.
  final bool conversationScope;

  /// Root event id of the thread, null at channel root and in a DM.
  final String? threadRoot;

  const ThreadTaskScope({
    required this.channelId,
    required this.conversationScope,
    required this.threadRoot,
  });

  /// Whether this scope names a conversation a task could be open in.
  ///
  /// A channel root is not one: a message there starts a thread rather than
  /// joining one, so there is nothing yet for a task to be attached to.
  bool get isAddressable =>
      channelId.isNotEmpty &&
      (conversationScope || (threadRoot?.isNotEmpty ?? false));

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ThreadTaskScope &&
          channelId == other.channelId &&
          conversationScope == other.conversationScope &&
          threadRoot == other.threadRoot;

  @override
  int get hashCode => Object.hash(channelId, conversationScope, threadRoot);
}

/// The task a thread currently has open, or null.
///
/// A thread holds at most one, so "the newest live one" is the whole rule.
/// Terminal tasks are history, and hidden tasks never reach this list at all:
/// the client drops them, because a task that only carries the cost of small
/// talk is not work anyone can be shown or asked to close.
final threadOpenTaskProvider =
    FutureProvider.family<CompanyTask?, ThreadTaskScope>((ref, scope) async {
      if (!scope.isAddressable) return null;
      final client = ref.watch(threadTaskClientProvider);
      return client.openTaskFor(
        channelId: scope.channelId,
        conversationScope: scope.conversationScope,
        threadRoot: scope.threadRoot,
      );
    });

/// The composer's "New task" request, held against the conversation it was
/// made in.
///
/// Per-send rather than a mode: leaving it on would quietly open a task per
/// message, which is the behaviour thread-scoped tasks exist to end.
class ComposerNewTaskNotifier extends Notifier<String?> {
  @override
  String? build() => null;

  /// Whether the switch is on for [scope].
  bool isRequestedFor(String scope) => state == scope;

  void request(String scope) => state = scope;

  void clear() => state = null;

  /// Called once the send that carried the switch has gone out.
  void consume() => state = null;
}

final composerNewTaskProvider =
    NotifierProvider<ComposerNewTaskNotifier, String?>(
      ComposerNewTaskNotifier.new,
    );

/// Whether the "New task" switch is on for one conversation right now.
final composerNewTaskRequestedProvider = Provider.family<bool, ThreadTaskScope>(
  (ref, scope) =>
      ref.watch(composerNewTaskProvider) ==
      newTaskScope(channelId: scope.channelId, threadRoot: scope.threadRoot),
);
