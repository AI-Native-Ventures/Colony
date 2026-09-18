import 'package:buzz/features/channels/ime_metrics_settle_observer.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  tearDown(() => debugDefaultTargetPlatformOverride = null);

  test('coalesces a burst of Android metrics into one callback', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    var settled = 0;
    final observer = ImeMetricsSettleObserver(
      onMetricsSettled: () => settled++,
      androidSettleDelay: const Duration(milliseconds: 20),
    );
    addTearDown(observer.dispose);

    // Android sends metrics throughout the keyboard animation; realigning on
    // each delivery competes with the transition.
    for (var i = 0; i < 5; i++) {
      observer.didChangeMetrics();
    }
    expect(settled, 0);

    await Future<void>.delayed(const Duration(milliseconds: 60));
    expect(settled, 1);
  });

  test('restarts the quiet period when metrics keep arriving', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    var settled = 0;
    final observer = ImeMetricsSettleObserver(
      onMetricsSettled: () => settled++,
      androidSettleDelay: const Duration(milliseconds: 40),
    );
    addTearDown(observer.dispose);

    observer.didChangeMetrics();
    await Future<void>.delayed(const Duration(milliseconds: 25));
    observer.didChangeMetrics();
    await Future<void>.delayed(const Duration(milliseconds: 25));

    // The second delivery reset the timer, so nothing has settled yet.
    expect(settled, 0);

    await Future<void>.delayed(const Duration(milliseconds: 40));
    expect(settled, 1);
  });

  test('reports immediately off Android', () {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    var settled = 0;
    final observer = ImeMetricsSettleObserver(
      onMetricsSettled: () => settled++,
    );
    addTearDown(observer.dispose);

    observer.didChangeMetrics();
    observer.didChangeMetrics();

    expect(settled, 2);
  });

  test('dispose cancels a pending settle', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    var settled = 0;
    final observer = ImeMetricsSettleObserver(
      onMetricsSettled: () => settled++,
      androidSettleDelay: const Duration(milliseconds: 20),
    );

    observer.didChangeMetrics();
    observer.dispose();
    await Future<void>.delayed(const Duration(milliseconds: 60));

    expect(settled, 0);
  });
}
