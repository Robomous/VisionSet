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
);
