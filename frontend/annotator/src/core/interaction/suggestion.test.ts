/**
 * The suggest session, driven directly — no store, no adapter, no DOM.
 *
 * The lifecycle claims D4 makes are the subject: a preview replaced by a refine,
 * discarded by Escape, and accepted into exactly one annotation carrying where it
 * came from. The two that are structural rather than behavioural — nothing enters
 * the command log, nothing enters the document — are asserted here against a real
 * `AnnotatorStore`, because "it is ephemeral" is a claim about `canUndo` and about
 * `document.annotations`, and only a store can answer either.
 */

import { describe, expect, it } from "vitest";

import { AnnotatorStore } from "../state/store";
import { annotationsInDrawOrder, createDocument } from "../state/document";
import type { AnnotationDocument } from "../state/document";
import { addAnnotationCommand } from "../state/commands";
import type { AnnotationSchema, AssetDescriptor, Geometry, LabelClass } from "../types";
import {
  SUGGESTIBLE_GEOMETRY_TYPES,
  acceptedAnnotation,
  allowedGeometriesFor,
  answered,
  armed,
  cleared,
  hasPending,
  isAcceptable,
  isSuggestibleClass,
  promptOf,
  refused,
  schemaCanSuggest,
  suggestClassFor,
  withPoint,
} from "./suggestion";
import type { Suggestion, SuggestionState } from "./suggestion";

const ASSET: AssetDescriptor = { id: "asset-424", width: 800, height: 600 };

function classOf(name: string, geometry: LabelClass["geometry"]): LabelClass {
  return { name, geometry, color: null, attributes: [] };
}

const CAR = classOf("car", "bbox");
const ROAD = classOf("road", "polygon");
const LANE = classOf("lane", "polyline");
const WEATHER = classOf("weather", "classification_tag");

function schemaOf(...classes: readonly LabelClass[]): AnnotationSchema {
  return {
    project_id: "project-424",
    version: 4,
    classes,
    description: null,
    created_at: null,
    provenance: null,
  };
}

function documentOf(schema: AnnotationSchema = schemaOf(CAR, ROAD)): AnnotationDocument {
  return createDocument(ASSET, schema, []);
}

const A_BOX: Geometry = { type: "bbox", x: 10, y: 20, width: 30, height: 40 };
const A_POLYGON: Geometry = {
  type: "polygon",
  points: [
    [0, 0],
    [10, 0],
    [10, 10],
  ],
};

function proposal(geometry: Geometry = A_BOX, confidence: number | null = 0.87): Suggestion {
  return { geometry, confidence, modelRef: "facebook/sam2-hiera-base-plus@main" };
}

/** A session that has asked once and been answered. The commonest starting point. */
function showing(suggestion: Suggestion = proposal()): SuggestionState {
  const asked = withPoint(armed("car"), [100, 120], "positive");
  return answered(asked, asked.serial, suggestion);
}

describe("which classes the tool is offered for", () => {
  it("names exactly the two kinds a mask can be narrowed into", () => {
    expect(SUGGESTIBLE_GEOMETRY_TYPES).toEqual(["bbox", "polygon"]);
  });

  it("accepts a box class and a polygon class", () => {
    expect(isSuggestibleClass(CAR)).toBe(true);
    expect(isSuggestibleClass(ROAD)).toBe(true);
  });

  it("refuses a lane and a tag — an open path and no coordinates at all", () => {
    expect(isSuggestibleClass(LANE)).toBe(false);
    expect(isSuggestibleClass(WEATHER)).toBe(false);
  });

  it("answers the allowed kinds as the class's own, and nothing else", () => {
    expect(allowedGeometriesFor(CAR)).toEqual(["bbox"]);
    expect(allowedGeometriesFor(ROAD)).toEqual(["polygon"]);
  });

  it("answers no allowed kinds for a class that can hold neither", () => {
    expect(allowedGeometriesFor(LANE)).toEqual([]);
    expect(allowedGeometriesFor(WEATHER)).toEqual([]);
  });

  it("says a lane-and-tag schema cannot reach the tool at all — D3's third case", () => {
    expect(schemaCanSuggest(schemaOf(LANE, WEATHER))).toBe(false);
    expect(suggestClassFor(schemaOf(LANE, WEATHER), "lane")).toBe(null);
  });

  it("keeps a held class that can already hold a suggestion", () => {
    expect(suggestClassFor(schemaOf(CAR, ROAD), "road")).toBe("road");
  });

  it("falls back to the first suggestible class when the held one is not", () => {
    expect(suggestClassFor(schemaOf(LANE, ROAD, CAR), "lane")).toBe("road");
    expect(suggestClassFor(schemaOf(LANE, ROAD, CAR), null)).toBe("road");
  });
});

