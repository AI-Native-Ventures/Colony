import type { CSSProperties } from "react";

const scenes = [
  {
    name: "bloom",
    colours: ["#c8b2fa", "#f3bbd9", "#a7d4f3", "#f4d4a7", "#b6e5d5"],
  },
  {
    name: "lagoon",
    colours: ["#afe5d5", "#abcdf5", "#c6b7f4", "#f4c5d8", "#f1dfb5"],
  },
  {
    name: "daybreak",
    colours: ["#f4cbb5", "#d6b9ef", "#b4dfd7", "#adcdf4", "#f0c5dd"],
  },
  {
    name: "meadow",
    colours: ["#b8c9f4", "#b9e4cd", "#e8bce2", "#eed6ad", "#b5def0"],
  },
];

let selectedScene: { name: string; style: CSSProperties } | undefined;

/** Choose once per document, including React's development double render. */
export function getBrandScene() {
  if (selectedScene) return selectedScene;
  let previous = -1;
  try {
    const saved = sessionStorage.getItem("colony-landing-scene");
    if (saved !== null) previous = Number(saved);
  } catch {
    // A blocked storage policy must not prevent the page from rendering.
  }
  const choices = scenes
    .map((_, index) => index)
    .filter((index) => index !== previous);
  const index = choices[Math.floor(Math.random() * choices.length)];
  try {
    sessionStorage.setItem("colony-landing-scene", String(index));
  } catch {
    // The random blend still works without remembering the previous visit.
  }
  const scene = scenes[index];
  selectedScene = {
    name: scene.name,
    style: Object.fromEntries(
      scene.colours.map((colour, i) => [`--scene-${i + 1}`, colour]),
    ) as CSSProperties,
  };
  return selectedScene;
}
