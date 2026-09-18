import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../shared/animated_avatar.dart';
import '../../shared/custom_emoji/custom_emoji_provider.dart';
import '../../shared/custom_emoji/custom_emoji_render.dart';
import '../../shared/theme/theme.dart';
import '../../shared/widgets/avatar_image.dart';
import '../../shared/widgets/masked_avatar_badge.dart';
import '../../shared/widgets/progressive_animated_avatar.dart';
import 'profile_provider.dart';
import 'set_status_sheet.dart';
import 'user_status_provider.dart';

/// Desktop's settings-avatar treatment (`ProfileSettingsCard`): a large centred
/// avatar with a circular badge notched out of its bottom-right corner. Desktop
/// puts an edit-photo pencil in that badge; here it carries the status glyph and
/// opens the status sheet instead. The notch shape — including the fillets where
/// it meets the avatar's edge — comes from [AvatarBadgeMaskGeometry.badge].
class SettingsProfileHeader extends HookConsumerWidget {
  const SettingsProfileHeader({super.key});

  static const _avatarSize = 128.0;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profile = ref.watch(profileProvider).asData?.value;
    final status = ref.watch(userStatusProvider).asData?.value;
    final hasStatus = status != null && !status.isEmpty;
    final animatedAvatar = parseAnimatedAvatarUrl(profile?.avatarUrl);
    // Null while animating: the animation widget owns rendering then.
    final stoppedAnimationUrl = useState<String?>(null);
    final avatarUrl = animatedAvatar == null
        ? profile?.avatarUrl
        : stoppedAnimationUrl.value == animatedAvatar.animationUrl
        ? animatedAvatar.posterUrl
        : null;

    void openStatusSheet() =>
        showSetStatusSheet(context, currentStatus: status);

    return Padding(
      padding: const EdgeInsets.only(top: Grid.xxs, bottom: Grid.sm),
      child: Column(
        children: [
          MaskedAvatarBadge(
            size: _avatarSize,
            avatar: GestureDetector(
              key: const ValueKey('settings-profile-avatar'),
              onTap: animatedAvatar == null
                  ? null
                  : () => stoppedAnimationUrl.value =
                        stoppedAnimationUrl.value == animatedAvatar.animationUrl
                        ? null
                        : animatedAvatar.animationUrl,
              child: ColoredBox(
                key: const ValueKey('settings-profile-avatar-background'),
                color: animatedAvatar == null
                    ? context.colors.primaryContainer
                    : Colors.transparent,
                child:
                    animatedAvatar != null &&
                        stoppedAnimationUrl.value != animatedAvatar.animationUrl
                    ? ProgressiveAnimatedAvatar(
                        key: ValueKey(animatedAvatar.animationUrl),
                        descriptor: animatedAvatar,
                        fallback: _AvatarFallback(initial: profile?.initial),
                      )
                    : AvatarImageContent(
                        imageUrl: avatarUrl,
                        fallback: _AvatarFallback(initial: profile?.initial),
                      ),
              ),
            ),
            badge: _StatusBadge(
              emoji: status?.emoji ?? '',
              onTap: openStatusSheet,
            ),
          ),
          const SizedBox(height: Grid.twelve),
          Text(
            profile?.label ?? 'Your profile',
            style: context.textTheme.titleMedium,
            textAlign: TextAlign.center,
          ),
          // No placeholder copy — the badge is the affordance, so this line
          // appears only once there is an actual status to show.
          if (hasStatus)
            GestureDetector(
              onTap: openStatusSheet,
              child: Padding(
                padding: const EdgeInsets.only(
                  top: Grid.quarter,
                  left: Grid.gutter,
                  right: Grid.gutter,
                  bottom: Grid.half,
                ),
                child: Text(
                  status.text.isNotEmpty ? status.text : status.emoji,
                  style: context.textTheme.bodySmall?.copyWith(
                    color: context.colors.onSurfaceVariant,
                  ),
                  textAlign: TextAlign.center,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// Fills the notch left by [MaskedAvatarBadge], so its size comes from the mask
/// geometry rather than being set here.
class _AvatarFallback extends StatelessWidget {
  const _AvatarFallback({required this.initial});

  final String? initial;

  @override
  Widget build(BuildContext context) {
    return Text(
      initial ?? '?',
      style: context.textTheme.displaySmall?.copyWith(
        color: context.colors.onPrimaryContainer,
      ),
    );
  }
}

class _StatusBadge extends StatelessWidget {
  const _StatusBadge({required this.emoji, required this.onTap});

  final String emoji;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: 'Set a status',
      child: GestureDetector(
        onTap: onTap,
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: context.colors.surfaceContainerHighest,
            shape: BoxShape.circle,
          ),
          child: Center(child: _StatusGlyph(emoji: emoji)),
        ),
      ),
    );
  }
}

/// The status emoji, resolving `:shortcode:` values against the community's
/// custom emoji. Falls back to the add-status icon when no status is set.
class _StatusGlyph extends ConsumerWidget {
  const _StatusGlyph({required this.emoji});

  final String emoji;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (emoji.isEmpty) {
      return Icon(
        LucideIcons.smilePlus,
        size: 20,
        color: context.colors.onSurfaceVariant,
      );
    }

    final shortcode = emoji.startsWith(':') && emoji.endsWith(':')
        ? emoji.substring(1, emoji.length - 1).toLowerCase()
        : null;
    if (shortcode != null) {
      for (final entry in ref.watch(customEmojiListProvider)) {
        if (entry.shortcode == shortcode) {
          return CustomEmojiImage(
            shortcode: shortcode,
            url: entry.url,
            size: 22,
          );
        }
      }
      return Icon(
        LucideIcons.smile,
        size: 20,
        color: context.colors.onSurfaceVariant,
      );
    }

    return Text(emoji, style: const TextStyle(fontSize: 20));
  }
}
