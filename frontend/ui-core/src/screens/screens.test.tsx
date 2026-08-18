/**
 * The project screens, driven against a stubbed `fetch`.
 *
 * The acceptance criteria are "component tests for the editor's edit/validate/save
 * flow" and "version history renders and past versions are read-only". Both are
 * below, and so is the thing the editor actually exists to get right: **the two
 * 409s, and the fact that only one of them may be retried.**
 *
 * That last one cannot be checked any other way. It is not a rendering question
 * and not a request-shape question — it is whether the screen branches on the
 * error `code` or on the status, and a screen that branches on the status looks
 * completely correct until somebody meets `SCHEMA_CHANGE_WOULD_ORPHAN` and is
 * offered a button that will never work.
 */

import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type JSX, type ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { classColor, hexColor } from "../palette";
import { writeToken } from "../data/session";
import { ProjectScreen } from "./ProjectScreen";
import { ProjectsScreen } from "./ProjectsScreen";
import {
  usePreviewSchemaChange,
  type LabelClassBody,
  type SchemaChangePreview,
} from "./queries";
import { batchActions } from "../testing/wire.fixtures.js";
import type { components as capComponents } from "../generated/api.js";

type BatchState = capComponents["schemas"]["BatchState"];

/** See `dataShell.test.tsx`: undici's `Request` needs an absolute URL. */
const API = "http://visionset.test";
const PROJECT = "11111111-1111-4111-8111-111111111111";

/** One route table, matched in order. A miss is a loud 500 rather than a hang. */
type HandlerAnswer = { status: number; body: unknown } | undefined;
type Handler = (request: Request) => HandlerAnswer | Promise<HandlerAnswer>;

let handlers: Handler[] = [];
const sent: Request[] = [];
/**
 * What each request carried, captured before the client consumes it.
 *
 * Cloned rather than read later: a `Request` body is a one-shot stream, so a test
 * asking for it after the fact gets nothing. The colour-input claim needs it —
 * is about the payload a save actually sends, not about what the control shows.
 */
const bodies = new Map<Request, string>();

/**
 * A minimal stand-in for `SchemaDraftService`, keyed by project id — the schema
 * editor now writes the shared draft before every publish, so `save-schema`
 * needs a `PUT .../schema/drafts/{kind}` that actually answers rather than the
 * loud 500 an unmatched route gets everywhere else in this file. No test here
 * exercises `STALE_WRITE` — that belongs to `schemaDraft.test.tsx`, which owns
 * the fuller simulation — so this one only ever creates and re-saves.
 */
let curatedDrafts: Map<
  string,
  { project_id: string; kind: string; classes: unknown[]; note: string; based_on: number | null; revision: number; updated_at: string }
>;

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

