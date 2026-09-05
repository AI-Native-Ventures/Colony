import 'dart:convert';

import 'package:buzz/shared/relay/company/canonical_json.dart';
import 'package:buzz/shared/relay/company/company_action.dart';
import 'package:buzz/shared/relay/company/thread_attach.dart';
import 'package:buzz/shared/relay/nostr_models.dart';
import 'package:flutter_test/flutter_test.dart';

const _relay =
    '5f2b1c8d4e7a90b3c6d1e4f7a0b3c6d9e2f5a8b1c4d7e0f3a6b9c2d5e8f1a4b7';
const _owner =
    'ab12000000000000000000000000000000000000000000000000000000000000';

ThreadAttachRequest _sample({
  ThreadAttachMode mode = ThreadAttachMode.open,
  String? threadRoot = 'abc',
  bool conversationScope = false,
  String sendId = 'send-1',
  String title = 'ship the release',
}) => ThreadAttachRequest(
  channelId: 'engineering',
  threadRoot: threadRoot,
  conversationScope: conversationScope,
  sendId: sendId,
  mode: mode,
  title: title,
  ownerPubkey: _owner,
  relayPubkey: _relay,
  agentPersonaId: 'persona-cto',
);

void main() {
  group('thread slots', () {
    test('are the same coordinate from every client', () {
      final upper = threadSlotId(
        channelId: 'engineering',
        threadKey: 'root:abc',
        ownerPubkey: _owner.toUpperCase(),
      );
      final lower = threadSlotId(
        channelId: 'engineering',
        threadKey: 'root:abc',
        ownerPubkey: _owner,
      );
      expect(upper, lower);
      expect(upper, startsWith(threadSlotPrefix));
    });

    test('never collide between the work and chat slots', () {
      expect(
        threadSlotId(
          channelId: 'engineering',
          threadKey: 'root:abc',
          ownerPubkey: _owner,
        ),
        isNot(
          threadSlotId(
            channelId: 'engineering',
            threadKey: 'root:abc',
            ownerPubkey: _owner,
            slot: ThreadSlot.chat,
          ),
        ),
      );
    });

    test('give a second member in one thread their own slot', () {
      expect(
        threadSlotId(
          channelId: 'engineering',
          threadKey: 'root:abc',
          ownerPubkey: _owner,
        ),
        isNot(
          threadSlotId(
            channelId: 'engineering',
            threadKey: 'root:abc',
            ownerPubkey: 'cd34',
          ),
        ),
      );
    });
  });

  test('a reply and a root send key the same thread differently', () {
    expect(
      threadKey(threadRoot: 'abc', sendId: 'send-1', conversationScope: false),
      'root:abc',
    );
    expect(
      threadKey(threadRoot: null, sendId: 'send-1', conversationScope: false),
      'send:send-1',
    );
    expect(
      threadKey(threadRoot: 'abc', sendId: 'send-1', conversationScope: true),
      'conversation',
    );
  });

  test('a title longer than the relay accepts is cut on a rune boundary', () {
    final long = '€' * 100; // 300 UTF-8 bytes.
    final clamped = clampTaskTitle(long);
    expect(utf8.encode(clamped).length, lessThanOrEqualTo(maxTaskTitleBytes));
    expect(clamped.runes.length, 66);
    expect(clampTaskTitle('short'), 'short');
  });

  group('planThreadAttach', () {
    test('targets its slot and asserts no head', () {
      final action = planThreadAttach(_sample());
      expect(action.operation, CompanyActionOperation.attach);
      expect(action.expectedHead, isNull);
      expect(action.target, startsWith('${EventKind.task}:$_relay:'));
      expect(action.target, contains(threadSlotPrefix));
    });

    test('the same send replays and a new task does not', () {
      final open = planThreadAttach(_sample());
      final repeat = planThreadAttach(_sample());
      final fresh = planThreadAttach(_sample(mode: ThreadAttachMode.createNew));
      expect(open.idempotencyKey, repeat.idempotencyKey);
      expect(open.idempotencyKey, isNot(fresh.idempotencyKey));
    });

    test('a send without a channel or a relay is refused', () {
      expect(
        () => planThreadAttach(
          ThreadAttachRequest(
            channelId: '   ',
            threadRoot: null,
            conversationScope: false,
            sendId: 'send-1',
            mode: ThreadAttachMode.open,
            title: 'x',
            ownerPubkey: _owner,
            relayPubkey: _relay,
          ),
        ),
        throwsA(isA<ThreadAttachError>()),
      );
      expect(
        () => planThreadAttach(
          ThreadAttachRequest(
            channelId: 'engineering',
            threadRoot: null,
            conversationScope: false,
            sendId: 'send-1',
            mode: ThreadAttachMode.open,
            title: 'x',
            ownerPubkey: _owner,
            relayPubkey: 'not-a-key',
          ),
        ),
        throwsA(isA<ThreadAttachError>()),
      );
    });

    test('carries the exact record the relay validates', () {
      final action = planThreadAttach(_sample());
      final content = jsonDecode(action.content) as Map<String, dynamic>;
      expect(content['schema'], companyActionSchema);
      expect(content['operation'], 'attach');
      expect(content['expectedHead'], isNull);
      expect(content['expectedReferences'], isEmpty);

      final payload = content['payload'] as Map<String, dynamic>;
      expect(payload['kind'], 'threadAttach');
      final record = payload['record'] as Map<String, dynamic>;
      expect(record['schema'], threadAttachSchema);
      expect(record['mode'], 'open');
      expect(record['threadRoot'], 'abc');
      expect(record['conversationScope'], isFalse);
      expect(record['sendId'], 'send-1');
      expect(record['agentPersonaId'], 'persona-cto');
      expect(record['parentTaskId'], isNull);
      expect(content['target'], endsWith(':${record['id']}'));
      expect(record['id'], startsWith(threadSlotPrefix));
    });

    test('a root send names no thread root, and a DM names none either', () {
      final root = planThreadAttach(_sample(threadRoot: null));
      final dm = planThreadAttach(
        _sample(threadRoot: null, conversationScope: true),
      );
      for (final action in [root, dm]) {
        final record =
            ((jsonDecode(action.content) as Map<String, dynamic>)['payload']
                    as Map<String, dynamic>)['record']
                as Map<String, dynamic>;
        expect(record['threadRoot'], isNull);
      }
      // Different threads, so different slots: one is claimed under its send
      // id and rebound later, the other is the conversation for its whole life.
      expect(root.target, isNot(dm.target));
    });

    test('the envelope is exactly three tags', () {
      final tags = planThreadAttach(_sample()).tags;
      expect(tags.map((tag) => tag.first).toSet(), {
        'p',
        'a',
        'company-action',
      });
      expect(tags.length, 3);
      final tuple = tags.firstWhere((tag) => tag.first == 'company-action');
      expect(tuple.length, 5);
      expect(tuple[1], '1');
      expect(tuple[2], 'attach');
    });
  });

  group('canonical encodings', () {
    test('object keys are sorted recursively and nothing is spaced', () {
      expect(
        canonicalCompanyJson({
          'z': [
            {'b': 2, 'a': 1},
          ],
          'a': {'d': 4, 'c': 3},
        }),
        '{"a":{"c":3,"d":4},"z":[{"a":1,"b":2}]}',
      );
    });

    test('a derived timestamp is stable and inside the Colony epoch year', () {
      final first = approvalTimestamp('engineering:send-1');
      expect(first, approvalTimestamp('engineering:send-1'));
      expect(first, greaterThanOrEqualTo(1767225600));
      expect(first, lessThan(1767225600 + 31536000));
      expect(first, isNot(approvalTimestamp('engineering:send-2')));
    });

    test('a derived idempotency key is a v5 uuid and is stable', () {
      final key = stepIdempotencyKey('thread-slot', 'a:b:c:work');
      expect(key, stepIdempotencyKey('thread-slot', 'a:b:c:work'));
      expect(
        key,
        matches(
          RegExp(
            r'^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}'
            r'-[0-9a-f]{12}$',
          ),
        ),
      );
    });
  });
}
