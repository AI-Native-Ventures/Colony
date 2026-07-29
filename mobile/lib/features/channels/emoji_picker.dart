import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../shared/custom_emoji/custom_emoji.dart';
import '../../shared/custom_emoji/custom_emoji_provider.dart';
import '../../shared/custom_emoji/custom_emoji_render.dart';
import '../../shared/emoji/emoji_data.dart';
import '../../shared/emoji/emoji_data_provider.dart';
import '../../shared/emoji/emoji_search.dart';
import '../../shared/theme/theme.dart';
import 'recent_emoji_provider.dart';

part 'emoji_picker/search_field.dart';
part 'emoji_picker/category_rail.dart';
part 'emoji_picker/emoji_grid.dart';

/// Height of the picker sheet as a fraction of the screen. The full emoji set
/// is ~1.9k glyphs; the old fixed 340px sheet only ever showed a hand-picked
/// subset and had no room to browse.
const _sheetHeightFactor = 0.62;

/// Opens the full emoji picker as a modal bottom sheet.
///
/// [onSelect] receives a single string, normalized the same way desktop's
/// `EmojiPicker` normalizes its selection: a standard emoji emits its glyph, a
/// custom emoji emits `:shortcode:`. Callers store or send that string and let
/// the existing renderers resolve it.
void showEmojiPicker({
  required BuildContext context,
  required void Function(String emoji) onSelect,
}) {
  showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    backgroundColor: context.colors.surfaceContainerHighest,
    builder: (sheetContext) => EmojiPickerSheet(
      onSelect: (emoji) {
        Navigator.of(sheetContext).pop();
        onSelect(emoji);
      },
    ),
  );
}

/// Which tab of the picker is showing. Frequently-used and custom are pinned
/// either side of the dataset's own categories.
sealed class _PickerTab {
  const _PickerTab();
}

class _FrequentTab extends _PickerTab {
  const _FrequentTab();
}

class _CustomTab extends _PickerTab {
  const _CustomTab();
}

class _StandardTab extends _PickerTab {
  final int categoryIndex;

  const _StandardTab(this.categoryIndex);
}

class EmojiPickerSheet extends HookConsumerWidget {
  final void Function(String emoji) onSelect;

  const EmojiPickerSheet({super.key, required this.onSelect});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final dataset = ref.watch(emojiDatasetOrEmptyProvider);
    final customEmoji = ref.watch(customEmojiListProvider);
    final recent = ref.watch(recentEmojiProvider);

    final searchController = useTextEditingController();
    final query = useState('');
    useEffect(() {
      void onChanged() => query.value = searchController.text;
      searchController.addListener(onChanged);
      return () => searchController.removeListener(onChanged);
    }, [searchController]);

    final tab = useState<_PickerTab>(const _FrequentTab());
    final trimmedQuery = query.value.trim();
    final isSearching = trimmedQuery.isNotEmpty;

    void select(String emoji) {
      ref.read(recentEmojiProvider.notifier).record(emoji);
      onSelect(emoji);
    }

    // Recompute only when the query or the underlying sets change — scanning
    // ~1.9k entries per keystroke is sub-millisecond, but rebuilds are frequent
    // while the sheet animates.
    final results = useMemoized(
      () => isSearching
          ? searchEmoji(trimmedQuery, dataset.all)
          : const <EmojiEntry>[],
      [trimmedQuery, dataset],
    );
    final customResults = useMemoized(
      () => isSearching
          ? rankByShortcode(
              trimmedQuery,
              customEmoji,
              (emoji) => emoji.shortcode,
            )
          : const <CustomEmoji>[],
      [trimmedQuery, customEmoji],
    );

    return SizedBox(
      height: MediaQuery.sizeOf(context).height * _sheetHeightFactor,
      child: Column(
        children: [
          _EmojiSearchField(controller: searchController),
          if (!isSearching)
            _CategoryRail(
              dataset: dataset,
              hasCustomEmoji: customEmoji.isNotEmpty,
              selected: tab.value,
              onSelect: (next) => tab.value = next,
            ),
          Divider(height: 1, color: context.colors.outlineVariant),
          Expanded(
            child: dataset.isEmpty && customEmoji.isEmpty
                ? const Center(child: CircularProgressIndicator())
                : isSearching
                ? _EmojiSearchResults(
                    entries: results,
                    customEmoji: customResults,
                    onSelect: select,
                  )
                : switch (tab.value) {
                    _FrequentTab() => _FrequentGrid(
                      recent: recent,
                      customEmoji: customEmoji,
                      onSelect: select,
                    ),
                    _CustomTab() => _CustomEmojiGrid(
                      emoji: customEmoji,
                      onSelect: select,
                    ),
                    _StandardTab(:final categoryIndex) => _EmojiGrid(
                      // A community can drop its last custom emoji while the
                      // sheet is open, shrinking the rail under the selection.
                      entries: categoryIndex < dataset.categories.length
                          ? dataset.categories[categoryIndex].emoji
                          : const [],
                      onSelect: select,
                    ),
                  },
          ),
        ],
      ),
    );
  }
}
