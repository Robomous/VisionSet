/**
 * The suggest tool's panel: the six things it can be saying, and the one rule
 * about its action.
 *
 * The three *blocked* readings — none configured, none
 * ready, and the server refusing because this build cannot run the model — are
 * each is asserted to carry a remedy rather than a state. The fourth claim is the
 * structural one: with no callback there is an explanation and **no control**,
 * never a dead button.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { JSX } from "react";

import { answered, armed, refused, withClass, withPoint } from "@visionset/annotator";
import type { Suggestion, SuggestionState } from "@visionset/annotator";

import { SuggestPanel } from "./SuggestPanel";
import { usableConnection, type Connection } from "../data/inferenceQueries";

const A_BOX = { type: "bbox", x: 10, y: 20, width: 30, height: 40 } as const;

function proposal(): Suggestion {
  return { geometry: A_BOX, confidence: 0.9, modelRef: "facebook/sam2-hiera-base-plus@main" };
}

function asked(): SuggestionState {
  return withPoint(armed("vehicle"), [100, 120], "positive");
}

function shown(): SuggestionState {
  const session = asked();
  return answered(session, session.serial, proposal());
}

function mount(overrides: Partial<Parameters<typeof SuggestPanel>[0]> = {}): JSX.Element {
  return (
    <SuggestPanel
      session={armed("vehicle")}
      heldClass="vehicle"
      blocker={null}
      refusal={null}
      onAccept={vi.fn()}
      onDiscard={vi.fn()}
      {...overrides}
    />
  );
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
    setup_state: setup,
    allowed_actions: [],
    // Resolved by the server from the model's own config, and empty until
    // something has read one — which is why a row that never downloaded
    // declares nothing.
    capabilities: setup === "ready" ? ["point_suggest"] : [],
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

describe("the no-connection panel (D6)", () => {
  it("says what is missing when nothing is configured, and offers the way out", async () => {
    const onConfigure = vi.fn();
    render(mount({ blocker: "no-connections", onConfigure }));

    expect(screen.getByTestId("suggest-no-connections")).toBeTruthy();
    expect(screen.getByTestId("suggest-panel").getAttribute("data-tone")).toBe("warn");
    await userEvent.click(screen.getByTestId("suggest-configure"));
    expect(onConfigure).toHaveBeenCalledTimes(1);
  });

  it("tells a configured-but-undownloaded connection apart from no connection", () => {
    render(mount({ blocker: "not-ready", onConfigure: vi.fn() }));
    expect(screen.getByTestId("suggest-not-ready")).toBeTruthy();
    expect(screen.queryByTestId("suggest-no-connections")).toBeNull();
    // Two states, two sentences: one is a thing to make and the other is a
    // download, and a shared message would send somebody to the wrong remedy.
    expect(screen.getByTestId("suggest-panel").textContent).toContain("not on this machine");
  });

  it("is not a warning while it is merely checking", () => {
    render(mount({ blocker: "checking" }));
    expect(screen.getByTestId("suggest-checking")).toBeTruthy();
    expect(screen.getByTestId("suggest-panel").getAttribute("data-tone")).toBe("calm");
  });

  /**
   * The structural claim. `ui-core` imports no router, so where "set one up"
   * goes is the host's — and a host that has nowhere to send somebody must get
   * the explanation with nothing to press, never a control that does nothing.
   */
  it("renders the explanation and no control when the host wires no destination", () => {
    render(mount({ blocker: "no-connections" }));
    expect(screen.getByTestId("suggest-no-connections")).toBeTruthy();
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

describe("what the panel says while the tool is working", () => {
  it("invites the first click", () => {
    render(mount());
    expect(screen.getByTestId("suggest-idle")).toBeTruthy();
    expect(screen.getByTestId("suggest-panel").textContent).toContain("vehicle");
  });

  it("says a request is in flight, in the async vocabulary and not a new spinner", () => {
    render(mount({ session: asked() }));
    expect(screen.getByTestId("suggest-asking")).toBeTruthy();
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
    expect(screen.queryByTestId("suggest-cold-start")).toBeNull();

    cleanup();
    render(mount({ session: asked(), pendingEscalated: true }));
    expect(screen.getByTestId("suggest-cold-start").textContent).toContain(
      "The first click on a frame is the slow one",
    );
  });

  it("reports a refine the same way it reports a first click", () => {
    // The shape being refined stays drawn on the canvas throughout —
    // `paintSuggestion` tests what the session holds rather than what its status
    // is — so this card describing the ask rather than the shape costs nothing.
    const refining = withPoint(shown(), [140, 160], "positive");
    render(mount({ session: refining }));

    expect(screen.getByTestId("suggest-asking")).toBeTruthy();
    expect(screen.queryByTestId("suggest-shown")).toBeNull();
  });

  it("offers accept again the moment the newer answer lands", () => {
    const refining = withPoint(shown(), [140, 160], "positive");
    const back = answered(refining, refining.serial, proposal());
    render(mount({ session: back }));

    expect((screen.getByTestId("suggest-accept") as HTMLButtonElement).disabled).toBe(false);
  });

  it("offers accept and discard once something is showing", async () => {
    const onAccept = vi.fn();
    const onDiscard = vi.fn();
    render(mount({ session: shown(), onAccept, onDiscard }));

    expect(screen.getByTestId("suggest-shown")).toBeTruthy();
    await userEvent.click(screen.getByTestId("suggest-accept"));
    expect(onAccept).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByTestId("suggest-discard"));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("treats an answer with nothing in it as an answer, and says what to try", () => {
    const session = asked();
    render(mount({ session: answered(session, session.serial, null) }));
    expect(screen.getByTestId("suggest-none")).toBeTruthy();
    expect(screen.queryByTestId("suggest-accept")).toBeNull();
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
    const card = screen.getByTestId("suggest-panel");
    expect(card.textContent).toContain("box or a polygon");
    expect(card.textContent).toContain("still armed");
    expect(card.getAttribute("data-tone")).toBe("calm");
  });

  it("offers the way out, which is the only one while the strip button is dimmed", async () => {
    const onDiscard = vi.fn();
    render(mount({ session: parked(), heldClass: "lane", onDiscard }));

    await userEvent.click(screen.getByTestId("suggest-discard"));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    // No `Esc` chip: the chord is a substitution the canvas makes while something
    // is pending, and a parked session has nothing pending.
    expect(screen.getByTestId("suggest-panel").textContent).not.toContain("Esc");
  });

  it("outranks the blocker, which is not the thing standing in the way", () => {
    render(mount({ session: parked(), heldClass: "lane", blocker: "checking" }));

    expect(screen.getByTestId("suggest-parked")).toBeTruthy();
    // "Getting the model ready" would report progress towards something that is
    // not going to happen, and hide the one choice the person can change.
    expect(screen.queryByTestId("suggest-checking")).toBeNull();
  });

  it("has a sentence for a workspace sitting on no class at all", () => {
    render(mount({ session: parked(), heldClass: null }));
    expect(screen.getByTestId("suggest-parked").textContent).toContain("Nothing selected");
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

    expect(screen.getByTestId("suggest-refusal").textContent).toBe(prose);
    expect(screen.getByTestId("suggest-panel").getAttribute("data-tone")).toBe("warn");
  });

  it("says the clicks survive it, because they do", () => {
    const session = asked();
    render(mount({ session: refused(session, session.serial, "nope"), refusal: "nope" }));
    expect(screen.getByTestId("suggest-panel").textContent).toContain("Esc");
    expect(screen.queryByTestId("suggest-accept")).toBeNull();
  });
});

describe("the wrong-kind panel", () => {
  it("says what the model answers instead, and offers the way out", async () => {
    const onConfigure = vi.fn();
    render(mount({ blocker: "not-capable", onConfigure }));

    const card = screen.getByTestId("suggest-not-capable");
    expect(card.textContent).toContain("different question");
    expect(screen.getByTestId("suggest-panel").getAttribute("data-tone")).toBe("warn");
    await userEvent.click(screen.getByTestId("suggest-configure"));
    expect(onConfigure).toHaveBeenCalledTimes(1);
  });

  it("is a different sentence from having nothing configured or nothing downloaded", () => {
    render(mount({ blocker: "not-capable" }));
    expect(screen.queryByTestId("suggest-no-connections")).toBeNull();
    expect(screen.queryByTestId("suggest-not-ready")).toBeNull();
  });
});

describe("which connection a click goes through, on the card", () => {
  const SAM = connection("ready", { id: "c1", name: "local sam" });
  const OTHER = connection("ready", {
    id: "c2",
    name: "the big one",
    model_id: "facebook/sam2-hiera-large",
  });

  it("names the one there is, with no control to press", () => {
    render(mount({ candidates: [SAM], connectionId: "c1", onChooseConnection: vi.fn() }));

    expect(screen.getByTestId("suggest-connection").textContent).toContain("local sam");
    // A picker over a single option is a decision nobody has, and it would sit
    // in the editor asking to be read on every job.
    expect(screen.queryByTestId("suggest-connection-select")).toBeNull();
  });

  it("offers a picker once there is a choice, showing the model under the name", () => {
    render(mount({ candidates: [SAM, OTHER], connectionId: "c2", onChooseConnection: vi.fn() }));

    const trigger = screen.getByTestId("suggest-connection-select");
    expect(trigger.textContent).toContain("the big one");
    expect(trigger.textContent).toContain("facebook/sam2-hiera-large");
    expect(screen.queryByTestId("suggest-connection")).toBeNull();
  });

  it("names the active one rather than a dead control when the host cannot honour a choice", () => {
    // `onConfigure`'s standing rule, applied to the second control this card
    // grew: an explanation with no control beats a control that does nothing.
    render(mount({ candidates: [SAM, OTHER], connectionId: "c2" }));
    expect(screen.getByTestId("suggest-connection").textContent).toContain("the big one");
    expect(screen.queryByTestId("suggest-connection-select")).toBeNull();
  });

  it("is absent while something is in flight or waiting to be accepted", () => {
    // Changing which model answers while an answer is on screen would leave a
    // proposal that nothing on the card explains.
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
