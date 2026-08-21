/**
 * The one content collection: Starlight's `docs`.
 *
 * `docsLoader()` reads `src/content/docs/`, which is **generated** — see
 * `scripts/sync-docs.mjs` for what puts it there and why the projection exists
 * instead of pointing a loader straight at `../content`.
 */
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import { defineCollection } from "astro:content";

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
