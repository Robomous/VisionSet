/**
 * The suggest tool's one voice: what it is doing, or why it cannot.
 *
 * ## An in-editor panel, and never a navigation
 *
 * `DESIGN.md` principle 10 — *the annotation workspace is self-sufficient*,
 * marked immovable — is the whole shape of this
 * component. Somebody who arms a tool over an unconfigured workspace must be
 * told, on the canvas, without leaving work behind. So this is a card floating
 * over the picture: not a toast (which disappears while somebody is reading it),
 * not a redirect (which loses the frame), and not a modal (which stops the
 * gesture the page exists for).
 *
 * **Where that card sits is `EditorNotice`'s business and not this component's.**
 * Every message the editor floats over the stage goes to one top-right column, so
 * this file chooses the sentence and the tone and nothing about the geometry.
 *
 * ## One panel for six states, because they are one question
 *
 * "What is the suggest tool doing" has six honest answers, and each of them is a
 * sentence somewhere on this card: waiting for a click, asking, showing something
 * to accept, having found nothing, refusing, or parked over a class that can hold
 * nothing. The alternative — a spinner in one corner, an error surface in
 * another, an empty state somewhere else — scatters one answer across three
 * places and leaves the person to assemble it.
 *
 * The parked reading is the one that answers a control the strip has dimmed, so
 * it is the sentence principle 9 requires beside a disabled state. It says what
 * to change rather than what is wrong, and it says the tool is still armed —
 * because it is, and because a person who has just been told a capability does
 * not apply will otherwise assume they have to turn it back on.
 *
 * ## And one choice, in the one state where it is safe to make
 *
 * Where a workspace has more than one model that can answer a click, the idle
 * card carries the picker for it — never the asking or the accept card, because
 * changing which model answers while an answer is on screen would leave a
 * proposal nothing on the card explains. With a single candidate there is no
 * control at all, only the line naming it.
 *
 * Principle 9, *never disable without explanation*, is what makes the refusal
 * cases carry a remedy rather than a state: "not configured" names the thing to
 * make, "not ready" names the download, and a server refusal is quoted **as the
 * server wrote it**, because those messages carry the exact install command
 * (`_extra.py`: *"the message is the remedy"*).
 *
 * ## The action is a callback, and its absence renders nothing
 *
 * `ui-core` imports no router — `information-architecture` states it — so where
 * "set one up" goes is the host's. A host that has nowhere to send somebody
 * passes no callback and gets the explanation with **no control at all**, which
 * is `onOpenGallery`'s established rule: a host that cannot honour a control
 * renders no control rather than a dead one. The sentence is useful on its own,
 * and a button that did nothing would be worse than no button.
 */

import {
  MAXIMUM_TOLERANCE,
  MINIMUM_TOLERANCE,
  vertexCount,
  isAcceptable,
  isParked,
  hasPending,
  type SuggestionState,
} from "@visionset/annotator";
import { Check, Loader2, Sparkles, TriangleAlert, X } from "lucide-react";
import type { JSX, ReactNode } from "react";

import { EditorNotice } from "./EditorNotice";
import { Button } from "../primitives/Button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../primitives/Select";
import type { Connection, SuggestBlocker } from "../data/inferenceQueries";

