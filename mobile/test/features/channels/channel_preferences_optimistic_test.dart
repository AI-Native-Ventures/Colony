import 'package:buzz/features/channels/channel_mutes/channel_mutes_manager.dart';
import 'package:buzz/features/channels/channel_stars/channel_stars_manager.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nostr/nostr.dart' as nostr;
import 'package:shared_preferences/shared_preferences.dart';

const _channelId = '11111111-1111-4111-8111-111111111111';
const _pubkey =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
final _nsec = nostr.Keys.generate().nsec;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late SharedPreferences prefs;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    prefs = await SharedPreferences.getInstance();
  });

  group('stars', () {
    ChannelStarsManager buildManager(void Function() onChanged) =>
        ChannelStarsManager(
          pubkey: _pubkey,
          prefs: prefs,
          crypto: ChannelStarsCrypto(_nsec, _pubkey),
          relaySession: null,
          signedEventRelay: null,
          // Remote publishing is debounced by five seconds; the point of these
          // tests is that the UI does not wait for it.
          remoteEnabled: false,
          onChanged: onChanged,
        );

    test('starring notifies immediately', () {
      var notifications = 0;
      final manager = buildManager(() => notifications++);
      addTearDown(manager.dispose);
      final before = notifications;

      manager.starChannel(_channelId);

      expect(notifications, greaterThan(before));
      expect(manager.store.channels[_channelId]?.starred, isTrue);
    });

    test('unstarring notifies immediately', () {
      var notifications = 0;
      final manager = buildManager(() => notifications++);
      addTearDown(manager.dispose);
      manager.starChannel(_channelId);
      final before = notifications;

      manager.unstarChannel(_channelId);

      expect(notifications, greaterThan(before));
      expect(manager.store.channels[_channelId]?.starred, isFalse);
    });
  });

  group('mutes', () {
    ChannelMutesManager buildManager(void Function() onChanged) =>
        ChannelMutesManager(
          pubkey: _pubkey,
          prefs: prefs,
          crypto: ChannelMutesCrypto(_nsec, _pubkey),
          relaySession: null,
          signedEventRelay: null,
          remoteEnabled: false,
          onChanged: onChanged,
        );

    test('muting notifies immediately', () {
      var notifications = 0;
      final manager = buildManager(() => notifications++);
      addTearDown(manager.dispose);
      final before = notifications;

      manager.muteChannel(_channelId);

      expect(notifications, greaterThan(before));
      expect(manager.store.channels[_channelId]?.muted, isTrue);
    });

    test('unmuting notifies immediately', () {
      var notifications = 0;
      final manager = buildManager(() => notifications++);
      addTearDown(manager.dispose);
      manager.muteChannel(_channelId);
      final before = notifications;

      manager.unmuteChannel(_channelId);

      expect(notifications, greaterThan(before));
      expect(manager.store.channels[_channelId]?.muted, isFalse);
    });
  });
}
