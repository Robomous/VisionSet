/**
 * The setting every interaction test runs in: a document with one box and one
 * polygon, a real store, a counting id factory, and — the part that matters —
 * two total `Record`s that the compiler forces to stay complete.
 *
 * The `_` prefix marks a harness, so `tsconfig.build.json` keeps it out of the
 * shipped engine and out of the headless boundary's type gate — the convention
 * `_fixture.ts`, `_sample.ts` and `tests/server/_flow.py` already follow.
 *
 * It is `_scene.ts` rather than a third `_sample.ts` because `state/_sample.ts`
 * already owns that name and a file needing both would have to alias one; and
 * because what this holds is a store plus a context plus a walk, which is not a
 * sample of anything.
 *
 * ## `ROUTES` and `EVENT_SAMPLES` are the exhaustiveness
 *
 * Both are `Record`s over a discriminant read off the union, so **a state added
 * without a route, or an event added without a sample, does not compile** —
 * here, in the harness, before a single test runs. That is the TypeScript
 * analogue of `tests/kernel/test_events.py` asserting `SAMPLES` equals
 * `DomainEvent.__subclasses__()`, and it arrives earlier than a runtime sweep
 * can.
 *
 * States are only ever reached by **walking a route**, never hand-built. A
 * hand-built `moving` can name an id the document does not hold, or a
 * `startGeometry` that was never in it, and then every assertion about it is
 * about a state the machine cannot produce. `tests/kernel/test_job_service.py`
 * makes the same choice for the same reason: *"the routes the fixture walks are
 * legal in the table, not shortcuts"*.
 *
 * ## A route carries an active class, because a tool is not an event
 *
 * `drawing-bbox` is unreachable while the active class draws polygons, and the
 * tool is derived from the class rather than dispatched (see `tool.ts`). So a
 * route is a class plus a sequence, and `World.walk` sets the first before
 * sending the second.
 */

import { assetTolerances } from "../geometry/tolerance";
import type { Tolerances } from "../geometry/tolerance";
import { createDocument } from "../state/document";
import type { AnnotationDocument } from "../state/document";
import { ASSET, SCHEMA, annotation } from "../state/_sample";
import { AnnotatorStore } from "../state/store";
import type { Annotation, Point } from "../types";
import { NO_MODIFIERS } from "./events";
import type { InteractionEvent, InteractionEventType, Modifiers, PointerButton } from "./events";
import { transition } from "./machine";
import type { InteractionContext, Transition } from "./machine";
import { runEffects } from "./runEffects";
import { IDLE } from "./state";
import type { InteractionState, InteractionStateType } from "./state";
import { toolFor } from "./tool";

/** The box in the scene: class `sign`, which draws bboxes. */
export const BOX_ID = "box";

/** The polygon in the scene: class `lane`, which draws polygons. */
export const POLY_ID = "poly";

/** Inside the box, well away from its grips. */
export const BOX_BODY: Point = [140, 130];

/** The box's north-west grip, exactly. */
export const BOX_NW: Point = [100, 100];

/** Inside the polygon, well away from its vertices and edges. */
export const POLY_BODY: Point = [350, 340];

/** The polygon's first vertex, exactly. */
export const POLY_VERTEX: Point = [300, 300];

/** The path in the scene: class `path`, which draws polylines (#342). */
export const PATH_ID = "path";

/** On the path's first segment, away from both its vertices. */
export const PATH_BODY: Point = [560, 300];

/** The path's first vertex, exactly. */
export const PATH_VERTEX: Point = [500, 300];

/** Under no annotation, and not within any tolerance of one. */
export const EMPTY_POINT: Point = [20, 440];

/** A `sign` box at 100,100, 80×60. Its own fixture: `_sample.ts` has no polygon. */
export function box(): Annotation {
  return {
    ...annotation(BOX_ID),
    geometry: { type: "bbox", x: 100, y: 100, width: 80, height: 60 },
  };
}

/** A `lane` polygon, a 100×80 rectangle at 300,300. */
export function polygon(): Annotation {
  return {
    ...annotation(POLY_ID),
    label_class: "lane",
    geometry: {
      type: "polygon",
      points: [
        [300, 300],
        [400, 300],
        [400, 380],
        [300, 380],
      ],
    },
  };
}

/**
 * A `path` polyline: three points running right and then down, at 500,300.
 *
 * Deliberately **not closed and not convex**, so a test that only ever asked
 * `polygonContains` would answer wrongly about it — an open path has no inside,
 * and this shape's "inside" would be a region nothing should ever hit.
 */
export function path(): Annotation {
  return {
    ...annotation(PATH_ID),
    label_class: "path",
    geometry: {
      type: "polyline",
      points: [
        [500, 300],
        [620, 300],
        [620, 400],
      ],
    },
  };
}

/** The scene's document: the box first, so the polygon and path are above it. */
export function sceneDocument(): AnnotationDocument {
  return createDocument(ASSET, SCHEMA, [box(), polygon(), path()]);
}

/** A pointer-down. Primary button and no modifiers unless said otherwise. */
export function down(
  point: Point,
  button: PointerButton = "primary",
  modifiers: Modifiers = NO_MODIFIERS,
): InteractionEvent {
  return { type: "pointer-down", point, button, modifiers };
}

/** A pointer-move. */
export function move(point: Point): InteractionEvent {
  return { type: "pointer-move", point };
}

/** A pointer-up. Primary button and no modifiers unless said otherwise. */
export function up(
  point: Point,
  button: PointerButton = "primary",
  modifiers: Modifiers = NO_MODIFIERS,
): InteractionEvent {
  return { type: "pointer-up", point, button, modifiers };
}

