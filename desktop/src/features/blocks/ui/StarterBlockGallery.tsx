import type { BlockManifest } from "../contracts";
import {
  BlockPrimitive,
  type BlockActionEnvironment,
  type BlockPrimitiveNode,
} from "./primitives";

export type StarterBlockGalleryEntry = {
  data: unknown;
  manifest: BlockManifest;
};

/**
 * Test-only gallery for proving that every relay-bundled starter composite
 * renders through the closed native primitive grammar.
 */
export function StarterBlockGallery({
  entries,
}: {
  entries: readonly StarterBlockGalleryEntry[];
}) {
  return (
    <div data-starter-block-gallery>
      {entries.map(({ data, manifest }) => {
        const declaredActionIds = new Set(
          manifest.actions.map((action) => action.id),
        );
        const environment: BlockActionEnvironment = {
          actionUnavailableReasons: new Map(),
          completedActionIds: new Set(),
          declaredActionIds,
          directActionIds: declaredActionIds,
          origin: manifest.origin,
          resolvingActionIds: new Set(
            manifest.actions.flatMap((action) =>
              action.interaction.type === "signed" &&
              action.interaction.resolves_attention
                ? [action.id]
                : [],
            ),
          ),
          trusted: true,
          openPresentation: async () => {},
          submitSigned: async () => {},
        };

        return (
          <article data-starter-block={manifest.handle} key={manifest.handle}>
            <BlockPrimitive
              context={{
                actionEnvironment: environment,
                data,
                rootData: data,
              }}
              node={manifest.tree as BlockPrimitiveNode}
            />
          </article>
        );
      })}
    </div>
  );
}
