import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(path.join(REPO, rel), "utf8");

const COMMENT = /^\s*(?:\/\/|\/\*|\*|#)/;
const SOURCE = /\.(?:ts|tsx|css)$/;
const GENERATED = /^frontend\/ui-core\/src\/generated\//;
const SHADCN_SNAPSHOT = /^frontend\/ui-core\/shadcn\//;

/** Every tracked `frontend` file matching `SOURCE`, minus the generated client. */
function frontendSources({ includeSnapshots } = {}) {
  const listed = spawnSync("git", ["ls-files", "-z", "frontend"], { cwd: REPO, encoding: "utf8" });
  assert.equal(listed.status, 0, `git ls-files failed: ${listed.stderr}`);
  return listed.stdout
    .split("\0")
    .filter(
      (name) =>
        SOURCE.test(name) && !GENERATED.test(name) && (includeSnapshots || !SHADCN_SNAPSHOT.test(name)),
    );
}

/** The variant keys of the first `variant: { … }` block in a cva source. */
export function variantKeys(source, block = "variant") {
  const start = source.indexOf(`${block}: {`);
  assert.notEqual(start, -1, `no "${block}" block`);
  let depth = 0, i = start + block.length + 3;
  const begin = i;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { if (depth === 0) break; depth--; }
  }
  const body = source.slice(begin, i);
  return [...body.matchAll(/(?:^|,)\s*"?([a-z][a-z0-9-]*)"?:\s/g)].map((m) => m[1]);
}

test("variantKeys reads quoted and bare keys and ignores class text", () => {
  assert.deepEqual(
    variantKeys(`x({ variants: { variant: { default: "a: b", "icon-xs": "c" }, size: { sm: "d" } } })`),
    ["default", "icon-xs"],
  );
  assert.deepEqual(variantKeys(`variants: { variant: { a: "" }, size: { sm: "x", lg: "y" } }`, "size"), ["sm", "lg"]);
});

const BUTTON = "frontend/ui-core/src/primitives/button.tsx";
test("Button carries shadcn's variants and sizes, and nothing else", () => {
  const src = read(BUTTON);
  assert.deepEqual(variantKeys(src, "variant"), ["default", "outline", "secondary", "ghost", "destructive", "link"]);
  assert.deepEqual(variantKeys(src, "size"), ["default", "xs", "sm", "lg", "icon", "icon-xs", "icon-sm", "icon-lg"]);
});

const BADGE = "frontend/ui-core/src/primitives/badge.tsx";
const OFFICIAL_BADGE = ["default", "secondary", "destructive", "outline", "ghost", "link"];
const VISIONSET_BADGE = ["success", "warning", "info", "quiet"];

test("Badge keeps shadcn's variants and adds exactly the four VisionSet status variants", () => {
  const keys = variantKeys(read(BADGE), "variant");
  for (const k of OFFICIAL_BADGE) assert.ok(keys.includes(k), `official Badge variant ${k} missing`);
  assert.deepEqual(keys.filter((k) => !OFFICIAL_BADGE.includes(k)).sort(), [...VISIONSET_BADGE].sort());
});

/** The class string of one variant line in a cva source. */
export function variantClasses(source, key) {
  const m = source.match(new RegExp(String.raw`^\s*"?${key}"?:\s*\n?\s*"([^"]*)"`, "m"));
  assert.ok(m, `no variant ${key}`);
  return m[1];
}

test("a status Badge paints a soft surface and readable ink, never a coloured stroke", () => {
  const src = read(BADGE);
  const stroke = /\bborder-(?:emerald|amber|sky|success|warning|destructive|primary)\b/;
  for (const k of [...VISIONSET_BADGE, "destructive"]) {
    assert.doesNotMatch(variantClasses(src, k), stroke, `${k} adds a coloured border`);
  }
  assert.match(variantClasses(src, "success"), /\bbg-emerald-500\/10\b/);
  assert.match(variantClasses(src, "success"), /\btext-emerald-700\b/);
  assert.match(variantClasses(src, "warning"), /\bbg-amber-500\/10\b/);
  assert.match(variantClasses(src, "warning"), /\btext-amber-700\b/);
  assert.match(variantClasses(src, "info"), /\bbg-sky-500\/10\b/);
  assert.match(variantClasses(src, "info"), /\btext-sky-700\b/);
  assert.match(variantClasses(src, "quiet"), /\bbg-muted\b/);
  assert.match(variantClasses(src, "quiet"), /\btext-muted-foreground\b/);
  // Official destructive stays on the semantic token, never red-*.
  assert.match(variantClasses(src, "destructive"), /\bbg-destructive\/10\b/);
  assert.doesNotMatch(src, /\b(?:bg|text)-red-\d/);
});

