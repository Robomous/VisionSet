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
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { writeToken } from "../data/session";
import { ProjectScreen } from "./ProjectScreen";
import { ProjectsScreen } from "./ProjectsScreen";

/** See `dataShell.test.tsx`: undici's `Request` needs an absolute URL. */
const API = "http://visionset.test";
const PROJECT = "11111111-1111-4111-8111-111111111111";

/** One route table, matched in order. A miss is a loud 500 rather than a hang. */
type Handler = (request: Request) => { status: number; body: unknown } | undefined;

let handlers: Handler[] = [];
const sent: Request[] = [];

beforeEach(() => {
  handlers = [];
  sent.length = 0;
  writeToken("a-token");
  vi.stubGlobal("fetch", (request: Request) => {
    sent.push(request);
    for (const handler of handlers) {
      const answer = handler(request);
      if (answer !== undefined) {
        return Promise.resolve(
          new Response(answer.status === 204 ? null : JSON.stringify(answer.body), {
            status: answer.status,
            headers: { "content-type": "application/json" },
          }),
        );
      }
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
  { name: "vehicle", geometry: "bbox", color: "#38bdf8", attributes: [] },
  { name: "lane", geometry: "polygon", color: null, attributes: [] },
];

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

  it("renders a refusal with its code, because that is what a client branches on", async () => {
    on("GET", /^\/projects$/, { status: 200, body: { items: [], total: 0 } });
    on("POST", /^\/projects$/, {
      status: 409,
      body: { code: "PROJECT_NAME_TAKEN", message: "A project called highway already exists." },
    });

    render(mount(<ProjectsScreen onOpenProject={vi.fn()} />));
    await userEvent.click(await screen.findByTestId("new-project"));
    await userEvent.type(screen.getByTestId("project-name"), "highway");
    await userEvent.click(screen.getByTestId("create-submit"));

    const error = await screen.findByTestId("create-error");
    expect(error.textContent).toContain("PROJECT_NAME_TAKEN");
    expect(error.textContent).toContain("already exists");
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

  it("treats a schema-less project as an empty draft, not as an error", async () => {
    on("GET", /^\/projects\/[^/]+$/, {
      status: 200,
      body: { id: PROJECT, name: "fresh", description: null },
    });
    // A project starts schema-less on purpose (#6). This 404 is the normal state
    // of a project three seconds old, and an error surface here would tell a new
    // user their project is broken.
    on("GET", /^\/projects\/[^/]+\/schema$/, {
      status: 404,
      body: { code: "SCHEMA_NOT_FOUND", message: "This project has no schema version yet." },
    });
    on("GET", /schema\/versions$/, { status: 200, body: { items: [], total: 0 } });

    render(mount(<ProjectScreen projectId={PROJECT} />));

    await waitFor(() => expect(screen.queryByTestId("schema-editor")).not.toBeNull());
    expect(screen.queryByTestId("schema-error")).toBeNull();
    expect(screen.getByTestId("schema-editor").textContent).toContain("Saving creates version 1");
  });

  it("edits a draft and publishes it as the next version", async () => {
    projectWithSchema();
    on("POST", /schema\/versions$/, {
      status: 201,
      body: { project_id: PROJECT, version: 4, classes: CLASSES },
    });

    render(mount(<ProjectScreen projectId={PROJECT} />));
    await screen.findByTestId("schema-editor");
    expect(screen.getByTestId("schema-editor").textContent).toContain("Saving creates version 4");

    // Nothing has changed, so there is nothing to publish — a version that
    // declares exactly what the last one did is a version nobody should be able to
    // create by accident.
    expect(screen.getByTestId("save-schema")).toHaveProperty("disabled", true);

    await userEvent.click(screen.getByTestId("add-class"));
    // …and a nameless class is not saveable either. `normalize_name` refuses a
    // blank, so this is the API's rule mirrored rather than a second one.
    expect(screen.getByTestId("save-schema")).toHaveProperty("disabled", true);

    await userEvent.type(screen.getByTestId("class-name-2"), "pedestrian");
    expect(screen.queryByTestId("schema-dirty")).not.toBeNull();
    await userEvent.click(screen.getByTestId("save-schema"));

    await waitFor(() => expect(sent.some((r) => r.method === "POST")).toBe(true));
    const request = sent.find((r) => r.method === "POST");
    // The plain save carries no gate — `allow_destructive` is only ever sent
    // after the API has said it is needed.
    expect(new URL(request?.url ?? "").searchParams.get("allow_destructive")).toBeNull();
  });

  it("offers an override for a destructive change, and retries with the flag", async () => {
    projectWithSchema();
    let attempts = 0;
    handlers.push((request) => {
      if (request.method !== "POST") return undefined;
      attempts += 1;
      const allowed = new URL(request.url).searchParams.get("allow_destructive") === "true";
      return allowed
        ? { status: 201, body: { project_id: PROJECT, version: 4, classes: [] } }
        : {
            status: 409,
            body: {
              code: "DESTRUCTIVE_SCHEMA_CHANGE",
              message: "Removing “lane” narrows the contract.",
            },
          };
    });

    render(mount(<ProjectScreen projectId={PROJECT} />));
    await screen.findByTestId("schema-editor");
    await userEvent.click(screen.getByTestId("remove-class-1"));
    await userEvent.click(screen.getByTestId("save-schema"));

    const dialog = await screen.findByTestId("destructive-dialog");
    expect(dialog.textContent).toContain("narrows the contract");

    await userEvent.click(screen.getByTestId("allow-destructive"));
    await waitFor(() => expect(attempts).toBe(2));
    expect(
      new URL(sent.filter((r) => r.method === "POST")[1].url).searchParams.get("allow_destructive"),
    ).toBe("true");
  });

  it("offers no override for an orphaning change, because there is none", async () => {
    projectWithSchema();
    on("POST", /schema\/versions$/, {
      status: 409,
      body: {
        code: "SCHEMA_CHANGE_WOULD_ORPHAN",
        message: "1,204 annotations use “lane”.",
      },
    });

    render(mount(<ProjectScreen projectId={PROJECT} />));
    await screen.findByTestId("schema-editor");
    await userEvent.click(screen.getByTestId("remove-class-1"));
    await userEvent.click(screen.getByTestId("save-schema"));

    const dialog = await screen.findByTestId("orphan-dialog");
    expect(dialog.textContent).toContain("1,204 annotations");
    // The missing button *is* the assertion. `SchemaChangeWouldOrphan` has no
    // override and is deliberately not a subclass of `DestructiveSchemaChange`, so
    // a "Save anyway" here would be an infinite loop with a person in it.
    expect(screen.queryByTestId("allow-destructive")).toBeNull();
    expect(screen.queryByTestId("destructive-dialog")).toBeNull();
    expect(within(dialog).getByTestId("orphan-close")).not.toBeNull();
  });

  it("offers only the three geometries an annotation can carry", async () => {
    projectWithSchema();
    render(mount(<ProjectScreen projectId={PROJECT} />));
    await screen.findByTestId("schema-editor");

    await userEvent.click(screen.getByTestId("class-geometry-0"));
    for (const geometry of ["bbox", "polygon", "classification_tag"]) {
      expect(screen.getAllByText(geometry).length).toBeGreaterThan(0);
    }
    // `GeometryType` has eight members; five are refused at write time with
    // `UnsupportedGeometry`, so offering them would be offering a refusal.
    for (const geometry of ["mask", "polyline", "keypoints", "cuboid_3d", "polyline_3d"]) {
      expect(screen.queryByRole("option", { name: geometry })).toBeNull();
    }
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

    render(mount(<ProjectScreen projectId={PROJECT} />));

    const history = await screen.findByTestId("version-history");
    // `findBy` on the row, not on the card: the card renders immediately and holds
    // the skeletons, so a `getBy` here asserts against a loading state.
    await within(history).findByTestId("version-1");
    expect(within(history).getByTestId("version-1").textContent).toContain("vehicle (bbox)");
    expect(within(history).getByTestId("version-2").textContent).toContain("lane (polygon)");

    // Active is *derived* — the highest version, never a stored flag.
    expect(within(history).getByTestId("version-2").textContent).toContain("active");
    expect(within(history).getByTestId("version-1").textContent).not.toContain("active");

    // Read-only is structural rather than disabled: there are no controls at all.
    expect(within(history).queryAllByRole("button")).toHaveLength(0);
    expect(within(history).queryAllByRole("textbox")).toHaveLength(0);
  });
});
