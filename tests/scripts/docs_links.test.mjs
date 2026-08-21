/**
 * Every internal link in every tracked Markdown file resolves — file *and* anchor
 *.
 *
 * **`.mdx` counts as Markdown here.** `docs/content/` is `.md` today and the documentation
 * site's own rule keeps it that way (see `docs/README.md`), but the site can
 * take `.mdx` for a page that genuinely needs a component — and an extension this
 * scan did not name would be a document exempt from every rule below, silently,
 * from the moment somebody added one. The two are checked identically: a fragment
 * into either is a heading question, and a link at either resolves or does not.
 *
 * Renaming a `##` heading silently invalidates every inbound `#fragment` pointing
 * at it. Nothing fails, nothing warns; the link simply starts landing at the top of
 * the page, which is indistinguishable from working unless you already know which
 * paragraph you were promised. It was a near miss during the
 * `visionset ui` → `visionset server` rename, where prose changes reached
 * headings — and this repository leans on cross-document references hard enough
 * (`docs/content/` alone is nineteen files that cite each other by section) that a reviewing
 * habit is the wrong instrument. It is mechanically decidable, so it is a gate.
 *
 * **External URLs are out of scope**, deliberately: checking them makes the gate
 * fail for a rate limit, a redirect, or somebody else's outage — reasons that have
 * nothing to do with this repository, on a check that has to be trustworthy to be
 * worth having.
 *
 * It reads `git ls-files`, i.e. the **index** rather than the working tree, on the
 * bargain `annotator_boundary.test.mjs` already runs on: a merely *staged* document
 * is checked before any commit lands, and `node_modules/` stays out for free rather
 * than by a list somebody maintains.
 *
 * ## Fenced code comes out for both scans; inline code comes out for only one
 *
 * A fence has to go before anything else looks at the text, in both directions:
 * `docs/content/cli.md` holds shell transcripts containing `[project.scripts]`, which a
 * link regex reads as a reference definition into nowhere, and a `# comment`
 * opening a bash block is a level-one heading to anything that cannot see the
 * fence around it.
 *
 * **Inline spans are different, and getting that wrong is what a first run looks
 * like.** A link scan wants them gone — prose quoting `[a](b.md)` as an example is
 * not a link. A *heading* scan must keep their text, because half the headings in
 * this repository are entirely code (`## \`visionset server\``), and stripping the
 * span leaves `##` with nothing to slug. Which is precisely what happened: the
 * first run reported five broken anchors, and all five were this file being wrong
 * rather than a document being wrong.
 *
 * ## Anchors are GitHub's slugs, and two details are load-bearing
 *
 * Lowercase; drop everything that is not a letter, a digit, a space, a hyphen or an
 * **underscore**; spaces to hyphens. The underscore is why
 * `persistence.md#migrations-and-format_version` resolves, and dropping it was two
 * of those five false findings.
 *
 * A repeat of an existing slug gains `-1`, `-2`, … in document order. Nothing links
 * to a suffixed anchor today, so this rule guards against a *false* finding rather
 * than covering a live link — `docs/content/api.md` has three `### Errors` sections, and
 * without it a perfectly good link to the second one would be reported broken. That
 * is the failure worth pre-empting: a gate that cries wolf gets switched off.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The extensions this gate treats as Markdown. See the header for why `.mdx` is here. */
export const MARKDOWN = [".md", ".mdx"];

/**
 * Tracked Markdown, from the index.
 *
 * The pathspecs are derived from `MARKDOWN` rather than written out, so the set of
 * files this gate *finds* and the set whose anchors it *reads* cannot drift apart —
 * which is the shape the bug would take: an extension added to one and not the
 * other leaves those documents scanned for outbound links and never scanned for
 * the headings other documents point at.
 */
function markdownFiles() {
  const listed = spawnSync("git", ["-C", REPO, "ls-files", ...MARKDOWN.map((e) => `*${e}`)], {
    encoding: "utf8",
  });
  assert.equal(listed.status, 0, "git ls-files must succeed");
  return listed.stdout.split("\n").filter(Boolean);
}

