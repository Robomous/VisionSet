/**
 * The suggest tool's one voice: what it is doing, or why it cannot — said in the
 * tool's own bar over the picture.
 *
 * ## In the bar, and never a navigation
 *
 * `DESIGN.md` principle 10 — *the annotation workspace is self-sufficient*,
 * marked immovable — is the whole shape of this component. Somebody who arms a
 * tool over an unconfigured workspace must be told, in the editor, without
 * leaving work behind. So this is the armed tool's row in `ToolOptions`, the bar
 * every tool already has over the canvas: not a toast (which disappears while
 * somebody is reading it), not a redirect (which loses the frame), not a modal
 * (which stops the gesture the page exists for), and no longer a card floating
 * over the picture — a card sat on the thing being outlined, and the options it
 * carried are options of the *tool*, which is what the bar is for.
 *
 * Read left to right it is: where the click runs (`Server | Local`), the model
 * answering, the state in a few words with an ⓘ holding the rest, the shape it
 * returns, its Detail, the class it becomes — and, once something is outlined,
 * Accept and Discard at the bar's far end. Messages that are not the tool's — a
 * refused save, a refused progress move, a refused opening — stay in the notice
 * column (`EditorNotice`); this file has no say over that column any more.
 *
 * ## One phrase for six states, because they are one question
 *
 * "What is the suggest tool doing" has six honest answers — waiting for a click,
 * asking, showing something to accept, having found nothing, refusing, or parked
 * over a class that can hold nothing — and each is one short phrase in the same
 * slot of this bar, inside one live `status`. The alternative — a spinner in one
 * corner, an error surface in another, an empty state somewhere else — scatters
 * one answer across three places and leaves the person to assemble it.
 *
 * **The phrase is short; the sentence is one hover away, verbatim.** Every
 * explanation this tool used to print in full — why it is blocked, what parked
 * means, what to try when nothing was found, the cold-start note — is the ⓘ's
 * card, word for word, and also the ⓘ button's permanent description, so a
 * screen reader reaches it without opening anything. A server refusal is quoted
 * there **as the server wrote it**, because those messages carry the exact
 * install command (`_extra.py`: *"the message is the remedy"*); the bar says
 * *Suggestion refused* and the card says the rest.
 *
 * The parked reading is the one that answers a control the strip has dimmed, so
 * it is the phrase principle 9 requires beside a disabled state. It names the
 * class to change, its card says the tool is still armed — because it is, and a
 * person told a capability does not apply will otherwise assume they have to turn
 * it back on — and the way out, *Put the tool away*, is a button in the bar.
 *
 * ## And the choices, only in the states where they are safe to make
 *
 * Where the click runs, which model answers it, and which shape it returns are
 * drawn only while nothing is in flight and nothing is waiting to be accepted:
 * changing any of them while an answer is on screen would leave a proposal that
 * nothing in the bar explains. Gated on `hasPending` rather than on which branch
 * renders, so the rule is stated where it is enforced.
 *
 * With a single model there is no picker, only its name; with two or more, a
 * picker. `Local` appears only once a browser runtime is wired at all; a
 * server-side blocker is then a fact about `Server` alone and never hides
 * `Local`'s own Download. Box or polygon is offered only for a class the schema
 * declares both for — the same preference the strip's tools and the class row's
 * shape chips write (`suggestGeometriesFor`), never one this file invents.
 *
 * Detail is inline, and appears only where the server's answer declared the
 * tolerance (`session.parameters`); nothing here knows that a box has none.
 *
 * ## The action is a callback, and its absence renders nothing
 *
 * `ui-core` imports no router — `docs/content/ui/navigation.md` states it — so
 * where "set one up" goes is the host's. A host that has nowhere to send somebody
 * passes no callback and gets the explanation with **no control at all**, which
 * is `onOpenGallery`'s established rule: a host that cannot honour a control
 * renders no control rather than a dead one. The same holds for the model picker
 * (`onChooseConnection`) and Remove (`onRemoveBrowserModel`).
 *
 * ## The keyboard stays on the canvas
 *
 * Every chord the editor answers is a `keydown` on the annotator's own root, so
 * a press here that took focus would switch `[`, `]`, `Esc` and `↵` off with
 * nothing on screen to say why. The bar's buttons cancel the press's default
 * focus move; the slider cannot — its drag *is* that default — so it hands focus
 * back when the drag ends.
 */

