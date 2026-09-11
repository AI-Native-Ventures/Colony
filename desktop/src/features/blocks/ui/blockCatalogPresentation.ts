import type { BlockCatalogItem } from "@/features/blocks/blockCatalog";

/** Browsing groups derived from publisher origin and primitive identity. */
export type BlockCatalogCategory =
  | "all"
  | "primitives"
  | "composites"
  | "custom";

/** Category metadata never changes the renderer or the publisher's authority. */
export function blockCatalogCategory(
  item: BlockCatalogItem,
): Exclude<BlockCatalogCategory, "all"> {
  if (item.origin !== "core" || item.manifestRecord.trust !== "core")
    return "custom";
  return item.handle === item.manifestRecord.manifest.tree.type
    ? "primitives"
    : "composites";
}

/** Match names, handles and descriptions while retaining catalog ordering. */
export function filterBlockCatalog(
  items: readonly BlockCatalogItem[],
  query: string,
  category: BlockCatalogCategory,
): readonly BlockCatalogItem[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (category !== "all" && blockCatalogCategory(item) !== category)
      return false;
    const description =
      `${item.name} ${item.handle} ${item.summary}`.toLocaleLowerCase();
    return words.every((word) => description.includes(word));
  });
}
