/**
 * "Is this distribution lopsided?" — one pure function, on purpose.
 *
 * The rule is a **v1 placeholder and will be wrong for somebody**: a long-tailed
 * dataset is a legitimate thing to have, and "rare class" is a judgement about a
 * domain rather than about a ratio. So it lives here, alone, taking counts and
 * returning either a note or nothing — replacing it later is one function and not
 * a hunt through JSX.
 *
 * It is a **note, never a warning that blocks anything**. Nothing branches on it.
 */

/** One class's share of the annotations, as the Overview receives it. */
export interface ClassShare {
  readonly label_class: string;
  readonly annotations: number;
}

/**
 * Below this share of all annotations, the smallest class is called out.
 *
 * Ten percent is a round number rather than a derived one, which is the whole
 * reason this constant is named and exported: a test pins the boundary, and
 * moving it is a one-line change with a visible blast radius.
 */
export const IMBALANCE_SHARE = 0.1;

/**
 * At least this many classes before the note is offered at all.
 *
 * With two classes "imbalance" is just the ratio between them, and a 90/10 split
 * across two classes is often exactly what somebody meant to build — a defect
 * detector is mostly not-a-defect. Three is where "one of these is being starved"
 * starts to be the more useful reading.
 */
export const IMBALANCE_MIN_CLASSES = 3;

/**
 * The sentence to show under a distribution, or `null` when there is nothing to say.
 *
 * Returns the *text* rather than a boolean because the number in it — which class
 * and what percentage — is the whole value of the note. A caller handed `true`
 * would have to recompute both to render anything useful.
 *
 * Silent when: fewer than three classes, no annotations at all, or the smallest
 * class is at or above the threshold. **At exactly the threshold it is silent** —
 * a class holding a round tenth of the data is not being starved, and a rule that
 * fires on equality fires on the boundary case somebody deliberately aimed at.
 */
export function imbalanceNote(classes: readonly ClassShare[]): string | null {
  if (classes.length < IMBALANCE_MIN_CLASSES) return null;
  const total = classes.reduce((sum, one) => sum + one.annotations, 0);
  if (total <= 0) return null;

  // `reduce` rather than a sort: this is asked on every render of the Overview,
  // and the caller has already sorted for display in the other direction.
  const smallest = classes.reduce((least, one) =>
    one.annotations < least.annotations ? one : least,
  );
  const share = smallest.annotations / total;
  if (share >= IMBALANCE_SHARE) return null;

  // Rounded for reading, and floored so a class at 0.4% reads "0%" rather than
  // being rounded up into looking better represented than it is — the same
  // direction `formatPercent` refuses to fail in.
  const percent = share < 0.01 ? Math.floor(share * 100) : Math.round(share * 100);
  return `Class imbalance: ${smallest.label_class} is ${percent}% of annotations`;
}
