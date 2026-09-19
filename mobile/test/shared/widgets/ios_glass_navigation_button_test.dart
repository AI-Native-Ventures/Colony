import 'package:buzz/shared/theme/theme.dart';
import 'package:buzz/shared/widgets/frosted_app_bar.dart';
import 'package:buzz/shared/widgets/ios_glass_navigation_button.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// Pushes a route carrying a [FrostedAppBar] so its automatic back control is
/// the thing under test.
Future<void> _pumpPushedAppBar(
  WidgetTester tester, {
  required TargetPlatform platform,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: AppTheme.light().copyWith(platform: platform),
      home: const Scaffold(body: SizedBox()),
    ),
  );
  await tester.pumpAndSettle();

  tester
      .state<NavigatorState>(find.byType(Navigator).first)
      .push(
        MaterialPageRoute<void>(
          builder: (_) =>
              const Stack(children: [FrostedAppBar(title: Text('Pushed'))]),
        ),
      );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('renders the native platform view on iOS', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    try {
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light().copyWith(platform: TargetPlatform.iOS),
          home: Scaffold(
            body: IosGlassNavigationButton(
              icon: IosGlassNavigationIcon.back,
              semanticLabel: 'Back',
              onPressed: () {},
            ),
          ),
        ),
      );
      await tester.pump();

      expect(
        tester.widget<UiKitView>(find.byType(UiKitView)).viewType,
        IosGlassNavigationButton.viewType,
      );
    } finally {
      debugDefaultTargetPlatformOverride = null;
    }
  });

  testWidgets('the app bar back control uses glass on iOS', (tester) async {
    // The port only matters if the shared app bar actually reaches the native
    // control, not merely that the widget compiles.
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    try {
      await _pumpPushedAppBar(tester, platform: TargetPlatform.iOS);

      expect(find.byType(IosGlassNavigationButton), findsOneWidget);
      expect(find.byIcon(LucideIcons.chevronLeft), findsNothing);
    } finally {
      debugDefaultTargetPlatformOverride = null;
    }
  });

  testWidgets('the app bar back control stays a plain button off iOS', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    try {
      await _pumpPushedAppBar(tester, platform: TargetPlatform.android);

      expect(find.byType(IosGlassNavigationButton), findsNothing);
      expect(find.byIcon(LucideIcons.chevronLeft), findsOneWidget);
    } finally {
      debugDefaultTargetPlatformOverride = null;
    }
  });
}
