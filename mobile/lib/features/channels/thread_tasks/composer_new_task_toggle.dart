import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../../shared/theme/theme.dart';
import 'attach_decision.dart';
import 'thread_task_providers.dart';

/// The composer's "New task" switch.
///
/// A thread holds one open task, and every message in it is charged to that
/// task. That is right nearly always and wrong when two things are being
/// worked on in one conversation, so the switch is how a member says "this one
/// is separate" without leaving the thread.
///
/// It only appears where it means something: a thread, or a DM, that already
/// has work open. On a channel timeline there is nothing to start a second
/// task beside, so the widget renders nothing at all.
class ComposerNewTaskToggle extends ConsumerWidget {
  final ThreadTaskScope scope;

  const ComposerNewTaskToggle({super.key, required this.scope});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!scope.isAddressable) return const SizedBox.shrink();
    final openTask = ref.watch(threadOpenTaskProvider(scope)).value;
    if (openTask == null) return const SizedBox.shrink();

    final requested = ref.watch(composerNewTaskRequestedProvider(scope));
    final label = newTaskScope(
      channelId: scope.channelId,
      threadRoot: scope.threadRoot,
    );

    return Align(
      alignment: Alignment.centerLeft,
      child: Padding(
        padding: const EdgeInsets.only(left: Grid.half, bottom: Grid.xxs),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Switch(
              key: const ValueKey('composer-new-task'),
              value: requested,
              onChanged: (next) {
                final notifier = ref.read(composerNewTaskProvider.notifier);
                if (next) {
                  notifier.request(label);
                } else {
                  notifier.clear();
                }
              },
            ),
            const SizedBox(width: Grid.xxs),
            Semantics(
              label: 'Start a separate task in this thread',
              child: Text(
                'New task',
                style: context.textTheme.bodySmall?.copyWith(
                  color: context.colors.onSurfaceVariant,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
