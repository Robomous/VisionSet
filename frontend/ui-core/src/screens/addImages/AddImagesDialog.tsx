/**
 * Add images: a centred, three-step dialog over the project — 1 Upload,
 * 2 Frames & settings, 3 Batch — opened from the project bar.
 *
 * ## Three mechanisms, one walk
 *
 * Images are read **by the server**: they upload, a source is registered, a run
 * fills a batch. Point clouds take the same path but state their frame before
 * registering. A clip is read **by this browser**: the host's materializer
 * decodes it locally, frames are staged against a session, and a commit turns
 * the lot into assets. They have different refusals and different places a
 * failure can appear (`ingestRun.tsx`, `clipImport.tsx`); what they share is the
 * walk — choose, decide, watch it land — so each step draws whichever the files
 * turned out to be.
 *
 * ## The track
 *
 * Three segments fill as the flow moves (a transform, 300 ms on the strong
 * ease-out), and a reached segment before the one shown can be pressed to walk
 * back — until a run exists, which cannot be un-launched. Each page comes in
 * from the side the walk is heading (24 px and opacity, 220 ms), and under
 * reduced motion nothing moves. The footer carries a way back, a secondary, and
 * the step's one filled action.
 *
 * ## Owned by the host, mounted while closed
 *
 * The flow's state lives in this component above the `Dialog`, and the host
 * keeps it mounted while the dialog is closed — so closing hides the flow
 * rather than discarding it. `ProjectScreen` is the host, and the open state is
 * its own (or the URL's, through `addImagesOpen`). Once a flow has settled,
 * closing starts the next one over.
 */

import { Plus, Stamp, Upload, X } from "lucide-react";
import { useEffect, useRef, type JSX } from "react";

import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, cn } from "@robomous/ui-core";
import { BATCH_ACTION, declares } from "../../data/capabilities";
import { asApiError } from "../../data/errors";
import { formatCount } from "../../lib/format";
import { approveLabel } from "../BatchLifecycle";
import { SchemaForeshadow } from "../SchemaForeshadow";
import { useActiveSchema, useProject } from "../queries";
import { BatchStep } from "./BatchStep";
import { ingestFraction } from "./ingestRun";
import { NEW_BATCH } from "./IntoField";
import { EASE, PRESS } from "./motion";
import { SettingsStep } from "./SettingsStep";
import { UploadStep } from "./UploadStep";
import { useAddImagesFlow, type AddImagesFlow, type StepIndex } from "./useAddImagesFlow";

/** What `SchemaService.require_active` raises for a project that has none. */
const SCHEMA_NOT_FOUND = "SCHEMA_NOT_FOUND";

const STEPS = ["Upload", "Frames & settings", "Batch"] as const;

export interface AddImagesDialogProps {
  readonly projectId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * Open the batch the flow filled — its panel on the Overview. A callback
   * rather than a route, because `ui-core` may not import a router. Absent, the
   * outcome renders without the button rather than with a dead one. The host is
   * expected to close the dialog on the way (`ProjectScreen` does).
   */
  readonly onOpenBatch?: (batchId: string) => void;
  /** The project's Classes section, for the labels foreshadowing and the approval's remedy. */
  readonly onOpenSchema?: () => void;
}

export function AddImagesDialog({ projectId, open, onOpenChange, onOpenBatch, onOpenSchema }: AddImagesDialogProps): JSX.Element {
  const flow = useAddImagesFlow(projectId);
  const project = useProject(projectId);
  const schema = useActiveSchema(projectId, open);
  const noSchema = schema.isError && asApiError(schema.error).code === SCHEMA_NOT_FOUND;
  const approvable = schema.isSuccess && flow.batch !== null && declares(flow.batch, BATCH_ACTION.approve);

  // A settled flow is over: closing on it starts the next one over, session and
  // all. Anything short of that — files chosen, a run in flight — is kept for
  // when the dialog opens again.
  const wasOpen = useRef(open);
  const { settled, restart } = flow;
  useEffect(() => {
    if (wasOpen.current && !open && settled) restart();
    wasOpen.current = open;
  }, [open, settled, restart]);

  const close = (): void => onOpenChange(false);
  const actions = actionsFor(flow, { close, approvable, ...(onOpenBatch === undefined ? {} : { onOpenBatch }) });
  const name = project.data?.name;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        showCloseButton={false}
        data-testid="add-images"
        data-kind={flow.kind}
      >
        <header className="flex shrink-0 flex-col gap-4 px-6 pt-5 pb-4">
          <div className="flex items-start gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <DialogTitle>Add images</DialogTitle>
              <DialogDescription className="truncate">{name === undefined ? "to this project" : `to ${name}`}</DialogDescription>
            </div>
            <Button variant="ghost" size="icon" className={cn("-mt-1 -mr-2", PRESS)} aria-label="Close" data-testid="add-images-close" onClick={close}>
              <X aria-hidden="true" />
            </Button>
          </div>
          <Track flow={flow} />
        </header>
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto border-t border-border/70 px-6 py-5">
          {/* Ingesting without labels is fine — annotating without them is not, and
              the refusal would otherwise arrive only at the approval. */}
          {flow.shown === 0 && (
            <div className="mb-4 empty:hidden">
              <SchemaForeshadow projectId={projectId} {...(onOpenSchema === undefined ? {} : { onOpenSchema })} />
            </div>
          )}
          {/* Each page comes in from the side the walk is heading: 220 ms, transform and opacity only. */}
          <div
            key={`${flow.shown}-${flow.approving ? "approve" : "batch"}-${flow.attempt}`}
            data-testid="add-images-step"
            className={cn(
              "transition-[translate,opacity] duration-[220ms] starting:opacity-0 motion-reduce:transition-none motion-reduce:starting:translate-x-0",
              flow.direction === 1 ? "starting:translate-x-6" : "starting:-translate-x-6",
            )}
            style={{ transitionTimingFunction: EASE }}
          >
            {flow.shown === 0 && <UploadStep flow={flow} />}
            {flow.shown === 1 && <SettingsStep flow={flow} />}
            {flow.shown === 2 && (
              <BatchStep
                flow={flow}
                noSchema={noSchema}
                approvable={approvable}
                {...(onOpenBatch === undefined ? {} : { onOpenBatch })}
                {...(onOpenSchema === undefined ? {} : { onOpenSchema })}
              />
            )}
          </div>
        </div>
        <Footer actions={actions} />
      </DialogContent>
    </Dialog>
  );
}

