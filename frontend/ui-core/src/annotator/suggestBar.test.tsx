/**
 * The suggest tool's bar: the six things it can be saying, the choices it offers
 * only while nothing is pending, and the one rule about its action.
 *
 * The three *blocked* readings — none configured, none ready, and the server
 * refusing because this build cannot run the model — are each asserted to carry a
 * remedy rather than a state: a short phrase in the bar, and the full sentence
 * behind its ⓘ, word for word. The structural claim is unchanged from the card
 * this replaced: with no callback there is an explanation and **no control**,
 * never a dead button.
 *
 * Every long sentence is read off `suggest-tip`, the ⓘ's permanent (hidden)
 * description — the same words its card shows on hover and focus, and what a
 * screen reader reaches without opening anything. One case opens the card to
 * prove the two are the same words.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX } from "react";

import { answered, armed, detecting, refused, withChoice, withClass, withPoint } from "@visionset/annotator";
import type { Answer, Suggestion, SuggestionState } from "@visionset/annotator";
import { TooltipProvider } from "@robomous/ui-core";

import { SuggestBar } from "./SuggestBar";
import { usableConnection, type Connection } from "../data/inferenceQueries";
import type {
  BrowserModelAcquisition,
  BrowserModelCatalogEntry,
  BrowserSuggestionTarget,
} from "../inference/browserPort.js";
import { stubResizeObserver } from "../testing/resizeObserver.js";

const A_BOX = { type: "bbox", x: 10, y: 20, width: 30, height: 40 } as const;

const MODEL_REF = "facebook/sam2-hiera-base-plus@main";

beforeEach(() => {
  stubResizeObserver();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function proposal(): Suggestion {
  return { geometry: A_BOX, confidence: 0.9, modelRef: MODEL_REF, contour: [] };
}

/** An answer carrying those shapes, with every parameter declared as applying. */
function answerOf(...suggestions: readonly Suggestion[]): Answer {
  return {
    modelRef: MODEL_REF,
    confidence: suggestions[0]?.confidence ?? null,
    suggestions,
    parameters: ["tolerance"],
  };
}

function asked(): SuggestionState {
  return withPoint(armed("vehicle"), [100, 120], "positive");
}

function shown(): SuggestionState {
  const session = asked();
  return answered(session, session.serial, answerOf(proposal()));
}

function mount(overrides: Partial<Parameters<typeof SuggestBar>[0]> = {}): JSX.Element {
  return (
    <TooltipProvider>
      <SuggestBar
        session={armed("vehicle")}
        heldClass="vehicle"
        blocker={null}
        refusal={null}
        onAccept={vi.fn()}
        onDiscard={vi.fn()}
        {...overrides}
      />
    </TooltipProvider>
  );
}

/** The ⓘ's words, as its permanent description holds them. */
function tip(): string {
  return screen.getByTestId("suggest-tip").textContent ?? "";
}

function tone(): string | null {
  return screen.getByTestId("suggest-status").getAttribute("data-tone");
}

/** A connection row, in whichever setup state and capability a case needs. */
function connection(
  setup: Connection["setup_state"],
  overrides: Partial<Connection> = {},
): Connection {
  return {
    id: "c1",
    name: "local sam",
    connection_type: "local",
    model_id: "facebook/sam2-hiera-base-plus",
    model_revision: "main",
    device: "cuda",
    precision: "fp16",
    endpoint_url: null,
    provider_id: "sam",
    credential_env: null,
    origin: "huggingface",
    setup_state: setup,
    allowed_actions: [],
    // Resolved by the server from the model's own config, and empty until
    // something has read one — which is why a row that never downloaded
    // declares nothing.
    capabilities: setup === "ready" ? ["point_suggest"] : [],
    produces: setup === "ready" ? ["bbox", "polygon"] : [],
    download: null,
    integrity_check: null,
    created_at: "2026-08-08T00:00:00Z",
    updated_at: "2026-08-08T00:00:00Z",
    ...overrides,
  } as Connection;
}

/** The one the reproduction had: ready, and it answers words rather than points. */
function aDetector(id = "d1"): Connection {
  return connection("ready", {
    id,
    name: "grounding dino",
    model_id: "IDEA-Research/grounding-dino-tiny",
    capabilities: ["text_detect"],
  });
}

describe("which connection a click goes through", () => {
  it("is none, and says why, when the workspace has configured none", () => {
    expect(usableConnection([])).toEqual({
      connection: null,
      candidates: [],
      blocker: "no-connections",
    });
  });

  it("is none, and says why, when one exists but its weights are not here", () => {
    expect(usableConnection([connection("not_set_up")])).toEqual({
      connection: null,
      candidates: [],
      blocker: "not-ready",
    });
  });

  it("is the first capable one, in the list's own order", () => {
    const ready = connection("ready", { id: "c2" });
    const answer = usableConnection([connection("not_set_up"), ready, connection("ready")]);
    expect(answer.connection).toBe(ready);
    expect(answer.blocker).toBe(null);
  });

  it("never picks a ready connection whose model answers a different question", () => {
    // The bug this whole slice exists for. `find(setup_state === "ready")` sent
    // every point-prompt click to whatever was ready, and a workspace holding
    // only a text-prompt detector got a truthful refusal per click.
    const answer = usableConnection([aDetector()]);
    expect(answer.connection).toBe(null);
    expect(answer.blocker).toBe("not-capable");
  });

  it("looks past one to a connection that can answer", () => {
    const sam = connection("ready", { id: "c2" });
    const answer = usableConnection([aDetector(), sam]);
    expect(answer.connection).toBe(sam);
    expect(answer.candidates).toEqual([sam]);
  });

  it("says the weights are missing before it says the model is the wrong kind", () => {
    // An undownloaded connection has no capability *yet*, so ranking capability
    // first would answer "wrong kind of model" where the truth is "not here".
    expect(usableConnection([connection("not_set_up")]).blocker).toBe("not-ready");
  });

  it("honours a remembered choice, and falls back rather than blocking on a stale one", () => {
    const first = connection("ready", { id: "c1" });
    const second = connection("ready", { id: "c2", name: "the other sam" });

    expect(usableConnection([first, second], "c2").connection).toBe(second);
    // A connection somebody deleted must not leave a project unable to suggest.
    expect(usableConnection([first, second], "gone").connection).toBe(first);
  });

  it("names the loading window rather than pretending it is a working tool", () => {
    // The list is only fetched once the tool is armed, so this window is real —
    // and a click landing in it must be told something rather than vanishing.
    expect(usableConnection(undefined)).toEqual({
      connection: null,
      candidates: [],
      blocker: "checking",
    });
  });
});

