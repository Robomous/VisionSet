/**
 * The project screens' test harness: a stubbed `fetch` with a route table, the
 * requests it saw, a stand-in for the shared schema draft, and the helpers the
 * schema editor's suites drive the page with. The two hook probes are
 * `screensProbes.tsx`'s.
 *
 * Shared by `screens.test.tsx`, `schemaEditor.test.tsx` and
 * `schemaHistory.test.tsx`; each calls `installScreensHarness()` once at its top level.
 */

import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { stubResizeObserver } from "./resizeObserver.js";
import type { components as capComponents } from "../generated/api.js";

export type BatchState = capComponents["schemas"]["BatchState"];

export const PROJECT = "11111111-1111-4111-8111-111111111111";
/** A second project, for the draft that must not follow somebody into it. */
export const OTHER_PROJECT = "77777777-7777-4777-8777-777777777777";

/** One route table, matched in order. A miss is a loud 500 rather than a hang. */
export type HandlerAnswer = { status: number; body: unknown } | undefined;
export type Handler = (request: Request) => HandlerAnswer | Promise<HandlerAnswer>;

export const handlers: Handler[] = [];
export const sent: Request[] = [];
/**
 * What each request carried, captured before the client consumes it.
 *
 * Cloned rather than read later: a `Request` body is a one-shot stream, so a test
 * asking for it after the fact gets nothing. The colour-input claim needs it —
 * is about the payload a save actually sends, not about what the control shows.
 */
export const bodies = new Map<Request, string>();

/**
 * A minimal stand-in for `SchemaDraftService`, keyed by project id — the schema
 * editor now writes the shared draft before every publish, so `save-schema`
 * needs a `PUT .../schema/drafts/{kind}` that actually answers rather than the
 * loud 500 an unmatched route gets everywhere else in this file. No test here
 * exercises `STALE_WRITE` — that belongs to `schemaDraft.test.tsx`, which owns
 * the fuller simulation — so this one only ever creates and re-saves.
 */
export const curatedDrafts = new Map<
  string,
  { project_id: string; kind: string; classes: unknown[]; note: string; based_on: number | null; revision: number; updated_at: string }
>();

