/**
 * What a progress indicator says when pointed at or focused, and the
 * arithmetic under it.
 *
 * The promises: the split is the wire's own and adds up to the total; the card
 * and the readout round the same way and never say 100% while anything is
 * left; focus opens the card at once (what the pointer learns, the keyboard
 * learns too); and an indicator with nothing more to say stays a plain readout.
 */

import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { labelSegments, percentDone } from "./progressDetail";
import { ProgressReadout } from "./ProgressRing";

const COUNTS = { total: 24, accepted: 0, annotated: 8, review_pending: 0, skipped: 2, pre_labeled: 3, unannotated: 11 };

describe("a progress indicator's detail", () => {
  it("splits the total by the wire's states, done first, leaving empty states out", () => {
    const parts = labelSegments(COUNTS);
    expect(parts.map((one) => one.key)).toEqual(["annotated", "skipped", "pre_labeled", "left"]);
    expect(parts.reduce((sum, one) => sum + one.count, 0)).toBe(24);
    expect(parts.filter((one) => one.done).reduce((sum, one) => sum + one.count, 0)).toBe(10);
  });

  it("rounds as the readout does, and never says 100% while anything is left", () => {
    expect(percentDone(10, 24, false)).toBe(42);
    expect(percentDone(239, 240, false)).toBe(99);
    expect(percentDone(24, 24, true)).toBe(100);
  });
});

describe("the progress card", () => {
  it("opens on focus with how far, the parts and whose it is", async () => {
    render(
      <ProgressReadout value={10} total={24} detail={{ title: "Labeled", caption: "autopista cámara 1", segments: labelSegments(COUNTS) }}>
        10/24
      </ProgressReadout>,
    );

    await userEvent.tab();
    const card = await screen.findByTestId("progress-card");
    expect(card.textContent).toContain("Labeled");
    expect(card.textContent).toContain("10 of 24 · 42%");
    const parts = within(card).getByTestId("progress-card-parts");
    expect(parts.textContent).toContain("8annotated");
    expect(parts.textContent).toContain("11not started");
    expect(card.textContent).toContain("autopista cámara 1");
  });

  it("leaves an indicator with nothing more to say as a plain readout, out of the Tab order", async () => {
    render(
      <ProgressReadout value={3} total={6}>
        3/6
      </ProgressReadout>,
    );

    expect(document.querySelector("[data-progress-trigger]")).toBeNull();
    await userEvent.tab();
    expect(screen.queryByTestId("progress-card")).toBeNull();
  });
});
