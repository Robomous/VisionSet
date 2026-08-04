/**
 * The add-a-class dialog's own contract: what it refuses, and what it says.
 *
 * The *order* the three calls run in is `addClass.test.ts` — that is the part
 * that loses work when it is wrong. This is the part a person sees.
 *
 * Rendered directly rather than through `AnnotationPage`, because the dialog takes
 * its whole world as props and the page around it is a canvas jsdom cannot lay
 * out. There is no e2e scenario either: the annotator demo has no project behind
 * it, so it renders no button at all (`toolPalette.test.tsx` asserts that), which
 * is the acceptance criterion's own "else the ui-core screen-test convention".
 */

import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { JSX } from "react";

import { ApiError } from "../data/errors";
import { AddClassDialog } from "./AddClassDialog";
import type { SchemaVersion } from "../screens/queries";

const ACTIVE = {
  project_id: "11111111-1111-4111-8111-111111111111",
  version: 3,
  classes: [
    { name: "sign", geometry: "bbox", color: null, attributes: [] },
    { name: "lane", geometry: "polygon", color: "#f97316", attributes: [] },
  ],
  description: null,
  created_at: null,
} as unknown as SchemaVersion;

function mount(overrides: Partial<Parameters<typeof AddClassDialog>[0]> = {}): JSX.Element {
  return (
    <AddClassDialog
      open
      onOpenChange={vi.fn()}
      active={ACTIVE}
      pinnedVersion={2}
      canRepin
      pending={false}
      error={null}
      onSubmit={vi.fn()}
      {...overrides}
    />
  );
}

describe("what the dialog refuses before it asks", () => {
  it("will not submit a nameless class", async () => {
    render(mount());

    expect(screen.getByTestId("add-class-submit")).toHaveProperty("disabled", true);

    await userEvent.type(screen.getByTestId("class-name-new"), "crossing");

    expect(screen.getByTestId("add-class-submit")).toHaveProperty("disabled", false);
  });

  it("will not submit a name the active version already declares, ignoring case", async () => {
    // `create_version` refuses a collision case-insensitively, so this mirrors the
    // API's rule rather than inventing a second one — and it explains beside the
    // field instead of failing after a round trip.
    render(mount());

    await userEvent.type(screen.getByTestId("class-name-new"), "SIGN");

    expect(screen.getByTestId("add-class-submit")).toHaveProperty("disabled", true);
    expect(screen.getByText(/already declares a class/)).toBeTruthy();
  });

  it("will not submit before the active version has loaded", async () => {
    // Composing on nothing would publish a version holding one class and drop
    // every other — the exact destructive change this flow exists never to make.
    render(mount({ active: null }));

    await userEvent.type(screen.getByTestId("class-name-new"), "crossing");

    expect(screen.getByTestId("add-class-submit")).toHaveProperty("disabled", true);
  });

  it("stops asking while a request is in flight", () => {
    render(mount({ pending: true }));

    expect(screen.getByTestId("add-class-submit")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("add-class-submit").textContent).toContain("Publishing");
  });
});

describe("what it submits", () => {
  it("hands over the class and the description it filled in", async () => {
    const submit = vi.fn();
    render(mount({ onSubmit: submit }));

    await userEvent.type(screen.getByTestId("class-name-new"), "crossing");
    await userEvent.click(screen.getByTestId("add-class-submit"));

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ name: "crossing", geometry: "bbox" }),
      'Added class "crossing" from the annotation view',
    );
  });

  it("keeps what somebody typed over the description it suggested", async () => {
    const submit = vi.fn();
    render(mount({ onSubmit: submit }));

    await userEvent.type(screen.getByTestId("class-name-new"), "crossing");
    await userEvent.clear(screen.getByTestId("add-class-note"));
    await userEvent.type(screen.getByTestId("add-class-note"), "the survey needs it");
    await userEvent.click(screen.getByTestId("add-class-submit"));

    expect(submit).toHaveBeenCalledWith(expect.anything(), "the survey needs it");
  });

  it("trims the name, so a stray space is not a different class", async () => {
    const submit = vi.fn();
    render(mount({ onSubmit: submit }));

    await userEvent.type(screen.getByTestId("class-name-new"), "  crossing  ");
    await userEvent.click(screen.getByTestId("add-class-submit"));

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ name: "crossing" }),
      expect.anything(),
    );
  });

  it("offers the geometry picker, because picking a class picks a tool", async () => {
    render(mount());

    // The shared `ClassFields` is what makes this the same picker the Schema tab
    // offers — three geometries, and the five an annotation cannot carry absent.
    expect(screen.getByTestId("class-geometry-new")).toBeTruthy();
  });
});

