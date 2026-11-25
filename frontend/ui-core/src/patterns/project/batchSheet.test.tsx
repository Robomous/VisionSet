/**
 * The batch's panel, on fixture rows, without a screen or a server around it.
 *
 * What it promises: the state is one of the properties rather than a badge
 * beside the name; what is read less often waits behind "N more properties",
 * always the same four, "Empty" until they have a value, and folded it cannot
 * be tabbed into; every action sits in the top bar, and the panel opens on the
 * forward one; J/K still walk the batches from anywhere in the panel; and each
 * job is a row that is its own way into the editor, walked with ↑/↓.
 */

import { TooltipProvider } from "@robomous/ui-core";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { Toaster, toast } from "sonner";
import { describe, expect, it, vi } from "vitest";

import { BatchSheet, type BatchSheetProps, type SheetJob } from "./BatchSheet";
import { SheetLine } from "./SheetLine";
import { InSheet, spokenLines } from "./sheetLines";
import type { BatchRowView } from "./BatchTable";

const ROW: BatchRowView = {
  id: "b1",
  name: "autopista cámara 1",
  phase: "annotating",
  schemaVersion: 3,
  done: 18,
  total: 48,
  prelabel: null,
  assignees: ["ana", null],
};

const JOBS: readonly SheetJob[] = [
  { id: "j1", label: "Job 1", assignee: "ana", images: 24, done: 12, state: "In progress", finished: false },
  { id: "j2", label: "Job 2", assignee: null, images: 24, done: 6, state: "In progress", finished: false },
];

function renderSheet(over: Partial<BatchSheetProps> = {}): { onStep: ReturnType<typeof vi.fn> } {
  const onStep = vi.fn();
  // The state chip's card is a tooltip; the app mounts its provider at the root.
  render(
    <TooltipProvider>
      <BatchSheet
        row={ROW}
        position={{ at: 0, count: 3 }}
        onStep={onStep}
        onClose={vi.fn()}
        jobs={JOBS}
        noJobs="No jobs yet."
        details={{ review: { accepted: 10, waiting: 5, skipped: 3 }, correction: false, promoted: 0 }}
        {...over}
      />
    </TooltipProvider>,
  );
  return { onStep };
}

