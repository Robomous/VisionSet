/**
 * The transition table, swept against itself.
 *
 * The transition table exercised by tests, including cancel paths from every
 * state — the "the table is the whole of what happens" and "cancel, from
 * everywhere" blocks. **Neither lists a state by
 * hand.** Both are generated from `TRANSITIONS` and from `_scene.ts`'s `ROUTES`,
 * which is the rule `tests/kernel/test_batch_service.py` set for
 * `BATCH_TRANSITIONS`: a sweep that reads the table cannot drift from it.
 *
 * There are three layers of exhaustiveness here and it is worth naming which
 * catches what, because only the last one is a test:
 *
 * - `TRANSITIONS` is a **total** mapped type over `InteractionState["type"]`, so
 *   a state added to the union without a row does not compile — in the shipping
 *   module, before any of this runs.
 * - `ROUTES` and `EVENT_SAMPLES` are total `Record`s, so a state with no route,
 *   or an event with no sample, does not compile either — in the harness.
 * - What is left for a test is the *behaviour*: that every square answers, that
 *   the silent squares are silent by identity, and that every non-idle state can
 *   be cancelled.
 *
 * `KNOWN_EFFECTS` below is the fourth: a `Record` over `EffectKind`, so an effect
 * added to the union without a case in `runEffects` is caught here rather than at
 * a `default:` nobody hits until a user does.
 */

import { describe, expect, it } from "vitest";

import {
  BOX_BODY,
  BOX_ID,
  BOX_NW,
  EMPTY_POINT,
  EVENT_SAMPLES,
  POLY_ID,
  POLY_VERTEX,
  World,
  down,
  everyEvent,
  everyStateType,
  held,
  move,
  up,
  worldIn,
} from "./_scene";
import { annotation } from "../state/_sample";
import { addAnnotationCommand, removeAnnotationsCommand } from "../state/commands";
import type { EffectKind } from "./effects";
import { TRANSITIONS } from "./machine";
import { IDLE } from "./state";
import type { InteractionStateType } from "./state";

/** Every effect the runner has a case for. A new kind fails to compile here. */
const KNOWN_EFFECTS: Record<EffectKind, true> = {
  select: true,
  stage: true,
  commit: true,
  discard: true,
  add: true,
  replace: true,
  remove: true,
};

const EFFECT_KINDS = new Set(Object.keys(KNOWN_EFFECTS));
const STATE_TYPES = new Set(everyStateType());
const NON_IDLE = everyStateType().filter((type) => type !== "idle");

/** Where the table has no handler — the squares whose answer is "unchanged". */
function isSilent(state: InteractionStateType, event: string): boolean {
  const row = TRANSITIONS[state] as Record<string, unknown>;
  return row[event] === undefined;
}

/**
 * The states where a lost pointer is **not** a cancel.
 *
 * A `pointer-cancel` means a drag was interrupted; a click-by-click polygon or
 * polyline session is not a drag, and discarding twelve placed vertices because a window
 * lost focus would be indefensible. Written as a set rather than as an `if` so a
 * later state joining the exception has to be added here, in front of a reader.
 */
const KEEPS_ITS_WORK_ON_A_LOST_POINTER = new Set<InteractionStateType>([
  "drawing-polygon",
  // The polyline row has the same asymmetry for the same reason, and a path
  // session is if anything the longer of the two to lose.
  "drawing-polyline",
]);