describe("the no-connection reading (D6)", () => {
  it("says what is missing when nothing is configured, and offers the way out", async () => {
    const onConfigure = vi.fn();
    render(mount({ blocker: "no-connections", onConfigure }));

    expect(screen.getByTestId("suggest-no-connections").textContent).toBe("No model connection");
    expect(tone()).toBe("warn");
    expect(tip()).toContain("this workspace has none configured");
    await userEvent.click(screen.getByTestId("suggest-configure"));
    expect(onConfigure).toHaveBeenCalledTimes(1);
  });

  it("tells a configured-but-undownloaded connection apart from no connection", () => {
    render(mount({ blocker: "not-ready", onConfigure: vi.fn() }));
    expect(screen.getByTestId("suggest-not-ready")).toBeTruthy();
    expect(screen.queryByTestId("suggest-no-connections")).toBeNull();
    // Two states, two sentences: one is a thing to make and the other is a
    // download, and a shared message would send somebody to the wrong remedy.
    expect(tip()).toContain("not on this machine");
  });

  it("is not a warning while it is merely checking", () => {
    render(mount({ blocker: "checking" }));
    expect(screen.getByTestId("suggest-checking")).toBeTruthy();
    expect(tone()).not.toBe("warn");
    expect(tone()).toBe("busy");
  });

  /**
   * The structural claim. `ui-core` imports no router, so where "set one up"
   * goes is the host's — and a host that has nowhere to send somebody must get
   * the explanation with nothing to press, never a control that does nothing.
   */
  it("renders the explanation and no control when the host wires no destination", () => {
    render(mount({ blocker: "no-connections" }));
    expect(screen.getByTestId("suggest-no-connections")).toBeTruthy();
    expect(tip()).toContain("Set one up once");
    expect(screen.queryByTestId("suggest-configure")).toBeNull();
  });

  it("never renders an action for the checking state, callback or not", () => {
    render(mount({ blocker: "checking", onConfigure: vi.fn() }));
    expect(screen.queryByTestId("suggest-configure")).toBeNull();
  });

  it("outranks whatever the session was doing", () => {
    // A session over a workspace with no usable connection has nothing to report
    // about a request it never made.
    render(mount({ session: shown(), blocker: "no-connections" }));
    expect(screen.getByTestId("suggest-no-connections")).toBeTruthy();
    expect(screen.queryByTestId("suggest-accept")).toBeNull();
  });
});

