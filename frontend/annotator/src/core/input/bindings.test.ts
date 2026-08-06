/**
 * The shortcut table, and the registry it folds into — #46's first acceptance
 * criterion.
 *
 * Every default row gets its own `it`, driven the way a host drives it: a
 * `KeyPress` through `keystrokeOf`, through `resolve`, to an `Action` compared
 * with `toEqual`. Nothing here reaches into `DEFAULT_BINDINGS` to read a chord
 * and hand it back, which is what makes the sweep a *proof that the literals are
 * canonical*: a row written `"Mod+Z"` or `"shift+?"` fails, because that is not
 * what `chordOf` produces.
 *
 * `DISPATCH` is asserted to cover the table exactly, in both directions, so a
 * row added without a test and a test naming a row that was deleted are both
 * failures. `machine.test.ts` sweeps `TRANSITIONS` the same way, for the same
 * reason: *the test cannot drift from the table, it reads it.*
 */

import { describe, expect, it } from "vitest";

import {
  EMPTY_SCHEMA,
  LANE,
  PALETTE,
  PALETTE_SCHEMA,
  SIGN,
  pressOf,
  wideSchema,
} from "./_palette";
import { FOCUS_CLASS_FIELD, RESET_ZOOM, SAVE, SKIP_FRAME, TOGGLE_HELP } from "./actions";
import type { Action } from "./actions";
import {
  CLASS_HOTKEY_DIGITS,
  DEFAULT_BINDINGS,
  classAction,
  defaultRegistry,
  classHotkeys,
  hotkeyForClass,
  registryOf,
  resolve,
} from "./bindings";
import { keystrokeOf } from "./keys";
import type { KeyPress, Keystroke } from "./keys";

/** One documented row: what a user presses, and what it must mean. */
interface DispatchRow {
  readonly chord: string;
  readonly key: string;
  readonly held?: Partial<KeyPress>;
  readonly action: Action;
}

const MOD = { ctrlKey: true } as const;

/** The whole default map, spelled as presses. */
const DISPATCH: readonly DispatchRow[] = [
  { chord: "escape", key: "Escape", action: { kind: "send", event: { type: "cancel" } } },
  { chord: "enter", key: "Enter", action: { kind: "send", event: { type: "commit" } } },
  { chord: "delete", key: "Delete", action: { kind: "delete-selection" } },
  // #129: not a synonym for `Delete` any more. The two chords meant one thing, so
  // one was free — and `Backspace` takes back the last thing you did, which is the
  // only spelling the polygon take-back has.
  {
    chord: "backspace",
    key: "Backspace",
    action: { kind: "send", event: { type: "take-back-point" } },
  },
  { chord: "mod+z", key: "z", held: MOD, action: { kind: "undo" } },
  {
    chord: "mod+shift+z",
    key: "Z",
    held: { ctrlKey: true, shiftKey: true },
    action: { kind: "redo" },
  },
  { chord: "mod+a", key: "a", held: MOD, action: { kind: "select-all" } },
  { chord: "mod+c", key: "c", held: MOD, action: { kind: "copy-selection" } },
  { chord: "mod+v", key: "v", held: MOD, action: { kind: "paste" } },
  { chord: "mod+0", key: "0", held: MOD, action: { kind: "host", name: RESET_ZOOM } },
  {
    chord: "?",
    key: "?",
    held: { shiftKey: true },
    action: { kind: "host", name: TOGGLE_HELP },
  },
  { chord: "c", key: "c", action: { kind: "host", name: FOCUS_CLASS_FIELD } },
  { chord: "mod+s", key: "s", held: MOD, action: { kind: "host", name: SAVE } },
  // #383. `enter` is deliberately absent from this pair: the flow verb's chord is
  // the ring close above, substituted by the adapter when nothing is being drawn,
  // so a second `enter` row here would shadow the commit.
  { chord: "x", key: "x", action: { kind: "host", name: SKIP_FRAME } },
  { chord: "v", key: "v", action: { kind: "activate-class", labelClass: null } },
];

const DEFAULTS = registryOf(DEFAULT_BINDINGS);

/** A keystroke, refusing to proceed if the press was not one. */
function keystroke(key: string, held: Partial<KeyPress> = {}): Keystroke {
  const pressed = keystrokeOf(pressOf(key, held));
  expect(pressed).not.toBeNull();
  return pressed as Keystroke;
}