beforeEach(() => {
  handlers = [];
  sent.length = 0;
  bodies.clear();
  curatedDrafts = new Map();
  writeToken("a-token");
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

function on(method: string, pattern: RegExp, answer: { status: number; body?: unknown }): void {
  handlers.push((request) =>
    request.method === method && pattern.test(new URL(request.url).pathname + new URL(request.url).search)
      ? { status: answer.status, body: answer.body ?? null }
      : undefined,
  );
}

function mount(node: ReactNode): JSX.Element {
  return (
    <ApiProvider
      baseUrl={API}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {node}
    </ApiProvider>
  );
}

const CLASSES = [
  { name: "vehicle", geometries: ["bbox"], color: "#38bdf8", attributes: [] },
  { name: "lane", geometries: ["polygon"], color: null, attributes: [] },
];

function PreviewSchemaChangeProbe({
  projectId,
  classes,
}: {
  readonly projectId: string;
  readonly classes: readonly LabelClassBody[];
}): JSX.Element {
  const preview = usePreviewSchemaChange(projectId);
  const [result, setResult] = useState<SchemaChangePreview | null>(null);

  return (
    <div>
      <button
        data-testid="preview-schema-change"
        onClick={() => {
          void preview.mutateAsync({ classes }).then(setResult);
        }}
      >
        preview
      </button>
      {result === null ? null : (
        <p data-testid="preview-result">
          {`${result.diff.destructive_classes.join(",")}:${result.blockers[0]?.annotations}:${result.blockers[0]?.assets}:${result.is_refused}`}
        </p>
      )}
    </div>
  );
}

describe("the project list", () => {
  it("lists projects and opens one through the callback, never a router", async () => {
    on("GET", /^\/projects$/, {
      status: 200,
      body: { items: [{ id: PROJECT, name: "highway", description: "M4 survey" }], total: 1 },
    });
    const opened = vi.fn();

    render(mount(<ProjectsScreen onOpenProject={opened} />));

    await waitFor(() => expect(screen.queryByTestId("projects-table")).not.toBeNull());
    await userEvent.click(screen.getByTestId("open-highway"));
    // The screen navigates by asking, which is what keeps `ui-core` free of a
    // router it would then only work inside.
    expect(opened).toHaveBeenCalledWith(PROJECT);
  });

  it("shows the empty state rather than an empty table", async () => {
    on("GET", /^\/projects$/, { status: 200, body: { items: [], total: 0 } });
    render(mount(<ProjectsScreen onOpenProject={vi.fn()} />));
    await waitFor(() => expect(screen.queryByText("No projects yet")).not.toBeNull());
    expect(screen.queryByTestId("projects-table")).toBeNull();
  });

  it("lands inside the project it just created, not back on the list", async () => {
    on("GET", /^\/projects$/, { status: 200, body: { items: [], total: 0 } });
    on("POST", /^\/projects$/, {
      status: 201,
      body: { id: PROJECT, name: "highway", description: null },
    });
    const opened = vi.fn();

    render(mount(<ProjectsScreen onOpenProject={opened} />));
    await userEvent.click(await screen.findByTestId("new-project"));
    await userEvent.type(screen.getByTestId("project-name"), "highway");
    await userEvent.click(screen.getByTestId("create-submit"));

    // Every project is created in order to do something with it, so the list is
    // never the destination. The id comes back on the 201 — nothing is fetched
    // to find it — and it travels out through the callback the row already uses,
    // which is what keeps the routing in the app.
    await waitFor(() => expect(opened).toHaveBeenCalledWith(PROJECT));
    expect(screen.queryByTestId("create-project-dialog")).toBeNull();
  });

  it("renders a refusal with its code, because that is what a client branches on", async () => {
    on("GET", /^\/projects$/, { status: 200, body: { items: [], total: 0 } });
    on("POST", /^\/projects$/, {
      status: 409,
      body: { code: "PROJECT_NAME_TAKEN", message: "A project called highway already exists." },
    });
    const opened = vi.fn();

    render(mount(<ProjectsScreen onOpenProject={opened} />));
    await userEvent.click(await screen.findByTestId("new-project"));
    await userEvent.type(screen.getByTestId("project-name"), "highway");
    await userEvent.click(screen.getByTestId("create-submit"));

    const error = await screen.findByTestId("create-error");
    expect(error.textContent).toContain("PROJECT_NAME_TAKEN");
    expect(error.textContent).toContain("already exists");
    // The failure path is untouched: the dialog stays open with what was
    // typed still in it, and nothing navigates anywhere.
    expect(screen.queryByTestId("create-project-dialog")).not.toBeNull();
    expect(screen.getByTestId("project-name")).toHaveProperty("value", "highway");
    expect(opened).not.toHaveBeenCalled();
  });

  it("sends confirm=true on a delete, because the API will not act without it", async () => {
    on("GET", /^\/projects$/, {
      status: 200,
      body: { items: [{ id: PROJECT, name: "highway", description: null }], total: 1 },
    });
    on("DELETE", /^\/projects\//, { status: 204 });

    render(mount(<ProjectsScreen onOpenProject={vi.fn()} />));
    await userEvent.click(await screen.findByTestId("delete-highway"));
    await userEvent.click(screen.getByTestId("delete-submit"));

    await waitFor(() => expect(sent.some((r) => r.method === "DELETE")).toBe(true));
    const request = sent.find((r) => r.method === "DELETE");
    // The dialog is the *user's* confirmation; this parameter is the API's. Both
    // are doing something, which is why neither replaced the other.
    expect(new URL(request?.url ?? "").searchParams.get("confirm")).toBe("true");
  });
});

describe("the schema editor", () => {
  function projectWithSchema(): void {
    on("GET", /^\/projects\/[^/]+$/, {
      status: 200,
      body: { id: PROJECT, name: "highway", description: null },
    });
    on("GET", /^\/projects\/[^/]+\/schema$/, {
      status: 200,
      body: { project_id: PROJECT, version: 3, classes: CLASSES },
    });
    on("GET", /schema\/versions$/, {
      status: 200,
      body: {
        items: [
          { project_id: PROJECT, version: 1, classes: [CLASSES[0]] },
          { project_id: PROJECT, version: 2, classes: CLASSES },
          { project_id: PROJECT, version: 3, classes: CLASSES },
        ],
        total: 3,
      },
    });
  }

  /** Open one class's detail panel. Only the selected class has one. */
  async function selectClass(index: number): Promise<void> {
    await userEvent.click(screen.getByTestId("class-list").querySelectorAll("button")[index]);
  }

  async function removeClass(index: number): Promise<void> {
    await selectClass(index);
    await userEvent.click(screen.getByTestId(`remove-class-${index}`));
    await waitFor(() =>
      expect(screen.getByTestId("class-list").querySelectorAll("button")).toHaveLength(
        CLASSES.length - 1,
      ),
    );
  }

  it("previews a candidate without lane and reads its orphan blockers", async () => {
    const candidate: readonly LabelClassBody[] = [
      { name: "vehicle", geometries: ["bbox"], color: "#38bdf8", attributes: [] },
    ];
    on("POST", /\/schema\/preview$/, {
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [{ label_class: "lane", annotations: 12, assets: 3 }],
        is_refused: true,
      },
    });

    render(mount(<PreviewSchemaChangeProbe projectId={PROJECT} classes={candidate} />));
    await userEvent.click(screen.getByTestId("preview-schema-change"));

    await waitFor(() =>
      expect(screen.getByTestId("preview-result").textContent).toBe("lane:12:3:true"),
    );
    const request = sent.find(
      (sentRequest) =>
        sentRequest.method === "POST" && new URL(sentRequest.url).pathname.endsWith("/schema/preview"),
    );
    if (request === undefined) throw new Error("Expected a schema preview request");
    expect(JSON.parse(bodies.get(request) ?? "")).toEqual({ classes: candidate });
    expect(
      sent.some(
        (sentRequest) =>
          sentRequest.method === "POST" &&
          new URL(sentRequest.url).pathname.endsWith("/schema/drafts/curated/publish"),
      ),
    ).toBe(false);
  });

  it("treats a schema-less project as an empty draft, not as an error", async () => {
    on("GET", /^\/projects\/[^/]+$/, {
      status: 200,
      body: { id: PROJECT, name: "fresh", description: null },
    });
    // A project starts schema-less on purpose. This 404 is the normal state
    // of a project three seconds old, and an error surface here would tell a new
    // user their project is broken.
    on("GET", /^\/projects\/[^/]+\/schema$/, {
      status: 404,
      body: { code: "SCHEMA_NOT_FOUND", message: "This project has no schema version yet." },
    });
    on("GET", /schema\/versions$/, { status: 200, body: { items: [], total: 0 } });

    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));

    await waitFor(() => expect(screen.queryByTestId("schema-editor")).not.toBeNull());
    expect(screen.queryByTestId("schema-error")).toBeNull();
    expect(screen.getByTestId("schema-status").textContent).toContain("Saving creates version 1");
  });

  it("edits a draft and publishes it as the next version", async () => {
    projectWithSchema();
    on("POST", /schema\/drafts\/curated\/publish$/, {
      status: 201,
      body: { published: { project_id: PROJECT, version: 4, classes: CLASSES }, advanced_batches: [] },
    });

    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    // Versioning is ambient: one persistent line saying what saving would
    // do, rather than a disabled button somebody has to press to find out.
    expect(screen.getByTestId("schema-status").textContent).toContain("Version 3 active");
    expect(screen.getByTestId("schema-status").textContent).toContain("v4");

    // Nothing has changed, and the button is **enabled anyway** — it answers
    // rather than sitting grey. Nothing is sent.
    expect(screen.getByTestId("save-schema")).toHaveProperty("disabled", false);
    await userEvent.click(screen.getByTestId("save-schema"));
    expect(sent.some((r) => r.method === "POST")).toBe(false);

    await userEvent.click(screen.getByTestId("add-class"));
    // …and a nameless class is refused the same way, not by a grey button.
    // `normalize_name` refuses a blank, so this mirrors the API's rule.
    await userEvent.click(screen.getByTestId("save-schema"));
    expect(sent.some((r) => r.method === "POST")).toBe(false);

    await userEvent.type(screen.getByTestId("class-name-2"), "pedestrian");
    expect(screen.getByTestId("schema-status").textContent).toContain("unsaved changes");
    await userEvent.click(screen.getByTestId("save-schema"));

    await waitFor(() =>
      expect(
        sent.some(
          (request) =>
            request.method === "POST" &&
            new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish"),
        ),
      ).toBe(true),
    );
    const request = sent.find(
      (request) =>
        request.method === "POST" &&
        new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish"),
    );
    expect(request).toBeDefined();
    // The plain save carries no gate — `allow_destructive` is only ever sent
    // after the API has said it is needed.
    expect(new URL(request?.url ?? "").searchParams.get("allow_destructive")).toBeNull();
  });

  it("locks draft mutations until a deferred publish settles", async () => {
    projectWithSchema();
    let resolvePublish: ((answer: Exclude<HandlerAnswer, undefined>) => void) | undefined;
    handlers.push((request) => {
      if (
        request.method !== "POST" ||
        !new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish")
      ) {
        return undefined;
      }
      return new Promise((resolve) => {
        resolvePublish = resolve;
      });
    });

    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(screen.getByTestId("class-name-2"), "pedestrian");
    await userEvent.click(screen.getByTestId("save-schema"));
    await waitFor(() => expect(resolvePublish).toBeDefined());

    const className = screen.getByTestId("class-name-2");
    expect(className).toHaveProperty("disabled", true);
    expect(screen.getByTestId("version-note")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("add-class")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("remove-class-2")).toHaveProperty("disabled", true);
    await userEvent.type(className, "-newer");
    expect(className).toHaveProperty("value", "pedestrian");

    if (resolvePublish === undefined) throw new Error("Expected the deferred publish request");
    resolvePublish({
      status: 201,
      body: {
        published: {
          project_id: PROJECT,
          version: 4,
          classes: [...CLASSES, { name: "pedestrian", geometries: ["bbox"], color: null, attributes: [] }],
        },
        advanced_batches: [],
      },
    });
    await waitFor(() => expect(screen.getByTestId("save-schema")).toHaveProperty("disabled", false));
    expect(screen.getByTestId("class-name-2")).toHaveProperty("value", "pedestrian");
  });

  it("previews a publishable narrowing before one flagged publish", async () => {
    projectWithSchema();
    on("POST", /schema\/preview$/, {
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [],
        is_refused: false,
      },
    });
    handlers.push((request) => {
      if (
        request.method !== "POST" ||
        !new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish")
      ) {
        return undefined;
      }
      const allowed = new URL(request.url).searchParams.get("allow_destructive") === "true";
      return allowed
        ? {
            status: 201,
            body: {
              published: { project_id: PROJECT, version: 4, classes: [] },
              advanced_batches: [],
            },
          }
        : {
            status: 409,
            body: {
              code: "DESTRUCTIVE_SCHEMA_CHANGE",
              message: "internal wording must not appear",
            },
          };
    });

    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    await removeClass(1);
    await userEvent.click(screen.getByTestId("save-schema"));

    const dialog = await screen.findByTestId("destructive-dialog");
    expect(dialog.textContent).toContain("lane");
    expect(dialog.textContent).not.toContain("internal wording must not appear");
    // The blast radius, counted: DESIGN.md requires a confirmation to name what
    // it costs. `blockers` is empty on every preview that reaches this dialog,
    // so the zero is measured rather than assumed.
    expect(dialog.textContent).toContain("1 class narrows");
    expect(dialog.textContent).toContain("No annotations use what this removes");
    // The removed promise. It described what happens to annotations *after* the
    // publish, which the kernel has not decided, so the dialog stops claiming it.
    expect(dialog.textContent).not.toContain("Existing annotations are not touched");
    expect(
      sent.some(
        (request) =>
          request.method === "POST" &&
          new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish"),
      ),
    ).toBe(false);

    const allow = screen.getByTestId("allow-destructive");
    await waitFor(() => expect(allow).toHaveProperty("disabled", false));
    await userEvent.click(allow);
    await waitFor(() =>
      expect(
        sent.filter(
          (request) =>
            request.method === "POST" &&
            new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish"),
        ),
      ).toHaveLength(1),
    );
    const publishRequest = sent.find(
      (request) =>
        request.method === "POST" &&
        new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish"),
    );
    expect(new URL(publishRequest?.url ?? "").searchParams.get("allow_destructive")).toBe("true");
  });

  it("counts every narrowing class in the confirmation", async () => {
    projectWithSchema();
    handlers.push((request) => {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/schema/preview")) {
        return undefined;
      }
      return {
        status: 200,
        body: {
          is_refused: false,
          blockers: [],
          diff: {
            is_destructive: true,
            destructive_classes: ["lane", "sign"],
            changes: [
              { kind: "destructive", label_class: "lane", attribute: null, detail: "class 'lane' removed" },
              { kind: "destructive", label_class: "sign", attribute: null, detail: "class 'sign' removed" },
            ],
          },
        },
      };
    });

    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    await removeClass(1);
    await userEvent.click(screen.getByTestId("save-schema"));

    const dialog = await screen.findByTestId("destructive-dialog");
    expect(dialog.textContent).toContain("2 classes narrow");
    expect(dialog.textContent).toContain("lane");
    expect(dialog.textContent).toContain("sign");
    expect(dialog.textContent).toContain("No annotations use what this removes");
  });

  it("prevents repeated confirmation while its second preview is pending", async () => {
    projectWithSchema();
    let previews = 0;
    let resolveSecondPreview: ((answer: Exclude<HandlerAnswer, undefined>) => void) | undefined;
    handlers.push((request) => {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/schema/preview")) {
        return undefined;
      }
      previews += 1;
      if (previews === 3) {
        return new Promise((resolve) => {
          resolveSecondPreview = resolve;
        });
      }
      return {
        status: 200,
        body: {
          diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
          blockers: [],
          is_refused: false,
        },
      };
    });
    on("POST", /schema\/drafts\/curated\/publish(?:\?.*)?$/, {
      status: 201,
      body: {
        published: { project_id: PROJECT, version: 4, classes: [] },
        advanced_batches: [],
      },
    });

    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    await removeClass(1);
    await userEvent.click(screen.getByTestId("save-schema"));
    const allow = await screen.findByTestId("allow-destructive");
    await waitFor(() => expect(allow).toHaveProperty("disabled", false));
    await userEvent.click(allow);
    await waitFor(() => expect(resolveSecondPreview).toBeDefined());

    expect(allow).toHaveProperty("disabled", true);
    await userEvent.click(allow);

    if (resolveSecondPreview === undefined) throw new Error("Expected the deferred second preview");
    resolveSecondPreview({
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [],
        is_refused: false,
      },
    });
    await waitFor(() =>
      expect(
        sent.filter(
          (request) =>
            request.method === "POST" &&
            new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish"),
        ),
      ).toHaveLength(1),
    );
  });

  it("opens the terminal blocker dialog when the save-time preview refuses", async () => {
    projectWithSchema();
    let previews = 0;
    handlers.push((request) => {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/schema/preview")) {
        return undefined;
      }
      previews += 1;
      return previews === 1
        ? {
            status: 200,
            body: {
              diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
              blockers: [],
              is_refused: false,
            },
          }
        : {
            status: 200,
            body: {
              diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
              blockers: [{ label_class: "lane", annotations: 12, assets: 3 }],
              is_refused: true,
            },
          };
    });

    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    await removeClass(1);
    await userEvent.click(screen.getByTestId("save-schema"));

    const dialog = await screen.findByTestId("orphan-dialog");
    expect(dialog.textContent).toContain("12 annotations");
    expect(dialog.textContent).toContain("3 assets");
    // The missing button *is* the assertion. `SchemaChangeWouldOrphan` has no
    // override and is deliberately not a subclass of `DestructiveSchemaChange`, so
    // a "Save anyway" here would be an infinite loop with a person in it.
    expect(screen.queryByTestId("allow-destructive")).toBeNull();
    expect(screen.queryByTestId("destructive-dialog")).toBeNull();
    expect(within(dialog).getByTestId("orphan-close")).not.toBeNull();
    expect(
      sent.some(
        (request) =>
          request.method === "POST" &&
          new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish"),
      ),
    ).toBe(false);
  });

  it("uses typed publish-time orphan blockers when the preview becomes stale", async () => {
    projectWithSchema();
    on("POST", /schema\/preview$/, {
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [],
        is_refused: false,
      },
    });
    on("POST", /schema\/drafts\/curated\/publish(?:\?.*)?$/, {
      status: 409,
      body: {
        code: "SCHEMA_CHANGE_WOULD_ORPHAN",
        message: "internal wording must not appear",
        detail: { blockers: [{ label_class: "lane", annotations: 12, assets: 3 }] },
      },
    });

    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    await removeClass(1);
    await userEvent.click(screen.getByTestId("save-schema"));
    const allow = await screen.findByTestId("allow-destructive");
    await waitFor(() => expect(allow).toHaveProperty("disabled", false));
    await userEvent.click(allow);
    await waitFor(() =>
      expect(
        sent.filter(
          (request) =>
            request.method === "POST" &&
            new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish"),
        ),
      ).toHaveLength(1),
    );

    const dialog = await screen.findByTestId("orphan-dialog");
    expect(dialog.textContent).toContain("lane: 12 annotations across 3 assets");
    expect(dialog.textContent).not.toContain("internal wording must not appear");
    expect(screen.queryByTestId("allow-destructive")).toBeNull();
    expect(screen.queryByTestId("destructive-dialog")).toBeNull();
  });

  it.each([
    { shape: "absent", detail: undefined },
    { shape: "malformed", detail: { blockers: [{ label_class: "lane" }] } },
  ])(
    "clears destructive confirmation and renders prose for an orphan refusal with $shape detail",
    async ({ detail }) => {
      projectWithSchema();
      on("POST", /schema\/preview$/, {
        status: 200,
        body: {
          diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
          blockers: [],
          is_refused: false,
        },
      });
      on("POST", /schema\/drafts\/curated\/publish(?:\?.*)?$/, {
        status: 409,
        body: {
          code: "SCHEMA_CHANGE_WOULD_ORPHAN",
          message: "internal wording must not appear",
          detail,
        },
      });

      render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
      await screen.findByTestId("schema-editor");
      await removeClass(1);
      await userEvent.click(screen.getByTestId("save-schema"));
      await userEvent.click(await screen.findByTestId("allow-destructive"));

      const error = await screen.findByTestId("schema-error");
      expect(error.textContent).toContain(
        "Annotations already exist under a class this change removes.",
      );
      expect(error.textContent).not.toContain("internal wording must not appear");
      expect(screen.queryByTestId("allow-destructive")).toBeNull();
      expect(screen.queryByTestId("destructive-dialog")).toBeNull();
    },
  );

  it("offers only the geometries an annotation can carry", async () => {
    projectWithSchema();
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");

    // `polyline` is offered even where no tool draws one: the API
    // accepts it, the exporters need it, and the tool strip is where a person
    // learns there is nothing to draw with. Offering it is not offering a refusal.
    //
    // Addressed by `data-testid`, which keeps the **wire** value, while the label
    // beside it is the display word — so this asserts which geometries are on
    // offer without also asserting what they are called, which is
    // `geometryCategory.test.ts`'s job.
    for (const geometry of ["bbox", "polygon", "polyline", "classification_tag"]) {
      expect(screen.getByTestId(`class-geometry-0-${geometry}`)).toBeTruthy();
    }
    // `GeometryType` has eight members; four are refused at write time with
    // `UnsupportedGeometry`, so offering them would be offering a refusal.
    for (const geometry of ["mask", "keypoints", "cuboid_3d", "polyline_3d"]) {
      expect(screen.queryByTestId(`class-geometry-0-${geometry}`)).toBeNull();
    }
  });

  /**
   * A flat list of every name the product can address says nothing about
   * which ones belong to the work somebody is doing, and it only grows.
   *
   * The grouping is presentation and this is the surface it exists for. What is
   * asserted is the pairing — a heading, and the right members under it — because
   * a test that only counted the headings would pass with both of them empty and
   * every geometry in the wrong one.
   */
  it("groups the geometries it offers under their category", async () => {
    projectWithSchema();
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");

    // No press: the boxes are on the page, which is the point of the control
    // being a checkbox group rather than a dropdown — what a class accepts is
    // readable without opening anything.
    const basic = screen.getByTestId("geometry-category-Basic Computer Vision");
    const robotics = screen.getByTestId("geometry-category-Robotics and AD");
    // Read from the DOM rather than from the map, which is what makes this a
    // check on the rendering and not on the table.
    const membersOf = (label: HTMLElement): string[] =>
      [...(label.parentElement?.querySelectorAll("label") ?? [])].map(
        (option) => option.textContent ?? "",
      );

    // The display words, not the wire values: `classification_tag` is an
    // identifier and `tag` is what it is called.
    expect(membersOf(basic)).toEqual(["box", "polygon", "tag"]);
    expect(membersOf(robotics)).toEqual(["polyline"]);
    // Order of the sections is the map's declaration order, and it is the order
    // somebody reads down the list in.
    expect(basic.compareDocumentPosition(robotics) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /**
   * The regression pin. Grouping is a change to how options are *arranged*; if it
   * changed what selecting one does, it would have silently rewritten the schema
   * editor's only real interaction.
   */
  it("adds a geometry to a class rather than replacing the one it had", async () => {
    projectWithSchema();
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");

    const before = screen.getByTestId("class-geometry-0-bbox") as HTMLInputElement;
    expect(before.checked).toBe(true);

    // Across a group boundary deliberately: `polyline` is the only member of the
    // second category, so ticking it proves a grouped box is still a box.
    await userEvent.click(screen.getByTestId("class-geometry-0-polyline"));

    // Both, which is the whole feature — a control that replaced would leave the
    // first box clear and this would still find the second one ticked.
    expect((screen.getByTestId("class-geometry-0-bbox") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("class-geometry-0-polyline") as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it("refuses to untick the last geometry, and says why rather than greying out", async () => {
    projectWithSchema();
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");

    const only = screen.getByTestId("class-geometry-0-bbox") as HTMLInputElement;
    expect(only.checked).toBe(true);

    await userEvent.click(only);

    expect((screen.getByTestId("class-geometry-0-bbox") as HTMLInputElement).checked).toBe(true);
    // Principle 9: the control that will not move carries the reason. `title`
    // rather than the `disabled` attribute, so a keyboard still reaches it.
    expect(only.closest("label")?.getAttribute("title")).toMatch(/at least one geometry/i);
    expect(only.getAttribute("aria-disabled")).toBe("true");
  });

  /**
   * The colour control has to show the colour the class is actually drawn in.
   *
   * The swatch was bound to the **stored** colour, which is `null` for a derived
   * class, so `<input type="color">` fell back to its own default and rendered
   * grey — beside a dot showing the real teal, and against an annotator drawing
   * that same teal. One row, two colours, in the one control whose entire job is to
   * say what colour something is.
   */
  it("previews a derived class in the colour it is actually drawn in", async () => {
    projectWithSchema();
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");

    // `lane` declares no colour, so `classColor` derives one. Computed here from
    // the shipped rule rather than hardcoded, which is what makes this a check on
    // *agreement* — a change to the palette moves both sides together, and only a
    // swatch that stopped reading `classColor` fails.
    const derived = hexColor(
      classColor({ name: "lane", geometries: ["polygon"], color: null, attributes: [] }, "lane"),
    );
    expect(derived).not.toBeNull();
    // One panel at a time, so each class is asserted from its own.
    await selectClass(1);
    expect(screen.getByTestId("class-color-1")).toHaveProperty("value", derived);
    // Never the neutral, which is what it used to be for every derived class.
    expect(screen.getByTestId("class-color-1")).not.toHaveProperty("value", "#888888");

    // And a declared colour is still itself.
    await selectClass(0);
    expect(screen.getByTestId("class-color-0")).toHaveProperty("value", "#38bdf8");
  });

  it("does not turn a derived colour into a declared one just by showing it", async () => {
    // The half worth being careful about: making the
    // input *display* a colour must not make the class *declare* it. A schema
    // version that pinned today's hash output would make every derived class look
    // authored, and would change meaning if the palette rule ever moved.
    projectWithSchema();
    on("POST", /schema\/drafts\/curated\/publish$/, {
      status: 201,
      body: { published: { project_id: PROJECT, version: 4, classes: CLASSES }, advanced_batches: [] },
    });

    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    // Dirty by something that is not the colour. An untouched draft sends
    // nothing — the button answers instead of being grey, and that
    // refusal is itself the first half of the guarantee.
    await userEvent.click(screen.getByTestId("save-schema"));
    expect(sent.some((r) => r.method === "PUT")).toBe(false);
    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(screen.getByTestId("class-name-2"), "pedestrian");
    await userEvent.click(screen.getByTestId("save-schema"));

    // The classes now travel in the draft's own write, not in the publish —
    // Save flushes it before publishing, so this is the request that carries
    // what the version will actually record.
    await waitFor(() => expect(sent.some((r) => r.method === "PUT")).toBe(true));
    const request = sent.find((r) => r.method === "PUT")!;
    const body = JSON.parse(bodies.get(request) ?? "{}") as {
      classes: { name: string; color: string | null }[];
    };
    // Assert the payload, never the control: what matters is what the version
    // records.
    expect(body.classes.find((one) => one.name === "lane")?.color).toBeNull();
    expect(body.classes.find((one) => one.name === "pedestrian")?.color).toBeNull();
    expect(body.classes.find((one) => one.name === "vehicle")?.color).toBe("#38bdf8");
  });

  it("Derive clears a declared colour back to the derived one, in the swatch too", async () => {
    projectWithSchema();
    on("POST", /schema\/drafts\/curated\/publish$/, {
      status: 201,
      body: { published: { project_id: PROJECT, version: 4, classes: CLASSES }, advanced_batches: [] },
    });

    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    await userEvent.click(screen.getByTestId("clear-color-0"));

    const derived = hexColor(
      classColor({ name: "vehicle", geometries: ["bbox"], color: null, attributes: [] }, "vehicle"),
    );
    expect(screen.getByTestId("class-color-0")).toHaveProperty("value", derived);
    // The button still means something: the stored value went back to null, which
    // is what "Derive" is for.
    await userEvent.click(screen.getByTestId("save-schema"));
    // The draft's own write carries the classes now; the publish that follows
    // carries only a revision.
    await waitFor(() => expect(sent.some((r) => r.method === "PUT")).toBe(true));
    const request = sent.find((r) => r.method === "PUT")!;
    const body = JSON.parse(bodies.get(request) ?? "{}") as {
      classes: { name: string; color: string | null }[];
    };
    expect(body.classes.find((one) => one.name === "vehicle")?.color).toBeNull();
  });
});

/**
 * The sections are tabs, so what is *not* on the page is an assertion.
 *
 * The interesting one is the last: a query that lives in the section that renders
 * it is a query that follows the tab. That is what makes the split more than
 * cosmetic, and it is invisible in the rendering — only the request log shows it.
 */
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
      body: { id: PROJECT, name: "highway", description: null },
    });
    on("GET", /^\/projects\/[^/]+\/schema$/, { status: 200, body: active });
    on("GET", /schema\/versions$/, { status: 200, body: { items, total: items.length } });
  }

  function withDiff(answer: unknown): void {
    on("GET", /schema\/compare/, { status: 200, body: answer });
  }

  const NOTHING = { is_destructive: false, destructive_classes: [], changes: [] };

  async function open(): Promise<void> {
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    await screen.findByTestId("version-navigator");
  }

  async function view(version: number): Promise<void> {
    // Radix's Select is a listbox, not a native one — open it, then pick.
    await userEvent.click(screen.getByTestId("version-picker"));
    await userEvent.click(await screen.findByRole("option", { name: new RegExp(`^v${version}`) }));
  }

  it("lists every version, newest first, and says which one is active", async () => {
    withHistory();
    withDiff(NOTHING);
    await open();

    await userEvent.click(screen.getByTestId("version-picker"));
    const options = await screen.findAllByRole("option");

    expect(options.map((option) => option.textContent)).toEqual([
      "v3 · active",
      "v2",
      "v1",
    ]);
  });

  it("does not render a navigator for a project with one version", async () => {
    // A selector with one entry is furniture. There is no history to navigate.
    withHistory([VERSIONS[2]], VERSIONS[2]);
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));

    await screen.findByTestId("schema-editor");
    expect(screen.queryByTestId("version-navigator")).toBeNull();
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
    expect(screen.queryByTestId("save-schema")).toBeNull();
    expect(screen.queryByTestId("add-class")).toBeNull();
    expect(screen.queryByTestId("version-note")).toBeNull();
    expect(screen.queryByTestId("class-list")).toBeNull();
    expect(screen.getByTestId("schema-status").textContent).toContain("read-only");
  });

  it("returns to the editor, unchanged, when the navigator is left alone again", async () => {
    withHistory();
    withDiff(NOTHING);
    await open();
    await view(1);
    await screen.findByTestId("past-version");

    await userEvent.click(screen.getByTestId("back-to-active"));

    await waitFor(() => expect(screen.queryByTestId("save-schema")).not.toBeNull());
    expect(screen.getByTestId("schema-status").textContent).toContain("Version 3 active");
  });

  it("shows the selected version's own description, and says so when there is none", async () => {
    withHistory();
    withDiff(NOTHING);
    await open();

    // v3 is active and was published without one.
    expect(screen.getByTestId("version-description").textContent).toContain("No description");

    await view(2);

    await waitFor(() =>
      expect(screen.getByTestId("version-description").textContent).toContain("lanes too"),
    );
  });

  it("renders the diff the API returned, never one computed here", async () => {
    withHistory();
    withDiff({
      is_destructive: true,
      destructive_classes: ["lane"],
      changes: [
        { kind: "additive", label_class: "crossing", attribute: null, detail: "class 'crossing' added" },
        { kind: "destructive", label_class: "lane", attribute: null, detail: "class 'lane' removed" },
      ],
    });
    await open();

    const diff = await screen.findByTestId("version-diff");

    // `detail` verbatim: it is the string the kernel's own 409 is built from, so
    // a sentence here and a sentence in a refusal are the same sentence.
    expect(diff.textContent).toContain("class 'crossing' added");
    expect(diff.textContent).toContain("class 'lane' removed");
    expect(within(diff).getAllByText("Destructive")).toHaveLength(1);
    expect(within(diff).getAllByText("Additive")).toHaveLength(1);
  });

  it("asks about the selected version against its predecessor", async () => {
    withHistory();
    withDiff(NOTHING);
    await open();
    await waitFor(() =>
      expect(sent.some((r) => r.url.includes("from=2&to=3"))).toBe(true),
    );

    await view(2);

    await waitFor(() => expect(sent.some((r) => r.url.includes("from=1&to=2"))).toBe(true));
  });

  it("asks nothing about version 1, because there is nothing before it", async () => {
    withHistory();
    withDiff(NOTHING);
    await open();
    await view(1);

    await screen.findByTestId("version-diff-none");
    // `from=0` is a 422, so the query is disabled rather than sent with a guess.
    expect(sent.some((r) => r.url.includes("from=0"))).toBe(false);
  });

  it("publishes the description written beside Save", async () => {
    withHistory();
    withDiff(NOTHING);
    on("POST", /schema\/drafts\/curated\/publish$/, {
      status: 201,
      body: { published: { ...VERSIONS[2], version: 4 }, advanced_batches: [] },
    });
    await open();

    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(screen.getByTestId("class-name-2"), "pedestrian");
    await userEvent.type(screen.getByTestId("version-note"), "added pedestrians");
    await userEvent.click(screen.getByTestId("save-schema"));

    // The description is typed into the draft's own `note`, which Save flushes
    // before it publishes — the kernel reads the version's description off the
    // stored draft, so this is the request that carries what was typed.
    await waitFor(() => expect(sent.some((r) => r.method === "PUT")).toBe(true));
    const request = sent.find((r) => r.method === "PUT");
    expect(JSON.parse(bodies.get(request!) ?? "{}").note).toBe("added pedestrians");
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

    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(screen.getByTestId("class-name-2"), "pedestrian");
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

    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(screen.getByTestId("class-name-2"), "pedestrian");
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
    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(screen.getByTestId("class-name-2"), "pedestrian");

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

    await waitFor(() =>
      expect(screen.getByTestId("version-description").textContent).toContain(
        "added pedestrians",
      ),
    );
  });

  it("says so rather than going blank when the comparison cannot be loaded", async () => {
    withHistory();
    on("GET", /schema\/compare/, { status: 500, body: { code: "INTERNAL_ERROR", message: "no" } });
    await open();

    await screen.findByTestId("version-diff-error");
    // The editor itself is unaffected: a diff is context, not the contract.
    expect(screen.queryByTestId("save-schema")).not.toBeNull();
  });
});

