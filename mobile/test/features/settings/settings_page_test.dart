import 'package:buzz/features/settings/settings_page.dart';
import 'package:buzz/shared/community/community_membership_provider.dart';
import 'package:buzz/shared/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';

Future<void> _pumpSettings(
  WidgetTester tester,
  AsyncValue<CommunityMemberRole?> role,
) async {
  SharedPreferences.setMockInitialValues({});
  PackageInfo.setMockInitialValues(
    appName: 'Colony',
    packageName: 'ventures.ainative.colony',
    version: '1.0.0',
    buildNumber: '1',
    buildSignature: '',
  );
  final prefs = await SharedPreferences.getInstance();

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        savedPrefsProvider.overrideWithValue(prefs),
        currentCommunityRoleProvider.overrideWithValue(role),
      ],
      child: MaterialApp(
        theme: AppTheme.light(),
        home: SettingsPage(
          profileHeader: const SizedBox.shrink(),
          invitePageBuilder: (_) => const Text('Invite destination'),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('shows community invite navigation to owners and admins', (
    tester,
  ) async {
    await _pumpSettings(
      tester,
      const AsyncData<CommunityMemberRole?>(CommunityMemberRole.admin),
    );

    expect(find.text('Invite to community'), findsOneWidget);
    await tester.tap(find.text('Invite to community'));
    await tester.pumpAndSettle();
    expect(find.text('Invite destination'), findsOneWidget);
  });

  testWidgets('keeps invite navigation available when role lookup fails', (
    tester,
  ) async {
    await _pumpSettings(
      tester,
      AsyncError<CommunityMemberRole?>(
        Exception('membership query failed'),
        StackTrace.empty,
      ),
    );

    expect(find.text('Invite to community'), findsOneWidget);
    await tester.tap(find.text('Invite to community'));
    await tester.pumpAndSettle();
    expect(find.text('Invite destination'), findsOneWidget);
  });

  testWidgets('hides community invite navigation from plain members', (
    tester,
  ) async {
    await _pumpSettings(
      tester,
      const AsyncData<CommunityMemberRole?>(CommunityMemberRole.member),
    );

    expect(find.text('Invite to community'), findsNothing);
  });

  testWidgets('hides community invite navigation while the role loads', (
    tester,
  ) async {
    await _pumpSettings(tester, const AsyncLoading<CommunityMemberRole?>());

    expect(find.text('Invite to community'), findsNothing);
  });
}
