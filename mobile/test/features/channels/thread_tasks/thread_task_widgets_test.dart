import 'package:buzz/features/channels/thread_tasks/composer_new_task_toggle.dart';
import 'package:buzz/features/channels/thread_tasks/thread_task_header_bar.dart';
import 'package:buzz/features/channels/thread_tasks/thread_task_providers.dart';
import 'package:buzz/shared/relay/company/company_task.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:hooks_riverpod/misc.dart';

import '../../../helpers/widget_helpers.dart';

const _scope = ThreadTaskScope(
  channelId: 'engineering',
  conversationScope: false,
  threadRoot: 'abc',
);

const _rootScope = ThreadTaskScope(
  channelId: 'engineering',
  conversationScope: false,
  threadRoot: null,
);

CompanyTask _task({
  String title = 'Cut the release video',
  bool hidden = false,
}) => CompanyTask(
  headEventId: 'head',
  record: const {},
  id: 'thread-task:sample',
  title: title,
  status: 'inProgress',
  owningTeamId: 'team-coordination',
  initiativeId: null,
  sourceChannelId: 'engineering',
  threadRoot: 'abc',
  doerKind: 'agent',
  assigneePersonaIds: const ['persona-cto'],
  reportedCompleteBy: const [],
  hidden: hidden,
  parentTaskId: null,
  createdAt: 1,
  updatedAt: 1,
);

List<Override> _withOpenTask(CompanyTask? task) => [
  threadOpenTaskProvider.overrideWith((ref, scope) async => task),
];

void main() {
  group('the New task switch', () {
    testWidgets('appears where a thread already holds work', (tester) async {
      await tester.pumpWidget(
        WidgetHelpers.testable(
          overrides: _withOpenTask(_task()),
          child: const ComposerNewTaskToggle(scope: _scope),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('composer-new-task')), findsOneWidget);
      expect(find.text('New task'), findsOneWidget);
    });

    testWidgets('is absent while the thread holds no work', (tester) async {
      await tester.pumpWidget(
        WidgetHelpers.testable(
          overrides: _withOpenTask(null),
          child: const ComposerNewTaskToggle(scope: _scope),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('composer-new-task')), findsNothing);
    });

    testWidgets('is absent at a channel root, where no task can be open', (
      tester,
    ) async {
      await tester.pumpWidget(
        WidgetHelpers.testable(
          overrides: _withOpenTask(_task()),
          child: const ComposerNewTaskToggle(scope: _rootScope),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('composer-new-task')), findsNothing);
    });

    testWidgets('records the request against the thread it was made in', (
      tester,
    ) async {
      final container = ProviderContainer(overrides: _withOpenTask(_task()));
      addTearDown(container.dispose);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(
            home: Scaffold(body: ComposerNewTaskToggle(scope: _scope)),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(container.read(composerNewTaskProvider), isNull);
      await tester.tap(find.byKey(const ValueKey('composer-new-task')));
      await tester.pumpAndSettle();
      expect(container.read(composerNewTaskProvider), 'engineering:abc');

      await tester.tap(find.byKey(const ValueKey('composer-new-task')));
      await tester.pumpAndSettle();
      expect(container.read(composerNewTaskProvider), isNull);
    });
  });

  group('the thread task header', () {
    testWidgets('names the open task and offers to close it', (tester) async {
      await tester.pumpWidget(
        WidgetHelpers.testable(
          overrides: _withOpenTask(_task()),
          child: const ThreadTaskHeaderBar(scope: _scope),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Cut the release video'), findsOneWidget);
      expect(find.byKey(const ValueKey('thread-mark-done')), findsOneWidget);
    });

    testWidgets('says nothing when the thread holds no work', (tester) async {
      await tester.pumpWidget(
        WidgetHelpers.testable(
          overrides: _withOpenTask(null),
          child: const ThreadTaskHeaderBar(scope: _scope),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('thread-open-task-title')),
        findsNothing,
      );
      expect(find.byKey(const ValueKey('thread-mark-done')), findsNothing);
    });

    testWidgets('never shows the hidden chat task', (tester) async {
      await tester.pumpWidget(
        WidgetHelpers.testable(
          overrides: _withOpenTask(_task(title: 'Chat', hidden: true)),
          child: const ThreadTaskHeaderBar(scope: _scope),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Chat'), findsNothing);
      expect(find.byKey(const ValueKey('thread-mark-done')), findsNothing);
    });

    testWidgets('offers no close to a member who is not the owner', (
      tester,
    ) async {
      await tester.pumpWidget(
        WidgetHelpers.testable(
          overrides: _withOpenTask(_task()),
          child: const ThreadTaskHeaderBar(scope: _scope, viewerRole: 'member'),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Cut the release video'), findsOneWidget);
      expect(find.byKey(const ValueKey('thread-mark-done')), findsNothing);
    });
  });
}
