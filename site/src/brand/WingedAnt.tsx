// site/src/brand/WingedAnt.tsx
// Winged variant of the Colony ant mark, used ONLY by ScatterField. Alates
// (winged ants) are a real caste, and a hero backdrop of ants scattered
// mid-air reads as a swarm in flight rather than ants walking on nothing.
// AntMark.tsx and WalkingAnt.tsx geometry stay exactly as documented in
// docs/BRAND.md; this component wraps WalkingAnt unmodified and layers two
// translucent wing shapes on top of it, each on its own HTML-level wrapper
// so the flap transform runs on the compositor. Same constraint
// WalkingAnt's leg layers follow and for the same WebKit reason: transforms
// on SVG children freeze under main-thread load, transforms on HTML
// wrappers don't (see docs/BRAND.md "Technical constraints").
import { WalkingAnt } from "./WalkingAnt";
import "./site-animations.css";

// Wing shapes are drawn in the same 0 0 466 309 coordinate space as the
// body (see AntMark.tsx) so they align without extra math: an ellipse
// anchored up and back of the thorax (cx=226 cy=164), over the abdomen,
// rotated to a raked angle. Two overlapping ellipses (a larger hind wing
// behind, a smaller fore wing in front) read as a pair of insect wings.
const HIND_WING = { cx: 150, cy: 90, rx: 95, ry: 34, rotate: -24 };
const FORE_WING = { cx: 178, cy: 112, rx: 78, ry: 27, rotate: -17 };

// The flap pivots around the thorax attachment point, expressed as a
// percentage of the 466x309 box (226/466, 164/309), same technique
// site-animations.css already uses for the leg tripods' hip pivot.
const THORAX_ORIGIN = "48.5% 53.1%";

function Wing({
  shape,
  opacity,
  wrapperClassName,
}: {
  shape: typeof HIND_WING;
  opacity: number;
  wrapperClassName: string;
}) {
  return (
    <div
      className={`ant-wing absolute inset-0 ${wrapperClassName}`}
      style={{ transformOrigin: THORAX_ORIGIN }}
    >
      <svg
        aria-hidden="true"
        className="block h-full w-full"
        viewBox="0 0 466 309"
      >
        <ellipse
          cx={shape.cx}
          cy={shape.cy}
          rx={shape.rx}
          ry={shape.ry}
          transform={`rotate(${shape.rotate} ${shape.cx} ${shape.cy})`}
          fill="currentColor"
          fillOpacity={opacity}
        />
      </svg>
    </div>
  );
}

export function WingedAnt({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={["ant-winged", "relative", "aspect-[466/309]", className]
        .filter(Boolean)
        .join(" ")}
    >
      <Wing shape={HIND_WING} opacity={0.3} wrapperClassName="ant-wing-hind" />
      <Wing shape={FORE_WING} opacity={0.45} wrapperClassName="ant-wing-fore" />
      {/* Body last so it paints over both wing roots, same ordering
          WalkingAnt uses for its own leg roots. */}
      <div className="absolute inset-0 h-full w-full">
        <WalkingAnt className="h-full w-full" />
      </div>
    </div>
  );
}
