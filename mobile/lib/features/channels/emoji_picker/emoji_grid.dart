part of '../emoji_picker.dart';

/// Emoji per row. Matches desktop's `perLine={8}`.
const _emojiPerLine = 8;

/// Custom emoji are images rather than glyphs and read better a little larger,
/// so they get their own (looser) grid — same as the old picker did.
const _customEmojiPerLine = 6;

const _emojiGlyphSize = 28.0;
const _customEmojiSize = 32.0;

/// Shared grid delegate so every tab lays out identically.
SliverGridDelegate _gridDelegate({required int perLine}) {
  return SliverGridDelegateWithFixedCrossAxisCount(
    crossAxisCount: perLine,
    mainAxisSpacing: Grid.half,
    crossAxisSpacing: Grid.half,
  );
}

EdgeInsets _gridPadding(BuildContext context) => EdgeInsets.only(
  left: Grid.gutter,
  right: Grid.gutter,
  top: Grid.xxs,
  // Clear the home indicator so the last row isn't half-swallowed.
  bottom: MediaQuery.viewPaddingOf(context).bottom + Grid.xxs,
);

/// One tappable standard emoji.
class _EmojiTile extends StatelessWidget {
  final EmojiEntry entry;
  final VoidCallback onTap;

  const _EmojiTile({required this.entry, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      key: ValueKey('emoji-tile-${entry.id}'),
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Semantics(
        button: true,
        label: entry.name,
        child: Center(
          child: Text(
            entry.native,
            style: const TextStyle(fontSize: _emojiGlyphSize),
          ),
        ),
      ),
    );
  }
}

/// One tappable custom (image) emoji.
class _CustomEmojiTile extends StatelessWidget {
  final CustomEmoji emoji;
  final VoidCallback onTap;

  const _CustomEmojiTile({required this.emoji, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      key: ValueKey('emoji-tile-custom-${emoji.shortcode}'),
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Tooltip(
        message: ':${emoji.shortcode}:',
        child: Center(
          child: CustomEmojiImage(
            shortcode: emoji.shortcode,
            url: emoji.url,
            size: _customEmojiSize,
          ),
        ),
      ),
    );
  }
}

/// A flat grid of standard emoji — one dataset category.
class _EmojiGrid extends StatelessWidget {
  final List<EmojiEntry> entries;
  final void Function(String emoji) onSelect;

  const _EmojiGrid({required this.entries, required this.onSelect});

  @override
  Widget build(BuildContext context) {
    return GridView.builder(
      key: const ValueKey('emoji-picker-grid'),
      padding: _gridPadding(context),
      gridDelegate: _gridDelegate(perLine: _emojiPerLine),
      itemCount: entries.length,
      itemBuilder: (context, index) {
        final entry = entries[index];
        return _EmojiTile(entry: entry, onTap: () => onSelect(entry.native));
      },
    );
  }
}

/// The community's custom-emoji palette.
class _CustomEmojiGrid extends StatelessWidget {
  final List<CustomEmoji> emoji;
  final void Function(String emoji) onSelect;

  const _CustomEmojiGrid({required this.emoji, required this.onSelect});

  @override
  Widget build(BuildContext context) {
    return GridView.builder(
      key: const ValueKey('emoji-picker-custom-grid'),
      padding: _gridPadding(context),
      gridDelegate: _gridDelegate(perLine: _customEmojiPerLine),
      itemCount: emoji.length,
      itemBuilder: (context, index) {
        final entry = emoji[index];
        return _CustomEmojiTile(
          emoji: entry,
          onTap: () => onSelect(':${entry.shortcode}:'),
        );
      },
    );
  }
}

/// Frequently-used tab: the user's ranked history, resolved back to renderable
/// tiles. Entries are stored as the selected string, so a standard emoji is a
/// glyph and a custom one is `:shortcode:` — resolve each against the dataset
/// and the palette, and drop anything that no longer exists (a custom emoji
/// removed from the community would otherwise render as literal text).
class _FrequentGrid extends HookConsumerWidget {
  final List<RecentEmojiEntry> recent;
  final List<CustomEmoji> customEmoji;
  final void Function(String emoji) onSelect;

