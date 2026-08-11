/**
 * When a wait has earned the right to be shown, and when it has earned the right
 * to be explained.
 *
 * A suggest click is answered in tens of milliseconds when the segmenter has
 * already read the frame, and in well over a second when it has not. Those two
 * want opposite things from an indicator: the fast one wants none at all, because
 * a spinner that appears and vanishes inside 150 ms reads as a glitch rather than
 * as work; the slow one wants something at the click point, because otherwise the
 * canvas is silent and *working* is indistinguishable from *broken*.
 *
 * One timer answers both. Nothing is shown for `SHOW_DELAY_MS`; past it a halo
 * appears; past `ESCALATE_MS` the panel adds the sentence about the first click
 * being the slow one. And once shown it stays for `MIN_VISIBLE_MS`, so an answer
 * landing at 210 ms does not produce the blink the delay was there to prevent.
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
 * continuous in-flight period rather than two — which is what keeps a halo that
 * has already earned the screen from being taken away and given back 200 ms later.
 * The escalation likewise counts from the first unanswered click, because that is
 * the one paying for the encode; the refinements after it are the cheap ones.
 */

/** What the indicator has just done. */
export type PendingPhase = "show" | "escalate" | "hide";

/** Nothing before this; a halo after it. */
export const SHOW_DELAY_MS = 200;

/** Once shown, at least this long — the floor that kills the 200–250 ms blink. */
export const MIN_VISIBLE_MS = 250;

/** Long enough that the wait is worth a sentence rather than just a shape. */
export const ESCALATE_MS = 1500;

/** The handle a host drives. */
export interface PendingIndicator {
  /** A request is out. Idempotent while one already is. */
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
  let shownAt: number | null = null;
  let delay: Timer | null = null;
  let escalate: Timer | null = null;
  let floor: Timer | null = null;

  function clear(timer: Timer | null): null {
    if (timer !== null) clearTimeout(timer);
    return null;
  }

  /** Every timer down and the period over. The one path out, so none is forgotten. */
  function stop(): void {
    delay = clear(delay);
    escalate = clear(escalate);
    floor = clear(floor);
    inFlight = false;
  }

  function hide(): void {
    stop();
    if (shownAt === null) return;
    shownAt = null;
    announce("hide");
  }

  /**
   * An answer or a refusal. Below the delay nothing was ever shown, so nothing is
   * announced and the whole period leaves no trace; above it, the floor decides
   * whether the hide is now or in a moment.
   */
  function settle(): void {
    if (!inFlight) return;
    if (shownAt === null) {
      stop();
      return;
    }
    // `Date.now()` rather than a monotonic clock: the quantity is a quarter of a
    // second of screen time, and the failure mode of a clock adjustment landing
    // inside it is one halo held a beat too long.
    const visible = Date.now() - shownAt;
    if (visible >= MIN_VISIBLE_MS) {
      hide();
      return;
    }
    delay = clear(delay);
    escalate = clear(escalate);
    floor = setTimeout(hide, MIN_VISIBLE_MS - visible);
  }

  return {
    start(): void {
      if (inFlight) return;
      // A `start` arriving inside a floor wait is a new click over an indicator
      // still on screen: keep it there and carry on rather than blinking.
      floor = clear(floor);
      inFlight = true;
      delay = setTimeout(() => {
        delay = null;
        shownAt = Date.now();
        announce("show");
      }, SHOW_DELAY_MS);
      escalate = setTimeout(() => {
        escalate = null;
        announce("escalate");
      }, ESCALATE_MS);
    },
    resolve: settle,
    reject: settle,
    cancel(): void {
      if (!inFlight && shownAt === null) return;
      hide();
    },
  };
}
