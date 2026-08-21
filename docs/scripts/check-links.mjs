/**
 * Every internal link in the **built site** resolves — page and anchor both.
 *
 * `tests/scripts/docs_links.test.mjs` already holds every link in `content/` to a file
 * and a heading that exist. This is the other half, and neither covers it: that gate
 * reads the Markdown *before* `sync-docs.mjs` rewrites it, so a rewrite that turns a
 * good `../CONTRIBUTING.md` into a URL pointing nowhere passes it untouched. What is
 * checked here is what a reader actually clicks.
 *
 * It runs over `dist/`, after `astro build`, for the same reason: the mapping from
 * `api.md` to `/api/` is Starlight's routing decision, and reimplementing it here to
 * predict the answer would just be a second copy free to disagree with the first.
 *
 * **External URLs are out of scope**, the rule the Markdown gate already states: a
 * check that fails for somebody else's rate limit is one people learn to re-run
 * rather than read. That includes every `github.com/Robomous/VisionSet/blob/…` link
 * the projection writes — which is why `sync-docs.mjs` derives those from a path it
 * has already resolved against the real tree, rather than from a guess.
 *
 * Usage:
 *
 *     node scripts/check-links.mjs        # after `pnpm build`
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(SITE_ROOT, "dist");

/** Every built page, as `dist`-relative paths. */
function pages(dir = DIST, prefix = "") {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...pages(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith(".html")) found.push(rel);
  }
  return found;
}

/**
 * Every `href` in a document that names somewhere on this site.
 *
 * Anything with a scheme or a `//` prefix belongs to somebody else; a `mailto:` is
 * caught by the same test.
 */
function internalLinks(html) {
  const found = [];
  for (const match of html.matchAll(/<a\b[^>]*?\bhref="([^"]*)"/g)) {
    const href = match[1];
    if (href === "" || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) continue;
    found.push(href);
  }
  return found;
}

/** Every `id` a page offers, which is what an anchor has to land on. */
function idsIn(html) {
  return new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
}

/** The file that answers a site-absolute path, or `null`. */
function fileFor(sitePath) {
  const clean = sitePath.replace(/^\//, "").replace(/\/$/, "");
  for (const candidate of [path.join(DIST, clean, "index.html"), path.join(DIST, `${clean}.html`)]) {
    if (existsSync(candidate)) return candidate;
  }
  return clean === "" && existsSync(path.join(DIST, "index.html")) ? path.join(DIST, "index.html") : null;
}

if (!existsSync(DIST)) {
  console.error("dist/ is not there — run 'pnpm build' first");
  process.exit(2);
}

const idCache = new Map();
const idsFor = (file) => {
  if (!idCache.has(file)) idCache.set(file, idsIn(readFileSync(file, "utf8")));
  return idCache.get(file);
};

const broken = [];
let checked = 0;

for (const page of pages()) {
  const html = readFileSync(path.join(DIST, page), "utf8");
  for (const href of internalLinks(html)) {
    checked += 1;
    const hash = href.indexOf("#");
    const where = hash < 0 ? href : href.slice(0, hash);
    const fragment = hash < 0 ? "" : decodeURIComponent(href.slice(hash + 1));

    // A bare `#fragment` is this page. Starlight's own table of contents is full
    // of them, and they are exactly as worth checking as any other.
    const target = where === "" ? path.join(DIST, page) : fileFor(where);
    if (target === null) {
      broken.push(`${page} → ${href}  (no page is served at ${where})`);
      continue;
    }
    if (fragment !== "" && !idsFor(target).has(fragment)) {
      broken.push(`${page} → ${href}  (nothing in ${path.relative(DIST, target)} has id "${fragment}")`);
    }
  }
}

if (broken.length > 0) {
  console.error(`internal links pointing at nothing:\n  ${broken.sort().join("\n  ")}`);
  process.exit(1);
}

// A scan that silently found nothing would agree with an empty list. `content/` alone
// cross-references itself hundreds of times, so anything near zero means this is
// not reading the pages.
if (checked < 200) {
  console.error(`only ${checked} internal links found — the scan is not reading the built pages`);
  process.exit(1);
}

console.error(`${checked} internal links across ${pages().length} pages, all resolve`);