import {
  MAXIMUM_TOLERANCE,
  MINIMUM_TOLERANCE,
  hasPending,
  isAcceptable,
  isParked,
  vertexCount,
  type SuggestibleGeometryType,
  type SuggestionState,
} from "@visionset/annotator";
import { Check, ChevronDown, Laptop, Loader2, Server, TriangleAlert, X } from "lucide-react";
import { useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from "react";

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Kbd,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from "@robomous/ui-core";
import type { Connection, SuggestBlocker } from "../data/inferenceQueries";
import type {
  ActiveSuggestionTarget,
  BrowserModelAcquisition,
  BrowserModelCatalogEntry,
  BrowserSuggestionTarget,
} from "../inference/browserPort.js";
import { InfoTip } from "../patterns/InfoTip";
import { GeometryIcon } from "./GeometryIcon";
import { keepCanvasFocus } from "./keepCanvasFocus";

/** The shapes a class admits that a segmenter can return, and which one a click asks for. */
export interface SuggestShapeChoice {
  /** Only offered as a choice when there are two. */
  readonly kinds: readonly SuggestibleGeometryType[];
  /** What a click asks for now, or `null` when the held tool narrows to neither. */
  readonly value: SuggestibleGeometryType | null;
  readonly onChoose: (kind: SuggestibleGeometryType) => void;
}

export interface SuggestBarProps {
  /** The session, whose status decides which phrase this bar carries. */
  readonly session: SuggestionState;
  /**
   * The class the workspace is on.
   *
   * The same thing as `session.labelClass` for every reading but one: a **parked**
   * session has no class of its own, and the phrase it needs is about the class
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
   * One is the common case and renders as its name rather than as a control: a
   * picker over a single option is a decision nobody has. Two or more render a
   * picker, because at that point which model answers is a choice, and one made
   * per project rather than per click.
   */
  readonly candidates?: readonly Connection[];
  /** Which of them a click goes through now. */
  readonly connectionId?: string | null;
  /** Absent leaves the choice unrendered, on `onConfigure`'s rule. */
  readonly onChooseConnection?: (connectionId: string) => void;
  /** Where a person goes to make or finish a connection, if the host has one. */
  readonly onConfigure?: () => void;
  /** Browser targets ready right now. `undefined` when no browser runtime is wired at all. */
  readonly browserTargets?: readonly BrowserSuggestionTarget[];
  /** Models not yet acquired. `undefined` when no browser runtime is wired at all. */
  readonly browserAcquisitions?: readonly BrowserModelAcquisition[];
  /** Reactive install/activation state. Absent keeps the Phase F acquisition UI. */
  readonly browserModels?: readonly BrowserModelCatalogEntry[];
  readonly onAcquireBrowserModel?: (id: string) => Promise<void>;
  readonly onRemoveBrowserModel?: (id: string) => Promise<void>;
  readonly activeTarget?: ActiveSuggestionTarget;
  readonly onChooseTarget?: (target: ActiveSuggestionTarget) => void;
  /** Called once an `acquire()` this bar started resolves, so the host can re-read `listTargets()`. */
  readonly onAcquired?: () => void;
  readonly onAccept: () => void;
  readonly onDiscard: () => void;
  /** A tolerance, applied without a request. */
  readonly onTolerance?: (tolerance: number) => void;
  /**
   * Whether the wait has lasted long enough to be worth explaining.
   *
   * The cold-start sentence is true of the first click on a frame, so it waits
   * for a wait that is plausibly that one. Decided by the host's
   * `usePendingIndicator` — the *only* thing that clock is for, since the canvas
   * stopped reporting the wait at all (#557).
   */
  readonly pendingEscalated?: boolean;
  /** Box or polygon, for a class that admits both. Absent offers no choice. */
  readonly shape?: SuggestShapeChoice;
  /** The class chip the bar draws for every tool, placed where these options put it. */
  readonly classSlot?: ReactNode;
  /**
   * Give the canvas its keyboard back once a pointer gesture on a control is over.
   *
   * The other half of {@link keepCanvasFocus}'s rule, for a slider, whose drag is
   * its `mousedown` default and so cannot be cancelled. On release rather than on
   * change: a drag emits a change per step, and pulling focus mid-drag would end
   * the gesture under the pointer.
   */
  readonly onReturnFocus?: () => void;
}

/**
 * What each blocker says: a phrase for the bar, the explanation for its card, and
 * what its action is called.
 *
 * A record rather than a ternary chain so the set is readable as a table and a
 * further blocker cannot be added to the union without an entry — the same reason
 * `ToolPalette`'s `TOOL_LABELS` is total over what `drawableGeometry` answers.
 */
const BLOCKER_COPY: Readonly<
  Record<
    SuggestBlocker,
    {
      readonly phrase: string;
      readonly body: string;
      /** What the way out is called, or `null` where there is nothing to press. */
      readonly action: string | null;
      readonly tone: Tone;
    }
  >
> = {
  // Not a warning: nothing is wrong, the answer is simply not back. A red phrase
  // for a request in flight would teach somebody to distrust a working tool.
  checking: {
    phrase: "Getting the model ready…",
    body: "Checking which model connection this workspace can suggest through.",
    action: null,
    tone: "busy",
  },
  "no-connections": {
    phrase: "No model connection",
    body: "Suggesting a shape runs a segmentation model through a connection, and this workspace has none configured. Set one up once and every job can use it.",
    action: "Set up",
    tone: "warn",
  },
  "not-ready": {
    phrase: "Model not downloaded",
    body: "This workspace has a connection, but its weights are not on this machine. Downloading them is a one-time step and runs in the background.",
    action: "Finish setup",
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
    phrase: "Model answers a different question",
    body: "Suggesting a shape needs a model that takes points and answers with a region. The connections that are ready here answer something else, so a click would come back refused.",
    action: "Set up",
    tone: "warn",
  },
};

const REFINEMENT_GUIDANCE = "Click again to refine it — alt-click to take a part away.";

type Tone = "calm" | "warn" | "busy";

/** The state in a few words — the phrase the bar's live `status` carries. */
interface Status {
  readonly testId: string;
  readonly tone: Tone;
  readonly phrase: string;
  /** Set when the phrase is a blocker's, whose card and action come from `BLOCKER_COPY`. */
  readonly blocker?: SuggestBlocker;
}

/** One line of the ⓘ's card, keyed by what it says rather than where it falls. */
type TipLine = readonly [key: string, line: ReactNode];

/** A failure the bar names in a word or two, with its sentence in the card. */
interface Failure {
  readonly short: string;
  readonly long: string;
}

export function SuggestBar(props: SuggestBarProps): JSX.Element {
  const local = useLocalOperations(props);
  const facts = readFacts(props);
  const status = readStatus(facts);
  const tip = readTip(facts, status, local.failure);

  return (
    <div className="flex min-w-max flex-1 items-center gap-2" data-testid="suggest-bar">
      {facts.choosing && <Choices facts={facts} local={local} />}
      <StatusPhrase status={status} />
      {tip.length > 0 && (
        <InfoTip label="About Suggest" describe testId="suggest-info" contentTestId="suggest-tip-card" descriptionTestId="suggest-tip">
          {tip.map(([key, line]) => (
            <span key={key} className="block">
              {line}
            </span>
          ))}
        </InfoTip>
      )}
      <StatusAction facts={facts} status={status} />
      <Adjust facts={facts} />
      {props.classSlot !== undefined && (
        <>
          <Divider />
          {props.classSlot}
        </>
      )}
      <Decisions facts={facts} status={status} />
    </div>
  );
}

/** Everything the bar reads off its props, decided once. */
interface Facts {
  readonly props: SuggestBarProps;
  readonly session: SuggestionState;
  /** A browser runtime is wired at all — the one place this fact is decided. */
  readonly runtimeWired: boolean;
  readonly parked: boolean;
  readonly pending: boolean;
  readonly blocker: SuggestBlocker | null;
  readonly target: "server" | "browser";
  /** Where it runs, which model, which shape: only once nothing is pending. */
  readonly choosing: boolean;
  /** Local is chosen and has no model to answer with yet. */
  readonly localUnacquired: boolean;
  /** …and is getting one ready: downloading, installed, or loading. */
  readonly localBusy: boolean;
  readonly catalogModel: BrowserModelCatalogEntry | undefined;
  readonly readyTarget: BrowserSuggestionTarget | undefined;
  readonly acquisition: BrowserModelAcquisition | undefined;
}

function readFacts(props: SuggestBarProps): Facts {
  const { session, activeTarget, browserModels } = props;
  // The one place this fact is decided. Repeating it at both the blocker's
  // precedence and the target switch risked them drifting apart — the guard
  // once fired on a wired runtime's own "not-ready" and blanked out the Local
  // control it should have deferred to.
  const runtimeWired =
    props.browserTargets !== undefined || props.browserAcquisitions !== undefined || browserModels !== undefined;
  const parked = isParked(session);
  const pending = hasPending(session);
  const blocker = props.blocker ?? null;
  const target = activeTarget?.kind ?? "server";
  const activeModel =
    activeTarget?.kind === "browser" ? browserModels?.find((model) => model.id === activeTarget.targetId) : undefined;
  return {
    props,
    session,
    runtimeWired,
    parked,
    pending,
    blocker,
    target,
    // Parked has nothing to choose for, and a blocker with no runtime wired
    // leaves nothing to choose between.
    choosing: !parked && !pending && !(!runtimeWired && blocker !== null),
    // The click this bar would otherwise invite is a silent no-op — the host holds
    // no executor for an unready browser target — so the invitation is replaced by
    // the Download beside it.
    localUnacquired: runtimeWired && target === "browser" && blocker === "not-ready",
    localBusy: activeModel !== undefined && BUSY_STATES.has(activeModel.state),
    catalogModel: browserModels?.[0],
    readyTarget: props.browserTargets?.[0],
    acquisition: props.browserAcquisitions?.[0],
  };
}

const BUSY_STATES: ReadonlySet<BrowserModelCatalogEntry["state"]> = new Set(["downloading", "installed", "activating"]);

/** The reading's phrase, most-blocking first. */
function readStatus(facts: Facts): Status | null {
  const { session, blocker } = facts;
  /*
    Parked outranks even the blocker. A connection this tool will not use is not
    the thing standing in the way, and "getting the model ready" over a class
    that could never hold the answer would be the wrong phrase twice: it reports
    progress towards something that is not going to happen, and it hides the one
    choice the person can change.
  */
  if (facts.parked) return parkedStatus(facts.props.heldClass);
  // The blocker outranks everything else: a session over a workspace with no
  // usable connection has nothing to report about a request it never made.
  // Only with no runtime wired — once one is, the blocker is `Server`'s alone.
  if (!facts.runtimeWired && blocker !== null) return blockerStatus(blocker);
  const answer = SESSION_STATUS[session.status];
  if (answer !== undefined) return answer;
  if (isAcceptable(session)) return { testId: "suggest-shown", tone: "calm", phrase: "Proposed shape" };
  return idleStatus(facts);
}

function parkedStatus(heldClass: string | null): Status {
  return {
    testId: "suggest-parked",
    tone: "calm",
    phrase: heldClass === null ? "Nothing selected to suggest for" : `“${heldClass}” cannot hold a suggestion`,
  };
}

/**
 * The readings the session's status alone decides. `asking` is said from the
 * frame the request leaves; the floor that stops it leaving too *soon* lives in
 * `usePendingIndicator`, not here.
 */
const SESSION_STATUS: Partial<Record<SuggestionState["status"], Status>> = {
  refused: { testId: "suggest-refused", tone: "warn", phrase: "Suggestion refused" },
  asking: { testId: "suggest-asking", tone: "busy", phrase: "Looking at that…" },
  none: { testId: "suggest-none", tone: "calm", phrase: "Nothing to suggest there" },
};

function idleStatus(facts: Facts): Status | null {
  // Whether `Server` is the side a person is looking at and `blocker` is about
  // it. The Local side's readiness never depends on `blocker`.
  if (facts.runtimeWired && facts.target === "server" && facts.blocker !== null) return blockerStatus(facts.blocker);
  if (!facts.localUnacquired) return { testId: "suggest-idle", tone: "calm", phrase: "Click the thing you want" };
  // While it is downloading or loading the Local control already says so, in
  // the same words; a second copy beside it would be the same fact twice.
  return facts.localBusy ? null : { testId: "suggest-idle-unacquired", tone: "calm", phrase: "Model not downloaded" };
}

/** The card behind the ⓘ: every sentence the current reading needs, verbatim. */
function readTip(facts: Facts, status: Status | null, failure: Failure | null): readonly TipLine[] {
  const { session } = facts;
  if (facts.parked) {
    return [
      [
        "parked",
        "A suggestion comes back as a box or a polygon. Pick a class that holds one and the tool carries on from here — it is still armed.",
      ],
    ];
  }
  if (status?.blocker !== undefined) return [["blocker", BLOCKER_COPY[status.blocker].body]];
  if (session.status === "refused") {
    return [
      // The server's sentence, verbatim. It is the one that carries the install
      // command when the cause is a missing extra.
      ["refusal", facts.props.refusal ?? session.refusal ?? ""],
      ["clicks", "Your clicks are still here — press Esc to clear them, or click again to retry."],
    ];
  }
  if (session.status === "asking") return askingTip(facts.props.pendingEscalated === true);
  if (session.status === "none") return [["none", noneTip(session, facts.props.onTolerance !== undefined)]];
  if (isAcceptable(session)) return [["shown", REFINEMENT_GUIDANCE]];
  return [...idleTip(facts, status), ...(facts.choosing && facts.target === "browser" ? localTip(facts, failure) : [])];
}

/**
 * The route's own note, said where it matters: the first click on a frame pays
 * for reading the whole image and every later one is nearly free. Held back
 * until the wait is long enough to plausibly *be* that first click — printed on
 * a fast one it explains a delay nobody experienced.
 */
function askingTip(escalated: boolean): readonly TipLine[] {
  return escalated ? [["cold-start", "The first click on a frame is the slow one — refining after it is quick."]] : [];
}

function noneTip(session: SuggestionState, canAdjust: boolean): ReactNode {
  return (
    <>
      Click nearer the middle of the object, or add another point. Alt-click marks something that is{" "}
      <em>not</em> part of it.
      {hasAdjustments(session) && canAdjust && " The Detail setting still applies — step one back."}
    </>
  );
}

function idleTip(facts: Facts, status: Status | null): readonly TipLine[] {
  const lines: TipLine[] = [];
  if (status?.testId === "suggest-idle") {
    lines.push([
      "idle",
      `One click proposes a shape for “${facts.session.labelClass ?? ""}”. Alt-click marks something that is not part of it.`,
    ]);
  }
  if (facts.localUnacquired) {
    lines.push([
      "unacquired",
      facts.localBusy
        ? "Local is getting the selected model ready. A click will work once loading finishes."
        : "Local has nothing to answer with yet, so a click does nothing. Download it, or switch back to Server.",
    ]);
  }
  return lines;
}

/** What Local has to add: what the model is, and anything true of its storage. */
function localTip(facts: Facts, failure: Failure | null): readonly TipLine[] {
  const { catalogModel: model, acquisition } = facts;
  const lines: TipLine[] = [];
  if (model !== undefined) {
    lines.push([
      "model",
      `${model.label} · ~${megabytes(model.bytes)} MB · ${model.license} · from ${model.source.label}. Runs in this browser, so the picture and the clicks stay on this machine.`,
    ]);
    lines.push(...storageNotes(model));
  } else if (acquisition !== undefined && facts.readyTarget === undefined) {
    lines.push(["model", `${acquisition.label} · ~${megabytes(acquisition.approxBytes)} MB. Runs in this browser.`]);
  }
  const said = failure ?? catalogFailure(model?.error);
  if (said !== null) lines.push(["failure", said.long]);
  return lines;
}

function storageNotes(model: BrowserModelCatalogEntry): readonly TipLine[] {
  const lines: TipLine[] = [];
  if (model.state === "ready" && model.storage === "session") {
    lines.push(["session-only", "Ready for this session, but it was not saved in this browser."]);
  }
  if (model.storage === "unknown") {
    lines.push(["storage-unknown", "Browser storage could not be checked. Remove this model to clear any saved files."]);
  }
  if (model.warning !== undefined && model.warning !== model.error) {
    lines.push(["catalog-warning", "The model registry could not be checked. A saved model can still run on this device."]);
  }
  return lines;
}

/** The story of one browser-model operation in flight, and how it failed. */
interface LocalOperations {
  readonly acquiring: boolean;
  readonly removing: boolean;
  readonly failure: Failure | null;
  readonly acquireModel?: (id: string) => void;
  readonly acquire?: () => void;
  readonly remove?: (id: string) => void;
}

/**
 * `acquire()` and `remove()` are not reactive, so the UI owns the story of one
 * attempt. Held at the bar rather than in the Local control because the ⓘ's card
 * has to be able to say how it failed too.
 */
function useLocalOperations({
  browserAcquisitions,
  onAcquireBrowserModel,
  onRemoveBrowserModel,
  onAcquired,
}: SuggestBarProps): LocalOperations {
  const [acquiring, setAcquiring] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const acquisition = browserAcquisitions?.[0];

  function run(work: () => Promise<void>, failed: Failure, onDone?: () => void): void {
    setAcquiring(true);
    setFailure(null);
    work().then(
      () => {
        setAcquiring(false);
        onDone?.();
      },
      () => {
        setAcquiring(false);
        setFailure(failed);
      },
    );
  }

  function remove(id: string): void {
    if (onRemoveBrowserModel === undefined) return;
    setRemoving(true);
    setFailure(null);
    onRemoveBrowserModel(id).then(
      () => setRemoving(false),
      () => {
        setRemoving(false);
        setFailure({ short: "Couldn't remove", long: "That model could not be removed. Try again." });
      },
    );
  }

  return {
    acquiring,
    removing,
    failure,
    ...(onAcquireBrowserModel === undefined
      ? {}
      : {
          acquireModel: (id: string) =>
            run(() => onAcquireBrowserModel(id), { short: "Download failed", long: "That download failed. Try again." }),
        }),
    ...(acquisition === undefined
      ? {}
      : {
          acquire: () =>
            run(() => acquisition.acquire(), { short: "Download failed", long: "Download failed. Try again." }, onAcquired),
        }),
    ...(onRemoveBrowserModel === undefined ? {} : { remove }),
  };
}

/** Where the click runs, and the model answering it — drawn only while choosing. */
function Choices({ facts, local }: { readonly facts: Facts; readonly local: LocalOperations }): JSX.Element {
  const { props, target, runtimeWired } = facts;

  function chooseTarget(next: "server" | "browser"): void {
    if (next === "server") {
      props.onChooseTarget?.({ kind: "server", connectionId: props.connectionId ?? "" });
      return;
    }
    const targetId = facts.readyTarget?.id ?? facts.catalogModel?.id ?? facts.acquisition?.id;
    if (targetId !== undefined) props.onChooseTarget?.({ kind: "browser", targetId });
  }

  return (
    <>
      {runtimeWired && (
        <Segmented
          label="Where it runs"
          value={target}
          onChange={chooseTarget}
          options={[
            { value: "server", label: "Server", icon: <Server aria-hidden="true" />, testId: "suggest-target-server" },
            { value: "browser", label: "Local", icon: <Laptop aria-hidden="true" />, testId: "suggest-target-browser" },
          ]}
        />
      )}
      {target === "server" && facts.blocker === null && (
        <Through
          candidates={props.candidates ?? []}
          connectionId={props.connectionId ?? null}
          {...(props.onChooseConnection === undefined ? {} : { onChoose: props.onChooseConnection })}
        />
      )}
      {/*
        Never gated on `blocker` — a server-side "not-ready"/"no-connections" is a
        fact about `Server` and says nothing about whether this browser can run
        something. It reads only the runtime's own lists.
      */}
      {runtimeWired && target === "browser" && (
        <LocalModel
          model={facts.catalogModel}
          target={facts.readyTarget}
          acquisition={facts.acquisition}
          local={local}
          failure={local.failure ?? catalogFailure(facts.catalogModel?.error)}
        />
      )}
    </>
  );
}

/** One live region for every phrase, mounted for the whole session so a change is announced. */
function StatusPhrase({ status }: { readonly status: Status | null }): JSX.Element {
  return (
    <span
      role="status"
      className={cn(
        "flex shrink-0 items-center gap-1.5 whitespace-nowrap text-sm",
        status?.tone === "warn" ? "text-foreground" : "text-muted-foreground",
      )}
      data-testid="suggest-status"
      data-tone={status?.tone ?? "calm"}
    >
      {status !== null && (
        <span className="flex items-center gap-1.5" data-testid={status.testId}>
          {status.tone === "warn" && <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />}
          {status.tone === "busy" && <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />}
          {status.phrase}
        </span>
      )}
    </span>
  );
}

/** The way out the phrase names, beside it: put the tool away, or set one up. */
function StatusAction({ facts, status }: { readonly facts: Facts; readonly status: Status | null }): JSX.Element | null {
  const { onDiscard, onConfigure } = facts.props;
  if (facts.parked) {
    /*
      No `Esc` chip beside it, unlike the other take-backs here. The chord is a
      substitution the canvas makes while something is pending, and a parked
      session has nothing pending — so printing the key would be printing one
      that does nothing. This button is the way out, and it is why the dimmed
      strip button is not a trap.
    */
    return (
      <Button
        variant="ghost"
        size="sm"
        className="h-8 shrink-0"
        data-testid="suggest-discard"
        onMouseDown={keepCanvasFocus}
        onClick={onDiscard}
      >
        <X aria-hidden="true" />
        Put the tool away
      </Button>
    );
  }
  // The action's *destination* is the host's, so its absence removes the
  // control and leaves the explanation — never a dead button.
  const action = status?.blocker === undefined ? null : BLOCKER_COPY[status.blocker].action;
  if (action === null || onConfigure === undefined) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-8 shrink-0"
      data-testid="suggest-configure"
      onMouseDown={keepCanvasFocus}
      onClick={onConfigure}
    >
      {action}
    </Button>
  );
}

