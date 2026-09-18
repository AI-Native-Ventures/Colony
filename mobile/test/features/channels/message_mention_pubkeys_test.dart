import 'package:buzz/features/channels/channel.dart';
import 'package:buzz/features/channels/message_mention_pubkeys.dart';
import 'package:flutter_test/flutter_test.dart';

const _me = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const _peer =
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const _agent =
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

Channel _channel({required String type}) => Channel(
  id: 'channel-1',
  name: type == 'dm' ? 'DM' : 'general',
  channelType: type,
  visibility: 'private',
  description: '',
  createdBy: _me,
  createdAt: DateTime.utc(2024),
  memberCount: 2,
);

void main() {
  test('addresses every DM recipient without a visible mention', () {
    final result = messageMentionPubkeys(
      channel: _channel(type: 'dm'),
      senderPubkey: _me,
      explicitMentions: const [],
      dmRecipientPubkeys: const [_peer, _agent],
    );

    expect(result, [_peer, _agent]);
  });

  test('leaves non-DM channels explicit-only', () {
    final result = messageMentionPubkeys(
      channel: _channel(type: 'stream'),
      senderPubkey: _me,
      explicitMentions: const [_peer],
      // A stream channel's members must never be addressed implicitly.
      dmRecipientPubkeys: const [_agent],
    );

    expect(result, [_peer]);
  });

  test('never addresses the sender', () {
    final result = messageMentionPubkeys(
      channel: _channel(type: 'dm'),
      senderPubkey: _me.toUpperCase(),
      explicitMentions: const [_me],
      dmRecipientPubkeys: const [_me, _peer],
    );

    expect(result, [_peer]);
  });

  test('deduplicates an explicit mention that is also a DM recipient', () {
    final result = messageMentionPubkeys(
      channel: _channel(type: 'dm'),
      senderPubkey: _me,
      explicitMentions: const [_peer],
      dmRecipientPubkeys: const [_peer, _agent],
    );

    expect(result, [_peer, _agent]);
  });

  test('normalizes case and drops blank entries', () {
    final result = messageMentionPubkeys(
      channel: _channel(type: 'dm'),
      senderPubkey: _me,
      explicitMentions: const ['   '],
      dmRecipientPubkeys: [_peer.toUpperCase(), ''],
    );

    expect(result, [_peer]);
  });
}
