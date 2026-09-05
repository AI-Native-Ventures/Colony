import 'package:flutter/foundation.dart';

import '../../../shared/relay/company/company_task.dart';

/// What a thread header says about the work open in the thread.
///
/// Pure on purpose: the header owns layout, this owns the rule, and the rule
/// is the part worth proving without rendering anything.
@immutable
class ThreadTaskHeader {
  /// The open task's title, or null when the thread has no work open.
  final String? title;

  /// Whether this viewer may close the task from here.
  final bool canMarkDone;

  const ThreadTaskHeader({required this.title, required this.canMarkDone});
}

/// "Mark done" is the owner's close, not an assignee's report.
///
/// An agent finishing its own share publishes a completion report and the task
/// closes on its own once every assignee has. A Company Action may only be
/// signed by the human owner, so a member who is known not to be one is not
/// offered a button the relay is going to refuse.
///
/// An unknown role is not a refusal. A relay that does not advertise
/// membership roles reports no role for anybody, which is the ordinary
/// single-owner install: hiding the control there would take it away from the
/// only person who could ever use it.
///
/// A hidden task is never offered either: it exists to carry the cost of turns
/// that were not work, and there is nothing in it for a member to finish.
ThreadTaskHeader threadTaskHeader(CompanyTask? openTask, String? viewerRole) {
  if (openTask == null || openTask.hidden) {
    return const ThreadTaskHeader(title: null, canMarkDone: false);
  }
  return ThreadTaskHeader(
    title: openTask.title,
    canMarkDone: viewerRole == null || viewerRole == 'owner',
  );
}
