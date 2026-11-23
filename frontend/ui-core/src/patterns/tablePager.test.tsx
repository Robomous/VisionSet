/**
 * The two pagers, tested for what they say and what they refuse: the labels, a
 * step that cannot go anywhere, the tooltip on one that can, and an inline pager
 * that is not there while everything fits on one page.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, type JSX } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { TooltipProvider } from "@robomous/ui-core";
import { stubResizeObserver } from "../testing/resizeObserver.js";
import { usePagination } from "./pagination";
import { InlinePager, TableFooter } from "./TablePager";

const rows = (count: number): number[] => Array.from({ length: count }, (_, index) => index + 1);

beforeEach(() => stubResizeObserver());

function Footer({ count, unfiltered, size = 25 }: { readonly count: number; readonly unfiltered?: number; readonly size?: number }): JSX.Element {
  const paging = usePagination(rows(count), { pageSize: size });
  const frame = useRef<HTMLDivElement>(null);
  return (
    <TooltipProvider>
      <div ref={frame} data-testid="frame">
        {paging.slice.map((row) => (
          <p key={row} data-testid={`row-${row}`}>
            {row}
          </p>
        ))}
      </div>
      <TableFooter pagination={paging} frameRef={frame} noun="project" {...(unfiltered === undefined ? {} : { unfiltered })} />
    </TooltipProvider>
  );
}

function Inline({ count }: { readonly count: number }): JSX.Element {
  const paging = usePagination(rows(count), { pageSize: 10 });
  return (
    <TooltipProvider>
      <InlinePager pagination={paging} />
      <output data-testid="first">{paging.slice[0]}</output>
    </TooltipProvider>
  );
}

const button = (id: string): HTMLButtonElement => screen.getByTestId(id) as HTMLButtonElement;

describe("TableFooter", () => {
  it("says which rows, of how many, and which page, with four steps", () => {
    render(<Footer count={312} />);
    expect(screen.getByTestId("table-pager-range").textContent).toBe("1–25 of 312 projects");
    expect(screen.getByTestId("table-pager-page").textContent).toBe("Page 1 of 13");
    expect(screen.getByTestId("table-footer").getAttribute("aria-label")).toBe("Pages");
    for (const [id, name] of [
      ["table-pager-first", "First page"],
      ["table-pager-prev", "Previous page"],
      ["table-pager-next", "Next page"],
      ["table-pager-last", "Last page"],
    ] as const) {
      expect(button(id).getAttribute("aria-label")).toBe(name);
    }
  });

  it("names the range in the stronger ink and the count in the quiet one", () => {
    render(<Footer count={312} />);
    const strong = screen.getByTestId("table-pager-range").querySelector(".font-medium");
    expect(strong?.textContent).toBe("1–25");
    expect(screen.getByTestId("table-pager-page").querySelector(".font-medium")?.textContent).toBe("1");
  });

  it("fades the steps that go back on the first page and those that go on at the last", async () => {
    render(<Footer count={60} />);
    expect(button("table-pager-first").getAttribute("aria-disabled")).toBe("true");
    expect(button("table-pager-prev").getAttribute("aria-disabled")).toBe("true");
    expect(button("table-pager-next").hasAttribute("aria-disabled")).toBe(false);
    expect(button("table-pager-last").hasAttribute("aria-disabled")).toBe(false);

    await userEvent.click(button("table-pager-last"));
    expect(screen.getByTestId("table-pager-range").textContent).toBe("51–60 of 60 projects");
    expect(screen.getByTestId("table-pager-page").textContent).toBe("Page 3 of 3");
    expect(button("table-pager-first").hasAttribute("aria-disabled")).toBe(false);
    expect(button("table-pager-prev").hasAttribute("aria-disabled")).toBe(false);
    expect(button("table-pager-next").getAttribute("aria-disabled")).toBe("true");
    expect(button("table-pager-last").getAttribute("aria-disabled")).toBe("true");

    await userEvent.click(button("table-pager-prev"));
    expect(screen.getByTestId("table-pager-page").textContent).toBe("Page 2 of 3");
    await userEvent.click(button("table-pager-first"));
    expect(screen.getByTestId("table-pager-page").textContent).toBe("Page 1 of 3");
    expect(screen.getByTestId("row-1")).not.toBeNull();
  });

  it("names an enabled step in a tooltip", async () => {
    render(<Footer count={60} />);
    await userEvent.hover(button("table-pager-next"));
    expect((await screen.findByRole("tooltip")).textContent).toBe("Next page");
  });

  it("gives a step that cannot go anywhere no tooltip", async () => {
    render(<Footer count={60} />);
    await userEvent.hover(button("table-pager-first"));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("changes the page size from the choices, keeping the first visible row's page", async () => {
    render(<Footer count={312} />);
    expect(screen.getByTestId("table-pager-size").textContent).toBe("25");
    await userEvent.click(button("table-pager-next"));
    await userEvent.click(button("table-pager-next"));
    expect(screen.getByTestId("table-pager-range").textContent).toBe("51–75 of 312 projects");

    await userEvent.click(screen.getByTestId("table-pager-size"));
    const options = within(await screen.findByRole("listbox")).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["10", "25", "50", "100"]);
    await userEvent.click(options[0]!);

    expect(screen.getByTestId("table-pager-size").textContent).toBe("10");
    expect(screen.getByTestId("table-pager-range").textContent).toBe("51–60 of 312 projects");
    expect(screen.getByTestId("table-pager-page").textContent).toBe("Page 6 of 32");
  });

  it("offers a starting size that is not one of the choices", async () => {
    render(<Footer count={312} size={30} />);
    await userEvent.click(screen.getByTestId("table-pager-size"));
    const options = within(await screen.findByRole("listbox")).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["10", "25", "30", "50", "100"]);
  });

  it("says what a filter narrowed it from, only when it did", () => {
    const { rerender } = render(<Footer count={11} unfiltered={60} />);
    expect(screen.getByTestId("table-pager-range").textContent).toBe("1–11 of 11 projects · filtered from 60");
    rerender(<Footer count={11} unfiltered={11} />);
    expect(screen.getByTestId("table-pager-range").textContent).toBe("1–11 of 11 projects");
  });

  it("says one row in the singular and none as nothing matching", () => {
    const { rerender } = render(<Footer count={1} />);
    expect(screen.getByTestId("table-pager-range").textContent).toBe("1 project");
    rerender(<Footer count={0} unfiltered={4} />);
    expect(screen.getByTestId("table-pager-range").textContent).toBe("No projects match");
    expect(screen.getByTestId("table-pager-page").textContent).toBe("Page 1 of 1");
    expect(button("table-pager-next").getAttribute("aria-disabled")).toBe("true");
  });

  it("says a last page of one row by its place", async () => {
    render(<Footer count={51} />);
    await userEvent.click(button("table-pager-last"));
    expect(screen.getByTestId("table-pager-range").textContent).toBe("51 of 51 projects");
  });
});

describe("InlinePager", () => {
  it("says the page and has two small steps, and goes where they say", async () => {
    render(<Inline count={25} />);
    expect(screen.getByTestId("inline-pager")).not.toBeNull();
    expect(screen.getByTestId("table-pager-page").textContent).toBe("Page 1 of 3");
    expect(screen.queryByTestId("table-pager-first")).toBeNull();
    expect(screen.queryByTestId("table-pager-last")).toBeNull();
    expect(screen.queryByTestId("table-pager-size")).toBeNull();
    expect(button("table-pager-prev").getAttribute("aria-disabled")).toBe("true");
    expect(button("table-pager-next").getAttribute("aria-label")).toBe("Next page");

    await userEvent.click(button("table-pager-next"));
    expect(screen.getByTestId("first").textContent).toBe("11");
    await userEvent.click(button("table-pager-next"));
    expect(button("table-pager-next").getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(button("table-pager-prev"));
    expect(screen.getByTestId("table-pager-page").textContent).toBe("Page 2 of 3");
  });

  it("is not there while the rows fit on one page", () => {
    render(<Inline count={10} />);
    expect(screen.queryByTestId("inline-pager")).toBeNull();
    expect(screen.queryByTestId("table-pager-page")).toBeNull();
  });
});
