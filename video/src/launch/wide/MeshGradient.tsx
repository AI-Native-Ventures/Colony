import { WIDE_H, WIDE_W } from "./beat.ts";
import {
  LIGHT_WORLD,
  PALETTES,
  type Palette,
  type PaletteId,
  type PaletteStop,
  paletteWeights,
} from "./mesh.ts";

/** One palette: soft colour fields drifting slowly, a pale band woven across them. */
export const MeshGradient: React.FC<{
  palette: Palette;
  t: number;
  opacity?: number;
  width?: number;
  height?: number;
}> = ({ palette, t, opacity = 1, width = WIDE_W, height = WIDE_H }) => {
  const sway = 2 * Math.sin(t * 0.15);
  const { band } = palette;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        background: palette.base,
        opacity,
      }}
    >
      {palette.blobs.map((blob, i) => {
        const x = blob.x + 2.5 * Math.sin(t * 0.21 + i * 1.7);
        const y = blob.y + 2 * Math.cos(t * 0.17 + i * 2.3);
        const w = (blob.rx / 50) * width;
        const h = (blob.ry / 50) * height;
        return (
          <div
            key={`${blob.color}-${blob.x}-${blob.y}`}
            style={{
              position: "absolute",
              left: (x / 100) * width - w / 2,
              top: (y / 100) * height - h / 2,
              width: w,
              height: h,
              background: `radial-gradient(closest-side, ${blob.color} 0%, ${blob.color} 32%, transparent 100%)`,
            }}
          />
        );
      })}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `linear-gradient(${band.angle}deg, transparent ${(band.from - 14 + sway).toFixed(2)}%, ${band.color} ${((band.from + band.to) / 2 + sway).toFixed(2)}%, transparent ${(band.to + 14 + sway).toFixed(2)}%)`,
        }}
      />
    </div>
  );
};

/** The light world behind the opening and the close, crossfading between palettes. */
export const LightWorld: React.FC<{
  t: number;
  stops?: readonly PaletteStop[];
  /** The frame; the wide film's unless given. */
  width?: number;
  height?: number;
}> = ({ t, stops = LIGHT_WORLD, width, height }) => (
  <>
    {paletteWeights(t, stops).map(({ id, weight }, i) => (
      <MeshGradient
        key={id as PaletteId}
        palette={PALETTES[id]}
        t={t}
        opacity={i === 0 ? 1 : weight}
        width={width}
        height={height}
      />
    ))}
  </>
);