describe("the preview lifecycle", () => {
  it("arms with no points, nothing asked and nothing to take back", () => {
    const state = armed("car");
    expect(state.points).toEqual([]);
    expect(state.status).toBe("idle");
    expect(state.suggestion).toBe(null);
    expect(hasPending(state)).toBe(false);
  });

  it("turns a click into an ask", () => {
    const state = withPoint(armed("car"), [40, 50], "positive");
    expect(state.status).toBe("asking");
    expect(state.points).toEqual([{ point: [40, 50], polarity: "positive" }]);
    expect(hasPending(state)).toBe(true);
  });

  it("shows the answer to that ask", () => {
    const state = showing();
    expect(state.status).toBe("shown");
    expect(state.suggestion?.geometry).toEqual(A_BOX);
    expect(isAcceptable(state)).toBe(true);
  });

  it("replaces the preview when a refine click is answered", () => {
    const refined = withPoint(showing(), [200, 210], "negative");
    // The old shape stays up while the next answer is in flight — a refine that
    // blanked the canvas would flicker on every press.
    expect(refined.status).toBe("asking");
    expect(refined.suggestion?.geometry).toEqual(A_BOX);

    const next = answered(refined, refined.serial, proposal(A_POLYGON, 0.42));
    expect(next.status).toBe("shown");
    expect(next.suggestion?.geometry).toEqual(A_POLYGON);
    expect(next.points).toHaveLength(2);
  });

  it("sends the accumulated points, split by what each one meant", () => {
    const one = withPoint(armed("car"), [10, 10], "positive");
    const two = withPoint(one, [20, 20], "negative");
    const three = withPoint(two, [30, 30], "positive");
    expect(promptOf(three)).toEqual({
      positive: [
        [10, 10],
        [30, 30],
      ],
      negative: [[20, 20]],
    });
  });

  it("treats an answer with nothing in it as an answer, not as an idle tool", () => {
    const asked = withPoint(armed("car"), [1, 1], "positive");
    const none = answered(asked, asked.serial, null);
    expect(none.status).toBe("none");
    expect(none.suggestion).toBe(null);
    expect(isAcceptable(none)).toBe(false);
    // Still pending, so Escape has something to take back — which is what tells
    // "asked and got nothing" apart from "not asked".
    expect(hasPending(none)).toBe(true);
  });

  it("holds the server's prose on a refusal and drops the stale preview", () => {
    const asked = withPoint(showing(), [2, 2], "positive");
    const stopped = refused(asked, asked.serial, "The weights are not here yet.");
    expect(stopped.status).toBe("refused");
    expect(stopped.refusal).toBe("The weights are not here yet.");
    expect(stopped.suggestion).toBe(null);
    expect(isAcceptable(stopped)).toBe(false);
  });

  it("clears a refusal when the next click retries", () => {
    const asked = withPoint(armed("car"), [1, 1], "positive");
    const stopped = refused(asked, asked.serial, "Not here yet.");
    expect(withPoint(stopped, [2, 2], "positive").refusal).toBe(null);
  });
});

describe("a late answer never wins", () => {
  it("drops an answer that names a superseded ask, by identity", () => {
    const first = withPoint(armed("car"), [10, 10], "positive");
    const second = withPoint(first, [20, 20], "positive");
    const late = answered(second, first.serial, proposal(A_POLYGON));
    expect(late).toBe(second);
  });

  it("drops a late refusal too", () => {
    const first = withPoint(armed("car"), [10, 10], "positive");
    const second = withPoint(first, [20, 20], "positive");
    expect(refused(second, first.serial, "too late")).toBe(second);
  });

  it("keeps counting across a clear, so an in-flight answer cannot repaint", () => {
    const asked = withPoint(armed("car"), [10, 10], "positive");
    const wiped = cleared(asked);
    const next = withPoint(wiped, [20, 20], "positive");
    // The ask Escape interrupted still names serial 1; the fresh one names 2.
    expect(answered(next, asked.serial, proposal())).toBe(next);
  });
});

