import { readFileSync } from "node:fs";
import {
  readCoreManifest,
  trustedWorkspaceManifest,
} from "./blocks-test-helpers";

// Sample work for the visual comparison, assembled through the existing
// schema-driven renderer. No production post template or workflow is added.
export const POST_PREVIEW = trustedWorkspaceManifest(
  readCoreManifest("artifact"),
  {
    handle: "brand-post-preview",
    name: "Post and caption",
    description: "A sample brand post for the approved workspace comparison.",
    tree: {
      type: "card",
      title: "Post + caption",
      children: [
        {
          type: "grid",
          columns: 2,
          gap: "large",
          children: [
            {
              type: "media",
              url_path: "/url",
              alt: "Horizon Labs sample post: A brand people remember.",
            },
            {
              type: "section",
              title: "Caption draft",
              text: "{{description}}",
            },
          ],
        },
      ],
    },
    actions: [],
    permissions: [],
    primitive_versions: { card: 1, media: 1, section: 1 },
  },
);

export const POST_IMAGE_URL = "https://redesign.example.test/horizon-post.png";
export const POST_IMAGE = readFileSync(
  new URL("../fixtures/redesign/horizon-post.png", import.meta.url),
);
