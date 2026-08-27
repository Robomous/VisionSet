/**
 * Every `<Button>` inside a `<form>` says what kind it is.
 *
 * ## Why this is a gate and not a review note
 *
 * A `<button>` with no `type` is a **submit** button — that is HTML's default,
 * not a browser quirk. The old VisionSet `Button` papered over it by defaulting
 * `type="button"`, so a "Cancel" beside a submit was harmless. The canonical
 * shadcn file does not: it forwards props and adds no default, which is the
 * correct thing for a primitive to do and the reason this rule has to live
 * somewhere else.
 *
 * The failure it prevents is quiet and destructive in the same breath. A
 * "Cancel" that submits does not look broken — it closes the dialog, because the
 * submit handler navigates or the mutation succeeds. The person who pressed it
 * believes they backed out; the record says they went ahead. Nothing in the
 * suite catches that unless a test happens to press Cancel *and* assert the
 * absence of a request, and no jsdom test asserts absence by default.
 *
 * `primitives.test.tsx` used to hold this claim about the primitive. It cannot
 * any more — there is no default left to assert — so the claim moves to where
 * the property now lives: every call site, checked as text.
 *
 * ## The bargain
 *
 * The same one `design_tokens.test.mjs` and `annotator_boundary.test.mjs` strike:
 * the rule is a pure function over one file's text, so the gate proves it fires
 * against fabricated input and then runs it over the repo. It reads
 * `git ls-files` — the **index** — so a merely staged file is checked before any
 * commit lands, and `node_modules/` and `dist/` stay out for free.
 *
 * A text scan is the right instrument here rather than a limitation. The
 * question "is this button inside a form" is answered by the JSX as written; a
 * runtime check would need every dialog opened in every state to see the same
 * pairs, and would still miss the branch that did not render.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const TSX = /\.tsx$/;

/**
 * An attribute named exactly `type`, so `data-type=` and `itemType=` do not
 * satisfy the rule by accident — the lookbehind is the whole point of spelling
 * it out rather than using `\btype=`, which a hyphen satisfies.
 */
const SAYS_TYPE = /(?<![-\w])type=/;

/**
 * Walk an opening JSX tag from `<` to the `>` that closes *it*.
 *
 * Not a regex, because an attribute value legitimately contains the terminator:
 * `onClick={() => close()}` has a `>` in an arrow, `data-testid="a>b"` has one in
 * a string, and `{/* … *\/}` can have one in a comment. Tracking brace depth and
 * quote state answers all three, and anything a JSX attribute can hold is inside
 * one or the other.
 *
 * Returns the tag's source text, or `null` if the file ends mid-tag — which is
 * not valid TSX and would have failed `tsc` long before this gate ran.
 */
