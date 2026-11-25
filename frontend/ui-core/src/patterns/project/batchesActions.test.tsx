/**
 * The batches band's ways forward, as a component: Add images is a ghost word
 * with its icon, Annotate the one filled control and only while a batch is open
 * for annotation; Annotate goes straight to the newest batch with work left —
 * into its one job when it has exactly one — and with several open a chevron
 * asks which.
 */

import { render as plainRender, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@robomous/ui-core";

import { stubResizeObserver } from "../../testing/resizeObserver.js";
import type { AnnotateTarget } from "../projectSections";
import { BatchesActions, type BatchesActionsProps } from "./BatchesActions";

function render(props: BatchesActionsProps): ReturnType<typeof plainRender> {
  return plainRender(<BatchesActions {...props} />, { wrapper: TooltipProvider });
}

const ONE: readonly AnnotateTarget[] = [{ id: "b1", name: "drive-01", remaining: 12, schemaVersion: 4, jobIds: ["j1"] }];

/** Nova's filled `Button` carries `data-variant="default"`. */
function filled(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('button[data-variant="default"]'));
}

// The dropdown measures its trigger.
beforeEach(() => stubResizeObserver());

describe("BatchesActions", () => {
  it("draws Add images as a ghost icon button before the filled Annotate, which names itself in text", () => {
    render({ onIngest: vi.fn(), annotate: { targets: ONE, onOpen: vi.fn() } });
    const ingest = screen.getByTestId("go-ingest");
    const annotate = screen.getByTestId("go-annotate");
    expect(ingest.dataset.variant).toBe("ghost");
    // An icon, named by its tooltip.
    expect(ingest.textContent).toBe("");
    expect(ingest.getAttribute("aria-label")).toBe("Add images");
    expect(annotate.textContent).toBe("Annotate");
    expect(ingest.compareDocumentPosition(annotate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(filled()).toEqual([annotate]);
  });

  it("draws no Annotate while nothing is open for annotation — absent, never disabled", () => {
    render({ onIngest: vi.fn(), annotate: { targets: [], onOpen: vi.fn() } });
    expect(screen.queryByTestId("go-annotate")).toBeNull();
    expect(filled()).toHaveLength(0);
    expect(screen.getByTestId("go-ingest")).toBeTruthy();
  });

  it("renders nothing at all when the host wired neither", () => {
    const { container } = render({});
    expect(container.textContent).toBe("");
  });

  it("splits Annotate when more than one batch is open: it jumps to the newest, and a chevron asks which", async () => {
    const onOpen = vi.fn();
    render({
      annotate: {
        targets: [
          { id: "b2", name: "drive-02", remaining: 3, schemaVersion: 4 },
          { id: "b1", name: "drive-01", remaining: 12, schemaVersion: 3 },
        ],
        onOpen,
      },
    });
    const trigger = screen.getByTestId("go-annotate-menu");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-label")).toBe("Choose a batch to annotate");
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByTestId("annotate-batch-drive-01"));
    expect(onOpen).toHaveBeenCalledWith("b1");

    // The main half does not ask: it goes straight to the first target, the newest.
    onOpen.mockClear();
    await userEvent.click(screen.getByTestId("go-annotate"));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("b2");
  });

  it("skips a batch with nothing left for the next one that has work", async () => {
    const onOpen = vi.fn();
    render({
      annotate: {
        targets: [
          { id: "b2", name: "drive-02", remaining: 0, schemaVersion: 4 },
          { id: "b1", name: "drive-01", remaining: 12, schemaVersion: 3 },
        ],
        onOpen,
      },
    });
    await userEvent.click(screen.getByTestId("go-annotate"));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("b1");
  });

  it("jumps into the annotator when the one open batch has one job", async () => {
    const onOpen = vi.fn();
    const onOpenJob = vi.fn();
    render({ annotate: { targets: ONE, onOpen, onOpenJob } });
    await userEvent.click(screen.getByTestId("go-annotate"));
    expect(onOpenJob).toHaveBeenCalledWith("j1");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("lands on the batch's panel to pick a job when the batch has several, or while they are unknown", async () => {
    for (const jobIds of [["j1", "j2"], undefined]) {
      const onOpen = vi.fn();
      const onOpenJob = vi.fn();
      const { unmount } = render({
        annotate: { targets: [{ id: "b1", name: "drive-01", remaining: 12, schemaVersion: 4, jobIds }], onOpen, onOpenJob },
      });
      await userEvent.click(screen.getByTestId("go-annotate"));
      expect(onOpen).toHaveBeenCalledWith("b1");
      expect(onOpenJob).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("applies the job rule to the batch picked from the dropdown", async () => {
    const onOpen = vi.fn();
    const onOpenJob = vi.fn();
    render({
      annotate: {
        targets: [
          { id: "b2", name: "drive-02", remaining: 3, schemaVersion: 4, jobIds: ["j2"] },
          { id: "b1", name: "drive-01", remaining: 12, schemaVersion: 3, jobIds: ["j1a", "j1b"] },
        ],
        onOpen,
        onOpenJob,
      },
    });
    await userEvent.click(screen.getByTestId("go-annotate-menu"));
    await userEvent.click(await screen.findByTestId("annotate-batch-drive-02"));
    expect(onOpenJob).toHaveBeenCalledWith("j2");
    await userEvent.click(screen.getByTestId("go-annotate-menu"));
    await userEvent.click(await screen.findByTestId("annotate-batch-drive-01"));
    expect(onOpen).toHaveBeenCalledWith("b1");
  });
});
