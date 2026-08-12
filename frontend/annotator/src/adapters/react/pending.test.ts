/**
 * The two thresholds and the visibility floor, driven on fake time.
 *
 * These are the first fake-timer tests in the repository, and the reason they can
 * be is that `pendingIndicator` owns nothing but timers: no React, no DOM, no
 * request. Every case below is a wall-clock story — *the answer came back at N
 * milliseconds* — which is exactly what the rule is about and exactly what a real
 * request cannot be asked to reproduce.
 *
 * `vi.useFakeTimers()` replaces `setTimeout`/`clearTimeout` for the module under
 * test as well as for this one, so `advance` moves the machine's clock and not
 * merely this file's.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ESCALATE_MS,
  MIN_VISIBLE_MS,
  SHOW_DELAY_MS,
  pendingIndicator,
} from "./pending";
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
  it("names them in the order they fire, with the floor inside the delay's shadow", () => {
    // Stated as a relation rather than as three numbers, because the case below
    // asserting a hide at 450 ms is `SHOW_DELAY_MS + MIN_VISIBLE_MS` and would
    // otherwise be a coincidence a reader has to check by arithmetic.
    expect(SHOW_DELAY_MS).toBe(200);
    expect(MIN_VISIBLE_MS).toBe(250);
    expect(ESCALATE_MS).toBe(1500);
    expect(SHOW_DELAY_MS).toBeLessThan(ESCALATE_MS);
  });
});

describe("an answer that arrives before the delay", () => {
  it("shows nothing at all, at 199 ms", () => {
    const heard = recorder();
    const indicator = pendingIndicator(heard.on);

    indicator.start();
    vi.advanceTimersByTime(199);
    indicator.resolve();

    expect(heard.seen).toEqual([]);

    // And nothing arrives late either: the delay timer must have been cleared
    // rather than merely ignored when it fired.
    vi.advanceTimersByTime(10_000);
    expect(heard.seen).toEqual([]);
  });
});

describe("an answer that arrives just after the delay", () => {
  it("shows at 200 ms and hides no earlier than 450 ms after the start", () => {
    const heard = recorder();
    const indicator = pendingIndicator(heard.on);

    indicator.start();
    vi.advanceTimersByTime(201);
    expect(heard.seen).toEqual(["show"]);

    // The answer is here, but the halo has been on screen for 1 ms. Hiding now is
    // the flicker the floor exists to prevent.
    indicator.resolve();
    expect(heard.seen).toEqual(["show"]);

    // 449 ms after the start is 249 ms of visibility — one short.
    vi.advanceTimersByTime(248);
    expect(heard.seen).toEqual(["show"]);

    vi.advanceTimersByTime(1);
    expect(heard.seen).toEqual(["show", "hide"]);
  });
});

describe("an answer at 800 ms", () => {
  it("shows at 200, hides on arrival because the floor is already paid, and never escalates", () => {
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
  it("shows at 200, escalates at 1500, and hides on arrival", () => {
    const heard = recorder();
    const indicator = pendingIndicator(heard.on);

    indicator.start();

    vi.advanceTimersByTime(200);
    expect(heard.seen).toEqual(["show"]);

    vi.advanceTimersByTime(1299);
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

  it("shows nothing when it arrives inside the delay", () => {
    const heard = recorder();
    const indicator = pendingIndicator(heard.on);

    indicator.start();
    vi.advanceTimersByTime(50);
    indicator.reject();
    vi.advanceTimersByTime(10_000);

    expect(heard.seen).toEqual([]);
  });
});

describe("cancel", () => {
  it("hides immediately, ignoring the floor", () => {
    // Escape is a take-back, and a take-back that leaves its own indicator on
    // screen for another quarter second is not one.
    const heard = recorder();
    const indicator = pendingIndicator(heard.on);

    indicator.start();
    vi.advanceTimersByTime(201);
    expect(heard.seen).toEqual(["show"]);

    indicator.cancel();
    expect(heard.seen).toEqual(["show", "hide"]);

    vi.advanceTimersByTime(10_000);
    expect(heard.seen).toEqual(["show", "hide"]);
  });

  it("fires nothing when it lands inside the delay", () => {
    const heard = recorder();
    const indicator = pendingIndicator(heard.on);

    indicator.start();
    vi.advanceTimersByTime(100);
    indicator.cancel();
    vi.advanceTimersByTime(10_000);

    expect(heard.seen).toEqual([]);
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

  it("leaves the machine usable", () => {
    const heard = recorder();
    const indicator = pendingIndicator(heard.on);

    indicator.start();
    vi.advanceTimersByTime(1000);
    indicator.cancel();

    indicator.start();
    vi.advanceTimersByTime(201);

    expect(heard.seen).toEqual(["show", "hide", "show"]);
  });
});

describe("a refine click while the answer is still out", () => {
  it("is one continuous period, so the halo neither restarts nor blinks", () => {
    // `active` is the session's own `asking`, which a refine click never lowers.
    // A machine that restarted on each ask would hide a halo that had earned the
    // screen and show it again 200 ms later — the flicker, reintroduced by the
    // thing that was supposed to prevent it.
    const heard = recorder();
    const indicator = pendingIndicator(heard.on);

    indicator.start();
    vi.advanceTimersByTime(201);
    expect(heard.seen).toEqual(["show"]);

    indicator.start();
    indicator.start();
    vi.advanceTimersByTime(50);
    expect(heard.seen).toEqual(["show"]);

    // And the escalation still counts from the first unanswered click, because
    // that is the one that paid for the encode.
    vi.advanceTimersByTime(1249);
    expect(heard.seen).toEqual(["show", "escalate"]);
  });

  it("does not restart the delay when it lands before the halo is shown", () => {
    const heard = recorder();
    const indicator = pendingIndicator(heard.on);

    indicator.start();
    vi.advanceTimersByTime(150);
    indicator.start();
    vi.advanceTimersByTime(50);

    expect(heard.seen).toEqual(["show"]);
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
