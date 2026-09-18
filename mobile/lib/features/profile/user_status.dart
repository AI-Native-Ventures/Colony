import 'package:flutter/foundation.dart';

import '../../shared/relay/nostr_models.dart';

const _minDateTimeUnixSeconds = -8640000000000;
const _maxDateTimeUnixSeconds = 8640000000000;

/// A user's NIP-38 status (kind:30315, d=general).
@immutable
class UserStatus {
  final String text;
  final String emoji;
  final int updatedAt;

  /// NIP-40 expiration, in unix SECONDS.
  ///
  /// Desktop writes this tag when a status is set with a duration
  /// (`desktop/src/shared/api/relayClientSession.ts`) and compares it against
  /// a seconds clock, converting with `expiresAt * 1000` only to schedule a
  /// timer. Treating it as milliseconds here would park every expiry ~50,000
  /// years out and silently keep showing a status desktop has already hidden.
  final int? expiresAt;

  const UserStatus({
    required this.text,
    required this.emoji,
    required this.updatedAt,
    this.expiresAt,
  });

  factory UserStatus.fromEvent(NostrEvent event) {
    final emojiTag = event.tags
        .where((t) => t.length >= 2 && t[0] == 'emoji')
        .firstOrNull;
    final expirationTag = event.tags
        .where((t) => t.length >= 2 && t[0] == 'expiration')
        .firstOrNull;
    return UserStatus(
      text: event.content,
      emoji: emojiTag?[1] ?? '',
      updatedAt: event.createdAt,
      expiresAt: int.tryParse(expirationTag?[1] ?? ''),
    );
  }

  /// Converts [expiresAt] when it falls within Dart's supported date range.
  ///
  /// NIP-40 expiration tags are untrusted integers and may exceed that range.
  DateTime? get expirationDateTime {
    final unixSeconds = expiresAt;
    if (unixSeconds == null ||
        unixSeconds < _minDateTimeUnixSeconds ||
        unixSeconds > _maxDateTimeUnixSeconds) {
      return null;
    }
    return DateTime.fromMillisecondsSinceEpoch(unixSeconds * 1000);
  }

  bool get isEmpty => text.isEmpty && emoji.isEmpty;

  /// Whether this status has expired as of [unixSeconds], in seconds.
  bool isExpiredAt(int unixSeconds) =>
      expiresAt != null && expiresAt! <= unixSeconds;
}