describe("the table is the whole of what happens", () => {
  it("has a route into every state the table names", () => {
    expect(new Set(Object.keys(TRANSITIONS))).toEqual(STATE_TYPES);
  });

  it("has a sample of every event the alphabet declares", () => {
    // The `Record` types already prove this at compile time; asserting it here
    // is what catches a sample list that was emptied rather than removed.
    for (const [type, samples] of Object.entries(EVENT_SAMPLES)) {
      expect(samples.length, type).toBeGreaterThan(0);
    }
  });

  it("names no event the alphabet does not declare", () => {
    const declared = new Set(Object.keys(EVENT_SAMPLES));
    for (const type of everyStateType()) {
      for (const event of Object.keys(TRANSITIONS[type])) {
        expect(declared, `${type} answers ${event}`).toContain(event);
      }
    }
  });

  for (const type of everyStateType()) {
    it(`answers every event without throwing, from ${type}`, () => {
      for (const event of everyEvent()) {
        const world = worldIn(type);
        expect(() => world.turn(event), `${type} on ${event.type}`).not.toThrow();
      }
    });

    it(`only ever names a state the union declares, from ${type}`, () => {
      for (const event of everyEvent()) {
        const world = worldIn(type);
        const answer = world.turn(event);
        expect(STATE_TYPES, `${type} on ${event.type}`).toContain(answer.state.type);
      }
    });

    it(`only ever asks for an effect the runner knows, from ${type}`, () => {
      for (const event of everyEvent()) {
        const world = worldIn(type);
        for (const effect of world.turn(event).effects) {
          expect(EFFECT_KINDS, `${type} on ${event.type}`).toContain(effect.kind);
        }
      }
    });

    it(`hands back the very state it was given where the table is silent, from ${type}`, () => {
      for (const event of everyEvent()) {
        if (!isSilent(type, event.type)) continue;
        const world = worldIn(type);
        const before = world.state;
        const answer = world.turn(event);
        // By identity: the claim is that nothing was rebuilt, not that something
        // equal came back. A renderer keyed on the state object depends on it.
        expect(answer.state, `${type} on ${event.type}`).toBe(before);
        expect(answer.effects, `${type} on ${event.type}`).toHaveLength(0);
      }
    });
  }
});

describe("every state is reachable, by a route the table allows", () => {
  for (const type of everyStateType()) {
    it(`walks from idle into ${type} and lands in the one it claims`, () => {
      const world = worldIn(type);
      expect(world.state.type).toBe(type);
    });
  }

  it("starts idle, and idle is a variant rather than an absence", () => {
    expect(new World().state).toBe(IDLE);
  });
});

describe("cancel, from everywhere", () => {
  for (const type of NON_IDLE) {
    it(`escape returns ${type} to idle`, () => {
      const world = worldIn(type);
      world.dispatch({ type: "cancel" });
      expect(world.state).toBe(IDLE);
    });

    it(`a tool change returns ${type} to idle`, () => {
      const world = worldIn(type);
      world.dispatch({ type: "tool-changed" });
      expect(world.state).toBe(IDLE);
    });

    it(`escape leaves ${type} nothing staged and no new history`, () => {
      const world = worldIn(type);
      const committed = world.store.document;
      const couldUndo = world.store.canUndo;
      world.dispatch({ type: "cancel" });
      // `toBe`: the committed document is the object it was, not one that looks
      // like it. That is the whole of "a cancel reverts".
      expect(world.store.document).toBe(committed);
      expect(world.store.preview).toBeNull();
      expect(world.store.canUndo).toBe(couldUndo);
    });

    it(`a lost pointer treats ${type} the way its own row says`, () => {
      const world = worldIn(type);
      const before = world.state;
      world.dispatch({ type: "pointer-cancel" });
      if (KEEPS_ITS_WORK_ON_A_LOST_POINTER.has(type)) {
        expect(world.state).toBe(before);
      } else {
        expect(world.state).toBe(IDLE);
      }
    });
  }

  it("keeps a half-drawn polygon through a lost pointer, which is the one asymmetry", () => {
    const world = worldIn("drawing-polygon");
    world.send(down([220, 200]), down([220, 240]));
    world.dispatch({ type: "pointer-cancel" });
    expect(world.state.type).toBe("drawing-polygon");
    // And escape, which means the user asked, still drops all three.
    world.dispatch({ type: "cancel" });
    expect(world.state).toBe(IDLE);
  });

  it("does nothing at all in idle when nothing is picked, and hands the same state back", () => {
    const world = new World();
    const answer = world.turn({ type: "cancel" });
    expect(answer.state).toBe(world.state);
    expect(answer.effects).toHaveLength(0);
  });

  it("clears the selection in idle when there is one", () => {
    const world = new World();
    world.send(down(BOX_BODY), up(BOX_BODY));
    expect(world.store.selection.has(BOX_ID)).toBe(true);
    world.dispatch({ type: "cancel" });
    expect(world.store.selection.size).toBe(0);
  });
});

