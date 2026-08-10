import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// The browser host, banned by name inside src/core/. `no-undef` is off for TypeScript files (the
// tseslint preset disables it, since the compiler owns that question), which is why `document`
// reports nothing without this rule.
//
// Timers, `console`, `fetch` and `AbortController` are deliberately absent: they are banned in the
// engine by tsconfig.core.json's `lib`/`types`, and this rule also covers `*.test.ts`, where a
// vitest test reaching for a timer is harmless.
const BROWSER_HOST = [
  "document",
  "window",
  "navigator",
  "location",
  "history",
  "screen",
  "localStorage",
  "sessionStorage",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
  "matchMedia",
  "alert",
  "confirm",
  "prompt",
  "ResizeObserver",
  "IntersectionObserver",
  "MutationObserver",
  "DOMParser",
  "XMLHttpRequest",
];

const NO_BROWSER_HOST =
  "@visionset/annotator core is headless — the DOM lives in src/adapters/. Take values as arguments and return plain data.";

export default tseslint.config(
  { ignores: ["dist/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The headless boundary, machine-enforced (mirror of the backend's import-linter kernel
    // contracts). Two rules here, because each reaches somewhere the other cannot:
    //
    //   no-restricted-imports  — no React anywhere inside src/core/.
    //   no-restricted-globals  — no browser host object, as a *value*, in any core file, the vitest
    //                            harness included.
    //
    // The third gate is tsconfig.core.json, which compiles the shipped engine with no DOM `lib` at
    // all and so catches a DOM type in a *signature* — the case a lint rule reading value references
    // is blind to, and the one that actually leaked in v1. `pnpm lint` runs both.
    files: ["src/core/**/*.ts", "src/core/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["react", "react/*", "react-dom", "react-dom/*", "react-*"],
              message:
                "@visionset/annotator core is headless — React only lives in src/adapters/.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        ...BROWSER_HOST.map((name) => ({ name, message: NO_BROWSER_HOST })),
      ],
    },
  },
  {
    // The Rules of Hooks, over the one directory that has any. A hook called
    // conditionally or a stale dependency is precisely the class of bug the three
    // gates above are blind to: `tsc` type-checks a conditional `useRef` happily,
    // and a `useEffect` reading a value it does not depend on is well-typed and
    // wrong.
    //
    // Scoped to `src/adapters/react/**` rather than applied package-wide, for the
    // same reason the boundary rules are scoped to `src/core/**`: a rule whose
    // subject is React should have nothing to say about a package that is
    // mostly not React.
    files: ["src/adapters/react/**/*.ts", "src/adapters/react/**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  }
);
