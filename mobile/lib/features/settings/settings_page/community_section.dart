part of '../settings_page.dart';

class _CommunitySection extends ConsumerWidget {
  const _CommunitySection({required this.invitePageBuilder});

  final WidgetBuilder invitePageBuilder;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final roleAsync = ref.watch(currentCommunityRoleProvider);
    // A failed role lookup keeps the row: the invite page re-checks and
    // explains itself, which beats hiding the entry point on a flaky query.
    if (!roleAsync.hasError && !canManageCommunityInvites(roleAsync.value)) {
      return const SizedBox.shrink();
    }

    return AppListCard(
      label: 'Community',
      children: [
        AppListRow(
          icon: LucideIcons.userPlus,
          title: 'Invite to community',
          trailing: const _RowChevron(),
          onTap: () => Navigator.of(
            context,
          ).push(MaterialPageRoute<void>(builder: invitePageBuilder)),
        ),
      ],
    );
  }
}
