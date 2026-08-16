/**
 * The data-surface parts, tested for the decisions rather than the class strings.
 *
 * What is asserted here is the handful of things a screen would silently lose:
 * the shared bar scale, the zero-denominator guards, the whole-row click target,
 * the overflow tile that is a control only when it leads somewhere, and the
 * number formatting that keeps a stat grid readable.
 *
 * `primitives.test.tsx` argues the general case: pinning every class would pin
 * the design system to whatever it was on the day, which is a test that fails
 * for reasons nobody chose.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { formatCount, formatPercent, formatWhen } from "../lib/format";
import { ClassListRow, DistributionBar, StatCard, ThumbnailGrid } from "./DataDisplay";

/** The rendered width of a bar's fill, as the percentage string it was given. */
function fillWidth(container: HTMLElement): string {
  const track = container.querySelector("span > span.block");
  return (track as HTMLElement).style.width;
}

describe("formatCount", () => {
  it("separates thousands so a seven-digit count stays readable", () => {
    // Locale-dependent by design, so the assertion is the browser's own answer
    // rather than a hardcoded comma — that is the whole point of not pinning one.
    expect(formatCount(1234567)).toBe((1234567).toLocaleString(undefined));
    expect(formatCount(1234567)).not.toBe("1234567");
  });

  it("leaves a small number alone", () => {
    expect(formatCount(42)).toBe("42");
  });
});

describe("formatPercent", () => {
  it("rounds to whole units, because a stat card is a glance", () => {
    expect(formatPercent(61.7431)).toBe("62%");
  });

  it("never rounds a sliver of progress up to one percent", () => {
    // Three labeled assets in a thousand is 0.3%. Reporting 1% would overstate
    // progress, which is the one direction this number must not fail in.
    expect(formatPercent(0.3)).toBe("0%");
    expect(formatPercent(0.5)).toBe("0%");
  });

  it("reports a finished project as 100", () => {
    expect(formatPercent(100)).toBe("100%");
  });
});

describe("formatWhen", () => {
  const now = Date.parse("2026-08-01T12:00:00Z");

  it("is relative inside a week", () => {
    expect(formatWhen("2026-07-30T12:00:00Z", now)).toBe("2d ago");
    expect(formatWhen("2026-08-01T09:00:00Z", now)).toBe("3h ago");
    expect(formatWhen("2026-08-01T11:30:00Z", now)).toBe("30m ago");
  });

  it("is absolute beyond a week, because 47d ago is arithmetic homework", () => {
    expect(formatWhen("2026-01-14T12:00:00Z", now)).not.toContain("ago");
    expect(formatWhen("2026-01-14T12:00:00Z", now)).toContain("2026");
  });

  it("shows a date rather than a negative age when the clocks disagree", () => {
    expect(formatWhen("2026-08-02T12:00:00Z", now)).not.toContain("-");
  });

  it("answers empty for a value that is not a date, rather than Invalid Date", () => {
    expect(formatWhen("not a date", now)).toBe("");
  });
});

describe("StatCard", () => {
  it("shows its label and value", () => {
    render(<StatCard label="Images" value={formatCount(1248)} />);
    expect(screen.queryByText("Images")).not.toBeNull();
    expect(screen.queryByText((1248).toLocaleString(undefined))).not.toBeNull();
  });

  it("renders no context line when it was given none", () => {
    const { container } = render(<StatCard label="Classes" value="3" />);
    expect(container.querySelectorAll("span")).toHaveLength(2);
  });
});