/**
 * v1's vocabulary the extension contract retired: prop names and shapes no
 * shadcn primitive carries, and the PascalCase import paths and framework
 * package v1 read them from.
 *
 * Every forbidden token is assembled from fragments — the trick
 * `design_tokens.test.mjs` uses for `RETIRED_ICON_PACKAGE` — so none of them
 * sits contiguously anywhere in this file's own source.
 */
const NEXT_THEMES = ["next", "themes"].join("-");
const FIELD_HINT = ["Field", "Hint"].join("");
const TABLE_EMPTY = ["Table", "Empty"].join("");
const LEGACY_PRIMITIVES = [
  "Badge",
  "Button",
  "Card",
  "Combobox",
  "Dialog",
  "Feedback",
  "Input",
  "Menu",
  "Select",
  "Table",
  "Tabs",
];

const TAG_ATTRIBUTE_RULES = [
  { tag: "Button", attribute: /variant="(?:primary|success)"|size="(?:md)"/ },
  { tag: "Badge", attribute: /variant="(?:neutral|accent)"/ },
  { tag: "Progress", attribute: /\bvariant=/ },
  { tag: "SelectItem", attribute: /\bmeta=/ },
  { tag: "Alert", attribute: /\btitle=/ },
];
const LEGACY_IMPORT = new RegExp(
  String.raw`from\s+["'][^"']*/primitives/(?:${LEGACY_PRIMITIVES.join("|")})(?:\.js)?["']`,
);
const NEXT_THEMES_IMPORT = new RegExp(String.raw`from\s+["']${NEXT_THEMES}["']`);
const BARE_LEGACY_NAME = new RegExp(String.raw`\b(?:${FIELD_HINT}|${TABLE_EMPTY})\b`);

/** The 1-based line of `text` that character offset `index` falls on. */
function lineAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

/**
 * The index just past a JSX opening tag's real closing `>`, starting the scan
 * at `start` (the tag's own `<`). A `[^>]*?` regex is fooled by any literal
 * `>` — an arrow function, a `count > 0` comparison, a `>` inside a quoted
 * string — so this instead walks the text tracking `{}` depth (a `>` only
 * ends the tag at depth zero) and skips over `"…"`/`'…'`/`` `…` `` bodies
 * wholesale, wherever they appear, so a `>` quoted inside one is never read
 * as the tag's own.
 */
function openTagEnd(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return i + 1;
  }
  return text.length;
}

/** Every `<Tag …>` opening tag in `text`, as `{ at, tag }` in source order. */
function openTagsIn(text, tagName) {
  const starts = new RegExp(String.raw`<${tagName}\b`, "g");
  return [...text.matchAll(starts)].map((m) => ({
    at: m.index,
    tag: text.slice(m.index, openTagEnd(text, m.index)),
  }));
}

/** Every `file:line` in `text` reaching for a name the extension contract retired. */
export function legacyVocabularyIn(file, text) {
  const scrubbed = text
    .split("\n")
    .map((line) => (COMMENT.test(line) ? "" : line))
    .join("\n");
  const hits = [];

  for (const { tag, attribute } of TAG_ATTRIBUTE_RULES) {
    for (const { at, tag: tagText } of openTagsIn(scrubbed, tag)) {
      if (attribute.test(tagText)) hits.push({ at: lineAt(scrubbed, at), text: tagText.split("\n")[0].trim() });
    }
  }

  scrubbed.split("\n").forEach((line, index) => {
    if (BARE_LEGACY_NAME.test(line) || LEGACY_IMPORT.test(line) || NEXT_THEMES_IMPORT.test(line)) {
      hits.push({ at: index + 1, text: line.trim() });
    }
  });

  return hits
    .sort((a, b) => a.at - b.at)
    .map(({ at, text: t }) => `${file}:${at}: ${t}`);
}

