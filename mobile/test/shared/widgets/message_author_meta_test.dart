import 'package:buzz/shared/theme/theme.dart';
import 'package:buzz/shared/widgets/message_author_meta.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('keeps the timestamp next to a short name without a separator', (
    tester,
  ) async {
    const displayNameKey = Key('author-display-name');
    const timestampKey = Key('author-timestamp');

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: const Scaffold(
          body: SizedBox(
            width: 300,
            child: MessageAuthorMeta(
              displayName: 'Alice',
              timestamp: '2m',
              displayNameKey: displayNameKey,
              timestampKey: timestampKey,
              nameColor: Colors.black,
              metadataColor: Colors.grey,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final displayNameRect = tester.getRect(find.byKey(displayNameKey));
    final timestampRect = tester.getRect(find.byKey(timestampKey));

    expect(find.text('·'), findsNothing);
    expect(timestampRect.left - displayNameRect.right, Grid.xxs);
    expect(
      tester.widget<Text>(find.byKey(timestampKey)).style?.fontSize,
      messageTimestampTextStyle.fontSize,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('reallocates unused metadata width to the display name', (
    tester,
  ) async {
    const displayNameKey = Key('author-display-name');
    const timestampKey = Key('author-timestamp');

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: const Scaffold(
          body: SizedBox(
            width: 300,
            child: MessageAuthorMeta(
              displayName: 'A display name that needs the available width',
              username: 'al',
              timestamp: '2m',
              displayNameKey: displayNameKey,
              timestampKey: timestampKey,
              nameColor: Colors.black,
              metadataColor: Colors.grey,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final row = find.byType(MessageAuthorMeta);
    final displayName = find.byKey(displayNameKey);
    final timestamp = find.byKey(timestampKey);

    expect(
      tester.getSize(displayName).width,
      greaterThan(tester.getSize(row).width / 2),
    );
    expect(
      tester.getTopRight(timestamp).dx,
      closeTo(tester.getTopRight(row).dx, 0.01),
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('constrains long metadata at large accessible text sizes', (
    tester,
  ) async {
    const timestampKey = Key('author-timestamp');

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: const MediaQuery(
          data: MediaQueryData(textScaler: TextScaler.linear(2)),
          child: Scaffold(
            body: SizedBox(
              width: 220,
              child: MessageAuthorMeta(
                displayName: 'A very long display name',
                username: 'a-very-long-username',
                timestamp: 'Mar 15, 2025',
                timestampKey: timestampKey,
                nameColor: Colors.black,
                metadataColor: Colors.grey,
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final timestamp = tester.widget<Text>(find.byKey(timestampKey));
    expect(timestamp.maxLines, 1);
    expect(timestamp.overflow, TextOverflow.ellipsis);
    expect(tester.takeException(), isNull);
  });

  testWidgets('renders the timestamp smaller than the author name', (
    tester,
  ) async {
    const displayNameKey = Key('author-display-name');
    const timestampKey = Key('author-timestamp');

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: const Scaffold(
          body: SizedBox(
            width: 300,
            child: MessageAuthorMeta(
              displayName: 'Alice',
              timestamp: '2m',
              displayNameKey: displayNameKey,
              timestampKey: timestampKey,
              nameColor: Colors.black,
              metadataColor: Colors.grey,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final timestampStyle = tester.widget<Text>(find.byKey(timestampKey)).style;
    // The timestamp takes its own style rather than the author-metadata one,
    // and keeps the metadata colour.
    expect(timestampStyle?.fontSize, messageTimestampTextStyle.fontSize);
    expect(
      timestampStyle!.fontSize!,
      lessThan(messageUsernameTextStyle.fontSize!),
    );
    expect(timestampStyle.color, Colors.grey);
  });

  testWidgets('an explicit timestampStyle overrides the default', (
    tester,
  ) async {
    const timestampKey = Key('author-timestamp');

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: const Scaffold(
          body: SizedBox(
            width: 300,
            child: MessageAuthorMeta(
              displayName: 'Alice',
              timestamp: '2m',
              timestampKey: timestampKey,
              nameColor: Colors.black,
              metadataColor: Colors.grey,
              timestampStyle: TextStyle(fontSize: 9),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(tester.widget<Text>(find.byKey(timestampKey)).style?.fontSize, 9);
  });
}
