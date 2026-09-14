import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const mergeClassNames = extendTailwindMerge({
  extend: {
    classGroups: {
      // `rounded-squircle` is a clip-path utility, not a radius, so
      // tailwind-merge has to treat it as part of the radius group or a later
      // `rounded-full` would not replace it (and vice versa).
      rounded: ["rounded-squircle"],
      "font-size": [
        {
          text: ["message", "message-timestamp"],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return mergeClassNames(clsx(inputs));
}
