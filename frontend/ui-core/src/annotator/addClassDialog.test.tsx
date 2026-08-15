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
    { name: "sign", geometries: ["bbox"], color: null, attributes: [] },
    { name: "lane", geometries: ["polygon"], color: "#f97316", attributes: [] },
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

  it("offers to widen a class the active version already declares, ignoring case", async () => {
    // A name that exists is not a refusal. `create_version` compares names
    // case-insensitively, so "SIGN" lands on "sign" — and what somebody typing it
    // wants is almost always to draw that class as a shape it does not have yet.
    const onSubmit = vi.fn();
    render(mount({ onSubmit }));

    await userEvent.type(screen.getByTestId("class-name-new"), "SIGN");
    // The form starts on `bbox`, which "sign" already accepts, so there is
    // nothing to add yet and *that* is the refusal — with the remedy named.
    expect(screen.getByTestId("add-class-submit")).toHaveProperty("disabled", true);
    expect(screen.getByText(/adds nothing to it/)).toBeTruthy();

    await userEvent.click(screen.getByTestId("class-geometry-new-polygon"));

    const offer = screen.getByTestId("widen-offer");
    expect(offer.textContent).toContain("“sign” already exists");
    expect(offer.textContent).toContain("declares it as bbox");
    const submit = screen.getByTestId("add-class-submit");
    expect(submit).toHaveProperty("disabled", false);
    // The button says what it does, rather than "Add class".
    expect(submit.textContent).toContain("Add polygon to “sign”");
  });

  it("widens the existing class rather than writing a second one", async () => {
    const onSubmit = vi.fn();
    render(mount({ onSubmit }));

    await userEvent.type(screen.getByTestId("class-name-new"), "SIGN");
    await userEvent.click(screen.getByTestId("class-geometry-new-polygon"));
    await userEvent.click(screen.getByTestId("add-class-submit"));

    // The **existing** class's own name and colour, widened — not the form's. The
    // form was opened to make a new class, so publishing its blank colour would
    // quietly wipe what "sign" already declared.
    expect(onSubmit).toHaveBeenCalledWith(
      [{ name: "sign", geometries: ["bbox", "polygon"], color: null, attributes: [] }],
      expect.anything(),
    );
  });

  it("still refuses a name typed twice in one sitting, which has nothing to offer", async () => {
    // The other collision, and the one that stays a refusal: both entries are
    // being written now, so merging them would be guessing which was meant.
    render(mount());

    await userEvent.type(screen.getByTestId("class-name-new"), "crossing");
    await userEvent.click(screen.getByTestId("add-another"));
    await userEvent.type(screen.getByTestId("class-name-new"), "CROSSING");

    expect(screen.getByTestId("add-class-submit")).toHaveProperty("disabled", true);
    expect(screen.getByText(/already added a class/)).toBeTruthy();
    expect(screen.queryByTestId("widen-offer")).toBeNull();
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
      [expect.objectContaining({ name: "crossing", geometries: ["bbox"] })],
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
      [expect.objectContaining({ name: "crossing" })],
      expect.anything(),
    );
  });

  it("offers the geometry picker, because picking a class picks a tool", async () => {
    render(mount());

    // The shared `ClassFields` is what makes this the same picker the Schema tab
    // offers — four geometries, and the four an annotation cannot carry absent.
    expect(screen.getByTestId("class-geometry-new")).toBeTruthy();
  });

  /**
   * The second surface for grouped geometry choices. Both pickers share
   * `ClassFields`, so grouping arrives here without a second call site — and this
   * is the test that says so, because "they share a component" is a fact about
   * today's code and the claim worth pinning is about what a person sees.
   */
  it("groups the geometries under their category, the same as the Schema tab", async () => {
    render(mount());

    // No press: the boxes are already on the page. See the Schema tab's twin.
    const basic = screen.getByTestId("geometry-category-Basic Computer Vision");
    const robotics = screen.getByTestId("geometry-category-Robotics and AD");
    const membersOf = (label: HTMLElement): string[] =>
      [...(label.parentElement?.querySelectorAll("label") ?? [])].map(
        (option) => option.textContent ?? "",
      );

    expect(membersOf(basic)).toEqual(["bbox", "polygon", "classification_tag"]);
    expect(membersOf(robotics)).toEqual(["polyline"]);
  });

  /**
   * The regression pin for the annotator's half: a class's geometry is what
   * `toolFor` reads to decide which tool a hotkey arms, so a picker that grouped
   * its options and stopped writing one would break drawing rather than layout.
   */
  it("writes every geometry ticked onto the class it will publish", async () => {
    const onSubmit = vi.fn();
    render(mount({ onSubmit }));

    await userEvent.type(screen.getByTestId("class-name-new"), "centre-line");
    // Tick the second before clearing the first, which is also the only order
    // the control allows: a class never passes through accepting nothing.
    await userEvent.click(screen.getByTestId("class-geometry-new-polyline"));
    await userEvent.click(screen.getByTestId("class-geometry-new-bbox"));
    await userEvent.click(screen.getByTestId("add-class-submit"));

    expect(onSubmit).toHaveBeenCalledWith(
      [expect.objectContaining({ name: "centre-line", geometries: ["polyline"] })],
      expect.anything(),
    );
  });

  it("publishes a class accepting two shapes, which is what a set is for", async () => {
    const onSubmit = vi.fn();
    render(mount({ onSubmit }));

    // A name the active version does not hold: "sign" would land on the widening
    // path below, which is a different test.
    await userEvent.type(screen.getByTestId("class-name-new"), "kerb");
    await userEvent.click(screen.getByTestId("class-geometry-new-polygon"));
    await userEvent.click(screen.getByTestId("add-class-submit"));

    expect(onSubmit).toHaveBeenCalledWith(
      [expect.objectContaining({ name: "kerb", geometries: ["bbox", "polygon"] })],
      expect.anything(),
    );
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
  it("does not also promise the batch will move, which the notice denies", () => {
    // The description was unconditional and contradicted the notice below it:
    // one promised the batch would move onto the version, the other said it
    // would stay. Only one of them can be true on a completed batch.
    render(mount({ canRepin: false }));

    const dialog = screen.getByTestId("add-class-dialog");
    expect(dialog.textContent).toContain("publishes as one schema version");
    expect(dialog.textContent).not.toContain("moves this batch onto it");
  });

  it("still promises it where the batch will take the pin", () => {
    render(mount({ canRepin: true }));

    expect(screen.getByTestId("add-class-dialog").textContent).toContain(
      "moves this batch onto it",
    );
  });

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

  it("names every class of the session, since by then the form is empty", async () => {
    // The notice interpolated the *form field*, which is right for one class and
    // names nothing at all once the classes are banked and the field has been
    // cleared for the next one. The mechanism — `canRepin`, the two sentences —
    // is untouched; only what it points at is.
    render(mount({ canRepin: false }));

    await userEvent.type(screen.getByTestId("class-name-new"), "cone");
    await userEvent.click(screen.getByTestId("add-another"));
    await userEvent.type(screen.getByTestId("class-name-new"), "barrier");
    await userEvent.click(screen.getByTestId("add-another"));

    const notice = screen.getByTestId("no-repin-notice");
    expect(notice.textContent).toContain("cone");
    expect(notice.textContent).toContain("barrier");
  });
});