/** A double-click. */
export function doubleClick(point: Point, modifiers: Modifiers = NO_MODIFIERS): InteractionEvent {
  return { type: "double-click", point, modifiers };
}

/** Modifiers with one key held. */
export function held(key: keyof Modifiers): Modifiers {
  return { ...NO_MODIFIERS, [key]: true };
}

/** The class to hold, then the events that reach a state from idle. */
export interface Route {
  /** `null` is select mode. */
  readonly activeClass: string | null;
  readonly events: readonly InteractionEvent[];
}

/**
 * The shortest legal walk into every state. Total over the union, so a new
 * state fails to compile until somebody says how to reach it.
 *
 * `resizing` and `moving-vertex` need their shape selected first — grips only
 * exist on a selected annotation — which is what the press-and-release in front
 * of each is for. Neither records anything: a press with no move stages no
 * preview, and `AnnotatorStore.commit` answers `false` to that.
 */
export const ROUTES: Readonly<Record<InteractionStateType, Route>> = {
  idle: { activeClass: null, events: [] },
  "pressing-empty": { activeClass: null, events: [down(EMPTY_POINT)] },
  "drawing-bbox": { activeClass: "sign", events: [down([200, 200])] },
  "drawing-polygon": { activeClass: "lane", events: [down([200, 200])] },
  "drawing-polyline": { activeClass: "path", events: [down([200, 200])] },
  moving: { activeClass: null, events: [down(BOX_BODY)] },
  resizing: {
    activeClass: null,
    events: [down(BOX_BODY), up(BOX_BODY), down(BOX_NW)],
  },
  "moving-vertex": {
    activeClass: null,
    events: [down(POLY_BODY), up(POLY_BODY), down(POLY_VERTEX)],
  },
};

/**
 * At least one of every event. Total over the union, so a new event fails to
 * compile until somebody says what one looks like.
 *
 * More than one where the variants differ in a way a transition reads — a
 * secondary button, a modifier held — because the sweep's value is in covering
 * the squares, and a square only reached by a right-click is not covered by a
 * left one.
 */
export const EVENT_SAMPLES: Readonly<Record<InteractionEventType, readonly InteractionEvent[]>> = {
  "pointer-down": [
    down(EMPTY_POINT),
    down(BOX_BODY),
    down(BOX_NW),
    down(POLY_VERTEX),
    down(POLY_VERTEX, "secondary"),
    down(POLY_VERTEX, "primary", held("ctrl")),
    down(BOX_BODY, "primary", held("shift")),
    down(BOX_BODY, "auxiliary"),
  ],
  "pointer-move": [move(EMPTY_POINT), move([210, 220])],
  "pointer-up": [up(EMPTY_POINT), up([210, 220]), up(BOX_BODY, "secondary")],
  "pointer-cancel": [{ type: "pointer-cancel" }],
  "double-click": [doubleClick([350, 300]), doubleClick(EMPTY_POINT)],
  cancel: [{ type: "cancel" }],
  "take-back-point": [{ type: "take-back-point" }],
  commit: [{ type: "commit" }],
  "tool-changed": [{ type: "tool-changed" }],
};

/** Every event sample, flattened — what a sweep iterates. */
export function everyEvent(): readonly InteractionEvent[] {
  return Object.values(EVENT_SAMPLES).flat();
}

/**
 * A store, a machine state, and the context that ties them together.
 *
 * `context()` reads `store.document` — the **committed** one — every time it is
 * asked, so a test that undoes mid-drag gets the same context the adapter would.
 * Using `store.rendered` here instead would make each pointer-move compute from
 * the last, which is the accumulating shape #41's absolute transforms exist to
 * avoid, and no test would notice until a drag drifted.
 */
export class World {
  readonly store: AnnotatorStore;
  state: InteractionState = IDLE;
  activeClass: string | null = null;
  tolerances: Tolerances = assetTolerances(1);
  /** How many ids have been handed out. The claim `minted === 1` is about this. */
  minted = 0;

  constructor(document: AnnotationDocument = sceneDocument()) {
    this.store = new AnnotatorStore(document);
  }

  context(): InteractionContext {
    return {
      document: this.store.document,
      selection: this.store.selection,
      tool: toolFor(this.store.document, this.activeClass),
      tolerances: this.tolerances,
      labelClass: this.activeClass,
      mint: () => {
        this.minted += 1;
        return `n${this.minted}`;
      },
    };
  }

  /** One turn, computed and thrown away: no state change, no store call. */
  turn(event: InteractionEvent): Transition {
    return transition(this.state, event, this.context());
  }

  /** One turn, adopted: the state moves and the effects reach the store. */
  dispatch(event: InteractionEvent): Transition {
    const answer = this.turn(event);
    this.state = answer.state;
    runEffects(this.store, answer.effects);
    return answer;
  }

  /** Every event in order, adopted. */
  send(...events: readonly InteractionEvent[]): void {
    for (const event of events) this.dispatch(event);
  }

  /** Hold a route's class and walk it. Leaves the world in that state. */
  walk(route: Route): void {
    this.activeClass = route.activeClass;
    this.send(...route.events);
  }
}

/** A world already standing in the named state, reached by its route. */
export function worldIn(type: InteractionStateType): World {
  const world = new World();
  world.walk(ROUTES[type]);
  return world;
}

/** Every state's name, read off the routes so a sweep cannot list a stale one. */
export function everyStateType(): readonly InteractionStateType[] {
  return Object.keys(ROUTES) as readonly InteractionStateType[];
}