describe("a press is not yet a drag", () => {
  it("clears the selection when the press comes up where it went down", () => {
    const world = new World();
    world.send(down(BOX_BODY), up(BOX_BODY));
    world.send(down(EMPTY_POINT), up(EMPTY_POINT));
    expect(world.store.selection.size).toBe(0);
  });

  it("leaves the selection alone when the press travelled — it was a pan", () => {
    const world = new World();
    world.send(down(BOX_BODY), up(BOX_BODY));
    world.send(down(EMPTY_POINT), move([120, 440]), up([120, 440]));
    expect(world.store.selection.has(BOX_ID)).toBe(true);
  });

  it("counts a press exactly at the slop as travel, so the boundary is written down", () => {
    const world = new World();
    world.send(down(BOX_BODY), up(BOX_BODY));
    const [x, y] = EMPTY_POINT;
    // Manhattan, which is v1's `|dx| + |dy|`, and `>=` is the side of the
    // boundary this engine chose. v1 spelled it `< 3`, so the two agree.
    world.send(down(EMPTY_POINT), up([x + world.tolerances.click, y]));
    expect(world.store.selection.has(BOX_ID)).toBe(true);
  });

  it("measures the slop in the asset pixels it was handed, not in screen ones", () => {
    const world = new World();
    world.send(down(BOX_BODY), up(BOX_BODY));
    // Twice the tolerance: the same gesture that was a click at 100% is a drag
    // once the caller says the image is drawn at half size.
    world.tolerances = { ...world.tolerances, click: world.tolerances.click / 2 };
    const [x, y] = EMPTY_POINT;
    world.send(down(EMPTY_POINT), up([x + 2, y]));
    expect(world.store.selection.has(BOX_ID)).toBe(true);
  });

  it("starts nothing at all on a button that is not the primary one", () => {
    const world = new World();
    const answer = world.turn(down(EMPTY_POINT, "auxiliary"));
    expect(answer.state).toBe(world.state);
    expect(answer.effects).toHaveLength(0);
  });
});

describe("what a press means, in select mode", () => {
  it("picks the topmost shape under the pointer and starts moving it", () => {
    const world = new World();
    world.dispatch(down(BOX_BODY));
    expect(world.state.type).toBe("moving");
    expect(world.store.selection.has(BOX_ID)).toBe(true);
  });

  it("adds to the selection on shift, and starts no drag", () => {
    const world = new World();
    world.send(down(BOX_BODY), up(BOX_BODY));
    world.dispatch(down([350, 340], "primary", held("shift")));
    expect(world.state).toBe(IDLE);
    expect(world.store.selection.has(BOX_ID)).toBe(true);
    expect(world.store.selection.has(POLY_ID)).toBe(true);
  });

  it("toggles on ctrl, so a second press on a picked shape drops it", () => {
    const world = new World();
    world.send(down(BOX_BODY), up(BOX_BODY));
    world.dispatch(down(BOX_BODY, "primary", held("ctrl")));
    expect(world.store.selection.has(BOX_ID)).toBe(false);
    expect(world.state).toBe(IDLE);
  });

  it("takes a grip over the shape it belongs to, once that shape is picked", () => {
    const world = new World();
    world.send(down(BOX_BODY), up(BOX_BODY));
    world.dispatch(down(BOX_NW));
    expect(world.state.type).toBe("resizing");
  });

  it("draws instead of selecting while a drawing class is held", () => {
    const world = new World();
    world.activeClass = "sign";
    world.dispatch(down(BOX_BODY));
    // v1 auto-switched to select here, changing the tool from a canvas click.
    // `tool.ts` argues why that cannot happen when the tool *is* the class.
    expect(world.state.type).toBe("drawing-bbox");
  });
});

