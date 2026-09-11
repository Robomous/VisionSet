import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Flat-config ignores are relative to this file's directory, so the generated client must be
  // named at its real path — "generated/" silently matches nothing now that it lives under src/.
  { ignores: ["dist/", "src/generated/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The Rules of Hooks over the whole package, unlike the annotator, where the
    // same plugin is scoped to `src/adapters/react/**`. There the scope was the
    // point: a rule about React should have nothing to say about a package that is
    // mostly not React. Here every module is a component or is imported by one, so
    // the scope is the package.
    files: ["src/**/*.ts", "src/**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    // `openapi-fetch` describes the request shapes the generated contract
    // declares, and that description is worth borrowing in type position — it is
    // erased at build, so the shipped package holds no reference to it. Importing
    // it as a *value* would put a transport inside the reusable UI, which is the
    // one thing the host boundary exists to prevent.
    //
    // `src/testing` is exempt because it never ships: `tsconfig.build.json`
    // excludes it, and the test harness needs a real client to answer a stubbed
    // `fetch`. The boundary being defended is the shipped reusable UI.
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["src/testing/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "openapi-fetch",
              allowTypeImports: true,
              message:
                "Type-only. A value import puts a transport in the reusable UI — the host supplies the client (see src/data/port.ts).",
            },
          ],
        },
      ],
    },
  },
);
