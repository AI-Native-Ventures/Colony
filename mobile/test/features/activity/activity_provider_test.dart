import 'dart:async';

import 'package:buzz/features/activity/activity_provider.dart';
import 'package:buzz/features/channels/channel.dart';
import 'package:buzz/features/channels/channels_provider.dart';
import 'package:buzz/shared/relay/relay.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

/// Records every DM history query (`#h` filter) so tests can assert whether
/// the DM source was fetched. All queries resolve to empty lists.
class _RecordingSessionNotifier extends RelaySessionNotifier {
  final List<List<String>> dmQueries = [];

  @override
  SessionState build() => const SessionState(status: SessionStatus.connected);

  @override
  Future<List<NostrEvent>> fetchHistory(
    NostrFilter filter, {
    Duration timeout = const Duration(seconds: 8),
  }) async {
    final h = filter.tags['#h'];
    if (h != null) dmQueries.add(h);
    return const [];
  }
}

/// Channels provider that starts loading and resolves on demand, modelling a
/// cold start where the channel list arrives after Activity's first fetch.
/// Records batched `/query` reads and lets a test fail them on demand.
class _BatchingSessionNotifier extends RelaySessionNotifier {
  _BatchingSessionNotifier({this.failBatch = false});

  final bool failBatch;
  final List<List<NostrFilter>> batchedQueries = [];
  final List<NostrFilter> fallbackQueries = [];

  @override
  SessionState build() => const SessionState(status: SessionStatus.connected);

  @override
  Future<List<NostrEvent>> queryRelay(
    List<NostrFilter> filters, {
    Duration timeout = const Duration(seconds: 8),
  }) async {
    batchedQueries.add(filters);
    if (failBatch) throw StateError('bridge unavailable');
    return const [];
  }

  @override
  Future<List<NostrEvent>> fetchHistory(
    NostrFilter filter, {
    Duration timeout = const Duration(seconds: 8),
  }) async {
    fallbackQueries.add(filter);
    return const [];
  }
}

class _LateChannelsNotifier extends ChannelsNotifier {
  final Completer<List<Channel>> _completer = Completer<List<Channel>>();

  @override
  Future<List<Channel>> build() => _completer.future;

  void resolve(List<Channel> channels) => _completer.complete(channels);
}

class _FixedRelayConfigNotifier extends RelayConfigNotifier {
  @override
  RelayConfig build() =>
      const RelayConfig(baseUrl: 'https://relay.example', nsec: null);
}

Channel _dmChannel(String id) => Channel(
  id: id,
  name: 'dm',
  channelType: 'dm',
  visibility: 'private',
  description: '',
  createdBy: 'x',
  createdAt: DateTime(2025),
  memberCount: 2,
  isMember: true,
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('refetches and includes DMs when channels resolve after first '
      'fetch (cold start)', () async {
    final session = _RecordingSessionNotifier();
    final channels = _LateChannelsNotifier();
    final container = ProviderContainer(
      overrides: [
        relayConfigProvider.overrideWith(_FixedRelayConfigNotifier.new),
        myPubkeyProvider.overrideWithValue('me_pk'),
        relaySessionProvider.overrideWith(() => session),
        channelsProvider.overrideWith(() => channels),
      ],
    );
    addTearDown(container.dispose);

    // Cold start: channels still loading, so the first fetch has no DM ids.
    await container.read(activityProvider.future);
    expect(session.dmQueries, isEmpty);

    // Channel list resolves with a DM → Activity must rebuild and query it.
    channels.resolve([_dmChannel('dm1')]);
    await container.read(channelsProvider.future);
    await container.read(activityProvider.future);

    expect(session.dmQueries, hasLength(1));
    expect(session.dmQueries.single, ['dm1']);
  });

  test('does not query DMs when the resolved channel list has none', () async {
    final session = _RecordingSessionNotifier();
    final channels = _LateChannelsNotifier();
    final container = ProviderContainer(
      overrides: [
        relayConfigProvider.overrideWith(_FixedRelayConfigNotifier.new),
        myPubkeyProvider.overrideWithValue('me_pk'),
        relaySessionProvider.overrideWith(() => session),
        channelsProvider.overrideWith(() => channels),
      ],
    );
    addTearDown(container.dispose);

    await container.read(activityProvider.future);
    channels.resolve(const []);
    await container.read(channelsProvider.future);
    await container.read(activityProvider.future);

    expect(session.dmQueries, isEmpty);
  });

  test('reads the whole feed in one batched query', () async {
    final session = _BatchingSessionNotifier();
    final channels = _LateChannelsNotifier();
    final container = ProviderContainer(
      overrides: [
        relayConfigProvider.overrideWith(_FixedRelayConfigNotifier.new),
        relaySessionProvider.overrideWith(() => session),
        myPubkeyProvider.overrideWithValue('me'),
        channelsProvider.overrideWith(() => channels),
      ],
    );
    addTearDown(container.dispose);

    channels.resolve([_dmChannel('dm-1')]);
    await container.read(channelsProvider.future);
    await container.read(activityProvider.future);

    // One request, not one per source.
    expect(session.batchedQueries, isNotEmpty);
    expect(session.batchedQueries.last, hasLength(4));
    expect(session.fallbackQueries, isEmpty);
  });

  test('falls back to per-filter history when the batch fails', () async {
    final session = _BatchingSessionNotifier(failBatch: true);
    final channels = _LateChannelsNotifier();
    final container = ProviderContainer(
      overrides: [
        relayConfigProvider.overrideWith(_FixedRelayConfigNotifier.new),
        relaySessionProvider.overrideWith(() => session),
        myPubkeyProvider.overrideWithValue('me'),
        channelsProvider.overrideWith(() => channels),
      ],
    );
    addTearDown(container.dispose);

    channels.resolve([_dmChannel('dm-1')]);
    await container.read(channelsProvider.future);
    await container.read(activityProvider.future);

    expect(session.batchedQueries, isNotEmpty);
    // Every filter is still read, so a bridge outage degrades rather than
    // blanking the feed.
    expect(session.fallbackQueries.length, session.batchedQueries.last.length);
  });
}
