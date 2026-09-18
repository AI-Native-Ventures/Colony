part of '../compose_bar.dart';

/// Docks the composer's suggestion and attachment surfaces above the bar.
///
/// The panel rides in an overlay so it can escape the composer's own clip,
/// and it is anchored to the composer's painted origin so it tracks the bar
/// as the keyboard and attachment surfaces resize it.
class _ComposerOverlayPortal extends StatelessWidget {
  final OverlayPortalController controller;
  final ValueListenable<_AttachmentSurface> attachmentSurface;
  final bool reducedMotion;
  final Widget Function(_AttachmentSurface surface) buildOverlayPanel;
  final Widget child;

  const _ComposerOverlayPortal({
    required this.controller,
    required this.attachmentSurface,
    required this.reducedMotion,
    required this.buildOverlayPanel,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    return OverlayPortal.overlayChildLayoutBuilder(
      controller: controller,
      overlayChildBuilder: (context, layoutInfo) {
        final composerOrigin = MatrixUtils.transformPoint(
          layoutInfo.childPaintTransform,
          Offset.zero,
        );
        return ValueListenableBuilder<_AttachmentSurface>(
          valueListenable: attachmentSurface,
          builder: (context, surface, _) {
            final surfaceDuration = reducedMotion
                ? Duration.zero
                : Duration(
                    milliseconds:
                        surface == _AttachmentSurface.camera ||
                            surface == _AttachmentSurface.photos
                        ? 320
                        : 250,
                  );
            // The tall surfaces cover the composer, so they anchor above it
            // rather than to its top edge.
            final expandedSurfaceCoversComposer =
                surface == _AttachmentSurface.camera ||
                surface == _AttachmentSurface.photos;
            final overlayAnchorY =
                composerOrigin.dy +
                (expandedSurfaceCoversComposer
                    ? layoutInfo.childSize.height + Grid.twelve
                    : 0);
            return AnimatedPositioned(
              duration: surfaceDuration,
              curve: expandedSurfaceCoversComposer
                  ? const Cubic(0.34, 1.25, 0.64, 1)
                  : const Cubic(0.22, 1, 0.36, 1),
              left: composerOrigin.dx,
              bottom: layoutInfo.overlaySize.height - overlayAnchorY,
              width: layoutInfo.childSize.width,
              child: ClipRect(
                child: Padding(
                  padding: const EdgeInsets.only(bottom: Grid.xxs),
                  child: surface == _AttachmentSurface.closed
                      ? _SuggestionPanelMotion(
                          duration: surfaceDuration,
                          alignment: Alignment.bottomLeft,
                          child: buildOverlayPanel(surface),
                        )
                      : buildOverlayPanel(surface),
                ),
              ),
            );
          },
        );
      },
      child: child,
    );
  }
}
