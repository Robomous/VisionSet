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

  /**
   * Select a class and remove it from the draft, through the confirmation.
   *
   * Three steps rather than one since #213: only the *selected* class has a
   * detail panel, and removal states its blast radius before it happens.
   */
  /** Open one class's detail panel. Only the selected class has one since #213. */
  async function selectClass(index: number): Promise<void> {
    await userEvent.click(screen.getByTestId("class-list").querySelectorAll("button")[index]);
  }

  async function removeClass(index: number): Promise<void> {
    await selectClass(index);
    await userEvent.click(screen.getByTestId(`remove-class-${index}`));
    await userEvent.click(await screen.findByTestId("remove-class-confirm"));
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
    expect(screen.getByTestId("schema-status").textContent).toContain("Saving creates version 1");
  });

  it("edits a draft and publishes it as the next version", async () => {
    projectWithSchema();
    on("POST", /schema\/versions$/, {
      status: 201,
      body: { project_id: PROJECT, version: 4, classes: CLASSES },
    });

    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    // Versioning is ambient (#213): one persistent line saying what saving would
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
    await removeClass(1);
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
    await removeClass(1);
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
    // One panel at a time since #213, so each class is asserted from its own.
    await selectClass(1);
    expect(screen.getByTestId("class-color-1")).toHaveProperty("value", derived);
    // Never the neutral, which is what it used to be for every derived class.
    expect(screen.getByTestId("class-color-1")).not.toHaveProperty("value", "#888888");

    // And a declared colour is still itself.
    await selectClass(0);
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
    // Dirty by something that is not the colour. An untouched draft sends
    // nothing — the button answers instead of being grey (#213), and that
    // refusal is itself the first half of the guarantee.
    await userEvent.click(screen.getByTestId("save-schema"));
    expect(sent.some((r) => r.method === "POST")).toBe(false);
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
describe("the schema version history", () => {
  /**
   * Three versions with descriptions and moments, the shape #230 put on the wire.
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
    on("POST", /schema\/versions$/, { status: 201, body: { ...VERSIONS[2], version: 4 } });
    await open();

    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(screen.getByTestId("class-name-2"), "pedestrian");
    await userEvent.type(screen.getByTestId("version-note"), "added pedestrians");
    await userEvent.click(screen.getByTestId("save-schema"));

    await waitFor(() => expect(sent.some((r) => r.method === "POST")).toBe(true));
    const request = sent.find((r) => r.method === "POST");
    expect(JSON.parse(bodies.get(request!) ?? "{}").description).toBe("added pedestrians");
  });

  it("omits the key entirely when nobody wrote one", async () => {
    // Blank is legal and the API stores null either way; sending `""` would make
    // an empty box look like a decision in the request log.
    withHistory();
    withDiff(NOTHING);
    on("POST", /schema\/versions$/, { status: 201, body: { ...VERSIONS[2], version: 4 } });
    await open();

    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(screen.getByTestId("class-name-2"), "pedestrian");
    await userEvent.click(screen.getByTestId("save-schema"));

    await waitFor(() => expect(sent.some((r) => r.method === "POST")).toBe(true));
    const request = sent.find((r) => r.method === "POST");
    expect("description" in JSON.parse(bodies.get(request!) ?? "{}")).toBe(false);
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
    on("POST", /schema\/versions$/, { status: 201, body: published });
    await open();
    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(screen.getByTestId("class-name-2"), "pedestrian");

    // The refetch after the save finds a fourth version, which is what the
    // history renders — this is the round trip, not the mutation's own answer.
    handlers.length = 0;
    withHistory([...VERSIONS, published], published);
    withDiff(NOTHING);
    on("POST", /schema\/versions$/, { status: 201, body: published });
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
    geometry: "bbox",
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
      { name: "Vehicle", geometry: "bbox", color: null, attributes: [] },
      { name: "lane", geometry: "polygon", color: null, attributes: [] },
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

  it("states the blast radius when the class being removed carries annotations", async () => {
    withClasses(MANY);
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("remove-class-0"));

    const said = (await screen.findByTestId("remove-class-blast-radius")).textContent ?? "";
    expect(said).toContain((4372).toLocaleString(undefined));
    // And that this removal cannot be published at all, which is the fact that
    // matters: the orphan refusal has no override.
    expect(said).toContain("no override");
  });

  it("says a removal costs nothing when nobody has used the class", async () => {
    withClasses(MANY);
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("class-list").querySelectorAll("button")[1]);
    await userEvent.click(screen.getByTestId("remove-class-1"));

    const said = (await screen.findByTestId("remove-class-blast-radius")).textContent ?? "";
    expect(said).toContain("costs nothing");
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
    await userEvent.click(await screen.findByTestId("remove-class-confirm"));

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
      // "Schema history" since #292: the tab holds schema versions, and the
      // bare "Versions" read as dataset versions. Label only — the union
      // value, testid and `?tab=versions` are public API and stay.
      "Schema history",
    ]);
  });

  it("still opens on Overview for a host with no batch route", async () => {
    project();
    render(mount(<ProjectScreen projectId={PROJECT} />));

    await screen.findByTestId("overview-panel");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Schema",
      "Schema history",
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

  it("shows why and when, and an em dash for a version that recorded neither", async () => {
    // #230's two fields on the ledger. Both are null for a version published
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

    render(mount(<ProjectScreen projectId={PROJECT} tab="versions" />));

    const history = await screen.findByTestId("version-history");
    await within(history).findByTestId("version-1");
    expect(within(history).getByTestId("version-2").textContent).toContain(
      "split vehicle into car and truck",
    );
    expect(within(history).getByTestId("version-1").textContent).toContain("—");
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

  function headerFor(options: {
    description?: string | null;
    schema?: boolean;
    stats?: boolean;
    batchState?: string;
    lastIngest?: unknown;
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
          : { ...STATS, last_ingest_at: options.lastIngest ?? null },
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
    // this project predates migration 13 and cannot be backfilled (#216). Same
    // rule as a missing description: omitted, never placeheld.
    headerFor({});
    render(mount(<ProjectScreen projectId={PROJECT} />));

    await screen.findByTestId("project-chips");
    await waitFor(() => expect(screen.queryByTestId("chip-images")).not.toBeNull());
    expect(screen.queryByTestId("chip-ingested")).toBeNull();
    expect(document.body.textContent).not.toContain("Ingested");
  });

  it("refuses a stats document whose timestamp is not a string", async () => {
    // #225 moved this assertion rather than removing it. It used to read "the chip
    // is simply absent", which was the *symptom* of a document nobody had checked:
    // during #206–#213 the same wrong body white-screened three surfaces, and the
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
