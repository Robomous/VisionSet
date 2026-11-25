/**
 * One model, opened from its row: what it is, and everything that can be done
 * to it — in a sheet over the page (`SideSheet`), the batch sheet's language.
 *
 * ## A slim bar, then a page
 *
 * A 48px bar: the way out, the walk (J/K, or its arrows) and where this model
 * sits among the rows shown, then every action the connection declares as an
 * icon button named by its tooltip — what ends or changes the model (Delete,
 * Edit) parted by a hairline from what sets it up and keeps it honest (the
 * two checks, the download, Test endpoint). Under the bar the model reads as a
 * page: its name, the weights behind the logo of where they come from, then its
 * properties as icon + label rows.
 *
 * ## What a press says takes a strip under the bar
 *
 * A run in flight, a failure and its remedy, the endpoint's answer: each is a
 * line in a strip between the bar and the page, so the bar never changes
 * height and the answer is next to the button that asked. The strip is a live
 * region that is always there, so its words are announced as they change. A
 * line that a press produces arrives from 4px above; a line that was already
 * there when J/K walked here appears at once — walking is frequent.
 *
 * ## Nothing here decides what is legal
 *
 * Which buttons exist is `allowed_actions` and nothing else; `setup_state` only
 * picks the reading of a declared download (Download weights below `Ready`,
 * Check for missing files at it), and a live run only withholds what a second
 * press would collide with — still focusable, its tooltip saying why
 * (`IconAction`, `ui-capabilities`). The rules behind each are in
 * `ModelsScreen.tsx`'s header.
 */

import {
  ChevronDown,
  ChevronsRight,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Cpu,
  Download,
  FileSearch,
  GitCommitHorizontal,
  Globe,
  HardDrive,
  KeyRound,
  Link2,
  Pencil,
  RadioTower,
  RotateCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useState, type JSX, type KeyboardEvent, type ReactNode } from "react";

import { Badge, Button, Spinner, cn } from "@robomous/ui-core";
import { useDownloadSize, useTestEndpoint, type Connection } from "../data/inferenceQueries";
import { refusalProse } from "../data/refusals";
import { formatCount } from "../lib/format";
import { IconAction } from "../patterns/IconAction";
import { CopyHash } from "./images/ImageParts";
import { SideSheet } from "../patterns/SideSheet";
import { StateChip, type State } from "../patterns/StateChip";
import { abilityLabels, bytes, isLocal, kindLabel, originLabel, sentence, STATE_LABELS } from "./modelCopy";
import { DownloadProgress, IntegrityProgress, RunProgress, useDownloadRun, useIntegrityRun } from "./modelRuns";
import { OriginLogo } from "./OriginLogo";

/** A press presses: 0.97, back in 100ms, transform only; none under reduced motion. */
const PRESS = "transition-[background-color,scale] duration-100 ease-out active:scale-[0.97] motion-reduce:transition-none";

/** A line arrives as its press lands: in from 4px above, 200ms on the strong ease-out — it says what just happened. */
const ARRIVE =
  "transition-[opacity,translate] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] starting:-translate-y-1 starting:opacity-0 motion-reduce:starting:translate-y-0";

/** The sheet's width: the person's, remembered, between a usable floor and most of the window. */
const WIDTH = { key: "detail-width:model-sheet", default: 480, min: 380, max: 960 } as const;

export interface ModelSheetProps {
  /** The model to show; `undefined` closes the sheet, which keeps the last one on screen while it slides out. */
  readonly connection: Connection | undefined;
  /** Where it sits among the rows the list shows. */
  readonly position: { readonly at: number; readonly count: number };
  readonly onStep: (step: 1 | -1) => void;
  readonly onClose: () => void;
  readonly onEdit: (connection: Connection) => void;
  readonly onDelete: (connection: Connection) => void;
}

export function ModelSheet({ connection, position, onStep, onClose, onEdit, onDelete }: ModelSheetProps): JSX.Element {
  // The model last shown, so the sheet leaves with it on screen rather than empty.
  const [last, setLast] = useState(connection);
  if (connection !== undefined && connection !== last) setLast(connection);
  const shown = connection ?? last;

  function walk(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
    if (event.key !== "j" && event.key !== "k") return;
    const target = event.target as HTMLElement;
    // A field owns its letters, and what the sheet opened (portalled out of it) owns its keys.
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable) return;
    if (!event.currentTarget.contains(target)) return;
    event.preventDefault();
    onStep(event.key === "j" ? 1 : -1);
  }

  return (
    <SideSheet
      open={connection !== undefined}
      id="model-sheet-panel"
      label="Model"
      widthKey={WIDTH.key}
      defaultWidth={WIDTH.default}
      minWidth={WIDTH.min}
      maxWidth={WIDTH.max}
      onClose={onClose}
      // Back to the row of the model last shown — the one J/K walked to.
      returnFocus={() => (shown === undefined ? null : document.getElementById(`model-open-${shown.id}`))}
      onKeyDown={walk}
      testId="model-sheet"
    >
      {shown !== undefined && (
        // Keyed by the model: a request made here for one model is never shown on another.
        <ModelDetail
          key={shown.id}
          connection={shown}
          position={position}
          onStep={onStep}
          onClose={onClose}
          onEdit={() => onEdit(shown)}
          onDelete={() => onDelete(shown)}
        />
      )}
    </SideSheet>
  );
}

