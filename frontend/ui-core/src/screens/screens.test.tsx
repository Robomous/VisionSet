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
import { classColor, hexColor } from "../palette";
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
/**
 * What each request carried, captured before the client consumes it.
 *
 * Cloned rather than read later: a `Request` body is a one-shot stream, so a test
 * asking for it after the fact gets nothing. #162 needs it — its second criterion
 * is about the payload a save actually sends, not about what the control shows.
 */
const bodies = new Map<Request, string>();

beforeEach(() => {
  handlers = [];
  sent.length = 0;
  bodies.clear();
  writeToken("a-token");
  vi.stubGlobal("fetch", async (request: Request) => {
    sent.push(request);
    if (request.method !== "GET") bodies.set(request, await request.clone().text());
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

    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));

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

    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
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

    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
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

    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
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
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
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

  /**
   * #162: the colour control has to show the colour the class is actually drawn in.
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
      classColor({ name: "lane", geometry: "polygon", color: null, attributes: [] }, "lane"),
    );
    expect(derived).not.toBeNull();
    expect(screen.getByTestId("class-color-1")).toHaveProperty("value", derived);
    // Never the neutral, which is what it used to be for every derived class.
    expect(screen.getByTestId("class-color-1")).not.toHaveProperty("value", "#888888");

    // And a declared colour is still itself.
    expect(screen.getByTestId("class-color-0")).toHaveProperty("value", "#38bdf8");
  });

  it("does not turn a derived colour into a declared one just by showing it", async () => {
    // #162's second criterion, and the one worth being careful about: making the
    // input *display* a colour must not make the class *declare* it. A schema
    // version that pinned today's hash output would make every derived class look
    // authored, and would change meaning if the palette rule ever moved.
    projectWithSchema();
    on("POST", /schema\/versions$/, {
      status: 201,
      body: { project_id: PROJECT, version: 4, classes: CLASSES },
    });

    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    // Dirty by something that is not the colour — an untouched draft is not
    // saveable at all, which is itself the first half of the guarantee.
    expect(screen.getByTestId("save-schema")).toHaveProperty("disabled", true);
    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(screen.getByTestId("class-name-2"), "pedestrian");
    await userEvent.click(screen.getByTestId("save-schema"));

    await waitFor(() => expect(sent.some((r) => r.method === "POST")).toBe(true));
    const request = sent.find((r) => r.method === "POST")!;
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
    on("POST", /schema\/versions$/, {
      status: 201,
      body: { project_id: PROJECT, version: 4, classes: CLASSES },
    });

    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    await userEvent.click(screen.getByTestId("clear-color-0"));

    const derived = hexColor(
      classColor({ name: "vehicle", geometry: "bbox", color: null, attributes: [] }, "vehicle"),
    );
    expect(screen.getByTestId("class-color-0")).toHaveProperty("value", derived);
    // The button still means something: the stored value went back to null, which
    // is what "Derive" is for.
    await userEvent.click(screen.getByTestId("save-schema"));
    await waitFor(() => expect(sent.some((r) => r.method === "POST")).toBe(true));
    const request = sent.find((r) => r.method === "POST")!;
    const body = JSON.parse(bodies.get(request) ?? "{}") as {
      classes: { name: string; color: string | null }[];
    };
    expect(body.classes.find((one) => one.name === "vehicle")?.color).toBeNull();
  });
});

/**
 * #171: the sections are tabs, so what is *not* on the page is now an assertion.
 *
 * The interesting one is the last: a query that lives in the section that renders
 * it is a query that follows the tab. That is what makes the split more than
 * cosmetic, and it is invisible in the rendering — only the request log shows it.
 */
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
    // Overview is the default tab since #210, so its two reads are part of
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

    // Overview is where a project opens since #210: a project page's subject is
    // its data, and the schema editor renders the same for an empty project and
    // a hundred-thousand-image one.
    await screen.findByTestId("overview-panel");
    expect(screen.queryByTestId("schema-editor")).toBeNull();
    expect(screen.queryByTestId("batches-screen")).toBeNull();
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

    // Structural, never a class string (#182): the styling changed once already
    // and will again, but "this section is the open one" is what the keyboard and
    // a screen reader read, and it is what a restyle must not lose.
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(screen.getByTestId("tab-overview").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("tab-overview").dataset.state).toBe("active");
    for (const other of ["tab-schema", "tab-batches", "tab-versions"]) {
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
    const { unmount } = render(mount(<ProjectScreen projectId={PROJECT} tab="versions" />));
    await screen.findByTestId("version-history");
    expect(screen.queryByTestId("schema-editor")).toBeNull();
    unmount();

    // A stale link, a typo, or `batches` on a host with no batch route: none of
    // them is an empty page. The default they land on is Overview since #210.
    render(mount(<ProjectScreen projectId={PROJECT} tab="nonsense" />));
    await screen.findByTestId("overview-panel");
  });

  it("opens on Overview, and offers the four sections in order", async () => {
    // #210 reversed #171's choice of Schema. A schema editor is configuration,
    // and it renders identically for an empty project and a 100k-image one —
    // which is the test `DESIGN.md` principle 6 states, about this page.
    project();
    render(mount(<ProjectScreen projectId={PROJECT} onOpenBatch={vi.fn()} />));

    await screen.findByTestId("overview-panel");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Schema",
      "Batches",
      "Versions",
    ]);
  });

  it("still opens on Overview for a host with no batch route", async () => {
    project();
    render(mount(<ProjectScreen projectId={PROJECT} />));

    await screen.findByTestId("overview-panel");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Schema",
      "Versions",
    ]);
  });

  it("round-trips ?tab=overview, so the default is addressable too", async () => {
    // The default being addressable is what makes a link to it survive the
    // default moving again.
    project();
    const changed = vi.fn();
    render(mount(<ProjectScreen projectId={PROJECT} tab="overview" onTabChange={changed} />));

    await screen.findByTestId("overview-panel");
    await userEvent.click(screen.getByTestId("tab-versions"));
    expect(changed).toHaveBeenCalledWith("versions");
  });

  it("reports the tab to the host rather than reaching for a router", async () => {
    project();
    const changed = vi.fn();
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" onTabChange={changed} />));

    await screen.findByTestId("schema-editor");
    await userEvent.click(screen.getByTestId("tab-versions"));
    expect(changed).toHaveBeenCalledWith("versions");
    // Controlled: the host owns the value, so the section does not move until the
    // URL does. Anything else would make the back button lie.
    expect(screen.queryByTestId("version-history")).toBeNull();
  });

  it("does not read the version list until somebody opens the Versions tab", async () => {
    project();
    render(mount(<ProjectScreen projectId={PROJECT} />));

    await screen.findByTestId("overview-panel");
    const versionRequests = (): number =>
      sent.filter((request) => new URL(request.url).pathname.endsWith("/schema/versions")).length;
    expect(versionRequests()).toBe(0);

    await userEvent.click(screen.getByTestId("tab-versions"));
    await waitFor(() => expect(versionRequests()).toBe(1));
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

    // Reached through the tab, which is the only way to reach it now (#171).
    render(mount(<ProjectScreen projectId={PROJECT} tab="versions" />));

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

describe("the project header", () => {
  const STATS = {
    project_id: PROJECT,
    asset_count: 1248,
    annotated_asset_count: 774,
    annotation_count: 6431,
    class_count: 3,
    annotated_pct: 62.0,
    classes: [],
  };

  function headerFor(options: {
    description?: string | null;
    schema?: boolean;
    stats?: boolean;
    batchState?: string;
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
      body: options.stats === false ? { code: "BOOM", message: "no" } : STATS,
    });
    on("GET", /\/batches$/, {
      status: 200,
      body:
        options.batchState === undefined
          ? { items: [], total: 0 }
          : {
              items: [
                {
                  id: "22222222-2222-4222-8222-222222222222",
                  project_id: PROJECT,
                  name: "drive-01",
                  state: options.batchState,
                  asset_count: 4,
                  schema_version: 1,
                  progress: {
                    unannotated: 4,
                    annotated: 0,
                    skipped: 0,
                    review_pending: 0,
                    accepted: 0,
                    total: 4,
                  },
                },
              ],
              total: 1,
            },
    });
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

  it("offers Annotate when a batch is open for annotation, and opens that batch", async () => {
    const opened = vi.fn();
    headerFor({ batchState: "in_annotation" });
    render(mount(<ProjectScreen projectId={PROJECT} onOpenBatch={opened} />));

    await userEvent.click(await screen.findByTestId("go-annotate"));

    expect(opened).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
  });

  it("does not render Annotate at all when no batch is open for annotation", async () => {
    // `DESIGN.md`'s never-disable rule, and #160 from the other side: a control
    // that leads nowhere is absent, not grey.
    headerFor({ batchState: "draft" });
    render(mount(<ProjectScreen projectId={PROJECT} onOpenBatch={vi.fn()} onIngest={vi.fn()} />));

    await screen.findByTestId("go-ingest");
    expect(screen.queryByTestId("go-annotate")).toBeNull();
  });

  it("moves Rename and Dataset into the overflow, so only two buttons show", async () => {
    headerFor({ batchState: "in_annotation" });
    render(mount(<ProjectScreen projectId={PROJECT} onOpenBatch={vi.fn()} onIngest={vi.fn()} onOpenDataset={vi.fn()} />));

    await screen.findByTestId("go-annotate");
    // Rename and Dataset are behind the menu, so they are not in the document yet.
    expect(screen.queryByTestId("rename-project")).toBeNull();
    expect(screen.queryByTestId("go-dataset")).toBeNull();

    await userEvent.click(screen.getByTestId("project-menu"));

    expect(await screen.findByTestId("rename-project")).not.toBeNull();
    expect(screen.queryByTestId("go-dataset")).not.toBeNull();
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
