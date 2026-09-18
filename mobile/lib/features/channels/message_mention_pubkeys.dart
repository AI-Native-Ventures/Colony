import 'channel.dart';

/// Semantic recipients for an outgoing mobile message.
///
/// Explicit mentions are always preserved. In a DM, every current recipient is
/// also addressed with a `p` tag without inserting visible `@mentions` into the
/// composer. Non-DM channels remain explicit-only.
///
/// This is what makes a DM to an agent work at all: an agent only answers
/// messages that address it, so a DM with no `p` tag reaches nobody.
///
/// Do not lift this into an agent-side client. Colony's relay refuses a
/// worker- or leader-tier agent that p-tags a community owner on kind 9 with
/// no thread root (`crates/buzz-relay/src/interrupt_gate.rs`), which is
/// exactly the shape this builds for a top-level DM message. Signing here is
/// always a human's device key, which the gate leaves unrestricted.
List<String> messageMentionPubkeys({
  required Channel channel,
  required String? senderPubkey,
  required Iterable<String> explicitMentions,
  required Iterable<String> dmRecipientPubkeys,
}) {
  final sender = senderPubkey?.toLowerCase();
  final candidates = <String>[
    ...explicitMentions,
    if (channel.isDm) ...dmRecipientPubkeys,
  ];

  final seen = <String>{?sender};
  return [
    for (final candidate in candidates)
      if (candidate.trim().isNotEmpty && seen.add(candidate.toLowerCase()))
        candidate.toLowerCase(),
  ];
}
