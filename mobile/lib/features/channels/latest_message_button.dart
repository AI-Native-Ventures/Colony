import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../shared/theme/theme.dart';

/// Shared channel/thread control for returning to the newest message.
///
/// Extracted from the channel timeline so threads present the same control
/// rather than a second one that drifts. The treatment is Colony's existing
/// channel button; upstream restyles this as a blurred glass pill, which is a
/// separate design change.
class LatestMessageButton extends StatelessWidget {
  /// Returns the message list to its newest item.
  final VoidCallback onPressed;

  const LatestMessageButton({required this.onPressed, super.key});

  @override
  Widget build(BuildContext context) {
    return FilledButton.icon(
      onPressed: onPressed,
      style: FilledButton.styleFrom(
        backgroundColor: context.colors.primaryContainer,
        foregroundColor: context.colors.onPrimaryContainer,
        padding: const EdgeInsets.symmetric(
          horizontal: Grid.gutter,
          vertical: Grid.xxs,
        ),
      ),
      icon: const Icon(LucideIcons.arrowDown, size: 16),
      label: const Text('Latest'),
    );
  }
}
