/**
 * The schema's version history — the History sheet and a past version shown
 * read-only — driven against a stubbed `fetch` (`testing/screensHarness.tsx`).
 */

import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
// `VisionSetDataProvider` and `QueryClient` stay direct imports: three tests
// below build their own local `wrap` that a `rerender` reuses across a prop
// change, which needs the same `client` identity (and the same `QueryClient`,
// since they assert on its cache) present on both sides of the rerender —
// something `renderWithData`'s result cannot give a caller-driven `rerender`.
// See each local `wrap` below.
import { Toaster } from "@robomous/ui-core";
import { formatWhen } from "../lib/format";
import { ProjectScreen } from "./ProjectScreen";
import { renderWithData } from "../testing/dataHarness";
import {
  CLASSES,
  PROJECT,
  addNamedClass,
  barState,
  bodies,
  classCards,
  editAffordances,
  handlers,
  historyEntry,
  on,
  openHistory,
  sent,
  installScreensHarness,
  viewVersion,
} from "../testing/screensHarness";

installScreensHarness();

describe("the schema version history", () => {
  /**
   * Three versions with descriptions and moments, the wire's own shape.
   *
   * Descriptions differ per version on purpose: a history whose entries all said
   * the same thing would pass an assertion that the *selected* one is shown while
   * actually showing any of them.
   */
  const VERSIONS = [
    {
      project_id: PROJECT,
      version: 1,
      classes: [CLASSES[0]],
      description: "the first contract",
      created_at: "2026-07-01T09:00:00Z",
    },
    {
      project_id: PROJECT,
      version: 2,
      classes: CLASSES,
      description: "lanes too",
      created_at: "2026-07-15T09:00:00Z",
    },
    {
      project_id: PROJECT,
      version: 3,
      classes: CLASSES,
      description: null,
      created_at: "2026-08-01T09:00:00Z",
    },
  ];

  /**
   * The project, its active version, and its history.
   *
   * ``active`` is passed rather than derived from ``items`` because the two are
   * separate routes and the screen reads them separately — a fixture that derived
   * one from the other would hide the case where they disagree, which is exactly
   * what a stale refetch looks like.
   */
  function withHistory(items: unknown[] = VERSIONS, active: unknown = VERSIONS[2]): void {
    on("GET", /^\/projects\/[^/]+$/, {
      status: 200,
      body: {
        id: PROJECT,
        name: "highway",
        description: null,
        thumbnail_asset_id: null,
        thumbnail_hash: null,
        created_at: null,
      },
    });
    on("GET", /^\/projects\/[^/]+\/schema$/, { status: 200, body: active });
    on("GET", /schema\/versions$/, { status: 200, body: { items, total: items.length } });
  }

  function withDiff(answer: unknown): void {
    on("GET", /schema\/compare/, { status: 200, body: answer });
  }

  const NOTHING = { is_destructive: false, destructive_classes: [], changes: [] };

  async function open(): Promise<void> {
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await screen.findByTestId("open-history");
  }

  /** Read a published version through its History entry. */
  async function view(version: number): Promise<void> {
    await viewVersion(version);
  }

  /** The entries of the open History sheet, in the order it lists them. */
  function entries(history: HTMLElement): HTMLElement[] {
    return [...history.querySelectorAll<HTMLElement>("[data-testid]")].filter((element) =>
      /^version-\d+$/.test(element.dataset.testid ?? ""),
    );
  }

  it("lists every version newest first in a sheet, and says which one is active", async () => {
    withHistory();
    withDiff(NOTHING);
    await open();
    // The band names the version in force on the button that opens the rest.
    expect(screen.getByTestId("open-history").getAttribute("aria-label")).toContain("version 3");
    // An icon button: no words of its own on the band.
    expect(screen.getByTestId("open-history").textContent?.trim()).toBe("");

    const history = await openHistory();
    await within(history).findByTestId("version-3");
    const listed = entries(history);
    expect(listed.map((entry) => entry.dataset.testid)).toEqual(["version-3", "version-2", "version-1"]);
    expect(within(listed[0]).getByText("Active")).not.toBeNull();
    expect(within(listed[1]).queryByText("Active")).toBeNull();
    expect(listed[1].textContent).toContain(formatWhen(VERSIONS[1].created_at));
    // Each says why it was made, in the words written beside Save — or that
    // nobody wrote any.
    expect(listed[1].textContent).toContain("lanes too");
    expect(listed[0].textContent).toContain("No message");
  });

  it("raises the commit bar once the draft has unsaved changes, and counts them", async () => {
    withHistory();
    withDiff(NOTHING);
    on("POST", /schema\/preview$/, {
      status: 200,
      body: {
        is_refused: false,
        blockers: [],
        diff: {
          is_destructive: false,
          destructive_classes: [],
          changes: [{ kind: "additive", label_class: "pedestrian", attribute: null, detail: "class 'pedestrian' added" }],
        },
      },
    });
    await open();
    expect(barState()).toBe("down");

    await addNamedClass("pedestrian");

    expect(barState()).toBe("up");
    await waitFor(() => expect(screen.getByTestId("draft-count").textContent).toBe("1 change in draft"));
    expect(screen.getByTestId("save-schema").textContent).toBe("Save version 4");
  });

  it("offers the history from the first published version, and not before", async () => {
    // One published version is already a history: there is a past to read, and
    // the draft to come back to.
    withHistory([VERSIONS[2]], VERSIONS[2]);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);

    await screen.findByTestId("schema-editor");
    const history = await openHistory();
    await within(history).findByTestId("version-3");
    expect(entries(history).map((entry) => entry.dataset.testid)).toEqual(["version-3"]);
  });

  it("offers no history to a project that has never published", async () => {
    // Nothing but the draft to choose from is furniture.
    on("GET", /^\/projects\/[^/]+$/, {
      status: 200,
      body: {
        id: PROJECT,
        name: "fresh",
        description: null,
        thumbnail_asset_id: null,
        thumbnail_hash: null,
        created_at: null,
      },
    });
    on("GET", /^\/projects\/[^/]+\/schema$/, {
      status: 404,
      body: { code: "SCHEMA_NOT_FOUND", message: "This project has no schema version yet." },
    });
    on("GET", /schema\/versions$/, { status: 200, body: { items: [], total: 0 } });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);

    await screen.findByTestId("schema-editor");
    // Nothing but the draft to come back to is furniture.
    expect(screen.queryByTestId("open-history")).toBeNull();
    expect(screen.queryByTestId("history-sheet")).toBeNull();
  });

  it("switches the page to a read-only past version, marking what it added", async () => {
    withHistory();
    withDiff(NOTHING);
    await open();

    await view(2);

    // The rows are read-only: a row opens to read the class, and nothing in the
    // table takes input or offers an edit — no menu, no restore — because a
    // published version is immutable and there is no "not now" to say.
    const past = await screen.findByTestId("past-version");
    expect(within(past).getAllByTestId(/^past-class-\d+$/).map((button) => button.getAttribute("data-testid"))).toEqual(["past-class-0", "past-class-1"]);
    expect(editAffordances(past)).toEqual([]);
    expect(within(past).getByTestId("past-class-0").textContent).toContain("vehicle");
    expect(within(past).getByTestId("past-class-1").textContent).toContain("lane");
    expect(screen.getByRole("heading", { level: 2, name: "Classes in version 2" })).not.toBeNull();
    // `lane` is not in version 1, which is the version before it — read off the
    // history, not computed from the diff. `vehicle` was already there.
    expect(within(past).getByTestId("class-mark-1").textContent).toBe("New");
    expect(within(past).queryByTestId("class-mark-0")).toBeNull();
    // And the band across the table says whose words these are.
    const panel = screen.getByTestId("past-version-panel");
    expect(within(panel).getByTestId("schema-status").textContent).toContain("version 2");
    expect(within(panel).getByTestId("schema-status").textContent).toContain("read-only");
    expect(within(panel).getByTestId("restore-version")).not.toBeNull();
  });

  it("opens a past version's row in a dialog to read the whole class, with nothing to edit", async () => {
    const DECLARED = [
      { name: "vehicle", geometries: ["bbox", "polygon"], color: "#38bdf8", attributes: [] },
      {
        name: "lane",
        geometries: ["polyline"],
        color: null,
        attributes: [
          { name: "surface", kind: "select", required: true, options: ["tarmac", "gravel"], default: "tarmac" },
          { name: "faded", kind: "boolean", required: false, options: null, default: null },
        ],
      },
    ];
    const history = [{ ...VERSIONS[0], classes: DECLARED }, VERSIONS[2]];
    withHistory(history, VERSIONS[2]);
    withDiff(NOTHING);
    await open();

    await view(1);
    const past = await screen.findByTestId("past-version");
    // Closed to begin with: a row is a summary until it is asked for.
    expect(screen.queryByTestId("past-class-detail-1")).toBeNull();
    expect(screen.queryByTestId("past-class-sheet")).toBeNull();
    // It opens a panel beside the table, not a dialog over it.
    expect(within(past).getByTestId("past-class-1").getAttribute("aria-haspopup")).toBeNull();

    await userEvent.click(within(past).getByTestId("past-class-1"));

    const sheet = await screen.findByTestId("past-class-sheet");
    // A panel at the right of the table, not a dialog over the page.
    expect(sheet.closest("aside")?.getAttribute("aria-label")).toBe("Class");
    expect(sheet.closest("[role=dialog]")).toBeNull();
    expect(within(sheet).getByRole("heading", { name: "lane" })).not.toBeNull();
    expect(sheet.textContent).toContain("As version 1 declares it");
    const detail = within(sheet).getByTestId("past-class-detail-1");
    // The colour it derives from its name, the key it holds and the shape it draws as.
    expect(detail.textContent).toContain("from the name");
    expect(within(detail).getByText("Shortcut").nextElementSibling!.textContent).toBe("2");
    expect(detail.textContent).toContain("Polyline");
    // Each attribute, as its name, whether it is required, what it accepts and its default.
    expect(detail.textContent).toContain("surface");
    expect(detail.textContent).toContain("Choice of 2 · required");
    // Its choices are always shown, with the default marked: a read has no group to open.
    expect(detail.textContent).toContain("tarmac (default)");
    expect(detail.textContent).toContain("gravel");
    expect(detail.textContent).not.toContain("gravel (default)");
    expect(detail.textContent).toContain("faded");
    expect(detail.textContent).toContain("Yes or no");
    // Read, not edited: nothing in the class takes input or changes a value, and
    // an attribute has no menu to remove it from.
    expect(detail.querySelectorAll("input, textarea, select, button, [role=switch], [role=combobox], [role=checkbox]")).toHaveLength(0);
    expect(screen.queryByTestId("class-sheet")).toBeNull();
    expect(within(sheet).queryByTestId("class-sheet-done")).toBeNull();
    expect(within(sheet).queryByTestId("remove-class-1")).toBeNull();

    // Put away with its footer's Close, and focus is back on the row it was opened from.
    await userEvent.click(within(sheet).getAllByRole("button", { name: "Close" }).at(-1)!);
    await waitFor(() => expect(screen.queryByTestId("past-class-sheet")).toBeNull());
    expect(document.activeElement).toBe(within(past).getByTestId("past-class-1"));

    // A class with no attributes says so, and a declared colour is read as its hex.
    await userEvent.click(within(past).getByTestId("past-class-0"));
    const first = await screen.findByTestId("past-class-detail-0");
    expect(first.textContent).toContain("None — an annotation carries only its class.");
    expect(first.textContent).toContain("Box");
    expect(first.textContent).toContain("Polygon");
    expect(first.textContent).toContain("#38bdf8");
    await waitFor(() => expect(screen.queryByTestId("past-class-detail-1")).toBeNull());
    expect(screen.getAllByTestId("past-class-sheet")).toHaveLength(1);
  });

  it("marks a class the comparison says changed, and only that class", async () => {
    withHistory();
    withDiff({
      is_destructive: false,
      destructive_classes: [],
      changes: [
        { kind: "additive", label_class: "lane", attribute: "lit", detail: "attribute 'lit' added to 'lane'" },
      ],
    });
    await open();

    await view(3);

    // Version 2 already declared both classes, so neither is new; `lane` is the
    // one the API's own comparison names.
    const past = await screen.findByTestId("past-version");
    await waitFor(() => expect(within(past).queryByTestId("class-mark-1")).not.toBeNull());
    expect(within(past).getByTestId("class-mark-1").textContent).toBe("Changed");
    expect(within(past).queryByTestId("class-mark-0")).toBeNull();
  });

  it("opens a version from the history, and its second press goes back to the draft", async () => {
    withHistory();
    withDiff(NOTHING);
    await open();

    const history = await openHistory();
    await userEvent.click(await within(history).findByTestId("view-version-2"));

    // The panel puts itself away, and the table is the version's.
    await screen.findByTestId("past-version");
    await waitFor(() => expect(screen.queryByTestId("history-sheet")).toBeNull());
    expect(screen.queryByTestId("save-schema")).toBeNull();

    // Opened again, the history says which version is on screen, and that
    // entry's View is the way back.
    const again = await openHistory();
    expect(within(again).getByTestId("version-2").getAttribute("aria-current")).toBe("true");
    expect(within(again).getByTestId("version-1").getAttribute("aria-current")).toBeNull();
    expect(within(again).getByTestId("view-version-2").getAttribute("aria-pressed")).toBe("true");
    expect(within(again).getByTestId("view-version-2").getAttribute("aria-label")).toContain("Back to the draft");
    await userEvent.click(within(again).getByTestId("view-version-2"));

    await screen.findByTestId("class-list");
    expect(screen.queryByTestId("past-version")).toBeNull();
    expect(screen.getByTestId("schema-status").textContent).toContain("Version 3 active");
  });

  it("opens as a labelled panel beside the table, takes focus, and Escape puts it away", async () => {
    withHistory();
    withDiff(NOTHING);
    await open();

    const history = await openHistory();
    const pane = screen.getByTestId("history-sheet").closest("aside")!;
    expect(pane.getAttribute("aria-label")).toBe("Schema history");
    expect(pane.closest("[role=dialog]")).toBeNull();
    expect(pane.contains(document.activeElement)).toBe(true);
    // The table stays on the page beside it.
    expect(screen.getByTestId("class-list")).not.toBeNull();
    expect(history).not.toBeNull();

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("history-sheet")).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId("open-history"));
  });

  it("is replaced by a class's panel, and a class's panel by it — one detail at a time", async () => {
    withHistory();
    withDiff(NOTHING);
    await open();

    await openHistory();
    await userEvent.click(screen.getByTestId("class-card-0"));
    await screen.findByTestId("class-sheet");
    await waitFor(() => expect(screen.queryByTestId("history-sheet")).toBeNull());
    expect(document.querySelectorAll("aside[aria-label]")).toHaveLength(1);

    await userEvent.click(screen.getByTestId("open-history"));
    await screen.findByTestId("history-sheet");
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
  });

  it("renders a past version with no edit affordance at all", async () => {
    withHistory();
    withDiff(NOTHING);
    await open();
    expect(screen.queryByTestId("save-schema")).not.toBeNull();

    await view(1);

    // Absent, not disabled: a disabled control says "not now", and there is no
    // now — a published version is immutable.
    await waitFor(() => expect(screen.queryByTestId("past-version")).not.toBeNull());
    const past = screen.getByTestId("past-version");
    expect(within(past).getAllByTestId(/^past-class-\d+$/).map((button) => button.getAttribute("data-testid"))).toEqual(["past-class-0"]);
    expect(editAffordances(past)).toEqual([]);
    // No commit bar to rise, and so nothing to discard or save: a published
    // version has no draft in it. No lens either — nothing in it changed.
    expect(screen.queryByTestId("commit-bar")).toBeNull();
    expect(screen.queryByTestId("discard-draft")).toBeNull();
    expect(screen.queryByTestId("classes-lens")).toBeNull();
    expect(screen.queryByTestId("save-schema")).toBeNull();
    expect(screen.queryByTestId("add-class")).toBeNull();
    expect(screen.queryByTestId("class-list")).toBeNull();
    expect(screen.queryByTestId("class-sheet")).toBeNull();
    expect(screen.queryByTestId("classes-none")).toBeNull();
    expect(screen.getByTestId("schema-status").textContent).toContain("read-only");
    // Version 1 has nothing before it, so nothing on it can be new or changed.
    expect(screen.queryByTestId("class-mark-0")).toBeNull();
  });

  it("returns to the draft, unchanged, when the way back is pressed", async () => {
    withHistory();
    withDiff(NOTHING);
    await open();
    await view(1);
    await screen.findByTestId("past-version");

    await userEvent.click(screen.getByTestId("back-to-active"));

    await waitFor(() => expect(screen.queryByTestId("save-schema")).not.toBeNull());
    expect(screen.getByTestId("schema-status").textContent).toContain("Version 3 active");
    expect(screen.getByRole("heading", { level: 2, name: "Classes" })).not.toBeNull();
    expect(screen.queryByTestId("past-version-panel")).toBeNull();
  });

  it("shows the selected version's own description, and says so when there is none", async () => {
    withHistory();
    withDiff(NOTHING);
    await open();

    // v3 is active and was published without one — and it is read under the
    // same band as any other, as "active · read-only".
    await view(3);
    expect(screen.getByTestId("version-description").textContent).toContain("No message");
    expect(screen.getByTestId("schema-status").textContent).toContain("active · read-only");
    // The active version is what the draft already starts from: nothing to
    // restore, said in Restore's own room so walking onto it moves nothing.
    expect(screen.queryByTestId("restore-version")).toBeNull();
    expect(screen.getByTestId("version-active").textContent).toContain("Active version");

    await view(2);

    await waitFor(() =>
      expect(screen.getByTestId("version-description").textContent).toContain("lanes too"),
    );
    expect(screen.getByTestId("schema-status").textContent).not.toContain("active");
  });

  it("marks the version by the API's comparison, whose word wins over the cells", async () => {
    withHistory();
    withDiff({
      is_destructive: true,
      destructive_classes: ["lane"],
      changes: [
        { kind: "destructive", label_class: "lane", attribute: "lit", detail: "required attribute 'lit' added to class 'lane'" },
      ],
    });
    await open();
    await view(3);

    // v2 and v3 declare the same classes, so no cell moved — yet the kernel
    // names `lane`, and the table says what the kernel says.
    const past = await screen.findByTestId("past-version");
    await waitFor(() => expect(within(past).getByTestId("class-mark-1").textContent).toBe("Changed"));
    expect(within(past).queryByTestId("class-mark-0")).toBeNull();
    // A narrowing says so in a word beside the mark — the colour is not the only cue.
    expect(within(past).getByTestId("class-mark-narrows-1").textContent).toContain("Narrows");
    expect(within(past).queryByTestId("class-mark-narrows-0")).toBeNull();
    // And the head counts both.
    const counted = screen.getByTestId("version-diff").textContent;
    expect(counted).toContain("1 changed");
    expect(counted).toContain("1 narrows");
  });

  it("keeps a class the version dropped where it stood, struck, and marks the ones it added", async () => {
    const [vehicle, lane] = CLASSES;
    withHistory([
      { project_id: PROJECT, version: 1, classes: [lane, vehicle], description: "both", created_at: "2026-07-01T09:00:00Z" },
      { project_id: PROJECT, version: 2, classes: [vehicle], description: "lane out", created_at: "2026-07-15T09:00:00Z" },
      { project_id: PROJECT, version: 3, classes: [vehicle, lane], description: "lane back", created_at: "2026-08-01T09:00:00Z" },
    ], { project_id: PROJECT, version: 3, classes: [vehicle, lane] });
    withDiff({
      is_destructive: true,
      destructive_classes: ["lane"],
      changes: [{ kind: "destructive", label_class: "lane", attribute: null, detail: "class 'lane' removed" }],
    });
    await open();
    await view(2);

    const past = await screen.findByTestId("past-version");
    // Removed, in the row it held in v1 — above vehicle — and nothing to press.
    const rows = [...past.querySelectorAll<HTMLElement>("tbody tr")].map((row) => row.dataset.testid);
    expect(rows).toEqual(["class-removed-lane", "past-row-0"]);
    expect(within(past).getByTestId("class-mark-removed-lane").textContent).toBe("Removed");
    expect(within(past).getByTestId("class-mark-narrows-lane").textContent).toContain("Narrows");
    // vehicle moved from the second hotkey to the first: the old digit is struck beside the new.
    expect(within(past).getByTestId("past-row-0").textContent).toContain("2");
    expect(within(past).getByLabelText("was 2")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("version-diff").textContent).toContain("1 removed"));

    // v3 brings lane back: new.
    await userEvent.click(screen.getByTestId("newer-version"));
    await waitFor(() => expect(screen.getByTestId("schema-status").textContent).toContain("version 3"));
    expect(within(await screen.findByTestId("past-version")).getByTestId("class-mark-1").textContent).toBe("New");
  });

  it("asks nothing until a version is opened, then about it against its predecessor", async () => {
    withHistory();
    withDiff(NOTHING);
    await open();
    // On the draft there is no version to compare, so nothing is asked — and
    // the sheet is a navigator: opening it asks nothing either.
    await openHistory();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent.some((r) => r.url.includes("/schema/compare"))).toBe(false);

    await view(3);
    await waitFor(() => expect(sent.some((r) => r.url.includes("from=2&to=3"))).toBe(true));
    // Never about a version against one that does not exist.
    expect(sent.some((r) => r.url.includes("from=0"))).toBe(false);
  });

  it("asks nothing about version 1, because there is nothing before it", async () => {
    withHistory();
    withDiff(NOTHING);
    await open();
    await view(1);
    await screen.findByTestId("past-version");

    // Its head says it is the first, and no row is marked.
    expect(screen.getByTestId("version-diff-none").textContent).toContain("first version");
    expect(screen.queryAllByTestId(/^class-mark-/)).toHaveLength(0);
    // `from=0` is a 422, so the query is disabled rather than sent with a guess.
    expect(sent.some((r) => r.url.includes("from=0"))).toBe(false);
  });

  it("restores a past version into the draft, with the note, and goes back to the draft", async () => {
    withHistory();
    withDiff(NOTHING);
    renderWithData(
      <>
        <ProjectScreen projectId={PROJECT} tab="schema" />
        <Toaster />
      </>,
    );
    await screen.findByTestId("open-history");
    await view(1);
    await screen.findByTestId("past-version");

    await userEvent.click(screen.getByTestId("restore-version"));

    // Back on the draft, which is now version 1's contract — one class — and
    // nothing has been published: a version is never rewritten.
    await screen.findByTestId("class-list");
    expect(screen.queryByTestId("past-version")).toBeNull();
    await waitFor(() => expect(classCards()).toHaveLength(1));
    expect(screen.getByTestId("class-card-0").getAttribute("aria-label")).toBe("Edit vehicle");
    expect(screen.getByTestId("schema-status").textContent).toContain("unsaved changes create v4");
    expect(barState()).toBe("up");
    expect(screen.getByTestId("save-schema").textContent).toBe("Save version 4");
    expect(sent.some((r) => r.method === "POST" && r.url.includes("/publish"))).toBe(false);
    // Said once, with what Save will do. The draft was clean, so there is
    // nothing to undo and no Undo is offered.
    expect(await screen.findByText("Version 1's classes are in the draft")).not.toBeNull();
    expect(screen.getByText("Saving publishes them as version 4.")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("puts the draft that a restore replaced back, when Undo is pressed", async () => {
    withHistory();
    withDiff(NOTHING);
    renderWithData(
      <>
        <ProjectScreen projectId={PROJECT} tab="schema" />
        <Toaster />
      </>,
    );
    await screen.findByTestId("open-history");
    await addNamedClass("pedestrian");
    await view(1);
    await screen.findByTestId("past-version");

    await userEvent.click(screen.getByTestId("restore-version"));

    await waitFor(() => expect(classCards()).toHaveLength(1));
    // The draft held unsaved work, so the restore replaced it and says how to
    // get it back.
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));

    await waitFor(() => expect(classCards()).toHaveLength(3));
    expect(screen.getByTestId("class-card-2").getAttribute("aria-label")).toBe("Edit pedestrian");
  });

  it("discards the draft back to the version in force, with an Undo", async () => {
    withHistory();
    withDiff(NOTHING);
    renderWithData(
      <>
        <ProjectScreen projectId={PROJECT} tab="schema" />
        <Toaster />
      </>,
    );
    await screen.findByTestId("open-history");
    await addNamedClass("pedestrian");
    expect(barState()).toBe("up");

    await userEvent.click(screen.getByTestId("discard-draft"));

    // Nothing asked first: what was there is one Undo away, and nothing was published.
    await waitFor(() => expect(classCards()).toHaveLength(2));
    expect(barState()).toBe("down");
    expect(sent.some((r) => r.method === "POST" && r.url.includes("/publish"))).toBe(false);
    expect(await screen.findByText("Draft discarded")).not.toBeNull();

    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(classCards()).toHaveLength(3));
    expect(barState()).toBe("up");
  });

  it("restores a version straight from its History entry, publishing nothing", async () => {
    withHistory();
    withDiff(NOTHING);
    await open();

    const entry = await historyEntry(1);
    await userEvent.click(within(entry).getByTestId("restore-version-1"));

    await waitFor(() => expect(screen.queryByTestId("history-sheet")).toBeNull());
    await waitFor(() => expect(classCards()).toHaveLength(1));
    expect(barState()).toBe("up");
    expect(sent.some((r) => r.method === "POST" && r.url.includes("/publish"))).toBe(false);
  });

  it("publishes a restored version with the message the restore wrote", async () => {
    withHistory();
    withDiff(NOTHING);
    on("POST", /schema\/drafts\/curated\/publish$/, {
      status: 201,
      body: { published: { ...VERSIONS[0], version: 4 }, advanced_batches: [] },
    });
    await open();

    // There is no field for a version's message: the one a draft carries is
    // the restore's own, and Save flushes it with the draft before it
    // publishes — the kernel reads the description off the stored draft.
    const entry = await historyEntry(1);
    await userEvent.click(within(entry).getByTestId("restore-version-1"));
    await waitFor(() => expect(classCards()).toHaveLength(1));
    await userEvent.click(screen.getByTestId("save-schema"));

    await waitFor(() => expect(sent.some((r) => r.method === "PUT")).toBe(true));
    const request = sent.filter((r) => r.method === "PUT").at(-1);
    expect(JSON.parse(bodies.get(request!) ?? "{}").note).toBe("Restore version 1");
  });

  /**
   * The old client-side omission this test's name described no longer exists
   * to prove: `SchemaDraftBody.note` (`generated/api.ts`) is a required
   * `string`, so there is no key left to leave out, and "blank is legal"
   * became the kernel's decision (`draft.note or None`, read off the stored
   * draft at publish time) rather than a choice this screen makes about the
   * request. What is still this screen's to get right is that it does not
   * invent a *second* version of that decision — an empty box is sent exactly
   * as typed, not coerced to `null` or held back.
   */
  it("sends an empty note rather than inventing an omission for it", async () => {
    withHistory();
    withDiff(NOTHING);
    on("POST", /schema\/drafts\/curated\/publish$/, {
      status: 201,
      body: { published: { ...VERSIONS[2], version: 4 }, advanced_batches: [] },
    });
    await open();

    await addNamedClass("pedestrian");
    await userEvent.click(screen.getByTestId("save-schema"));

    await waitFor(() => expect(sent.some((r) => r.method === "PUT")).toBe(true));
    const request = sent.find((r) => r.method === "PUT");
    expect(JSON.parse(bodies.get(request!) ?? "{}").note).toBe("");
  });

  it("declares every version it publishes as curated", async () => {
    // The editor is where somebody sits down and decides what the project labels,
    // so what makes a version a milestone is the *surface* rather than the size of
    // the change — a one-class save from here is still curated. The sibling claim,
    // that the annotator's dialog says `annotation`, lives in `addClass.test.ts`.
    //
    // `curated` used to be a field on the publish body; it is now the draft's own
    // `kind`, named in the path rather than the payload — so the path this
    // editor publishes through *is* the claim.
    withHistory();
    withDiff(NOTHING);
    on("POST", /schema\/drafts\/curated\/publish$/, {
      status: 201,
      body: { published: { ...VERSIONS[2], version: 4 }, advanced_batches: [] },
    });
    await open();

    await addNamedClass("pedestrian");
    await userEvent.click(screen.getByTestId("save-schema"));

    await waitFor(() =>
      expect(
        sent.some(
          (r) =>
            r.method === "POST" &&
            /\/schema\/drafts\/curated\/publish$/.test(new URL(r.url).pathname),
        ),
      ).toBe(true),
    );
  });

  it("shows a published description as soon as the refetch lands", async () => {
    withHistory();
    withDiff(NOTHING);
    const published = {
      project_id: PROJECT,
      version: 4,
      classes: CLASSES,
      description: "added pedestrians",
      created_at: "2026-08-02T09:00:00Z",
    };
    on("POST", /schema\/drafts\/curated\/publish$/, {
      status: 201,
      body: { published, advanced_batches: [] },
    });
    await open();
    await addNamedClass("pedestrian");

    // The refetch after the save finds a fourth version, which is what the
    // history renders — this is the round trip, not the mutation's own answer.
    handlers.length = 0;
    withHistory([...VERSIONS, published], published);
    withDiff(NOTHING);
    on("POST", /schema\/drafts\/curated\/publish$/, {
      status: 201,
      body: { published, advanced_batches: [] },
    });
    await userEvent.click(screen.getByTestId("save-schema"));

    // Back on the draft after a publish, and the history — the one place every
    // version's own note is shown without being opened — carries it.
    await waitFor(() => expect(screen.getByTestId("open-history").getAttribute("aria-label")).toContain("version 4"));
    const history = await openHistory();
    await waitFor(() =>
      expect(within(history).getByTestId("version-4").textContent).toContain("added pedestrians"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("schema-status").textContent).toContain("Version 4 active"),
    );
  });

  it("says so rather than going blank when the comparison cannot be loaded", async () => {
    withHistory();
    on("GET", /schema\/compare/, { status: 500, body: { code: "INTERNAL_ERROR", message: "no" } });
    await open();
    await view(2);

    await screen.findByTestId("version-diff-error");
    // The version is still readable and still restorable: a diff is context, not
    // the contract.
    expect(screen.queryByTestId("past-version")).not.toBeNull();
    expect(screen.queryByTestId("restore-version")).not.toBeNull();
    // And the draft it came from is untouched.
    await userEvent.click(screen.getByTestId("back-to-active"));
    expect(screen.queryByTestId("save-schema")).not.toBeNull();
    // Restoring from the history does not wait on a comparison either.
    const entry = await historyEntry(2);
    expect(within(entry).getByTestId("restore-version-2")).not.toBeNull();
  });
});