describe("the schema editor's two panels", () => {
  /** Fifty classes: an ordinary Physical AI ontology, and what the stack broke at. */
  const MANY = Array.from({ length: 50 }, (_, index) => ({
    name: `class-${String(index).padStart(2, "0")}`,
    geometries: ["bbox"],
    color: null,
    attributes: [],
  }));

  function withClasses(classes: unknown[]): void {
    on("GET", /^\/projects\/[^/]+$/, {
      status: 200,
      body: { id: PROJECT, name: "highway", description: null },
    });
    on("GET", /^\/projects\/[^/]+\/schema$/, {
      status: 200,
      body: { project_id: PROJECT, version: 1, classes },
    });
    on("GET", /schema\/versions$/, { status: 200, body: { items: [], total: 0 } });
    on("GET", /\/stats$/, {
      status: 200,
      body: {
        project_id: PROJECT,
        asset_count: 10,
        annotated_asset_count: 5,
        annotation_count: 4372,
        class_count: classes.length,
        annotated_pct: 50,
        classes: [{ label_class: "class-00", annotations: 4372, assets: 5 }],
      },
    });
    on("GET", /\/assets$/, { status: 200, body: { items: [], total: 0 } });
    on("GET", /\/batches/, { status: 200, body: { items: [], total: 0 } });
  }

  it("shows every class in the list and only the selected one in full", async () => {
    // The whole point of the layout. Fifty stacked full-width cards is what this
    // replaces, and it is unusable well before fifty.
    withClasses(MANY);
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));

    await screen.findByTestId("class-list");
    expect(screen.getByTestId("class-list").querySelectorAll("button")).toHaveLength(50);
    expect(screen.queryByTestId("class-name-0")).not.toBeNull();
    expect(screen.queryByTestId("class-name-1")).toBeNull();
    expect(screen.queryByTestId("class-name-49")).toBeNull();
  });

  it("opens the class a row names, not the row's position in a filtered list", async () => {
    // The trap the filter creates: a row's index in the *view* is not its index
    // in the schema, and writing through the wrong one edits a different class.
    withClasses(MANY);
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("class-filter");

    await userEvent.type(screen.getByTestId("class-filter"), "class-42");
    expect(screen.getByTestId("class-list").querySelectorAll("button")).toHaveLength(1);

    await userEvent.click(screen.getByTestId("class-list").querySelectorAll("button")[0]);
    expect(screen.getByTestId("class-name-42")).toHaveProperty("value", "class-42");
  });

  it("filters case-insensitively on a substring", async () => {
    withClasses([
      { name: "Vehicle", geometries: ["bbox"], color: null, attributes: [] },
      { name: "lane", geometries: ["polygon"], color: null, attributes: [] },
    ]);
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("class-filter");

    await userEvent.type(screen.getByTestId("class-filter"), "EHIC");
    expect(screen.getByTestId("class-list").querySelectorAll("button")).toHaveLength(1);
  });

  it("says so when a filter matches nothing, rather than showing an empty box", async () => {
    withClasses(MANY);
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("class-filter");

    await userEvent.type(screen.getByTestId("class-filter"), "zzz");
    expect(screen.queryByTestId("filter-empty")).not.toBeNull();
  });

  it("walks the list with the arrow keys", async () => {
    withClasses(MANY);
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("class-list");

    const rows = screen.getByTestId("class-list").querySelectorAll("button");
    rows[0].focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.queryByTestId("class-name-1")).not.toBeNull();

    await userEvent.keyboard("{ArrowDown}");
    expect(screen.queryByTestId("class-name-2")).not.toBeNull();

    await userEvent.keyboard("{ArrowUp}");
    expect(screen.queryByTestId("class-name-1")).not.toBeNull();
  });

  it("does not walk off either end of the list", async () => {
    withClasses(MANY.slice(0, 2));
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("class-list");

    screen.getByTestId("class-list").querySelectorAll("button")[0].focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.queryByTestId("class-name-0")).not.toBeNull();

    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(screen.queryByTestId("class-name-1")).not.toBeNull();
  });

  it("adds a class and selects it, so the panel is showing what was just made", async () => {
    withClasses(MANY);
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("add-class"));

    expect(screen.getByTestId("class-name-50")).toHaveProperty("value", "");
  });

  it("clears the filter when adding, or the new class would be hidden by it", async () => {
    // A new class has an empty name, so *any* filter hides the row that was just
    // created — and the panel would be editing something the list does not show.
    withClasses(MANY);
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("class-filter");

    await userEvent.type(screen.getByTestId("class-filter"), "class-42");
    await userEvent.click(screen.getByTestId("add-class"));

    expect(screen.getByTestId("class-filter")).toHaveProperty("value", "");
    expect(screen.getByTestId("class-list").querySelectorAll("button")).toHaveLength(51);
  });

  it("keeps an orphaning removal terminal and leaves the draft unchanged", async () => {
    withClasses(CLASSES);
    on("POST", /\/schema\/preview$/, {
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [{ label_class: "lane", annotations: 12, assets: 3 }],
        is_refused: true,
      },
    });
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("class-list").querySelectorAll("button")[1]);
    await userEvent.click(screen.getByTestId("remove-class-1"));

    expect((await screen.findByTestId("orphan-dialog")).textContent).toContain("12 annotations");
    expect(screen.getByTestId("orphan-dialog").textContent).toContain("3 assets");
    expect(screen.queryByTestId("remove-class-confirm")).toBeNull();
    expect(screen.queryByTestId("allow-destructive")).toBeNull();
    expect(screen.getByTestId("class-name-1")).toHaveProperty("value", "lane");
  });

  it("removes a clear candidate from the local draft without publishing", async () => {
    withClasses(CLASSES);
    on("POST", /\/schema\/preview$/, {
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [],
        is_refused: false,
      },
    });
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("class-list").querySelectorAll("button")[1]);
    await userEvent.click(screen.getByTestId("remove-class-1"));

    await waitFor(() =>
      expect(screen.getByTestId("class-list").querySelectorAll("button")).toHaveLength(1),
    );
    expect(screen.queryByTestId("orphan-dialog")).toBeNull();
    expect(sent.some((request) => new URL(request.url).pathname.endsWith("/publish"))).toBe(false);
  });

  it("shows shared preview failure prose and leaves the draft unchanged", async () => {
    withClasses(CLASSES);
    on("POST", /\/schema\/preview$/, {
      status: 503,
      body: { code: "NETWORK_ERROR", message: "unreachable" },
    });
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("class-list").querySelectorAll("button")[1]);
    await userEvent.click(screen.getByTestId("remove-class-1"));

    const error = await screen.findByTestId("schema-preview-error");
    expect(error.textContent).toContain("The server could not be reached");
    expect(error.textContent).not.toContain("unreachable");
    expect(screen.getByTestId("class-name-1")).toHaveProperty("value", "lane");
    expect(screen.queryByTestId("orphan-dialog")).toBeNull();
  });

  it("does not apply field edits while a removal preview is pending", async () => {
    withClasses(CLASSES);
    let resolvePreview: ((answer: Exclude<HandlerAnswer, undefined>) => void) | undefined;
    handlers.push((request) => {
      if (
        request.method !== "POST" ||
        !new URL(request.url).pathname.endsWith("/schema/preview")
      ) {
        return undefined;
      }
      return new Promise((resolve) => {
        resolvePreview = resolve;
      });
    });
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("remove-class-0"));
    await waitFor(() => expect(screen.getByTestId("remove-class-0")).toHaveProperty("disabled", true));
    expect(screen.getByTestId("remove-class-0").textContent).toContain("Checking…");

    await userEvent.type(screen.getByTestId("class-name-0"), "-edited");
    expect(screen.getByTestId("class-name-0")).toHaveProperty("value", "vehicle");

    if (resolvePreview === undefined) throw new Error("Expected the deferred preview request");
    resolvePreview({
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["vehicle"], is_destructive: true },
        blockers: [],
        is_refused: false,
      },
    });

    await waitFor(() =>
      expect(screen.getByTestId("class-list").querySelectorAll("button")).toHaveLength(1),
    );
    expect(screen.getByTestId("class-name-0")).toHaveProperty("value", "lane");
  });

  it("shows each class's annotation count in its panel header", async () => {
    withClasses(MANY);
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));

    // The panel renders before the counts arrive — it has a class to show and
    // does not wait on a number to show it — so this waits for the count rather
    // than for the header.
    await screen.findByTestId("class-count-0");
    await waitFor(() =>
      expect(screen.getByTestId("class-count-0").textContent).toContain(
        (4372).toLocaleString(undefined),
      ),
    );
  });

  it("lands on the neighbour after a removal rather than on an empty panel", async () => {
    withClasses(MANY.slice(0, 3));
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("class-list").querySelectorAll("button")[2]);
    await userEvent.click(screen.getByTestId("remove-class-2"));
    await waitFor(() =>
      expect(screen.getByTestId("class-list").querySelectorAll("button")).toHaveLength(2),
    );

    expect(screen.getByTestId("class-list").querySelectorAll("button")).toHaveLength(2);
    expect(screen.queryByTestId("class-name-1")).not.toBeNull();
  });
});