/**
 * One dialog session is one published version.
 *
 * The point is not the request — `create_version` takes the whole contract
 * whether it holds one new class or three — it is the re-pins and refetches that
 * do not happen, and the ledger rows that are not written. `addClass.test.ts`
 * asserts the chain runs once; this is what a person does to get there.
 */
describe("adding several classes in one sitting", () => {
  it("banks a class and clears the form for the next one", async () => {
    render(mount());

    await userEvent.type(screen.getByTestId("class-name-new"), "cone");
    await userEvent.click(screen.getByTestId("add-another"));

    expect(screen.getByTestId("session-class-cone")).toBeTruthy();
    // Cleared, not left holding the class that was just banked — otherwise the
    // next `and another` would bank it twice and the primary would publish a
    // duplicate the API refuses.
    expect(screen.getByTestId("class-name-new")).toHaveProperty("value", "");
  });

  it("publishes the banked classes and the form's own, in one press", async () => {
    const submit = vi.fn();
    render(mount({ onSubmit: submit }));

    // **Banked twice**, deliberately: with one banked class a session that
    // *replaced* rather than accumulated would publish the same two names, so
    // the shorter version of this test cannot tell accumulation from overwriting.
    await userEvent.type(screen.getByTestId("class-name-new"), "cone");
    await userEvent.click(screen.getByTestId("add-another"));
    await userEvent.type(screen.getByTestId("class-name-new"), "barrier");
    await userEvent.click(screen.getByTestId("add-another"));
    await userEvent.type(screen.getByTestId("class-name-new"), "crossing");
    await userEvent.click(screen.getByTestId("add-class-submit"));

    // The form counts without being banked first: somebody who wrote the last
    // class and pressed the primary is done, and making them press `and another`
    // first would be a ceremony the implementation needs and the person does not.
    expect(submit).toHaveBeenCalledWith(
      [
        expect.objectContaining({ name: "cone" }),
        expect.objectContaining({ name: "barrier" }),
        expect.objectContaining({ name: "crossing" }),
      ],
      'Added classes "cone", "barrier" and "crossing" from the annotation view',
    );
  });

  it("publishes the banked classes when the form is empty", async () => {
    const submit = vi.fn();
    render(mount({ onSubmit: submit }));

    await userEvent.type(screen.getByTestId("class-name-new"), "cone");
    await userEvent.click(screen.getByTestId("add-another"));
    await userEvent.click(screen.getByTestId("add-class-submit"));

    expect(submit).toHaveBeenCalledWith([expect.objectContaining({ name: "cone" })], expect.anything());
  });

  it("says how many the press will publish", async () => {
    render(mount());

    await userEvent.type(screen.getByTestId("class-name-new"), "cone");
    await userEvent.click(screen.getByTestId("add-another"));
    await userEvent.type(screen.getByTestId("class-name-new"), "barrier");

    expect(screen.getByTestId("add-class-submit").textContent).toContain("Add 2 classes");
  });

  it("banks on ⌘Enter, so a session is typed without leaving the keyboard", async () => {
    render(mount());

    await userEvent.type(screen.getByTestId("class-name-new"), "cone");
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");

    expect(screen.getByTestId("session-class-cone")).toBeTruthy();
  });

  it("lets a banked class be taken back out", async () => {
    render(mount());

    await userEvent.type(screen.getByTestId("class-name-new"), "cone");
    await userEvent.click(screen.getByTestId("add-another"));
    await userEvent.click(screen.getByTestId("session-remove-cone"));

    expect(screen.queryByTestId("session-class-cone")).toBeNull();
    // And with nothing left to publish, the primary goes back to refusing.
    expect(screen.getByTestId("add-class-submit")).toHaveProperty("disabled", true);
  });

  it("refuses a name already banked in this session, and says which rule refused", async () => {
    // The session and the published version go into *one* contract, so
    // `create_version` judges them together — a collision inside the session is
    // refused by the same rule, and a 409 after the save is the worst place to
    // learn it. The two remedies differ, which is why the sentence does.
    render(mount());

    await userEvent.type(screen.getByTestId("class-name-new"), "cone");
    await userEvent.click(screen.getByTestId("add-another"));
    await userEvent.type(screen.getByTestId("class-name-new"), "CONE");

    expect(screen.getByTestId("add-another")).toHaveProperty("disabled", true);
    expect(screen.getByText(/already added a class called/)).toBeTruthy();
  });

  it("will not bank a nameless class", async () => {
    render(mount());

    expect(screen.getByTestId("add-another")).toHaveProperty("disabled", true);
  });
});