describe("a vertex, deleted", () => {
  it("drops the vertex a right-click names", () => {
    const world = new World();
    world.send(down([350, 340]), up([350, 340]));
    world.dispatch(down(POLY_VERTEX, "secondary"));
    const after = world.store.document.annotations.get(POLY_ID);
    expect(after?.geometry.type === "polygon" && after.geometry.points.length).toBe(3);
  });

  it("drops it on ctrl-click too, which is v1's other spelling", () => {
    const world = new World();
    world.send(down([350, 340]), up([350, 340]));
    world.dispatch(down(POLY_VERTEX, "primary", held("ctrl")));
    const after = world.store.document.annotations.get(POLY_ID);
    expect(after?.geometry.type === "polygon" && after.geometry.points.length).toBe(3);
  });

  it("refuses at the minimum, and refusing means the document does not move", () => {
    const world = new World();
    world.send(down([350, 340]), up([350, 340]));
    world.dispatch(down(POLY_VERTEX, "secondary"));
    const before = world.store.document;
    // A triangle now. `removePolygonVertex` answers `null` and nothing happens —
    // v1 deleted the whole annotation here. By identity, because
    // "the document did not move" is the claim; an equal-but-new document would
    // still have put an entry in the history.
    world.dispatch(down([300, 300], "secondary"));
    expect(world.store.document).toBe(before);
    expect(world.store.canUndo).toBe(true);
    expect(world.store.getSnapshot().undoLabel).toBe("edit lane");
  });

  it("survives the ctrl-click that fires twice on macOS, where a delete would not", () => {
    // v1's own bug: ctrl-click is the native secondary click there, so one gesture
    // raises both handlers. Two refusals are a refusal; two removes would be a
    // `DocumentError` out of `removeAnnotations`, raised from a pointer handler.
    const world = new World();
    world.send(down([350, 340]), up([350, 340]));
    world.dispatch(down(POLY_VERTEX, "secondary"));
    const before = world.store.document;
    expect(() => {
      world.dispatch(down([300, 300], "secondary"));
      world.dispatch(down([300, 300], "primary", held("ctrl")));
    }).not.toThrow();
    expect(world.store.document).toBe(before);
  });
});

/**
 * The take-back a browser can actually reach.
 *
 * v1 spelled this as a right-click, and the React adapter answers **every**
 * non-primary press with a pan before the machine is told — deliberately, because
 * a pan conditional on a hit test would pan sometimes and not others depending on
 * where a vertex happens to be, and because on macOS ctrl-click *is* a secondary
 * press, so routing it would fire both spellings of the vertex delete at once.
 *
 * So the capability got an intent of its own, and the two doors share one
 * implementation. These assert the intent; `bindings.test.ts` asserts that
 * `Backspace` is what says it.
 */
describe("taking a polygon point back", () => {
  function drawing(points: readonly [number, number][]): World {
    const world = new World();
    world.activeClass = "lane";
    for (const point of points) world.dispatch(down(point));
    return world;
  }

  it("drops the last point placed", () => {
    const world = drawing([
      [200, 200],
      [300, 200],
      [300, 300],
    ]);
    world.dispatch({ type: "take-back-point" });
    expect(world.state.type === "drawing-polygon" && world.state.points.length).toBe(2);
  });

  it("is the same thing a secondary press does, by construction", () => {
    const keyboard = drawing([
      [200, 200],
      [300, 200],
    ]);
    const pointer = drawing([
      [200, 200],
      [300, 200],
    ]);
    keyboard.dispatch({ type: "take-back-point" });
    pointer.dispatch(down([300, 200], "secondary"));
    expect(keyboard.state).toEqual(pointer.state);
  });

  it("returns to idle rather than leaving a session holding nothing", () => {
    // `points[0]` is what the close ring and the affordance are measured from, so a
    // `drawing-polygon` with an empty buffer is a state every reader would have to
    // guard. Escape from a one-point session does the same, and that is not an
    // accident.
    const world = drawing([[200, 200]]);
    world.dispatch({ type: "take-back-point" });
    expect(world.state.type).toBe("idle");
  });

  it("leaves the cursor where the pointer is, not where the vertex was", () => {
    const world = drawing([
      [200, 200],
      [300, 200],
    ]);
    world.dispatch({ type: "pointer-move", point: [400, 400] });
    world.dispatch({ type: "take-back-point" });
    expect(world.state.type === "drawing-polygon" && world.state.cursor).toEqual([400, 400]);
  });

  it("is silent everywhere else, which the partial rows make automatic", () => {
    for (const type of ["idle", "moving", "resizing", "moving-vertex", "pressing-empty"] as const) {
      const world = worldIn(type);
      const before = world.state;
      world.dispatch({ type: "take-back-point" });
      expect(world.state, `${type} answered take-back-point`).toBe(before);
    }
  });

  it("does not touch the document — a pending polygon is not in the log at all", () => {
    // Which is also why `mod+z` could not have served: `store.undo()` would walk
    // past the session to whatever was committed before it.
    const world = drawing([
      [200, 200],
      [300, 200],
      [300, 300],
    ]);
    const before = world.store.document;
    world.dispatch({ type: "take-back-point" });
    expect(world.store.document).toBe(before);
  });
});