/** `/projects/{id}/schema/drafts/{kind}`'s `id`, or `null` off that path. */
function draftProjectId(path: string): string | null {
  const match = /^\/projects\/([^/]+)\/schema\/drafts\/[^/]+$/.exec(path);
  return match ? match[1] : null;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Installs the stubbed `fetch` and its reset around every test of the file that
 * calls it, at the top level, once.
 */
export function installScreensHarness(): void {
beforeEach(() => {
  // The class dialog's fields sit in a form element, where a Radix Checkbox measures
  // itself through `ResizeObserver`; jsdom has none. `afterEach` unstubs it.
  stubResizeObserver();
  handlers.length = 0;
  sent.length = 0;
  bodies.clear();
  curatedDrafts.clear();
  vi.stubGlobal("fetch", async (request: Request) => {
    sent.push(request);
    if (request.method !== "GET") bodies.set(request, await request.clone().text());
    for (const handler of handlers) {
      const answer = await handler(request);
      if (answer !== undefined) {
        return Promise.resolve(
          new Response(answer.status === 204 ? null : JSON.stringify(answer.body), {
            status: answer.status,
            headers: { "content-type": "application/json" },
          }),
        );
      }
    }
    const path = new URL(request.url).pathname;
    const draftProject = draftProjectId(path);
    if (draftProject !== null && request.method === "GET") {
      const stored = curatedDrafts.get(draftProject);
      return Promise.resolve(
        stored === undefined
          ? jsonResponse(404, { code: "SCHEMA_DRAFT_NOT_FOUND", message: "no draft yet" })
          : jsonResponse(200, stored),
      );
    }
    if (draftProject !== null && request.method === "PUT") {
      const written = JSON.parse(bodies.get(request) ?? "{}") as {
        classes: unknown[];
        note: string;
        based_on: number | null;
      };
      const saved = {
        project_id: draftProject,
        kind: "curated",
        classes: written.classes,
        note: written.note,
        based_on: written.based_on,
        revision: (curatedDrafts.get(draftProject)?.revision ?? 0) + 1,
        updated_at: "2024-01-01T00:00:00Z",
      };
      curatedDrafts.set(draftProject, saved);
      return Promise.resolve(jsonResponse(200, saved));
    }
    if (path.endsWith("/schema/preview") && request.method === "POST") {
      return Promise.resolve(
        jsonResponse(200, {
          diff: { changes: [], destructive_classes: [], is_destructive: false },
          blockers: [],
          is_refused: false,
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ code: "NO_STUB", message: `${request.method} ${request.url}` }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.sessionStorage.clear();
});
}

export function on(method: string, pattern: RegExp, answer: { status: number; body?: unknown }): void {
  handlers.push((request) =>
    request.method === method && pattern.test(new URL(request.url).pathname + new URL(request.url).search)
      ? { status: answer.status, body: answer.body ?? null }
      : undefined,
  );
}

/** The text of every element a dialog's `aria-describedby` reaches. */
export function describedBy(dialog: HTMLElement): readonly (string | null)[] {
  return (dialog.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? null);
}

export const CLASSES = [
  { name: "vehicle", geometries: ["bbox"], color: "#38bdf8", attributes: [] },
  { name: "lane", geometries: ["polygon"], color: null, attributes: [] },
];



export function classCards(): HTMLElement[] {
  const list = screen.queryByTestId("class-list");
  return list === null ? [] : [...list.querySelectorAll<HTMLElement>('button[data-testid^="class-card-"]')];
}

/**
 * Put the open class dialog away with its submit — Save, or Add to draft — the
 * way a person finishes with a class before moving on. A dialog is modal, so a
 * test that leaves one open would find the page behind it inert; and an edit
 * only reaches the draft when it is submitted, so this is also what makes what
 * was typed count.
 */
export async function closeSheet(): Promise<void> {
  if (screen.queryByTestId("class-sheet") === null) return;
  await userEvent.click(screen.getByTestId("class-sheet-done"));
  await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
}

/** Whether the commit bar is up: the draft differs from the version in force. */
export function barState(): string | null {
  return screen.queryByTestId("commit-bar")?.getAttribute("data-state") ?? null;
}

/** The History sheet, opened from the band if it is not open already. */
export async function openHistory(): Promise<HTMLElement> {
  if (screen.queryByTestId("history-sheet") === null) {
    await userEvent.click(await screen.findByTestId("open-history"));
  }
  return screen.findByTestId("version-history");
}

/** A version's entry in the History sheet. */
export async function historyEntry(version: number): Promise<HTMLElement> {
  const history = await openHistory();
  return within(history).findByTestId(`version-${version}`);
}

/** Show a published version in the table, through its History entry's View. */
export async function viewVersion(version: number): Promise<void> {
  const entry = await historyEntry(version);
  await userEvent.click(within(entry).getByTestId(`view-version-${version}`));
  await waitFor(() => expect(screen.queryByTestId("history-sheet")).toBeNull());
}

/**
 * The controls in a read-only table that would be an edit: everything but the
 * buttons that open a row to read it and the hints a hover or focus opens.
 */
export function editAffordances(table: HTMLElement): HTMLElement[] {
  return [...table.querySelectorAll<HTMLElement>("button, input, textarea, select, [role=switch], [role=combobox]")].filter((control) => {
    const id = control.dataset.testid ?? "";
    return !/^past-class-\d+$/.test(id) && !/^class-mark-/.test(id) && !/^class-attributes-/.test(id);
  });
}

/** Put the open class dialog away without keeping anything typed in it. */
export async function cancelSheet(): Promise<void> {
  if (screen.queryByTestId("class-sheet") === null) return;
  await userEvent.click(screen.getByTestId("class-dialog-cancel"));
  await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
}

/** Add a class: name it in the dialog `Add class` opens, and add it to the draft. */
export async function addNamedClass(name: string, slot = CLASSES.length): Promise<void> {
  await userEvent.click(screen.getByTestId("add-class"));
  await userEvent.type(screen.getByTestId(`class-name-${slot}`), name);
  await closeSheet();
}