/** How far into the step shown the flow has got, for its segment's fill. */
function fillOf(flow: AddImagesFlow, step: StepIndex): number {
  if (step < flow.shown) return 1;
  if (step > flow.shown) return 0;
  if (step === 0) return flow.reached > 0 ? 1 : flow.register.isPending ? 0.66 : flow.files.length > 0 ? 0.33 : 0.12;
  if (step === 1) return 0.5;
  if (flow.settled) return 1;
  if (flow.kind === "video") {
    const progress = flow.clip.progress;
    return Math.max(0.12, progress === null || progress.expected === 0 ? 0 : progress.materialized / progress.expected);
  }
  return Math.max(0.12, flow.run.job === null ? 0 : ingestFraction(flow.run.job));
}

/** The track: three segments that fill as the flow moves; a reached one before the step shown walks back to it. */
function Track({ flow }: { readonly flow: AddImagesFlow }): JSX.Element {
  return (
    <ol className="grid grid-cols-3 gap-2" aria-label="Steps">
      {STEPS.map((title, at) => {
        const step = at as StepIndex;
        const here = step === flow.shown;
        const state = here ? "active" : step < flow.reached ? "complete" : "upcoming";
        const reachable = step < flow.shown && flow.reached < 2;
        return (
          <li key={title} data-testid={`step-${at + 1}`} data-state={state}>
            <button
              type="button"
              disabled={!reachable}
              onClick={() => flow.go(step)}
              aria-current={here ? "step" : undefined}
              className="group flex min-h-10 w-full flex-col justify-center gap-1.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default"
            >
              <span className="h-1 overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full origin-left rounded-full bg-foreground transition-transform duration-300 motion-reduce:transition-none"
                  style={{ transform: `scaleX(${fillOf(flow, step)})`, transitionTimingFunction: EASE }}
                />
              </span>
              <span
                className={cn(
                  "text-xs",
                  here ? "font-medium text-foreground" : "text-muted-foreground",
                  reachable && "underline-offset-2 group-hover:text-foreground group-hover:underline",
                )}
              >
                {at + 1}. {title}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

// --- the footer's actions, per state ------------------------------------------------------

interface Action {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly icon?: JSX.Element;
  readonly testId: string;
}

interface Actions {
  readonly back?: Action;
  readonly secondary?: Action;
  readonly primary?: Action;
}

function noun(flow: AddImagesFlow, n: number): string {
  const one = flow.kind === "scans" ? "scan" : flow.kind === "video" ? "frame" : "image";
  return `${formatCount(n)} ${n === 1 ? one : `${one}s`}`;
}

/** What the footer offers on the step shown: a way back, a secondary, and the one filled action. */
function actionsFor(
  flow: AddImagesFlow,
  { close, approvable, onOpenBatch }: { readonly close: () => void; readonly approvable: boolean; readonly onOpenBatch?: (batchId: string) => void },
): Actions {
  const another: Action = {
    label: "Add another source",
    onClick: flow.another,
    icon: <Plus aria-hidden="true" />,
    testId: flow.kind === "video" ? "import-another" : "ingest-another",
  };

  if (flow.shown === 0) {
    // Walked back from a later step: what was chosen stands, and the way on is forward.
    if (flow.reached > 0) return { primary: { label: "Continue", onClick: () => flow.go(null), testId: "continue" } };
    const cancel: Action = { label: "Cancel", onClick: close, testId: "add-images-cancel" };
    if (flow.kind === "video") {
      const reading = flow.clip.inspection === null && flow.clip.unreadable === null;
      return {
        secondary: cancel,
        primary: { label: reading ? "Reading the clip…" : "Choose frames", onClick: flow.cut, disabled: !flow.clip.decodable, testId: "cut-clip" },
      };
    }
    const pending = flow.register.isPending;
    const label =
      flow.kind === "images" || flow.kind === "scans" ? `Upload ${noun(flow, flow.files.length)}` : "Upload";
    return {
      secondary: cancel,
      primary: {
        label: pending ? "Uploading…" : label,
        onClick: flow.upload,
        disabled: !flow.canUpload,
        icon: <Upload aria-hidden="true" />,
        testId: "register-source",
      },
    };
  }

  if (flow.shown === 1) {
    const back: Action = { label: "Back", onClick: () => flow.go(0), testId: "back-to-files" };
    if (flow.kind === "video") {
      return {
        back,
        primary: {
          label: flow.clip.importable ? `Import ${noun(flow, flow.clip.expected)}` : "Import frames",
          onClick: flow.launch,
          disabled: !flow.clip.importable || flow.clip.inFlight,
          testId: "start-video-import",
        },
      };
    }
    const pending = flow.run.start.isPending;
    return {
      back,
      primary: {
        label: pending ? "Starting…" : flow.target.choice === NEW_BATCH ? "Create batch" : "Add to batch",
        onClick: flow.launch,
        disabled: pending || flow.source === null,
        testId: "start-ingest",
      },
    };
  }

  // Step 3, in flight: a run is a row on the server and keeps going closed; a
  // clip keeps decoding closed too, and Cancel is the way to stop it.
  if (!flow.settled) {
    if (flow.kind === "video") {
      return {
        secondary: { label: "Cancel import", onClick: flow.clip.cancel, disabled: flow.clip.commit.isPending, testId: "cancel-video-import" },
      };
    }
    return { secondary: { label: "Close", onClick: close, testId: "add-images-done" } };
  }

  const batchId = flow.batchId;
  const open: Action | undefined =
    batchId === null || onOpenBatch === undefined
      ? undefined
      : { label: "Open the batch", onClick: () => onOpenBatch(batchId), testId: "open-batch" };
  const rerun: Action | undefined =
    flow.kind === "video" ? undefined : { label: "Into another batch", onClick: flow.rerun, testId: "rerun-source" };

  const approval = flow.approval;
  const startRefused = approval.approvedAt !== null && approval.begin.isError;
  if (flow.approved !== null || (flow.approving && startRefused)) {
    return { secondary: another, ...(open === undefined ? {} : { primary: open }) };
  }
  if (flow.approving) {
    return {
      back: { label: "Back", onClick: () => flow.setApproving(false), disabled: approval.busy, testId: "approve-back" },
      secondary: { ...another, disabled: approval.busy },
      primary: {
        label: approveLabel(approval),
        onClick: flow.approve,
        disabled: approval.busy || !approval.valid || approval.batch === null,
        icon: <Stamp aria-hidden="true" />,
        testId: "approve-submit",
      },
    };
  }
  if (batchId === null) {
    return { ...(rerun === undefined ? {} : { back: rerun }), primary: another };
  }
  if (approvable) {
    return {
      ...(rerun === undefined ? {} : { back: rerun }),
      secondary: another,
      primary: { label: "Approve batch", onClick: () => flow.setApproving(true), icon: <Stamp aria-hidden="true" />, testId: "approve-open" },
    };
  }
  return { ...(rerun === undefined ? {} : { back: rerun }), secondary: another, ...(open === undefined ? {} : { primary: open }) };
}

function Footer({ actions }: { readonly actions: Actions }): JSX.Element {
  const { back, secondary, primary } = actions;
  return (
    // The band across the bottom of the surface, as `DialogFooter` draws it.
    <footer className="flex shrink-0 flex-wrap items-center gap-2 rounded-b-2xl border-t border-border/70 bg-muted/50 px-5 py-3">
      {back !== undefined && (
        <Button variant="ghost" className={PRESS} onClick={back.onClick} disabled={back.disabled} data-testid={back.testId}>
          {back.label}
        </Button>
      )}
      <span className="flex-1" />
      {secondary !== undefined && (
        <Button variant="outline" className={PRESS} onClick={secondary.onClick} disabled={secondary.disabled} data-testid={secondary.testId}>
          {secondary.icon !== undefined && (
            <span data-icon="inline-start" className="contents">
              {secondary.icon}
            </span>
          )}
          {secondary.label}
        </Button>
      )}
      {primary !== undefined && (
        <Button className={cn(PRESS, "tabular-nums")} onClick={primary.onClick} disabled={primary.disabled} data-testid={primary.testId}>
          {primary.icon !== undefined && (
            <span data-icon="inline-start" className="contents">
              {primary.icon}
            </span>
          )}
          {primary.label}
        </Button>
      )}
    </footer>
  );
}
