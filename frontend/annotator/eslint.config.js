import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The headless boundary, machine-enforced (mirror of the backend's
    // import-linter kernel contracts): no React anywhere inside src/core/.
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
    },
  }
);
