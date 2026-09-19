part of '../channel_detail_page.dart';

/// Avatar size for the two-line channel header.
const _channelHeaderAvatarSize = 40.0;

/// A two-person DM has no membership to manage, so the Members action is
/// hidden there and kept for group DMs and ordinary channels.
bool _showsMembersAction(Channel channel) {
  if (!channel.isDm) return true;
  final participants = channel.participantPubkeys
      .map((pubkey) => pubkey.toLowerCase())
      .toSet();
  return participants.length != 2;
}

double _scaledTextHeight(BuildContext context, TextStyle style) {
  final scaledFontSize = MediaQuery.textScalerOf(
    context,
  ).scale(style.fontSize ?? 0);
  return scaledFontSize * (style.height ?? 1);
}

/// Height of a two-line app-bar title: a DM's name over its presence line, or
/// a channel's name over its member count.
///
/// The DM branch keeps Colony's existing type and 30dp floor unchanged; only
/// the channel branch is new, so adding the member count does not restyle
/// headers that already worked.
double _twoLineAppBarTitleContentHeight(
  BuildContext context, {
  required bool isDm,
}) {
  const dmFloor = 30.0;
  final titleStyle = isDm
      ? channelTitleTextStyle
      : context.textTheme.titleMedium;
  final subtitleStyle = context.textTheme.bodySmall;
  final floor = isDm ? dmFloor : _channelHeaderAvatarSize;
  if (titleStyle == null || subtitleStyle == null) {
    return floor;
  }
  final textHeight =
      _scaledTextHeight(context, titleStyle) +
      _scaledTextHeight(context, subtitleStyle);
  return textHeight > floor ? textHeight : floor;
}

/// Channel name over its member count, tapping through to channel settings.
///
/// Replaces a name-only header: the member count is information the header did
/// not carry before, and the whole row becomes the settings affordance.
class _ChannelAppBarTitle extends ConsumerWidget {
  const _ChannelAppBarTitle({required this.channel, required this.onTap});

  final Channel channel;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final membersAsync = ref.watch(channelMembersProvider(channel.id));
    // Fall back to the channel's own count until the member list resolves, so
    // the second line never flashes empty.
    final memberCount = membersAsync.value?.length ?? channel.memberCount;
    final memberLabel =
        '$memberCount ${memberCount == 1 ? 'member' : 'members'}';

    return Semantics(
      button: true,
      label: 'Open settings for ${channel.name}, $memberLabel',
      child: Tooltip(
        message: 'Open channel settings',
        child: InkWell(
          key: const ValueKey('channel-header-settings-trigger'),
          borderRadius: BorderRadius.circular(Radii.md),
          onTap: onTap,
          child: Row(
            children: [
              Container(
                key: const ValueKey('channel-header-avatar'),
                width: _channelHeaderAvatarSize,
                height: _channelHeaderAvatarSize,
                decoration: BoxDecoration(
                  color: context.colors.primaryContainer,
                  shape: BoxShape.circle,
                ),
                child: Icon(
                  channelIcon(channel),
                  size: 20,
                  color: context.colors.onPrimaryContainer,
                ),
              ),
              const SizedBox(width: Grid.xxs),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Flexible(
                          child: Text(
                            channel.name,
                            key: const ValueKey('channel-header-name'),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: context.textTheme.titleMedium,
                          ),
                        ),
                        if (channel.isEphemeral) ...[
                          const SizedBox(width: Grid.quarter),
                          _HeaderEphemeralBadge(channel: channel),
                        ],
                      ],
                    ),
                    Text(
                      memberLabel,
                      key: const ValueKey('channel-header-member-count'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: context.textTheme.bodySmall?.copyWith(
                        color: context.colors.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _MembersButton extends ConsumerWidget {
  final String channelId;
  final Channel channel;
  final String? currentPubkey;

  const _MembersButton({
    required this.channelId,
    required this.channel,
    required this.currentPubkey,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hasWorkingBot = ref
        .watch(workingBotPubkeysProvider(channelId))
        .isNotEmpty;

    return IconButton(
      color: context.colors.primary,
      onPressed: () {
        showModalBottomSheet<void>(
          context: context,
          isScrollControlled: true,
          showDragHandle: true,
          builder: (_) =>
              MembersSheet(channel: channel, currentPubkey: currentPubkey),
        );
      },
      tooltip: 'View members',
      icon: Stack(
        clipBehavior: Clip.none,
        children: [
          const Icon(LucideIcons.users, size: 22),
          if (hasWorkingBot)
            Positioned(
              top: -2,
              right: -2,
              child: Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(
                  color: context.appColors.success,
                  shape: BoxShape.circle,
                  border: Border.all(color: context.colors.surface, width: 1.5),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _DmAppBarTitle extends ConsumerWidget {
  final Channel channel;
  final String? currentPubkey;

  const _DmAppBarTitle({required this.channel, required this.currentPubkey});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profiles = ref.watch(userCacheProvider);
    final presenceMap = ref.watch(presenceCacheProvider);
    final normalizedCurrent = currentPubkey?.toLowerCase();

    String? otherPubkey;
    for (final pk in channel.participantPubkeys) {
      if (pk.toLowerCase() != normalizedCurrent) {
        otherPubkey = pk.toLowerCase();
        break;
      }
    }

    final profile = otherPubkey != null ? profiles[otherPubkey] : null;

    if (otherPubkey != null) {
      if (profile == null) {
        ref.read(userCacheProvider.notifier).preload([otherPubkey]);
      }
      ref.read(presenceCacheProvider.notifier).track([otherPubkey]);
    }

    final avatarUrl = profile?.avatarUrl;
    final initial =
        profile?.initial ??
        (channel.participants.isNotEmpty
            ? channel.participants.first[0].toUpperCase()
            : '?');
    final presence = otherPubkey != null
        ? (presenceMap[otherPubkey] ?? 'offline')
        : 'offline';
    final presenceLabel = switch (presence) {
      'online' => 'Online',
      'away' => 'Away',
      _ => 'Offline',
    };

    return Row(
      children: [
        SizedBox(
          width: 30,
          height: 30,
          child: Stack(
            clipBehavior: Clip.none,
            children: [
              AvatarImage(
                imageUrl: avatarUrl,
                radius: 14,
                backgroundColor: context.colors.primaryContainer,
                fallback: Text(
                  initial,
                  style: context.textTheme.labelSmall?.copyWith(
                    color: context.colors.onPrimaryContainer,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              Positioned(
                right: -1,
                bottom: -1,
                child: Container(
                  width: 10,
                  height: 10,
                  decoration: BoxDecoration(
                    color: switch (presence) {
                      'online' => context.appColors.success,
                      'away' => context.appColors.warning,
                      _ => context.colors.outline,
                    },
                    shape: BoxShape.circle,
                    border: Border.all(
                      color: context.colors.surface,
                      width: 1.5,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(width: Grid.xxs),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Flexible(
                    child: Text(
                      resolveDmChannelDisplayLabel(
                        channel,
                        currentPubkey: currentPubkey,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: channelTitleTextStyle,
                    ),
                  ),
                  if (channel.isEphemeral) ...[
                    const SizedBox(width: Grid.quarter),
                    _HeaderEphemeralBadge(channel: channel),
                  ],
                ],
              ),
              Text(
                presenceLabel,
                style: context.textTheme.bodySmall?.copyWith(
                  color: context.colors.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
