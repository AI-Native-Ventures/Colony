/** @type {import('tailwindcss').Config} */
export default {
  theme: {
    extend: {
      colors: {
        colony: {
          violet: "hsl(258 90% 66%)",
          blue: "hsl(217 91% 60%)",
          pink: "hsl(330 81% 60%)",
          amber: "hsl(38 92% 50%)",
          green: "hsl(160 60% 45%)",
          // Dynamic tokens: index.html's inline script sets these on
          // documentElement.style before first paint (the random-hue
          // mechanic). See src/brand/hue.ts.
          canvas: "var(--colony-canvas)",
          accent: "var(--colony-accent)",
          ink: "#171717",
        },
      },
    },
  },
};
