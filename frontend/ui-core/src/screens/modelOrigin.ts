/**
 * Where a model's weights come from, as a card reads it: a name and a mark.
 *
 * `origin` on a connection is a stored fact in a closed vocabulary, and this
 * module is the whole of what the page says about one. Keyed by the vocabulary's
 * members and total over them, so an origin added to the kernel fails this build
 * until its copy and its mark exist — the same enforcement `KIND_LABELS` and the
 * capability copy put on their vocabularies.
 *
 * The mark is the one place the page uses colour for a category, and it is an
 * accent edge rather than a badge or a fill on purpose: a grid of cards sorts
 * itself by origin at a glance with nothing added to the card's reading, where
 * one more chip would be one more thing to read and a tinted card would say it
 * again, louder, across the whole surface. The three tokens are VisionSet's own
 * (`DESIGN.md`, *VisionSet Extensions*).
 */

import type { ModelOrigin } from "../data/inferenceQueries";

interface OriginCopy {
  /** The name on the card, in the publisher's own spelling. */
  readonly label: string;
  /** The card's accent edge, as the utility class over the origin's own token. */
  readonly mark: string;
}

/** Every origin, in the order a filter lists them. */
const ORIGIN_COPY: Record<ModelOrigin, OriginCopy> = {
  huggingface: { label: "Hugging Face", mark: "border-l-origin-hub" },
  custom: { label: "Customized", mark: "border-l-origin-custom" },
  robomous: { label: "Robomous", mark: "border-l-origin-robomous" },
};

/** The origin as the card names it. */
export function originLabel(origin: ModelOrigin): string {
  return ORIGIN_COPY[origin].label;
}

/** The card's accent edge for an origin. */
export function originMark(origin: ModelOrigin): string {
  return ORIGIN_COPY[origin].mark;
}

/** How each origin reads in a filter, in the order it offers them. */
export const ORIGIN_OPTION_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ORIGIN_COPY).map(([key, copy]) => [key, copy.label]),
);
