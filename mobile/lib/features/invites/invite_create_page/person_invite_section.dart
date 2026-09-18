part of '../invite_create_page.dart';

class _PersonInviteSection extends HookConsumerWidget {
  const _PersonInviteSection({required this.role});

  final CommunityMemberRole role;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final searchController = useTextEditingController();
    final searchFocusNode = useFocusNode();
    final candidatePubkey = useState<String?>(null);
    final selectedRole = useState(CommunityMemberRole.member);
    final isSubmitting = useState(false);
    final submitError = useState<String?>(null);

    final membership = ref.watch(communityMembershipProvider).asData?.value;
    final existingMemberPubkeys = {
      ...?membership?.pubkeys.map((pubkey) => pubkey.toLowerCase()),
    };
    final currentPubkey = ref.watch(myPubkeyProvider)?.toLowerCase();

    void selectCandidate(String pubkey) {
      final normalized = pubkey.toLowerCase();
      if (normalized == currentPubkey) {
        candidatePubkey.value = null;
        submitError.value = 'You cannot invite yourself.';
        return;
      }
      if (existingMemberPubkeys.contains(normalized)) {
        candidatePubkey.value = null;
        submitError.value = 'This person is already in the community.';
        return;
      }
      candidatePubkey.value = normalized;
      submitError.value = null;
    }

    void handleInput(String value) {
      submitError.value = null;
      final pubkey = parseCommunityInvitePubkey(value);
      if (pubkey == null) {
        candidatePubkey.value = null;
      } else {
        selectCandidate(pubkey);
      }
    }

    Future<void> submit(CommunityInviteRecipient invitee) async {
      if (isSubmitting.value) return;
      isSubmitting.value = true;
      submitError.value = null;
      try {
        await ref
            .read(communityInviteActionsProvider)
            .inviteMembers(
              pubkeys: [invitee.pubkey],
              // Only an owner may grant admin; the relay refuses it from an
              // admin, so the client never offers the choice.
              role: role == CommunityMemberRole.owner
                  ? selectedRole.value
                  : CommunityMemberRole.member,
            );
        if (!context.mounted) return;
        candidatePubkey.value = null;
        searchController.clear();
        ref.invalidate(communityMembershipProvider);
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Invited to the community')),
        );
      } catch (error) {
        if (context.mounted) {
          submitError.value = _inviteErrorMessage(error);
        }
      } finally {
        if (context.mounted) {
          isSubmitting.value = false;
        }
      }
    }

    final pubkey = candidatePubkey.value;
    final profileAsync = pubkey == null
        ? null
        : ref.watch(communityInviteProfileProvider(pubkey));

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: Grid.gutter),
          child: _NpubField(
            key: const Key('community-invite-recipient-field'),
            controller: searchController,
            focusNode: searchFocusNode,
            enabled: !isSubmitting.value,
            onChanged: handleInput,
            onSubmitted: (value) {
              final parsed = parseCommunityInvitePubkey(value);
              if (parsed == null && value.trim().isNotEmpty) {
                submitError.value = 'Paste a valid npub.';
              } else if (parsed != null) {
                selectCandidate(parsed);
              }
            },
          ),
        ),
        if (pubkey != null && profileAsync != null) ...[
          const SizedBox(height: Grid.xs),
          _InviteeResolutionCard(
            pubkey: pubkey,
            profileAsync: profileAsync,
            role: role,
            selectedRole: selectedRole.value,
            isSubmitting: isSubmitting.value,
            onRetry: () =>
                ref.invalidate(communityInviteProfileProvider(pubkey)),
            onRoleSelected: (value) => selectedRole.value = value,
            onInvite: (invitee) => unawaited(submit(invitee)),
          ),
        ],
        if (submitError.value case final error?) ...[
          const SizedBox(height: Grid.xxs),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: Grid.gutter),
            child: Text(
              error,
              key: const Key('community-invite-error'),
              style: context.textTheme.bodySmall?.copyWith(
                color: context.colors.error,
              ),
            ),
          ),
        ],
      ],
    );
  }
}

