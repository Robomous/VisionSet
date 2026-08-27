import assert from "node:assert/strict";
import { test } from "node:test";
import { relativize } from "../../scripts/shadcn_relativize.mjs";

test("the cn import and a sibling primitive import become relative; nothing else moves", () => {
  const source = [
    'import { cn } from "@/lib/cn"',
    'import { Button } from "@/primitives/button"',
    'import { Slot } from "radix-ui"',
  ].join("\n");
  assert.equal(
    relativize(source),
    ['import { cn } from "../lib/cn"', 'import { Button } from "./button"', 'import { Slot } from "radix-ui"'].join("\n"),
  );
});