test("legacyVocabularyIn flags v1's shapes and stays silent on the shadcn contract", () => {
  assert.deepEqual(legacyVocabularyIn("a.tsx", `<Button variant="primary">Go</Button>`), [
    `a.tsx:1: <Button variant="primary">`,
  ]);
  assert.deepEqual(legacyVocabularyIn("b.tsx", `<Button size="md">Go</Button>`), [`b.tsx:1: <Button size="md">`]);
  assert.deepEqual(legacyVocabularyIn("c.tsx", `<Badge variant="neutral">Draft</Badge>`), [
    `c.tsx:1: <Badge variant="neutral">`,
  ]);
  assert.deepEqual(legacyVocabularyIn("d.tsx", `<Progress value={40} variant="thin" />`), [
    `d.tsx:1: <Progress value={40} variant="thin" />`,
  ]);
  assert.deepEqual(legacyVocabularyIn("e.tsx", `<SelectItem value="a" meta="12 items">A</SelectItem>`), [
    `e.tsx:1: <SelectItem value="a" meta="12 items">`,
  ]);
  assert.deepEqual(legacyVocabularyIn("f.tsx", `<Alert title="Heads up">…</Alert>`), [
    `f.tsx:1: <Alert title="Heads up">`,
  ]);
  // A multi-line tag is still one tag.
  assert.deepEqual(
    legacyVocabularyIn("g.tsx", `<Button\n  variant="primary"\n  onClick={go}\n>\n  Go\n</Button>`),
    [`g.tsx:1: <Button`],
  );
  // An arrow function's own `>` does not end the tag before the real attribute.
  assert.deepEqual(
    legacyVocabularyIn("g2.tsx", `<Button onClick={() => setOpen(true)} variant="primary">Go</Button>`),
    [`g2.tsx:1: <Button onClick={() => setOpen(true)} variant="primary">`],
  );
  // Nor does a `>` comparison inside the expression.
  assert.deepEqual(
    legacyVocabularyIn("g3.tsx", `<Progress value={count > 0 ? count : 0} variant="thin" />`),
    [`g3.tsx:1: <Progress value={count > 0 ? count : 0} variant="thin" />`],
  );
  // The same tricky arrow function with no forbidden attribute stays silent.
  assert.deepEqual(legacyVocabularyIn("g4.tsx", `<Button onClick={() => go()}>ok</Button>`), []);
  // Nor does a `>` quoted inside a string inside braces — the tag still
  // extends to its real close, past the attribute that follows the string.
  assert.deepEqual(
    legacyVocabularyIn("g5.tsx", `<Alert data-note={"a > b"} title="Heads up">Body</Alert>`),
    [`g5.tsx:1: <Alert data-note={"a > b"} title="Heads up">`],
  );
  assert.deepEqual(legacyVocabularyIn("h.tsx", `<FieldHint>Optional</FieldHint>`), [
    `h.tsx:1: <FieldHint>Optional</FieldHint>`,
  ]);
  assert.deepEqual(legacyVocabularyIn("i.tsx", `<TableEmpty>No rows</TableEmpty>`), [
    `i.tsx:1: <TableEmpty>No rows</TableEmpty>`,
  ]);
  assert.deepEqual(legacyVocabularyIn("j.ts", `import { Badge } from "../primitives/Badge.js";`), [
    `j.ts:1: import { Badge } from "../primitives/Badge.js";`,
  ]);
  assert.deepEqual(legacyVocabularyIn("k.tsx", `import { useTheme } from "next-themes";`), [
    `k.tsx:1: import { useTheme } from "next-themes";`,
  ]);

  // The shadcn contract itself must pass clean.
  assert.deepEqual(legacyVocabularyIn("l.tsx", `<Button variant="outline" size="sm">Go</Button>`), []);
  assert.deepEqual(legacyVocabularyIn("m.tsx", `<AlertTitle title="not this one">x</AlertTitle>`), []);
  assert.deepEqual(legacyVocabularyIn("n.tsx", `<Badge variant="secondary">Draft</Badge>`), []);
  assert.deepEqual(legacyVocabularyIn("o.ts", `import { Badge } from "../primitives/badge.js";`), []);
  // A comment recalling the retired shape states history, not a usage.
  assert.deepEqual(legacyVocabularyIn("p.tsx", `  // <Button variant="primary">Go</Button>`), []);
  assert.deepEqual(legacyVocabularyIn("q.tsx", `// reads next-themes for the mounted flag`), []);
});

test("no frontend consumer reaches for a name the extension contract retired", () => {
  const tracked = frontendSources();
  assert.ok(tracked.length > 0, "the scan found no frontend consumers, so it proves nothing");

  const offenders = tracked.flatMap((file) => legacyVocabularyIn(file, readFileSync(path.join(REPO, file), "utf8")));
  assert.deepEqual(
    offenders,
    [],
    "a consumer still reaches for a name the extension contract retired:\n" + offenders.join("\n"),
  );
});

/**
 * The status palette's one Tailwind family: emerald/amber/sky, across every
 * prefix that can carry a colour. `Badge` and `statusTone.ts` are its one
 * home — see `statusTone.ts`'s own docstring — so a third place naming the
 * family is a fork of the palette, not a use of it.
 */
