import 'package:buzz/features/channels/thread_tasks/attach_decision.dart';
import 'package:buzz/features/channels/thread_tasks/implies_work.dart';
import 'package:buzz/shared/relay/company/thread_attach.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('impliesWork', () {
    test('a greeting or a presence check asks for nothing', () {
      for (final message in [
        'hi',
        'Thanks!',
        'are you there?',
        '@Chief of Staff are you there?',
        '   ',
      ]) {
        expect(impliesWork(message), isFalse, reason: message);
      }
    });

    test('anything with an instruction in it is work', () {
      for (final message in [
        'ship it',
        'thanks, now ship it',
        '@Chief of Staff cut the release video',
        'no, do the other one',
      ]) {
        expect(impliesWork(message), isTrue, reason: message);
      }
    });
  });

  group('threadAttachModeFor', () {
    test('the switch wins even over small talk', () {
      expect(
        threadAttachModeFor(content: 'hi', newTask: true),
        ThreadAttachMode.createNew,
      );
    });

    test('work opens, and everything else attaches', () {
      expect(
        threadAttachModeFor(content: 'ship the release'),
        ThreadAttachMode.open,
      );
      expect(threadAttachModeFor(content: 'hi'), ThreadAttachMode.attach);
    });
  });

  group('sendNeedsWorkContext', () {
    test('two people talking in a thread with no work charge nothing', () {
      expect(
        sendNeedsWorkContext(
          channelId: 'engineering',
          mentionsAgent: false,
          threadHasOpenTask: false,
        ),
        isFalse,
      );
    });

    test('a send naming an agent always asks', () {
      expect(
        sendNeedsWorkContext(
          channelId: 'engineering',
          mentionsAgent: true,
          threadHasOpenTask: false,
        ),
        isTrue,
      );
    });

    test('once a thread holds work, every later message belongs to it', () {
      expect(
        sendNeedsWorkContext(
          channelId: 'engineering',
          mentionsAgent: false,
          threadHasOpenTask: true,
        ),
        isTrue,
      );
    });

    test('a send with no channel asks nobody anything', () {
      expect(
        sendNeedsWorkContext(
          channelId: '  ',
          mentionsAgent: true,
          threadHasOpenTask: true,
        ),
        isFalse,
      );
    });
  });

  group('sendIdentity', () {
    test('the same instruction to the same agent is the same send', () {
      expect(
        sendIdentity('engineering', 'ship it', 'agent-1'),
        sendIdentity('engineering', 'ship it', 'agent-1'),
      );
    });

    test('a different agent, channel, or instruction is a different send', () {
      final base = sendIdentity('engineering', 'ship it', 'agent-1');
      expect(base, isNot(sendIdentity('design', 'ship it', 'agent-1')));
      expect(base, isNot(sendIdentity('engineering', 'ship it!', 'agent-1')));
      expect(base, isNot(sendIdentity('engineering', 'ship it', 'agent-2')));
    });

    test('is a valid company identifier the relay will accept', () {
      expect(
        sendIdentity('engineering', 'ship it', 'agent-1'),
        matches(RegExp(r'^[0-9a-f]{32}$')),
      );
    });
  });

  test('work context replaces whatever the caller claimed, once', () {
    expect(
      mergeWorkContextTags(
        [
          ['h', 'engineering'],
          ['task', 'a-task-the-client-invented'],
          ['team', 'a-team-the-client-invented'],
        ],
        [
          ['task', 'thread-task:real'],
          ['team', 'team-real'],
        ],
      ),
      [
        ['h', 'engineering'],
        ['task', 'thread-task:real'],
        ['team', 'team-real'],
      ],
    );
  });

  test('a new-task request is remembered against its own conversation', () {
    expect(
      newTaskScope(channelId: 'engineering', threadRoot: 'abc'),
      isNot(newTaskScope(channelId: 'engineering', threadRoot: 'def')),
    );
    // A DM has no root, so the conversation itself is the scope.
    expect(newTaskScope(channelId: 'dm-1', threadRoot: null), 'dm-1:');
  });
}
