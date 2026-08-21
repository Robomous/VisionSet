/**
 * Project `content/` into the content collection Starlight reads, deterministically.
 *
 * **`content/` is the only source of truth.** It is plain Markdown, it renders on
 * GitHub, and a tool or an agent reads it with nothing installed. Starlight is a
 * rendering layer over it, never a second copy — so this script is the whole of the
 * relationship between the two, and everything it writes is git-ignored.
 *
 * ## Why a projection rather than pointing Starlight at `content/`
 *
 * Astro's `glob()` loader will happily take `base: "./content"`, and that was the
 * first thing tried. Two things in Starlight's content model refuse it, and neither
 * is worth bending `docs/` around:
 *
 *   1. `docsSchema()` **requires** a `title`. Adding `title:` frontmatter to
 *      forty-two files would put a YAML table at the top of every page GitHub
 *      renders, to say the thing the `# H1` on the next line already says.
 *   2. Starlight renders the frontmatter title as the page's `<h1>`. Left in place,
 *      each document's own `# H1` becomes a **second** `<h1>` — two titles on every
 *      page, and an outline that lies.
 *
 * So the transform is exactly those two facts and nothing else: **the first `# H1`
 * becomes the title and is removed from the body.** No prose is touched, no heading
 * below the first is moved, no content is rewritten. Feed it a document and the
 * output is a function of that document alone.
 *
 * ## Links
 *
 * A link is rewritten only where leaving it alone would break it:
 *
 *     install.md              → /install/       a sibling page of this site
 *     architecture/README.md  → /architecture/  a directory's index
 *     ../../src/visionset/    → GitHub tree/    code, which this site does not host
 *     ../../CONTRIBUTING.md   → GitHub blob/    a repository file, likewise
 *     https://…, #anchor      → untouched
 *
 * Fragments survive: Astro slugs headings with github-slugger, the same algorithm
 * GitHub uses and the one `tests/scripts/docs_links.test.mjs` reimplements, so an
 * anchor that resolves on GitHub resolves here.
 *
 * Nothing inside a fenced block or an inline code span is rewritten, and no `#` line
 * inside one is mistaken for the title. `content/cli.md` holds shell transcripts, where
 * a path is output rather than a link and `# comment` opens a bash block — the same
 * rule the link gate follows, for the same reason.
 *
 * ## Determinism
 *
 * Same tree in, same bytes out — no timestamp, no version, no ordering that depends
 * on the filesystem. A file is written only when its content actually changes, and a
 * generated page whose source has gone is deleted, so an edit in the dev server
 * moves the one file it touched rather than rewriting forty-two and reloading the
 * whole site.
 *
 * Usage:
 *
 *     node scripts/sync-docs.mjs           # write it
 *     node scripts/sync-docs.mjs --check   # fail if what is on disk differs
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** `docs/` — the site, and the corpus it renders. */
export const SITE_ROOT = path.resolve(HERE, "..");

/** The repository root — the code every out-of-corpus link points into. */
export const REPO_ROOT = path.resolve(SITE_ROOT, "..");

/** The canonical documentation, repository-relative. Read only; this script never writes here. */
const CORPUS = "docs/content";

/** The same, absolute. */
export const DOCS_DIR = path.join(REPO_ROOT, CORPUS);

/** Where the projection lands. Generated, git-ignored, never edited by hand. */
export const CONTENT_DIR = path.join(SITE_ROOT, "src", "content", "docs");

/**
 * Where a link that leaves `docs/` is sent instead.
 *
 * `main` rather than a tag: these point at code, and a reader following one wants
 * the code as it is now, not as it was when a release was cut.
 */
const GITHUB = "https://github.com/Robomous/VisionSet";
const GITHUB_BRANCH = "main";

/** Every Markdown file under `docs/`, relative to it, in a stable order. */
export function documentPaths(dir = DOCS_DIR, prefix = "") {
  const found = [];
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...documentPaths(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith(".md")) found.push(rel);
  }
  return found;
}

/**
 * Every line of a document, each flagged as prose or as fenced code.
 *
 * One walker for both passes below, because both have to ignore a fence and both
 * used to get it wrong in the same way: a `#` opening a bash block is a heading to
 * anything that cannot see the fence around it, and a path in a shell transcript is
 * output rather than a link. The opening and closing fence lines count as code, so
 * neither pass can touch them either.
 */
function* lines(source) {
  let fence = null;
  for (const line of source.split("\n")) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (marker !== null) {
        fence = marker[1][0];
        yield { line, code: true };
        continue;
      }
      yield { line, code: false };
      continue;
    }
    yield { line, code: true };
    if (marker !== null && marker[1][0] === fence) fence = null;
  }
}

