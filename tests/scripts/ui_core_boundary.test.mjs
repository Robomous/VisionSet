// tests/scripts/ui_core_boundary.test.mjs
// Run with: pnpm test:scripts  (also part of the root `pnpm test`)
//
// The host boundary's gate. `@visionset/ui-core` is the reusable half of the
// frontend: it renders VisionSet's domain and reaches data through a contract the
// host satisfies. What it must not contain is this application's transport or this
// application's credential — and "must not" stated in a design document is a rule
// that survives exactly as long as nobody is in a hurry.
//
// Scoped to shipped source. Test files and `src/testing` are excluded because
// `tsconfig.build.json` excludes them from `dist`: the harness legitimately builds
// a client to answer a stubbed `fetch`. `src/generated/` is NOT excluded — it IS
// shipped (`tsconfig.build.json` does not exclude it, unlike the two above), and
// `openapi-typescript` emits only types today: verified empirically, zero hits
// under every rule below. A blind spot closeable for free is closed, not scoped
// around with a comment that conflates "generated" with "not shipped".
//
// Every rule is a pure function over file text, so the gate is proved to fire by a
// planted corpus that is never written to the repository — the same bargain
// `annotator_boundary.test.mjs` and `checks_wiring.test.mjs` struck. And every rule
// keeps a planted-probe test asserting both halves — the violation it targets is
// caught, and the legitimate neighbouring form beside it is not — because a gate
// proven only by its positive case has not been proven against the case it exists
// to distinguish from.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

/** Shipped `ui-core` source: no tests, no harness. `.mts`/`.cts`/`.mjs`/`.cjs` count as
 * source too — `tsc` compiles them, and a filter that only knew `.ts`/`.tsx`/`.js`/`.jsx`
 * would silently stop covering a file the moment one appeared. */
function shippedSource() {
  return execFileSync("git", ["ls-files", "frontend/ui-core/src"], { cwd: REPO, encoding: "utf8" })
    .split("\n")
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file))
    .filter((file) => !/\.test\.[jt]sx?$/.test(file))
    .filter((file) => !file.startsWith("frontend/ui-core/src/testing/"))
    .map((file) => ({ path: file, text: readFileSync(path.join(REPO, file), "utf8") }));
}

/**
 * Text that would mean the reusable UI knows how a request is made, or which
 * credential makes it.
 *
 * Each pattern names a thing the host owns. `import.meta.env` is here because a
 * package that reads the bundler's environment can only be built one way, which is
 * the same failure in a different costume.
 */