export interface SuggestPanelProps {
  /** The session, whose status decides which sentence this card carries. */
  readonly session: SuggestionState;
  /**
   * The class the workspace is on.
   *
   * The same thing as `session.labelClass` for every reading but one: a **parked**
   * session has no class of its own, and the sentence it needs is about the class
   * the person just picked. Naming it is the difference between "that will not
   * work" and knowing which choice to change.
   */
  readonly heldClass: string | null;
  /**
   * Why the tool cannot run at all, from the connection list — or `null` when it
   * can, and `undefined` while the list is still loading.
   */
  readonly blocker: SuggestBlocker | null | undefined;
  /**
   * The server's own words for a refusal, when one happened.
   *
   * Quoted rather than restated: `LOCAL_INFERENCE_UNAVAILABLE`,
   * `INFERENCE_CONNECTION_NOT_RUNNABLE` and `INFERENCE_OUT_OF_MEMORY` are all
   * `expose_message=True`, each because the message carries the remedy - an
   * install command for the first two, freeing the device or picking a smaller
   * model for the third - and a sentence written here would throw that away.
   * `refusalProse` is what turns the rest into prose.
   */
  readonly refusal: string | null;
  /**
   * Every connection a click *could* go through, in the list's own order.
   *
   * One is the common case and renders as a line naming it rather than as a
   * control: a picker over a single option is a decision nobody has. Two or more
   * render a picker, because at that point which model answers is a choice, and
   * one made per project rather than per click.
   */
  readonly candidates?: readonly Connection[];
  /** Which of them a click goes through now. */
  readonly connectionId?: string | null;
  /** Absent leaves the choice unrendered, on `onConfigure`'s rule. */
  readonly onChooseConnection?: (connectionId: string) => void;
  /** Where a person goes to make or finish a connection, if the host has one. */
  readonly onConfigure?: () => void;
  readonly onAccept: () => void;
  readonly onDiscard: () => void;
  /** Whether the adjustments are open. Owned by the host, because `Esc` layers on it. */
  readonly adjusting?: boolean;
  readonly onAdjusting?: (open: boolean) => void;
  /** A tolerance, applied without a request. */
  readonly onTolerance?: (tolerance: number) => void;
  /**
   * Whether the wait has lasted long enough to be worth explaining.
   *
   * The cold-start sentence used to ride along with the spinner on every click,
   * including the fast ones it is not about. It is true of the first click on a
   * frame, so it waits for a wait that is plausibly that one. Decided by the
   * host's `usePendingIndicator` — which is now the *only* thing that clock is
   * for, since the canvas stopped reporting the wait at all (#557).
   */
  readonly pendingEscalated?: boolean;
}

/**
 * What each blocker says, and what its action means.
 *
 * A record rather than a ternary chain so the set is readable as a table and a
 * further blocker cannot be added to the union without an entry — the same reason
 * `ToolPalette`'s `TOOL_LABELS` is total over what `drawableGeometry` answers.
 */
const BLOCKER_COPY: Readonly<
  Record<
    SuggestBlocker,
    {
      readonly title: string;
      readonly body: string;
      /** What the way out is called, or `null` where there is nothing to press. */
      readonly action: string | null;
      readonly tone: "calm" | "warn";
    }
  >
> = {
  // Not a warning: nothing is wrong, the answer is simply not back. A red card
  // for a request in flight would teach somebody to distrust a working tool.
  checking: {
    title: "Getting the model ready…",
    body: "Checking which model connection this workspace can suggest through.",
    action: null,
    tone: "calm",
  },
  "no-connections": {
    title: "No model connection yet",
    body: "Suggesting a shape runs a segmentation model through a connection, and this workspace has none configured. Set one up once and every job can use it.",
    action: "Set up a connection",
    tone: "warn",
  },
  "not-ready": {
    title: "The model is not downloaded yet",
    body: "This workspace has a connection, but its weights are not on this machine. Downloading them is a one-time step and runs in the background.",
    action: "Finish setting it up",
    tone: "warn",
  },
  // Ranked *below* `not-ready` by `usableConnection`, and the copy relies on it:
  // this sentence is only ever read where something is downloaded and running,
  // so "the model you have" is a model that is genuinely here.
  // The sentence names what the model has to *do* rather than which family does
  // it. More than one architecture answers a point now, so a copy naming one of
  // them was a second place the supported list lived — and the one that goes
  // stale silently, because no build fails when prose falls behind a register.
  "not-capable": {
    title: "That model answers a different question",
    body: "Suggesting a shape needs a model that takes points and answers with a region. The connections that are ready here answer something else, so a click would come back refused.",
    action: "Set up a connection",
    tone: "warn",
  },
};

