part of '../emoji_picker.dart';

/// Rail icon for each emoji-mart category. Ids come from the dataset, so this
/// map is keyed on emoji-mart's own category ids.
IconData _categoryIcon(String categoryId) => switch (categoryId) {
  'people' => LucideIcons.smile,
  'nature' => LucideIcons.leaf,
  'foods' => LucideIcons.coffee,
  'activity' => LucideIcons.volleyball,
  'places' => LucideIcons.plane,
  'objects' => LucideIcons.lightbulb,
  'symbols' => LucideIcons.heart,
  'flags' => LucideIcons.flag,
  _ => LucideIcons.layoutGrid,
};

/// Horizontal category selector: Frequently-used, then the dataset's eight
/// categories in emoji-mart order, then the community's custom emoji.
class _CategoryRail extends StatelessWidget {
  final EmojiDataset dataset;
  final bool hasCustomEmoji;
  final _PickerTab selected;
  final ValueChanged<_PickerTab> onSelect;

  const _CategoryRail({
    required this.dataset,
    required this.hasCustomEmoji,
    required this.selected,
    required this.onSelect,
  });

  @override
  Widget build(BuildContext context) {
    // Local binding so the pattern match promotes — a public final field
    // doesn't.
    final current = selected;
    return SizedBox(
      height: Grid.lg,
      // Ten-plus tabs don't fit a phone width; scroll rather than shrink the
      // targets below a comfortable tap size.
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: Grid.twelve),
        children: [
          _CategoryIcon(
            icon: LucideIcons.clock,
            tooltip: 'Frequently used',
            selected: current is _FrequentTab,
            onTap: () => onSelect(const _FrequentTab()),
          ),
          for (var i = 0; i < dataset.categories.length; i++)
            _CategoryIcon(
              icon: _categoryIcon(dataset.categories[i].id),
              tooltip: dataset.categories[i].label,
              selected: current is _StandardTab && current.categoryIndex == i,
              onTap: () => onSelect(_StandardTab(i)),
            ),
          if (hasCustomEmoji)
            _CategoryIcon(
              icon: LucideIcons.sparkles,
              tooltip: 'Custom',
              selected: current is _CustomTab,
              onTap: () => onSelect(const _CustomTab()),
            ),
        ],
      ),
    );
  }
}

class _CategoryIcon extends StatelessWidget {
  final IconData icon;
  final String tooltip;
  final bool selected;
  final VoidCallback onTap;

  const _CategoryIcon({
    required this.icon,
    required this.tooltip,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return SizedBox(
      width: Grid.lg,
      height: Grid.lg,
      child: IconButton(
        onPressed: onTap,
        tooltip: tooltip,
        icon: Icon(
          icon,
          size: 18,
          color: selected ? colors.primary : colors.onSurfaceVariant,
        ),
        padding: EdgeInsets.zero,
        visualDensity: VisualDensity.compact,
      ),
    );
  }
}