function openingTagAt(text, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === ">" && depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** The 1-based line `index` falls on. */
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

/**
 * Every `<form>` … `</form>` span in `text`, as `[start, end)` offsets.
 *
 * A `<form>` may not contain another `<form>` — HTML forbids it and React will
 * not invent one — so the next `</form>` is always the matching close. The
 * gate's own repo pass asserts open/close counts line up, which is what would
 * catch the day that stops being true.
 */
export function formRanges(text) {
  const ranges = [];
  const opens = /<form(?=[\s/>])/g;
  let open;
  while ((open = opens.exec(text)) !== null) {
    const close = text.indexOf("</form>", open.index);
    ranges.push([open.index, close === -1 ? text.length : close + "</form>".length]);
    if (close !== -1) opens.lastIndex = close;
  }
  return ranges;
}

/**
 * Every `<Button` opening tag in `text` whose `<` falls inside one of `ranges`
 * (or anywhere, when `ranges` is `null`), reported as the findings this gate
 * makes: the ones that do not name a `type`.
 *
 * `(?=[\s/>])` is what keeps `<ButtonGroup` out of a rule about buttons.
 */
function typelessButtons(file, text, ranges) {
  const findings = [];
  const tags = /<Button(?=[\s/>])/g;
  let tag;
  while ((tag = tags.exec(text)) !== null) {
    const inside = ranges === null || ranges.some(([from, to]) => tag.index >= from && tag.index < to);
    if (!inside) continue;
    const source = openingTagAt(text, tag.index);
    if (source === null || SAYS_TYPE.test(source)) continue;
    findings.push(`${file}:${lineAt(text, tag.index)}: ${source.split("\n")[0].trim()}`);
  }
  return findings;
}

/** Every `<Button` inside a `<form>` in this file that does not say its type. */
export function typelessFormButtonsIn(file, text) {
  return typelessButtons(file, text, formRanges(text));
}

/** A module-level declaration: the keyword at column 0, optionally exported. */
const TOP_LEVEL = String.raw`(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s`;

/**
 * The `[start, end)` offsets of the component declared as `name`.
 *
 * Needed because "rendered inside a form" is a property of a *component*, not of
 * a file: `SelectionPanel` is declared in `IngestScreen.tsx` — the same file as
 * the form that renders it — several hundred lines below the `</form>`. Scanning
 * the whole file instead would drag in that screen's seven other buttons, none
 * of which is in a form, and the gate would demand `type` on controls that have
 * no submit to trigger.
 *
 * The span runs from the declaration to the next declaration at column 0, rather
 * than by matching the body's braces. Brace matching is the obvious approach and
 * it is wrong here: `function Name({ … }: { … }) { … }` opens its first brace on
 * the *destructured parameter*, so a walk that stops when depth returns to zero
 * stops at the end of the parameter list and never reaches the JSX. That is not a
 * hypothetical — it is what the first draft of this file did, and it made the
 * repo pass below vacuously green because the scanned span contained no
 * `<Button` at all. Hence `assert.ok(found > 0)` in that test, and hence this.
 *
 * Ending at the next top-level declaration over-covers slightly: a trailing
 * comment block belongs to the neighbour. For a gate that is the safe direction —
 * it can only ever ask for a `type` on one button too many, never one too few.
 */
export function componentRange(text, name) {
  const declared = new RegExp(
    String.raw`(?:^|\n)(?:export\s+)?(?:async\s+)?(?:function\s+${name}\b|(?:const|let)\s+${name}\b)`,
  );
  const found = declared.exec(text);
  if (found === null) return null;

  const from = found.index === 0 ? 0 : found.index + 1;
  const next = new RegExp(String.raw`\n${TOP_LEVEL}`, "g");
  next.lastIndex = from + 1;
  const after = next.exec(text);
  return [from, after === null ? text.length : after.index + 1];
}

/**
 * Every `<Button` in the component `name` that does not say its type — for a
 * component rendered inside somebody else's `<form>`, where the enclosing tag is
 * out of reach of any range in the component's own source.
 */
export function typelessButtonsInComponent(file, text, name) {
  const range = componentRange(text, name);
  assert.ok(range !== null, `${file} does not declare ${name}`);
  return typelessButtons(file, text, [range]);
}

test("the scan finds a typeless button in a form, and nothing that merely looks like one", () => {
  const form = (button) => `<form onSubmit={submit}>\n  ${button}\n</form>\n`;

  // The defect itself: inside a form, no type.
  assert.deepEqual(typelessFormButtonsIn("a.tsx", form("<Button>Cancel</Button>")), [
    "a.tsx:2: <Button>",
  ]);
  // And the fix clears it.
  assert.deepEqual(typelessFormButtonsIn("b.tsx", form('<Button type="button">Cancel</Button>')), []);
  assert.deepEqual(typelessFormButtonsIn("c.tsx", form('<Button type="submit">Save</Button>')), []);

  // Outside a form there is no default to get wrong, so it is not this gate's
  // business — a page is full of typeless buttons and all of them are correct.
  assert.deepEqual(typelessFormButtonsIn("d.tsx", "<div>\n  <Button>Open</Button>\n</div>\n"), []);

  // A different component whose name starts the same way is not a Button.
  assert.deepEqual(typelessFormButtonsIn("e.tsx", form("<ButtonGroup><span /></ButtonGroup>")), []);

  // `data-type` is not `type`, and a scan using `\btype=` would accept it.
  assert.deepEqual(typelessFormButtonsIn("f.tsx", form('<Button data-type="ghost">Go</Button>')), [
    "f.tsx:2: <Button data-type=\"ghost\">",
  ]);

  // A multi-line tag is the shape every real call site has, and the `>` in the
  // arrow function must not end it early.
  assert.deepEqual(
    typelessFormButtonsIn(
      "g.tsx",
      '<form onSubmit={submit}>\n  <Button\n    variant="outline"\n    onClick={() => close()}\n  >\n    Cancel\n  </Button>\n</form>\n',
    ),
    ["g.tsx:2: <Button"],
  );
  // Same tag, typed — proving the walker reached the real end rather than
  // stopping somewhere that happened to contain `type=`.
  assert.deepEqual(
    typelessFormButtonsIn(
      "h.tsx",
      '<form onSubmit={submit}>\n  <Button\n    variant="outline"\n    onClick={() => close()}\n    type="button"\n  >\n    Cancel\n  </Button>\n</form>\n',
    ),
    [],
  );
  // A `>` inside a string attribute is not the end of the tag either.
  assert.deepEqual(
    typelessFormButtonsIn("i.tsx", form('<Button data-testid="a>b">Go</Button>')),
    ['i.tsx:2: <Button data-testid="a>b">'],
  );

  // Two forms in one file, which `IngestScreen.tsx` really has: a button in the
  // second is inside a form as much as one in the first, and the space between
  // them is not.
  const two =
    "<form onSubmit={a}>\n  <Button>One</Button>\n</form>\n" +
    "<Button>Between</Button>\n" +
    "<form onSubmit={b}>\n  <Button>Two</Button>\n</form>\n";
  assert.deepEqual(typelessFormButtonsIn("j.tsx", two), ["j.tsx:2: <Button>", "j.tsx:6: <Button>"]);

  // A self-closing button, which carries its label in a prop.
  assert.deepEqual(typelessFormButtonsIn("k.tsx", form('<Button aria-label="Clear" />')), [
    'k.tsx:2: <Button aria-label="Clear" />',
  ]);

  // The component-scoped variant ignores form boundaries, because its callers
  // supply the form from elsewhere — and it stops at the component's own end, so
  // a neighbour's buttons are not its problem.
  const two_components =
    "function Card() {\n  return <Button>Retry</Button>;\n}\n" +
    "function Other() {\n  return <Button>Open</Button>;\n}\n";
  assert.deepEqual(typelessButtonsInComponent("l.tsx", two_components, "Card"), [
    "l.tsx:2: <Button>",
  ]);
  assert.deepEqual(typelessButtonsInComponent("l.tsx", two_components, "Other"), [
    "l.tsx:5: <Button>",
  ]);
  // And a typed one in that component clears.
  assert.deepEqual(
    typelessButtonsInComponent("m.tsx", 'export function Card() {\n  return <Button type="button">Retry</Button>;\n}\n', "Card"),
    [],
  );
});

test("componentRange covers a declaration with a destructured parameter, and stops at its end", () => {
  // The shape every component in this repo has: destructured props, an inline
  // type, then the body.
  const text =
    "function Panel({\n  files,\n}: {\n  readonly files: readonly File[];\n}) {\n  return <Button>Clear</Button>;\n}\n" +
    "function After() {\n  return <Button>No</Button>;\n}\n";
  const [from, to] = componentRange(text, "Panel");
  const body = text.slice(from, to);
  assert.ok(body.includes("Clear"), "the parameter walk must reach the body");
  assert.ok(!body.includes("No"), "and must stop before the next declaration");
  assert.equal(componentRange(text, "Missing"), null);
});

test("formRanges spans the form and stops at its close", () => {
  const text = "x\n<form>\n  y\n</form>\nz\n";
  const [[from, to]] = formRanges(text);
  assert.equal(text.slice(from, to), "<form>\n  y\n</form>");
  // A form left unclosed runs to the end rather than silently spanning nothing,
  // so a malformed file over-reports instead of going quiet.
  assert.deepEqual(formRanges("<form>\n  <Button>x</Button>\n").length, 1);
});

/**
 * Components that hold a `<Button>` and are only ever rendered *inside* somebody
 * else's `<form>`, so the enclosing tag is in a different file.
 *
 * Kept as an explicit list rather than resolved by following imports, because
 * following imports would make the gate a type checker and get the answer wrong
 * at the first conditional render. The list is small on purpose: two entries is
 * a sign the composition is shallow, and a third should prompt the question of
 * whether the form is being assembled too far from itself.
 *
 * The list is asserted **total** below — every name here has to actually appear
 * inside a `<form>` range somewhere — so a stale entry fails the gate rather
 * than quietly widening it, which is the failure mode an allow-list normally has.
 */
const RENDERED_INSIDE_FORMS = {
  // The chosen-files summary inside `IngestScreen`'s upload form; its "Clear"
  // button is a plain control sitting between the file input and Upload. Declared
  // in the same file as that form and several hundred lines below it, which is
  // exactly why this is scoped to the component rather than the file.
  SelectionPanel: "frontend/ui-core/src/screens/IngestScreen.tsx",
  // `AsyncStates`' error card carries a Retry, and `ModelsScreen`'s connection
  // form renders one when the connection list fails to load.
  ErrorState: "frontend/ui-core/src/patterns/AsyncStates.tsx",
};

/** Every tracked `frontend/**\/*.tsx`, read from the index. */
function trackedTsx() {
  const listed = spawnSync("git", ["ls-files", "-z", "frontend"], { cwd: REPO, encoding: "utf8" });
  assert.equal(listed.status, 0, `git ls-files failed: ${listed.stderr}`);
  const tracked = listed.stdout.split("\0").filter((name) => TSX.test(name));
  assert.ok(tracked.length > 0, "the scan found no frontend components, so it proves nothing");
  return tracked;
}

test("every button inside a form says what kind it is", () => {
  const offenders = trackedTsx().flatMap((file) =>
    typelessFormButtonsIn(file, readFileSync(path.join(REPO, file), "utf8")),
  );
  assert.deepEqual(
    offenders,
    [],
    "a <button> with no type is a submit button — the canonical shadcn Button adds no " +
      'default, so a "Cancel" inside a form submits it. Add type="button" (or type="submit" ' +
      `where that is the intent):\n${offenders.join("\n")}`,
  );
});

test("a form's buttons that live in another file are typed too, and the list naming them is current", () => {
  const sources = new Map(
    trackedTsx().map((file) => [file, readFileSync(path.join(REPO, file), "utf8")]),
  );

  const offenders = Object.entries(RENDERED_INSIDE_FORMS).flatMap(([name, file]) => {
    const text = sources.get(file);
    assert.ok(text !== undefined, `RENDERED_INSIDE_FORMS names ${file}, which is not tracked`);

    // The non-vacuity guard, and it has already earned its place: an earlier
    // `componentRange` stopped at the destructured parameter list, so this scan
    // ran over a span with no JSX in it and reported nothing wrong. A component
    // listed here is listed *because* it holds a button, so a span with none in
    // it means the span is wrong, not that the code is clean.
    const [from, to] = componentRange(text, name);
    assert.ok(
      /<Button(?=[\s/>])/.test(text.slice(from, to)),
      `${name} is listed as holding a button and the scanned span of ${file} has none — ` +
        "componentRange is not covering the component's JSX",
    );

    return typelessButtonsInComponent(file, text, name);
  });
  assert.deepEqual(
    offenders,
    [],
    "this component renders inside somebody's <form>, so its buttons need a type for the " +
      `same reason the form's own do:\n${offenders.join("\n")}`,
  );

  // The half that keeps the list honest: a name that no longer renders inside a
  // form is an allowance nobody is using, and it would go on excusing the file
  // from nothing while reading as though it meant something.
  const insideSomeForm = (name) =>
    [...sources].some(([, text]) => {
      const ranges = formRanges(text);
      const uses = new RegExp(`<${name}(?=[\\s/>])`, "g");
      let use;
      while ((use = uses.exec(text)) !== null) {
        if (ranges.some(([from, to]) => use.index >= from && use.index < to)) return true;
      }
      return false;
    });

  const stale = Object.keys(RENDERED_INSIDE_FORMS).filter((name) => !insideSomeForm(name));
  assert.deepEqual(
    stale,
    [],
    "RENDERED_INSIDE_FORMS names a component that is no longer rendered inside any <form>. " +
      `Drop the entry rather than leaving the gate an allowance it does not need:\n${stale.join("\n")}`,
  );
});

test("the forms this gate is about are all still there, and none nests", () => {
  // Not a headcount for its own sake: the scan is only as good as its ability to
  // find a form at all, and a refactor that renamed the element or moved to a
  // form library would leave every assertion above vacuously green.
  const withForms = trackedTsx()
    .map((file) => [file, readFileSync(path.join(REPO, file), "utf8")])
    .filter(([, text]) => formRanges(text).length > 0);

  assert.deepEqual(
    withForms.map(([file]) => file).sort(),
    [
      "frontend/ui-core/src/data/TokenGate.tsx",
      "frontend/ui-core/src/screens/DatasetScreen.tsx",
      "frontend/ui-core/src/screens/IngestScreen.tsx",
      "frontend/ui-core/src/screens/ModelsScreen.tsx",
      "frontend/ui-core/src/screens/ProjectFrame.tsx",
      "frontend/ui-core/src/screens/ProjectsScreen.tsx",
    ],
    "a form appeared or moved. That is fine — add it here, having checked its buttons say " +
      "their type.",
  );

  // `formRanges` trusts that a form never contains another, which is what makes
  // "the next `</form>`" the matching close. This is that assumption, checked.
  for (const [file, text] of withForms) {
    const opens = text.match(/<form(?=[\s/>])/g) ?? [];
    const closes = text.match(/<\/form>/g) ?? [];
    assert.equal(
      opens.length,
      closes.length,
      `${file} has ${opens.length} <form> and ${closes.length} </form>`,
    );
  }
});