describe("version history", () => {
  /** The lines of the open History sheet, in the order it lists them. */
  function entries(history: HTMLElement): HTMLElement[] {
    return [...history.querySelectorAll<HTMLElement>("[data-testid]")].filter((element) => /^version-\d+$/.test(element.dataset.testid ?? ""));
  }

  it("renders every version, marks the active one, and offers no way to edit a past one", async () => {
    on("GET", /^\/projects\/[^/]+$/, {
      status: 200,
      body: {
        id: PROJECT,
        name: "highway",
        description: null,
        thumbnail_asset_id: null,
        thumbnail_hash: null,
        created_at: null,
      },
    });
    on("GET", /^\/projects\/[^/]+\/schema$/, {
      status: 200,
      body: { project_id: PROJECT, version: 2, classes: CLASSES },
    });
    on("GET", /schema\/versions$/, {
      status: 200,
      body: {
        items: [
          { project_id: PROJECT, version: 1, classes: [CLASSES[0]] },
          { project_id: PROJECT, version: 2, classes: CLASSES },
        ],
        total: 2,
      },
    });

    on("GET", /schema\/compare/, {
      status: 200,
      body: {
        is_destructive: false,
        destructive_classes: [],
        changes: [{ kind: "additive", label_class: "lane", attribute: null, detail: "class 'lane' added" }],
      },
    });

    // Reached through the Classes section, which is where the history lives: it
    // is a view *of* the schema rather than a peer of it.
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);

    const history = await openHistory();
    // `findBy` on the entry: the sheet renders at once and holds the skeletons,
    // so a `getBy` here asserts against a loading state.
    await within(history).findByTestId("version-1");
    // A line says the version's message — these were published without one.
    expect(within(history).getByTestId("version-1").textContent).toContain("No message");

    // Active is *derived* — the highest version, never a stored flag.
    expect(within(history).getByTestId("version-2").textContent).toContain("Active");
    expect(within(history).getByTestId("version-1").textContent).not.toContain("Active");

    // Read-only is structural rather than disabled: an entry's controls only
    // *open* the version or copy it into the draft, and nothing in the history
    // can write to it. The active one has nothing to restore.
    const buttons = within(history).getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "View version 2, active: no message",
      "View version 1: no message",
      "Restore version 1",
    ]);
    expect(within(history).queryAllByRole("textbox")).toHaveLength(0);
    await userEvent.click(buttons[1]);
    const past = await screen.findByTestId("past-version");
    // Version 1 declares one class: its row is the only thing to press, and it
    // only opens to read.
    expect(within(past).getAllByTestId(/^past-class-\d+$/).map((button) => button.getAttribute("data-testid"))).toEqual(["past-class-0"]);
    expect(editAffordances(past)).toEqual([]);
  });

  it("shows why and when, and an em dash for a version that recorded neither", async () => {
    // The two optional fields on the ledger. Both are null for a version published
    // before the migration, and nothing backfills either — so the row has to say
    // "not recorded" rather than go blank, which reads as a rendering bug.
    on("GET", /^\/projects\/[^/]+$/, {
      status: 200,
      body: {
        id: PROJECT,
        name: "highway",
        description: null,
        thumbnail_asset_id: null,
        thumbnail_hash: null,
        created_at: null,
      },
    });
    on("GET", /schema\/versions$/, {
      status: 200,
      body: {
        items: [
          { project_id: PROJECT, version: 1, classes: CLASSES, description: null, created_at: null },
          {
            project_id: PROJECT,
            version: 2,
            classes: CLASSES,
            description: "split vehicle into car and truck",
            created_at: "2026-07-15T09:00:00Z",
          },
        ],
        total: 2,
      },
    });

    // The editor is above the history in the same tab now, so its own query has
    // to be answered or the section never gets past loading.
    on("GET", /^\/projects\/[^/]+\/schema$/, {
      status: 200,
      body: { project_id: PROJECT, version: 2, classes: CLASSES },
    });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);

    const history = await openHistory();
    await within(history).findByTestId("version-1");
    expect(within(history).getByTestId("version-2").textContent).toContain(
      "split vehicle into car and truck",
    );
    expect(within(history).getByTestId("version-1").textContent).toContain("—");
  });

  /**
   * Grouping the ledger by provenance.
   *
   * The rule itself is `schemaHistory.test.ts` — pure, and where the boundaries
   * are. This is the half that only exists on screen: that a run renders as one
   * collapsed row, that the milestones around it do not, and that expanding
   * gives back exactly the entries a flat list would have had.
   */
  describe("versions published while annotating", () => {
    /** Four versions: two curated milestones with a two-version run between them. */
    function withRun(): void {
      on("GET", /^\/projects\/[^/]+$/, {
        status: 200,
        body: {
          id: PROJECT,
          name: "highway",
          description: null,
          thumbnail_asset_id: null,
          thumbnail_hash: null,
          created_at: null,
        },
      });
      on("GET", /^\/projects\/[^/]+\/schema$/, {
        status: 200,
        body: { project_id: PROJECT, version: 4, classes: CLASSES },
      });
      on("GET", /schema\/versions$/, {
        status: 200,
        body: {
          items: [
            { project_id: PROJECT, version: 1, classes: CLASSES, provenance: "curated" },
            {
              project_id: PROJECT,
              // Deliberately **fewer classes than v3**: with every version
              // declaring the same contract, a run summarising its oldest member
              // instead of its newest reads identically and the assertion below
              // cannot fail. The run's summary is what it *left behind*.
              version: 2,
              classes: [CLASSES[0]],
              provenance: "annotation",
              description: 'Added class "cone" from the annotation view',
            },
            {
              project_id: PROJECT,
              version: 3,
              classes: CLASSES,
              provenance: "annotation",
              description: 'Added class "barrier" from the annotation view',
            },
            {
              project_id: PROJECT,
              version: 4,
              classes: CLASSES,
              provenance: "curated",
              description: "split vehicle into car and truck",
            },
          ],
          total: 4,
        },
      });
    }

    it("draws the run on a lane of its own, and leaves the milestones on the main one", async () => {
      withRun();
      renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);

      const history = await openHistory();
      await within(history).findByTestId("version-4");

      // Every version is a line of its own, newest first — a run is a detour on
      // the graph, not a disclosure that hides its members.
      expect(entries(history).map((entry) => entry.dataset.testid)).toEqual(["version-4", "version-3", "version-2", "version-1"]);
      expect(within(history).getByTestId("version-3").dataset.lane).toBe("1");
      expect(within(history).getByTestId("version-2").dataset.lane).toBe("1");
      expect(within(history).getByTestId("version-4").dataset.lane).toBe("0");
      expect(within(history).getByTestId("version-1").dataset.lane).toBe("0");
    });

    it("says which sitting a version came from when it is read", async () => {
      withRun();
      on("GET", /schema\/compare/, { status: 200, body: { is_destructive: false, destructive_classes: [], changes: [] } });
      renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
      await viewVersion(3);

      const head = await screen.findByTestId("past-version-panel");
      expect(head.textContent).toContain("Annotating session 1");
      expect(head.textContent).toContain('Added class "barrier" from the annotation view');
    });

    it("marks the version on screen in the history, inside its run", async () => {
      withRun();
      on("GET", /schema\/compare/, { status: 200, body: { is_destructive: false, destructive_classes: [], changes: [] } });
      renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
      await viewVersion(3);
      await screen.findByTestId("past-version");

      const again = await openHistory();
      const entry = await within(again).findByTestId("version-3");
      expect(entry.getAttribute("aria-current")).toBe("true");
      expect(within(again).getByTestId("version-2").getAttribute("aria-current")).toBeNull();
    });

    it("reads a run's members like any other version", async () => {
      withRun();
      renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);

      const history = await openHistory();
      await within(history).findByTestId("version-3");
      expect(within(history).getByTestId("version-3").textContent).toContain('Added class "barrier" from the annotation view');
      expect(within(history).getByTestId("version-2").textContent).toContain('Added class "cone" from the annotation view');
    });

    it("groups nothing in a history that recorded no provenance", async () => {
      // Every version published before WS1's migration answers null, and nothing
      // backfills them. "Nobody said" must not be read as "incidental" — so a
      // project untouched since then reads exactly as it did before this rule.
      on("GET", /^\/projects\/[^/]+$/, {
        status: 200,
        body: {
          id: PROJECT,
          name: "highway",
          description: null,
          thumbnail_asset_id: null,
          thumbnail_hash: null,
          created_at: null,
        },
      });
      on("GET", /^\/projects\/[^/]+\/schema$/, {
        status: 200,
        body: { project_id: PROJECT, version: 2, classes: CLASSES },
      });
      on("GET", /schema\/versions$/, {
        status: 200,
        body: {
          items: [
            { project_id: PROJECT, version: 1, classes: CLASSES },
            { project_id: PROJECT, version: 2, classes: CLASSES },
          ],
          total: 2,
        },
      });
      renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);

      const history = await openHistory();
      await within(history).findByTestId("version-1");
      expect(within(history).getByTestId("version-2")).toBeTruthy();
      // And therefore no lane but the main one.
      expect(entries(history).map((entry) => entry.dataset.lane)).toEqual(["0", "0"]);
    });
  });
});

