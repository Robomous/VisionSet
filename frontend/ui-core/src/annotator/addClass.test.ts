/**
 * The add-a-class chain, which is a test about **order**.
 *
 * `Workspace` builds the annotator store in a `useMemo` keyed on the schema, so
 * the refetch that follows a re-pin rebuilds it — discarding unsaved edits. Publish
 * before saving and the user's last few boxes are gone with a success toast on
 * screen: no error, no refusal, no way to tell from the outside. That is exactly
 * the kind of defect a rendering test does not see, so this one asserts the
 * sequence directly and fails if it flips.
 */

import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, useState, type ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { AddClassDialog, composeVersion, defaultNote, runAddClass } from "./AddClassDialog";
import {
  useDiscardSchemaDraft,
  usePublishSchemaDraft,
  useSaveSchemaDraft,
  useSchemaDraft,
  type LabelClassBody,
  type SchemaVersion,
} from "../screens/queries";

const SIGN: LabelClassBody = { name: "sign", geometries: ["bbox"], color: null, attributes: [] };
const LANE: LabelClassBody = { name: "lane", geometries: ["polygon"], color: null, attributes: [] };
const NEW: LabelClassBody = { name: "crossing", geometries: ["bbox"], color: "#eb5a47", attributes: [] };

/** Two recorders writing into one list, so the order is a single assertion. */
function recorders(overrides: Partial<Record<"save" | "publish", () => Promise<never>>> = {}) {
  const order: string[] = [];
  const published: { classes: readonly LabelClassBody[]; note: string }[] = [];
  return {
    order,
    published,
    steps: {
      save: async () => {
        order.push("save");
        if (overrides.save) return overrides.save();
      },
      publish: async (classes: readonly LabelClassBody[], note: string) => {
        order.push("publish");
        published.push({ classes, note });
        if (overrides.publish) return overrides.publish();
      },
    },
  };
}

describe("the order the two calls run in", () => {
  it("saves before it publishes", async () => {
    const { order, steps } = recorders();

    await runAddClass({ ...steps, activeClasses: [SIGN], added: [NEW], note: "why" });

    // Flip the two lines in `runAddClass` and this fails: the publish is followed
    // by a refetch that rebuilds the store, so publishing first loses the work.
    //
    // There was a third step, `repin`, and #381 moved it into the kernel: the
    // publish now advances every open batch in its own transaction, so the
    // ordering question that step raised no longer exists here.
    expect(order).toEqual(["save", "publish"]);
  });

  it("composes on the active version's classes, plus the new one, in that order", async () => {
    const { published, steps } = recorders();

    await runAddClass({ ...steps, activeClasses: [SIGN, LANE], added: [NEW], note: "why" });

    // Composed on the **active** classes and never on the batch's pin: a pin that
    // is behind would drop every class published since, which is a destructive
    // change nobody asked for — and `create_version` takes the whole contract, so
    // a class omitted is a class removed.
    expect(published[0]?.classes).toEqual([SIGN, LANE, NEW]);
    expect(published[0]?.note).toBe("why");
  });

  it("never publishes when the save refused", async () => {
    // The save cannot be refused on this path — the pending work is valid under
    // the old schema and the change is additive — but if it ever is, publishing a
    // version after losing the work is the worst possible order of events.
    const { order, steps } = recorders({
      save: () => Promise.reject(new Error("save refused")),
    });

    await expect(
      runAddClass({ ...steps, activeClasses: [SIGN], added: [NEW], note: "why" }),
    ).rejects.toThrow("save refused");
    expect(order).toEqual(["save"]);
  });

  it("stops at a refused publish, with the edits already saved", async () => {
    // The remaining half-applied state, and it is the harmless one: the work is
    // on disk and no version exists. **The row that used to be here is gone** —
    // "the version exists and the pin has not moved" was finding F23, and it is
    // now unrepresentable rather than tested, because the publish and the pin
    // move in one kernel transaction.
    const { order, steps } = recorders({
      publish: () => Promise.reject(new Error("version conflict")),
    });

    await expect(
      runAddClass({ ...steps, activeClasses: [SIGN], added: [NEW], note: "why" }),
    ).rejects.toThrow("version conflict");
    expect(order).toEqual(["save", "publish"]);
  });

  it("does not touch the caller's class list", async () => {
    const active: LabelClassBody[] = [SIGN];
    const { steps } = recorders();

    await runAddClass({ ...steps, activeClasses: active, added: [NEW], note: "why" });

    expect(active).toEqual([SIGN]);
  });
});