describe("the batch's panel", () => {
  it("titles the page with the batch and lists its state among the properties", () => {
    renderSheet();

    expect(screen.getByRole("heading", { level: 2, name: "autopista cámara 1" })).toBeTruthy();
    const facts = within(screen.getByTestId("batch-sheet-facts"));
    expect(screen.getAllByTestId("batch-phase")).toHaveLength(1);
    expect(facts.getByText("State")).toBeTruthy();
    expect(facts.getByTestId("batch-phase").textContent).toBe("Labeling");
    expect(screen.getByTestId("batch-sheet-facts").textContent).toContain("18 of 48 · 38%");
    expect(facts.getByText("ana")).toBeTruthy();
  });

  it("offers the bar's forward step beside the state, by the bar's own name, and pressing it presses the bar's control", async () => {
    const approve = vi.fn();
    renderSheet({
      row: { ...ROW, phase: "draft", done: null },
      actions: (
        <button type="button" aria-label="Approve" data-autofocus="" onClick={approve}>
          ✓
        </button>
      ),
    });
    const next = await screen.findByTestId("batch-sheet-next");
    expect(next.textContent).toBe("Approve");
    // Beside the chip, in the State property.
    expect(screen.getByTestId("batch-sheet-facts").contains(next)).toBe(true);
    await userEvent.click(next);
    expect(approve).toHaveBeenCalledOnce();
  });

  it("offers nothing beside the state while the bar withholds its forward step", async () => {
    renderSheet({
      actions: (
        <button type="button" aria-label="Complete batch" aria-disabled="true" data-autofocus="">
          ✓
        </button>
      ),
    });
    await screen.findByTestId("batch-phase");
    expect(screen.queryByTestId("batch-sheet-next")).toBeNull();
  });

  it("offers the way to the dataset beside the state once the batch is in it", async () => {
    const onOpenDataset = vi.fn();
    renderSheet({ row: { ...ROW, phase: "in_dataset", done: 48 }, onOpenDataset });
    const next = await screen.findByTestId("batch-sheet-next");
    expect(next.textContent).toBe("Open the dataset");
    await userEvent.click(next);
    expect(onOpenDataset).toHaveBeenCalledOnce();
  });

  it("says Labeled as the table does — x of y · z% and its ring — and it does not unfold", () => {
    renderSheet();
    const facts = screen.getByTestId("batch-sheet-facts");
    expect(facts.textContent).toContain("18 of 48 · 38%");
    const labeled = within(facts).getByText("Labeled").closest("div");
    expect(labeled?.querySelector("button, [aria-expanded]")).toBeNull();
  });

  it("says Not started for a batch with no jobs, with nothing to unfold", () => {
    renderSheet({ row: { ...ROW, done: null } });
    const facts = screen.getByTestId("batch-sheet-facts");
    expect(facts.textContent).toContain("Not started");
    const labeled = within(facts).getByText("Labeled").closest("div");
    expect(labeled?.querySelector("button, [aria-expanded]")).toBeNull();
  });

  it("puts every action in the top bar, and opens on the forward one", () => {
    renderSheet({
      tools: <button type="button">Auto-label</button>,
      actions: (
        <>
          <button type="button">Delete batch</button>
          <span aria-hidden="true" className="flex-1" />
          <button type="button" data-autofocus="">
            Annotate
          </button>
        </>
      ),
    });

    const bar = screen.getByTestId("batch-sheet-actions");
    expect(bar.closest("header")).not.toBeNull();
    expect(within(bar).getByText("Auto-label")).toBeTruthy();
    expect(within(bar).getByText("Annotate")).toBeTruthy();
    expect(document.querySelector("footer")).toBeNull();
    expect(document.activeElement?.textContent).toBe("Annotate");
  });

  it("moves to the forward step when it arrives after the panel, until the person acts", () => {
    const props: BatchSheetProps = { row: ROW, position: { at: 0, count: 3 }, onStep: vi.fn(), onClose: vi.fn(), jobs: JOBS, noJobs: "No jobs yet." };
    const bar = (annotate: boolean) => (
      <>
        <button type="button">Delete batch</button>
        <span aria-hidden="true" className="flex-1" />
        {annotate && (
          <button type="button" data-autofocus="">
            Annotate
          </button>
        )}
      </>
    );
    const { rerender } = render(
      <TooltipProvider>
        <BatchSheet {...props} actions={bar(false)} />
      </TooltipProvider>,
    );
    // Opened from an address, the jobs are still being read: the last live action stands in.
    expect(document.activeElement?.textContent).toBe("Delete batch");

    rerender(
      <TooltipProvider>
        <BatchSheet {...props} actions={bar(true)} />
      </TooltipProvider>,
    );
    return waitFor(() => expect(document.activeElement?.textContent).toBe("Annotate"));
  });

  it("hands the focus to the other arrow when stepping reaches an end", async () => {
    const props: BatchSheetProps = { row: ROW, position: { at: 1, count: 3 }, onStep: vi.fn(), onClose: vi.fn(), jobs: JOBS, noJobs: "No jobs yet." };
    const { rerender } = render(
      <TooltipProvider>
        <BatchSheet {...props} />
      </TooltipProvider>,
    );
    screen.getByRole("button", { name: "Next batch (J)" }).focus();

    rerender(
      <TooltipProvider>
        <BatchSheet {...props} position={{ at: 2, count: 3 }} />
      </TooltipProvider>,
    );
    expect((screen.getByRole("button", { name: "Next batch (J)" }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Previous batch (K)"));
  });

  it("has no footer: an outcome or a refusal is a toast, with its words and its way on", async () => {
    render(
      <TooltipProvider>
        <BatchSheet
          row={ROW}
          position={{ at: 0, count: 3 }}
          onStep={vi.fn()}
          onClose={vi.fn()}
          jobs={JOBS}
          noJobs="No jobs yet."
          actions={
            <>
              <SheetLine tone="success" data-testid="done-line" about={{ id: "b1", name: ROW.name }} action={<a href="#dataset">Open the dataset</a>}>
                Completed.
              </SheetLine>
              <SheetLine tone="error" data-testid="refused-line" about={{ id: "b1", name: ROW.name }}>
                This batch can’t be completed yet.
              </SheetLine>
            </>
          }
        />
        <Toaster />
      </TooltipProvider>,
    );

    const done = await screen.findByTestId("done-line");
    const refused = await screen.findByTestId("refused-line");
    // Not in the panel: in the toasts.
    expect(screen.getByTestId("batch-sheet-actions").contains(done)).toBe(false);
    expect(document.querySelector("[data-line]")).toBeNull();
    expect(done.closest("[data-sonner-toast]")?.getAttribute("data-type")).toBe("success");
    expect(refused.closest("[data-sonner-toast]")?.getAttribute("data-type")).toBe("error");
    expect(done.closest("[data-sonner-toast]")?.textContent).toContain("Open the dataset");
    // Named, because the panel may be on another batch by the time it is read.
    expect(done.closest("[data-sonner-toast]")?.textContent).toContain(ROW.name);
    expect(refused.closest("[data-sonner-toast]")?.textContent).toContain(ROW.name);
  });

  it("keys a toast by the batch's id, so two batches of one name each raise their own", async () => {
    render(
      <InSheet.Provider value>
        <SheetLine tone="error" data-testid="refused-line" about={{ id: "b1", name: "drive" }}>
          First.
        </SheetLine>
        <SheetLine tone="error" data-testid="refused-line" about={{ id: "b2", name: "drive" }}>
          Second.
        </SheetLine>
        <Toaster />
      </InSheet.Provider>,
    );

    await waitFor(() => expect(screen.getAllByTestId("refused-line").map((line) => line.textContent)).toEqual(expect.arrayContaining(["First.", "Second."])));
  });

  it("forgets a toast's words once it has gone", async () => {
    render(
      <InSheet.Provider value>
        <SheetLine tone="success" data-testid="done-line" about={{ id: "b1", name: "drive" }}>
          Completed.
        </SheetLine>
        <Toaster />
      </InSheet.Provider>,
    );

    await screen.findByTestId("done-line");
    expect(spokenLines.get("done-line@b1")).toBeDefined();
    act(() => {
      toast.dismiss("done-line@b1");
    });
    await waitFor(() => expect(spokenLines.get("done-line@b1")).toBeUndefined());
  });

  it("lets an earlier toast's end leave a newer one of the same id speaking", () => {
    const endFirst = spokenLines.raise("race-line@b1", { words: "First.", way: undefined });
    const endSecond = spokenLines.raise("race-line@b1", { words: "Second.", way: undefined });
    endFirst();
    expect(spokenLines.get("race-line@b1")?.words).toBe("Second.");
    endSecond();
    expect(spokenLines.get("race-line@b1")).toBeUndefined();
  });

  it("keeps a line in place, as a row, outside a panel", () => {
    render(<SheetLine tone="error" data-testid="refused-line">This batch can’t be completed yet.</SheetLine>);
    expect(screen.getByTestId("refused-line").closest("[data-line]")?.getAttribute("role")).toBe("alert");
  });

  it("says Empty where a property has no value yet", async () => {
    renderSheet({ row: { ...ROW, phase: "draft", schemaVersion: null, done: null }, jobs: [], details: { review: null, correction: false, promoted: 0 } });

    const facts = within(screen.getByTestId("batch-sheet-facts"));
    expect(facts.getByText("Not started")).toBeTruthy();
    await userEvent.click(screen.getByTestId("batch-sheet-more-toggle"));
    const more = screen.getByTestId("batch-sheet-more");
    expect(within(more).getAllByText("Empty")).toHaveLength(3);
  });

  it("keeps the properties read less often behind a fold that cannot be tabbed into until it opens", async () => {
    renderSheet();

    const toggle = screen.getByTestId("batch-sheet-more-toggle");
    expect(toggle.textContent).toBe("4 more properties");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const more = screen.getByTestId("batch-sheet-more");
    expect(more.hasAttribute("inert")).toBe(true);
    expect(more.textContent).toContain("Version 3");
    expect(more.textContent).toContain("10 accepted · 5 waiting · 3 skipped");

    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("Hide 4 properties");
    expect(more.hasAttribute("inert")).toBe(false);
  });

  it("says a correction batch is one, and how many of its images are in the dataset", () => {
    renderSheet({ details: { review: null, correction: true, promoted: 12 } });

    const more = screen.getByTestId("batch-sheet-more");
    expect(more.textContent).toContain("Correction of an earlier batch");
    expect(more.textContent).toContain("12 images");
    expect(more.textContent).not.toContain("accepted");
  });

  it("steps the batches with J and K from inside the panel", async () => {
    const { onStep } = renderSheet();

    await userEvent.click(screen.getByTestId("batch-sheet-more-toggle"));
    await userEvent.keyboard("j");
    await userEvent.keyboard("k");
    expect(onStep.mock.calls).toEqual([[1], [-1]]);
  });

  it("lists each job as one row that opens it, saying its state, who holds it and how far it has come", async () => {
    const open = vi.fn();
    const done = vi.fn();
    renderSheet({
      jobs: [
        { ...JOBS[0]!, onOpen: open },
        { id: "j3", label: "Job 3", assignee: null, images: 24, done: 24, state: "Done", finished: true, onOpen: done },
      ],
    });

    const first = screen.getByTestId("batch-sheet-job-Job 1");
    expect(first.textContent).toContain("In progress");
    expect(first.textContent).toContain("ana");
    expect(first.textContent).toContain("12 of 24 · 50%");
    // A finished job is read, not continued: the row says View and its name says done.
    expect(screen.getByTestId("batch-sheet-job-Job 3").textContent).toContain("Unassigned");
    await userEvent.click(screen.getByRole("button", { name: "View Job 3 in the editor, done" }));
    expect(done).toHaveBeenCalledOnce();

    // ↑/↓ walk the rows' buttons, and stop at the ends.
    const row = screen.getByRole("button", { name: "Open Job 1 in the editor" });
    row.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("View Job 3 in the editor, done");
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("View Job 3 in the editor, done");
    await userEvent.keyboard("{ArrowUp}{Enter}");
    expect(open).toHaveBeenCalledOnce();
  });

  it("says a job's state in words where there is no editor to open it in", () => {
    renderSheet();

    const row = screen.getByTestId("batch-sheet-job-Job 2");
    expect(within(row).queryByRole("button")).toBeNull();
    expect(row.textContent).toContain("Unassigned");
    expect(row.textContent).toContain("In progress");
  });
});