/**
 * The first prose `# H1`, and the document without it.
 *
 * Only the first moves. A document carrying a second `# H1` keeps it — that is a
 * documentation problem, and silently repairing it here would hide it.
 */
export function splitTitle(source) {
  const kept = [];
  let title = null;
  for (const { line, code } of lines(source)) {
    if (title === null && !code) {
      const heading = /^#\s+(\S.*?)\s*$/.exec(line);
      if (heading !== null) {
        title = heading[1].replace(/\s+#+$/, "").trim();
        continue;
      }
    }
    kept.push(line);
  }
  return { title, body: kept.join("\n") };
}

/** Is this somebody else's URL, or an anchor into this same page? */
function external(target) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target);
}

/** Does this repository-relative path name a directory? */
function isDirectory(repoRelative) {
  try {
    return statSync(path.join(REPO_ROOT, repoRelative)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where a `docs/`-relative document is served from.
 *
 * `README.md` is a directory's index, which is what makes `content/README.md` the
 * site's home page and `architecture/README.md` the page `architecture/` links to.
 */
export function sitePath(docsRelative) {
  const parts = docsRelative.replace(/\.md$/, "").split("/").filter((part) => part !== "");
  if (parts[parts.length - 1] === "README") parts.pop();
  return parts.length === 0 ? "/" : `/${parts.join("/")}/`;
}

/**
 * One link target, as this site should spell it.
 *
 * The three outcomes are the three kinds of destination a link in the corpus has: a
 * page of this site, a file of this repository, and somewhere else entirely.
 */
export function rewriteTarget(target, fromDocsRelative) {
  if (external(target)) return target;

  const hash = target.indexOf("#");
  const where = hash < 0 ? target : target.slice(0, hash);
  const fragment = hash < 0 ? "" : target.slice(hash);
  if (where === "") return target;

  // Resolved against the repository root, so a target that climbs out of the
  // corpus is simply a path that does not start with it.
  const fromDir = path.posix.dirname(path.posix.join(CORPUS, fromDocsRelative));
  const repoRelative = path.posix.normalize(path.posix.join(fromDir, where));

  if (repoRelative === CORPUS || repoRelative === `${CORPUS}/`) return `/${fragment}`;
  if (repoRelative.startsWith(`${CORPUS}/`)) {
    const inDocs = repoRelative.slice(CORPUS.length + 1);
    if (isDirectory(repoRelative)) return `${sitePath(inDocs)}${fragment}`;
    if (inDocs.endsWith(".md")) return `${sitePath(inDocs)}${fragment}`;
    // Anything else under the corpus is a file this site does not serve, so it
    // falls through to the repository below like any other.
  }

  const kind = where.endsWith("/") || isDirectory(repoRelative) ? "tree" : "blob";
  return `${GITHUB}/${kind}/${GITHUB_BRANCH}/${repoRelative.replace(/\/+$/, "")}${fragment}`;
}

/**
 * The two kinds of region a link must not be rewritten inside, as `[start, end)`
 * offsets into the whole document.
 *
 * **Offsets rather than a filtered copy of the text, because a link is not a
 * line-sized thing.** Two shapes in `docs/` prove it, and each broke a draft of
 * this function:
 *
 *   ``[`src/visionset/kernel/`](../../../src/visionset/kernel/)``
 *       the *label* is a code span. Split the line on spans and rewrite the pieces
 *       and the target ends up in a fragment holding no whole link, so it is
 *       silently left alone — half the links in the architecture pages.
 *
 *   `…the [event\nbus](events.md) is in-process…`
 *       the label is wrapped across a line break. Rewrite line by line and the
 *       second half has no opening `[`, so again nothing matches. One link in
 *       `content/workspaces.md` is written this way, and it was the last one still
 *       pointing at a `.md` file after the code-span fix.
 *
 * So the pass below runs over the whole document at once and uses these ranges to
 * decide what to leave alone: a match inside a **fence** is never a link, and a
 * *target* inside a **code span** is prose quoting one.
 */
function codeRegions(source) {
  const fences = [];
  const spans = [];
  let offset = 0;
  let fence = null;
  let opened = 0;
  for (const line of source.split("\n")) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (marker !== null) {
        fence = marker[1][0];
        opened = offset;
      } else {
        // Longest backtick run first, so ``a `b` c`` closes where the author meant.
        for (const span of line.matchAll(/(`+)(?:(?!\1).)*\1/g)) {
          spans.push([offset + span.index, offset + span.index + span[0].length]);
        }
      }
    } else if (marker !== null && marker[1][0] === fence) {
      fences.push([opened, offset + line.length]);
      fence = null;
    }
    offset += line.length + 1;
  }
  // An unterminated fence is the author's problem; treat the rest as code.
  if (fence !== null) fences.push([opened, source.length]);
  return { fences, spans };
}

/** Does `[start, end)` overlap any of them? */
function within(ranges, start, end) {
  return ranges.some(([from, to]) => start < to && end > from);
}

/**
 * Inline links and reference definitions, rewritten; prose untouched.
 *
 * The label may cross a single newline but never a blank line — a `[` and a
 * `](…)` in two different paragraphs are two pieces of punctuation, not a link, and
 * an unbounded label would join them.
 */
const LINK = /(!?\[(?:[^\]\n]|\n(?!\n))*\]\(\s*)([^)\s]+)((?:\s+"[^"]*")?\s*\))/g;
const DEFINITION = /^([^\S\n]{0,3}\[[^\]\n]+\]:[^\S\n]*)(\S+)/gm;

export function rewriteLinks(source, fromDocsRelative) {
  // One pass per pattern, and the regions are recomputed for each: a rewritten
  // target is a different length, so every offset behind it has moved and the
  // ranges from the previous pass would name the wrong characters.
  const pass = (text, pattern, hasClose) => {
    const { fences, spans } = codeRegions(text);
    return text.replace(pattern, (...groups) => {
      const [match, open, target] = groups;
      const close = hasClose ? groups[3] : "";
      const offset = groups[hasClose ? 4 : 3];
      if (within(fences, offset, offset + match.length)) return match;
      const start = offset + open.length;
      if (within(spans, start, start + target.length)) return match;
      return `${open}${rewriteTarget(target, fromDocsRelative)}${close}`;
    });
  };

  return pass(pass(source, LINK, true), DEFINITION, false);
}

/** A YAML double-quoted scalar, which is the one spelling that takes any title. */
function yamlString(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * One document, as the page Starlight should build from it.
 *
 * A pure function of `(source, docsRelative)` apart from asking the filesystem
 * whether a link target is a directory. That is what makes `--check` meaningful.
 */
export function transform(source, docsRelative) {
  const { title, body } = splitTitle(source);
  const content = rewriteLinks(body, docsRelative).replace(/^\n+/, "");

  const frontmatter = [
    "---",
    `title: ${yamlString(title ?? path.posix.basename(docsRelative, ".md"))}`,
    // Per page rather than through Starlight's `editLink.baseUrl`, because the
    // projection moves two kinds of path: `README.md` becomes `index.md`, and the
    // site's root is `content/` rather than the repository's root. A global prefix
    // would send every index page at a file that does not exist.
    `editUrl: ${yamlString(`${GITHUB}/edit/${GITHUB_BRANCH}/${CORPUS}/${docsRelative}`)}`,
    "---",
    "",
  ].join("\n");

  return `${frontmatter}${content}`;
}

/** Where a `docs/`-relative document is written inside the content collection. */
export function contentPathFor(docsRelative) {
  return docsRelative.replace(/(^|\/)README\.md$/, "$1index.md");
}

/** What the content collection holds right now. */
function existingPages(dir = CONTENT_DIR, prefix = "") {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...existingPages(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith(".md")) found.push(rel);
  }
  return found;
}

/**
 * Bring `src/content/docs/` into agreement with `content/`.
 *
 * Returns `{ written, removed, stale, total }` — `stale` is what `--check` reports
 * and what a write run repairs.
 */
export function sync({ write = true } = {}) {
  const expected = new Map();
  for (const docsRelative of documentPaths()) {
    expected.set(
      contentPathFor(docsRelative),
      transform(readFileSync(path.join(DOCS_DIR, docsRelative), "utf8"), docsRelative),
    );
  }

  const stale = [];
  const written = [];
  for (const [relative, content] of expected) {
    const target = path.join(CONTENT_DIR, relative);
    let current = null;
    try {
      current = readFileSync(target, "utf8");
    } catch {
      /* not written yet */
    }
    if (current === content) continue;
    stale.push(relative);
    if (!write) continue;
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    written.push(relative);
  }

  const removed = [];
  for (const relative of existingPages()) {
    if (expected.has(relative)) continue;
    stale.push(relative);
    if (!write) continue;
    rmSync(path.join(CONTENT_DIR, relative));
    removed.push(relative);
  }

  return { written, removed, stale, total: expected.size };
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const check = process.argv.includes("--check");
  const result = sync({ write: !check });
  if (check && result.stale.length > 0) {
    console.error(`src/content/docs is stale — run 'pnpm sync':\n  ${result.stale.sort().join("\n  ")}`);
    process.exit(1);
  }
  // stderr, so a caller capturing stdout gets nothing it has to filter.
  console.error(
    check
      ? `docs projection is current (${result.total} pages)`
      : `docs projection: ${result.total} pages, ${result.written.length} written, ${result.removed.length} removed`,
  );
}
