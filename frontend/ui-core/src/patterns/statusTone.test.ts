import { describe, expect, it } from "vitest";

import { STATUS_INK, TONE_BORDER, TONE_FILL } from "./statusTone";

describe("status tones", () => {
  it("names one Tailwind family per status and never a retired token", () => {
    expect(TONE_FILL.success).toBe("bg-emerald-500 dark:bg-emerald-400");
    expect(TONE_FILL.warning).toBe("bg-amber-500 dark:bg-amber-400");
    expect(TONE_BORDER.success).toBe("border-emerald-500 dark:border-emerald-400");
    expect(TONE_BORDER.warning).toBe("border-amber-500 dark:border-amber-400");
    expect(TONE_FILL.destructive).toBe("bg-destructive");
    expect(TONE_BORDER.neutral).toBe("border-border");
    expect(STATUS_INK.warning).toBe("text-amber-700 dark:text-amber-400");
    expect(STATUS_INK.success).toBe("text-emerald-700 dark:text-emerald-400");
    expect(STATUS_INK.info).toBe("text-sky-700 dark:text-sky-400");
    for (const v of [...Object.values(TONE_FILL), ...Object.values(TONE_BORDER), ...Object.values(STATUS_INK)]) {
      expect(v).not.toMatch(/\b(?:bg|border|text)-(?:success|warning)\b/);
    }
  });
});
