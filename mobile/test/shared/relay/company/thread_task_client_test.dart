import 'package:buzz/shared/relay/company/company_action.dart';
import 'package:buzz/shared/relay/company/company_action_broker.dart';
import 'package:buzz/shared/relay/company/company_signer.dart';
import 'package:buzz/shared/relay/company/thread_attach.dart';
import 'package:buzz/shared/relay/company/thread_task_client.dart';
import 'package:buzz/shared/relay/nostr_models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nostr/nostr.dart' as nostr;

import 'company_fixtures.dart';

/// A relay that answers exactly what a test tells it to.
class _FakeRelay {
  final nostr.Keys keys;
  final List<NostrEvent> published = [];

  /// Receipts to hand back, keyed by the action event id they answer.
  final Map<String, NostrEvent> receipts = {};

  /// Task heads to hand back, keyed by event id and by `d` tag.
  final List<NostrEvent> tasks = [];

  /// When set, publishing throws this instead of accepting.
  Object? publishFailure;

  _FakeRelay(this.keys);

  Future<NostrEvent> publish(NostrEvent event) async {
    final failure = publishFailure;
    if (failure != null) throw failure;
    published.add(event);
    return event;
  }

  Future<List<NostrEvent>> query(NostrFilter filter) async {
    if (filter.kinds.contains(EventKind.companyReceipt)) {
      final wanted = filter.tags['#e']?.first;
      final receipt = receipts[wanted];
      return receipt == null ? const [] : [receipt];
    }
    if (filter.kinds.contains(EventKind.task)) {
      final ids = filter.ids;
      final coordinates = filter.tags['#d'];
      return tasks.where((event) {
        if (ids != null) return ids.contains(event.id);
        if (coordinates != null) {
          return coordinates.contains(event.getTagValue('d'));
        }
        return true;
      }).toList();
    }
    return const [];
  }
}

ThreadTaskClient _client(_FakeRelay relay, {required String nsec}) {
  Future<String?> relaySelf() async => relay.keys.public;
  return ThreadTaskClient(
    relaySelf: relaySelf,
    signAction: (action) => signCompanyAction(nsec, action),
    query: relay.query,
    delay: (_) async {},
    broker: CompanyActionBroker(
      publish: relay.publish,
      fetchFirstEvent: (filter) async {
        final events = await relay.query(filter);
        return events.isEmpty ? null : events.first;
      },
      relaySelf: relaySelf,
      delay: (_) async {},
      attempts: 3,
      interval: Duration.zero,
    ),
  );
}

/// The action this send would publish, so a fixture can answer the right one.
CompanyAction _plannedAttach(String ownerPubkey, String relayPubkey) =>
    planThreadAttach(
      ThreadAttachRequest(
        channelId: 'engineering',
        threadRoot: 'abc',
        conversationScope: false,
        sendId: 'send-1',
        mode: ThreadAttachMode.open,
        title: 'ship the release',
        ownerPubkey: ownerPubkey,
        relayPubkey: relayPubkey,
      ),
    );