/**
 * Cancelling with classes pending — the one press in here that destroys typing.
 *
 * Everything a session holds lives in the component. There is no draft on the
 * server, so nothing else can see it and nothing can restore it, which is exactly
 * why closing has to ask. Nothing else in this dialog does.
 */
describe("closing with classes pending", () => {
  it("asks before it discards them", async () => {
    const onOpenChange = vi.fn();
    render(mount({ onOpenChange }));

    await userEvent.type(screen.getByTestId("class-name-new"), "cone");
    await userEvent.click(screen.getByTestId("add-another"));
    await userEvent.click(screen.getByTestId("add-class-cancel"));

    expect(screen.getByTestId("discard-session")).toBeTruthy();
    // Still open: an ask that closed anyway would be a notice, not a question.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("goes back to the form when the answer is no", async () => {
    render(mount());

    await userEvent.type(screen.getByTestId("class-name-new"), "cone");
    await userEvent.click(screen.getByTestId("add-another"));
    await userEvent.click(screen.getByTestId("add-class-cancel"));
    await userEvent.click(screen.getByTestId("keep-editing"));

    expect(screen.queryByTestId("discard-session")).toBeNull();
    expect(screen.getByTestId("session-class-cone")).toBeTruthy();
  });

  it("closes when the answer is yes", async () => {
    const onOpenChange = vi.fn();
    render(mount({ onOpenChange }));

    await userEvent.type(screen.getByTestId("class-name-new"), "cone");
    await userEvent.click(screen.getByTestId("add-another"));
    await userEvent.click(screen.getByTestId("add-class-cancel"));
    await userEvent.click(screen.getByTestId("discard-confirm"));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("asks on Escape too, which is the route a button guard walks past", async () => {
    // The guard lives in the close handler rather than on Cancel for exactly
    // this: Radix routes Escape and the overlay through `onOpenChange`, so a
    // check the button owned would protect one of the three ways out.
    const onOpenChange = vi.fn();
    render(mount({ onOpenChange }));

    await userEvent.type(screen.getByTestId("class-name-new"), "cone");
    await userEvent.click(screen.getByTestId("add-another"));
    await userEvent.keyboard("{Escape}");

    expect(screen.getByTestId("discard-session")).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("closes without asking when there is nothing banked", async () => {
    // The form's own contents are not "work somebody accumulated" — they are one
    // half-typed class, and asking about those would train a person to click
    // through the question that matters.
    const onOpenChange = vi.fn();
    render(mount({ onOpenChange }));

    await userEvent.type(screen.getByTestId("class-name-new"), "cone");
    await userEvent.click(screen.getByTestId("add-class-cancel"));

    expect(screen.queryByTestId("discard-session")).toBeNull();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

/**
 * The name the create row typed.
 *
 * `ClassField`'s no-match row hands the typed name over, and dropping it would
 * mean typing a name,
 * being told it does not exist, and typing it again is the smallest possible way
 * to make a shortcut feel like a detour.
 */
describe("the name it opens with", () => {
  it("starts from what the create row was typed with", () => {
    render(mount({ initialName: "crossing" }));

    expect(screen.getByTestId("class-name-new")).toHaveProperty("value", "crossing");
  });

  it("is still editable, because a prefill is a starting point and not a binding", async () => {
    const submit = vi.fn();
    render(mount({ initialName: "crossing", onSubmit: submit }));

    await userEvent.clear(screen.getByTestId("class-name-new"));
    await userEvent.type(screen.getByTestId("class-name-new"), "cone");
    await userEvent.click(screen.getByTestId("add-class-submit"));

    expect(submit).toHaveBeenCalledWith([expect.objectContaining({ name: "cone" })], expect.anything());
  });

  it("opens empty when nobody typed anything", () => {
    render(mount());

    expect(screen.getByTestId("class-name-new")).toHaveProperty("value", "");
  });
});
