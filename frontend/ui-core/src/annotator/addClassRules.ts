/**
 * The rules of adding a class from the job: what the version says about itself,
 * the order of the calls that publish it, and how the next version's contract is
 * composed. Plain functions with no rendering in them, kept apart from the
 * dialog's component so the component file exports components only — and so the
 * order is testable without a canvas.
 */

import type { LabelClassBody } from "../screens/queries";

/**
 * The auto-filled version description.
 *
 * Pre-written rather than left empty because a version published from here is the
 * one somebody is *least* likely to describe — they are mid-annotation and think
 * of this as adding a label, not as publishing a contract. Editable, so it is a
 * default and not a decision made for them.
 *
 * It takes the whole session rather than one name, because a session publishes
 * one version and a version has one description: naming only the last class would
 * make the ledger's `Why` column a lie about the other two. Every name is listed
 * rather than counted — a history reader wants to know *which* classes arrived,
 * and a session is realistically two to five.
 *
 * `JSON.stringify` per name, so a class called `zebra "x"` — legal, since
 * `normalize_name` only refuses a blank — cannot produce a sentence that reads as
 * truncated.
 */
export function defaultNote(names: readonly string[]): string {
  const quoted = names.map((name) => JSON.stringify(name));
  // Singular for none as well as for one: the empty case is the placeholder the
  // note field shows before a name is typed, and "Added classes …" over an empty
  // form promises a session nobody has started.
  const noun = quoted.length > 1 ? "classes" : "class";
  // "a, b and c" — no serial comma, which is what `DESIGN.md`'s copy rules use
  // everywhere else. An empty session is the placeholder case: the dialog shows
  // this before a name has been typed.
  const listed =
    quoted.length === 0
      ? '"…"'
      : quoted.length === 1
        ? quoted[0]
        : `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
  return `Added ${noun} ${listed} from the annotation view`;
}

/**
 * The three calls, in the one order that does not lose work.
 *
 * A function rather than a body inside a `useCallback` because **the order is the
 * behaviour**, and behaviour that matters is worth being able to test without a
 * canvas. `AnnotationPage` supplies three thunks and this decides when each runs;
 * `addClass.test.ts` supplies three recorders and asserts what came first.
 *
 * Sequential `await` rather than `Promise.all` or chained `onSuccess`: each step
 * must *not* run if the one before it refused, and a rejection has to reach the
 * caller as one failure rather than three that could each be showing.
 */
export async function runAddClass(steps: {
  /** Save the pending annotations. First, always — see `AddClassDialog`'s module docstring. */
  readonly save: () => Promise<unknown>;
  /** Publish the next version. Given the whole class list, composed by the caller. */
  readonly publish: (classes: readonly LabelClassBody[], note: string) => Promise<unknown>;
  /** The **active** version's classes. Never the batch's pin — versions are linear. */
  readonly activeClasses: readonly LabelClassBody[];
  /**
   * The session's classes, in the order they were written — one press, one version.
   *
   * A list rather than a single class. The chain does not change shape
   * for it: `create_version` takes the whole contract either way, so publishing
   * three new classes is the same one request as publishing one, and the *saving*
   * is the two extra publishes and two refetches that do not happen.
   */
  readonly added: readonly LabelClassBody[];
  readonly note: string;
}): Promise<void> {
  await steps.save();
  await steps.publish(composeVersion(steps.activeClasses, steps.added), steps.note);
}

/** Case-insensitively, because that is how `create_version` compares class names. */
export function sameName(one: string, other: string): boolean {
  return one.toLowerCase() === other.toLowerCase();
}

/**
 * The whole contract the next version declares: the active classes, with this
 * sitting's written **into** them.
 *
 * A name already in the active version **replaces its entry in place** rather
 * than being appended, and both halves of that matter. Appending would publish
 * two classes with one name, which `create_version` refuses outright — so the
 * rescue flow (widening an existing class rather than making a second one)
 * would fail at the API with a 422 that named nothing the user did. And
 * replacing *in place* rather than at the end keeps the authored class order,
 * which is not cosmetic: the class list renders in it and the digit hotkeys are
 * positions in it, so appending would silently renumber somebody's keyboard.
 *
 * Exported for its own test: it is the one piece of this chain that composes
 * rather than sequences, and the order it preserves is invisible from outside.
 */
export function composeVersion(
  activeClasses: readonly LabelClassBody[],
  added: readonly LabelClassBody[],
): readonly LabelClassBody[] {
  const updated = activeClasses.map(
    (existing) => added.find((one) => sameName(one.name, existing.name)) ?? existing,
  );
  const fresh = added.filter(
    (one) => !activeClasses.some((existing) => sameName(existing.name, one.name)),
  );
  return [...updated, ...fresh];
}