const STATUS_PALETTE = /\b(?:bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|shadow)-(?:emerald|amber|sky)-\d/;

/** Every `file:line` in `text` painting with the status palette, outside a comment. */
export function statusPaletteIn(file, text) {
  return text
    .split("\n")
    .map((line, index) => ({ line, at: index + 1 }))
    .filter(({ line }) => !COMMENT.test(line) && STATUS_PALETTE.test(line))
    .map(({ line, at }) => `${file}:${at}: ${line.trim()}`);
}

test("statusPaletteIn finds the emerald/amber/sky family, and not a token or a comment", () => {
  assert.deepEqual(statusPaletteIn("a.tsx", `  className="bg-emerald-500/10"`), [
    `a.tsx:1: className="bg-emerald-500/10"`,
  ]);
  assert.deepEqual(statusPaletteIn("b.tsx", `  className="border-amber-400 dark:border-amber-300"`), [
    `b.tsx:1: className="border-amber-400 dark:border-amber-300"`,
  ]);
  assert.deepEqual(statusPaletteIn("c.tsx", `  className="ring-sky-500"`), [`c.tsx:1: className="ring-sky-500"`]);
  assert.deepEqual(statusPaletteIn("d.tsx", `  className="shadow-emerald-500/20"`), [
    `d.tsx:1: className="shadow-emerald-500/20"`,
  ]);
  // A token, not the palette.
  assert.deepEqual(statusPaletteIn("e.tsx", `  className="bg-primary text-primary-foreground"`), []);
  // The family name without a shade is not yet a colour.
  assert.deepEqual(statusPaletteIn("f.tsx", `  className="bg-emerald"`), []);
  // A comment recalling the palette states history, not a usage.
  assert.deepEqual(statusPaletteIn("g.tsx", `  // never bg-emerald-500 outside statusTone`), []);
});

/**
 * A colour family that competes with the status palette for the same job —
 * "a warning", "a success" — and so could stand in for it undetected. Unlike
 * the palette itself these have no allowed home anywhere in `frontend`.
 */
const COMPETING_PALETTE = /\b(?:bg|text|border)-(?:green|lime|teal|yellow|orange|blue|cyan|red)-\d/;

/** Every `file:line` in `text` reaching for a colour family that competes with the status palette. */
export function competingStatusPaletteIn(file, text) {
  return text
    .split("\n")
    .map((line, index) => ({ line, at: index + 1 }))
    .filter(({ line }) => !COMMENT.test(line) && COMPETING_PALETTE.test(line))
    .map(({ line, at }) => `${file}:${at}: ${line.trim()}`);
}

test("competingStatusPaletteIn finds a rival colour family, and not the status palette itself", () => {
  assert.deepEqual(competingStatusPaletteIn("a.tsx", `  className="bg-green-500"`), [
    `a.tsx:1: className="bg-green-500"`,
  ]);
  assert.deepEqual(competingStatusPaletteIn("b.tsx", `  className="text-yellow-700"`), [
    `b.tsx:1: className="text-yellow-700"`,
  ]);
  assert.deepEqual(competingStatusPaletteIn("c.tsx", `  className="border-blue-400"`), [
    `c.tsx:1: className="border-blue-400"`,
  ]);
  assert.deepEqual(competingStatusPaletteIn("d.tsx", `  className="bg-emerald-500"`), []);
  assert.deepEqual(competingStatusPaletteIn("e.tsx", `  // never bg-red-500 for a destructive state`), []);
});

test("the status palette lives in exactly Badge and statusTone, nowhere else", () => {
  const ALLOWED_PALETTE_FILES = [
    "frontend/ui-core/src/primitives/badge.tsx",
    "frontend/ui-core/src/patterns/statusTone.ts",
    "frontend/ui-core/src/patterns/statusTone.test.ts",
  ];
  const tracked = frontendSources({ includeSnapshots: true });
  assert.ok(tracked.length > 0, "the scan found no frontend sources, so it proves nothing");

  const offenders = tracked
    .filter((file) => !ALLOWED_PALETTE_FILES.includes(file))
    .flatMap((file) => statusPaletteIn(file, readFileSync(path.join(REPO, file), "utf8")));
  assert.deepEqual(
    offenders,
    [],
    "the status palette has exactly one home outside Badge and statusTone — read the tone from " +
      `patterns/statusTone.ts instead:\n${offenders.join("\n")}`,
  );
});