describe("Escape is the preview's undo", () => {
  it("takes the points and the preview back to an armed tool", () => {
    const wiped = cleared(showing());
    expect(wiped.points).toEqual([]);
    expect(wiped.status).toBe("idle");
    expect(wiped.suggestion).toBe(null);
    expect(hasPending(wiped)).toBe(false);
    // Armed, not off: the class survives so the next click starts a fresh
    // session with the same label rather than disarming the tool.
    expect(wiped.labelClass).toBe("car");
  });
});

describe("acceptance", () => {
  it("carries provenance, the model and the confidence", () => {
    const accepted = acceptedAnnotation(documentOf(), showing(), () => "id-1");
    expect(accepted).not.toBe(null);
    expect(accepted?.provenance).toBe("model");
    expect(accepted?.model_ref).toBe("facebook/sam2-hiera-base-plus@main");
    expect(accepted?.confidence).toBe(0.87);
    expect(accepted?.label_class).toBe("car");
    expect(accepted?.geometry).toEqual(A_BOX);
  });

  it("carries a null confidence through rather than inventing one", () => {
    const accepted = acceptedAnnotation(
      documentOf(),
      showing(proposal(A_BOX, null)),
      () => "id-1",
    );
    expect(accepted?.confidence).toBe(null);
    expect(accepted?.provenance).toBe("model");
  });

  it("seeds the class's attribute defaults, exactly as a drawn shape does", () => {
    const withDefault: LabelClass = {
      ...CAR,
      attributes: [
        { name: "occluded", kind: "boolean", required: false, options: null, default: false },
      ],
    };
    const accepted = acceptedAnnotation(
      documentOf(schemaOf(withDefault)),
      showing(),
      () => "id-1",
    );
    expect(accepted?.attributes).toEqual({ occluded: false });
  });

  it("refuses to build anything from a session with no preview showing", () => {
    const mint = (): string => "id-1";
    expect(acceptedAnnotation(documentOf(), armed("car"), mint)).toBe(null);
    const asked = withPoint(armed("car"), [1, 1], "positive");
    expect(acceptedAnnotation(documentOf(), asked, mint)).toBe(null);
    expect(acceptedAnnotation(documentOf(), answered(asked, asked.serial, null), mint)).toBe(null);
  });

  it("refuses when the schema no longer declares the session's class", () => {
    expect(acceptedAnnotation(documentOf(schemaOf(ROAD)), showing(), () => "id-1")).toBe(null);
  });
});

describe("nothing about a pending suggestion is in the document or the history", () => {
  it("leaves the store untouched through a whole click-refine-discard session", () => {
    const store = new AnnotatorStore(documentOf());
    const before = store.document;

    let session = armed("car");
    session = withPoint(session, [10, 10], "positive");
    session = answered(session, session.serial, proposal());
    session = withPoint(session, [20, 20], "negative");
    session = answered(session, session.serial, proposal(A_POLYGON));
    expect(cleared(session).points).toEqual([]);

    expect(store.document).toBe(before);
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(false);
    expect(annotationsInDrawOrder(store.document)).toHaveLength(0);
  });

  /**
   * **The mutation test for D4.** Turn `acceptedAnnotation`'s output into a
   * command and the log moves by exactly one; the preview that produced it never
   * did. A design that staged the preview into the store would make `canUndo`
   * true before this line, and this is the assertion that would turn red.
   */
  it("adds exactly one history entry when — and only when — it is accepted", () => {
    const store = new AnnotatorStore(documentOf());
    const session = showing();
    expect(store.canUndo).toBe(false);

    const accepted = acceptedAnnotation(store.document, session, () => "id-1");
    expect(accepted).not.toBe(null);
    store.execute(addAnnotationCommand(accepted!));

    expect(store.canUndo).toBe(true);
    expect(annotationsInDrawOrder(store.document)).toHaveLength(1);

    store.undo();
    expect(annotationsInDrawOrder(store.document)).toHaveLength(0);
    expect(store.canUndo).toBe(false);
  });
});