void main() {
  late nostr.Keys owner;
  late nostr.Keys relayKeys;
  late _FakeRelay relay;

  setUp(() {
    owner = nostr.Keys.generate();
    relayKeys = nostr.Keys.generate();
    relay = _FakeRelay(relayKeys);
  });

  Future<ThreadTaskClientResolution> resolve(ThreadTaskClient client) async {
    final task = await client.resolveWorkContext(
      channelId: 'engineering',
      sendId: 'send-1',
      ownerPubkey: owner.public,
      title: 'ship the release',
      mode: ThreadAttachMode.open,
      threadRoot: 'abc',
    );
    return ThreadTaskClientResolution(task.id, task.workContextTags);
  }

  test('an applied receipt resolves to the task the relay named', () async {
    final client = _client(relay, nsec: owner.nsec);
    final action = _plannedAttach(owner.public, relayKeys.public);
    final signed = signCompanyAction(owner.nsec, action);
    final head = signedTaskHead(keys: relayKeys, initiativeId: 'initiative-1');
    relay.tasks.add(head);
    relay.receipts[signed.id] = signedReceipt(
      keys: relayKeys,
      actionEventId: signed.id,
      headEventId: head.id,
      requestId: action.requestId,
      idempotencyKey: action.idempotencyKey,
    );

    final resolution = await resolve(client);
    expect(resolution.taskId, 'thread-task:sample');
    expect(resolution.tags, [
      ['task', 'thread-task:sample'],
      ['initiative', 'initiative-1'],
      ['team', 'team-coordination'],
    ]);
  });

  test('a superseded publish reads the winning action’s own receipt', () async {
    final client = _client(relay, nsec: owner.nsec);
    final action = _plannedAttach(owner.public, relayKeys.public);
    const winnerId =
        'ee55000000000000000000000000000000000000000000000000000000000055';
    relay.publishFailure = Exception(
      'conflict: superseded by original action $winnerId',
    );
    final head = signedTaskHead(keys: relayKeys);
    relay.tasks.add(head);
    relay.receipts[winnerId] = signedReceipt(
      keys: relayKeys,
      actionEventId: winnerId,
      headEventId: head.id,
      requestId: action.requestId,
      idempotencyKey: action.idempotencyKey,
    );

    final resolution = await resolve(client);
    expect(resolution.taskId, 'thread-task:sample');
  });

  test('a refusal fails the send rather than letting it go out', () async {
    final client = _client(relay, nsec: owner.nsec);
    final action = _plannedAttach(owner.public, relayKeys.public);
    final signed = signCompanyAction(owner.nsec, action);
    relay.receipts[signed.id] = signedReceipt(
      keys: relayKeys,
      actionEventId: signed.id,
      headEventId: null,
      outcome: 'rejected',
      requestId: action.requestId,
      idempotencyKey: action.idempotencyKey,
    );

    await expectLater(resolve(client), throwsA(isA<WorkContextError>()));
  });

  test('a relay that never answers fails the send, not the message', () async {
    final client = _client(relay, nsec: owner.nsec);
    await expectLater(resolve(client), throwsA(isA<WorkContextError>()));
  });

  test('a receipt for a different action is not this send’s answer', () async {
    final client = _client(relay, nsec: owner.nsec);
    final signed = signCompanyAction(
      owner.nsec,
      _plannedAttach(owner.public, relayKeys.public),
    );
    final head = signedTaskHead(keys: relayKeys);
    relay.tasks.add(head);
    // Right action id, wrong request: another send's answer arriving first.
    relay.receipts[signed.id] = signedReceipt(
      keys: relayKeys,
      actionEventId: signed.id,
      headEventId: head.id,
    );

    await expectLater(resolve(client), throwsA(isA<WorkContextError>()));
  });

  group('listing a thread’s tasks', () {
    test('drops hidden tasks and orders the rest newest first', () async {
      final client = _client(relay, nsec: owner.nsec);
      relay.tasks.addAll([
        signedTaskHead(keys: relayKeys, id: 'thread-task:old', updatedAt: 100),
        signedTaskHead(keys: relayKeys, id: 'thread-task:new', updatedAt: 200),
        signedTaskHead(
          keys: relayKeys,
          id: 'thread-task:chat',
          hidden: true,
          updatedAt: 300,
        ),
      ]);

      final tasks = await client.listThreadTasks('abc');
      expect(tasks.map((task) => task.id), [
        'thread-task:new',
        'thread-task:old',
      ]);
    });

    test('a DM’s tasks are found by channel, not by thread root', () async {
      final client = _client(relay, nsec: owner.nsec);
      relay.tasks.addAll([
        signedTaskHead(
          keys: relayKeys,
          id: 'thread-task:dm',
          threadRoot: null,
          sourceChannelId: 'dm-channel',
        ),
        signedTaskHead(keys: relayKeys, id: 'thread-task:thread'),
      ]);

      final tasks = await client.listConversationTasks('dm-channel');
      expect(tasks.map((task) => task.id), ['thread-task:dm']);
    });

    test('a completed task is history, so the thread has none open', () async {
      final client = _client(relay, nsec: owner.nsec);
      relay.tasks.add(
        signedTaskHead(
          keys: relayKeys,
          id: 'thread-task:done',
          status: 'completed',
        ),
      );
      expect(
        await client.openTaskFor(
          channelId: 'engineering',
          conversationScope: false,
          threadRoot: 'abc',
        ),
        isNull,
      );
    });
  });

  test('marking done pins to the head as it is right now', () async {
    final head = signedTaskHead(
      keys: relayKeys,
      id: 'thread-task:sample',
      updatedAt: 400,
    );
    relay.tasks.add(head);

    // The relay answers whatever action arrives, so the assertion is on what
    // the client published rather than on the outcome.
    late CompanyAction observed;
    final client = ThreadTaskClient(
      relaySelf: () async => relayKeys.public,
      signAction: (action) {
        observed = action;
        final signed = signCompanyAction(owner.nsec, action);
        relay.receipts[signed.id] = signedReceipt(
          keys: relayKeys,
          actionEventId: signed.id,
          headEventId: head.id,
          requestId: action.requestId,
          idempotencyKey: action.idempotencyKey,
        );
        return signed;
      },
      query: relay.query,
      delay: (_) async {},
      broker: CompanyActionBroker(
        publish: relay.publish,
        fetchFirstEvent: (filter) async {
          final events = await relay.query(filter);
          return events.isEmpty ? null : events.first;
        },
        relaySelf: () async => relayKeys.public,
        delay: (_) async {},
        attempts: 3,
        interval: Duration.zero,
      ),
    );
    await client.markTaskDone('thread-task:sample');

    expect(observed.operation, CompanyActionOperation.transition);
    expect(observed.expectedHead, head.id);
    expect(observed.content, contains('"status":"completed"'));
    expect(observed.content, contains('"updatedAt":401'));
  });
}

/// What one resolution produced, so the assertions read as the send would.
class ThreadTaskClientResolution {
  final String taskId;
  final List<List<String>> tags;

  const ThreadTaskClientResolution(this.taskId, this.tags);
}