describe("the version description it fills in", () => {
  it("names the class, so a history entry is readable without opening the diff", () => {
    expect(defaultNote(["crossing"])).toBe(
      'Added class "crossing" from the annotation view',
    );
  });

  it("quotes the name, so one containing a quote cannot break the sentence", () => {
    // `JSON.stringify` rather than template quotes: a class called `zebra "x"` is
    // legal — `normalize_name` only refuses a blank — and would otherwise produce
    // a description that reads as truncated.
    expect(defaultNote(['zebra "x"'])).toContain('"zebra \\"x\\""');
  });

  it("names every class of a session, because one press is one version", () => {
    // The `Why` column of the ledger is the only place a reader learns what a
    // version did without opening the diff, and a session's version did three
    // things. Naming only the last would make that column a lie about the others.
    expect(defaultNote(["cone", "barrier", "crossing"])).toBe(
      'Added classes "cone", "barrier" and "crossing" from the annotation view',
    );
  });

  it("says classes, not class, the moment there are two", () => {
    expect(defaultNote(["cone", "barrier"])).toBe(
      'Added classes "cone" and "barrier" from the annotation view',
    );
  });

  it("stays a readable sentence before anything has been typed", () => {
    // The dialog renders this into the note field from the first paint, so the
    // empty case is on screen more often than any other.
    expect(defaultNote([])).toBe('Added class "…" from the annotation view');
  });
});

/**
 * A session is one publish, and that is the whole of WS4's first deliverable.
 *
 * The saving is not the request — `create_version` takes the whole contract
 * either way — it is the **two re-pins and two refetches that do not happen**,
 * each of which rebuilds the annotator's store, and the two extra rows a version
 * history would otherwise have to collapse.
 */
describe("a session of several classes", () => {
  it("publishes them as one version, in the order they were written", async () => {
    const { order, published, steps } = recorders();

    await runAddClass({
      ...steps,
      activeClasses: [SIGN],
      added: [NEW, LANE],
      note: "the survey needs both",
    });

    expect(published).toHaveLength(1);
    expect(published[0]?.classes).toEqual([SIGN, NEW, LANE]);
    // One of each, not one per class: three of these would be three chances for
    // the middle one to refuse, and a half-published session with no way back.
    expect(order).toEqual(["save", "publish"]);
  });
});