/// The npub entry field, styled to match the global search input.
class _NpubField extends StatelessWidget {
  const _NpubField({
    super.key,
    required this.controller,
    required this.focusNode,
    required this.enabled,
    required this.onChanged,
    required this.onSubmitted,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final bool enabled;
  final ValueChanged<String> onChanged;
  final ValueChanged<String> onSubmitted;

  @override
  Widget build(BuildContext context) {
    final mutedColor = navigationSecondaryForeground(context);
    return Container(
      height: 45,
      padding: const EdgeInsets.symmetric(horizontal: Grid.half),
      decoration: BoxDecoration(
        color: navigationSearchSurface(context),
        borderRadius: BorderRadius.circular(Radii.lg),
      ),
      child: TextField(
        key: const Key('community-invite-search'),
        controller: controller,
        focusNode: focusNode,
        enabled: enabled,
        autocorrect: false,
        enableSuggestions: false,
        decoration: InputDecoration(
          hintText: 'Search npub',
          hintStyle: searchInputTextStyle.copyWith(color: mutedColor),
          prefixIcon: Icon(LucideIcons.search, size: 16, color: mutedColor),
          prefixIconConstraints: const BoxConstraints(minWidth: 32),
          border: InputBorder.none,
          enabledBorder: InputBorder.none,
          focusedBorder: InputBorder.none,
          disabledBorder: InputBorder.none,
          isDense: true,
          contentPadding: const EdgeInsets.symmetric(vertical: Grid.xxs),
        ),
        style: searchInputTextStyle.copyWith(
          color: navigationPrimaryForeground(context),
        ),
        textInputAction: TextInputAction.done,
        onChanged: onChanged,
        onSubmitted: onSubmitted,
      ),
    );
  }
}

class _InviteeResolutionCard extends StatelessWidget {
  const _InviteeResolutionCard({
    required this.pubkey,
    required this.profileAsync,
    required this.role,
    required this.selectedRole,
    required this.isSubmitting,
    required this.onRetry,
    required this.onRoleSelected,
    required this.onInvite,
  });

  final String pubkey;
  final AsyncValue<CommunityInviteRecipient?> profileAsync;
  final CommunityMemberRole role;
  final CommunityMemberRole selectedRole;
  final bool isSubmitting;
  final VoidCallback onRetry;
  final ValueChanged<CommunityMemberRole> onRoleSelected;
  final ValueChanged<CommunityInviteRecipient> onInvite;

  @override
  Widget build(BuildContext context) {
    return profileAsync.when(
      loading: () => AppListCard(
        children: [
          AppListRowRaw(
            key: Key('community-invite-resolving-$pubkey'),
            leading: const SizedBox.square(
              dimension: 40,
              child: Center(
                child: ColonyLoadingIndicator(
                  size: 20,
                  semanticLabel: 'Resolving profile',
                ),
              ),
            ),
            title: const Text('Resolving profile'),
            subtitle: Text(shortCommunityInviteNpub(pubkey)),
          ),
        ],
      ),
      error: (_, _) => AppListCard(
        children: [
          AppListRow(
            key: Key('community-invite-resolution-error-$pubkey'),
            title: 'Could not resolve profile',
            subtitle: shortCommunityInviteNpub(pubkey),
            trailing: TextButton(
              onPressed: onRetry,
              child: const Text('Retry'),
            ),
          ),
        ],
      ),
      data: (invitee) {
        if (invitee == null) {
          return AppListCard(
            children: [
              AppListRow(
                key: Key('community-invite-unresolved-$pubkey'),
                title: 'Invalid npub',
                subtitle: shortCommunityInviteNpub(pubkey),
              ),
            ],
          );
        }
        return AppListCard(
          key: const Key('community-invite-person-card'),
          dividerIndent: Grid.xs,
          children: [
            AppListRow(
              key: Key('community-invite-resolved-$pubkey'),
              title: invitee.label,
              subtitle: shortCommunityInviteNpub(invitee.pubkey),
              trailing: FilledButton(
                key: const Key('community-invite-submit'),
                onPressed: isSubmitting ? null : () => onInvite(invitee),
                child: isSubmitting
                    ? const ColonyLoadingIndicator(
                        size: 16,
                        semanticLabel: 'Inviting person',
                      )
                    : const Text('Invite'),
              ),
            ),
            if (role == CommunityMemberRole.owner)
              AppListRow(
                key: const Key('community-invite-role'),
                title: 'Role',
                value: switch (selectedRole) {
                  CommunityMemberRole.member => 'Member',
                  CommunityMemberRole.admin => 'Admin',
                  CommunityMemberRole.owner => 'Owner',
                },
                trailing: const _InviteRowChevron(),
                onTap: isSubmitting
                    ? null
                    : () => _showInviteOptionSheet<CommunityMemberRole>(
                        context: context,
                        title: 'Role',
                        value: selectedRole,
                        options: const [
                          CommunityInviteOption(
                            label: 'Member',
                            value: CommunityMemberRole.member,
                          ),
                          CommunityInviteOption(
                            label: 'Admin',
                            value: CommunityMemberRole.admin,
                          ),
                        ],
                        onSelected: onRoleSelected,
                      ),
              ),
          ],
        );
      },
    );
  }
}
