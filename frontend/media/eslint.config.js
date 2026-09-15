import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Banned as values in every file except the mediabunny adapter, which does not exist
// yet — scoping by `ignores` rather than `files: ["src/index.ts"]` means the adapter
// task needs no edit here to add its own browser-facing files under src/mediabunny/.
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
  "Worker",
  "VideoDecoder",
  "OffscreenCanvas",
];

const NO_BROWSER_HOST =
  "@visionset/media core is framework- and browser-free — browser globals live only in src/mediabunny/.";

/** Host globals for the plain-JS halves: the static server, the generator, the page. */
const HOST_GLOBALS = Object.fromEntries(
  [
    "console",
    "process",
    "fetch",
    "File",
    "Blob",
    "URL",
    "OffscreenCanvas",
    "createImageBitmap",
    "setTimeout",
  ].map((name) => [name, "readonly"]),
);

export default tseslint.config(
  { ignores: ["dist/", "test-fixtures/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs}"],
    ignores: ["eslint.config.js"],
    languageOptions: { globals: HOST_GLOBALS },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/mediabunny/**"],
    rules: {
      "no-restricted-globals": [
        "error",
        ...BROWSER_HOST.map((name) => ({ name, message: NO_BROWSER_HOST })),
      ],
    },
  },
);
