import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Flat-config ignores are relative to this file's directory, so the generated client must be
  // named at its real path — "generated/" silently matches nothing now that it lives under src/.
  { ignores: ["dist/", "src/generated/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended
);
