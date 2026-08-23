/**
 * Where a model's weights come from, as a card reads it: a name and a mark.
 *
 * `origin` on a connection is a stored fact, open on the wire, and this module is
 * the whole of what the page says about one. Keyed by the vocabulary's *known*
 * members, so an origin added to the kernel fails this build until its copy and
 * its mark exist; a value this build never compiled against renders as its raw
 * value on an unmarked card — shown, never dropped, and never guessed a colour
 * for.
 *
 * The mark is the one place the page uses colour for a category, and it is an
 * accent edge rather than a badge or a fill on purpose: a grid of cards sorts
 * itself by origin at a glance with nothing added to the card's reading, where
 * one more chip would be one more thing to read and a tinted card would say it
 * again, louder, across the whole surface. The three tokens are VisionSet's own
 * (`DESIGN.md`, *VisionSet Extensions*).
 */

import type { KnownMembers } from "../generated/api.js";

interface OriginCopy {
  /** The name on the card, in the publisher's own spelling. */
  readonly label: string;
  /** The card's accent edge, as the utility class over the origin's own token. */
  readonly mark: string;
}

/** Every origin this build can name, in the order a filter lists them. */
const ORIGIN_COPY: Record<KnownMembers["ModelOrigin"], OriginCopy> = {
  huggingface: { label: "Hugging Face", mark: "border-l-origin-hub" },
  custom: { label: "Customized", mark: "border-l-origin-custom" },
  robomous: { label: "Robomous", mark: "border-l-origin-robomous" },
};

function known(origin: string): OriginCopy | undefined {
  return Object.hasOwn(ORIGIN_COPY, origin)
    ? ORIGIN_COPY[origin as KnownMembers["ModelOrigin"]]
    : undefined;
}

/** The origin as the card names it: this build's copy, or the value itself. */
export function originLabel(origin: string): string {
  return known(origin)?.label ?? origin;
}

/** The card's accent edge for an origin, or none — an unmarked card — for one this build cannot name. */
export function originMark(origin: string): string | undefined {
  return known(origin)?.mark;
}

/** How each origin this build names reads in a filter, in the order it offers them. */
export const ORIGIN_OPTION_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ORIGIN_COPY).map(([key, copy]) => [key, copy.label]),
);
