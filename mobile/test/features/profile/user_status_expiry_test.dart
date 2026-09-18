import 'package:buzz/features/profile/user_status.dart';
import 'package:buzz/shared/relay/relay.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:buzz/features/profile/user_status_cache_provider.dart';

NostrEvent _statusEvent({
  required int createdAt,
  String content = 'heads down',
  List<List<String>> extraTags = const [],
}) => NostrEvent(
  id: 'status-$createdAt',
  pubkey: 'aa',
  createdAt: createdAt,
  kind: EventKind.userStatus,
  tags: [
    ['d', 'general'],
    ...extraTags,
  ],
  content: content,
  sig: 'sig',
);

void main() {
  test('reads a NIP-40 expiration tag as unix seconds', () {
    // Desktop writes this tag as seconds in relayClientSession.ts and compares
    // it against a seconds clock. Reading it as milliseconds here would park
    // every expiry tens of thousands of years out.
    const expiresAtSeconds = 1893456000; // 2030-01-01T00:00:00Z
    final status = UserStatus.fromEvent(
      _statusEvent(
        createdAt: 1000,
        extraTags: const [
          ['expiration', '$expiresAtSeconds'],
        ],
      ),
    );

    expect(status.expiresAt, expiresAtSeconds);
    expect(
      status.expirationDateTime,
      DateTime.fromMillisecondsSinceEpoch(expiresAtSeconds * 1000),
    );
    expect(status.expirationDateTime!.toUtc().year, 2030);
  });

  test('a status with no expiration tag never expires', () {
    final status = UserStatus.fromEvent(_statusEvent(createdAt: 1000));

    expect(status.expiresAt, isNull);
    expect(status.expirationDateTime, isNull);
    expect(status.isExpiredAt(9999999999), isFalse);
  });

  test('expiry is inclusive of its own second', () {
    final status = UserStatus.fromEvent(
      _statusEvent(
        createdAt: 1000,
        extraTags: const [
          ['expiration', '2000'],
        ],
      ),
    );

    expect(status.isExpiredAt(1999), isFalse);
    expect(status.isExpiredAt(2000), isTrue);
    expect(status.isExpiredAt(2001), isTrue);
  });

  test('ignores an unparsable expiration tag', () {
    final status = UserStatus.fromEvent(
      _statusEvent(
        createdAt: 1000,
        extraTags: const [
          ['expiration', 'soon'],
        ],
      ),
    );

    expect(status.expiresAt, isNull);
    expect(status.isExpiredAt(9999999999), isFalse);
  });

  test('refuses an expiration outside Dart\'s date range', () {
    // NIP-40 tags are untrusted integers; DateTime would throw on these.
    final status = UserStatus.fromEvent(
      _statusEvent(
        createdAt: 1000,
        extraTags: const [
          ['expiration', '99999999999999'],
        ],
      ),
    );

    expect(status.expiresAt, 99999999999999);
    expect(status.expirationDateTime, isNull);
    // Still expired in the comparison sense, just not schedulable.
    expect(status.isExpiredAt(9999999999), isFalse);
  });

  test('cache clears a status once its deadline passes', () async {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final cache = container.read(userStatusCacheProvider.notifier);

    final past = DateTime.now().millisecondsSinceEpoch ~/ 1000 - 60;
    cache.updateStatus(
      'aa',
      UserStatus.fromEvent(
        _statusEvent(
          createdAt: 1000,
          extraTags: [
            ['expiration', '$past'],
          ],
        ),
      ),
    );

    // Storing an already-elapsed deadline arms a zero-duration timer, so the
    // status clears itself without waiting for the next refresh.
    await Future<void>.delayed(Duration.zero);
    expect(container.read(userStatusCacheProvider)['aa'], isNull);
  });

  test('cache keeps a status whose deadline has not arrived', () async {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final cache = container.read(userStatusCacheProvider.notifier);

    final future = DateTime.now().millisecondsSinceEpoch ~/ 1000 + 3600;
    cache.updateStatus(
      'aa',
      UserStatus.fromEvent(
        _statusEvent(
          createdAt: 1000,
          extraTags: [
            ['expiration', '$future'],
          ],
        ),
      ),
    );

    await Future<void>.delayed(Duration.zero);
    expect(container.read(userStatusCacheProvider)['aa'], isNotNull);
  });
}
