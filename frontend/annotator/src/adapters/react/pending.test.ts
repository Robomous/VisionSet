/**
 * The visibility floor and the escalation, driven on fake time.
 *
 * `pendingIndicator` owns nothing but timers — no React, no DOM, no request — so
 * every case here is a wall-clock story, *the answer came back at N milliseconds*,
 * which is exactly what the rules are about and exactly what a real request cannot
 * be asked to reproduce.
 *
 * The suite that preceded this one was mostly about a 200ms delay before the halo
 * appeared. That delay is gone, and its cases are **deleted rather than skipped**:
 * the machine can no longer represent *started but not visible*, so a test naming
 * that state would be describing a thing rather than checking one.
 *
 * `vi.useFakeTimers()` replaces `setTimeout`/`clearTimeout` for the module under
 * test as well as for this one, so `advance` moves the machine's clock and not
 * merely this file's.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ESCALATE_MS, MIN_VISIBLE_MS, pendingIndicator } from "./pending";
import type { PendingPhase } from "./pending";

/** Every phase the machine announced, in order, since the last `start`. */
function recorder(): { readonly seen: PendingPhase[]; on: (phase: PendingPhase) => void } {
  const seen: PendingPhase[] = [];
  return { seen, on: (phase) => seen.push(phase) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the thresholds", () => {
  it("names the two that survive, and there is no third", () => {
    expect(MIN_VISIBLE_MS).toBe(250);
    expect(ESCALATE_MS).toBe(1500);
    // The floor has to fit inside the escalation, or a wait long enough to be
    // explained could still be too short to have been seen.
    expect(MIN_VISIBLE_MS).toBeLessThan(ESCALATE_MS);
  });
});

describe("dispatching a request", () => {
  it("shows the indicator immediately, with no clock advanced at all", () => {
    // The load-bearing assertion of the whole change, and it is deliberately made
    // *synchronously*: re-introducing any delay — a `setTimeout(…, 0)` included —
    // turns this red, where a version that advanced timers first would not.
    const heard = recorder();
    const indicator = pendingIndicator(heard.on);

    indicator.start();

    expect(heard.seen).toEqual(["show"]);
  });

  it("does not escalate on the way in", () => {
    const heard = recorder();
    const indicator = pendingIndicator(heard.on);

    indicator.start();
    vi.advanceTimersByTime(ESCALATE_MS - 1);

    expect(heard.seen).toEqual(["show"]);
  });
});

describe("an answer that beats the floor", () => {
  it("holds the halo to 250 ms after the start, from a resolve at 100 ms", () => {
    // With the delay gone this is the only thing standing between a fast answer
    // and a ring that appears for two frames.
    const heard = recorder();
    const indicator = pendingIndicator(heard.on);

    indicator.start();
    vi.advanceTimersByTime(100);
    indicator.resolve();
    expect(heard.seen).toEqual(["show"]);

    vi.advanceTimersByTime(149);
    expect(heard.seen).toEqual(["show"]);

    vi.advanceTimersByTime(1);
    expect(heard.seen).toEqual(["show", "hide"]);
  });

  it("holds it even when the answer is instant", () => {
    const heard = recorder();
    const indicator = pendingIndicator(heard.on);

    indicator.start();
    indicator.resolve();
    expect(heard.seen).toEqual(["show"]);

    vi.advanceTimersByTime(MIN_VISIBLE_MS);
    expect(heard.seen).toEqual(["show", "hide"]);
  });
});

describe("an answer at 800 ms", () => {
  it("hides on arrival because the floor is long since paid, and never escalates", () => {
    const heard = recorder();
    const indicator = pendingIndicator(heard.on);

    indicator.start();
    vi.advanceTimersByTime(800);
    expect(heard.seen).toEqual(["show"]);

    indicator.resolve();
    expect(heard.seen).toEqual(["show", "hide"]);

    // Past the escalation threshold with nothing in flight.
    vi.advanceTimersByTime(10_000);
    expect(heard.seen).toEqual(["show", "hide"]);
  });
});

describe("an answer at 2500 ms", () => {
  it("escalates at 1500 counted from the dispatch, and hides on arrival", () => {
    // 1500 from `start`, not 1300 from a halo that now appears at zero: the
    // sentence is a claim about how long a person has been waiting.
    const heard = recorder();
    const indicator = pendingIndicator(heard.on);

    indicator.start();
    vi.advanceTimersByTime(1499);
    expect(heard.seen).toEqual(["show"]);

    vi.advanceTimersByTime(1);
    expect(heard.seen).toEqual(["show", "escalate"]);

    vi.advanceTimersByTime(1000);
    indicator.resolve();
    expect(heard.seen).toEqual(["show", "escalate", "hide"]);
  });
});