  const _FrequentGrid({
    required this.recent,
    required this.customEmoji,
    required this.onSelect,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final dataset = ref.watch(emojiDatasetOrEmptyProvider);
    final customByShortcode = {
      for (final emoji in customEmoji) emoji.shortcode.toLowerCase(): emoji,
    };
    final entriesById = {for (final entry in dataset.all) entry.id: entry};

    final tiles = <Widget>[];
    for (final item in recent) {
      final value = item.emoji;
      if (value.startsWith(':') && value.endsWith(':')) {
        final custom =
            customByShortcode[value
                .substring(1, value.length - 1)
                .toLowerCase()];
        if (custom == null) continue;
        tiles.add(
          _CustomEmojiTile(emoji: custom, onTap: () => onSelect(value)),
        );
        continue;
      }
      final shortcode = dataset.nativeToShortcode[value];
      final entry = shortcode == null
          ? null
          : entriesById[shortcode.substring(1, shortcode.length - 1)];
      if (entry == null) continue;
      tiles.add(_EmojiTile(entry: entry, onTap: () => onSelect(entry.native)));
    }

    if (tiles.isEmpty) {
      return _EmojiEmptyState(
        icon: LucideIcons.clock,
        message: 'Emoji you use will show up here.',
      );
    }

    return GridView.builder(
      key: const ValueKey('emoji-picker-frequent-grid'),
      padding: _gridPadding(context),
      gridDelegate: _gridDelegate(perLine: _emojiPerLine),
      itemCount: tiles.length,
      itemBuilder: (context, index) => tiles[index],
    );
  }
}

/// Search results: custom emoji first (a community's own emoji are the ones a
/// user is most likely hunting for by name), then the standard set.
class _EmojiSearchResults extends StatelessWidget {
  final List<EmojiEntry> entries;
  final List<CustomEmoji> customEmoji;
  final void Function(String emoji) onSelect;

  const _EmojiSearchResults({
    required this.entries,
    required this.customEmoji,
    required this.onSelect,
  });

  @override
  Widget build(BuildContext context) {
    if (entries.isEmpty && customEmoji.isEmpty) {
      return _EmojiEmptyState(
        icon: LucideIcons.searchX,
        message: 'No emoji found.',
      );
    }

    return CustomScrollView(
      key: const ValueKey('emoji-picker-search-results'),
      slivers: [
        if (customEmoji.isNotEmpty) ...[
          const _SectionHeader(label: 'Custom'),
          SliverPadding(
            padding: EdgeInsets.symmetric(horizontal: Grid.gutter),
            sliver: SliverGrid.builder(
              gridDelegate: _gridDelegate(perLine: _customEmojiPerLine),
              itemCount: customEmoji.length,
              itemBuilder: (context, index) {
                final entry = customEmoji[index];
                return _CustomEmojiTile(
                  emoji: entry,
                  onTap: () => onSelect(':${entry.shortcode}:'),
                );
              },
            ),
          ),
        ],
        if (entries.isNotEmpty) ...[
          if (customEmoji.isNotEmpty) const _SectionHeader(label: 'Emoji'),
          SliverPadding(
            padding: EdgeInsets.only(
              left: Grid.gutter,
              right: Grid.gutter,
              top: Grid.xxs,
              bottom: MediaQuery.viewPaddingOf(context).bottom + Grid.xxs,
            ),
            sliver: SliverGrid.builder(
              gridDelegate: _gridDelegate(perLine: _emojiPerLine),
              itemCount: entries.length,
              itemBuilder: (context, index) {
                final entry = entries[index];
                return _EmojiTile(
                  entry: entry,
                  onTap: () => onSelect(entry.native),
                );
              },
            ),
          ),
        ],
      ],
    );
  }
}

class _SectionHeader extends StatelessWidget {
  final String label;

  const _SectionHeader({required this.label});

  @override
  Widget build(BuildContext context) {
    return SliverToBoxAdapter(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          Grid.gutter,
          Grid.xxs,
          Grid.gutter,
          Grid.half,
        ),
        child: Text(
          label,
          style: context.textTheme.labelMedium?.copyWith(
            color: context.colors.onSurfaceVariant,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
    );
  }
}

class _EmojiEmptyState extends StatelessWidget {
  final IconData icon;
  final String message;

  const _EmojiEmptyState({required this.icon, required this.message});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: Grid.md, color: context.colors.onSurfaceVariant),
          const SizedBox(height: Grid.xxs),
          Text(
            message,
            style: context.textTheme.bodySmall?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}