function ModelDetail({
  connection,
  position,
  onStep,
  onClose,
  onEdit,
  onDelete,
}: {
  readonly connection: Connection;
  readonly position: ModelSheetProps["position"];
  readonly onStep: (step: 1 | -1) => void;
  readonly onClose: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}): JSX.Element {
  const ready = connection.setup_state === "ready";
  const weights = useDownloadRun(connection);
  const integrity = useIntegrityRun(connection);
  const probe = useTestEndpoint();
  const runs: Runs = { weights, integrity, probe };
  const runsOn = [kindLabel(connection.connection_type), connection.device, connection.precision].filter((part) => part != null && part !== "").join(" · ");

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" data-testid="model-detail">
      {/* 48px, the list page's band height: close, the walk, where this one sits, then the actions. */}
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border/70 px-2">
        <Walk position={position} onStep={onStep} onClose={onClose} />
        <span aria-hidden="true" className="min-w-0 flex-1" />
        <BarActions connection={connection} runs={runs} onEdit={onEdit} onDelete={onDelete} />
      </header>

      <Strip runs={runs} ready={ready} />

      <div className="vs-scroll-fade-y min-h-0 flex-1 overflow-y-auto px-6 pt-7 pb-10">
        <h2 className="text-[28px] leading-[1.15] font-semibold tracking-tight text-balance break-words">{connection.name}</h2>
        {/* What the connection *is*: its weights, whole, behind the logo of where they come from. */}
        <p className="mt-2 flex min-w-0 items-center gap-2" title={connection.model_id}>
          <OriginLogo origin={connection.origin} className="size-4" testId="sheet-origin" />
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" data-testid="sheet-weights">
            {connection.model_id}
          </span>
        </p>

        <dl className="mt-6 flex flex-col">
          <Property icon={CircleDashed} label="State">
            <StateChip state={stateOf(connection)} testId="connection-status" />
          </Property>
          {isLocal(connection) && <WeightsRow connection={connection} />}
          {/* Twelve characters say which revision; the whole one is a hover or a copy away, never a 40-character wrap. */}
          <Property icon={GitCommitHorizontal} label="Revision" testId="sheet-revision">
            <CopyHash hash={connection.model_revision} label="Copy revision" />
          </Property>
          <Property icon={Globe} label="Origin">
            <span className="flex items-center gap-2">
              <OriginLogo origin={connection.origin} className="size-3.5" decorative />
              {originLabel(connection.origin)}
            </span>
          </Property>
          {/* The kind, then whichever of device and precision it carries — nothing drawn for one it does not. */}
          <Property icon={Cpu} label="Runs on" testId="sheet-runs">
            {runsOn}
          </Property>
          {connection.endpoint_url != null && connection.endpoint_url !== "" && (
            <Property icon={Link2} label="Endpoint" align="start">
              <span className="font-mono text-xs leading-5 break-all">{connection.endpoint_url}</span>
            </Property>
          )}
          {/* The variable's name, never the credential. */}
          {connection.credential_env != null && connection.credential_env !== "" && (
            <Property icon={KeyRound} label="Credential">
              <span className="truncate font-mono text-xs">{connection.credential_env}</span>
            </Property>
          )}
          <Property icon={Sparkles} label="What it does" align="start" testId="sheet-abilities">
            <Abilities connection={connection} />
          </Property>
        </dl>
      </div>
    </div>
  );
}

