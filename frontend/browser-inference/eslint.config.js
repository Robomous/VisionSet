import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Banned as values in every file except the adapter under src/browser/. Scoping by
// `ignores` rather than by an allow-list of core files means the adapter task needs
// no edit here to add its own browser-facing files.
//
// `WebAssembly`, `crossOriginIsolated` and `self` are on the list for this package
// specifically: they are exactly the environment facts core reasons about, and the
// ban is what forces them to arrive as the injected record in src/capabilities.ts
// instead of being read from wherever the code happens to be running.
const BROWSER_HOST = [
  "document",
  "window",
  "self",
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
  "OffscreenCanvas",
  "WebAssembly",
  "crossOriginIsolated",
  "postMessage",
];

const NO_BROWSER_HOST =
  "@visionset/browser-inference core is framework- and browser-free — browser globals live only in src/browser/.";

/** Host globals for the plain-JS halves: the build step, the static server, the page. */
const HOST_GLOBALS = Object.fromEntries(
  ["console", "process", "fetch", "URL", "Blob", "TextEncoder", "setTimeout"].map((name) => [
    name,
    "readonly",
  ]),
);

export default tseslint.config(
  { ignores: ["dist/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs}"],
    ignores: ["eslint.config.js"],
    languageOptions: { globals: HOST_GLOBALS },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/browser/**"],
    rules: {
      "no-restricted-globals": [
        "error",
        ...BROWSER_HOST.map((name) => ({ name, message: NO_BROWSER_HOST })),
      ],
    },
  },
);