/**
 * The shape a drag was holding, gone before the drag let go.
 *
 * Every drag row answers pointer-up by re-reading the annotation it started on
 * and comparing it against the geometry the gesture began with — `stillThere` —
 * and asks for a **discard** rather than a commit when that read comes back
 * empty. Nothing had ever reached those three arms: every other drag in this
 * file ends on a shape that is still there, so `commitDrag` was the only branch
 * any of the three rows had taken.
 *
 * It is reachable rather than theoretical. A drag stages outside the command log,
 * so the document underneath one is free to move while the gesture is
 * open — an undo, a delete arriving from the side panel, a reload of the page's
 * annotations with a pointer still down.
 *
 * ## Why these assert effects and not the store
 *
 * Because the store cannot tell the two apart, and finding that out is what this
 * block is worth. `AnnotatorStore.commit` and `.discard` both early-return when
 * nothing is staged, and `.execute` — which is how any removal arrives — sets
 * `staged = null` on its way through. So by the time a removed annotation is
 * observable, the preview it would have committed is already gone and the two
 * paths leave byte-identical state. A test written against `undoLabel` passes
 * with the guard deleted; this one was, and it did.
 *
 * The machine's contract is `(state, effects)`, and that is where the difference
 * lives: a lost shape must not produce a `commit`, whose label `commitDrag`
 * builds by reading the annotation it just failed to find — so the entry it asks
 * for would be named "move annotation", after nothing.
 *
 * The geometry-type arm is covered too, and it is not paranoia: an id is reused
 * when a draw is undone and redone, so "still in the document" and "still the
 * shape this gesture picked up" are different questions.
 */
describe("the annotation a drag was holding, removed mid-gesture", () => {
  const DRAGS = [
    { state: "moving", grab: BOX_BODY, id: BOX_ID },
    { state: "resizing", grab: BOX_NW, id: BOX_ID },
    { state: "moving-vertex", grab: POLY_VERTEX, id: POLY_ID },
  ] as const;

  /** The box's geometry, swapped for a polygon and vice versa. */
  function otherShape(id: string) {
    return id === BOX_ID
      ? ({
          type: "polygon",
          points: [
            [10, 10],
            [20, 10],
            [20, 20],
          ],
        } as const)
      : ({ type: "bbox", x: 10, y: 10, width: 5, height: 5 } as const);
  }

  for (const { state, grab, id } of DRAGS) {
    it(`${state} asks to discard, not to commit, when the shape is gone`, () => {
      const world = worldIn(state);
      expect(world.state.type).toBe(state);
      // Dragged first, so a preview really was in flight — the gesture under test
      // is one that had something to commit, not one that never started.
      world.dispatch(move([grab[0] + 12, grab[1] + 9]));
      // Removed through the store, so the document the context reads is the one a
      // real removal leaves, not a hand-built one the machine could never be given.
      world.store.execute(removeAnnotationsCommand([id]));

      const answer = world.dispatch(up(grab));

      expect(world.state).toBe(IDLE);
      expect(answer.effects.map((effect) => effect.kind)).toEqual(["discard"]);
      expect(world.store.document.annotations.has(id)).toBe(false);
    });

    it(`${state} asks to discard when the id came back as a different geometry`, () => {
      const world = worldIn(state);
      world.dispatch(move([grab[0] + 12, grab[1] + 9]));
      const replacement = { ...annotation("replacement"), id, geometry: otherShape(id) };
      world.store.execute(removeAnnotationsCommand([id]));
      world.store.execute(addAnnotationCommand(replacement));

      const answer = world.dispatch(up(grab));

      expect(world.state).toBe(IDLE);
      expect(answer.effects.map((effect) => effect.kind)).toEqual(["discard"]);
      // The substitute is untouched: a discarded drag writes nothing anywhere.
      expect(world.store.document.annotations.get(id)?.geometry).toEqual(replacement.geometry);
    });
  }

  it("still commits when the shape is exactly where the gesture left it", () => {
    // The control. Without it, a `stillThere` that answered `null` for everything
    // would satisfy every assertion above.
    const world = worldIn("moving");
    world.dispatch(move([BOX_BODY[0] + 12, BOX_BODY[1] + 9]));

    const answer = world.dispatch(up([BOX_BODY[0] + 12, BOX_BODY[1] + 9]));

    expect(answer.effects.map((effect) => effect.kind)).toEqual(["commit"]);
    expect(world.store.getSnapshot().undoLabel).toBe("move sign");
  });
});
