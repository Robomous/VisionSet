/**
 * The one thing that keeps `src/content/docs/` in agreement with `content/`.
 *
 * `scripts/sync-docs.mjs` does the work; this decides *when*. Two moments, because
 * there are two ways this site is built:
 *
 *   `astro:config:setup`  every `dev`, `build` and `preview` starts from a current
 *                         projection, so a clean checkout needs no `pnpm sync`
 *                         first and CI cannot build a stale site
 *   `astro:server:setup`  the dev server re-projects `content/` on every change
 *
 * `content/` sits inside this project's root, so Vite already watches it — but a
 * change there has to be *projected* before Astro sees a page move, and that is
 * what the watcher hook does: it re-runs the sync, which writes into
 * `src/content/docs/`, and Astro's own content-layer HMR takes it from there.
 *
 * `sync()` writes a file only when its bytes change, which is what makes this cheap
 * enough to run on every event: one edit moves one page.
 */

import path from "node:path";

import { DOCS_DIR, sync } from "../scripts/sync-docs.mjs";

export default function docsSource() {
  return {
    name: "visionset-docs-source",
    hooks: {
      "astro:config:setup": ({ logger }) => {
        const { total } = sync();
        logger.info(`projected ${total} pages from ${path.relative(process.cwd(), DOCS_DIR)}`);
      },

      "astro:server:setup": ({ server, logger }) => {
        server.watcher.add(DOCS_DIR);

        const changed = (file) => {
          // The watcher also carries this project's own tree, and a rebuild
          // triggered by the file we just wrote is a loop.
          if (!file.startsWith(`${DOCS_DIR}${path.sep}`) || !file.endsWith(".md")) return;
          const { written, removed } = sync();
          if (written.length + removed.length === 0) return;
          logger.info(`content/${path.relative(DOCS_DIR, file)} → ${[...written, ...removed].join(", ")}`);
        };

        for (const event of ["add", "change", "unlink"]) server.watcher.on(event, changed);
      },
    },
  };
}
