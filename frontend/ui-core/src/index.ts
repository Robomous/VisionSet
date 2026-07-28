/**
 * @visionset/ui-core — domain components, design tokens, generated API client.
 *
 * Components land in later sessions (Radix + lucide only for primitives).
 * For now this package exposes the token names so consumers reference CSS
 * custom properties through typed constants instead of raw strings, and the
 * typed API client generated from the committed openapi.json.
 */

export { createApiClient } from "./client.js";
export type { ApiClientOptions, VisionSetClient } from "./client.js";

// The generated contract, re-exported under the names every openapi-typescript consumer
// expects. Listed explicitly rather than `export *` so the public surface stays auditable.
export type { components, operations, paths } from "./generated/api.js";

export const tokens = {
  colorBg: "--vs-color-bg",
  colorSurface: "--vs-color-surface",
  colorBorder: "--vs-color-border",
  colorText: "--vs-color-text",
  colorTextMuted: "--vs-color-text-muted",
  colorAccent: "--vs-color-accent",
  colorDanger: "--vs-color-danger",
  space1: "--vs-space-1",
  space2: "--vs-space-2",
  space3: "--vs-space-3",
  space4: "--vs-space-4",
  radius: "--vs-radius",
  fontSans: "--vs-font-sans",
  fontMono: "--vs-font-mono",
} as const;

export type TokenName = (typeof tokens)[keyof typeof tokens];
