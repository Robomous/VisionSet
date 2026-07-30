// Run with: pnpm test:scripts  (also part of the root `pnpm test`)
//
// The headless boundary's own gate, tested. #112's complaint was that the rule was stated in three
// places and enforced in one; a gate with no test proving it fires is a weaker version of the same
// problem — "core is DOM-free" would still be an assertion about a config nobody exercises.
//
// Nothing that fails is committed. The negative probe is written into a mkdtemp directory and the
// eslint half goes through `--stdin`, which touches no file at all — the same bargain
// tests/architecture/test_tracked_file_sizes.py struck: the rule is a pure function, so "fails on a
// deliberate violation" is proved by a test containing no violation.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const PACKAGE = fileURLToPath(new URL("../../frontend/annotator/", import.meta.url));
const TSC = path.join(PACKAGE, "node_modules", ".bin", "tsc");
const ESLINT = path.join(PACKAGE, "node_modules", ".bin", "eslint");

/** Run one of the package's own binaries from the package directory. */
function run(bin, args, input) {
  const result = spawnSync(bin, args, { cwd: PACKAGE, encoding: "utf8", input });
  assert.equal(result.error, undefined, `failed to run ${path.basename(bin)}: ${result.error}`);
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const DOM_GLOBAL = 'document.addEventListener("keydown", () => undefined);\n';

test("the shipped engine compiles with no DOM lib at all", () => {
  // Acceptance criterion 4, mechanically: nothing in core touches the DOM today, so the gate lands
  // green rather than needing the sources changed to fit it.
  const { status, output } = run(TSC, ["-p", "tsconfig.core.json"]);
  assert.equal(status, 0, `tsconfig.core.json should compile clean:\n${output}`);
});

test("the react adapter still compiles against the DOM", () => {
  // Acceptance criterion 2. The boundary project is a second `noEmit` pass over the same tree — the
  // backend's lint-imports shape — not a build-graph split, so the real build is untouched.
  const { status, output } = run(TSC, ["-p", "tsconfig.build.json", "--noEmit"]);
  assert.equal(status, 0, `the package build should compile clean:\n${output}`);
});

test("no @types package reaches the boundary project", () => {
  // The root cause of the hole below, pinned directly. `types: []` blocks the automatic @types
  // inclusion but NOT the one `jsx: "react-jsx"` performs — that setting imports
  // `react/jsx-runtime`'s types into every file, which drags in @types/react/global.d.ts and its
  // empty `interface KeyboardEvent {}` / `interface SVGSVGElement {}` stand-ins. This fails the
  // moment `jsx: "preserve"` leaves tsconfig.core.json, which is the only warning anyone would get.
  const { status, output } = run(TSC, ["-p", "tsconfig.core.json", "--listFiles", "--noEmit"]);
  assert.equal(status, 0, output);
  const ambient = output.split("\n").filter((line) => line.includes("/@types/"));
  assert.deepEqual(ambient, [], `the engine's compile must see no ambient types:\n${ambient.join("\n")}`);
});

test("a DOM global and a DOM type in a signature both fail the core project", () => {
  // Acceptance criterion 1, for the half that matters most. The probe extends the *committed*
  // config, so this is the shipped gate under test and not a hand-made imitation of it; `include: []`
  // keeps the real tree out, leaving the probe's own errors as the only ones there can be.
  //
  // The scratch directory goes INSIDE the package, not in os.tmpdir(), and that is not a detail: a
  // file under /tmp resolves no `node_modules` at all, so `jsx: "react-jsx"` finds no @types/react
  // and the probe reports TS2304 whether the gate works or not. Measured — from /tmp this test passed
  // with the hole wide open. A dot-prefixed name keeps it out of every `include`, out of `eslint src`
  // and out of vitest's glob while it exists, and `finally` removes it.
  const scratch = mkdtempSync(path.join(PACKAGE, ".boundary-probe-"));
  try {
    const probe = path.join(scratch, "probe.ts");
    writeFileSync(
      probe,
      "export function onKey(event: KeyboardEvent): boolean {\n" +
        `  ${DOM_GLOBAL.trim()}\n` +
        "  return event !== null;\n" +
        "}\n" +
        "export function getSvgSize(svg: SVGSVGElement): number {\n" +
        "  return svg.clientWidth;\n" +
        "}\n",
    );
    const config = path.join(scratch, "tsconfig.probe.json");
    writeFileSync(
      config,
      JSON.stringify({
        extends: path.join(PACKAGE, "tsconfig.core.json"),
        include: [],
        files: [probe],
      }),
    );

    const { status, output } = run(TSC, ["-p", config]);
    assert.notEqual(status, 0, "a DOM leak inside core must fail the boundary project");
    // The assertions name the diagnostic CODE, not just the identifier, and that is the whole point.
    // TS2304/TS2584 mean the name does not exist; a bare /SVGSVGElement/ match also passes on TS2339
    // ("property 'clientWidth' does not exist on type 'SVGSVGElement'"), which is what this gate
    // reported while @types/react's empty stand-ins were still in scope — a broken gate that looked
    // like a working one. `KeyboardEvent` is the case that had no error at all: a signature with no
    // property access, and the exact shape #46 will want.
    assert.match(output, /error TS2584: Cannot find name 'document'/, output);
    assert.match(output, /error TS2304: Cannot find name 'KeyboardEvent'/, output);
    assert.match(output, /error TS2304: Cannot find name 'SVGSVGElement'/, output);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("eslint refuses a browser global inside core", () => {
  // The half that covers *.test.ts, which the type gate deliberately excludes.
  const { status, output } = run(
    ESLINT,
    ["--stdin", "--stdin-filename", "src/core/probe.ts"],
    DOM_GLOBAL,
  );
  assert.notEqual(status, 0, "`document` inside core must fail lint");
  assert.match(output, /no-restricted-globals/, output);
});

test("the same line is legal in an adapter", () => {
  // The negative control that proves the scope is a scope. Without it, a rule accidentally applied
  // to the whole package would pass every assertion above.
  const { status, output } = run(
    ESLINT,
    ["--stdin", "--stdin-filename", "src/adapters/react/probe.ts"],
    DOM_GLOBAL,
  );
  assert.equal(status, 0, `the DOM belongs in an adapter:\n${output}`);
});

test("the react import ban still fires", () => {
  // A regression pin: #112 edited the config object that rule lives in.
  const { status, output } = run(
    ESLINT,
    ["--stdin", "--stdin-filename", "src/core/probe.ts"],
    'import "react";\n',
  );
  assert.notEqual(status, 0, "a react import inside core must fail lint");
  assert.match(output, /no-restricted-imports/, output);
});
