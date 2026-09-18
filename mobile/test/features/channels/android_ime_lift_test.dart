import 'package:buzz/features/channels/android_ime_lift.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget _subject({required double imeBottom, required double systemBottom}) =>
    MediaQuery(
      data: MediaQueryData(
        viewInsets: EdgeInsets.only(bottom: imeBottom),
        viewPadding: EdgeInsets.only(bottom: systemBottom),
      ),
      child: const Directionality(
        textDirection: TextDirection.ltr,
        child: AndroidImeLift(
          child: SizedBox(key: Key('composer'), height: 40),
        ),
      ),
    );

void main() {
  // testWidgets verifies foundation debug vars at the END OF THE BODY, before
  // tearDown runs, so each widget test resets the override itself.
  testWidgets('lifts the composer by the IME inset less the safe area', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;

    await tester.pumpWidget(_subject(imeBottom: 300, systemBottom: 48));

    // The composer already reserves the navigation area, so lifting by the
    // full inset would leave a second gap above the keyboard.
    final padding = tester.widget<Padding>(find.byType(Padding));
    expect(padding.padding, const EdgeInsets.only(bottom: 252));
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('never applies a negative lift', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;

    await tester.pumpWidget(_subject(imeBottom: 0, systemBottom: 48));

    final padding = tester.widget<Padding>(find.byType(Padding));
    expect(padding.padding, EdgeInsets.zero);
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('is inert off Android, where the scaffold resizes instead', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;

    await tester.pumpWidget(_subject(imeBottom: 300, systemBottom: 48));

    expect(find.byType(Padding), findsNothing);
    expect(find.byKey(const Key('composer')), findsOneWidget);
    debugDefaultTargetPlatformOverride = null;
  });

  test('usesFixedAndroidImeViewport only reports true on Android', () {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    expect(usesFixedAndroidImeViewport, isTrue);

    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    expect(usesFixedAndroidImeViewport, isFalse);
    debugDefaultTargetPlatformOverride = null;
  });
}
