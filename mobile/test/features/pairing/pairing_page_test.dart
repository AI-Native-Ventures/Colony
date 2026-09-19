import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:buzz/features/pairing/pairing_page.dart';
import 'package:buzz/features/pairing/pairing_provider.dart';
import 'package:buzz/shared/theme/theme.dart';
import 'package:buzz/shared/widgets/colony_loading_indicator.dart';
import 'package:buzz/shared/widgets/tappable_flapping_ant.dart';

import '../../helpers/widget_helpers.dart';

void main() {
  group('PairingPage', () {
    testWidgets('renders branding and progressive pairing actions', (
      tester,
    ) async {
      await tester.pumpWidget(
        WidgetHelpers.testable(child: const PairingPage()),
      );

      expect(find.byType(TappableFlappingAnt), findsOneWidget);
      expect(find.text('Welcome to Colony'), findsOneWidget);
      // Sign-in is the primary action and pairing is the secondary one: a
      // phone user who has never owned a desktop must be able to get in.
      expect(find.widgetWithText(FilledButton, 'Sign in'), findsOneWidget);
      expect(
        find.widgetWithText(TextButton, 'I already use Colony on my computer'),
        findsOneWidget,
      );
      expect(find.text('Use pairing code'), findsOneWidget);
      expect(find.text('Connect'), findsNothing);
      expect(find.byType(TextField), findsNothing);
    });

    testWidgets('uses compact desktop-style onboarding actions', (
      tester,
    ) async {
      await tester.pumpWidget(
        WidgetHelpers.testable(child: const PairingPage()),
      );

      final scanButton = tester.getSize(
        find.widgetWithText(FilledButton, 'Sign in'),
      );
      final pairingCodeButton = tester.getSize(
        find.widgetWithText(TextButton, 'Use pairing code'),
      );

      expect(scanButton.width, lessThan(440));
      expect(pairingCodeButton.width, lessThan(440));
      expect(find.byType(OutlinedButton), findsNothing);
    });

    testWidgets('uses dark status-bar icons on the onboarding surface', (
      tester,
    ) async {
      await tester.pumpWidget(
        WidgetHelpers.testable(child: const PairingPage()),
      );

      final overlay = tester.widget<AnnotatedRegion<SystemUiOverlayStyle>>(
        find.byKey(const Key('pairing-onboarding-system-overlay')),
      );

      expect(overlay.value.statusBarIconBrightness, Brightness.dark);
      expect(overlay.value.statusBarColor, Colors.transparent);
    });

    testWidgets('uses light status-bar icons for dark-theme SAS verification', (
      tester,
    ) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            pairingProvider.overrideWith(() => _ConfirmingSasPairingNotifier()),
          ],
          child: MaterialApp(theme: AppTheme.dark(), home: const PairingPage()),
        ),
      );

      final overlay = tester.widget<AnnotatedRegion<SystemUiOverlayStyle>>(
        find.byKey(const Key('pairing-sas-system-overlay')),
      );

      expect(overlay.value.statusBarIconBrightness, Brightness.light);
      expect(overlay.value.statusBarColor, Colors.transparent);
      expect(find.text('Confirm desktop code'), findsOneWidget);
    });

    testWidgets('renders the code as six separate digit boxes', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            pairingProvider.overrideWith(() => _ConfirmingSasPairingNotifier()),
          ],
          child: MaterialApp(
            theme: AppTheme.light(),
            home: const PairingPage(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      for (var index = 1; index <= 6; index++) {
        expect(
          find.byKey(Key('pairing-sas-code-digit-$index')),
          findsOneWidget,
        );
      }
      // Each digit stands alone rather than as one run of text.
      expect(find.text('1'), findsOneWidget);
      expect(find.text('6'), findsOneWidget);
      expect(find.text('123 456'), findsNothing);
    });

    testWidgets('tells the user to compare the code on both devices', (
      tester,
    ) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            pairingProvider.overrideWith(() => _ConfirmingSasPairingNotifier()),
          ],
          child: MaterialApp(
            theme: AppTheme.light(),
            home: const PairingPage(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // The comparison IS the security control, so the copy has to name it.
      expect(find.textContaining('matches on both devices'), findsOneWidget);
      // And it must still say what confirming does.
      expect(find.textContaining('transfer to this device'), findsOneWidget);
    });

    testWidgets('keeps both confirm and cancel actions available', (
      tester,
    ) async {
      var confirmed = 0;
      var denied = 0;
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            pairingProvider.overrideWith(
              () => _RecordingSasPairingNotifier(
                onConfirm: () => confirmed++,
                onDeny: () => denied++,
              ),
            ),
          ],
          child: MaterialApp(
            theme: AppTheme.light(),
            home: const PairingPage(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(FilledButton, 'Codes match'));
      await tester.pumpAndSettle();
      expect(confirmed, 1);
      expect(denied, 0);

      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await tester.pumpAndSettle();
      expect(denied, 1);
    });

    testWidgets('replaces the actions with a waiting state once confirmed', (
      tester,
    ) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            pairingProvider.overrideWith(() => _ConfirmedSasPairingNotifier()),
          ],
          child: MaterialApp(
            theme: AppTheme.light(),
            home: const PairingPage(),
          ),
        ),
      );
      // pump, not pumpAndSettle: the waiting state shows a looping spinner
      // that never settles.
      await tester.pump();

      // Confirming must not leave a second chance to confirm.
      expect(find.widgetWithText(FilledButton, 'Codes match'), findsNothing);
      expect(find.textContaining('waiting for desktop'), findsOneWidget);
    });

    testWidgets('reveals pairing code field and connect action', (
      tester,
    ) async {
      await tester.pumpWidget(
        WidgetHelpers.testable(child: const PairingPage()),
      );

      await _expandPairingCode(tester);

      expect(find.text('Hide pairing code'), findsOneWidget);
      expect(find.text('Connect'), findsOneWidget);
      expect(find.byType(TextField), findsOneWidget);
    });

    testWidgets('connect button is below text field, not beside it', (
      tester,
    ) async {
      await tester.pumpWidget(
        WidgetHelpers.testable(child: const PairingPage()),
      );
      await _expandPairingCode(tester);

      final textField = tester.getBottomLeft(find.byType(TextField));
      final connectButton = tester.getTopLeft(
        find.widgetWithText(FilledButton, 'Connect'),
      );

      // The connect button should be below the text field.
      expect(connectButton.dy, greaterThan(textField.dy));
    });

    testWidgets('connect button is full width', (tester) async {
      await tester.pumpWidget(
        WidgetHelpers.testable(child: const PairingPage()),
      );
      await _expandPairingCode(tester);

      final connectButton = tester.getSize(
        find.widgetWithText(FilledButton, 'Connect'),
      );
      final textField = tester.getSize(find.byType(TextField));

      // Button width should be close to the text field width (both full-width).
      expect(connectButton.width, closeTo(textField.width, 2.0));
    });

    testWidgets('shows error container when pairing fails', (tester) async {
      await tester.pumpWidget(
        WidgetHelpers.testable(
          overrides: [
            pairingProvider.overrideWith(
              () => _ErrorPairingNotifier('Invalid pairing code: bad input'),
            ),
          ],
          child: const PairingPage(),
        ),
      );
      await tester.pump();

      expect(find.text('Invalid pairing code: bad input'), findsOneWidget);
    });

    testWidgets('shows spinner when connecting', (tester) async {
      await tester.pumpWidget(
        WidgetHelpers.testable(
          overrides: [
            pairingProvider.overrideWith(() => _ConnectingPairingNotifier()),
          ],
          child: const PairingPage(),
        ),
      );
      await tester.pump();

      expect(find.byType(ColonyLoadingIndicator), findsOneWidget);
      // Connect text should be replaced by spinner.
      expect(find.text('Connect'), findsNothing);
    });

    testWidgets('pairing actions are disabled when connecting', (tester) async {
      await tester.pumpWidget(
        WidgetHelpers.testable(
          overrides: [
            pairingProvider.overrideWith(() => _ConnectingPairingNotifier()),
          ],
          child: const PairingPage(),
        ),
      );
      await tester.pump();

      final scanButton = tester.widget<FilledButton>(find.byType(FilledButton));
      final pairingCodeButton = tester.widget<TextButton>(
        find.widgetWithText(TextButton, 'Use pairing code'),
      );

      expect(scanButton.onPressed, isNull);
      expect(pairingCodeButton.onPressed, isNull);
    });
  });
}

