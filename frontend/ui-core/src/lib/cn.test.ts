/**
 * `cn`, and the bug it exists to have already been fixed.
 *
 * The interesting assertions here are the font-size ones. `tailwind-merge` models
 * stock Tailwind, where every `text-*` that is not a t-shirt size or an arbitrary
 * length is a **colour** — so it read our `text-body` as a colour, decided it
 * conflicted with `text-foreground`, and dropped it. Every field and button in the
 * package rendered one size off the contract, with nothing failing anywhere: the
 * class string is opaque to `tsc`, and a page that is uniformly slightly wrong
 * looks fine.
 *
 * These tests are what makes that a fixed bug rather than a fixed symptom. A fifth
 * size added to `styles.css` and not wired here fails the last one below.
 */

import { describe, expect, it } from "vitest";

import { TEXT } from "../tokens";
import { cn } from "./cn";

describe("cn", () => {
  it("keeps a custom font size beside a text colour", () => {
    expect(cn("text-body", "text-foreground").split(" ").sort()).toEqual([
      "text-body",
      "text-foreground",
    ]);
  });

  it("still lets one custom font size replace another", () => {
    // The other half of the same claim: they *are* one group, so a caller
    // overriding the size gets exactly one.
    expect(cn("text-body", "text-meta")).toBe("text-meta");
  });

  it("still lets a caller override a stock utility", () => {
    expect(cn("px-4", "px-6")).toBe("px-6");
    expect(cn("rounded-md", "rounded-full")).toBe("rounded-full");
  });

  it("keeps utilities that do not conflict", () => {
    expect(cn("flex", "items-center").split(" ").sort()).toEqual(["flex", "items-center"]);
  });

  it("drops falsy input rather than emitting it", () => {
    expect(cn("flex", false, undefined, null, "gap-2")).toBe("flex gap-2");
  });

  it("covers every size the token table declares", () => {
    // The drift guard. `styles.css` and `tokens.ts` are already gated against each
    // other, so a size that exists is a size named here — unless somebody adds one
    // to both and forgets the merge configuration, which is this test.
    for (const size of Object.keys(TEXT)) {
      expect(
        cn(`text-${size}`, "text-muted-foreground"),
        `text-${size} is not registered as a font size in cn.ts`,
      ).toContain(`text-${size}`);
    }
  });
});