describe("the refusal it has to make legible", () => {
  it("renders a refusal with its code, which is what a client branches on", () => {
    render(
      mount({
        // A real `ApiError`, not a shaped object: `asApiError` returns
        // `NETWORK_ERROR` for anything that is not one, so a plain literal here
        // would test the fallback rather than the refusal.
        error: new ApiError(
          {
            code: "SCHEMA_VERSION_CONFLICT",
            message: "another writer created this schema version first",
          },
          409,
        ),
      }),
    );

    const alert = screen.getByTestId("add-class-error");
    expect(alert.textContent).toContain("another writer created this schema version first");
  });

  it("names where to look when the re-pin was the step that refused", () => {
    // The one refusal whose remedy is somewhere else: `repin` has no flag for it
    // on purpose, because the pin did not move due to somebody *else* narrowing
    // the schema. Saying "retry" there would be a lie.
    render(
      mount({
        error: new ApiError(
          {
            code: "DESTRUCTIVE_SCHEMA_CHANGE",
            message: "re-pinning narrows what this batch allows",
          },
          409,
        ),
      }),
    );

    const alert = screen.getByTestId("add-class-error");
    expect(alert.textContent).toContain("still on v2");
    expect(alert.textContent).toContain("Schema tab");
  });
});

/**
 * The half-applied chain, and the sentence that replaces it — audit finding F23.
 *
 * `REPINNABLE_STATES` excludes `completed`, so on a settled batch the old chain
 * published a schema version and *then* had the re-pin refused: a new version in
 * the project, a batch still judged against the old one, and an error about a
 * step nobody asked for. Nothing was recoverable by pressing anything.
 *
 * The remedy is not a rollback — three requests are not a transaction and cannot
 * be — it is asking first, and saying what the press will do before it is
 * pressed.
 */
describe("what it promises when the batch will not take the pin", () => {
  it("says the batch keeps its version, and names what does happen", async () => {
    render(mount({ canRepin: false }));
    await userEvent.type(screen.getByTestId("class-name-new"), "cone");

    const notice = screen.getByTestId("no-repin-notice");
    expect(notice.textContent).toMatch(/stay on its current version/i);
    // The half that is not a loss: the version is still published, and the next
    // batch approved will pin to it. A warning that only said "no" would leave
    // the user unable to tell whether pressing was worth anything.
    expect(notice.textContent).toMatch(/still published/i);
    expect(notice.textContent).toContain("cone");
  });

  it("says so on the button, which is the choice being made explicit", async () => {
    render(mount({ canRepin: false }));
    // Not a disabled button and not a second dialog: the act is legitimate, and
    // what changed is only what it promises. Two acts, two words.
    expect(screen.getByTestId("add-class-submit").textContent).toMatch(/without re-pinning/i);
  });

  it("says none of that when the batch will take the pin", () => {
    render(mount({ canRepin: true }));
    expect(screen.queryByTestId("no-repin-notice")).toBeNull();
    expect(screen.getByTestId("add-class-submit").textContent).toMatch(/add class/i);
  });

  it("still submits, because publishing without a re-pin is a real thing to want", async () => {
    const onSubmit = vi.fn();
    render(mount({ canRepin: false, onSubmit }));
    await userEvent.type(screen.getByTestId("class-name-new"), "cone");
    await userEvent.click(screen.getByTestId("add-class-submit"));

    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