Future<void> _expandPairingCode(WidgetTester tester) async {
  await tester.tap(find.text('Use pairing code'));
  await tester.pumpAndSettle();
}

class _ErrorPairingNotifier extends Notifier<PairingState>
    implements PairingNotifier {
  final String error;
  _ErrorPairingNotifier(this.error);

  @override
  PairingState build() =>
      PairingState(status: PairingStatus.error, errorMessage: error);

  @override
  Future<void> pair(String rawInput) async {}

  @override
  void reset() {}

  @override
  void confirmSas() {}

  @override
  void denySas() {}
}

class _ConnectingPairingNotifier extends Notifier<PairingState>
    implements PairingNotifier {
  @override
  PairingState build() => const PairingState(status: PairingStatus.connecting);

  @override
  Future<void> pair(String rawInput) async {}

  @override
  void reset() {}

  @override
  void confirmSas() {}

  @override
  void denySas() {}
}

class _ConfirmingSasPairingNotifier extends Notifier<PairingState>
    implements PairingNotifier {
  @override
  PairingState build() => const PairingState(
    status: PairingStatus.confirmingSas,
    sasCode: '123456',
  );

  @override
  Future<void> pair(String rawInput) async {}

  @override
  void reset() {}

  @override
  void confirmSas() {}

  @override
  void denySas() {}
}

class _RecordingSasPairingNotifier extends Notifier<PairingState>
    implements PairingNotifier {
  _RecordingSasPairingNotifier({required this.onConfirm, required this.onDeny});

  final VoidCallback onConfirm;
  final VoidCallback onDeny;

  @override
  PairingState build() => const PairingState(
    status: PairingStatus.confirmingSas,
    sasCode: '123456',
  );

  @override
  Future<void> pair(String rawInput) async {}

  @override
  void reset() {}

  @override
  void confirmSas() => onConfirm();

  @override
  void denySas() => onDeny();
}

class _ConfirmedSasPairingNotifier extends Notifier<PairingState>
    implements PairingNotifier {
  @override
  PairingState build() => const PairingState(
    status: PairingStatus.confirmingSas,
    sasCode: '123456',
    userConfirmedSas: true,
  );

  @override
  Future<void> pair(String rawInput) async {}

  @override
  void reset() {}

  @override
  void confirmSas() {}

  @override
  void denySas() {}
}
