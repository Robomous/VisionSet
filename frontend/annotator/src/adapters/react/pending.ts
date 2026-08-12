/**
 * How long an indicator stays once it is up, and when a wait earns a sentence.
 *
 * A suggest click that has left is reported immediately: the halo appears at the
 * click point on the same frame the request is dispatched, and the panel says so.
 * There is no delay before it, and there used to be — 200ms, on the theory that a
 * warm answer would beat it and no indicator would flash at all. Dogfooding on a
 * real machine settled that: point-suggest inference does not resolve that fast
 * even warm, so the delay never suppressed anything and only bought a second state.
 *
 * Two rules survive, and each answers a different question.
 *
 * `MIN_VISIBLE_MS` is the **anti-flicker** guard, and with the delay gone it is the
 * only one: once the halo is up it stays a quarter second, so an answer that does
 * arrive quickly — a cache that gets faster, a stub in a test — cannot leave it on
 * screen for two frames. `ESCALATE_MS` is the **explanation**: past a second and a
 * half the wait is plausibly a cold start, which is worth a sentence rather than
 * more shape.
 *
 * ## The state that no longer exists
 *
 * There is no *started but not yet visible*. A request being out and the halo
 * being on screen are the same fact, and the machine cannot represent them
 * disagreeing — which is why the delay was removed outright rather than defaulted
 * to zero. A knob for a behaviour nobody wants is the same logic kept in costume,
 * and it would leave every reader wondering which value production runs at.
 *
 * ## Why this is not in `core/`
 *
 * `tsconfig.core.json` builds the engine with `types: []`, so `setTimeout` does
 * not exist there, and that is not an obstacle to route around — the engine is
 * deterministic *because* it owns no clock, which is what lets every interaction
 * test drive it as a pure sequence. This is presentation timing over a request the
 * engine never hears about, so it belongs on the adapter's side of the boundary.
 *
 * ## Why `start` is idempotent
 *
 * The caller drives this from one boolean: the session's `asking`. A refine click
 * while an answer is still out never lowers that boolean, so the machine sees one
 * continuous in-flight period rather than two, and the escalation counts from the
 * first unanswered click — the one paying for the encode, where the refinements
 * after it are the cheap ones.
 */

/** What the indicator has just done. */
export type PendingPhase = "show" | "escalate" | "hide";

/**
 * Once up, at least this long.
 *
 * The floor is measured in *continuous screen time*, not from the request that
 * happens to be out: a second request starting over a halo that is still up
 * inherits its clock rather than restarting it, because the thing being prevented
 * is a ring that blinks, and a ring that has been up 200ms has not blinked.
 */
export const MIN_VISIBLE_MS = 250;

/** Long enough that the wait is worth a sentence rather than just a shape. */
export const ESCALATE_MS = 1500;

/** The handle a host drives. */
export interface PendingIndicator {
  /** A request is out — the halo shows now. Idempotent while one already is. */
  start(): void;
  /** An answer arrived. Honours the visibility floor. */
  resolve(): void;
  /** A refusal arrived. Identical to `resolve` — a refusal is an answer. */
  reject(): void;
  /** Escape. Hides now, floor and all, and clears every timer. */
  cancel(): void;
}

type Timer = ReturnType<typeof setTimeout>;

/**
 * A timing machine that announces phases and holds no opinion about rendering.
 *
 * `announce` is called with each phase in order. A `hide` is only ever announced
 * after a `show`, so a consumer can treat the pair as balanced.
 */
export function pendingIndicator(announce: (phase: PendingPhase) => void): PendingIndicator {
  let inFlight = false;
  /** When the halo went up. Non-null is exactly "on screen". */
  let visibleSince: number | null = null;
  let escalate: Timer | null = null;
  let floor: Timer | null = null;

  function clear(timer: Timer | null): null {
    if (timer !== null) clearTimeout(timer);
    return null;
  }

  function hide(): void {
    escalate = clear(escalate);
    floor = clear(floor);
    inFlight = false;
    if (visibleSince === null) return;
    visibleSince = null;
    announce("hide");
  }

  /**
   * An answer or a refusal: the request is over, and the floor decides whether the
   * halo goes now or in a moment.
   */
  function settle(): void {
    if (!inFlight) return;
    inFlight = false;
    escalate = clear(escalate);
    // `Date.now()` rather than a monotonic clock: the quantity is a quarter of a
    // second of screen time, and the failure mode of a clock adjustment landing
    // inside it is one halo held a beat too long.
    const visible = visibleSince === null ? MIN_VISIBLE_MS : Date.now() - visibleSince;
    if (visible >= MIN_VISIBLE_MS) {
      hide();
      return;
    }
    floor = setTimeout(hide, MIN_VISIBLE_MS - visible);
  }

  return {
    start(): void {
      if (inFlight) return;
      inFlight = true;
      // A start landing inside a floor wait is a new click over a halo that is
      // still up: cancel the pending hide and keep it there. The floor's clock is
      // deliberately **not** restarted — it measures unbroken screen time, and
      // this ring has not gone anywhere.
      floor = clear(floor);
      if (visibleSince === null) {
        visibleSince = Date.now();
        announce("show");
      }
      // Re-armed from this start rather than carried over: a fresh request is a
      // fresh wait, and the sentence is about how long *this* one has taken.
      escalate = clear(escalate);
      escalate = setTimeout(() => {
        escalate = null;
        announce("escalate");
      }, ESCALATE_MS);
    },
    resolve: settle,
    reject: settle,
    cancel(): void {
      if (!inFlight && visibleSince === null) return;
      hide();
    },
  };
}
