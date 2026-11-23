import { ASSET_ACTION, type AssetAction } from "../data/capabilities";

/**
 * The frame-level *review* actions, in the order they take their slot.
 *
 * Module scope and exported so a test can sweep it against the wire's own
 * declarations rather than against a copy. Each row names an action the wire
 * declares — this is a *presentation* order over `allowed_actions`, never a
 * second opinion about legality.
 *
 * They are an **outline** control rather than the bar's filled primary:
 * the filled slot belongs to the flow verb, because the thing a person does
 * on nine frames out of ten is finish this one and go to the next, and submitting
 * for review is the tenth. The list itself is unchanged — what moved is which
 * variant it wears and what sits to its right.
 */
export const REVIEW_ACTIONS: readonly {
  readonly action: AssetAction;
  readonly label: string;
  readonly testId: string;
  readonly progress: "annotated" | "review_pending" | "accepted";
  /** What the move means, for a product with no annotator identity. */
  readonly tooltip: string;
}[] = [
  {
    action: ASSET_ACTION.confirm,
    label: "Confirm labels",
    testId: "confirm",
    progress: "annotated",
    tooltip: "Keeps the model's labels as this frame's own — nothing else changes",
  },
  {
    action: ASSET_ACTION.submitForReview,
    label: "Submit for review",
    testId: "submit-for-review",
    progress: "review_pending",
    tooltip:
      "Marks this frame for a review pass — anyone opening the job can accept or return it",
  },
  {
    action: ASSET_ACTION.accept,
    label: "Accept",
    testId: "accept",
    progress: "accepted",
    tooltip: "Takes this frame as final — accepted work is corrected in a new batch, not here",
  },
];
