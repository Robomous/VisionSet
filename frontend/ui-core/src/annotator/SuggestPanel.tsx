/**
 * The suggest tool's one voice: what it is doing, or why it cannot (#424, D6).
 *
 * ## An in-editor panel, and never a navigation
 *
 * `DESIGN.md` principle 10 — *the annotation workspace is self-sufficient*,
 * ratified 2026-08-05 and marked immovable — is the whole shape of this
 * component. Somebody who arms a tool over an unconfigured workspace must be
 * told, on the canvas, without leaving work behind. So this is a card floating
 * over the picture: not a toast (which disappears while somebody is reading it),
 * not a redirect (which loses the frame), and not a modal (which stops the
 * gesture the page exists for).
 *
 * ## One panel for six states, because they are one question
 *
 * "What is the suggest tool doing" has six honest answers, and each of them is a
 * sentence somewhere on this card: waiting for a click, asking, showing something
 * to accept, having found nothing, refusing, or parked over a class that can hold
 * nothing (#472). The alternative — a spinner in one corner, an error surface in
 * another, an empty state somewhere else — scatters one answer across three
 * places and leaves the person to assemble it.
 *
 * The parked reading is the one that answers a control the strip has dimmed, so
 * it is the sentence principle 9 requires beside a disabled state. It says what
 * to change rather than what is wrong, and it says the tool is still armed —
 * because it is, and because a person who has just been told a capability does
 * not apply will otherwise assume they have to turn it back on.
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
  isAcceptable,
  isParked,
  hasPending,
  type SuggestionState,
} from "@visionset/annotator";
import { Check, Loader2, Sparkles, TriangleAlert, X } from "lucide-react";
import type { JSX, ReactNode } from "react";

import { Button } from "../primitives/Button";
import type { SuggestBlocker } from "../data/inferenceQueries";

export interface SuggestPanelProps {
  /** The session, whose status decides which sentence this card carries. */
  readonly session: SuggestionState;
  /**
   * The class the workspace is on (#472).
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
   * Quoted rather than restated: `LOCAL_INFERENCE_UNAVAILABLE` and
   * `INFERENCE_CONNECTION_NOT_RUNNABLE` are both `expose_message=True` precisely
   * so the install command reaches a person, and a sentence written here would
   * throw that away. `refusalProse` is what turns the rest into prose.
   */
  readonly refusal: string | null;
  /** Where a person goes to make or finish a connection, if the host has one. */
  readonly onConfigure?: () => void;
  readonly onAccept: () => void;
  readonly onDiscard: () => void;
}

/**
 * What the two blockers say, and what each one's action means.
 *
 * A record rather than a ternary chain so the pair is readable as a table and a
 * third blocker cannot be added to the copy without an entry — the same reason
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
};

export function SuggestPanel({
  session,
  heldClass,
  blocker,
  refusal,
  onConfigure,
  onAccept,
  onDiscard,
}: SuggestPanelProps): JSX.Element {
  /*
    Parked outranks even the blocker (#472). A connection this tool will not use
    is not the thing standing in the way, and "getting the model ready" over a
    class that could never hold the answer would be the wrong sentence twice: it
    reports progress towards something that is not going to happen, and it hides
    the one choice the person can change.
  */
  if (isParked(session)) {
    return (
      <Card testId="suggest-panel" tone="calm" icon={<Sparkles className="size-4" />}>
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
      </Card>
    );
  }

  // The blocker outranks everything else: a session over a workspace with no
  // usable connection has nothing to report about a request it never made.
  if (blocker !== null && blocker !== undefined) {
    const copy = BLOCKER_COPY[blocker];
    return (
      <Card
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
      </Card>
    );
  }

  if (session.status === "refused") {
    return (
      <Card testId="suggest-panel" tone="warn" icon={<TriangleAlert className="size-4" />}>
        <p className="font-medium text-foreground">That suggestion could not be made</p>
        {/* The server's sentence, verbatim. It is the one that carries the
            install command when the cause is a missing extra. */}
        <p className="text-muted-foreground" data-testid="suggest-refusal">
          {refusal ?? session.refusal}
        </p>
        <p className="text-muted-foreground">
          Your clicks are still here — press Esc to clear them, or click again to retry.
        </p>
      </Card>
    );
  }

  if (session.status === "asking") {
    return (
      <Card testId="suggest-panel" tone="calm" icon={<Loader2 className="size-4 animate-spin" />}>
        <p className="font-medium text-foreground" data-testid="suggest-asking">
          Looking at that…
        </p>
        {/* The route's own note, said where it matters: the first click on a frame
            pays for reading the whole image and every later one is nearly free. */}
        <p className="text-muted-foreground">
          The first click on a frame is the slow one — refining after it is quick.
        </p>
      </Card>
    );
  }

  if (session.status === "none") {
    return (
      <Card testId="suggest-panel" tone="calm" icon={<Sparkles className="size-4" />}>
        <p className="font-medium text-foreground" data-testid="suggest-none">
          Nothing to suggest there
        </p>
        <p className="text-muted-foreground">
          Click nearer the middle of the object, or add another point. Alt-click marks
          something that is <em>not</em> part of it.
        </p>
        <Discard onDiscard={onDiscard} />
      </Card>
    );
  }

  if (isAcceptable(session)) {
    return (
      <Card testId="suggest-panel" tone="calm" icon={<Sparkles className="size-4" />}>
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
      </Card>
    );
  }

  return (
    <Card testId="suggest-panel" tone="calm" icon={<Sparkles className="size-4" />}>
      <p className="font-medium text-foreground" data-testid="suggest-idle">
        Click the thing you want
      </p>
      <p className="text-muted-foreground">
        One click proposes a shape for “{session.labelClass}”. Alt-click marks something
        that is not part of it.
      </p>
      {hasPending(session) && <Discard onDiscard={onDiscard} />}
    </Card>
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
    <kbd className="ml-1 rounded-sm border border-border bg-muted px-1 font-mono text-meta text-muted-foreground">
      {children}
    </kbd>
  );
}

/**
 * The card itself: bottom-right of the stage, clear of the tool strip.
 *
 * Bottom-**right** rather than beside the strip, because the strip is top-left
 * and the object counter is bottom-left: this is the one corner the editor does
 * not already occupy, and a panel that covered the tools would hide the button
 * that arms it.
 */
function Card({
  testId,
  tone,
  icon,
  children,
}: {
  readonly testId: string;
  readonly tone: "calm" | "warn";
  readonly icon: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      data-testid={testId}
      data-tone={tone}
      role="status"
      /*
        Above the zoom widget, not beside it. Both are bottom-right overlays on
        the same stage, and at `bottom-2` this card sat *under* `ZoomWidget`'s
        `bottom-3` box — which does not merely look wrong: the widget's subtree
        intercepts the pointer, so the panel's own action could not be clicked at
        all. It shipped that way in #451 because nothing had a destination to
        click through to yet, and the e2e that gave it one is what found it.

        `bottom-16` clears the widget's 44px row and its gutter. The two never
        overlap now, so no z-index is needed and neither has to know about the
        other beyond this line.
      */
      className={`absolute bottom-16 right-3 flex max-w-80 gap-2 rounded-lg border p-3 text-meta shadow-lg ${
        tone === "warn"
          ? "border-destructive/40 bg-destructive/5"
          : "border-border bg-card"
      }`}
    >
      <span
        className={`mt-0.5 shrink-0 ${tone === "warn" ? "text-destructive" : "text-muted-foreground"}`}
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="flex min-w-0 flex-col gap-1">{children}</div>
    </div>
  );
}
