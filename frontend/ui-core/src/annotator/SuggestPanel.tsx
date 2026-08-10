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

import { EditorNotice } from "./EditorNotice";
import { Button } from "../primitives/Button";
import type { SuggestBlocker } from "../data/inferenceQueries";

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

  if (session.status === "asking") {
    return (
      <EditorNotice testId="suggest-panel" tone="calm" icon={<Loader2 className="size-4 animate-spin" />}>
        <p className="font-medium text-foreground" data-testid="suggest-asking">
          Looking at that…
        </p>
        {/* The route's own note, said where it matters: the first click on a frame
            pays for reading the whole image and every later one is nearly free. */}
        <p className="text-muted-foreground">
          The first click on a frame is the slow one — refining after it is quick.
        </p>
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
        </p>
        <Discard onDiscard={onDiscard} />
      </EditorNotice>
    );
  }

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
      {hasPending(session) && <Discard onDiscard={onDiscard} />}
    </EditorNotice>
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