describe("the default shortcut table", () => {
  for (const row of DISPATCH) {
    it(`${row.chord} is ${row.action.kind}`, () => {
      expect(resolve(DEFAULTS, keystroke(row.key, row.held))).toEqual(row.action);
    });
  }

  it("has a dispatch row for every binding, and no row for a binding it dropped", () => {
    expect(new Set(DISPATCH.map((row) => row.chord))).toEqual(
      new Set(DEFAULT_BINDINGS.map((binding) => binding.chord)),
    );
  });

  it("binds no chord twice", () => {
    expect(new Set(DEFAULT_BINDINGS.map((binding) => binding.chord)).size).toBe(
      DEFAULT_BINDINGS.length,
    );
  });

  it("claims no bare digit, so a class hotkey cannot collide with it", () => {
    const digits = new Set<string>(CLASS_HOTKEY_DIGITS);
    for (const binding of DEFAULT_BINDINGS) {
      expect(digits.has(binding.chord)).toBe(false);
    }
  });

  it("unbinds nothing — a default is a binding, and only an override may be null", () => {
    for (const binding of DEFAULT_BINDINGS) {
      expect(binding.action).not.toBeNull();
    }
  });

  it("claims copy and paste, and the bare `v` still means select mode", () => {
    // #123 took these two back from the browser. `v` and `mod+v` are different
    // chords — `chordOf` puts the modifier in the string — so claiming the second
    // did not shadow the first, and that is worth an assertion rather than a
    // reading of `keys.ts`.
    expect(resolve(DEFAULTS, keystroke("c", MOD))).toEqual({ kind: "copy-selection" });
    expect(resolve(DEFAULTS, keystroke("v", MOD))).toEqual({ kind: "paste" });
    expect(resolve(DEFAULTS, keystroke("v"))).toEqual({
      kind: "activate-class",
      labelClass: null,
    });
  });

  it("leaves v1's tool keys unclaimed, because a tool key is a class key here", () => {
    for (const key of ["b", "p", "k", "l"]) {
      expect(resolve(DEFAULTS, keystroke(key))).toBeNull();
    }
  });

  it("answers null for a chord nobody bound", () => {
    expect(resolve(DEFAULTS, keystroke("q"))).toBeNull();
    expect(resolve(DEFAULTS, keystroke("Escape", { altKey: true }))).toBeNull();
  });
});

describe("classAction", () => {
  it("makes a drawable class active", () => {
    expect(classAction(PALETTE_SCHEMA, "sign")).toEqual({
      kind: "activate-class",
      labelClass: "sign",
    });
  });

  it("toggles a tag class instead of activating it", () => {
    expect(classAction(PALETTE_SCHEMA, "weather")).toEqual({
      kind: "toggle-tag",
      labelClass: "weather",
    });
  });

  it("still activates a class no annotation can carry, so a palette can say why", () => {
    expect(classAction(PALETTE_SCHEMA, "rail")).toEqual({
      kind: "activate-class",
      labelClass: "rail",
    });
  });

  it("refuses a class the schema does not declare", () => {
    expect(classAction(PALETTE_SCHEMA, "unicorn")).toBeNull();
    expect(classAction(EMPTY_SCHEMA, "sign")).toBeNull();
  });
});

describe("classHotkeys", () => {
  it("gives digit N to palette row N, in the authored order", () => {
    expect(classHotkeys(PALETTE_SCHEMA)).toEqual([
      { chord: "1", action: { kind: "activate-class", labelClass: "sign" } },
      { chord: "2", action: { kind: "activate-class", labelClass: "lane" } },
      { chord: "3", action: { kind: "toggle-tag", labelClass: "weather" } },
      { chord: "4", action: { kind: "activate-class", labelClass: "rail" } },
      { chord: "5", action: { kind: "activate-class", labelClass: "stop" } },
    ]);
  });

  it("does not filter, so a tag class occupies its own row rather than shifting the rest", () => {
    const bound = classHotkeys(PALETTE_SCHEMA);
    expect(bound.map((binding) => binding.chord)).toEqual(["1", "2", "3", "4", "5"]);
    expect(bound).toHaveLength(PALETTE.length);
  });

  it("stops at nine, and does not reach for a tenth digit", () => {
    const bound = classHotkeys(wideSchema(12));
    expect(bound).toHaveLength(9);
    expect(bound.map((binding) => binding.chord)).toEqual([...CLASS_HOTKEY_DIGITS]);
    expect(bound.at(-1)?.action).toEqual({ kind: "activate-class", labelClass: "c9" });
  });

  it("binds nothing for a schema declaring nothing", () => {
    expect(classHotkeys(EMPTY_SCHEMA)).toEqual([]);
  });

  it("freezes the class name, never its position", () => {
    const reordered = { ...PALETTE_SCHEMA, classes: [LANE, SIGN] };
    expect(classHotkeys(reordered)[1]?.action).toEqual(
      classHotkeys({ ...PALETTE_SCHEMA, classes: [SIGN] })[0]?.action,
    );
  });

  it("resolves through a registry the way a host assembles one", () => {
    const registry = registryOf([...DEFAULT_BINDINGS, ...classHotkeys(PALETTE_SCHEMA)]);
    expect(resolve(registry, keystroke("3"))).toEqual({
      kind: "toggle-tag",
      labelClass: "weather",
    });
  });
});

