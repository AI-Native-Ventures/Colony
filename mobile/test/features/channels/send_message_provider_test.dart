import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:nostr/nostr.dart' as nostr;
import 'package:buzz/features/channels/channel.dart';
import 'package:buzz/features/channels/channel_management_provider.dart';
import 'package:buzz/features/channels/send_message_provider.dart';
import 'package:buzz/features/channels/thread_tasks/attach_work_context.dart';
import 'package:buzz/shared/relay/relay.dart';

/// A community with no company records attributes nothing and sends
/// unchanged, which is what these tests are about.
AttachWorkContext get _passthroughWorkContext =>
    ({
      required String channelId,
      required String content,
      required List<String> mentionPubkeys,
      required List<List<String>> outgoingTags,
      String? threadRoot,
    }) async => outgoingTags;

final _senderNsec = nostr.Keys.generate().nsec;

const _me = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const _agentPubkey =
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

Channel _channel({
  required String type,
  List<String> participants = const [],
}) => Channel(
  id: _channelId,
  name: type == 'dm' ? 'DM' : 'general',
  channelType: type,
  visibility: 'private',
  description: '',
  createdBy: _me,
  createdAt: DateTime.utc(2024),
  memberCount: participants.length,
  participantPubkeys: participants,
);

List<String> _pTags(NostrEvent event) => [
  for (final tag in event.tags)
    if (tag.length > 1 && tag[0] == 'p') tag[1],
];

void main() {
  test(
    'adds the signed message locally before relay acknowledgement',
    () async {
      final session = _PendingPublishRelaySession();
      final localMessages = <NostrEvent>[];
      final removedIds = <String>[];
      final completedIds = <String>[];
      final send = SendMessage(
        signedEventRelay: SignedEventRelay(
          session: session,
          nsec: nostr.Keys.generate().nsec,
        ),
        fetchMembers: (_) async => const [],
        readUserCache: () => const {},
        addLocalMessage: (_, event) => localMessages.add(event),
        completeLocalMessage: (_, eventId) => completedIds.add(eventId),
        removeLocalMessage: (_, eventId) => removedIds.add(eventId),
        attachWorkContext: _passthroughWorkContext,
      );

      final result = send(channelId: _channelId, content: 'hello');
      await session.published;

      expect(localMessages, hasLength(1));
      expect(localMessages.single.id, session.event.id);
      expect(localMessages.single.content, 'hello');
      expect(localMessages.single.channelId, _channelId);
      expect(removedIds, isEmpty);

      session.accept();
      await result;
      expect(completedIds, [localMessages.single.id]);
      expect(removedIds, isEmpty);
    },
  );

  test('rolls back the signed local message when publish fails', () async {
    final session = _PendingPublishRelaySession();
    final localMessages = <NostrEvent>[];
    final completedIds = <String>[];
    final removedIds = <String>[];
    final send = SendMessage(
      signedEventRelay: SignedEventRelay(
        session: session,
        nsec: nostr.Keys.generate().nsec,
      ),
      fetchMembers: (_) async => const [],
      readUserCache: () => const {},
      addLocalMessage: (_, event) => localMessages.add(event),
      completeLocalMessage: (_, eventId) => completedIds.add(eventId),
      removeLocalMessage: (_, eventId) => removedIds.add(eventId),
      attachWorkContext: _passthroughWorkContext,
    );

    final result = send(channelId: _channelId, content: 'hello');
    await session.published;
    session.reject();

    await expectLater(result, throwsException);
    expect(completedIds, isEmpty);
    expect(removedIds, [localMessages.single.id]);
  });

  test(
    'addresses DM recipients with p tags without visible mentions',
    () async {
      final session = _PendingPublishRelaySession();
      final send = SendMessage(
        signedEventRelay: SignedEventRelay(session: session, nsec: _senderNsec),
        fetchMembers: (_) async => [
          ChannelMember(
            pubkey: _agentPubkey,
            role: 'member',
            joinedAt: DateTime.utc(2024),
          ),
        ],
        readUserCache: () => const {},
        addLocalMessage: (_, _) {},
        completeLocalMessage: (_, _) {},
        removeLocalMessage: (_, _) {},
        attachWorkContext: _passthroughWorkContext,
      );

      final result = send(
        channelId: _channelId,
        content: 'no visible mention here',
        channel: _channel(type: 'dm'),
      );
      await session.published;
      session.accept();
      await result;

      // An agent only answers messages that address it, so the p tag is what
      // makes a mobile DM to an agent arrive at all.
      expect(_pTags(session.event), [_agentPubkey]);
      expect(session.event.content, 'no visible mention here');
    },
  );

  test('leaves a non-DM channel explicit-only', () async {
    final session = _PendingPublishRelaySession();
    final send = SendMessage(
      signedEventRelay: SignedEventRelay(session: session, nsec: _senderNsec),
      fetchMembers: (_) async => [
        ChannelMember(
          pubkey: _agentPubkey,
          role: 'member',
          joinedAt: DateTime.utc(2024),
        ),
      ],
      readUserCache: () => const {},
      addLocalMessage: (_, _) {},
      completeLocalMessage: (_, _) {},
      removeLocalMessage: (_, _) {},
      attachWorkContext: _passthroughWorkContext,
    );

    final result = send(
      channelId: _channelId,
      content: 'hello channel',
      mentionPubkeys: const [],
      channel: _channel(type: 'stream'),
    );
    await session.published;
    session.accept();
    await result;

    expect(_pTags(session.event), isEmpty);
  });

  test(
    'falls back to channel participants when membership is unavailable',
    () async {
      final session = _PendingPublishRelaySession();
      final send = SendMessage(
        signedEventRelay: SignedEventRelay(session: session, nsec: _senderNsec),
        fetchMembers: (_) async => throw StateError('membership unavailable'),
        readUserCache: () => const {},
        addLocalMessage: (_, _) {},
        completeLocalMessage: (_, _) {},
        removeLocalMessage: (_, _) {},
        attachWorkContext: _passthroughWorkContext,
      );

      final result = send(
        channelId: _channelId,
        content: 'still delivered',
        channel: _channel(type: 'dm', participants: [_agentPubkey]),
      );
      await session.published;
      session.accept();
      await result;

      expect(_pTags(session.event), [_agentPubkey]);
    },
  );
}

const _channelId = '11111111-1111-4111-8111-111111111111';

class _PendingPublishRelaySession extends RelaySessionNotifier {
  final Completer<NostrEvent> _result = Completer<NostrEvent>();
  final Completer<void> _published = Completer<void>();
  late NostrEvent event;

  Future<void> get published => _published.future;

  @override
  SessionState build() => const SessionState(status: SessionStatus.connected);

  @override
  Future<NostrEvent> publish(
    NostrEvent event, {
    Duration timeout = const Duration(seconds: 8),
  }) {
    this.event = event;
    _published.complete();
    return _result.future;
  }

  void accept() => _result.complete(event);

  void reject() => _result.completeError(Exception('relay rejected event'));
}
