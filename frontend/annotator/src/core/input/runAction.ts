/**
 * The interpreter: eight action kinds turned into store calls, host calls and
 * machine events.
 *
 * The **only** file in `input/` that imports `state/store.ts`, which is the point
 * of having it — `runEffects.ts` claims exactly that for `interaction/`, and its
 * claim survives verbatim because this one is in a different directory. It also
 * extends the package's one-way layering by a rung, `input/ → interaction/ →
 * state/ → root`. Nothing on the frontend enforces that layering, as `tags.ts`
 * noted when it declined to invert it; stating the rung is what keeps it
 * reviewable.
 *
 * ## Two booleans, and they answer different questions
 *
 * `resolve(...) !== null` asks **"is this keystroke ours?"** and is what decides
 * `preventDefault`. It has to be answered *before* running anything, or `mod+z`
 * with an empty history would fall through to the browser's own undo inside a
 * text field.
 *
 * `ActionOutcome.changed` asks **"did it do anything?"** — for a host that wants
 * to flash on a refusal, and for tests. Conflating them is the mistake; writing
 * them down is the remedy.
 *
 * ## Events come back as data; host *state* goes through a port
 *
 * `cancel`, `commit` and `tool-changed` are `InteractionEvent`s, so they are
 * returned for the caller to feed the machine rather than pushed through a
 * callback — `effects.ts`'s "data, not closures" argument, and what lets a
 * dispatch test assert with one `toEqual`.
 *
 * The active class cannot be: `tool.ts` states that *"nothing in `core/` stores
 * it"* and that a palette is a host concern. So `InputHost` is a port in the shape
 * `core/ids.ts` established — declared where it is used, implemented at the edge,
 * and satisfied in a test by an object literal that needs no host at all.
 *
 * ## `activate-class` discharges `tool.ts`'s reciprocal obligation, here, once
 *
 * `tool.ts` states the host's debt as *"when the class changes such that
 * `toolFor` returns a different tool, send `tool-changed`. **Not** on every class
 * change."* The second half is the half a host gets wrong, silently abandoning a
 * half-drawn box on a swap between two bbox classes. Deriving it here means every
 * renderer inherits it and no renderer restates it.
 *
 * A class the schema does not declare is **refused entirely** — nothing sent, the
 * host untouched. `tool.ts` cause 2 exists for a document that *loaded* holding an
 * orphan, which is a state you arrive in; manufacturing one from a keystroke would
 * leave the palette with no row lit and the canvas silently in select mode.
 * `activate-class null` is never refused: select mode is always legal.
 *
 * ## `toggle-tag` never touches the active class, and that is structural
 *
 * `toolFor` answers `select` for a tag class, so activating one would light a
 * palette row that draws nothing — and `tags.ts` specifies *"one binding per
 * class, pressed twice to undo itself"*, which requires the class not to become
 * sticky-active. The sharper reason is the event: a `tool-changed` here would be
 * answered by **every** drag row in `machine.ts` with a cancel, `drawing-polygon`
 * dropping every pending vertex. Tagging an asset mid-draw would silently destroy
 * a half-finished polygon. Hence two action kinds rather than one.
 *
 * The command is built from `store.document`, the **committed** one, never from
 * `rendered` — `tags.ts` states that rule, and `store.execute` drops the preview
 * anyway.
 *
 * ## Refusals are values; a subscriber's exception is not
 *
 * Every domain refusal is `changed: false`. `tags.ts` gives the standard: *"an
 * exception out of a keydown handler is an exception into the host's error
 * boundary: a refusal loses a keystroke, a throw loses the session."* But an
 * `AggregateError` from `AnnotatorStore.changed` — a *subscriber* threw —
 * propagates, exactly as `runEffects` propagates it. Swallowing it would put a
 * silent hole in the store's deliberately loud posture one layer out. So there is
 * no `try` around the switch, and no `runEffects`-style collect-every-failure
 * loop either: that exists because a turn lists many effects, and one keystroke is
 * one action.
 *
 * ## Two guards that look like hygiene and are not
 *
 * **`delete-selection` resolves ids through `selectedAnnotations`, never through
 * the raw `Selection`.** `selection.ts` keeps stale ids on purpose — filtered on
 * read, never pruned, which is what makes undoing a delete restore the selection
 * — and `removeAnnotations` throws `DocumentError` on an unknown id. So *draw a
 * box, `mod+z`, `Delete`* would throw out of the key handler. Three keystrokes.
 *
 * **An empty resolved selection returns without executing.** An identity command
 * still goes through `store.execute`, which reads
 * `if (after !== before || had) this.changed()` — so with a drag in flight it
 * fires anyway and **drops the preview**. `select-all` guards the empty document
 * for the neighbouring reason: `selectAll` builds a *new* empty `Set`, which is
 * not `EMPTY_SELECTION`, so `select` would notify and every
 * `useSyncExternalStore` consumer would re-render for nothing, against the
 * store's explicit "the snapshot's identity is load-bearing".
 *
 * One thing it deliberately does not special-case: `delete-selection` on a
 * selected tag removes it through `removeAnnotationsCommand` rather than
 * `untagCommand` — the "two removal paths for one concept" `tags.ts` warns about.
 * It is reachable only if something selects a tag, and a tag is never under the
 * pointer, so naming it is the whole fix.
 */