/** The shape it returns and its Detail — each only where it applies. */
function Adjust({ facts }: { readonly facts: Facts }): JSX.Element | null {
  const { session, props } = facts;
  const shape = facts.choosing && props.shape !== undefined && props.shape.kinds.length >= 2 ? props.shape : null;
  const onTolerance =
    (session.status === "shown" || session.status === "none") && hasAdjustments(session) ? props.onTolerance : undefined;
  if (shape === null && onTolerance === undefined) return null;
  return (
    <>
      <Divider />
      {shape !== null && (
        <Segmented
          label="Shape"
          value={shape.value}
          onChange={shape.onChoose}
          options={shape.kinds.map((kind) => ({
            value: kind,
            label: kind === "bbox" ? "Box" : "Polygon",
            icon: <GeometryIcon tool={kind} className="size-3.5" />,
            testId: `suggest-shape-${kind}`,
          }))}
        />
      )}
      {onTolerance !== undefined && (
        <Detail session={session} onTolerance={onTolerance} onReturnFocus={props.onReturnFocus} />
      )}
    </>
  );
}

/** The bar's far end: accept or discard a proposal, or clear what is pending. */
function Decisions({ facts, status }: { readonly facts: Facts; readonly status: Status | null }): JSX.Element {
  const { onAccept, onDiscard } = facts.props;
  // Only the shown reading can be accepted — a blocker over a shown session has
  // nothing to report about a request it never made, and offers no Accept.
  const acceptable = status?.testId === "suggest-shown";
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
      {acceptable && (
        <Button size="sm" className="h-8" data-testid="suggest-accept" onMouseDown={keepCanvasFocus} onClick={onAccept}>
          <Check aria-hidden="true" />
          Accept
          <Kbd className="bg-primary-foreground/15 text-primary-foreground @max-[48rem]:hidden">↵</Kbd>
        </Button>
      )}
      {/* The take-back where something is pending: Discard beside Accept, or Clear
          where nothing can be accepted — found nothing, refused, or still asking. */}
      {!facts.parked && facts.pending && (acceptable || status?.blocker === undefined) && (
        <Button variant="ghost" size="sm" className="h-8" data-testid="suggest-discard" onMouseDown={keepCanvasFocus} onClick={onDiscard}>
          <X aria-hidden="true" />
          {acceptable ? "Discard" : "Clear"}
          <Kbd className="@max-[48rem]:hidden">Esc</Kbd>
        </Button>
      )}
    </span>
  );
}