/** The way out, the walk, and where this model sits among the rows shown. */
function Walk({ position, onStep, onClose }: { readonly position: ModelSheetProps["position"]; readonly onStep: (step: 1 | -1) => void; readonly onClose: () => void }): JSX.Element {
  return (
    <>
      <Button variant="ghost" size="icon-lg" className={PRESS} aria-label="Close the model" data-testid="model-close" onClick={onClose}>
        <ChevronsRight strokeWidth={1.75} aria-hidden="true" />
      </Button>
      <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-border" />
      <Button variant="ghost" size="icon-lg" className={PRESS} aria-label="Previous model (K)" data-testid="model-previous" disabled={position.at <= 0} onClick={() => onStep(-1)}>
        <ChevronUp strokeWidth={1.75} aria-hidden="true" />
      </Button>
      <Button variant="ghost" size="icon-lg" className={PRESS} aria-label="Next model (J)" data-testid="model-next" disabled={position.at >= position.count - 1} onClick={() => onStep(1)}>
        <ChevronDown strokeWidth={1.75} aria-hidden="true" />
      </Button>
      <span className="shrink-0 px-1 text-xs text-muted-foreground tabular-nums" data-testid="model-position">
        <span className="sr-only">Model </span>
        {position.at + 1} of {position.count}
      </span>
    </>
  );
}

/**
 * Where a local model's weights are: here, or what fetching them would cost —
 * the form's size read, keyed by the pair and asked only while a fetch is on
 * offer. Its refusal is where a missing local runtime shows, as the server
 * wrote it.
 */
function WeightsRow({ connection }: { readonly connection: Connection }): JSX.Element {
  const ready = connection.setup_state === "ready";
  const downloadable = connection.allowed_actions.includes("download_weights") && !ready;
  const size = useDownloadSize(connection.model_id, connection.model_revision, downloadable);
  let value: ReactNode;
  if (ready) value = <span>On this machine</span>;
  else if (!downloadable) value = <span className="text-muted-foreground">Not here yet</span>;
  else if (size.isPending)
    value = (
      <span className="text-muted-foreground" data-testid="connection-size-checking">
        Reading the download size…
      </span>
    );
  else if (size.isError)
    value = (
      <span className="text-xs leading-5 text-pretty text-muted-foreground" data-testid="connection-size-unavailable">
        {refusalProse(size.error)}
      </span>
    );
  else
    value = (
      <span data-testid="connection-size-known">
        {bytes(size.data.total_bytes)}
        <span className="text-muted-foreground"> across {formatCount(size.data.file_count)} files</span>
      </span>
    );
  return (
    <Property icon={HardDrive} label="Weights" align={downloadable && size.isError ? "start" : "center"} testId="connection-size">
      {value}
    </Property>
  );
}

/** Every ability as a quiet label, wrapping — or why none is known yet. */
function Abilities({ connection }: { readonly connection: Connection }): JSX.Element {
  const abilities = abilityLabels(connection);
  if (abilities.length === 0) {
    const waiting = isLocal(connection) && connection.setup_state !== "ready";
    return (
      <span className="block py-0.5 text-pretty text-muted-foreground">
        {waiting ? "Known once the weights are here — a model's abilities are read from its own files." : "Nothing declared."}
      </span>
    );
  }
  return (
    <ul className="flex flex-wrap gap-1.5 py-0.5" aria-label="What it does">
      {abilities.map((label) => (
        <li key={label}>
          <Badge variant="quiet">{label}</Badge>
        </li>
      ))}
    </ul>
  );
}

/** `setup_state` as the product's state chip reads it: the two values the wire has. */
function stateOf(connection: Connection): State {
  return connection.setup_state === "ready"
    ? { tone: "done", label: STATE_LABELS.ready }
    : { tone: "waiting", glyph: "todo", label: STATE_LABELS[connection.setup_state] };
}

/** The model's runs, and the endpoint's probe: what the bar starts and the strip reads. */
interface Runs {
  readonly weights: ReturnType<typeof useDownloadRun>;
  readonly integrity: ReturnType<typeof useIntegrityRun>;
  readonly probe: ReturnType<typeof useTestEndpoint>;
}

/**
 * Every action the connection declares, as icon buttons: what ends or changes
 * the model, a hairline, then what sets it up and keeps it honest.
 */
function BarActions({ connection, runs, onEdit, onDelete }: { readonly connection: Connection; readonly runs: Runs; readonly onEdit: () => void; readonly onDelete: () => void }): JSX.Element {
  const can = new Set(connection.allowed_actions);
  const ends = can.has("delete") || can.has("update");
  const keeps = can.has("download_weights") || can.has("check_integrity") || can.has("test_endpoint");
  const { probe } = runs;
  return (
    <div className="flex h-10 shrink-0 items-center gap-1">
      {can.has("delete") && <IconAction icon={Trash2} label="Delete" hint="Annotations keep their model provenance." data-testid="action-delete" onClick={onDelete} />}
      {can.has("update") && <IconAction icon={Pencil} label="Edit" data-testid="action-edit" onClick={onEdit} />}
      {ends && keeps && <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />}
      <FileActions connection={connection} runs={runs} />
      {can.has("test_endpoint") && (
        <IconAction
          icon={RadioTower}
          label={probe.isPending ? "Asking the endpoint…" : "Test endpoint"}
          busy={probe.isPending}
          hint="Asks it now; the answer is never stored."
          data-testid="action-test-endpoint"
          onClick={() => probe.mutate(connection.id)}
        />
      )}
    </div>
  );
}