describe("what the chain is given", () => {
  it("runs nothing at all when the caller supplies no steps it can await", async () => {
    // A guard for the shape rather than the behaviour: every step is required, so
    // a refactor that made one optional would have to change this file first.
    const save = vi.fn(async () => undefined);
    const publish = vi.fn(async () => undefined);

    await runAddClass({ save, publish, activeClasses: [], added: [NEW], note: "" });

    expect(save).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

/**
 * The step that used to be here, and why nothing replaced it.
 *
 * The chain took a third callback — re-pin the batch — and a `null` for it when
 * the batch would not take one. That was finding F23's remedy: `REPINNABLE_STATES`
 * excludes `completed`, so on a settled batch the version published and the pin
 * then refused, leaving a half-applied state the caller had to pre-empt by asking
 * `allowed_actions` first.
 *
 * #381 removed the step rather than the hazard. Publishing an additive version
 * moves every open batch in the kernel's own transaction, so there is no second
 * request to order, to refuse, or to skip — and a completed batch is simply one
 * the kernel does not move, which needs no client-side preflight to express.
 *
 * `canRepin` still reaches the dialog, because the *sentence* it drives is still
 * true: a completed batch keeps its version, and somebody publishing from inside
 * one should be told that before they press.
 */
describe("composing the version a sitting publishes", () => {
  const WIDENED: LabelClassBody = {
    name: "sign",
    geometries: ["bbox", "polygon"],
    color: null,
    attributes: [],
  };

  it("appends a class the active version does not have", () => {
    expect(composeVersion([SIGN, LANE], [NEW])).toEqual([SIGN, LANE, NEW]);
  });

  it("replaces a class of the same name rather than adding a second", () => {
    // Two classes with one name is what `create_version` refuses outright, so an
    // append here would turn the widening flow into a 422 naming nothing the user
    // did.
    expect(composeVersion([SIGN, LANE], [WIDENED])).toEqual([WIDENED, LANE]);
  });

  it("replaces in place, so the authored class order does not move", () => {
    // Not cosmetic: the class list renders in this order and the digit hotkeys
    // are positions in it, so appending the widened class would silently
    // renumber somebody's keyboard.
    expect(composeVersion([SIGN, LANE], [WIDENED]).map((one) => one.name)).toEqual([
      "sign",
      "lane",
    ]);
  });

  it("matches the name the way the API does, ignoring case", () => {
    const shouted: LabelClassBody = { ...WIDENED, name: "SIGN" };
    expect(composeVersion([SIGN, LANE], [shouted])).toEqual([shouted, LANE]);
  });

  it("does both at once, for a sitting that widens one class and adds another", () => {
    expect(composeVersion([SIGN, LANE], [WIDENED, NEW])).toEqual([WIDENED, LANE, NEW]);
  });
});

/**
 * The session, backed by the project's `annotation` schema draft.
 *
 * `addClassDialog.test.tsx` renders the dialog against plain props and never
 * sees a request; `schemaDraftServer.test.tsx` proves the four hooks against a
 * stubbed server but never renders this dialog. This is the seam between them —
 * a small harness wiring the real hooks to the real dialog, so what is asserted
 * is the request that actually leaves, not a callback's arguments.
 *
 * Publishing goes through the draft: a save immediately before, addressed at
 * the composed contract (folding in whatever this sitting typed but never
 * banked), then a publish naming only the revision that save returned — so
 * what is published can never diverge from what the draft holds. The harness
 * mirrors `AnnotationPage`'s own wiring rather than `runAddClass`'s shape
 * directly, because the claim under test is the request that leaves, and
 * `runAddClass` itself takes a `publish(classes, note)` callback and never
 * learns how that callback reaches the wire.
 */
describe("the session, backed by the project's annotation draft", () => {
  const PROJECT = "66666666-6666-4666-8666-666666666666";
  const ACTIVE = {
    project_id: PROJECT,
    version: 3,
    classes: [SIGN],
    description: null,
    created_at: null,
  } as unknown as SchemaVersion;

  type Answer = { readonly status: number; readonly body?: unknown };
  let handlers: ((request: Request) => Answer | undefined)[] = [];
  const sent: Request[] = [];

  beforeEach(() => {
    handlers = [];
    sent.length = 0;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      sent.push(request);
      for (const handler of handlers) {
        const answer = handler(request);
        if (answer !== undefined) {
          return Promise.resolve(
            new Response(answer.status === 204 ? null : JSON.stringify(answer.body ?? null), {
              status: answer.status,
              headers: { "content-type": "application/json" },
            }),
          );
        }
      }
      return Promise.resolve(
        new Response(JSON.stringify({ code: "NO_STUB", message: request.url }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      );
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  function on(method: string, pattern: RegExp, answer: Answer): void {
    handlers.push((request) =>
      request.method === method && pattern.test(new URL(request.url).pathname) ? answer : undefined,
    );
  }

  function findSent(method: string, pattern: RegExp): Request | undefined {
    return sent.find((request) => request.method === method && pattern.test(new URL(request.url).pathname));
  }

  /** A blank annotation draft — the ordinary case, before anything is banked. */
  function noDraft(): void {
    on("GET", /\/schema\/drafts\/annotation$/, {
      status: 404,
      body: { code: "SCHEMA_DRAFT_NOT_FOUND", message: "no draft yet" },
    });
  }

  /**
   * The dialog wired the way `AnnotationPage` wires it: `useSchemaDraft` seeds
   * and announces, `useSaveSchemaDraft` write-throughs a bank, and confirming
   * flushes the composed contract to the draft before publishing it through
   * `usePublishSchemaDraft` — the same two-call shape `addClass` uses.
   */
  function harness(options: { readonly startOpen?: boolean } = {}): ReactNode {
    function Harness(): ReactNode {
      const [open, setOpen] = useState(options.startOpen ?? true);
      // Gated exactly the way `Workspace` gates it: only while the dialog is
      // open, so a mount that never opens the dialog makes no request. See
      // `"the gate"` below for the assertion that pins this.
      const draft = useSchemaDraft(PROJECT, "annotation", open);
      const saveDraft = useSaveSchemaDraft(PROJECT, "annotation");
      const discardDraft = useDiscardSchemaDraft(PROJECT, "annotation");
      const publishDraft = usePublishSchemaDraft(PROJECT, "annotation");

      return createElement(
        "div",
        null,
        createElement(
          "button",
          { type: "button", "data-testid": "open-dialog", onClick: () => setOpen(true) },
          "open",
        ),
        createElement(AddClassDialog, {
          open,
          onOpenChange: setOpen,
          active: ACTIVE,
          pinnedVersion: ACTIVE.version,
          canRepin: true,
          // The same composite `AnnotationPage` builds, `discardDraft`
          // included — Finding 2's own fix: while a discard is in flight,
          // banking and the discard buttons must both be unusable, or a bank
          // races the unconditional `DELETE`.
          pending:
            saveDraft.isPending || publishDraft.isPending || discardDraft.isPending,
          error: saveDraft.error ?? publishDraft.error ?? discardDraft.error ?? null,
          serverDraft: draft.data ?? null,
          draftPending: draft.isPending,
          onBank: (classes: readonly LabelClassBody[]) =>
            saveDraft.mutate({
              classes: classes.map((entry) => ({ ...entry })),
              note: "",
              basedOn: ACTIVE.version,
              revision: draft.data?.revision ?? null,
            }),
          // `mutateAsync`, matching `AnnotationPage`'s own wiring — the
          // dialog holds its local "it is gone" state until this settles.
          onDiscardDraft: () => discardDraft.mutateAsync(),
          onSubmit: async (added: readonly LabelClassBody[], note: string) => {
            const written = await saveDraft.mutateAsync({
              classes: composeVersion(ACTIVE.classes, added),
              note,
              basedOn: ACTIVE.version,
              revision: draft.data?.revision ?? null,
            });
            await publishDraft.mutateAsync({ revision: written.revision });
          },
        }),
      );
    }

    return createElement(ApiProvider, {
      baseUrl: "http://visionset.test",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      children: createElement(Harness),
    });
  }

  it("banks an added class to the annotation draft, not only to component state", async () => {
    noDraft();
    on("PUT", /\/schema\/drafts\/annotation$/, {
      status: 200,
      body: {
        project_id: PROJECT,
        kind: "annotation",
        classes: [],
        note: "",
        based_on: 3,
        revision: 1,
        updated_at: "2026-08-16T00:00:00Z",
      },
    });

    render(harness());
    await screen.findByTestId("add-class-dialog");

    await userEvent.type(screen.getByTestId("class-name-new"), "crossing");
    await userEvent.click(screen.getByTestId("add-another"));

    await waitFor(() => {
      expect(findSent("PUT", /\/schema\/drafts\/annotation$/)).toBeDefined();
    });
    // Not merely a request — the one class this press banked, on the wire.
    const put = findSent("PUT", /\/schema\/drafts\/annotation$/)!;
    const body = JSON.parse(await put.clone().text()) as { classes: { name: string }[] };
    expect(body.classes.map((entry) => entry.name)).toEqual(["crossing"]);
  });

  it("says so when a previous session left classes pending", async () => {
    on("GET", /\/schema\/drafts\/annotation$/, {
      status: 200,
      body: {
        project_id: PROJECT,
        kind: "annotation",
        classes: [
          { name: "cone", geometries: ["bbox"], color: null, attributes: [] },
          { name: "barrier", geometries: ["bbox"], color: null, attributes: [] },
        ],
        note: "",
        based_on: 3,
        revision: 4,
        updated_at: "2026-08-16T00:00:00Z",
      },
    });

    render(harness());

    // Silently resuming would publish classes nobody at this keyboard typed —
    // this is the one place that cannot happen quietly.
    const banner = await screen.findByTestId("resumed-draft");
    expect(banner.textContent).toContain("cone");
    expect(banner.textContent).toContain("barrier");
  });

  it("publishes the annotation draft and leaves the curated one alone", async () => {
    noDraft();
    // A trap: nothing in this flow has any business reading the editor's own
    // draft, and this is what would catch it if a future change blurred the
    // two kinds back together.
    on("GET", /\/schema\/drafts\/curated$/, {
      status: 200,
      body: {
        project_id: PROJECT,
        kind: "curated",
        classes: [{ name: "lane", geometries: ["polygon"], color: null, attributes: [] }],
        note: "midway through a redesign",
        based_on: 3,
        revision: 7,
        updated_at: "2026-08-16T00:00:00Z",
      },
    });
    // The flush immediately before Confirm's publish.
    on("PUT", /\/schema\/drafts\/annotation$/, {
      status: 200,
      body: {
        project_id: PROJECT,
        kind: "annotation",
        classes: [SIGN, NEW],
        note: 'Added class "crossing" from the annotation view',
        based_on: 3,
        revision: 1,
        updated_at: "2026-08-16T00:00:00Z",
      },
    });
    on("POST", /\/schema\/drafts\/annotation\/publish$/, {
      status: 200,
      body: {
        published: { ...ACTIVE, version: 4, classes: [SIGN, NEW] },
        advanced_batches: [],
      },
    });

    render(harness());
    await screen.findByTestId("add-class-dialog");

    await userEvent.type(screen.getByTestId("class-name-new"), "crossing");
    await userEvent.click(screen.getByTestId("add-class-submit"));

    await waitFor(() => {
      expect(findSent("POST", /\/schema\/drafts\/annotation\/publish$/)).toBeDefined();
    });
    expect(sent.some((request) => /\/schema\/drafts\/curated/.test(new URL(request.url).pathname))).toBe(
      false,
    );
  });

  it("discards the stored draft when cancel is confirmed", async () => {
    noDraft();
    on("PUT", /\/schema\/drafts\/annotation$/, {
      status: 200,
      body: {
        project_id: PROJECT,
        kind: "annotation",
        classes: [{ name: "cone", geometries: ["bbox"], color: null, attributes: [] }],
        note: "",
        based_on: 3,
        revision: 1,
        updated_at: "2026-08-16T00:00:00Z",
      },
    });
    on("DELETE", /\/schema\/drafts\/annotation$/, { status: 204 });

    render(harness());
    await screen.findByTestId("add-class-dialog");

    await userEvent.type(screen.getByTestId("class-name-new"), "cone");
    await userEvent.click(screen.getByTestId("add-another"));
    await userEvent.click(screen.getByTestId("add-class-cancel"));
    await userEvent.click(screen.getByTestId("discard-confirm"));

    await waitFor(() => {
      expect(findSent("DELETE", /\/schema\/drafts\/annotation$/)).toBeDefined();
    });
  });

  /**
   * The gate — `useSchemaDraft`'s own `enabled` parameter, wired the way
   * `activeSchema` already is. A mount that read this on every job open would
   * be a request the annotator has no business making until the dialog is
   * actually open; `annotate.spec.ts:433`'s e2e sibling covers the same
   * discipline for `useActiveSchema` and does not reach this endpoint.
   */
  it("reads the annotation draft only while the dialog is open", async () => {
    noDraft();

    render(harness({ startOpen: false }));

    // Given a moment for a stray request to have shown up, if one were going to.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(findSent("GET", /\/schema\/drafts\/annotation$/)).toBeUndefined();

    await userEvent.click(screen.getByTestId("open-dialog"));

    await waitFor(() => {
      expect(findSent("GET", /\/schema\/drafts\/annotation$/)).toBeDefined();
    });
  });

  /**
   * A refused discard, from the resumed-draft banner's own button.
   *
   * Clearing the session first and unconditionally is what let a refused
   * `DELETE` tell somebody the shared draft was gone when it was not — they
   * would meet the same classes again the next time this opened, having been
   * told they were discarded. Nothing here is swallowed: the classes stay
   * banked, the banner stays up, and the refusal renders.
   */
  it("keeps the pending classes and shows the refusal when a discard fails", async () => {
    on("GET", /\/schema\/drafts\/annotation$/, {
      status: 200,
      body: {
        project_id: PROJECT,
        kind: "annotation",
        classes: [{ name: "cone", geometries: ["bbox"], color: null, attributes: [] }],
        note: "",
        based_on: 3,
        revision: 4,
        updated_at: "2026-08-16T00:00:00Z",
      },
    });
    on("DELETE", /\/schema\/drafts\/annotation$/, {
      status: 500,
      body: { code: "INTERNAL_ERROR", message: "the draft could not be discarded" },
    });

    render(harness());
    await screen.findByTestId("resumed-draft");

    await userEvent.click(screen.getByTestId("discard-resumed"));

    await screen.findByTestId("add-class-error");
    // Still here — nothing was actually thrown away.
    expect(screen.getByTestId("resumed-draft")).toBeTruthy();
    expect(screen.getByTestId("session-class-cone")).toBeTruthy();
  });

  /**
   * The same failure, from Cancel's confirm — the path that used to close the
   * dialog the instant the `DELETE` was *sent*, regardless of what it
   * answered. The close is held until it resolves; on a refusal, the dialog
   * stays exactly where it was, still asking, with the refusal on screen.
   */
  it("keeps the dialog open on Cancel's confirm when the discard fails", async () => {
    noDraft();
    on("PUT", /\/schema\/drafts\/annotation$/, {
      status: 200,
      body: {
        project_id: PROJECT,
        kind: "annotation",
        classes: [{ name: "cone", geometries: ["bbox"], color: null, attributes: [] }],
        note: "",
        based_on: 3,
        revision: 1,
        updated_at: "2026-08-16T00:00:00Z",
      },
    });
    on("DELETE", /\/schema\/drafts\/annotation$/, {
      status: 500,
      body: { code: "INTERNAL_ERROR", message: "the draft could not be discarded" },
    });

    render(harness());
    await screen.findByTestId("add-class-dialog");

    await userEvent.type(screen.getByTestId("class-name-new"), "cone");
    await userEvent.click(screen.getByTestId("add-another"));
    await userEvent.click(screen.getByTestId("add-class-cancel"));
    await userEvent.click(screen.getByTestId("discard-confirm"));

    await screen.findByTestId("add-class-error");
    // The dialog never closed, and the ask is still the screen showing.
    expect(screen.getByTestId("add-class-dialog")).toBeTruthy();
    expect(screen.getByTestId("discard-session")).toBeTruthy();
  });

  /**
   * The race Finding 2 named: a discard fires, and before its `DELETE`
   * resolves the person types and banks a new class. An unconditional delete
   * is cheaper than a validating upsert, so the server could easily take the
   * bank's `PUT` first and the `DELETE` second — deleting the class this
   * press just banked, with nothing left to say so.
   *
   * `⌘Enter` is the route that matters: it calls `addAnother` directly from
   * `onKeyDown`, walking straight past the button's own `disabled` attribute,
   * so only a check inside `addAnother` itself closes this.
   */
  it("blocks a bank from racing a discard still in flight", async () => {
    let releaseDelete: (() => void) | undefined;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });

    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      sent.push(request);
      const path = new URL(request.url).pathname;

      if (request.method === "GET" && /\/schema\/drafts\/annotation$/.test(path)) {
        return new Response(
          JSON.stringify({
            project_id: PROJECT,
            kind: "annotation",
            classes: [{ name: "cone", geometries: ["bbox"], color: null, attributes: [] }],
            note: "",
            based_on: 3,
            revision: 4,
            updated_at: "2026-08-16T00:00:00Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (request.method === "DELETE" && /\/schema\/drafts\/annotation$/.test(path)) {
        // Held open deliberately — this is the window a racing bank has to
        // land in, if it is going to.
        await deleteGate;
        return new Response(null, { status: 204 });
      }
      if (request.method === "PUT" && /\/schema\/drafts\/annotation$/.test(path)) {
        return new Response(
          JSON.stringify({
            project_id: PROJECT,
            kind: "annotation",
            classes: [{ name: "barrier", geometries: ["bbox"], color: null, attributes: [] }],
            note: "",
            based_on: 3,
            revision: 5,
            updated_at: "2026-08-16T00:00:00Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ code: "NO_STUB", message: request.url }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    });

    render(harness());
    await screen.findByTestId("resumed-draft");

    await userEvent.click(screen.getByTestId("discard-resumed"));
    await waitFor(() => {
      expect(findSent("DELETE", /\/schema\/drafts\/annotation$/)).toBeDefined();
    });

    await userEvent.type(screen.getByTestId("class-name-new"), "barrier");
    await userEvent.click(screen.getByTestId("add-another"));
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");

    expect(findSent("PUT", /\/schema\/drafts\/annotation$/)).toBeUndefined();

    releaseDelete?.();
    await waitFor(() => {
      expect(screen.queryByTestId("resumed-draft")).toBeNull();
    });
    // Cleared on the discard that actually landed, not on the blocked bank.
    expect(findSent("PUT", /\/schema\/drafts\/annotation$/)).toBeUndefined();
  });
});
