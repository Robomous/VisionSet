import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * A Tailwind arbitrary value whose content is a colour: `bg-[#fff]`,
 * `text-[rgb(0 0 0)]`, `ring-[var(--x)]`. `@robomous/ui-core` closes Tailwind's
 * palette, so this is the one road left for a literal to enter a class string.
 */
const COLOUR_IN_CLASS = String.raw`-\[\s*(?:#|rgba?\(|hsla?\(|oklch\(|var\(--)`;
const COLOUR_MESSAGE =
  "Colour belongs to the token contract: name the intent (bg-primary, text-warning) " +
  "or add a token to frontend/ui-core/src/styles.css, never a literal inside a class.";

export default tseslint.config(
  { ignores: ["dist/", "playwright-report/", "test-results/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: `Literal[value=/${COLOUR_IN_CLASS}/]`, message: COLOUR_MESSAGE },
        { selector: `TemplateElement[value.raw=/${COLOUR_IN_CLASS}/]`, message: COLOUR_MESSAGE },
      ],
    },
  },
);
