import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CUSTOM_GRADIENT,
  parseCustomGradient,
  customGradientStops,
} from "./customGradient.ts";

test("validates both custom gradient colors before they reach CSS", () => {
  const valid = { enabled: true, color1: "#123456", color2: "#abcdef" };
  assert.deepEqual(parseCustomGradient(valid), valid);
  for (const invalid of [
    null,
    [],
    {},
    { ...valid, enabled: "true" },
    { ...valid, color1: "red" },
    { ...valid, color2: "url(https://example.com)" },
    { ...valid, color1: "#12345g" },
  ]) {
    assert.equal(parseCustomGradient(invalid), null);
  }
});

test("default mode does not override the existing gradient", () => {
  assert.equal(customGradientStops(DEFAULT_CUSTOM_GRADIENT), null);
});

test("custom stops use both colors and adapt for light and dark chrome", () => {
  const stops = customGradientStops({
    enabled: true,
    color1: "#ff0000",
    color2: "#0000ff",
  });
  assert.deepEqual(stops, {
    lightTop: "#ffbdbd",
    lightBottom: "#bdbdff",
    darkTop: "#400000",
    darkBottom: "#000040",
  });
});

test("identical colors produce a solid surface, including black and white", () => {
  for (const color of ["#000000", "#ffffff", "#895AF6"]) {
    const stops = customGradientStops({
      enabled: true,
      color1: color,
      color2: color,
    });
    assert.equal(stops.lightTop, stops.lightBottom);
    assert.equal(stops.darkTop, stops.darkBottom);
    for (const channel of stops.lightTop.slice(1).match(/../g))
      assert.ok(Number.parseInt(channel, 16) >= 189);
    for (const channel of stops.darkTop.slice(1).match(/../g))
      assert.ok(Number.parseInt(channel, 16) <= 64);
  }
});
