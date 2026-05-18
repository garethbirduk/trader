import type { InsertItemKindInput } from "../../engine/stock/items-repo.js";
import { loadSkinJson } from "./cast.js";

/**
 * Everyday item catalogue — loaded from ./data/items.json at module
 * load. JSON shape matches `InsertItemKindInput` directly so no
 * conversion is needed beyond a typed parse.
 */
export const EVERYDAY_ITEMS: readonly InsertItemKindInput[] = loadSkinJson<
  readonly InsertItemKindInput[]
>("data/items.json");