describe("the project view's tabs", () => {
  function project(): void {
    on("GET", /^\/projects\/[^/]+$/, {
      status: 200,
      body: { id: PROJECT, name: "highway", description: null },
    });
    on("GET", /^\/projects\/[^/]+\/schema$/, {
      status: 200,
      body: { project_id: PROJECT, version: 2, classes: CLASSES },
    });
    on("GET", /schema\/versions$/, { status: 200, body: { items: [], total: 0 } });
    on("GET", /\/batches/, { status: 200, body: { items: [], total: 0 } });
    // Overview is the default tab, so its two reads are part of
    // opening a project at all.
    on("GET", /\/stats$/, {
      status: 200,
      body: {
        project_id: PROJECT,
        asset_count: 12,
        annotated_asset_count: 3,
        annotation_count: 20,
        class_count: 2,
        annotated_pct: 25,
        classes: [{ label_class: "vehicle", annotations: 20, assets: 3 }],
      },
    });
    on("GET", /\/assets$/, { status: 200, body: { items: [], total: 0 } });
  }

  it("shows one section at a time, and the others are not in the DOM", async () => {
    project();
    render(mount(<ProjectScreen projectId={PROJECT} onOpenBatch={vi.fn()} />));

    // Overview is where a project opens: a project page's subject is
    // its data, and the schema editor renders the same for an empty project and
    // a hundred-thousand-image one.
    await screen.findByTestId("overview-panel");
    expect(screen.queryByTestId("schema-editor")).toBeNull();
    expect(screen.queryByTestId("batches-screen")).toBeNull();
    // The history is inside Schema now, so it is absent for the same reason the
    // editor is rather than for one of its own.
    expect(screen.queryByTestId("version-history")).toBeNull();

    await userEvent.click(screen.getByTestId("tab-batches"));
    await screen.findByTestId("batches-screen");
    expect(screen.queryByTestId("overview-panel")).toBeNull();
    expect(screen.queryByTestId("schema-editor")).toBeNull();
    expect(screen.queryByTestId("version-history")).toBeNull();
  });

  it("presents the sections as tabs, with the open one selected and the others not", async () => {
    project();
    render(mount(<ProjectScreen projectId={PROJECT} onOpenBatch={vi.fn()} />));
    await screen.findByTestId("overview-panel");

    // Structural, never a class string: the styling changed once already
    // and will again, but "this section is the open one" is what the keyboard and
    // a screen reader read, and it is what a restyle must not lose.
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(screen.getByTestId("tab-overview").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("tab-overview").dataset.state).toBe("active");
    for (const other of ["tab-schema", "tab-batches", "tab-dataset"]) {
      expect(screen.getByTestId(other).getAttribute("aria-selected")).toBe("false");
      expect(screen.getByTestId(other).dataset.state).toBe("inactive");
    }

    await userEvent.click(screen.getByTestId("tab-batches"));
    await screen.findByTestId("batches-screen");
    expect(screen.getByTestId("tab-batches").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("tab-overview").getAttribute("aria-selected")).toBe("false");
  });

  it("opens on the section the URL named, and on the default when it names nothing valid", async () => {
    project();
    const { unmount } = render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    expect(screen.queryByTestId("overview-panel")).toBeNull();
    unmount();

    // A stale link, a typo, or `batches` on a host with no batch route: none of
    // them is an empty page. The default they land on is Overview.
    render(mount(<ProjectScreen projectId={PROJECT} tab="nonsense" />));
    await screen.findByTestId("overview-panel");
  });

  it("opens on Overview, and offers the four sections in order", async () => {
    // Not Schema. A schema editor is configuration,
    // and it renders identically for an empty project and a 100k-image one —
    // which is the test `DESIGN.md` principle 6 states, about this page.
    project();
    render(mount(<ProjectScreen projectId={PROJECT} onOpenBatch={vi.fn()} />));

    await screen.findByTestId("overview-panel");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Schema",
      "Batches",
      // **Dataset, where "Schema history" used to be.** The trunk is the
      // product's central object and was reachable only through an overflow
      // menu, an Overview link and the last step of a checklist; the history is
      // a *view of* Schema and now sits inside it. `?tab=versions` still works
      // and lands on Schema — a bookmarked URL is a promise.
      "Dataset",
    ]);
  });

  it("still opens on Overview for a host with no batch route", async () => {
    project();
    render(mount(<ProjectScreen projectId={PROJECT} />));

    await screen.findByTestId("overview-panel");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Schema",
      "Dataset",
    ]);
  });

  it("round-trips ?tab=overview, so the default is addressable too", async () => {
    // The default being addressable is what makes a link to it survive the
    // default moving again.
    project();
    const changed = vi.fn();
    render(mount(<ProjectScreen projectId={PROJECT} tab="overview" onTabChange={changed} />));

    await screen.findByTestId("overview-panel");
    await userEvent.click(screen.getByTestId("tab-dataset"));
    expect(changed).toHaveBeenCalledWith("dataset");
  });

  it("reports the tab to the host rather than reaching for a router", async () => {
    project();
    const changed = vi.fn();
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" onTabChange={changed} />));

    await screen.findByTestId("schema-editor");
    await userEvent.click(screen.getByTestId("tab-overview"));
    expect(changed).toHaveBeenCalledWith("overview");
    // Controlled: the host owns the value, so the section does not move until the
    // URL does. Anything else would make the back button lie.
    expect(screen.queryByTestId("overview-panel")).toBeNull();
  });

  it("does not read the version list until somebody opens the Schema tab", async () => {
    // The history moved *inside* Schema, so the query moved with it — Radix
    // unmounts an inactive tab's content, which is what makes "requests follow
    // the open tab" true by construction rather than by every panel remembering.
    project();
    render(mount(<ProjectScreen projectId={PROJECT} />));

    await screen.findByTestId("overview-panel");
    const versionRequests = (): number =>
      sent.filter((request) => new URL(request.url).pathname.endsWith("/schema/versions")).length;
    expect(versionRequests()).toBe(0);

    await userEvent.click(screen.getByTestId("tab-schema"));
    await waitFor(() => expect(versionRequests()).toBe(1));
  });

  it("carries a bookmarked ?tab=versions to Schema, where the history now lives", async () => {
    // A URL somebody saved is a promise. `resolveProjectTab` is what the *host*
    // asks to rewrite the address bar; this is the screen holding up its end
    // when handed the stale value directly.
    project();
    render(mount(<ProjectScreen projectId={PROJECT} tab="versions" />));

    await screen.findByTestId("schema-editor");
    expect(screen.queryByTestId("version-history")).not.toBeNull();
    expect(screen.queryByTestId("overview-panel")).toBeNull();
  });
});

