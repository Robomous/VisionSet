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
    // declares, and that description is worth borrowing in type position. It is
    // erased from emitted JavaScript, though emitted declarations intentionally
    // retain the type references, so it remains a consumer-resolvable dependency.
    // Importing it as a *value* would put a transport inside the reusable UI,
    // which is the one thing the host boundary exists to prevent.
    //
    // `src/testing` is exempt because it never ships: `tsconfig.build.json`
    // excludes it, and the test harness needs a real client to answer a stubbed
    // `fetch`. The boundary being defended is the shipped reusable UI.
    //
    // `@visionset/media/*` is the second boundary, and the same shape of one: the
    // package root is core arithmetic and contracts, its `/mediabunny` subpath is a
    // decoder with a worker and WebCodecs in it. Which decoder is the host's answer,
    // so the reusable UI takes a materializer and never imports one. There is a text
    // scan over this in `tests/scripts/ui_core_boundary.test.mjs`; this is the same
    // rule stated where the compiler can see the import rather than the characters.
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
          patterns: [
            {
              group: ["@visionset/media/*"],
              message:
                "A decoder belongs to the host, not the reusable UI — take a VideoMaterializer through VisionSetMediaProvider (see src/media/port.ts).",
            },
          ],
        },
      ],
    },
  },
);