test("no competing colour family stands in for the status palette anywhere in frontend", () => {
  const tracked = frontendSources({ includeSnapshots: true });
  assert.ok(tracked.length > 0, "the scan found no frontend sources, so it proves nothing");

  const offenders = tracked.flatMap((file) =>
    competingStatusPaletteIn(file, readFileSync(path.join(REPO, file), "utf8")),
  );
  assert.deepEqual(
    offenders,
    [],
    `a competing colour family stands in for the status palette:\n${offenders.join("\n")}`,
  );
});

/**
 * `--success`/`--warning` and their `-foreground` companions are retired
 * declarations (`design_tokens.test.mjs` guards `styles.css` itself); this is
 * the other half — no consumer may reach for the *utility* either, on any of
 * the four prefixes that could carry one.
 */
const STATUS_TOKEN_UTILITY = /\b(?:bg|text|border|ring)-(?:success|warning)(?:-foreground)?\b/;

/** Every `file:line` in `text` reaching for the retired status token utility, outside a comment. */
export function statusTokenUtilitiesIn(file, text) {
  return text
    .split("\n")
    .map((line, index) => ({ line, at: index + 1 }))
    .filter(({ line }) => !COMMENT.test(line) && STATUS_TOKEN_UTILITY.test(line))
    .map(({ line, at }) => `${file}:${at}: ${line.trim()}`);
}

test("statusTokenUtilitiesIn finds the retired success/warning utility, and not the emerald/amber tokens that replaced it", () => {
  assert.deepEqual(statusTokenUtilitiesIn("a.tsx", `  className="bg-success"`), [`a.tsx:1: className="bg-success"`]);
  assert.deepEqual(statusTokenUtilitiesIn("b.tsx", `  className="text-warning-foreground"`), [
    `b.tsx:1: className="text-warning-foreground"`,
  ]);
  assert.deepEqual(statusTokenUtilitiesIn("c.tsx", `  className="border-success"`), [
    `c.tsx:1: className="border-success"`,
  ]);
  assert.deepEqual(statusTokenUtilitiesIn("d.tsx", `  className="ring-warning"`), [
    `d.tsx:1: className="ring-warning"`,
  ]);
  assert.deepEqual(statusTokenUtilitiesIn("e.tsx", `  className="bg-emerald-500 text-emerald-700"`), []);
  assert.deepEqual(statusTokenUtilitiesIn("f.tsx", `  className="bg-destructive"`), []);
  assert.deepEqual(statusTokenUtilitiesIn("g.tsx", `  // bg-success no longer exists`), []);
});

test("no frontend source reaches for the retired success/warning token utility", () => {
  const tracked = frontendSources({ includeSnapshots: true });
  assert.ok(tracked.length > 0, "the scan found no frontend sources, so it proves nothing");

  const offenders = tracked.flatMap((file) =>
    statusTokenUtilitiesIn(file, readFileSync(path.join(REPO, file), "utf8")),
  );
  assert.deepEqual(
    offenders,
    [],
    `a source reaches for the retired success/warning token utility:\n${offenders.join("\n")}`,
  );
});

/**
 * The public surface `index.ts` promises: every canonical primitive
 * re-exported, the retired pattern-layer `Combobox` gone now that it is a
 * primitive, and no `*Variants` beyond the three shadcn's own `cva` calls
 * produce.
 */
const INDEX_PATH = "frontend/ui-core/src/index.ts";
const PUBLIC_PRIMITIVES = [
  "badge",
  "button",
  "alert",
  "field",
  "dialog",
  "sheet",
  "combobox",
  "input-group",
  "select",
  "dropdown-menu",
  "tooltip",
  "progress",
  "skeleton",
  "sonner",
  "table",
  "tabs",
  "card",
  "input",
  "textarea",
  "label",
];

test("index.ts exports every canonical primitive, drops the retired pattern Combobox, and adds no *Variants beyond shadcn's own three", () => {
  const source = read(INDEX_PATH);

  for (const name of PUBLIC_PRIMITIVES) {
    const exported = new RegExp(String.raw`export\s*\{[^;]*\}\s*from\s*"\./primitives/${name}\.js"`).test(source);
    assert.ok(exported, `${INDEX_PATH} does not export from ./primitives/${name}.js`);
  }

  assert.ok(
    !source.includes('from "./patterns/Combobox.js"'),
    `${INDEX_PATH} must not export the retired ./patterns/Combobox.js — Combobox is a primitive now`,
  );

  const variantsExports = [...new Set([...source.matchAll(/\b[a-zA-Z]*Variants\b/g)].map((m) => m[0]))].sort();
  assert.deepEqual(
    variantsExports,
    ["badgeVariants", "buttonVariants", "tabsListVariants"],
    `${INDEX_PATH} exports a *Variants beyond shadcn's own three:\n${variantsExports.join(", ")}`,
  );
});