describe("a rejection", () => {
  it("ends the indicator exactly as an answer does", () => {
    // The refusal renders as prose in the panel, so the one thing this must not
    // do is leave a halo pulsing over a request that is over.
    const heard = recorder();
    const indicator = pendingIndicator(heard.on);

    indicator.start();
    vi.advanceTimersByTime(900);
    indicator.reject();

    expect(heard.seen).toEqual(["show", "hide"]);
  });

  it("pays the floor like any other answer", () => {
    const heard = recorder();
    const indicator = pendingIndicator(heard.on);

    indicator.start();
    vi.advanceTimersByTime(50);
    indicator.reject();
    expect(heard.seen).toEqual(["show"]);

    vi.advanceTimersByTime(200);
    expect(heard.seen).toEqual(["show", "hide"]);
  });
});

describe("cancel", () => {
  it("hides immediately, ignoring the floor", () => {
    // Escape is a take-back, and a take-back that leaves its own indicator on
    // screen for another quarter second is not one.
    const heard = recorder();
    const indicator = pendingIndicator(heard.on);

    indicator.start();
    expect(heard.seen).toEqual(["show"]);

    indicator.cancel();
    expect(heard.seen).toEqual(["show", "hide"]);

    vi.advanceTimersByTime(10_000);
    expect(heard.seen).toEqual(["show", "hide"]);
  });

  it("clears the escalation too", () => {
    const heard = recorder();
    const indicator = pendingIndicator(heard.on);

    indicator.start();
    vi.advanceTimersByTime(1000);
    indicator.cancel();
    vi.advanceTimersByTime(10_000);

    expect(heard.seen).toEqual(["show", "hide"]);
  });

  it("clears a floor already running", () => {
    const heard = recorder();
    const indicator = pendingIndicator(heard.on);

    indicator.start();
    vi.advanceTimersByTime(10);
    indicator.resolve();
    indicator.cancel();
    expect(heard.seen).toEqual(["show", "hide"]);

    vi.advanceTimersByTime(10_000);
    expect(heard.seen).toEqual(["show", "hide"]);
  });

  it("leaves the machine usable", () => {
    const heard = recorder();
    const indicator = pendingIndicator(heard.on);

    indicator.start();
    vi.advanceTimersByTime(1000);
    indicator.cancel();

    indicator.start();

    expect(heard.seen).toEqual(["show", "hide", "show"]);
  });
});

describe("a refine click while the answer is still out", () => {
  it("is one continuous period, so nothing is announced twice", () => {
    // `active` is the session's own `asking`, which a refine click never lowers.
    const heard = recorder();
    const indicator = pendingIndicator(heard.on);

    indicator.start();
    vi.advanceTimersByTime(300);
    indicator.start();
    indicator.start();
    vi.advanceTimersByTime(50);

    expect(heard.seen).toEqual(["show"]);
  });

  it("keeps the escalation counting from the first unanswered click", () => {
    const heard = recorder();
    const indicator = pendingIndicator(heard.on);

    indicator.start();
    vi.advanceTimersByTime(1000);
    indicator.start();
    vi.advanceTimersByTime(499);
    expect(heard.seen).toEqual(["show"]);

    vi.advanceTimersByTime(1);
    expect(heard.seen).toEqual(["show", "escalate"]);
  });
});

describe("a new request arriving over a halo that is still up", () => {
  it("cancels the pending hide instead of letting it fire mid-request", () => {
    // Reachable in two clicks: answer inside the floor, refine before it expires.
    // Without the cancel the ring vanishes while a request is genuinely out, and
    // nothing brings it back — the machine already believes it is showing.
    const heard = recorder();
    const indicator = pendingIndicator(heard.on);

    indicator.start();
    vi.advanceTimersByTime(50);
    indicator.resolve();

    indicator.start();
    vi.advanceTimersByTime(10_000);

    expect(heard.seen).toEqual(["show", "escalate"]);
  });

  it("does not restart the floor's clock, because the ring never blinked", () => {
    const heard = recorder();
    const indicator = pendingIndicator(heard.on);

    indicator.start();
    vi.advanceTimersByTime(200);
    indicator.resolve();

    indicator.start();
    indicator.resolve();
    // 200 ms of unbroken screen time are already paid, so 50 remain — not 250.
    vi.advanceTimersByTime(49);
    expect(heard.seen).toEqual(["show"]);

    vi.advanceTimersByTime(1);
    expect(heard.seen).toEqual(["show", "hide"]);
  });
});

describe("an answer with nothing in flight", () => {
  it("is ignored rather than announcing a hide nobody can act on", () => {
    const heard = recorder();
    const indicator = pendingIndicator(heard.on);

    indicator.resolve();
    indicator.cancel();
    vi.advanceTimersByTime(10_000);

    expect(heard.seen).toEqual([]);
  });
});