export function SuggestPanel({
  session,
  heldClass,
  blocker,
  refusal,
  candidates = [],
  connectionId = null,
  onChooseConnection,
  onConfigure,
  onAccept,
  onDiscard,
  adjusting,
  onAdjusting,
  onTolerance,
  pendingEscalated = false,
}: SuggestPanelProps): JSX.Element {
  /*
    Parked outranks even the blocker. A connection this tool will not use
    is not the thing standing in the way, and "getting the model ready" over a
    class that could never hold the answer would be the wrong sentence twice: it
    reports progress towards something that is not going to happen, and it hides
    the one choice the person can change.
  */
  if (isParked(session)) {
    return (
      <EditorNotice testId="suggest-panel" tone="calm" icon={<Sparkles className="size-4" />}>
        <p className="font-medium text-foreground" data-testid="suggest-parked">
          {heldClass === null
            ? "Nothing selected to suggest for"
            : `“${heldClass}” cannot hold a suggestion`}
        </p>
        <p className="text-muted-foreground">
          A suggestion comes back as a box or a polygon. Pick a class that holds one
          and the tool carries on from here — it is still armed.
        </p>
        {/*
          No `Esc` chip beside it, unlike the other take-backs on this card. The
          chord is a substitution the canvas makes while something is pending, and
          a parked session has nothing pending — so printing the key would be
          printing one that does nothing. This button is the way out, and it is
          why the dimmed strip button is not a trap.
        */}
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 self-start"
          data-testid="suggest-discard"
          onClick={onDiscard}
        >
          <X className="size-4" aria-hidden="true" />
          Put the tool away
        </Button>
      </EditorNotice>
    );
  }

  // The blocker outranks everything else: a session over a workspace with no
  // usable connection has nothing to report about a request it never made.
  if (blocker !== null && blocker !== undefined) {
    const copy = BLOCKER_COPY[blocker];
    return (
      <EditorNotice
        testId="suggest-panel"
        tone={copy.tone}
        icon={
          copy.tone === "warn" ? (
            <TriangleAlert className="size-4" />
          ) : (
            <Loader2 className="size-4 animate-spin" />
          )
        }
      >
        <p className="font-medium text-foreground" data-testid={`suggest-${blocker}`}>
          {copy.title}
        </p>
        <p className="text-muted-foreground">{copy.body}</p>
        {/* The action's *destination* is the host's, so its absence removes the
            control and leaves the explanation — never a dead button. */}
        {copy.action !== null && onConfigure !== undefined && (
          <Button
            variant="secondary"
            size="sm"
            className="mt-1 self-start"
            data-testid="suggest-configure"
            onClick={onConfigure}
          >
            {copy.action}
          </Button>
        )}
      </EditorNotice>
    );
  }

  if (session.status === "refused") {
    return (
      <EditorNotice testId="suggest-panel" tone="warn" icon={<TriangleAlert className="size-4" />}>
        <p className="font-medium text-foreground">That suggestion could not be made</p>
        {/* The server's sentence, verbatim. It is the one that carries the
            install command when the cause is a missing extra. */}
        <p className="text-muted-foreground" data-testid="suggest-refusal">
          {refusal ?? session.refusal}
        </p>
        <p className="text-muted-foreground">
          Your clicks are still here — press Esc to clear them, or click again to retry.
        </p>
      </EditorNotice>
    );
  }

  // Back to the status alone. This was gated on a 200ms threshold, on the theory
  // that a warm answer would beat it and the card would never appear; dogfooding
  // showed inference never resolves that fast, so the gate suppressed nothing.
  // The floor that stops the card leaving too *soon* is what survives, and it
  // lives in `usePendingIndicator` rather than here.
  if (session.status === "asking") {
    return (
      <EditorNotice testId="suggest-panel" tone="calm" icon={<Loader2 className="size-4 animate-spin" />}>
        <p className="font-medium text-foreground" data-testid="suggest-asking">
          Looking at that…
        </p>
        {/* The route's own note, said where it matters: the first click on a frame
            pays for reading the whole image and every later one is nearly free.
            Held back until the wait is long enough to plausibly *be* that first
            click — printed on a fast one it explains a delay nobody experienced. */}
        {pendingEscalated && (
          <p className="text-muted-foreground" data-testid="suggest-cold-start">
            The first click on a frame is the slow one — refining after it is quick.
          </p>
        )}
      </EditorNotice>
    );
  }

  if (session.status === "none") {
    return (
      <EditorNotice testId="suggest-panel" tone="calm" icon={<Sparkles className="size-4" />}>
        <p className="font-medium text-foreground" data-testid="suggest-none">
          Nothing to suggest there
        </p>
        <p className="text-muted-foreground">
          Click nearer the middle of the object, or add another point. Alt-click marks
          something that is <em>not</em> part of it.
          {hasAdjustments(session) && " The settings below still apply — step one back."}
        </p>
        <Discard onDiscard={onDiscard} />
        {/*
          The controls survive an answer with nothing in it, which is the whole of
          how somebody adjusts their way back out of one. Losing them here would
          leave a blank canvas and nothing to press but Escape, which throws the
          gesture away rather than undoing the setting that emptied it.
        */}
        <Adjustments
          session={session}
          open={adjusting === true}
          {...(onAdjusting === undefined ? {} : { onOpen: onAdjusting })}
          {...(onTolerance === undefined ? {} : { onTolerance })}
        />
      </EditorNotice>
    );
  }

  /*
    There is no longer a reading between these two. While the 200ms gate existed,
    a refine click spent that window here — the ask had gone out, the card above
    was still suppressed, and the shape `withPoint` keeps on screen needed a card
    that described it, with `Accept` dimmed because `acceptedAnnotation` answers
    `null` for any status but `shown`. With the gate gone the ask reaches the card
    above on the same frame it leaves, so that window has no duration and the
    branch that filled it is deleted rather than left unreachable.

    The shape itself still stays drawn through a refine — that is `paintSuggestion`
    testing what the session holds rather than what its status is, and it is why
    this card going away mid-refine costs nothing on the canvas.
  */
  if (isAcceptable(session)) {
    return (
      <EditorNotice testId="suggest-panel" tone="calm" icon={<Sparkles className="size-4" />}>
        <p className="font-medium text-foreground" data-testid="suggest-shown">
          A shape for “{session.labelClass}”
        </p>
        <p className="text-muted-foreground">
          Click again to refine it — alt-click to take a part away.
        </p>
        <div className="mt-1 flex gap-2">
          <Button variant="primary" size="sm" data-testid="suggest-accept" onClick={onAccept}>
            <Check className="size-4" aria-hidden="true" />
            Accept
            <Chip>↵</Chip>
          </Button>
          <Button variant="ghost" size="sm" data-testid="suggest-discard" onClick={onDiscard}>
            Discard
            <Chip>Esc</Chip>
          </Button>
        </div>
        <Adjustments
          session={session}
          open={adjusting === true}
          {...(onAdjusting === undefined ? {} : { onOpen: onAdjusting })}
          {...(onTolerance === undefined ? {} : { onTolerance })}
        />
      </EditorNotice>
    );
  }

  return (
    <EditorNotice testId="suggest-panel" tone="calm" icon={<Sparkles className="size-4" />}>
      <p className="font-medium text-foreground" data-testid="suggest-idle">
        Click the thing you want
      </p>
      <p className="text-muted-foreground">
        One click proposes a shape for “{session.labelClass}”. Alt-click marks something
        that is not part of it.
      </p>
      {/*
        Here and in no other reading. This is the state where nothing is in
        flight and nothing is waiting to be accepted, so it is the only one where
        changing which model answers cannot pull the ground out from under
        something already on screen.

        Gated on `hasPending` rather than on reaching this branch, which is the
        same thing today and has already stopped being it once — while the show
        threshold existed, a first click below it left this card up with its answer
        genuinely out. Stating the rule where it is enforced is what makes the
        branch ordering an implementation detail rather than the guarantee.
      */}
      {!hasPending(session) && (
        <Through
          candidates={candidates}
          connectionId={connectionId}
          {...(onChooseConnection === undefined ? {} : { onChoose: onChooseConnection })}
        />
      )}
      {hasPending(session) && <Discard onDiscard={onDiscard} />}
    </EditorNotice>
  );
}