describe("DistributionBar", () => {
  it("scales the fill against the chart's max, not against its own count", () => {
    // The whole reason `max` is a prop. A row deriving it would draw every bar
    // full width and the chart would say nothing.
    const { container } = render(
      <DistributionBar label="bicycle" count={515} max={4372} color="#ff0000" />,
    );
    expect(fillWidth(container)).toBe(`${(515 / 4372) * 100}%`);
  });

  it("draws a full bar for the largest class", () => {
    const { container } = render(
      <DistributionBar label="dog" count={4372} max={4372} color="#ff0000" />,
    );
    expect(fillWidth(container)).toBe("100%");
  });

  it("renders an empty track rather than dividing by zero", () => {
    const { container } = render(
      <DistributionBar label="dog" count={0} max={0} color="#ff0000" />,
    );
    expect(fillWidth(container)).toBe("0%");
  });

  it("never overflows its track when a count exceeds the max it was given", () => {
    const { container } = render(
      <DistributionBar label="dog" count={99} max={10} color="#ff0000" />,
    );
    expect(fillWidth(container)).toBe("100%");
  });

  it("formats the count", () => {
    render(<DistributionBar label="dog" count={4372} max={4372} color="#ff0000" />);
    expect(screen.queryByText((4372).toLocaleString(undefined))).not.toBeNull();
  });
});

describe("ClassListRow", () => {
  it("is one button spanning the row, so the whole row is the target", () => {
    render(<ClassListRow name="dog" geometry="bbox" count={4372} color="#ff0000" />);
    const row = screen.getByRole("button");
    expect(row.textContent).toContain("dog");
    expect(row.textContent).toContain("bbox");
  });

  it("reports selection to assistive technology, not only to the eye", () => {
    render(<ClassListRow name="dog" geometry="bbox" count={1} color="#ff0000" selected />);
    expect(screen.getByRole("button").getAttribute("aria-current")).toBe("true");
  });

  it("carries no aria-current when it is not selected", () => {
    render(<ClassListRow name="dog" geometry="bbox" count={1} color="#ff0000" />);
    expect(screen.getByRole("button").getAttribute("aria-current")).toBeNull();
  });

  it("is reachable and activatable from the keyboard alone", async () => {
    const chosen = vi.fn();
    render(
      <ClassListRow name="dog" geometry="bbox" count={1} color="#ff0000" onSelect={chosen} />,
    );
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("button"));
    await userEvent.keyboard("{Enter}");
    expect(chosen).toHaveBeenCalledOnce();
  });

  /**
   * #596: which side of a compact row gives way when both cannot fit.
   *
   * jsdom has no layout, so none of this can measure the pixels — the browser
   * half is a `scrollWidth` assertion in `cycle.spec.ts`. What is assertable here
   * is the *structure* the layout rests on, and it is the part a refactor breaks
   * silently: the name shrinks and truncates, the metadata shrinks and truncates,
   * and neither is pinned at its content width.
   */
  it("lets the geometry give way rather than the name", () => {
    render(
      <ClassListRow
        testId="row"
        name="pedestrian crossing marker"
        geometry="box +3"
        color="#ff0000"
        hotkey="5"
      />,
    );
    const geometry = screen.getByText("box +3");
    // `shrink-0` here was the defect: the name is `flex-1`, so its flex basis is
    // zero and it takes only what this leaves.
    expect(geometry.className).not.toContain("shrink-0");
    expect(geometry.className).toContain("truncate");
    expect(screen.getByTestId("row-name").className).toContain("truncate");
  });

  it("puts the full name in a title, so truncation is recoverable", () => {
    render(
      <ClassListRow testId="row" name="pedestrian crossing marker" geometry="box" color="#f00" />,
    );
    expect(screen.getByTestId("row-name").getAttribute("title")).toBe(
      "pedestrian crossing marker",
    );
  });

  it("keeps the hotkey badge on a row that is picking a shape", () => {
    // Every row picks, so dropping the badge here would take the digit off the
    // whole list. The chips wrap instead, which costs the name nothing.
    const shapes = [
      { value: "bbox", label: "box", active: true, onPick: vi.fn() },
      { value: "polygon", label: "polygon", active: false, onPick: vi.fn() },
    ];
    const { rerender } = render(
      <ClassListRow testId="row" name="car" geometry="box · polygon" color="#f00" hotkey="1" />,
    );
    expect(screen.getByText("1")).toBeDefined();

    rerender(
      <ClassListRow
        testId="row"
        name="car"
        geometry="box · polygon"
        color="#f00"
        hotkey="1"
        selected
        shapes={shapes}
      />,
    );
    expect(screen.getByText("1")).toBeDefined();
    expect(screen.getByTestId("row-shape-bbox")).toBeDefined();
    expect(screen.getByTestId("row-shape-polygon")).toBeDefined();
  });

  /**
   * The wrap, as far as jsdom can see it.
   *
   * There is no layout here, so this asserts the *mechanism* rather than the
   * result: the chips share a wrapping container with the name, and the name has
   * a flex floor to push against. The pixels — a long name taking the first line
   * to itself, the chips landing under it — are a browser claim and are measured
   * in `cycle.spec.ts`.
   *
   * Every way of getting it wrong is silent. Without `flex-wrap` the chips never
   * move; with `flex-1` the name's base is zero so it shrinks away and they never
   * need to; with a fixed `basis-*` every row wraps whether it had to or not.
   */
  it("lets the name's own width decide, inside a wrapping block", () => {
    render(
      <ClassListRow
        testId="row"
        name="pedestrian crossing marker"
        geometry="box · polygon"
        color="#f00"
        shapes={[{ value: "bbox", label: "box", active: true, onPick: vi.fn() }]}
      />,
    );
    const name = screen.getByTestId("row-name");
    expect(name.className).toContain("grow");
    // Neither of the two ways to stop the base tracking the text.
    expect(name.className).not.toContain("flex-1");
    expect(name.className).not.toMatch(/\bbasis-/);
    const block = name.parentElement;
    expect(block?.className).toContain("flex-wrap");
    // What keeps a wrapped line in the same right-hand column as every other row.
    expect(block?.className).toContain("justify-end");
    // The chips live in the same wrapping block, or they could not wrap out of it.
    expect(block?.contains(screen.getByTestId("row-shape-bbox"))).toBe(true);
  });

  it("refuses to pick when the row is refused, however many shapes it is handed", () => {
    // The group variant has no `disabled` to carry, so a refused row falls through
    // to the button that does: explained *and* inert.
    render(
      <ClassListRow
        testId="row"
        name="car"
        geometry="box"
        color="#f00"
        refusal="needs a polygon"
        shapes={[{ value: "bbox", label: "box", active: false, onPick: vi.fn() }]}
      />,
    );
    expect(screen.queryByTestId("row-shape-bbox")).toBeNull();
    const row = screen.getByTestId("row");
    expect(row.tagName).toBe("BUTTON");
    expect((row as HTMLButtonElement).disabled).toBe(true);
    expect(row.getAttribute("title")).toBe("needs a polygon");
  });
});

