import 'package:flutter/widgets.dart';
import 'package:scrollable_positioned_list/scrollable_positioned_list.dart';

/// Settles an ordinary thread open on the latest hydrated reply after layout.
///
/// Scheduling again before completion invalidates callbacks aimed at an older
/// tail, allowing a rebuild with newly arrived replies to choose the target.
class InitialThreadTailSettle {
  var _generation = 0;
  var _isComplete = false;

  /// Whether no more settling is needed.
  bool get isComplete => _isComplete;

  /// Permanently abandons initial settling and invalidates queued callbacks.
  void abandon() {
    _generation++;
    _isComplete = true;
  }

  /// Schedules a settle after each hydrated thread layout until [isComplete].
  void schedule({
    required BuildContext context,
    required ItemScrollController controller,
    required ItemPositionsListener positionsListener,
    required int? targetIndex,
    required double hiddenTopFraction,
    required double hiddenBottomFraction,
  }) {
    if (_isComplete) return;

    final generation = ++_generation;
    if (targetIndex == null) {
      _isComplete = true;
      return;
    }

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!context.mounted || generation != _generation) return;

      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!context.mounted ||
            !controller.isAttached ||
            generation != _generation) {
          return;
        }
        final targetIsFullyVisible = positionsListener.itemPositions.value.any(
          (position) =>
              position.index == targetIndex &&
              position.itemLeadingEdge >= hiddenTopFraction &&
              position.itemTrailingEdge <= 1 - hiddenBottomFraction,
        );
        if (targetIsFullyVisible) {
          _isComplete = true;
          return;
        }
        controller
            .scrollTo(
              index: targetIndex,
              alignment: hiddenTopFraction,
              duration: const Duration(milliseconds: 1),
            )
            .whenComplete(() {
              if (generation == _generation) _isComplete = true;
            });
      });
      WidgetsBinding.instance.scheduleFrame();
    });
  }
}