describe("version history", () => {
  it("renders every version, marks the active one, and offers no way to edit a past one", async () => {
    on("GET", /^\/projects\/[^/]+$/, {
      status: 200,
      body: { id: PROJECT, name: "highway", description: null },
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

    // Reached through the Schema tab, which is where the history lives now: it
    // is a view *of* the schema rather than a peer of it.
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));

    const history = await screen.findByTestId("version-history");
    // `findBy` on the row, not on the card: the card renders immediately and holds
    // the skeletons, so a `getBy` here asserts against a loading state.
    await within(history).findByTestId("version-1");
    expect(within(history).getByTestId("version-1").textContent).toContain("vehicle (box)");
    expect(within(history).getByTestId("version-2").textContent).toContain("lane (polygon)");

    // Active is *derived* — the highest version, never a stored flag.
    expect(within(history).getByTestId("version-2").textContent).toContain("active");
    expect(within(history).getByTestId("version-1").textContent).not.toContain("active");

    // Read-only is structural rather than disabled: there are no controls at all.
    expect(within(history).queryAllByRole("button")).toHaveLength(0);
    expect(within(history).queryAllByRole("textbox")).toHaveLength(0);
  });

  it("shows why and when, and an em dash for a version that recorded neither", async () => {
    // The two optional fields on the ledger. Both are null for a version published
    // before the migration, and nothing backfills either — so the row has to say
    // "not recorded" rather than go blank, which reads as a rendering bug.
    on("GET", /^\/projects\/[^/]+$/, {
      status: 200,
      body: { id: PROJECT, name: "highway", description: null },
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
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));

    const history = await screen.findByTestId("version-history");
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
   * gives back exactly the rows a flat table would have had.
   */
  describe("versions published while annotating", () => {
    /** Four versions: two curated milestones with a two-version run between them. */
    function withRun(): void {
      on("GET", /^\/projects\/[^/]+$/, {
        status: 200,
        body: { id: PROJECT, name: "highway", description: null },
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

    it("collapses the run and leaves the milestones alone", async () => {
      withRun();
      render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));

      const history = await screen.findByTestId("version-history");
      await within(history).findByTestId("version-4");

      // The two curated versions are rows of their own; the run between them is
      // one. Without that, the milestone somebody opened this table to read sits
      // under however many classes were added mid-job that week.
      expect(within(history).getByTestId("version-run-2-3")).toBeTruthy();
      expect(within(history).getByTestId("version-1")).toBeTruthy();
      // Collapsed means *absent*, not hidden: a row still in the DOM is a row a
      // test can read and a screen reader announces.
      expect(within(history).queryByTestId("version-2")).toBeNull();
      expect(within(history).queryByTestId("version-3")).toBeNull();
    });

    it("says how many it stands for, and what the schema looked like after them", async () => {
      withRun();
      render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));

      const history = await screen.findByTestId("version-history");
      const run = await within(history).findByTestId("version-run-2-3");

      expect(run.textContent).toContain("2 versions published while annotating");
      // The *newest* of the run: that is the contract it left behind, and what
      // the next version was composed on.
      expect(run.textContent).toContain("lane (polygon)");
      // And not v2's, which declares one class — the assertion above is only a
      // claim about *which* version is summarised because the two differ.
      expect(run.textContent).toContain("vehicle (box)");
    });

    it("gives back every row when it is expanded", async () => {
      withRun();
      render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));

      const history = await screen.findByTestId("version-history");
      await within(history).findByTestId("version-run-2-3");

      await userEvent.click(within(history).getByTestId("version-run-toggle-2"));

      // Same testids and the same cells as an ungrouped version, so what a person
      // finds by expanding reads exactly like what they would have found flat.
      expect(within(history).getByTestId("version-3").textContent).toContain(
        'Added class "barrier" from the annotation view',
      );
      expect(within(history).getByTestId("version-2").textContent).toContain(
        'Added class "cone" from the annotation view',
      );
    });

    it("groups nothing in a history that recorded no provenance", async () => {
      // Every version published before WS1's migration answers null, and nothing
      // backfills them. "Nobody said" must not be read as "incidental" — so a
      // project untouched since then reads exactly as it did before this rule.
      on("GET", /^\/projects\/[^/]+$/, {
        status: 200,
        body: { id: PROJECT, name: "highway", description: null },
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
      render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));

      const history = await screen.findByTestId("version-history");
      await within(history).findByTestId("version-1");
      expect(within(history).getByTestId("version-2")).toBeTruthy();
      // And therefore no disclosure at all — the ledger stays read-only, which
      // the sibling test above asserts by counting buttons.
      expect(within(history).queryAllByRole("button")).toHaveLength(0);
    });
  });
});

