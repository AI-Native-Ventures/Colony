import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../shared/theme/theme.dart';

/// Desktop-parity day separator with a centered label over a horizontal rule.
class DayDivider extends StatelessWidget {
  final String label;

  /// Identifies this day so a sticky header can say it is covering it.
  final int? dayTimestamp;

  /// The day currently pinned by the sticky header, when one is shown.
  final ValueListenable<int?>? stickyDayTimestamp;

  const DayDivider({
    super.key,
    required this.label,
    this.dayTimestamp,
    this.stickyDayTimestamp,
  });

  @override
  Widget build(BuildContext context) {
    final activeTimestamp = stickyDayTimestamp;
    final timestamp = dayTimestamp;
    if (activeTimestamp == null || timestamp == null) {
      return _buildDivider(context, isSticky: false);
    }
    return ValueListenableBuilder<int?>(
      valueListenable: activeTimestamp,
      builder: (context, activeDayTimestamp, _) =>
          _buildDivider(context, isSticky: activeDayTimestamp == timestamp),
    );
  }

  /// Colony's rule-and-capsule treatment, faded out while the sticky header
  /// is showing this same date so the two do not read as duplicates.
  Widget _buildDivider(BuildContext context, {required bool isSticky}) {
    return ExcludeSemantics(
      excluding: isSticky,
      child: AnimatedOpacity(
        key: dayTimestamp == null
            ? null
            : ValueKey('channel-day-divider-opacity-$dayTimestamp'),
        duration: MediaQuery.disableAnimationsOf(context)
            ? Duration.zero
            : const Duration(milliseconds: 120),
        curve: Curves.easeOutCubic,
        opacity: isSticky ? 0 : 1,
        child: _buildContent(context),
      ),
    );
  }

  Widget _buildContent(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Grid.xxs),
      child: SizedBox(
        width: double.infinity,
        child: Stack(
          alignment: Alignment.center,
          children: [
            Positioned(
              left: 0,
              right: 0,
              child: Divider(
                height: 1,
                thickness: 1,
                color: context.colors.outlineVariant.withValues(alpha: 0.35),
              ),
            ),
            Container(
              padding: const EdgeInsets.symmetric(
                horizontal: Grid.xxs + Grid.quarter,
                vertical: Grid.half,
              ),
              decoration: BoxDecoration(
                color: context.colors.surface,
                borderRadius: BorderRadius.circular(Radii.dialog),
                border: Border.all(
                  color: context.colors.outlineVariant.withValues(alpha: 0.7),
                ),
              ),
              child: Text(
                label,
                style: context.textTheme.labelSmall?.copyWith(
                  color: context.colors.onSurfaceVariant.withValues(alpha: 0.7),
                  letterSpacing: 0.22,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
