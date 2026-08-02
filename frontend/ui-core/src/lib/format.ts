/**
 * How numbers and moments are written, in one place.
 *
 * `DESIGN.md`'s **Numbers** rule, as running code. The point of centralising two
 * one-line functions is not that either is hard — it is that `6431` and `6,431`
 * appearing on the same screen is what happens when each call site decides for
 * itself, and a stat grid is exactly where that shows.
 */

/**
 * A count, with locale-aware thousands separators.
 *
 * Deliberately `undefined` locale, which is "whatever the browser is set to".
 * Hardcoding `en-US` would print `1,248` to somebody whose every other number
 * that day read `1.248`.
 *
 * Pair it with the `tabular-nums` class — the separator is what makes a number
 * readable, and tabular figures are what stop it jittering when it updates.
 */
export function formatCount(value: number): string {
  return value.toLocaleString(undefined);
}

/**
 * A percentage, rounded to whole units.
 *
 * Whole units because a stat card is a glance, not a measurement: `62%` is the
 * answer somebody wants and `61.7431%` is the same answer made unreadable. The
 * unrounded value stays on the wire for anybody who needs it.
 *
 * **Rounds toward zero for anything under 1%**, so a project with three labeled
 * assets out of a thousand reads `0%` rather than `1%` — overstating progress is
 * the one direction this number must not fail in. `Math.round` alone would
 * report 0.5% as 1%.
 */
export function formatPercent(value: number): string {
  const whole = value < 1 ? Math.floor(value) : Math.round(value);
  return `${formatCount(whole)}%`;
}

//: Seven days, in milliseconds. `DESIGN.md`: relative under a week, absolute beyond.
const RELATIVE_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * "2d ago" inside a week, "Jan 14, 2026" beyond it.
 *
 * The split exists because the two answer different questions. Inside a week
 * "how long ago" is what a person is actually asking, and they can hold it in
 * their head; beyond it the relative form stops meaning anything ("47d ago" is
 * arithmetic homework) and the date is what somebody would write down.
 *
 * `now` is a parameter rather than a call to `Date.now()` so this is a pure
 * function — which is what lets it be tested without freezing a clock.
 */
export function formatWhen(iso: string, now: number = Date.now()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const elapsed = now - at.getTime();
  // A timestamp in the future is a clock disagreement, not a negative age. Show
  // the date rather than "-3d ago", which reads as a bug to everybody who sees it.
  if (elapsed < 0 || elapsed >= RELATIVE_LIMIT_MS) {
    return at.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