describe("hotkeyForClass", () => {
  it("is the exact inverse of classHotkeys, so a palette shows the same numbering", () => {
    for (const binding of classHotkeys(PALETTE_SCHEMA)) {
      const named = binding.action;
      const labelClass =
        named !== null && "labelClass" in named ? named.labelClass : null;
      expect(hotkeyForClass(PALETTE_SCHEMA, labelClass as string)).toBe(binding.chord);
    }
  });

  it("answers null past the ninth class", () => {
    const schema = wideSchema(12);
    expect(hotkeyForClass(schema, "c9")).toBe("9");
    expect(hotkeyForClass(schema, "c10")).toBeNull();
  });

  it("answers null for a class the schema does not declare", () => {
    expect(hotkeyForClass(PALETTE_SCHEMA, "unicorn")).toBeNull();
  });
});

describe("registryOf", () => {
  it("lets the last binding win, which is how a remap works", () => {
    const registry = registryOf([
      ...DEFAULT_BINDINGS,
      { chord: "mod+z", action: { kind: "select-all" } },
    ]);
    expect(resolve(registry, keystroke("z", MOD))).toEqual({ kind: "select-all" });
  });

  it("leaves the neighbouring chord alone when one is overridden", () => {
    const registry = registryOf([
      ...DEFAULT_BINDINGS,
      { chord: "mod+z", action: { kind: "select-all" } },
    ]);
    expect(resolve(registry, keystroke("Z", { ctrlKey: true, shiftKey: true }))).toEqual({
      kind: "redo",
    });
  });

  it("unbinds on a null action", () => {
    const registry = registryOf([...DEFAULT_BINDINGS, { chord: "mod+a", action: null }]);
    expect(resolve(registry, keystroke("a", MOD))).toBeNull();
    expect(resolve(registry, keystroke("Escape"))).toEqual({
      kind: "send",
      event: { type: "cancel" },
    });
  });

  it("treats unbinding an unbound chord as a no-op rather than an error", () => {
    const registry = registryOf([{ chord: "mod+j", action: null }]);
    expect(registry.size).toBe(0);
  });

  it("does not throw on a duplicate, because the fold is the remap", () => {
    expect(() =>
      registryOf([
        { chord: "v", action: { kind: "undo" } },
        { chord: "v", action: { kind: "redo" } },
      ]),
    ).not.toThrow();
  });
});

/**
 * The fold, named once (#189).
 *
 * `defaultRegistry` exists because two callers must agree exactly: the adapter
 * that resolves a keystroke, and the help sheet that lists what is bound. A sheet
 * spelling the fold itself is a second spelling free to drift — which is the
 * failure v1's hand-written `HelpModal.tsx` had by construction.
 */
describe("the registry an annotator actually runs on", () => {
  it("is the defaults plus the schema's class hotkeys", () => {
    const registry = defaultRegistry(PALETTE_SCHEMA);
    for (const binding of DEFAULT_BINDINGS) {
      expect(registry.get(binding.chord)).toEqual(binding.action);
    }
    for (const binding of classHotkeys(PALETTE_SCHEMA)) {
      expect(registry.get(binding.chord)).toEqual(binding.action);
    }
    expect(registry.size).toBe(DEFAULT_BINDINGS.length + classHotkeys(PALETTE_SCHEMA).length);
  });

  it("carries no class hotkey for a schema with no classes", () => {
    expect(defaultRegistry(EMPTY_SCHEMA).size).toBe(DEFAULT_BINDINGS.length);
  });

  it("lets a host override win over a class hotkey, which wins over a default", () => {
    const registry = defaultRegistry(PALETTE_SCHEMA, [
      { chord: "1", action: { kind: "undo" } },
      { chord: "v", action: { kind: "redo" } },
    ]);
    expect(registry.get("1")).toEqual({ kind: "undo" });
    expect(registry.get("v")).toEqual({ kind: "redo" });
  });

  it("lets a host unbind a default, so the browser keeps the chord", () => {
    const registry = defaultRegistry(PALETTE_SCHEMA, [{ chord: "mod+0", action: null }]);
    expect(registry.has("mod+0")).toBe(false);
  });

  it("agrees with the fold it replaced, which is the whole point of naming it", () => {
    expect(defaultRegistry(PALETTE_SCHEMA)).toEqual(
      registryOf([...DEFAULT_BINDINGS, ...classHotkeys(PALETTE_SCHEMA)]),
    );
  });
});
