import 'package:buzz/features/channels/emoji_picker.dart';
import 'package:buzz/features/channels/recent_emoji_provider.dart';
import 'package:buzz/shared/custom_emoji/custom_emoji.dart';
import 'package:buzz/shared/custom_emoji/custom_emoji_provider.dart';
import 'package:buzz/shared/emoji/emoji_data.dart';
import 'package:buzz/shared/emoji/emoji_data_provider.dart';
import 'package:buzz/shared/relay/relay.dart';
import 'package:buzz/shared/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../helpers/widget_helpers.dart';

EmojiEntry _entry(
  String id, {
  required String native,
  required String categoryId,
  String? name,
  List<String> keywords = const [],
}) => EmojiEntry(
  id: id,
  name: name ?? id,
  keywords: keywords,
  native: native,
  categoryId: categoryId,
);

/// A miniature stand-in for the generated asset — two categories so the rail
/// has something to switch between. `emoji_data_test.dart` covers the real one.
final _dataset = () {
  final people = [
    _entry('grinning', native: '\u{1F600}', categoryId: 'people'),
    _entry(
      'point_up',
      native: '\u{261D}\u{FE0F}',
      categoryId: 'people',
      name: 'Index Pointing Up',
    ),
  ];
  final nature = [
    _entry(
      'fire',
      native: '\u{1F525}',
      categoryId: 'nature',
      name: 'Fire',
      keywords: const ['flame'],
    ),
  ];
  final all = [...people, ...nature];
  return EmojiDataset(
    categories: [
      EmojiCategory(id: 'people', emoji: people),
      EmojiCategory(id: 'nature', emoji: nature),
    ],
    all: all,
    nativeToShortcode: {for (final entry in all) entry.native: ':${entry.id}:'},
  );
}();

const _customEmoji = [
  CustomEmoji(shortcode: 'partyparrot', url: 'https://example.test/parrot.gif'),
];

Future<SharedPreferences> _prefs() {
  SharedPreferences.setMockInitialValues({});
  return SharedPreferences.getInstance();
}

Future<List<String>> _pumpPicker(
  WidgetTester tester, {
  required SharedPreferences prefs,
  List<CustomEmoji> customEmoji = _customEmoji,
  EmojiDataset? dataset,
}) async {
  final selected = <String>[];
  await tester.pumpWidget(
    WidgetHelpers.testable(
      overrides: [
        savedPrefsProvider.overrideWithValue(prefs),
        myPubkeyProvider.overrideWithValue('self'),
        emojiDatasetOrEmptyProvider.overrideWithValue(dataset ?? _dataset),
        customEmojiListProvider.overrideWithValue(customEmoji),
      ],
      child: EmojiPickerSheet(onSelect: selected.add),
    ),
  );
  await tester.pumpAndSettle();
  return selected;
}