/** "Waits for the run in flight" — what a file action withheld by the other run says. */
const WAIT = "Waits for the run in flight: both read the same files.";

/**
 * The actions over the model's files. **One busy state for all of them**: they
 * act on one cache, so a second request of the same kind is answered with the
 * run already going, and one of the other kind would set a transfer and a full
 * re-read over the same files at once. The one running names itself and spins;
 * the other is withheld and says why.
 *
 * Two checks, and each label says what its own check *proves*: a download
 * reads an index and finds a file that is absent, and only a full re-read
 * finds one that is present and wrong. `docs/content/inference.md` carries the
 * same two sentences.
 */
function FileActions({ connection, runs }: { readonly connection: Connection; readonly runs: Runs }): JSX.Element {
  const can = new Set(connection.allowed_actions);
  const { weights, integrity } = runs;
  return (
    <>
      {can.has("check_integrity") && (
        <IconAction
          icon={ShieldCheck}
          label={integrity.running ? "Reading every file…" : "Check files are undamaged"}
          busy={integrity.running}
          reason={weights.running ? WAIT : null}
          hint="Reads every byte and removes a damaged copy."
          data-testid="action-check-integrity"
          onClick={integrity.start}
        />
      )}
      {can.has("download_weights") && (connection.setup_state === "ready" ? (
        <IconAction
          icon={FileSearch}
          label={weights.running ? "Checking…" : "Check for missing files"}
          busy={weights.running}
          reason={integrity.running ? WAIT : null}
          hint="Re-reads the file list and fetches anything absent."
          data-testid="action-verify-weights"
          onClick={weights.start}
        />
      ) : (
        <DownloadAction connection={connection} runs={runs} />
      ))}
    </>
  );
}

/** The one step a model not set up is waiting on: filled until it runs, with what it would cost in its tooltip. */
function DownloadAction({ connection, runs }: { readonly connection: Connection; readonly runs: Runs }): JSX.Element {
  const { weights, integrity } = runs;
  // The size read the Weights row made, shared by its key — no second request.
  const size = useDownloadSize(connection.model_id, connection.model_revision, true);
  const failed = weights.failure !== null || integrity.failure !== null;
  const cost = size.data === undefined ? "" : `${bytes(size.data.total_bytes)}. `;
  const label = weights.running ? "Downloading…" : failed ? "Retry download" : "Download weights";
  return (
    <IconAction
      icon={failed ? RotateCw : Download}
      label={label}
      busy={weights.running}
      reason={integrity.running ? WAIT : null}
      hint={failed ? "Resumes from what arrived." : `${cost}Nothing is fetched until you ask.`}
      variant={weights.running || integrity.running ? "ghost" : "default"}
      data-testid="download-weights"
      onClick={weights.start}
    />
  );
}

interface Line {
  readonly key: string;
  readonly body: ReactNode;
}

/** The run in flight, read off the wire — so a run started from a terminal or another tab shows here too. */
function runLine({ weights, integrity }: Runs, ready: boolean): Line | null {
  if (weights.live === null && integrity.live === null && !weights.running && !integrity.running) return null;
  let progress: ReactNode;
  if (weights.live !== null) progress = <DownloadProgress download={weights.live} ready={ready} />;
  else if (integrity.live !== null) progress = <IntegrityProgress check={integrity.live} />;
  else {
    const title = weights.running ? (ready ? "Checking" : "Downloading") : "Reading every file";
    progress = (
      <RunProgress testId="run-starting" title={title} label="Starting" percent={null}>
        Starting…
      </RunProgress>
    );
  }
  return {
    key: weights.live !== null ? "download" : integrity.live !== null ? "integrity" : "starting",
    body: (
      <div className="flex flex-col gap-1.5">
        {progress}
        <span className="text-[11px] leading-4 text-pretty text-muted-foreground">Runs on the server — closing this or leaving the page does not stop it.</span>
      </div>
    ),
  };
}

/**
 * The failures, each with its remedy. A failed integrity check is the one on
 * this screen that has already acted: its sentence describes a state the
 * connection is *already* in, and the remedy is a button in the bar.
 */