import type { IdFactory } from "../ids";
import { toggleTagCommand } from "../interaction/tags";
import { toolFor } from "../interaction/tool";
import { removeAnnotationsCommand } from "../state/commands";
import { classNamed } from "../state/document";
import { selectAll, selectedAnnotations } from "../state/selection";
import type { AnnotatorStore } from "../state/store";
import type { Action, SentEvent } from "./actions";

/**
 * The capabilities core does not have.
 *
 * All three members are required. An optional one would make "I declined" and "I
 * forgot" the same program, with the compiler blessing the second; a host with no
 * zoom writes `run: () => false` in one line, which is honest. That is this
 * package's posture everywhere — `tagCommand` answers `null`, `store.discard`
 * answers `false`, `drawableGeometry` answers `null`: a refusal is always a value.
 */
export interface InputHost {
  /** The class a drawing gesture will carry. `null` is select mode. */
  readonly activeClass: string | null;
  /** Make this the active class. Core reads it back; it never stores it. */
  activateClass(labelClass: string | null): void;
  /** Anything core cannot do — a zoom, a help sheet. Answers whether it did. */
  run(name: string): boolean;
}

/** Everything an action needs, in the shape `InteractionContext` established. */
export interface ActionContext {
  readonly store: AnnotatorStore;
  readonly host: InputHost;
  /** The id port. Reached only by a tag that is being added. */
  readonly mint: IdFactory;
}

/** What running an action produced. See the two booleans, above. */
export interface ActionOutcome {
  readonly changed: boolean;
  /** For the caller to hand to `transition`. Usually empty. */
  readonly events: readonly SentEvent[];
}

/** Nothing happened. Shared; both fields are immutable. */
const UNCHANGED: ActionOutcome = { changed: false, events: [] };

/** Something happened and the machine needs to hear nothing about it. */
const CHANGED: ActionOutcome = { changed: true, events: [] };

/**
 * The compiler's own exhaustiveness proof: an action kind added without a case
 * below makes this call fail to type-check.
 *
 * `noFallthroughCasesInSwitch` catches a missing `break`; it says nothing about a
 * missing case. This does.
 */
function unreachable(value: never): never {
  throw new TypeError(`unhandled action: ${JSON.stringify(value)}`);
}

/**
 * Carry out one action.
 *
 * Never throws for a refusal. Does not catch what the store raises when a
 * subscriber throws — see the docstring.
 */
export function runAction(action: Action, context: ActionContext): ActionOutcome {
  const { store, host } = context;
  switch (action.kind) {
    case "send":
      return { changed: true, events: [action.event] };
    case "undo":
      return store.undo() ? CHANGED : UNCHANGED;
    case "redo":
      return store.redo() ? CHANGED : UNCHANGED;
    case "delete-selection": {
      const doomed = selectedAnnotations(store.document, store.selection);
      if (doomed.length === 0) return UNCHANGED;
      store.execute(removeAnnotationsCommand(doomed.map((annotation) => annotation.id)));
      return CHANGED;
    }
    case "select-all": {
      const everything = selectAll(store.document);
      if (everything.size === 0) return UNCHANGED;
      store.select(everything);
      return CHANGED;
    }
    case "activate-class": {
      const document = store.document;
      if (
        action.labelClass !== null &&
        classNamed(document, action.labelClass) === undefined
      ) {
        return UNCHANGED;
      }
      const before = toolFor(document, host.activeClass);
      const after = toolFor(document, action.labelClass);
      host.activateClass(action.labelClass);
      if (before === after) return CHANGED;
      return { changed: true, events: [{ type: "tool-changed" }] };
    }
    case "toggle-tag": {
      const command = toggleTagCommand(store.document, action.labelClass, context.mint);
      if (command === null) return UNCHANGED;
      store.execute(command);
      return CHANGED;
    }
    case "host":
      return host.run(action.name) ? CHANGED : UNCHANGED;
    default:
      return unreachable(action);
  }
}