describe("ThumbnailGrid", () => {
  const tiles = [<span key="a">a</span>, <span key="b">b</span>];

  it("renders every tile it was handed", () => {
    render(<ThumbnailGrid tiles={tiles} />);
    expect(screen.queryByText("a")).not.toBeNull();
    expect(screen.queryByText("b")).not.toBeNull();
  });

  it("renders no overflow tile when nothing is hidden", () => {
    render(<ThumbnailGrid tiles={tiles} />);
    expect(screen.queryByTestId("thumbnail-overflow")).toBeNull();
  });

  it("counts the overflow and formats it", () => {
    render(<ThumbnailGrid tiles={tiles} overflow={1243} />);
    expect(screen.getByTestId("thumbnail-overflow").textContent).toBe(
      `+${(1243).toLocaleString(undefined)}`,
    );
  });

  it("is a control only when it leads somewhere", async () => {
    // `DESIGN.md`'s never-disable rule: a tile that cannot navigate is text, not
    // a dead button.
    const { rerender } = render(<ThumbnailGrid tiles={tiles} overflow={5} />);
    expect(screen.getByTestId("thumbnail-overflow").tagName).toBe("DIV");

    const browse = vi.fn();
    rerender(<ThumbnailGrid tiles={tiles} overflow={5} onOverflow={browse} />);
    const control = screen.getByTestId("thumbnail-overflow");
    expect(control.tagName).toBe("BUTTON");
    await userEvent.click(control);
    expect(browse).toHaveBeenCalledOnce();
  });

  it("ignores a negative overflow rather than rendering a minus tile", () => {
    render(<ThumbnailGrid tiles={tiles} overflow={-3} />);
    expect(screen.queryByTestId("thumbnail-overflow")).toBeNull();
  });
});