/**
 * Which connection a click goes through: a line, or a picker where there is a choice.
 *
 * **One candidate renders no control**, which is the common case and the whole
 * of the friction argument: a select over a single option is a decision nobody
 * has, and it would sit in the editor asking to be read on every job. What stays
 * is the sentence naming the model, because a person who is about to spend
 * clicks on a suggestion should be able to see what is answering them.
 *
 * A host with no `onChoose` gets the sentence too, on the panel's standing rule:
 * an explanation with no control beats a control that does nothing.
 */
function Through({
  candidates,
  connectionId,
  onChoose,
}: {
  readonly candidates: readonly Connection[];
  readonly connectionId: string | null;
  readonly onChoose?: (connectionId: string) => void;
}): JSX.Element | null {
  const active = candidates.find((one) => one.id === connectionId) ?? candidates[0];
  if (active === undefined) return null;
  if (candidates.length === 1 || onChoose === undefined) {
    return (
      <p className="text-muted-foreground" data-testid="suggest-connection">
        Through “{active.name}”
      </p>
    );
  }
  return (
    <Select value={active.id} onValueChange={onChoose}>
      <SelectTrigger className="mt-1" data-testid="suggest-connection-select" aria-label="Model">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {candidates.map((one) => (
          // The two-line option: the name people gave it, then the model it
          // actually names. Two connections onto the same weights at different
          // precisions are otherwise told apart by nothing on screen.
          <SelectItem key={one.id} value={one.id} meta={one.model_id}>
            {one.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The take-back, where a state has something to take back and nothing to accept. */
function Discard({ onDiscard }: { readonly onDiscard: () => void }): JSX.Element {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="mt-1 self-start"
      data-testid="suggest-discard"
      onClick={onDiscard}
    >
      <X className="size-4" aria-hidden="true" />
      Clear the points
      <Chip>Esc</Chip>
    </Button>
  );
}

/** `AnnotationPage`'s chord chip, at this card's scale. Visual only. */
function Chip({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <kbd className="ml-1 rounded-sm border border-border bg-muted px-1 font-mono text-xs text-muted-foreground">
      {children}
    </kbd>
  );
}


/**
 * Whether this build has a control for anything the answer declared.
 *
 * `parameters` is an open vocabulary — a compatible release may add a member — so a
 * setting can be declared that this version has no way to draw. Two places need the
 * same answer and must not be able to disagree: the section that renders the
 * controls, and the copy telling somebody the settings are still there. This asks
 * whether *anything* is drawable; each row goes on asking whether its own setting
 * was declared, which is what keeps a second control one entry here and one row
 * below.
 */
function hasAdjustments(session: SuggestionState): boolean {
  return session.parameters.includes("tolerance");
}

/**
 * Keep the press from moving focus off the canvas.
 *
 * Every keyboard rule in the editor is a `keydown` on the annotator's own root,
 * so a control that took focus would silently switch them all off — `[` and `]`
 * would stop stepping, and `Esc` would stop being the preview's undo, both with
 * nothing on screen to say why. Found in a browser: jsdom has no focus to move.
 *
 * On the buttons only. **A range input drags on the default action**, so
 * cancelling its `mousedown` leaves a slider that looks alive and cannot be moved
 * by hand at all — which is what shipped, and what nothing caught, because the
 * test asserted the guard fired rather than that the thumb followed the pointer.
 * The slider uses {@link returnFocusToCanvas} instead: it takes focus for the
 * duration of the drag, like any form control, and hands it back on release.
 */
function keepFocusOnCanvas(event: { preventDefault: () => void }): void {
  event.preventDefault();
}

/**
 * Give the canvas its keyboard back once a pointer gesture on a control is over.
 *
 * The other half of the same rule, for a control whose default action is the
 * whole point of it. `FrameGallery` already returns focus this way after its
 * overlay closes, and by the same route — `ui-core` holds no ref to the
 * annotator's root, and threading one down for this would be a prop on every
 * layer between here and there.
 *
 * On release rather than on change: a drag emits a change per step, and pulling
 * focus mid-drag would end the gesture under the pointer.
 */
function returnFocusToCanvas(): void {
  document.querySelector<HTMLElement>('[data-testid="annotator-root"]')?.focus();
}

/**
 * The settings, inside the card that is already on screen.
 *
 * **A section rather than a popup**, which is the decision the whole thing turns
 * on: a proposal is a thing somebody is looking at, and a panel that opened over
 * the canvas would cover the shape being adjusted. It is collapsed by default
 * because the defaults are right most of the time, and `Esc` closes it before it
 * touches anything else — the nearest thing to hand is the thing a press undoes.
 *
 * **What renders is what the server declared, and nothing is worked out here.**
 * `session.parameters` comes off the answer; a box class declares nothing at all
 * and so gets no section, because that is what the kernel's table says applies to
 * a box, not because this file knows anything about boxes.
 *
 * The one thing this file does decide is whether it *has* a control, which is not
 * the same as deciding whether a setting applies. `parameters` is an open
 * vocabulary — a compatible release may add a member — so a setting can be
 * declared that this version has no way to draw, and offering `Adjust the shape`
 * over an empty box would be the dead control the section exists to avoid. Adding
 * a second setting is therefore a kernel change, a row below, and that setting's
 * name in the one line deciding whether anything is offerable.
 */
function Adjustments({
  session,
  open,
  onOpen,
  onTolerance,
}: {
  readonly session: SuggestionState;
  readonly open: boolean;
  readonly onOpen?: (open: boolean) => void;
  readonly onTolerance?: (tolerance: number) => void;
}): JSX.Element | null {
  // Gated on a setting this build has a row for, not on the list being non-empty:
  // a length test would offer `Adjust the shape` over an empty box the first time a
  // server named a setting this version cannot draw. See `hasAdjustments`.
  if (!hasAdjustments(session) || onOpen === undefined) return null;

  if (!open) {
    return (
      <button
        type="button"
        className="mt-1 w-fit text-xs text-muted-foreground underline-offset-2 hover:underline"
        data-testid="suggest-adjust-open"
        onMouseDown={keepFocusOnCanvas}
        onClick={() => onOpen(true)}
      >
        Adjust the shape
      </button>
    );
  }

  const { tolerance } = session.adjustments;
  return (
    <div
      className="mt-2 flex flex-col gap-2 border-t border-border pt-2"
      data-testid="suggest-adjustments"
    >
      {session.parameters.includes("tolerance") && onTolerance !== undefined && (
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">Detail</span>
          <div className="flex flex-1 items-center gap-2">
            {/*
              A doubling track: the thumb's position is log2 of the tolerance, so
              each halving takes the same distance and the fine end of the range
              is not squeezed into one pixel of travel. Quarter steps of the
              exponent give a continuous feel; the brackets walk whole doublings.

              A native `input[type=range]` and not a primitive, because there is no
              slider primitive in this package and one control does not earn one.
              It comes keyboard-operable and `focus-visible` for nothing.
            */}
            <input
              type="range"
              className="flex-1 accent-primary"
              min={Math.log2(MINIMUM_TOLERANCE)}
              max={Math.log2(MAXIMUM_TOLERANCE)}
              step={0.25}
              value={Math.log2(tolerance)}
              aria-label="Detail"
              aria-valuetext={`${px(tolerance)} px, ${vertexCount(session)} points`}
              data-testid="suggest-detail"
              // No `preventDefault` here: a range input *drags* on its default
              // action, so cancelling the press is what made this unmovable by
              // hand (#563). Focus goes back to the canvas on release instead, so
              // `[`, `]`, Esc and Enter are live again the moment the drag ends.
              onMouseUp={returnFocusToCanvas}
              onTouchEnd={returnFocusToCanvas}
              onChange={(event) =>
                onTolerance(Math.round(2 ** Number(event.target.value) * 100) / 100)
              }
            />
            {/*
              Tolerance and count in one label, because they are one fact: what
              this position costs. Tabular figures so the number does not shift
              the row as it changes under a held key.
            */}
            <span
              className="shrink-0 tabular-nums text-xs text-muted-foreground"
              data-testid="suggest-detail-label"
            >
              {px(tolerance)} px · {vertexCount(session)} pts
            </span>
            <Chip>[ ]</Chip>
          </div>
        </div>
      )}
    </div>
  );
}

/** `1.0`, `0.5`, `0.25` — one decimal for whole pixels, the exact fraction below. */
function px(tolerance: number): string {
  return Number.isInteger(tolerance) ? tolerance.toFixed(1) : String(tolerance);
}