const TRANSPORT = [
  [/\bfetch\s*\(/, "calls fetch — the host supplies the client"],
  [/\bAuthorization\b/, "names an Authorization header"],
  [/\bBearer\b/, "names a bearer credential"],
  [/["'`]\/session\b/, "probes /session — the OSS server's own sign-in"],
  [/\bimport\.meta\.env\b/, "reads the bundler environment"],
  // A *value* import only. `import type { … } from "openapi-fetch"` is how the port
  // borrows the contract's request shapes, is erased at build, and must pass — a
  // pattern that caught it would be a gate the correct code cannot satisfy, and the
  // fix would be to delete the types that make the port a contract.
  [
    /^\s*import\s+(?!type\b)[^;]*\bfrom\s+["']openapi-fetch["']/m,
    "value-imports openapi-fetch (type imports use `import type`)",
  ],
  [/\brequire\(\s*["']openapi-fetch["']\s*\)/, "require()s openapi-fetch"],
];

/** The two persisted things that belong to the OSS host, by their storage keys. */
const HOST_STORAGE = [
  [/["']visionset\.token["']/, "persists the OSS credential"],
  [/["']visionset\.rail["']/, "persists the standalone shell's rail"],
];

/**
 * Web storage reached from the data layer.
 *
 * Narrower than banning browser storage outright: a reusable component may
 * legitimately remember a per-viewer preference, and `data/prefs.ts` is exactly
 * that. What may not happen is the *data layer* acquiring a credential's or a
 * session's persistence again. Hoisted to module scope, alongside the predicate
 * that scopes it, so the self-test below can prove both against the same objects
 * the real assertion uses — proving the exemption rather than assuming it.
 */
const DATA_LAYER_STORAGE = [[/\b(?:localStorage|sessionStorage)\b/, "reaches web storage from the data layer"]];
const inDataLayer = (file) => file.startsWith("frontend/ui-core/src/data/") && !file.endsWith("prefs.ts");

/**
 * Reading a `DataResult`'s status as meaning.
 *
 * The invariant, in its exact wording:
 *
 *   No semantic branching on `DataResult.status` exists in reusable `ui-core`.
 *   `data/errors.ts` may presence-check `status` solely to carry diagnostics.
 *
 * The first pattern is deliberately narrow: a `.status` compared against a numeric
 * literal, not against an identifier spelled `result` and not against any
 * comparison at all. Naming `result` specifically was the mistake — `const r =
 * await client.GET(...); r.status === 404` is the same violation wearing a
 * different identifier, and the old pattern missed it. Requiring the comparison
 * to land on a digit is what keeps this pattern off `errors.ts`'s own
 * `result.status === undefined`: that line presence-checks a status to carry it
 * into a diagnostic, `undefined` is not a digit, and the pattern does not fire —
 * so `errors.ts` needs no by-name exemption from this rule at all, and doesn't get
 * one below. It is also, on purpose, no wider than that: `suggest.status ===
 * "running"` compares `.status` to a string, not a digit, and stays legitimate —
 * `status` is a perfectly good word elsewhere in the package.
 *
 * It does not catch `const { status } = await client.GET(...); if (status ===
 * 404)` — no member access, no `.status` for the pattern to match. That
 * destructured form does not occur in this package today (verified by grep over
 * `frontend/ui-core/src` and `frontend/app/src`); catching it would need a second,
 * wider pattern for a bare `status` identifier, which was not asked for here and
 * would need its own false-positive audit before it could be armed.
 *
 * The second pattern is unrelated to `DataResult` entirely: reading an HTTP
 * response's own `.status` — the shape `openapi-fetch` hands back before the port
 * translates it — is exactly the interpretation the port exists to keep out of
 * reusable code, comparison or not.
 */
const STATUS_AS_MEANING = [
  [
    /\.status\s*(===|!==|==|!=|<|>|<=|>=)\s*\d/,
    "compares a status to a numeric literal — the code is the meaning, the status is diagnostic",
  ],
  [/\.response\.status\b/, "reads an HTTP response's status"],
];

// Every symbol section 8 of the design retires from the public surface, named
// individually. `ApiProviderProps` and `TokenGateProps` are listed in full rather
// than assumed caught by `ApiProvider`/`TokenGate`: `\bApiProvider\b` does not
// match inside `ApiProviderProps` (the character right after is `P`, a word
// character, so there is no boundary there), and the same is true of
// `TokenGate`/`TokenGateProps`. A pattern built from the shorter name would let the
// longer one back onto the surface.
const REMOVED_EXPORTS = [
  "createApiClient",
  "ApiClientOptions",
  "VisionSetClient",
  "ApiProvider",
  "ApiProviderProps",
  "useApiSession",
  "ApiSession",
  "Access",
  "TokenGate",
  "TokenGateProps",
  "TokenForm",
  "readToken",
  "writeToken",
  "clearToken",
  "RAIL_COLLAPSED_BY_DEFAULT",
  "readRailCollapsed",
  "writeRailCollapsed",
];

/** Which of `REMOVED_EXPORTS` a chunk of text still names. */
function offeredRemovedExports(text) {
  return REMOVED_EXPORTS.filter((name) => new RegExp(`\\b${name}\\b`).test(text));
}

/** Every violation in a corpus, as `path: reason` strings. */
function violations(files, rules, only = () => true) {
  const found = [];
  for (const { path: file, text } of files) {
    if (!only(file)) continue;
    for (const [pattern, reason] of rules) {
      if (pattern.test(text)) found.push(`${file}: ${reason}`);
    }
  }
  return found;
}

test("the reusable UI does not know how a request is made", () => {
  assert.deepEqual(violations(shippedSource(), TRANSPORT), []);
});

test("the reusable UI persists neither the OSS credential nor the shell's state", () => {
  assert.deepEqual(violations(shippedSource(), HOST_STORAGE), []);
});

test("web storage is not reached from the data layer", () => {
  assert.deepEqual(violations(shippedSource(), DATA_LAYER_STORAGE, inDataLayer), []);
});

test("no semantic branching on DataResult.status in reusable ui-core", () => {
  assert.deepEqual(violations(shippedSource(), STATUS_AS_MEANING), []);
});

test("the public surface offers none of the host's concerns", () => {
  const index = readFileSync(path.join(REPO, "frontend/ui-core/src/index.ts"), "utf8");
  const offered = offeredRemovedExports(index);
  assert.deepEqual(offered, [], `index.ts still offers: ${offered.join(", ")}`);
});

test("the gate fires on a violation", () => {
  // Without this, every assertion above could be passing because the patterns
  // match nothing at all. One planted line per pattern, each written so it trips
  // exactly one pattern — verified so a neutered pattern changes the count, not
  // just its sign, and a mutation to one pattern cannot hide behind another's hit.
  const transportViolations = [
    { path: "frontend/ui-core/src/screens/Bad.tsx", text: 'await fetch("/projects");\n' },
    { path: "frontend/ui-core/src/data/BadAuth.ts", text: "const headers = { Authorization: token };\n" },
    { path: "frontend/ui-core/src/data/BadBearer.ts", text: 'const scheme = "Bearer";\n' },
    { path: "frontend/ui-core/src/data/BadSession.ts", text: 'await client.GET("/session");\n' },
    { path: "frontend/ui-core/src/data/BadEnv.ts", text: "const base = import.meta.env.API_URL;\n" },
    { path: "frontend/ui-core/src/data/BadImport.ts", text: 'import { createClient } from "openapi-fetch";\n' },
    { path: "frontend/ui-core/src/data/Required.ts", text: 'const c = require("openapi-fetch");\n' },
  ];
  assert.equal(violations(transportViolations, TRANSPORT).length, transportViolations.length);

  const storageViolations = [
    { path: "frontend/ui-core/src/data/BadToken.ts", text: 'const k = "visionset.token";\n' },
    { path: "frontend/ui-core/src/data/BadRail.ts", text: 'const k = "visionset.rail";\n' },
  ];
  assert.equal(violations(storageViolations, HOST_STORAGE).length, storageViolations.length);

  const dataLayerViolations = [
    {
      path: "frontend/ui-core/src/data/BadStorage.ts",
      text: 'localStorage.setItem("visionset.gallery.density", "compact");\n',
    },
  ];
  assert.equal(violations(dataLayerViolations, DATA_LAYER_STORAGE, inDataLayer).length, 1);

  const statusViolations = [
    { path: "frontend/ui-core/src/screens/Worse.ts", text: "if (result.status === 404) return null;\n" },
    { path: "frontend/ui-core/src/data/BadResponseStatus.ts", text: "const s = result.response.status;\n" },
  ];
  assert.equal(violations(statusViolations, STATUS_AS_MEANING).length, statusViolations.length);

  assert.deepEqual(offeredRemovedExports('export type { ApiProviderProps } from "./x.js";\n'), ["ApiProviderProps"]);
  assert.deepEqual(offeredRemovedExports('export type { TokenGateProps } from "./x.js";\n'), ["TokenGateProps"]);
  assert.deepEqual(offeredRemovedExports('export type { Access } from "./x.js";\n'), ["Access"]);
});

test("the gate does NOT fire on the legitimate neighbouring form", () => {
  // The other half of every probe above, and the half usually left out. A rule
  // that catches the violation and the correct code beside it is not a gate, it is
  // a ban on writing the code correctly — and it gets "fixed" by deleting the
  // correct code. Every form below is either what this repository actually ships,
  // or a realistic neighbour a correct pattern must leave alone.
  const legitimateTransport = [
    {
      path: "frontend/ui-core/src/data/port.ts",
      // Type-only, erased at build. This is how the port borrows the contract's
      // request shapes, and it must pass.
      text: 'import type { Client, MaybeOptionalInit } from "openapi-fetch";\n',
    },
    { path: "frontend/ui-core/src/data/FetchPolicy.ts", text: 'const fetchPolicy = "network-first";\n' },
    { path: "frontend/ui-core/src/data/Auth.ts", text: 'const authorization = "n/a";\n' },
    { path: "frontend/ui-core/src/data/Bearer.ts", text: "const clearBearerCache = true;\n" },
    { path: "frontend/ui-core/src/data/Sessions.ts", text: 'await client.GET("/sessions");\n' },
    { path: "frontend/ui-core/src/data/Meta.ts", text: "const url = import.meta.url;\n" },
    { path: "frontend/ui-core/src/data/Types.ts", text: 'const c = require("openapi-types");\n' },
  ];
  assert.deepEqual(violations(legitimateTransport, TRANSPORT), []);

  const legitimateStorage = [{ path: "frontend/ui-core/src/data/Theme.ts", text: 'const k = "visionset.theme";\n' }];
  assert.deepEqual(violations(legitimateStorage, HOST_STORAGE), []);

  const legitimateDataLayer = [
    {
      path: "frontend/ui-core/src/data/prefs.ts",
      // A per-viewer preference is not a credential, and `prefs.ts` is exempt by
      // name — run against `DATA_LAYER_STORAGE`/`inDataLayer` themselves, the same
      // objects the real assertion above uses, so the exemption is proved rather
      // than assumed.
      text: 'localStorage.setItem("visionset.gallery.density", "compact");\n',
    },
  ];
  assert.deepEqual(violations(legitimateDataLayer, DATA_LAYER_STORAGE, inDataLayer), []);

  const legitimateStatus = [
    {
      path: "frontend/ui-core/src/data/errors.ts",
      // Carriage, not branching: the status travels into the error so a bug report
      // can quote it. Nothing decides anything from it. This line contains `===`
      // and is SUPPOSED to pass — which is why the invariant is worded "no semantic
      // branching on DataResult.status in reusable ui-core; data/errors.ts may
      // presence-check status solely to carry diagnostics", and not "no status
      // comparison exists". The second wording would make this probe a lie.
      text: "const carry = { ...(result.status === undefined ? {} : { status: result.status }) };\n",
    },
    {
      path: "frontend/ui-core/src/screens/Suggest.ts",
      // `status` is a perfectly good word elsewhere in the package — a suggest
      // session has one, and comparing it to a string is not the violation this
      // rule exists to catch.
      text: 'if (suggestion.status === "running") return;\n',
    },
  ];
  assert.deepEqual(violations(legitimateStatus, STATUS_AS_MEANING), []);

  assert.deepEqual(
    offeredRemovedExports('export { VisionSetDataProvider, type VisionSetDataProviderProps } from "./x.js";\n'),
    [],
  );
});

test("the status pattern is not defeated by renaming the variable", () => {
  // The old pattern named `result` literally, so `const r = await client.GET(...);
  // r.status === 404` sailed straight through it. The new one matches `.status`
  // compared to a digit regardless of what identifier sits before the dot.
  assert.equal(
    violations(
      [{ path: "frontend/ui-core/src/screens/Renamed.ts", text: "const r = result; if (r.status === 404) return;\n" }],
      STATUS_AS_MEANING,
    ).length,
    1,
  );
  // The destructured form still gets through — documented above as the pattern's
  // known, deliberate limit, and pinned here so a future change to that limit is a
  // visible diff rather than a silent one.
  assert.deepEqual(
    violations(
      [{ path: "frontend/ui-core/src/screens/Destructured.ts", text: "const { status } = r; if (status === 404) return;\n" }],
      STATUS_AS_MEANING,
    ),
    [],
  );
});
