/**
 * `cn` — the generic merge cases. No custom `tailwind-merge` configuration
 * lives behind this one (the shadcn preset's names do not collide with a
 * stock class group the way v1's `--text-*` scale did), so there is nothing
 * scale-specific left to pin here.
 */

import { describe, expect, it } from "vitest";

import { cn } from "./cn";

describe("cn", () => {
  it("lets a caller override a stock utility", () => {
    expect(cn("px-4", "px-6")).toBe("px-6");
    expect(cn("rounded-md", "rounded-full")).toBe("rounded-full");
  });

  it("keeps utilities that do not conflict", () => {
    expect(cn("flex", "items-center").split(" ").sort()).toEqual(["flex", "items-center"]);
  });

  it("drops falsy input rather than emitting it", () => {
    expect(cn("flex", false, undefined, null, "gap-2")).toBe("flex gap-2");
  });

  it("keeps a semantic colour beside a layout utility", () => {
    expect(cn("bg-primary", "rounded-lg").split(" ").sort()).toEqual(["bg-primary", "rounded-lg"]);
  });

  it("lets a caller override a semantic background colour", () => {
    expect(cn("bg-primary", "bg-destructive")).toBe("bg-destructive");
  });
});