function Divider(): JSX.Element {
  return <span aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 bg-border" />;
}

/**
 * A two-way choice drawn as one control: a `radiogroup` whose arrow keys move
 * the choice, with one tab stop. Below 48rem of bar the words drop and the icons
 * stay, and each radio keeps its word as its name.
 */
function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  readonly label: string;
  readonly value: T | null;
  readonly onChange: (value: T) => void;
  readonly options: readonly {
    readonly value: T;
    readonly label: string;
    readonly icon: ReactNode;
    readonly testId: string;
  }[];
}): JSX.Element {
  const group = useRef<HTMLDivElement | null>(null);

  function step(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const by = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (by === 0) return;
    event.preventDefault();
    const next = options[(index + by + options.length) % options.length];
    if (next === undefined) return;
    onChange(next.value);
    group.current?.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)?.focus();
  }

  const focusable = options.some((one) => one.value === value) ? value : options[0]?.value;
  return (
    <div ref={group} role="radiogroup" aria-label={label} className="flex h-8 shrink-0 items-center rounded-md bg-muted p-0.5">
      {options.map((option, index) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={option.label}
            tabIndex={option.value === focusable ? 0 : -1}
            data-value={option.value}
            data-testid={option.testId}
            onMouseDown={keepCanvasFocus}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => step(event, index)}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-[5px] px-2 text-xs font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-3.5",
              on ? "bg-background text-foreground shadow-xs ring-1 ring-foreground/10" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.icon}
            <span aria-hidden="true" className="@max-[48rem]:hidden">
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Which connection a click goes through: its name, or a picker where there is a choice.
 *
 * **One candidate renders no control**, which is the common case and the whole
 * of the friction argument: a select over a single option is a decision nobody
 * has, and it would sit in the editor asking to be read on every job. What stays
 * is the name, because a person who is about to spend clicks on a suggestion
 * should be able to see what is answering them.
 *
 * A host with no `onChoose` gets the name too, on the bar's standing rule: an
 * explanation with no control beats a control that does nothing.
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
      <span
        className="max-w-48 shrink-0 truncate text-sm text-muted-foreground"
        title={active.model_id}
        data-testid="suggest-connection"
      >
        {active.name}
      </span>
    );
  }
  return (
    <Select value={active.id} onValueChange={onChoose}>
      <SelectTrigger
        size="sm"
        className="h-8 w-auto max-w-56 shrink-0 gap-2 text-xs"
        data-testid="suggest-connection-select"
        aria-label="Model"
      >
        {/* The name alone on the bar; the list says which weights each one is. */}
        <SelectValue>{active.name}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {candidates.map((one) => (
          // The two-line option: the name people gave it, then the model it
          // actually names. Two connections onto the same weights at different
          // precisions are otherwise told apart by nothing on screen.
          <SelectItem key={one.id} value={one.id}>
            <span className="flex flex-col items-start">
              <span>{one.name}</span>
              <span className="text-xs text-muted-foreground">{one.model_id}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function catalogFailure(error: string | undefined): Failure | null {
  if (error === undefined) return null;
  if (/sha-256|size mismatch|verification/i.test(error)) {
    return {
      short: "Failed verification",
      long: "This model failed verification. Download it again to use it on this device.",
    };
  }
  return { short: "Failed", long: "That browser model operation failed. Try again." };
}

function blockerStatus(blocker: SuggestBlocker): Status {
  const copy = BLOCKER_COPY[blocker];
  return { testId: `suggest-${blocker}`, tone: copy.tone, phrase: copy.phrase, blocker };
}

function megabytes(bytes: number): number {
  return Math.round(bytes / 1_000_000);
}

/**
 * The browser model, compactly: its name, where it stands, and the one move it
 * needs — Download (with its size), or nothing while it downloads and loads.
 * Remove and the model's source sit in the small menu on its name, because they
 * are the rare moves.
 *
 * Phase F ships exactly one browser-suggestible model, so this never chooses
 * between several: it reads the catalog's entry where there is a catalog, and the
 * runtime's ready target or acquisition where there is not.
 */
function LocalModel({
  model,
  target,
  acquisition,
  local,
  failure,
}: {
  readonly model: BrowserModelCatalogEntry | undefined;
  readonly target: BrowserSuggestionTarget | undefined;
  readonly acquisition: BrowserModelAcquisition | undefined;
  readonly local: LocalOperations;
  readonly failure: Failure | null;
}): JSX.Element | null {
  if (model !== undefined) return <CatalogModel model={model} local={local} failure={failure} />;
  if (target !== undefined) {
    return (
      <div className="flex shrink-0 items-center gap-1.5" data-testid="suggest-device-section">
        <span className="shrink-0 text-xs font-medium">{target.label}</span>
        <Ready>Ready</Ready>
      </div>
    );
  }
  if (acquisition === undefined) return null;
  return (
    <div className="flex shrink-0 items-center gap-1.5" data-testid="suggest-device-section">
      <span className="shrink-0 text-xs font-medium">{acquisition.label}</span>
      {local.acquire !== undefined && (
        <DownloadButton id={acquisition.id} bytes={acquisition.approxBytes} busy={local.acquiring} onPress={local.acquire} />
      )}
      <FailureAlert failure={failure} />
    </div>
  );
}

/** A catalog model: its name and small menu, where it stands, and Download where it needs one. */
function CatalogModel({
  model,
  local,
  failure,
}: {
  readonly model: BrowserModelCatalogEntry;
  readonly local: LocalOperations;
  readonly failure: Failure | null;
}): JSX.Element {
  const { acquireModel } = local;
  return (
    <div className="flex shrink-0 items-center gap-1.5" data-testid="suggest-device-section">
      <ModelMenu model={model} removing={local.removing} {...(local.remove === undefined ? {} : { onRemove: local.remove })} />
      <ModelState model={model} removing={local.removing} />
      {(model.state === "available" || model.state === "failed") && acquireModel !== undefined && (
        <DownloadButton id={model.id} bytes={model.bytes} busy={local.acquiring} onPress={() => acquireModel(model.id)} />
      )}
      <FailureAlert failure={failure} />
    </div>
  );
}

/** The model's name, opening the rare moves: where it comes from, and Remove. */
function ModelMenu({
  model,
  removing,
  onRemove,
}: {
  readonly model: BrowserModelCatalogEntry;
  readonly removing: boolean;
  readonly onRemove?: (id: string) => void;
}): JSX.Element {
  const canRemove = model.storage !== "none" || model.state === "installed" || model.state === "ready";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 max-w-48 gap-1 px-2 text-xs"
          aria-label={`${model.label}, model options`}
          data-testid="suggest-device-menu"
        >
          <span className="truncate font-medium">{model.label}</span>
          <ChevronDown aria-hidden="true" className="size-3 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          ~{megabytes(model.bytes)} MB · {model.license}
        </DropdownMenuLabel>
        <DropdownMenuItem asChild>
          <a href={model.source.href} target="_blank" rel="noreferrer">
            Source: {model.source.label}
          </a>
        </DropdownMenuItem>
        {canRemove && onRemove !== undefined && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={removing}
              data-testid={`suggest-device-remove-${model.id}`}
              onSelect={() => onRemove(model.id)}
            >
              Remove from this browser
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Where the model stands, in a word — the catalog's state, or a remove in flight. */
function ModelState({ model, removing }: { readonly model: BrowserModelCatalogEntry; readonly removing: boolean }): JSX.Element | null {
  if (removing) return <Working>Removing…</Working>;
  if (model.state === "downloading") return <Working>Downloading…</Working>;
  if (model.state === "activating") return <Working>Loading…</Working>;
  if (model.state === "installed") return <span className="shrink-0 text-xs text-muted-foreground">Installed</span>;
  if (model.state !== "ready") return null;
  // Usable now, but not kept: said without claiming the model is installed.
  return model.storage === "session" ? <Ready testId="suggest-device-session-only">Ready, not saved</Ready> : <Ready>Ready</Ready>;
}

/** A failure in a word or two; its sentence is in the ⓘ's card. Never swallowed. */
function FailureAlert({ failure }: { readonly failure: Failure | null }): JSX.Element | null {
  if (failure === null) return null;
  return (
    <span role="alert" className="shrink-0 whitespace-nowrap text-xs text-destructive" data-testid="suggest-device-failure">
      {failure.short}
    </span>
  );
}

function DownloadButton({
  id,
  bytes,
  busy,
  onPress,
}: {
  readonly id: string;
  readonly bytes: number;
  readonly busy: boolean;
  readonly onPress: () => void;
}): JSX.Element {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8 shrink-0 gap-1.5 text-xs"
      data-testid={`suggest-device-acquire-${id}`}
      aria-label={busy ? "Downloading to this browser" : `Download to this browser, ${megabytes(bytes)} MB`}
      disabled={busy}
      onMouseDown={keepCanvasFocus}
      onClick={onPress}
    >
      {busy ? (
        <>
          <Loader2 aria-hidden="true" className="animate-spin" />
          Downloading…
        </>
      ) : (
        <>
          Download
          <span className="tabular-nums text-muted-foreground">{megabytes(bytes)} MB</span>
        </>
      )}
    </Button>
  );
}

function Working({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      {children}
    </span>
  );
}

function Ready({ children, testId }: { readonly children: ReactNode; readonly testId?: string }): JSX.Element {
  return (
    <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-muted-foreground" data-testid={testId}>
      <Check className="size-3.5 text-success" aria-hidden="true" />
      {children}
    </span>
  );
}

/**
 * Whether this build has a control for anything the answer declared.
 *
 * `parameters` is an open vocabulary — a compatible release may add a member — so a
 * setting can be declared that this version has no way to draw. Two places need the
 * same answer and must not be able to disagree: the slider, and the card's line
 * saying the setting still applies.
 */
function hasAdjustments(session: SuggestionState): boolean {
  return session.parameters.includes("tolerance");
}

/**
 * Detail, inline in the bar.
 *
 * **What renders is what the server declared, and nothing is worked out here.**
 * `session.parameters` comes off the answer; a box class declares nothing at all
 * and so gets no slider, because that is what the kernel's table says applies to
 * a box, not because this file knows anything about boxes. Adding a second
 * setting is a kernel change, a control here, and that setting's name in
 * {@link hasAdjustments}.
 *
 * Inline rather than behind a toggle: the bar has room for one slider, and a
 * disclosure over it would only be a click between somebody and the setting.
 */
function Detail({
  session,
  onTolerance,
  onReturnFocus,
}: {
  readonly session: SuggestionState;
  readonly onTolerance: (tolerance: number) => void;
  readonly onReturnFocus: (() => void) | undefined;
}): JSX.Element {
  const { tolerance } = session.adjustments;
  return (
    <div role="group" aria-label="Shape detail" className="flex shrink-0 items-center gap-2" data-testid="suggest-adjustments">
      <span aria-hidden="true" className="text-xs text-muted-foreground @max-[48rem]:hidden">
        Detail
      </span>
      {/*
        A doubling track: the thumb's position is log2 of the tolerance, so each
        halving takes the same distance and the fine end of the range is not
        squeezed into one pixel of travel. Quarter steps of the exponent give a
        continuous feel; the brackets walk whole doublings.

        A native `input[type=range]` and not a primitive: it comes keyboard-operable
        and `focus-visible` for nothing, and its drag is the default action the
        bar's focus guard deliberately leaves alone.
      */}
      <input
        type="range"
        className="w-24 accent-primary"
        min={Math.log2(MINIMUM_TOLERANCE)}
        max={Math.log2(MAXIMUM_TOLERANCE)}
        step={0.25}
        value={Math.log2(tolerance)}
        aria-label="Detail"
        aria-valuetext={`${px(tolerance)} px, ${vertexCount(session)} points`}
        data-testid="suggest-detail"
        onMouseUp={onReturnFocus}
        onTouchEnd={onReturnFocus}
        onChange={(event) => onTolerance(Math.round(2 ** Number(event.target.value) * 100) / 100)}
      />
      {/*
        Tolerance and count in one label, because they are one fact: what this
        position costs. Tabular figures so the number does not shift the row as it
        changes under a held key.
      */}
      <span className="shrink-0 tabular-nums text-xs text-muted-foreground" data-testid="suggest-detail-label">
        {px(tolerance)} px · {vertexCount(session)} pts
      </span>
      <Kbd className="@max-[48rem]:hidden">[ ]</Kbd>
    </div>
  );
}

/** `1.0`, `0.5`, `0.25` — one decimal for whole pixels, the exact fraction below. */
function px(tolerance: number): string {
  return Number.isInteger(tolerance) ? tolerance.toFixed(1) : String(tolerance);
}
