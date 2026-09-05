import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../shared/relay/company/thread_task_client.dart';
import '../../../shared/theme/theme.dart';
import 'thread_task_header_model.dart';
import 'thread_task_providers.dart';

/// Height this bar occupies when it has something to say.
///
/// A caller reserves it in the surface above so the timeline is not drawn
/// underneath the bar.
const threadTaskHeaderHeight = 40.0;

/// The work open in a thread, and the way to say it is finished.
///
/// A thread holds at most one open task, and this is the one place a member
/// reading the conversation can see which one they are talking about and close
/// it. Closing it from a task list instead would mean leaving the conversation
/// to end the work the conversation is about.
///
/// "Mark done" is the owner's close, not an assignee's report: an agent
/// finishing its own share publishes a completion report, and the task closes
/// on its own once every assignee has.
class ThreadTaskHeaderBar extends HookConsumerWidget {
  final ThreadTaskScope scope;

  /// This member's community role, when the relay reports one. Null means
  /// unknown, which is the ordinary single-owner install rather than a
  /// refusal - see [threadTaskHeader].
  final String? viewerRole;

  const ThreadTaskHeaderBar({super.key, required this.scope, this.viewerRole});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final openTask = ref.watch(threadOpenTaskProvider(scope)).value;
    final header = threadTaskHeader(openTask, viewerRole);
    final isClosing = useState(false);
    final error = useState<String?>(null);

    if (header.title == null) return const SizedBox.shrink();

    Future<void> markDone() async {
      final task = openTask;
      if (task == null || isClosing.value) return;
      isClosing.value = true;
      error.value = null;
      try {
        await ref.read(threadTaskClientProvider).markTaskDone(task.id);
        ref.invalidate(threadOpenTaskProvider(scope));
      } on WorkContextError catch (failure) {
        error.value = failure.message;
      } catch (_) {
        error.value = 'That task could not be closed.';
      } finally {
        isClosing.value = false;
      }
    }

    return SizedBox(
      height: threadTaskHeaderHeight,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: Grid.gutter),
        child: Row(
          children: [
            Icon(
              LucideIcons.listChecks,
              size: 14,
              color: context.colors.onSurfaceVariant,
            ),
            const SizedBox(width: Grid.xxs),
            Expanded(
              child: Text(
                error.value ?? header.title!,
                key: const ValueKey('thread-open-task-title'),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: context.textTheme.bodySmall?.copyWith(
                  color: error.value == null
                      ? context.colors.onSurfaceVariant
                      : context.colors.error,
                ),
              ),
            ),
            if (header.canMarkDone)
              TextButton(
                key: const ValueKey('thread-mark-done'),
                onPressed: isClosing.value ? null : markDone,
                child: const Text('Mark done'),
              ),
          ],
        ),
      ),
    );
  }
}
