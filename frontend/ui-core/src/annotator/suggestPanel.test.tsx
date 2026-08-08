/**
 * The suggest tool's panel: the five things it can be saying, and the one rule
 * about its action (#424, D6).
 *
 * The three *blocked* readings are the issue's own list — none configured, none
 * ready, and the server refusing because this build cannot run the model — and
 * each is asserted to carry a remedy rather than a state. The fourth claim is the
 * structural one: with no callback there is an explanation and **no control**,
 * never a dead button.
 */

import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { JSX } from "react";

import { answered, armed, refused, withPoint } from "@visionset/annotator";
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
      blocker={null}
      refusal={null}
      onAccept={vi.fn()}
      onDiscard={vi.fn()}
      {...overrides}
    />
  );
}

/** A connection row, in whichever setup state a case needs. */
function connection(setup: Connection["setup_state"]): Connection {
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
    created_at: "2026-08-08T00:00:00Z",
    updated_at: "2026-08-08T00:00:00Z",
  } as Connection;
}

describe("which connection a click goes through", () => {
  it("is none, and says why, when the workspace has configured none", () => {
    expect(usableConnection([])).toEqual({ connection: null, blocker: "no-connections" });
  });

  it("is none, and says why, when one exists but its weights are not here", () => {
    expect(usableConnection([connection("not_set_up")])).toEqual({
      connection: null,
      blocker: "not-ready",
    });
  });

  it("is the first ready one, in the list's own order", () => {
    const ready = connection("ready");
    const answer = usableConnection([connection("not_set_up"), ready, connection("ready")]);
    expect(answer.connection).toBe(ready);
    expect(answer.blocker).toBe(null);
  });

  it("names the loading window rather than pretending it is a working tool", () => {
    // The list is only fetched once the tool is armed, so this window is real —
    // and a click landing in it must be told something rather than vanishing.
    expect(usableConnection(undefined)).toEqual({ connection: null, blocker: "checking" });
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
