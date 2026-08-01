import 'dart:math' show cos, min, pi;

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

/// The Colony ant drawn as a winged alate, whose wings flutter twice when the
/// user taps it.
///
/// Body, leg, and antenna geometry is the canonical Colony mark shared with
/// desktop and web (`desktop/src/shared/ui/colony-logo/AntMark.tsx`), in the
/// same 466x309 coordinate space. The wings are the alate variant from
/// `site/src/brand/WingedAnt.tsx`. When reduced motion is enabled, the mark
/// stays static in its rest pose.
///
/// The site's wings run out of phase with each other, which this does not: a
/// tap plays a bounded two-flap burst that has to start and end at rest, and
/// an offset wing would be caught mid-stroke at both ends. The wings still
/// counter-rotate and squash by different amounts, which is what stops them
/// reading as one rigid plate.
class TappableFlappingAnt extends HookConsumerWidget {
  /// The rendered width of the complete ant mark.
  final double width;

  /// The color used for the ant silhouette.
  final Color color;

  const TappableFlappingAnt({
    required this.width,
    required this.color,
    super.key,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final animation = useAnimationController(
      duration: const Duration(milliseconds: 480),
    );
    final reducedMotion = MediaQuery.disableAnimationsOf(context);

    void flutterWings() {
      if (reducedMotion) return;
      animation.forward(from: 0);
    }

    return Semantics(
      button: true,
      label: 'Colony ant',
      hint: 'Tap to make its wings flutter',
      onTap: flutterWings,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        excludeFromSemantics: true,
        onTap: flutterWings,
        child: RepaintBoundary(
          child: AnimatedBuilder(
            animation: animation,
            builder: (context, _) {
              final flapAmount = 0.5 - (0.5 * cos(animation.value * 4 * pi));
              return CustomPaint(
                size: Size(width, width * 309 / 466),
                painter: _FlappingAntPainter(
                  color: color,
                  flapAmount: flapAmount,
                ),
              );
            },
          ),
        ),
      ),
    );
  }
}

/// One wing: a translucent ellipse at a fixed rest position over the abdomen,
/// which a flap rotates by [flapRotation] degrees and squashes to
/// [flapScaleY] about the thorax.
class _Wing {
  final Offset center;
  final double radiusX;
  final double radiusY;
  final double restRotation;
  final double opacity;
  final double flapRotation;
  final double flapScaleY;

  const _Wing({
    required this.center,
    required this.radiusX,
    required this.radiusY,
    required this.restRotation,
    required this.opacity,
    required this.flapRotation,
    required this.flapScaleY,
  });
}

/// The thorax attachment the flap pivots around, matching the body geometry.
/// The site expresses the same point as a percentage (226/466, 164/309).
const _thorax = Offset(226, 164);

/// Wing shapes and flap values are ported verbatim from the marketing site's
/// `site/src/brand/WingedAnt.tsx` and `site-animations.css`, so the alate
/// reads identically on both surfaces. The larger wing sits behind at a lower
/// opacity; the two counter-rotate so they never read as one rigid plate.
const _hindwing = _Wing(
  center: Offset(150, 90),
  radiusX: 95,
  radiusY: 34,
  restRotation: -24,
  opacity: 0.30,
  flapRotation: -6,
  flapScaleY: 0.72,
);
const _forewing = _Wing(
  center: Offset(178, 112),
  radiusX: 78,
  radiusY: 27,
  restRotation: -17,
  opacity: 0.45,
  flapRotation: 6,
  flapScaleY: 0.68,
);

class _FlappingAntPainter extends CustomPainter {
  final Color color;
  final double flapAmount;

  const _FlappingAntPainter({required this.color, required this.flapAmount});

  @override
  void paint(Canvas canvas, Size size) {
    final scale = min(size.width / 466, size.height / 309);
    final renderedWidth = 466 * scale;
    final renderedHeight = 309 * scale;

    canvas
      ..save()
      ..translate(
        (size.width - renderedWidth) / 2,
        (size.height - renderedHeight) / 2,
      )
      ..scale(scale);

    // Wings first, then legs and antennae, then the body, so the body always
    // reads clean over the wing and leg roots. The two wings are told apart by
    // their opacities rather than an outline, matching the site.
    _paintWing(canvas, _hindwing);
    _paintWing(canvas, _forewing);

    final limbs = Path()
      ..moveTo(202, 203)
      ..lineTo(136, 292)
      ..moveTo(220, 210)
      ..lineTo(196, 298)
      ..moveTo(235, 209)
      ..lineTo(246, 300)
      ..moveTo(247, 205)
      ..lineTo(294, 294)
      ..moveTo(257, 198)
      ..lineTo(336, 282)
      ..moveTo(164, 215)
      ..lineTo(112, 272)
      ..moveTo(327, 114)
      ..quadraticBezierTo(345, 64, 397, 50)
      ..moveTo(343, 126)
      ..quadraticBezierTo(377, 86, 427, 80);
    final limbPaint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 14
      ..strokeCap = StrokeCap.round;

    final body = Path()
      ..addOval(Rect.fromCircle(center: const Offset(104, 172), radius: 80))
      ..addOval(Rect.fromCircle(center: const Offset(226, 164), radius: 52))
      ..addOval(Rect.fromCircle(center: const Offset(313, 148), radius: 46));
    final eye = Path()
      ..addOval(Rect.fromCircle(center: const Offset(335, 136), radius: 11));

    canvas
      ..drawPath(limbs, limbPaint)
      ..drawPath(
        Path.combine(PathOperation.difference, body, eye),
        Paint()..color = color,
      )
      ..restore();
  }

  void _paintWing(Canvas canvas, _Wing wing) {
    // The flap is the site's `rotate(...) scaleY(...)` about the thorax. A CSS
    // transform list applies right to left, so the squash happens before the
    // rotation; the canvas calls below compose in that same order.
    final flapRadians = wing.flapRotation * flapAmount * pi / 180;
    final squash = 1 - ((1 - wing.flapScaleY) * flapAmount);

    canvas
      ..save()
      ..translate(_thorax.dx, _thorax.dy)
      ..rotate(flapRadians)
      ..scale(1, squash)
      ..translate(-_thorax.dx, -_thorax.dy)
      // Then the wing's own fixed rest pose, about its own centre.
      ..translate(wing.center.dx, wing.center.dy)
      ..rotate(wing.restRotation * pi / 180)
      ..drawOval(
        Rect.fromCenter(
          center: Offset.zero,
          width: wing.radiusX * 2,
          height: wing.radiusY * 2,
        ),
        Paint()..color = color.withValues(alpha: color.a * wing.opacity),
      )
      ..restore();
  }

  @override
  bool shouldRepaint(_FlappingAntPainter oldDelegate) =>
      color != oldDelegate.color || flapAmount != oldDelegate.flapAmount;
}