describe("the project header", () => {
  const STATS = {
    project_id: PROJECT,
    asset_count: 1248,
    annotated_asset_count: 774,
    annotation_count: 6431,
    class_count: 3,
    annotated_pct: 62.0,
    classes: [],
    // Null by default, which is what an upgraded workspace reports for every
    // asset written before migration 13 — the state that cannot be backfilled.
    last_ingest_at: null as unknown,
  };

  /**
   * One batch as the wire spells it.
   *
   * `batchState` builds a single batch and answers most of this suite. The CTA's
   * own tests need several at once, in a stated order and with different pinned
   * versions, so both go through here rather than through two spellings of the
   * same twelve fields.
   */
  function batchStub(fields: {
    readonly id: string;
    readonly name: string;
    readonly state: string;
    readonly schemaVersion?: number | null;
    readonly unannotated?: number;
  }): Record<string, unknown> {
    return {
      id: fields.id,
      project_id: PROJECT,
      name: fields.name,
      state: fields.state,
      asset_count: 4,
      schema_version: fields.schemaVersion === undefined ? 1 : fields.schemaVersion,
      progress: {
        unannotated: fields.unannotated ?? 4,
        pre_labeled: 0,
        annotated: 0,
        skipped: 0,
        review_pending: 0,
        accepted: 0,
        total: 4,
      },
      allowed_actions: batchActions(fields.state as BatchState),
      promoted_asset_count: 0,
      parent_batch_id: null,
      pre_label_run: null,
    };
  }

  function headerFor(options: {
    description?: string | null;
    schema?: boolean;
    stats?: boolean;
    batchState?: string;
    /** Several batches, in wire order. Takes the place of `batchState`. */
    batches?: readonly Parameters<typeof batchStub>[0][];
    lastIngest?: unknown;
    /** `asset_count`, which is half of what the Overview's invitation reads. */
    assets?: number;
  }): void {
    on("GET", /^\/projects\/[^/]+$/, {
      status: 200,
      body: { id: PROJECT, name: "highway", description: options.description ?? null },
    });
    on("GET", /^\/projects\/[^/]+\/schema$/, {
      status: options.schema === false ? 404 : 200,
      body:
        options.schema === false
          ? { code: "SCHEMA_NOT_FOUND", message: "none yet" }
          : { project_id: PROJECT, version: 3, classes: CLASSES },
    });
    on("GET", /\/stats$/, {
      status: options.stats === false ? 500 : 200,
      body:
        options.stats === false
          ? { code: "BOOM", message: "no" }
          : {
              ...STATS,
              asset_count: options.assets ?? STATS.asset_count,
              last_ingest_at: options.lastIngest ?? null,
            },
    });
    const items =
      options.batches !== undefined
        ? options.batches.map(batchStub)
        : options.batchState === undefined
          ? []
          : [
              batchStub({
                id: "22222222-2222-4222-8222-222222222222",
                name: "drive-01",
                state: options.batchState,
              }),
            ];
    on("GET", /\/batches$/, { status: 200, body: { items, total: items.length } });
    on("GET", /schema\/versions$/, { status: 200, body: { items: [], total: 0 } });
  }

  it("renders nothing at all where a description is absent", async () => {
    // Not "No description." — a line about a field rather than about a project.
    headerFor({});
    render(mount(<ProjectScreen projectId={PROJECT} />));

    await screen.findByTestId("project-title");
    expect(screen.queryByTestId("project-description")).toBeNull();
    expect(document.body.textContent).not.toContain("No description");
  });

  it("shows a description when there is one", async () => {
    headerFor({ description: "M4 survey" });
    render(mount(<ProjectScreen projectId={PROJECT} />));

    expect((await screen.findByTestId("project-description")).textContent).toBe("M4 survey");
  });

  it("chips the active schema version", async () => {
    headerFor({});
    render(mount(<ProjectScreen projectId={PROJECT} />));

    expect((await screen.findByTestId("chip-version")).textContent).toContain("v3 active");
  });

  it("omits the version chip for a schema-less project rather than placeholding it", async () => {
    // `DESIGN.md`: a chip with no data is omitted, never rendered as a
    // placeholder. A project three seconds old is the ordinary case.
    headerFor({ schema: false });
    render(mount(<ProjectScreen projectId={PROJECT} />));

    await screen.findByTestId("project-chips");
    // Wait on the *counted* chip, whose request also settles the schema one, so
    // the assertion below is about an answer rather than about a pending query.
    await waitFor(() => expect(screen.queryByTestId("chip-images")).not.toBeNull());
    expect(screen.queryByTestId("chip-version")).toBeNull();
  });

  it("omits the image chip when the count cannot be read", async () => {
    headerFor({ stats: false });
    render(mount(<ProjectScreen projectId={PROJECT} />));

    await screen.findByTestId("project-chips");
    await waitFor(() => expect(screen.queryByTestId("chip-version")).not.toBeNull());
    expect(screen.queryByTestId("chip-images")).toBeNull();
  });

  it("formats the image count rather than printing a bare integer", async () => {
    headerFor({});
    render(mount(<ProjectScreen projectId={PROJECT} />));

    expect((await screen.findByTestId("chip-images")).textContent).toContain(
      (1248).toLocaleString(undefined),
    );
  });

  it("chips when data last arrived, relative inside a week", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    headerFor({ lastIngest: twoDaysAgo });
    render(mount(<ProjectScreen projectId={PROJECT} />));

    expect((await screen.findByTestId("chip-ingested")).textContent).toBe("Ingested 2d ago");
  });

  it("chips an absolute date once the ingest is older than a week", async () => {
    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    headerFor({ lastIngest: longAgo.toISOString() });
    render(mount(<ProjectScreen projectId={PROJECT} />));

    // The date the browser would write, not a hardcoded format: `formatWhen`
    // deliberately follows the viewer's locale.
    expect((await screen.findByTestId("chip-ingested")).textContent).toBe(
      `Ingested ${longAgo.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })}`,
    );
  });

  it("omits the ingest chip when nothing records an arrival", async () => {
    // Null is not "never ingested" — it is *unknown*, because every asset in
    // this project predates the column and cannot be backfilled. Same
    // rule as a missing description: omitted, never placeheld.
    headerFor({});
    render(mount(<ProjectScreen projectId={PROJECT} />));

    await screen.findByTestId("project-chips");
    await waitFor(() => expect(screen.queryByTestId("chip-images")).not.toBeNull());
    expect(screen.queryByTestId("chip-ingested")).toBeNull();
    expect(document.body.textContent).not.toContain("Ingested");
  });

  it("refuses a stats document whose timestamp is not a string", async () => {
    // This assertion moved rather than being removed. It used to read "the chip
    // is simply absent", which was the *symptom* of a document nobody had checked:
    // the same wrong body white-screened three surfaces once, and the
    // fix was a hand-written guard at each render site. Now the check runs at
    // `unwrap`, so the query fails, both chips stay away, and the page still stands.
    headerFor({ lastIngest: 1_754_000_000 });
    render(mount(<ProjectScreen projectId={PROJECT} />));

    await waitFor(() => expect(screen.getByTestId("project-title").textContent).toBe("highway"));
    expect(screen.queryByTestId("chip-images")).toBeNull();
    expect(screen.queryByTestId("chip-ingested")).toBeNull();
  });

  it("omits the ingest chip when the timestamp will not parse", async () => {
    headerFor({ lastIngest: "not-a-date" });
    render(mount(<ProjectScreen projectId={PROJECT} />));

    await waitFor(() => expect(screen.queryByTestId("chip-images")).not.toBeNull());
    expect(screen.queryByTestId("chip-ingested")).toBeNull();
  });

  it("offers Annotate when a batch is open for annotation, and opens that batch", async () => {
    const opened = vi.fn();
    headerFor({ batchState: "in_annotation" });
    render(mount(<ProjectScreen projectId={PROJECT} onOpenBatch={opened} />));

    const cta = await screen.findByTestId("go-annotate");
    // With nothing to choose between, the button is shaped like one that jumps:
    // it announces no menu, and it carries the pen and no chevron.
    expect(cta.getAttribute("aria-haspopup")).toBeNull();
    expect(cta.querySelectorAll("svg")).toHaveLength(1);

    await userEvent.click(cta);

    expect(opened).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
    expect(screen.queryByTestId("annotate-batch-drive-01")).toBeNull();
  });

  /*
   * The three shapes of one control.
   *
   * A batch pins the project's active schema version at approval and the pin never
   * moves, so with two batches open for annotation the header used to make a
   * semantic choice on somebody's behalf — a `find` over the wire's own order —
   * and never say that it had. These fix the shape of each arm, and the second
   * one is the guard: reverting to a `find` turns it red.
   */
  const OPEN_PAIR = [
    { id: "44444444-4444-4444-8444-444444444444", name: "closed-run", state: "completed" },
    {
      id: "55555555-5555-4555-8555-555555555555",
      name: "drive-02",
      state: "in_annotation",
      schemaVersion: 2,
      unannotated: 7,
    },
    {
      id: "66666666-6666-4666-8666-666666666666",
      name: "drive-03",
      state: "in_annotation",
      schemaVersion: 2,
      unannotated: 12,
    },
  ] as const;

  it("asks which batch when two are open for annotation, instead of picking one", async () => {
    const opened = vi.fn();
    headerFor({ batches: OPEN_PAIR });
    render(mount(<ProjectScreen projectId={PROJECT} onOpenBatch={opened} />));

    const cta = await screen.findByTestId("go-annotate");
    expect(cta.getAttribute("aria-haspopup")).toBe("menu");
    // The pen and the chevron: the shape is what says a press opens a choice.
    expect(cta.querySelectorAll("svg")).toHaveLength(2);

    await userEvent.click(cta);

    // Pressing it navigated nowhere. This is the whole defect, stated once.
    expect(opened).not.toHaveBeenCalled();
    expect(await screen.findByTestId("annotate-batch-drive-03")).not.toBeNull();
    expect(screen.getByTestId("annotate-batch-drive-02")).not.toBeNull();
  });

  it("lists only the batches work can happen in, newest first, with their remaining count and pinned version", async () => {
    headerFor({ batches: OPEN_PAIR });
    render(mount(<ProjectScreen projectId={PROJECT} onOpenBatch={vi.fn()} />));

    await userEvent.click(await screen.findByTestId("go-annotate"));
    await screen.findByTestId("annotate-batch-drive-03");

    // A completed batch refuses every save, so it is not somewhere to be sent.
    expect(screen.queryByTestId("annotate-batch-closed-run")).toBeNull();
    // `BatchOut` carries no timestamp, so newest-first is the wire's order
    // reversed — `drive-03` arrived last and leads.
    const rows = [...document.querySelectorAll("[data-testid^='annotate-batch-']")];
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
      "annotate-batch-drive-03",
      "annotate-batch-drive-02",
    ]);
    // Remaining work in the batch table's own words, and the version the pick
    // actually decides — the one consequence invisible everywhere else here.
    expect(rows[0]?.textContent).toContain("12 to do");
    expect(rows[0]?.textContent).toContain("v2");
    expect(rows[1]?.textContent).toContain("7 to do");
  });

  it("opens the batch the menu row names", async () => {
    const opened = vi.fn();
    headerFor({ batches: OPEN_PAIR });
    render(mount(<ProjectScreen projectId={PROJECT} onOpenBatch={opened} />));

    await userEvent.click(await screen.findByTestId("go-annotate"));
    await userEvent.click(await screen.findByTestId("annotate-batch-drive-02"));

    expect(opened).toHaveBeenCalledWith("55555555-5555-4555-8555-555555555555");
  });

  it("does not render Annotate at all when no batch is open for annotation", async () => {
    // `DESIGN.md`'s never-disable rule: a control
    // that leads nowhere is absent, not grey.
    headerFor({ batchState: "draft" });
    render(mount(<ProjectScreen projectId={PROJECT} onOpenBatch={vi.fn()} onIngest={vi.fn()} />));

    await screen.findByTestId("go-ingest");
    expect(screen.queryByTestId("go-annotate")).toBeNull();
  });

  /*
   * The header's half of the one-filled-button rule.
   *
   * `headerFor` stubs no assets endpoint and no dataset, which is exactly the
   * state a three-second-old project is in — so these run against the same
   * fixtures the rest of the header suite does, with only the schema moving.
   *
   * The count is the claim, so each of these asserts the *total* number of
   * filled buttons in the document rather than the variant of one of them: a
   * test that only checked "Ingest is secondary" would pass with two filled
   * buttons elsewhere, which is the defect that was filed.
   */
  function filled(): readonly HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>("button.bg-primary")];
  }

  it("steps Ingest back while the Overview's invitation owns the filled button", async () => {
    headerFor({ schema: false, assets: 0 });
    render(
      mount(<ProjectScreen projectId={PROJECT} onIngest={vi.fn()} onTabChange={vi.fn()} />),
    );

    const cta = await screen.findByTestId("first-run-cta");
    expect(filled()).toEqual([cta]);
    expect(screen.getByTestId("go-ingest").className).not.toContain("bg-primary");
  });

  it("does not stand back for an invitation that has nowhere to send anybody", async () => {
    // With no `onTabChange` the tabs are uncontrolled, so the panel is handed no
    // way into Schema and renders the invitation as prose. A header that stepped
    // back for that would leave the page with no filled button at all — which is
    // the same failure as two, counted the other way.
    headerFor({ schema: false, assets: 0 });
    render(mount(<ProjectScreen projectId={PROJECT} onIngest={vi.fn()} />));

    await screen.findByTestId("first-run");
    expect(screen.queryByTestId("first-run-cta")).toBeNull();
    expect(filled()).toEqual([screen.getByTestId("go-ingest")]);
  });

  it("keeps the filled Ingest when the invitation is the ingest one", async () => {
    // The invitation and the header say the same thing with the same handler, so
    // the loud one stays in the header and the panel's stays outlined.
    headerFor({ assets: 0 });
    render(mount(<ProjectScreen projectId={PROJECT} onIngest={vi.fn()} />));

    await screen.findByTestId("overview-ingest");
    expect(filled()).toEqual([screen.getByTestId("go-ingest")]);
  });

  it("keeps the filled Ingest once the project has both classes and images", async () => {
    headerFor({});
    render(mount(<ProjectScreen projectId={PROJECT} onIngest={vi.fn()} />));

    await screen.findByTestId("overview-stats");
    expect(screen.queryByTestId("first-run")).toBeNull();
    expect(filled()).toEqual([screen.getByTestId("go-ingest")]);
  });

  it("hands the filled button back the moment another tab is showing", async () => {
    // The invitation is the *Overview's*. Radix unmounts inactive content, so a
    // header still standing back on the Batches tab would be a page with no
    // forward action at all.
    headerFor({ schema: false, assets: 0 });
    render(
      mount(<ProjectScreen projectId={PROJECT} onIngest={vi.fn()} tab="dataset" />),
    );

    await screen.findByTestId("go-ingest");
    expect(screen.queryByTestId("first-run")).toBeNull();
    expect(filled()).toEqual([screen.getByTestId("go-ingest")]);
  });

  it("moves Rename into the overflow, so only two buttons show", async () => {
    headerFor({ batchState: "in_annotation" });
    render(mount(<ProjectScreen projectId={PROJECT} onOpenBatch={vi.fn()} onIngest={vi.fn()} />));

    await screen.findByTestId("go-annotate");
    // Rename is behind the menu, so it is not in the document yet.
    expect(screen.queryByTestId("rename-project")).toBeNull();

    await userEvent.click(screen.getByTestId("project-menu"));

    expect(await screen.findByTestId("rename-project")).not.toBeNull();
    // **No Dataset item.** It was in this menu because the dataset had no tab of
    // its own; it has one now, and the same destination in a tab bar *and* a
    // hidden menu is two answers to one question — the second of which nobody
    // finds.
    expect(screen.queryByTestId("go-dataset")).toBeNull();
    expect(screen.queryByTestId("delete-project")).not.toBeNull();
  });

  it("states the blast radius in counted terms before deleting anything", async () => {
    headerFor({});
    render(mount(<ProjectScreen projectId={PROJECT} />));

    await screen.findByTestId("project-menu");
    await userEvent.click(screen.getByTestId("project-menu"));
    await userEvent.click(await screen.findByTestId("delete-project"));

    const said = (await screen.findByTestId("delete-blast-radius")).textContent ?? "";
    expect(said).toContain((1248).toLocaleString(undefined));
    expect(said).toContain((6431).toLocaleString(undefined));
    // The one thing a delete does *not* do, said out loud.
    expect(said).toContain("not removed");
  });

  it("sends the delete and then hands the host somewhere to go", async () => {
    headerFor({});
    on("DELETE", /^\/projects\/[^/]+$/, { status: 204 });
    const gone = vi.fn();
    render(mount(<ProjectScreen projectId={PROJECT} onDeleted={gone} />));

    await screen.findByTestId("project-menu");
    await userEvent.click(screen.getByTestId("project-menu"));
    await userEvent.click(await screen.findByTestId("delete-project"));
    await userEvent.click(await screen.findByTestId("delete-submit"));

    await waitFor(() => expect(gone).toHaveBeenCalledOnce());
  });
});