/** Is this a document whose headings this gate can read? */
export function isMarkdown(file) {
  return MARKDOWN.some((extension) => file.endsWith(extension));
}

/**
 * The document with its fenced blocks blanked, so nothing inside a transcript is
 * read as markup — in either direction. Blanked rather than deleted, so a reported
 * line number is the line the author is looking at.
 *
 * Inline spans are **not** touched here, and that separation is load-bearing: a
 * link scan wants them gone, and a heading scan must keep their text. Half this
 * repository's headings are entirely code — `## \`visionset server\`` — and
 * stripping the span leaves `##` and nothing to slug, so every anchor into one
 * would be reported broken. All five findings on this file's first run were that
 * bug, not a broken document.
 */
export function withoutFences(source) {
  const out = [];
  let fence = null;
  for (const line of source.split("\n")) {
    const opener = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null && opener !== null) {
      fence = opener[1][0];
      out.push("");
      continue;
    }
    if (fence !== null) {
      out.push("");
      if (opener !== null && opener[1][0] === fence) fence = null;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Inline code spans dropped. Longest backtick run first, so ``a `b` c`` closes right. */
function withoutSpans(line) {
  return line.replace(/(`+)(?:(?!\1).)*\1/g, "");
}

/**
 * GitHub's heading slug: lowercase, drop everything that is not a letter, a digit,
 * a space, a hyphen or an **underscore**, then spaces to hyphens.
 *
 * The underscore is not an oversight to tidy away later — it is why
 * `persistence.md#migrations-and-format_version` resolves. Inline code contributes
 * its text (the backticks go, `format_version` stays), and so does a link's label.
 *
 * Emphasis is stripped as `*` and backticks only. `_` is left alone because this
 * reads text rather than parsing it, and every heading in this repository that
 * carries an underscore carries it as part of an identifier; treating `_` as
 * emphasis would break exactly the case the rule exists for.
 */
export function slug(heading) {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*`]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

/** Every anchor a file offers, duplicates suffixed the way GitHub suffixes them. */
export function anchorsOf(source) {
  const seen = new Map();
  const anchors = new Set();
  for (const line of withoutFences(source).split("\n")) {
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading === null) continue;
    const base = slug(heading[1].replace(/\s+#+\s*$/, ""));
    if (base === "") continue;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

/** Is this target somebody else's problem? */
function external(target) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target);
}

/**
 * Every internal link in a document, with the line it sits on.
 *
 * Inline (`[text](target)`) and reference definitions (`[id]: target`) both, since
 * a definition is where a reference-style link's target actually lives. Titles are
 * stripped: `[text](target "why")` is one link, not a target with a quote in it.
 */
export function linksIn(source) {
  const found = [];
  const lines = withoutFences(source).split("\n").map(withoutSpans);
  lines.forEach((line, index) => {
    const at = index + 1;
    for (const match of line.matchAll(/!?\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g)) {
      found.push({ target: match[1], line: at });
    }
    const definition = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/.exec(line);
    if (definition !== null) found.push({ target: definition[1], line: at });
  });
  return found.filter((link) => !external(link.target));
}

test("every internal Markdown link resolves to a tracked file", () => {
  const tracked = new Set(
    spawnSync("git", ["-C", REPO, "ls-files"], { encoding: "utf8" }).stdout.split("\n"),
  );
  const broken = [];

  for (const file of markdownFiles()) {
    const source = readFileSync(path.join(REPO, file), "utf8");
    for (const { target, line } of linksIn(source)) {
      const [where] = target.split("#");
      // A bare `#fragment` is this file, and the anchor test below owns it.
      if (where === "") continue;
      const resolved = path.normalize(path.join(path.dirname(file), where));
      // A directory is a legitimate destination — GitHub renders its listing — and
      // is not in `ls-files`, which names blobs.
      const isDirectory = existsSync(path.join(REPO, resolved)) && statSync(path.join(REPO, resolved)).isDirectory();
      if (!tracked.has(resolved) && !isDirectory) {
        broken.push(`${file}:${line} → ${target}`);
      }
    }
  }

  assert.deepEqual(broken, [], `links pointing at nothing:\n  ${broken.join("\n  ")}`);
});

test("every anchor fragment resolves to a heading in the file it names", () => {
  const anchors = new Map();
  const readAnchors = (file) => {
    if (!anchors.has(file)) anchors.set(file, anchorsOf(readFileSync(path.join(REPO, file), "utf8")));
    return anchors.get(file);
  };
  const broken = [];

  for (const file of markdownFiles()) {
    const source = readFileSync(path.join(REPO, file), "utf8");
    for (const { target, line } of linksIn(source)) {
      const hash = target.indexOf("#");
      if (hash < 0) continue;
      const fragment = decodeURIComponent(target.slice(hash + 1));
      if (fragment === "") continue;
      const where = target.slice(0, hash);
      const resolved = where === "" ? file : path.normalize(path.join(path.dirname(file), where));
      // A fragment into something that is not Markdown is not a heading question,
      // and a missing file is already the other test's finding.
      if (!isMarkdown(resolved) || !existsSync(path.join(REPO, resolved))) continue;
      if (!readAnchors(resolved).has(fragment)) {
        broken.push(`${file}:${line} → ${target}  (no heading in ${resolved} slugs to "${fragment}")`);
      }
    }
  }

  assert.deepEqual(broken, [], `anchors pointing at nothing:\n  ${broken.join("\n  ")}`);
});

test("external links are ignored, whatever shape they arrive in", () => {
  // Not a stylistic preference: a gate that fails for somebody else's rate limit
  // is a gate people learn to re-run rather than read.
  const source = [
    "[a](https://example.com/x#frag)",
    "[b](http://example.com)",
    "[c](//example.com/x)",
    "[d](mailto:someone@example.com)",
    "[e](docs/content/api.md#errors)",
  ].join("\n");
  assert.deepEqual(
    linksIn(source).map((link) => link.target),
    ["docs/content/api.md#errors"],
  );
});

test("nothing inside a code block is read as a link or as a heading", () => {
  // Both halves have bitten this file. `docs/content/cli.md` holds shell transcripts whose
  // `[project.scripts]` reads as a reference definition, and a bash comment opening
  // a block reads as an `<h1>`.
  const source = [
    "# Real heading",
    "",
    "```toml",
    "[project.scripts]",
    "visionset = 'visionset.cli.main:app'",
    "```",
    "",
    "```bash",
    "# Not a heading",
    "```",
    "",
    "Inline `[nope](nowhere.md)` stays out too.",
    "",
    "## Second heading",
  ].join("\n");

  assert.deepEqual(linksIn(source), []);
  assert.deepEqual([...anchorsOf(source)], ["real-heading", "second-heading"]);
});

test("a repeated heading gets GitHub's numeric suffix, so a live link is never miscalled", () => {
  // `docs/content/api.md` has three `### Errors`. No link points at the second or third
  // today — this is here so that the day one does, it is not reported broken.
  const source = ["## Errors", "## Errors", "## Errors"].join("\n");
  assert.deepEqual([...anchorsOf(source)], ["errors", "errors-1", "errors-2"]);
});

test("an .mdx document is held to these rules, not exempt from them", () => {
  // There is no `.mdx` in the repository today — `docs/content/` is Markdown and
  // `docs/README.md` says why it stays that way. This is the forward guard:
  // the day the documentation site takes one for a page that needs a component,
  // it must arrive already covered rather than silently outside every rule above.
  // Narrowing either half back to `.md` alone reddens this.
  assert.ok(isMarkdown("docs/src/content/docs/example.mdx"));
  assert.ok(isMarkdown("docs/content/api.md"));
  assert.ok(!isMarkdown("openapi.json"));
  assert.ok(!isMarkdown("README.mdx.txt"));
});

test("a slug drops punctuation, keeps hyphens, and unwraps a link in a heading", () => {
  assert.equal(slug("Where the UI lives"), "where-the-ui-lives");
  assert.equal(slug("`--fast`, and what it skips"), "--fast-and-what-it-skips");
  assert.equal(slug("See [the API](api.md)"), "see-the-api");
  assert.equal(slug("Ports & adapters"), "ports--adapters");
});
