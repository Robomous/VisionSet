// Run with: pnpm test:scripts  (also part of the root `pnpm test`)
//
// The frames route refuses a request carrying more than `FRAMES_PER_REQUEST` parts
// with a 422, and the browser's frame sink slices its uploads at its own copy of
// that number. The generated client is types only, so even a `maxItems` in the
// schema would reach the sink as no value at all — nothing but this gate holds the
// copies together (#849). The route's docstring states it too, and that prose
// is published in `openapi.json` as the operation's description.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const ROUTE = "src/visionset/server/routes/video_imports.py";
const SINK = "frontend/app/src/data/frameSink.ts";
const SINK_TEST = "frontend/app/src/data/frameSink.test.ts";

const SPELLINGS = [
  { file: ROUTE, label: "the enforced constant", pattern: /^FRAMES_PER_REQUEST: Final = (\d+)$/gm },
  { file: ROUTE, label: "the route's docstring", pattern: /at most (\d+) parts per request/g },
  { file: SINK, label: "the client's chunk size", pattern: /^export const FRAMES_PER_REQUEST = (\d+);$/gm },
];

const read = (file) => readFileSync(path.join(ROOT, file), "utf8");

/** Every spelling's value, or a reason it could not be read as exactly one. */
function measure(texts) {
  return SPELLINGS.map(({ file, label, pattern }) => {
    const found = [...texts[file].matchAll(pattern)].map((match) => Number(match[1]));
    return { file, label, found };
  });
}

function disagreements(texts) {
  const spellings = measure(texts);
  const problems = spellings
    .filter(({ found }) => found.length !== 1)
    .map(({ file, label, found }) => `${file}: expected exactly one match for ${label}, found ${found.length}`);
  if (problems.length > 0) return problems;
  const values = new Set(spellings.map(({ found }) => found[0]));
  if (values.size === 1) return [];
  return [
    "FRAMES_PER_REQUEST disagrees across server and client — the server's value is the bound, " +
      "the others must follow it:\n" +
      spellings.map(({ file, label, found }) => `  ${file} (${label}): ${found[0]}`).join("\n"),
  ];
}

const committed = () => ({ [ROUTE]: read(ROUTE), [SINK]: read(SINK) });

test("the server's bound and the client's chunk size are one number", () => {
  assert.deepEqual(disagreements(committed()), []);
});

test("the sink's test takes the bound from the sink instead of restating it", () => {
  const text = read(SINK_TEST);
  assert.match(text, /import \{[^}]*\bFRAMES_PER_REQUEST\b[^}]*\} from "\.\/frameSink";/);
  assert.doesNotMatch(text, /\bconst FRAMES_PER_REQUEST\b/, `${SINK_TEST} declares its own copy`);
});

test("the gate fires on a drifted copy", () => {
  const texts = committed();
  const drifted = { ...texts, [SINK]: texts[SINK].replace(/(export const FRAMES_PER_REQUEST = )\d+;/, "$164;") };
  const [problem] = disagreements(drifted);
  assert.ok(problem, "a client copy of 64 against the server's bound passed");
  for (const file of [ROUTE, SINK]) assert.ok(problem.includes(file), `the message does not name ${file}`);
});

test("the gate fires when a spelling disappears", () => {
  const texts = committed();
  const renamed = { ...texts, [ROUTE]: texts[ROUTE].replace("FRAMES_PER_REQUEST: Final", "MAX_FRAMES: Final") };
  assert.deepEqual(disagreements(renamed), [`${ROUTE}: expected exactly one match for the enforced constant, found 0`]);
});