void main() {
  group('EmojiPickerSheet', () {
    testWidgets('opens on Frequently used, empty until something is picked', (
      tester,
    ) async {
      await _pumpPicker(tester, prefs: await _prefs());

      expect(find.text('Emoji you use will show up here.'), findsOneWidget);
      expect(find.byKey(const ValueKey('emoji-picker-grid')), findsNothing);
    });

    testWidgets('rail switches between the dataset categories', (tester) async {
      await _pumpPicker(tester, prefs: await _prefs());

      await tester.tap(find.byTooltip('Smileys & People'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('emoji-picker-grid')), findsOneWidget);
      expect(find.byKey(const ValueKey('emoji-tile-grinning')), findsOneWidget);
      expect(find.byKey(const ValueKey('emoji-tile-fire')), findsNothing);

      await tester.tap(find.byTooltip('Animals & Nature'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('emoji-tile-fire')), findsOneWidget);
      expect(find.byKey(const ValueKey('emoji-tile-grinning')), findsNothing);
    });

    testWidgets('custom tab only appears when the palette has emoji', (
      tester,
    ) async {
      await _pumpPicker(tester, prefs: await _prefs(), customEmoji: const []);
      expect(find.byTooltip('Custom'), findsNothing);

      await _pumpPicker(tester, prefs: await _prefs());
      await tester.tap(find.byTooltip('Custom'));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('emoji-picker-custom-grid')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('emoji-tile-custom-partyparrot')),
        findsOneWidget,
      );
    });

    testWidgets('typing filters across the standard and custom sets', (
      tester,
    ) async {
      await _pumpPicker(tester, prefs: await _prefs());

      await tester.enterText(
        find.byKey(const ValueKey('emoji-picker-search')),
        'flame',
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('emoji-picker-search-results')),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('emoji-tile-fire')), findsOneWidget);
      expect(find.byKey(const ValueKey('emoji-tile-grinning')), findsNothing);
      // Searching hides the rail — the query is the navigation.
      expect(find.byTooltip('Smileys & People'), findsNothing);

      // Custom emoji rank in the same query, in their own section.
      await tester.enterText(
        find.byKey(const ValueKey('emoji-picker-search')),
        'parrot',
      );
      await tester.pumpAndSettle();
      expect(find.text('Custom'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('emoji-tile-custom-partyparrot')),
        findsOneWidget,
      );
    });

    testWidgets('crosses the shortcode separator emoji-mart cannot', (
      tester,
    ) async {
      await _pumpPicker(tester, prefs: await _prefs());

      await tester.enterText(
        find.byKey(const ValueKey('emoji-picker-search')),
        'pointup',
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('emoji-tile-point_up')), findsOneWidget);
    });

    testWidgets('reports no results rather than an empty grid', (tester) async {
      await _pumpPicker(tester, prefs: await _prefs());

      await tester.enterText(
        find.byKey(const ValueKey('emoji-picker-search')),
        'zzzzzz',
      );
      await tester.pumpAndSettle();

      expect(find.text('No emoji found.'), findsOneWidget);
    });

    testWidgets('clear button restores browsing', (tester) async {
      await _pumpPicker(tester, prefs: await _prefs());

      await tester.enterText(
        find.byKey(const ValueKey('emoji-picker-search')),
        'fire',
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('emoji-picker-search-clear')));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('emoji-picker-search-results')),
        findsNothing,
      );
      expect(find.byTooltip('Smileys & People'), findsOneWidget);
    });

    testWidgets('a standard emoji emits its glyph', (tester) async {
      final selected = await _pumpPicker(tester, prefs: await _prefs());

      await tester.tap(find.byTooltip('Animals & Nature'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('emoji-tile-fire')));
      await tester.pumpAndSettle();

      expect(selected, ['\u{1F525}']);
    });

    testWidgets('a custom emoji emits :shortcode:', (tester) async {
      final selected = await _pumpPicker(tester, prefs: await _prefs());

      await tester.tap(find.byTooltip('Custom'));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('emoji-tile-custom-partyparrot')),
      );
      await tester.pumpAndSettle();

      expect(selected, [':partyparrot:']);
    });

    testWidgets('a selection lands in Frequently used', (tester) async {
      final prefs = await _prefs();
      await _pumpPicker(tester, prefs: prefs);

      await tester.tap(find.byTooltip('Animals & Nature'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('emoji-tile-fire')));
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('Frequently used'));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('emoji-picker-frequent-grid')),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('emoji-tile-fire')), findsOneWidget);
    });

    testWidgets('shows a spinner while the dataset is still loading', (
      tester,
    ) async {
      final prefs = await _prefs();
      await tester.pumpWidget(
        WidgetHelpers.testable(
          overrides: [
            savedPrefsProvider.overrideWithValue(prefs),
            myPubkeyProvider.overrideWithValue('self'),
            emojiDatasetOrEmptyProvider.overrideWithValue(EmojiDataset.empty),
            customEmojiListProvider.overrideWithValue(const []),
          ],
          child: EmojiPickerSheet(onSelect: (_) {}),
        ),
      );
      // Not pumpAndSettle — the spinner animates forever.
      await tester.pump();

      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    });
  });

  group('recent emoji ranking', () {
    test('promotes by use count, breaking ties on recency', () {
      var entries = <RecentEmojiEntry>[];
      entries = recordRecentEmoji(entries, 'a', now: 10);
      entries = recordRecentEmoji(entries, 'b', now: 20);
      entries = recordRecentEmoji(entries, 'b', now: 30);
      entries = recordRecentEmoji(entries, 'c', now: 40);

      expect(entries.map((entry) => entry.emoji), ['b', 'c', 'a']);
      expect(entries.first.count, 2);
    });

    test('tops the quick row up with the defaults', () {
      final entries = recordRecentEmoji(const [], '\u{1F525}', now: 1);
      final row = quickReactionEmoji(entries, customShortcodes: const {});

      expect(row.first, '\u{1F525}');
      expect(row, hasLength(4));
      expect(row, containsAll(defaultQuickEmojis.take(3)));
    });

    test('drops custom emoji no longer in the palette', () {
      final entries = recordRecentEmoji(const [], ':gone:', now: 1);

      expect(
        quickReactionEmoji(entries, customShortcodes: const {}),
        defaultQuickEmojis,
      );
      expect(
        quickReactionEmoji(entries, customShortcodes: const {'gone'}).first,
        ':gone:',
      );
    });
  });
}
