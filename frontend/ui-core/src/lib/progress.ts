// Canonical `Progress` reads `value` only to size the indicator and never
// forwards it to Radix's `Root`, so the number a screen reader would announce
// is otherwise never rendered at all — a caller that needs it says so again here.
export function progressAria(value: number): { readonly "aria-valuenow": number } {
  return { "aria-valuenow": value };
}
