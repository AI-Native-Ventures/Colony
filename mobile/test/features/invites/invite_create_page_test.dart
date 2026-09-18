import 'package:buzz/features/invites/invite_create_page.dart';
import 'package:buzz/features/invites/invite_create_provider.dart';
import 'package:buzz/shared/community/community_membership_provider.dart';
import 'package:buzz/shared/relay/relay.dart';
import 'package:buzz/shared/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:nostr/nostr.dart' as nostr;

const owner =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const existingMember =
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const stranger =
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

String _npub(String pubkey) =>
    nostr.Nip19.encode(prefix: nostr.Nip19Prefix.npub, data: pubkey);

class _FakeInviteActions implements CommunityInviteActions {
  final mintRequests = <(int, int?)>[];
  final memberInvites = <(List<String>, CommunityMemberRole)>[];

  @override
  Future<MintedCommunityInvite> mintInvite({
    required int ttlSeconds,
    required int? maxUses,
  }) async {
    mintRequests.add((ttlSeconds, maxUses));
    return MintedCommunityInvite(
      code: 'code-${mintRequests.length}',
      expiresAt: 12345,
      url: 'https://relay.example.com/invite/${mintRequests.length}',
      maxUses: maxUses,
      usesRemaining: maxUses,
    );
  }

  @override
  Future<void> inviteMembers({
    required Iterable<String> pubkeys,
    required CommunityMemberRole role,
  }) async {
    memberInvites.add((pubkeys.toList(), role));
  }
}

Future<_FakeInviteActions> _pumpInvitePage(
  WidgetTester tester, {
  required CommunityMemberRole? role,
  void Function(String url)? onShare,
}) async {
  tester.view.physicalSize = const Size(430, 1100);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  final actions = _FakeInviteActions();
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        currentCommunityRoleProvider.overrideWithValue(
          AsyncData<CommunityMemberRole?>(role),
        ),
        communityMembershipProvider.overrideWith(
          (ref) async => const CommunityMembershipSnapshot(
            snapshotFound: true,
            members: [
              CommunityMember(pubkey: owner, role: CommunityMemberRole.owner),
              CommunityMember(
                pubkey: existingMember,
                role: CommunityMemberRole.member,
              ),
            ],
          ),
        ),
        myPubkeyProvider.overrideWithValue(owner),
        communityInviteProfileProvider.overrideWith(
          (ref, pubkey) async => CommunityInviteRecipient(pubkey: pubkey),
        ),
        communityInviteActionsProvider.overrideWithValue(actions),
        shareCommunityInviteProvider.overrideWithValue((url, origin) async {
          onShare?.call(url);
        }),
      ],
      child: MaterialApp(
        theme: AppTheme.light(),
        home: const CommunityInvitePage(),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return actions;
}

void main() {
  testWidgets('owner mints a link on open and invites a pasted npub', (
    tester,
  ) async {
    String? sharedUrl;
    final actions = await _pumpInvitePage(
      tester,
      role: CommunityMemberRole.owner,
      onShare: (url) => sharedUrl = url,
    );

    expect(actions.mintRequests, [(defaultCommunityInviteTtlSeconds, null)]);
    expect(find.text('Search npub'), findsOneWidget);

    await tester.enterText(
      find.byKey(const Key('community-invite-search')),
      _npub(stranger),
    );
    await tester.pumpAndSettle();

    expect(
      find.byKey(const Key('community-invite-resolved-$stranger')),
      findsOneWidget,
    );
    // An owner may choose the granted role; the default stays Member.
    expect(find.byKey(const Key('community-invite-role')), findsOneWidget);
    expect(find.text('Member'), findsOneWidget);

    await tester.tap(find.byKey(const Key('community-invite-submit')));
    await tester.pumpAndSettle();

    expect(actions.memberInvites, hasLength(1));
    expect(actions.memberInvites.single.$1, [stranger]);
    expect(actions.memberInvites.single.$2, CommunityMemberRole.member);

    await tester.ensureVisible(
      find.byKey(const Key('community-invite-share-link')),
    );
    await tester.tap(find.byKey(const Key('community-invite-share-link')));
    await tester.pumpAndSettle();
    expect(sharedUrl, 'https://relay.example.com/invite/1');
  });

  testWidgets('owner can grant the admin role', (tester) async {
    final actions = await _pumpInvitePage(
      tester,
      role: CommunityMemberRole.owner,
    );

    await tester.enterText(
      find.byKey(const Key('community-invite-search')),
      _npub(stranger),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('community-invite-role')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('community-invite-option-admin')));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('community-invite-submit')));
    await tester.pumpAndSettle();

    expect(actions.memberInvites.single.$2, CommunityMemberRole.admin);
  });

  testWidgets('admin gets no role choice and always invites members', (
    tester,
  ) async {
    final actions = await _pumpInvitePage(
      tester,
      role: CommunityMemberRole.admin,
    );

    await tester.enterText(
      find.byKey(const Key('community-invite-search')),
      _npub(stranger),
    );
    await tester.pumpAndSettle();

    // The relay refuses an admin-granted admin role, so the row is absent.
    expect(find.byKey(const Key('community-invite-role')), findsNothing);

    await tester.tap(find.byKey(const Key('community-invite-submit')));
    await tester.pumpAndSettle();

    expect(actions.memberInvites.single.$2, CommunityMemberRole.member);
  });

  testWidgets('changing the expiry remints the link', (tester) async {
    final actions = await _pumpInvitePage(
      tester,
      role: CommunityMemberRole.owner,
    );

    await tester.tap(find.byKey(const Key('community-invite-expiry-setting')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('community-invite-option-1-day')));
    await tester.pumpAndSettle();

    expect(actions.mintRequests, [
      (defaultCommunityInviteTtlSeconds, null),
      (24 * 60 * 60, null),
    ]);
  });

  testWidgets('rejects an npub that is already in the community', (
    tester,
  ) async {
    final actions = await _pumpInvitePage(
      tester,
      role: CommunityMemberRole.owner,
    );

    await tester.enterText(
      find.byKey(const Key('community-invite-search')),
      _npub(existingMember),
    );
    await tester.pumpAndSettle();

    expect(
      find.text('This person is already in the community.'),
      findsOneWidget,
    );
    expect(find.byKey(const Key('community-invite-submit')), findsNothing);
    expect(actions.memberInvites, isEmpty);
  });

  testWidgets('rejects inviting yourself', (tester) async {
    await _pumpInvitePage(tester, role: CommunityMemberRole.owner);

    await tester.enterText(
      find.byKey(const Key('community-invite-search')),
      _npub(owner),
    );
    await tester.pumpAndSettle();

    expect(find.text('You cannot invite yourself.'), findsOneWidget);
    expect(find.byKey(const Key('community-invite-submit')), findsNothing);
  });

  testWidgets('plain members cannot open invite tools', (tester) async {
    final actions = await _pumpInvitePage(
      tester,
      role: CommunityMemberRole.member,
    );

    expect(find.text('Invite access required'), findsOneWidget);
    expect(find.byKey(const Key('community-invite-search')), findsNothing);
    expect(actions.mintRequests, isEmpty);
  });

  testWidgets('non-members cannot open invite tools', (tester) async {
    final actions = await _pumpInvitePage(tester, role: null);

    expect(find.text('Invite access required'), findsOneWidget);
    expect(actions.mintRequests, isEmpty);
  });
}