describe("what the bar says while the tool is working", () => {
  it("invites the first click", () => {
    render(mount());
    expect(screen.getByTestId("suggest-idle").textContent).toBe("Click the thing you want");
    expect(tip()).toContain("“vehicle”");
  });

  it("keeps the long sentence one hover away, and the same words as the button's description", async () => {
    render(mount());

    const info = screen.getByTestId("suggest-info");
    // A screen reader hears the sentence as the button's description without
    // opening anything — the card is supplementary to it, never the only route.
    expect(info.getAttribute("aria-describedby")).toBe(screen.getByTestId("suggest-tip").id);
    expect(screen.queryByTestId("suggest-tip-card")).toBeNull();

    act(() => info.focus());
    const card = await screen.findByTestId("suggest-tip-card");
    expect(card.textContent).toContain(tip());
  });

  it("is one row: no collapse control, because nothing floats over the picture", () => {
    render(mount({ session: shown() }));
    expect(screen.queryByTestId("suggest-panel")).toBeNull();
    expect(screen.queryByTestId("suggest-panel-collapse")).toBeNull();
    const bar = screen.getByTestId("suggest-bar");
    expect(bar.contains(screen.getByTestId("suggest-accept"))).toBe(true);
    expect(bar.contains(screen.getByTestId("suggest-discard"))).toBe(true);
  });

  it("says a request is in flight, in the async vocabulary and not a new spinner", () => {
    render(mount({ session: asked() }));
    expect(screen.getByTestId("suggest-asking").textContent).toBe("Looking at that…");
    expect(tone()).toBe("busy");
    expect(screen.queryByTestId("suggest-accept")).toBeNull();
  });

  it("says so on the status alone, with no threshold to cross", () => {
    // The card used to be gated behind a 200ms show delay, and a set of cases
    // here described the window below it. The delay is gone, so the window has no
    // duration and those cases are deleted rather than reworded — the state they
    // named cannot be constructed any more.
    const asking = asked();
    expect(asking.status).toBe("asking");
    render(mount({ session: asking }));
    expect(screen.getByTestId("suggest-asking")).toBeTruthy();
  });

  it("explains a cold start only once the wait is long enough to be one", () => {
    render(mount({ session: asked() }));
    // Nothing more to say on a fast wait, so there is no ⓘ at all.
    expect(screen.queryByTestId("suggest-tip")).toBeNull();
    expect(screen.queryByTestId("suggest-info")).toBeNull();

    cleanup();
    render(mount({ session: asked(), pendingEscalated: true }));
    expect(tip()).toContain("The first click on a frame is the slow one");
  });

  it("reports a refine the same way it reports a first click", () => {
    // The shape being refined stays drawn on the canvas throughout —
    // `paintSuggestion` tests what the session holds rather than what its status
    // is — so the bar describing the ask rather than the shape costs nothing.
    const refining = withPoint(shown(), [140, 160], "positive");
    render(mount({ session: refining }));

    expect(screen.getByTestId("suggest-asking")).toBeTruthy();
    expect(screen.queryByTestId("suggest-shown")).toBeNull();
  });

  it("offers accept again the moment the newer answer lands", () => {
    const refining = withPoint(shown(), [140, 160], "positive");
    const back = answered(refining, refining.serial, answerOf(proposal()));
    render(mount({ session: back }));

    expect((screen.getByTestId("suggest-accept") as HTMLButtonElement).disabled).toBe(false);
  });

  it("offers accept and discard once something is showing, with their keys", async () => {
    const onAccept = vi.fn();
    const onDiscard = vi.fn();
    render(mount({ session: shown(), onAccept, onDiscard }));

    expect(screen.getByTestId("suggest-shown")).toBeTruthy();
    expect(tip()).toBe("Click again to refine it — alt-click to take a part away.");
    expect(screen.getByTestId("suggest-accept").textContent).toContain("↵");
    expect(screen.getByTestId("suggest-discard").textContent).toContain("Esc");
    await userEvent.click(screen.getByTestId("suggest-accept"));
    expect(onAccept).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByTestId("suggest-discard"));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("treats an answer with nothing in it as an answer, and says what to try", async () => {
    const onDiscard = vi.fn();
    const session = asked();
    render(mount({ session: answered(session, session.serial, answerOf()), onDiscard }));
    expect(screen.getByTestId("suggest-none")).toBeTruthy();
    expect(tip()).toContain("Click nearer the middle of the object");
    expect(screen.queryByTestId("suggest-accept")).toBeNull();
    // The points can still be taken back from the bar, not only with the key.
    await userEvent.click(screen.getByTestId("suggest-discard"));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
});

describe("parked over a class that can hold nothing (#472)", () => {
  function parked(): SuggestionState {
    return withClass(shown(), null);
  }

  it("names the class the person just picked, and says the tool is still on", () => {
    render(mount({ session: parked(), heldClass: "lane" }));

    expect(screen.getByTestId("suggest-parked").textContent).toContain("lane");
    // The sentence principle 9 requires beside the strip's dimmed button: what to
    // change, and that nothing needs turning back on.
    expect(tip()).toContain("box or a polygon");
    expect(tip()).toContain("still armed");
    expect(tone()).toBe("calm");
  });

  it("offers the way out, which is the only one while the strip button is dimmed", async () => {
    const onDiscard = vi.fn();
    render(mount({ session: parked(), heldClass: "lane", onDiscard }));

    await userEvent.click(screen.getByTestId("suggest-discard"));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    // No `Esc` chip: the chord is a substitution the canvas makes while something
    // is pending, and a parked session has nothing pending.
    expect(screen.getByTestId("suggest-bar").textContent).not.toContain("Esc");
  });

  it("outranks the blocker, which is not the thing standing in the way", () => {
    render(mount({ session: parked(), heldClass: "lane", blocker: "checking" }));

    expect(screen.getByTestId("suggest-parked")).toBeTruthy();
    // "Getting the model ready" would report progress towards something that is
    // not going to happen, and hide the one choice the person can change.
    expect(screen.queryByTestId("suggest-checking")).toBeNull();
  });

  it("has a phrase for a workspace sitting on no class at all", () => {
    render(mount({ session: parked(), heldClass: null }));
    expect(screen.getByTestId("suggest-parked").textContent).toContain("Nothing selected");
  });

  it("offers no choice of where it runs, which model, or which shape", () => {
    render(
      mount({
        session: parked(),
        heldClass: "lane",
        candidates: [connection("ready")],
        connectionId: "c1",
        browserTargets: [],
        shape: { kinds: ["bbox", "polygon"], value: "bbox", onChoose: vi.fn() },
      }),
    );
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByTestId("suggest-connection")).toBeNull();
  });
});

describe("a refusal", () => {
  /**
   * The one that matters most: `LOCAL_INFERENCE_UNAVAILABLE` is
   * `expose_message=True` precisely so the install command reaches a person, and
   * a sentence written in the client would throw it away.
   */
  it("shows the server's own words, including the install command", () => {
    const session = asked();
    const prose =
      "running a model locally needs the 'local-inference' extra, and 'torch' is not " +
      'installed here. Install it with: pip install "visionset[local-inference]"';
    render(mount({ session: refused(session, session.serial, prose), refusal: prose }));

    expect(screen.getByTestId("suggest-refused").textContent).toBe("Suggestion refused");
    // Verbatim, first, and whole — not reworded and not cut.
    expect(tip().startsWith(prose)).toBe(true);
    expect(tone()).toBe("warn");
  });

  it("says the clicks survive it, because they do", async () => {
    const onDiscard = vi.fn();
    const session = asked();
    render(mount({ session: refused(session, session.serial, "nope"), refusal: "nope", onDiscard }));
    expect(tip()).toContain("press Esc to clear them");
    expect(screen.queryByTestId("suggest-accept")).toBeNull();
    await userEvent.click(screen.getByTestId("suggest-discard"));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
});

describe("the wrong-kind reading", () => {
  it("says what the model answers instead, and offers the way out", async () => {
    const onConfigure = vi.fn();
    render(mount({ blocker: "not-capable", onConfigure }));

    expect(screen.getByTestId("suggest-not-capable").textContent).toContain("different question");
    expect(tip()).toContain("answer something else");
    expect(tone()).toBe("warn");
    await userEvent.click(screen.getByTestId("suggest-configure"));
    expect(onConfigure).toHaveBeenCalledTimes(1);
  });

  it("is a different phrase from having nothing configured or nothing downloaded", () => {
    render(mount({ blocker: "not-capable" }));
    expect(screen.queryByTestId("suggest-no-connections")).toBeNull();
    expect(screen.queryByTestId("suggest-not-ready")).toBeNull();
  });
});

describe("which connection a click goes through, in the bar", () => {
  const SAM = connection("ready", { id: "c1", name: "local sam" });
  const OTHER = connection("ready", {
    id: "c2",
    name: "the big one",
    model_id: "facebook/sam2-hiera-large",
  });

  it("names the one there is, with no control to press", () => {
    render(mount({ candidates: [SAM], connectionId: "c1", onChooseConnection: vi.fn() }));

    expect(screen.getByTestId("suggest-connection").textContent).toBe("local sam");
    // A picker over a single option is a decision nobody has, and it would sit
    // in the editor asking to be read on every job.
    expect(screen.queryByTestId("suggest-connection-select")).toBeNull();
  });

  it("offers a picker once there is a choice, showing the model under each name", async () => {
    const onChooseConnection = vi.fn();
    render(mount({ candidates: [SAM, OTHER], connectionId: "c2", onChooseConnection }));

    const trigger = screen.getByTestId("suggest-connection-select");
    expect(trigger.textContent).toContain("the big one");
    expect(screen.queryByTestId("suggest-connection")).toBeNull();

    await userEvent.click(trigger);
    // Two connections onto the same weights are told apart by the model line.
    const other = await screen.findByRole("option", { name: /the big one/ });
    expect(other.textContent).toContain("facebook/sam2-hiera-large");
    await userEvent.click(screen.getByRole("option", { name: /local sam/ }));
    expect(onChooseConnection).toHaveBeenCalledWith("c1");
  });

  it("names the active one rather than a dead control when the host cannot honour a choice", () => {
    // `onConfigure`'s standing rule, applied to the second control this tool
    // grew: an explanation with no control beats a control that does nothing.
    render(mount({ candidates: [SAM, OTHER], connectionId: "c2" }));
    expect(screen.getByTestId("suggest-connection").textContent).toContain("the big one");
    expect(screen.queryByTestId("suggest-connection-select")).toBeNull();
  });

  it("is absent while something is in flight or waiting to be accepted", () => {
    // Changing which model answers while an answer is on screen would leave a
    // proposal that nothing in the bar explains.
    for (const session of [asked(), shown()]) {
      const view = render(
        mount({ session, candidates: [SAM, OTHER], connectionId: "c1", onChooseConnection: vi.fn() }),
      );
      expect(screen.queryByTestId("suggest-connection-select")).toBeNull();
      expect(screen.queryByTestId("suggest-connection")).toBeNull();
      view.unmount();
    }
  });

  it("is absent while the tool is blocked, which has nothing to choose between", () => {
    render(
      mount({
        blocker: "not-ready",
        candidates: [SAM, OTHER],
        connectionId: "c1",
        onChooseConnection: vi.fn(),
      }),
    );
    expect(screen.queryByTestId("suggest-connection-select")).toBeNull();
  });
});

describe("the shape it returns, for a class that admits both", () => {
  it("offers box or polygon, on the preference the strip and the row already write", async () => {
    const onChoose = vi.fn();
    render(mount({ shape: { kinds: ["bbox", "polygon"], value: "bbox", onChoose } }));

    const group = screen.getByRole("radiogroup", { name: "Shape" });
    expect(group).toBeTruthy();
    expect(screen.getByTestId("suggest-shape-bbox").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("suggest-shape-polygon").getAttribute("aria-checked")).toBe("false");

    await userEvent.click(screen.getByTestId("suggest-shape-polygon"));
    expect(onChoose).toHaveBeenCalledWith("polygon");
  });

  it("moves the choice with the arrow keys, one tab stop for the group", () => {
    const onChoose = vi.fn();
    render(mount({ shape: { kinds: ["bbox", "polygon"], value: "bbox", onChoose } }));

    expect(screen.getByTestId("suggest-shape-bbox").tabIndex).toBe(0);
    expect(screen.getByTestId("suggest-shape-polygon").tabIndex).toBe(-1);
    fireEvent.keyDown(screen.getByTestId("suggest-shape-bbox"), { key: "ArrowRight" });
    expect(onChoose).toHaveBeenCalledWith("polygon");
  });

  it("offers nothing for a class with one shape — no choice is invented", () => {
    render(mount({ shape: { kinds: ["bbox"], value: "bbox", onChoose: vi.fn() } }));
    expect(screen.queryByRole("radiogroup", { name: "Shape" })).toBeNull();
  });

  it("is absent while something is pending, like every other choice", () => {
    render(mount({ session: shown(), shape: { kinds: ["bbox", "polygon"], value: "bbox", onChoose: vi.fn() } }));
    expect(screen.queryByRole("radiogroup", { name: "Shape" })).toBeNull();
  });
});

describe("Detail, inline in the bar", () => {
  /** An answer declaring the parameters a polygon class gets. */
  function polygonAnswer(): Answer {
    return {
      modelRef: MODEL_REF,
      confidence: 0.9,
      suggestions: [
        {
          geometry: { type: "polygon", points: [[0, 0], [10, 0], [10, 10], [0, 10]] },
          confidence: 0.9,
          modelRef: MODEL_REF,
          contour: [[0, 0], [10, 0], [10, 10], [0, 10]],
        },
      ],
      parameters: ["tolerance"],
    };
  }

  function showingPolygon(): SuggestionState {
    const session = asked();
    return answered(session, session.serial, polygonAnswer());
  }

  it("is there as soon as the answer declares it, with nothing to open first", () => {
    render(mount({ session: showingPolygon(), onTolerance: vi.fn() }));
    expect(screen.getByTestId("suggest-adjustments")).toBeTruthy();
    expect(screen.getByTestId("suggest-detail")).toBeTruthy();
    // The disclosure that used to stand between somebody and the slider is gone.
    expect(screen.queryByTestId("suggest-adjust-open")).toBeNull();
  });

  it("renders exactly the parameters the server declared, and nothing else", () => {
    render(mount({ session: showingPolygon(), onTolerance: vi.fn() }));
    expect(screen.getByTestId("suggest-detail")).toBeTruthy();
    // The two that were here and are not (#557). A control wired to nothing on
    // the ordinary mask is worse than no control.
    expect(screen.queryByTestId("suggest-fill-holes")).toBeNull();
    expect(screen.queryByTestId("suggest-fragments")).toBeNull();
  });

  it("offers a box class no Detail at all, because the wire declared nothing", () => {
    // The whole of the rule: no condition in this file mentions a box. Declare
    // `tolerance` for a box in the kernel's table and this test goes red there.
    const session = asked();
    const boxy = answered(session, session.serial, { ...polygonAnswer(), parameters: [] });
    render(mount({ session: boxy, onTolerance: vi.fn() }));

    expect(screen.queryByTestId("suggest-adjustments")).toBeNull();
    expect(screen.queryByTestId("suggest-detail")).toBeNull();
  });

  it("renders nothing where the host cannot apply a tolerance", () => {
    // A host that cannot honour a control renders no control rather than a dead one.
    render(mount({ session: showingPolygon() }));
    expect(screen.queryByTestId("suggest-adjustments")).toBeNull();
  });

  it("offers nothing for a parameter this build has no control for", () => {
    // `parameters` is an open vocabulary, so a newer server may name a setting this
    // version cannot draw. A control gated on the list's *length* would then be a
    // dead one. What is offered is the intersection, not the declaration.
    const session = asked();
    const unknown = answered(session, session.serial, {
      ...polygonAnswer(),
      parameters: ["depth_bias"],
    });
    render(mount({ session: unknown, onTolerance: vi.fn() }));

    expect(screen.queryByTestId("suggest-adjustments")).toBeNull();
    expect(screen.queryByTestId("suggest-detail")).toBeNull();
  });

  it("still offers the settings it does know beside one it does not", () => {
    // The other half: an unrecognised member is inert, not poisonous — the control
    // for a setting this build *can* draw goes on being offered next to it.
    const session = asked();
    const mixed = answered(session, session.serial, {
      ...polygonAnswer(),
      parameters: ["depth_bias", "tolerance"],
    });
    render(mount({ session: mixed, onTolerance: vi.fn() }));

    expect(screen.getByTestId("suggest-adjustments")).toBeTruthy();
    expect(screen.getByTestId("suggest-detail")).toBeTruthy();
  });

  it("names the tolerance and what it costs in one label, beside the control", () => {
    render(mount({ session: showingPolygon(), onTolerance: vi.fn() }));
    expect(screen.getByTestId("suggest-detail-label").textContent).toBe("1.0 px · 4 pts");
  });

  it("puts the slider on a doubling track, at the tolerance the session is holding", () => {
    render(mount({ session: showingPolygon(), onTolerance: vi.fn() }));
    const slider = screen.getByTestId("suggest-detail") as HTMLInputElement;
    expect(slider.value).toBe("0");
    expect(slider.min).toBe("-2");
    expect(slider.max).toBe("4");
    expect(slider.step).toBe("0.25");
  });

  it("reports a tolerance through the door that needs no request", () => {
    const onTolerance = vi.fn();
    render(mount({ session: showingPolygon(), onTolerance }));

    fireEvent.change(screen.getByTestId("suggest-detail"), { target: { value: "4" } });
    expect(onTolerance).toHaveBeenCalledWith(16);
    fireEvent.change(screen.getByTestId("suggest-detail"), { target: { value: "-2" } });
    expect(onTolerance).toHaveBeenCalledWith(0.25);
    fireEvent.change(screen.getByTestId("suggest-detail"), { target: { value: "-1" } });
    expect(onTolerance).toHaveBeenCalledWith(0.5);
  });

  it("rounds a quarter step's tolerance to two decimals", () => {
    const onTolerance = vi.fn();
    render(mount({ session: showingPolygon(), onTolerance }));

    fireEvent.change(screen.getByTestId("suggest-detail"), { target: { value: "0.25" } });
    expect(onTolerance).toHaveBeenCalledWith(1.19);
  });

  it("lets a press on the slider through, because that press is the drag", () => {
    // The defect this guards: `preventDefault` on the press cancelled a range
    // input's own drag, leaving a control that looked alive and could only be
    // moved with the brackets. The bar's focus guard skips the slider (#563).
    render(mount({ session: showingPolygon(), onTolerance: vi.fn() }));
    const press = fireEvent.mouseDown(screen.getByTestId("suggest-detail"));
    expect(press).toBe(true);
  });

  it("keeps a press on the bar's buttons from taking the canvas's keyboard", () => {
    // The other half of the same guard: a button that took focus would switch
    // `[`, `]`, `Esc` and `↵` off with nothing on screen to say why.
    render(mount({ session: showingPolygon(), onTolerance: vi.fn() }));
    expect(fireEvent.mouseDown(screen.getByTestId("suggest-accept"))).toBe(false);
    expect(fireEvent.mouseDown(screen.getByTestId("suggest-discard"))).toBe(false);
  });

  it("hands the keyboard back to the canvas when the drag ends", () => {
    // The slider may hold focus while it is being dragged, but not after, or
    // `[`, `]`, Esc and Enter stay dead with nothing to say why.
    // The page hands the bar its view's focus; nothing here finds the view by name.
    const root = document.createElement("div");
    root.tabIndex = 0;
    document.body.appendChild(root);

    render(mount({ session: showingPolygon(), onTolerance: vi.fn(), onReturnFocus: () => root.focus() }));
    const slider = screen.getByTestId("suggest-detail");
    slider.focus();
    expect(document.activeElement).toBe(slider);

    fireEvent.change(slider, { target: { value: "1" } });
    expect(document.activeElement).toBe(slider);

    fireEvent.mouseUp(slider);
    expect(document.activeElement).toBe(root);

    root.remove();
  });

  it("keeps the control operable on an answer with nothing in it", () => {
    // Decision 9: adjusting into an empty result must leave the way back. Losing
    // the slider here would leave a blank canvas and nothing to press but Esc,
    // which throws the gesture away rather than undoing what emptied it.
    const session = asked();
    const empty = answered(session, session.serial, {
      ...polygonAnswer(),
      suggestions: [],
    });
    render(mount({ session: empty, onTolerance: vi.fn() }));

    expect(screen.getByTestId("suggest-none")).toBeTruthy();
    expect(screen.getByTestId("suggest-adjustments")).toBeTruthy();
    expect(screen.getByTestId("suggest-detail")).toBeTruthy();
    expect(tip()).toContain("The Detail setting still applies");
  });

  it("does not point at settings it has no control for", () => {
    // The empty answer's card offers to step back through the setting, and that
    // sentence has to be true. `parameters` is open, so a server can declare one
    // this build cannot draw — and then the control is absent and the line would
    // be pointing at nothing.
    const session = asked();
    const empty = answered(session, session.serial, {
      ...polygonAnswer(),
      suggestions: [],
      parameters: ["depth_bias"],
    });
    render(mount({ session: empty, onTolerance: vi.fn() }));

    expect(screen.getByTestId("suggest-none")).toBeTruthy();
    expect(screen.queryByTestId("suggest-adjustments")).toBeNull();
    expect(tip()).not.toContain("still applies");
  });
});

describe("Local, once a browser runtime is wired", () => {
  const READY: BrowserSuggestionTarget = {
    id: "efficient-sam-ti",
    label: "EfficientSAM-Ti",
    modelRef: "efficient-sam-ti@browser",
  };

  function acquisition(overrides: Partial<BrowserModelAcquisition> = {}): BrowserModelAcquisition {
    return {
      id: "efficient-sam-ti",
      label: "EfficientSAM-Ti",
      approxBytes: 41_000_000,
      acquire: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  function catalogEntry(overrides: Partial<BrowserModelCatalogEntry> = {}): BrowserModelCatalogEntry {
    return {
      id: "efficient-sam-ti",
      label: "EfficientSAM-Ti",
      modelRef: "robomous/efficient-sam-ti@revision",
      revision: "revision",
      bytes: 41_301_678,
      license: "Apache-2.0",
      source: { label: "EfficientSAM", href: "https://github.com/yformer/EfficientSAM" },
      state: "available",
      storage: "none",
      ...overrides,
    };
  }

  /** Open the model's small menu, where Remove and the source live. */
  async function openModelMenu(): Promise<void> {
    await userEvent.click(screen.getByTestId("suggest-device-menu"));
  }

  it("names the model's size, license and source, and explicitly acquires an available model", async () => {
    const acquire = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(mount({
      browserTargets: [],
      browserModels: [catalogEntry()],
      activeTarget: { kind: "browser", targetId: "efficient-sam-ti" },
      onChooseTarget: vi.fn(),
      onAcquireBrowserModel: acquire,
    }));

    const section = screen.getByTestId("suggest-device-section");
    expect(section.textContent).toContain("EfficientSAM-Ti");
    // The size is on the Download itself, so it is read before the press.
    expect(screen.getByTestId("suggest-device-acquire-efficient-sam-ti").textContent).toContain("41 MB");
    expect(tip()).toContain("41 MB");
    expect(tip()).toContain("Apache-2.0");
    expect(tip()).toContain("EfficientSAM");

    await openModelMenu();
    expect((await screen.findByRole("menuitem", { name: "Source: EfficientSAM" })).getAttribute("href")).toBe(
      "https://github.com/yformer/EfficientSAM",
    );
    await user.keyboard("{Escape}");

    await user.click(screen.getByTestId("suggest-device-acquire-efficient-sam-ti"));
    expect(acquire).toHaveBeenCalledWith("efficient-sam-ti");
  });

  it.each([
    ["downloading", "Downloading…"],
    ["installed", "Installed"],
    ["activating", "Loading…"],
    ["ready", "Ready"],
  ] as const)("renders the catalog %s state as %s", (state, label) => {
    render(mount({
      browserTargets: state === "ready" ? [READY] : [],
      browserModels: [catalogEntry({ state, storage: state === "downloading" ? "none" : "persistent" })],
      activeTarget: { kind: "browser", targetId: READY.id },
      onChooseTarget: vi.fn(),
      onAcquireBrowserModel: vi.fn(),
      onRemoveBrowserModel: vi.fn(),
    }));
    expect(screen.getByTestId("suggest-device-section").textContent).toContain(label);
  });

  it("describes a cached model as loading instead of asking for another download", () => {
    render(mount({
      blocker: "not-ready",
      browserTargets: [],
      browserModels: [catalogEntry({ state: "activating", storage: "persistent" })],
      activeTarget: { kind: "browser", targetId: READY.id },
      onChooseTarget: vi.fn(),
      onRemoveBrowserModel: vi.fn(),
    }));

    expect(screen.getByTestId("suggest-device-section").textContent).toContain("Loading…");
    expect(screen.queryByTestId("suggest-device-acquire-efficient-sam-ti")).toBeNull();
    expect(screen.queryByTestId("suggest-idle-unacquired")).toBeNull();
    expect(screen.getByTestId("suggest-bar").textContent).not.toContain("Model not downloaded");
    expect(tip()).toContain("A click will work once loading finishes.");
  });

  it("removes an installed model through an explicit control in its menu", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    render(mount({
      browserTargets: [],
      browserModels: [catalogEntry({ state: "installed", storage: "persistent" })],
      activeTarget: { kind: "browser", targetId: READY.id },
      onChooseTarget: vi.fn(),
      onRemoveBrowserModel: remove,
    }));
    await openModelMenu();
    await userEvent.click(await screen.findByTestId("suggest-device-remove-efficient-sam-ti"));
    expect(remove).toHaveBeenCalledWith("efficient-sam-ti");
  });

  it("says so when removing fails, rather than letting the refusal vanish", async () => {
    const remove = vi.fn().mockRejectedValue(new Error("locked"));
    render(mount({
      browserTargets: [],
      browserModels: [catalogEntry({ state: "installed", storage: "persistent" })],
      activeTarget: { kind: "browser", targetId: READY.id },
      onChooseTarget: vi.fn(),
      onRemoveBrowserModel: remove,
    }));
    await openModelMenu();
    await userEvent.click(await screen.findByTestId("suggest-device-remove-efficient-sam-ti"));

    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't remove");
    expect(tip()).toContain("That model could not be removed. Try again.");
  });

  it("offers no Remove where the host cannot remove", async () => {
    render(mount({
      browserTargets: [],
      browserModels: [catalogEntry({ state: "installed", storage: "persistent" })],
      activeTarget: { kind: "browser", targetId: READY.id },
      onChooseTarget: vi.fn(),
    }));
    await openModelMenu();
    await screen.findByRole("menuitem", { name: "Source: EfficientSAM" });
    expect(screen.queryByTestId("suggest-device-remove-efficient-sam-ti")).toBeNull();
  });

  it("reports session-only readiness without claiming the model is installed", () => {
    render(mount({
      browserTargets: [READY],
      browserModels: [catalogEntry({ state: "ready", storage: "session" })],
      activeTarget: { kind: "browser", targetId: READY.id },
      onChooseTarget: vi.fn(),
      onRemoveBrowserModel: vi.fn(),
    }));
    expect(screen.getByTestId("suggest-device-session-only").textContent).toBe("Ready, not saved");
    expect(tip()).toMatch(/ready for this session.*not saved/i);
    expect(screen.getByTestId("suggest-device-section").textContent).not.toContain("Installed");
  });

  it("turns a cached integrity failure into useful prose and another explicit Download", () => {
    render(mount({
      browserTargets: [],
      browserModels: [catalogEntry({
        state: "failed",
        storage: "none",
        error: "cached encoder SHA-256 mismatch",
      })],
      activeTarget: { kind: "browser", targetId: READY.id },
      onChooseTarget: vi.fn(),
      onAcquireBrowserModel: vi.fn(),
    }));
    expect(screen.getByRole("alert").textContent).toMatch(/failed verification/i);
    expect(tip()).toMatch(/failed verification.*download/i);
    expect(screen.getByTestId("suggest-device-acquire-efficient-sam-ti")).toBeTruthy();
  });

  it("keeps removal available when browser storage could not be inspected", async () => {
    render(mount({
      browserTargets: [],
      browserModels: [catalogEntry({
        state: "failed",
        storage: "unknown",
        error: "cache match failed",
      })],
      activeTarget: { kind: "browser", targetId: READY.id },
      onChooseTarget: vi.fn(),
      onRemoveBrowserModel: vi.fn(),
    }));

    expect(tip()).toMatch(/storage could not be checked/i);
    await openModelMenu();
    expect(await screen.findByTestId("suggest-device-remove-efficient-sam-ti")).toBeTruthy();
  });

  it("reports a registry problem without hiding a usable saved model", async () => {
    render(mount({
      browserTargets: [READY],
      browserModels: [catalogEntry({ state: "ready", storage: "persistent", warning: "registry unavailable" })],
      activeTarget: { kind: "browser", targetId: READY.id },
      onChooseTarget: vi.fn(),
      onRemoveBrowserModel: vi.fn(),
    }));

    expect(tip()).toMatch(/registry could not be checked/i);
    expect(screen.getByTestId("suggest-device-section").textContent).toContain("Ready");
    await openModelMenu();
    expect(await screen.findByTestId("suggest-device-remove-efficient-sam-ti")).toBeTruthy();
  });

  it("renders no Local control, and no Server | Local choice, when no runtime is wired at all", () => {
    render(mount());

    expect(screen.queryByTestId("suggest-device-section")).toBeNull();
    expect(screen.queryByTestId("suggest-target-server")).toBeNull();
    expect(screen.queryByTestId("suggest-target-browser")).toBeNull();
    // The rest of the idle reading is exactly what it is with a runtime.
    expect(screen.getByTestId("suggest-idle")).toBeTruthy();
  });

  it("shows the ready target as Ready, and offers Server | Local as one radio group", () => {
    render(
      mount({
        browserTargets: [READY],
        browserAcquisitions: [],
        activeTarget: { kind: "browser", targetId: READY.id },
        onChooseTarget: vi.fn(),
      }),
    );

    const group = screen.getByRole("radiogroup", { name: "Where it runs" });
    expect(group.contains(screen.getByTestId("suggest-target-server"))).toBe(true);
    expect(screen.getByTestId("suggest-target-browser").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Local" })).toBeTruthy();
    const section = screen.getByTestId("suggest-device-section");
    expect(section.textContent).toContain("EfficientSAM-Ti");
    expect(section.textContent).toContain("Ready");
  });

  it("switches to the server target when Server is chosen", async () => {
    const onChooseTarget = vi.fn();
    const user = userEvent.setup();
    render(
      mount({
        browserTargets: [READY],
        browserAcquisitions: [],
        activeTarget: { kind: "browser", targetId: READY.id },
        onChooseTarget,
        connectionId: "c1",
      }),
    );

    await user.click(screen.getByTestId("suggest-target-server"));
    expect(onChooseTarget).toHaveBeenCalledWith({ kind: "server", connectionId: "c1" });
  });

  it("switches to the browser target when Local is chosen", async () => {
    const onChooseTarget = vi.fn();
    const user = userEvent.setup();
    render(
      mount({
        browserTargets: [READY],
        browserAcquisitions: [],
        activeTarget: { kind: "server", connectionId: "c1" },
        onChooseTarget,
      }),
    );

    await user.click(screen.getByTestId("suggest-target-browser"));
    expect(onChooseTarget).toHaveBeenCalledWith({ kind: "browser", targetId: READY.id });
  });

  it("is absent while something is pending, like every other choice", () => {
    render(
      mount({
        session: shown(),
        browserTargets: [READY],
        browserAcquisitions: [],
        activeTarget: { kind: "browser", targetId: READY.id },
        onChooseTarget: vi.fn(),
      }),
    );
    expect(screen.queryByRole("radiogroup", { name: "Where it runs" })).toBeNull();
    expect(screen.queryByTestId("suggest-device-section")).toBeNull();
  });

  it("offers a download for a model not yet acquired, and reports success", async () => {
    const onAcquired = vi.fn();
    const acquire = vi.fn().mockResolvedValue(undefined);
    render(
      mount({
        browserTargets: [],
        browserAcquisitions: [acquisition({ acquire })],
        activeTarget: { kind: "browser", targetId: "efficient-sam-ti" },
        onChooseTarget: vi.fn(),
        onAcquired,
      }),
    );

    const button = screen.getByTestId("suggest-device-acquire-efficient-sam-ti");
    expect(button.textContent).toContain("Download");
    expect(button.textContent).toContain("41 MB");
    expect(button.getAttribute("aria-label")).toBe("Download to this browser, 41 MB");

    fireEvent.click(button);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(button).toHaveProperty("disabled", true);

    await waitFor(() => expect(onAcquired).toHaveBeenCalledTimes(1));
  });

  it("shows an alert and re-enables the button when the download fails", async () => {
    const acquire = vi.fn().mockRejectedValue(new Error("network down"));
    render(
      mount({
        browserTargets: [],
        browserAcquisitions: [acquisition({ acquire })],
        activeTarget: { kind: "browser", targetId: "efficient-sam-ti" },
        onChooseTarget: vi.fn(),
      }),
    );

    const button = screen.getByTestId("suggest-device-acquire-efficient-sam-ti");
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("Download failed");
    expect(tip()).toContain("Download failed. Try again.");
    expect(button).toHaveProperty("disabled", false);
  });

  it("reaches Local's own download button even though the server side is not-ready (#Task-13 regression)", () => {
    // The real combination `AnnotationPage` produces once Local is chosen and the
    // model has not been acquired: `computeSuggestBlocker` answers "not-ready",
    // and that answer must never blank the bar out from under a choice the person
    // just made — the old top-level `blocker !== null` early return did exactly
    // that, regardless of which target was active.
    const acquire = vi.fn().mockResolvedValue(undefined);
    render(
      mount({
        browserTargets: [],
        browserAcquisitions: [acquisition({ acquire })],
        activeTarget: { kind: "browser", targetId: "efficient-sam-ti" },
        onChooseTarget: vi.fn(),
        blocker: "not-ready",
      }),
    );

    expect(screen.getByTestId("suggest-target-server")).toBeTruthy();
    expect(screen.getByTestId("suggest-target-browser")).toBeTruthy();
    const button = screen.getByTestId("suggest-device-acquire-efficient-sam-ti");
    expect(button).toHaveProperty("disabled", false);

    fireEvent.click(button);
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it("shows Server's own blocker without hiding Local", async () => {
    const onChooseTarget = vi.fn();
    const user = userEvent.setup();
    render(
      mount({
        browserTargets: [READY],
        browserAcquisitions: [],
        activeTarget: { kind: "server", connectionId: "" },
        onChooseTarget,
        blocker: "no-connections",
      }),
    );

    expect(screen.getByTestId("suggest-no-connections")).toBeTruthy();
    expect(screen.queryByTestId("suggest-connection")).toBeNull();

    const local = screen.getByTestId("suggest-target-browser");
    expect(local).toBeTruthy();
    await user.click(local);
    expect(onChooseTarget).toHaveBeenCalledWith({ kind: "browser", targetId: READY.id });
  });

  it("drops the invitation to click when the Server side it names is blocked", () => {
    // "Click the thing you want" is a promise about the *active* side. With Server
    // active and blocked, that promise is false, and it would read directly beside
    // the phrase explaining why a click will not work.
    render(
      mount({
        browserTargets: [READY],
        browserAcquisitions: [],
        activeTarget: { kind: "server", connectionId: "" },
        onChooseTarget: vi.fn(),
        blocker: "no-connections",
      }),
    );

    expect(screen.queryByTestId("suggest-idle")).toBeNull();
    expect(screen.getByTestId("suggest-no-connections")).toBeTruthy();
  });

  it("keeps the invitation when Local is active, whatever the server blocker says", () => {
    // The server's blocker is a fact about Server, not about whether this browser
    // can answer a click — Local may be perfectly ready.
    render(
      mount({
        browserTargets: [READY],
        browserAcquisitions: [],
        activeTarget: { kind: "browser", targetId: READY.id },
        onChooseTarget: vi.fn(),
        blocker: "no-connections",
      }),
    );

    expect(screen.getByTestId("suggest-idle")).toBeTruthy();
  });

  it("points at Download instead of inviting a click the unacquired Local cannot answer", () => {
    // "Click the thing you want" is a promise, and with Local chosen before any
    // download it is a false one: `AnnotationPage` holds no executor for an unready
    // browser target, so the click is a silent no-op.
    render(
      mount({
        browserTargets: [],
        browserAcquisitions: [acquisition()],
        activeTarget: { kind: "browser", targetId: "efficient-sam-ti" },
        onChooseTarget: vi.fn(),
        blocker: "not-ready",
      }),
    );

    expect(screen.queryByTestId("suggest-idle")).toBeNull();
    expect(screen.getByTestId("suggest-idle-unacquired").textContent).toMatch(/not downloaded/i);
    expect(tip()).toContain("a click does nothing");
    expect(screen.getByTestId("suggest-device-acquire-efficient-sam-ti")).toBeTruthy();
  });

  it("draws the warn icon inline with a warn-tone blocker on the Server side", () => {
    render(
      mount({
        browserTargets: [READY],
        browserAcquisitions: [],
        activeTarget: { kind: "server", connectionId: "" },
        onChooseTarget: vi.fn(),
        blocker: "not-capable",
      }),
    );

    const phrase = screen.getByTestId("suggest-not-capable");
    const svg = phrase.querySelector("svg");
    expect(svg).toBeTruthy();
    // The spinning icon is the calm-tone one; a warn-tone blocker must not draw it.
    expect(svg?.classList.contains("animate-spin")).toBe(false);
  });

  it("draws the spinner inline with the checking blocker on the Server side", () => {
    render(
      mount({
        browserTargets: [READY],
        browserAcquisitions: [],
        activeTarget: { kind: "server", connectionId: "" },
        onChooseTarget: vi.fn(),
        blocker: "checking",
      }),
    );

    const phrase = screen.getByTestId("suggest-checking");
    const svg = phrase.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.classList.contains("animate-spin")).toBe(true);
  });
});

describe("Detect all, and choosing among its candidates", () => {
  const FAR_BOX = { type: "bbox", x: 200, y: 200, width: 20, height: 20 } as const;

  function candidate(confidence: number, geometry: Suggestion["geometry"] = A_BOX): Suggestion {
    return { geometry, confidence, modelRef: "acme/detector@abc", contour: [], labelClass: "vehicle" };
  }

  function detected(...candidates: readonly Suggestion[]): SuggestionState {
    const session = detecting(armed("vehicle"));
    return answered(session, session.serial, {
      modelRef: "acme/detector@abc",
      confidence: null,
      suggestions: candidates,
      parameters: [],
    });
  }

  function two(): SuggestionState {
    return detected(candidate(0.83), candidate(0.61, FAR_BOX));
  }

  it("offers Detect all while nothing is pending, and asks when pressed", async () => {
    const onDetect = vi.fn();
    render(mount({ detect: { blocker: null, onDetect } }));
    const button = screen.getByRole("button", { name: "Detect all" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(button);
    expect(onDetect).toHaveBeenCalledTimes(1);
  });

  it("offers no Detect all where the host passes none, which is Local and read-only", () => {
    render(mount());
    expect(screen.queryByTestId("suggest-detect")).toBeNull();
  });

  it("disables Detect all with the blocker as its description", async () => {
    const onDetect = vi.fn();
    render(mount({ detect: { blocker: "no-shape", onDetect } }));
    const button = screen.getByTestId("suggest-detect") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const reason = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toContain("No ready detection model draws a shape this class can hold");
    expect(tip()).toContain("No ready detection model draws a shape this class can hold");
  });

  it("offers no Detect all over a proposal on screen", () => {
    render(mount({ session: shown(), detect: { blocker: null, onDetect: vi.fn() } }));
    expect(screen.queryByTestId("suggest-detect")).toBeNull();
  });

  it("states one count, the chosen of the detected, and opens the list from it", () => {
    render(mount({ session: withChoice(two(), 1, false), onToggleSuggestion: vi.fn() }));
    const status = screen.getByTestId("suggest-status");
    expect(status.textContent).toBe("1 of 2 chosen");
    expect(status.contains(screen.getByTestId("suggest-chosen"))).toBe(true);
    expect(screen.getByTestId("suggest-accept").textContent).toContain("Accept 1");
    expect(tip()).toContain("only the chosen ones are accepted");
  });

  it("names the list's trigger with what it does", () => {
    render(mount({ session: withChoice(two(), 1, false), onToggleSuggestion: vi.fn() }));
    expect(screen.getByRole("button", { name: "Choose candidates to accept — 1 of 2 chosen" })).toBe(
      screen.getByTestId("suggest-chosen"),
    );
  });

  it("keeps the list for a lone candidate, so one let go can be taken back", async () => {
    const onToggleSuggestion = vi.fn();
    render(mount({ session: withChoice(detected(candidate(0.7)), 0, false), onToggleSuggestion }));
    expect(screen.getByTestId("suggest-status").textContent).toContain("Choose a candidate to accept");
    await userEvent.click(screen.getByTestId("suggest-chosen"));
    await userEvent.click(await screen.findByTestId("suggest-chosen-0"));
    expect(onToggleSuggestion).toHaveBeenCalledWith(0);
  });

  it("keeps a point answer's Accept as it was, with no count and no list", () => {
    render(mount({ session: shown(), onToggleSuggestion: vi.fn() }));
    expect(screen.getByTestId("suggest-accept").textContent).toMatch(/^Accept↵?/);
    expect(screen.getByTestId("suggest-accept").textContent).not.toMatch(/Accept \d/);
    expect(screen.queryByTestId("suggest-chosen")).toBeNull();
  });

  it("disables Accept with its reason in the count's place when nothing is chosen", async () => {
    const onAccept = vi.fn();
    const none = withChoice(withChoice(two(), 0, false), 1, false);
    render(mount({ session: none, onAccept, onToggleSuggestion: vi.fn() }));

    const accept = screen.getByTestId("suggest-accept") as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    const reason = document.getElementById(accept.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toContain("Choose a candidate to accept");
    expect(screen.getByTestId("suggest-chosen").contains(reason)).toBe(true);
    await userEvent.click(accept);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("lists each candidate with its own score and choice, and reports a tick by index", async () => {
    const onToggleSuggestion = vi.fn();
    render(mount({ session: withChoice(two(), 1, false), onToggleSuggestion }));

    await userEvent.click(screen.getByTestId("suggest-chosen"));
    const first = await screen.findByTestId("suggest-chosen-0");
    const second = screen.getByTestId("suggest-chosen-1");
    expect(first.getAttribute("aria-checked")).toBe("true");
    expect(first.textContent).toContain("vehicle 1 · 83%");
    expect(second.getAttribute("aria-checked")).toBe("false");
    expect(second.textContent).toContain("vehicle 2 · 61%");

    await userEvent.click(second);
    expect(onToggleSuggestion).toHaveBeenCalledWith(1);
    expect(screen.getByTestId("suggest-chosen-0")).toBeTruthy();
  });

  it("renders no Detail for a detection, which has no contour to reduce", () => {
    render(mount({ session: two(), onTolerance: vi.fn() }));
    expect(screen.queryByTestId("suggest-detail")).toBeNull();
  });

  it("says Detecting while the ask is out, and Nothing detected for an empty answer", () => {
    const asking = detecting(armed("vehicle"));
    const { rerender } = render(mount({ session: asking }));
    expect(screen.getByTestId("suggest-status").textContent).toBe("Detecting…");
    rerender(mount({ session: detected() }));
    expect(screen.getByTestId("suggest-status").textContent).toBe("Nothing detected");
  });
});