function failureLines({ weights, integrity }: Runs, ready: boolean): Line[] {
  const lines: Line[] = [];
  if (weights.failure !== null) {
    const remedy = ready
      ? "The connection is still Ready — nothing was changed. Check again to re-read the cache."
      : "Nothing is half-installed, so the connection is still Not set up. Retry the download to resume from what arrived.";
    lines.push({ key: "download-error", body: <Said tone="destructive" testId="download-error" lead={sentence(weights.failure)}>{remedy}</Said> });
  }
  if (integrity.failure !== null) {
    const remedy = ready
      ? "Nothing was removed and the connection is still Ready — a check that cannot reach the model's source is not an answer about the files here."
      : "The damaged copies have been removed and the connection is back to Not set up. Download the weights again: with the bad files gone, it is a real transfer rather than a cache hit.";
    lines.push({ key: "integrity-error", body: <Said tone="destructive" testId="integrity-error" lead={sentence(integrity.failure)}>{remedy}</Said> });
  }
  return lines;
}

/** The endpoint's answer: a fresh one every time — reachability is never stored on the connection. */
function probeLine({ probe }: Runs): Line | null {
  if (probe.isPending)
    return {
      key: "probe",
      body: (
        <p className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="test-endpoint-pending">
          <Spinner className="size-3.5" />
          Asking the endpoint…
        </p>
      ),
    };
  if (probe.isSuccess) return { key: "probe-ok", body: <Said tone="success" testId="test-endpoint-ok">The endpoint answered.</Said> };
  if (probe.isError) return { key: "probe-error", body: <Said tone="destructive" testId="test-endpoint-error">{refusalProse(probe.error)}</Said> };
  return null;
}

/**
 * What the last press says, under the bar: the run in flight, a failure and
 * its remedy, the endpoint's answer. A live region that is always mounted, so
 * a screen reader hears each line as it changes; it draws nothing while it has
 * nothing to say.
 *
 * A line that a press produces arrives from 4px above; one that was already
 * there when this model opened — J/K walking here, which is frequent — appears
 * at once. The sheet's content is keyed by the model, so "already there" is
 * what the first render held.
 */
function Strip({ runs, ready }: { readonly runs: Runs; readonly ready: boolean }): JSX.Element {
  const lines = [runLine(runs, ready), ...failureLines(runs, ready), probeLine(runs)].filter((line): line is Line => line !== null);
  const [opened] = useState(() => new Set(lines.map((line) => line.key)));
  return (
    <div role="status" className={cn("shrink-0", lines.length > 0 && "flex flex-col gap-2.5 border-b border-border/70 px-6 py-3")} data-testid="model-strip">
      {lines.map((line) => (
        <div key={line.key} className={cn(!opened.has(line.key) && ARRIVE)}>
          {line.body}
        </div>
      ))}
    </div>
  );
}

/**
 * A sentence the strip says, behind the mark of how it went. A failure's own
 * words (`lead`) carry the colour; the remedy after them is read in the body's
 * ink, so four lines of red never shout the part that says what to do.
 */
function Said({
  tone,
  testId,
  lead,
  children,
}: {
  readonly tone: "success" | "destructive";
  readonly testId: string;
  readonly lead?: string;
  readonly children: ReactNode;
}): JSX.Element {
  const Icon = tone === "success" ? CircleCheck : CircleAlert;
  return (
    <p className="flex gap-2 text-xs leading-5" data-testid={testId}>
      <Icon aria-hidden="true" strokeWidth={1.75} className={cn("mt-0.5 size-3.5 shrink-0", tone === "success" ? "text-success" : "text-destructive")} />
      <span className="min-w-0 text-pretty text-muted-foreground">
        {lead !== undefined && <span className="text-destructive">{lead} </span>}
        <span className={cn(lead === undefined && (tone === "destructive" ? "text-destructive" : "text-foreground"))}>{children}</span>
      </span>
    </p>
  );
}

/** One property: an icon and its label in a fixed column, the value beside it. Read, not edited — so no hover. */
function Property({
  icon: Icon,
  label,
  align = "center",
  testId,
  children,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly align?: "center" | "start";
  readonly testId?: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div data-testid={testId} className={cn("grid min-h-9 grid-cols-[8.5rem_minmax(0,1fr)] gap-x-3 py-1 text-[13px]", align === "center" ? "items-center" : "items-start")}>
      <dt className="flex h-7 items-center gap-2 text-muted-foreground">
        <Icon aria-hidden="true" strokeWidth={1.75} className="size-4 shrink-0" />
        {label}
      </dt>
      <dd className={cn("m-0 flex min-h-7 min-w-0 items-center tabular-nums", align === "start" && "pt-1")}>{children}</dd>
    </div>
  );
}
