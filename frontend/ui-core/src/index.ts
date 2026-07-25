/**
 * @visionset/ui-core — domain components, design tokens, generated API client.
 *
 * Components land in later sessions (Radix + lucide only for primitives).
 * For now this package exposes the token names so consumers reference CSS
 * custom properties through typed constants instead of raw strings.
 */

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
