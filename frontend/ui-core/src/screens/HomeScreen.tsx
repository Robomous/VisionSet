/**
 * The workspace's front page: what needs attention, and where to carry on.
 *
 * Home used to be a redirect to the project list, and the route table said why —
 * *there is nothing else a workspace's front page could honestly be until a
 * dashboard has numbers to show*. `GET /home` is those numbers.
 *
 * ## The question this answers is not the project list's
 *
 * A project list answers *what exists*. This answers *what is waiting on me*,
 * which is a different question and spans every project: a batch part-way
 * through in one, frames awaiting review in another, an export that failed in a
 * third. None of that is visible from a list of names.
 *
 * ## One request, because the server composes it
 *
 * `useHome` is a single query. The alternative is a request per project per
 * question with this component doing the joining, which is both slower and a
 * page that renders in pieces as they land.
 *
 * ## Sections with nothing in them are not rendered
 *
 * Not rendered as a placeholder, not rendered as a zero, not rendered as "no
 * items yet" — absent. A dashboard whose every section is an apology is a page
 * that has taught you nothing and taken a screen to do it. The stat cards are
 * the deliberate exception: a count of zero is a *measurement*, and four cards
 * that come and go would make the aside jump on every visit.
 *
 * ## Exactly one filled button, in every state
 *
 * `DESIGN.md` states the rule as a count, tested in both directions, so zero
 * filled buttons fails it exactly as two would. The three states each have their
 * own answer and there is never a fourth: first run offers **Create project**,
 * a workspace with somewhere to carry on offers **Continue annotating**, and one
 * with nothing open offers **New project** — because when every batch is
 * finished, starting the next piece of work genuinely is what comes next.
 *
 * ## The resume card is ranked by progress, not by recency
 *
 * There is no timestamp on a batch, an annotation, or an asset's progress
 * anywhere in the storage format, so *the batch I touched last* has no source.
 * The card offers the batch furthest through that still has an unlabeled frame.
 * Its one visible consequence is here: with nothing left to label the control
 * reads **Open batch** and goes to the gallery, because there is no frame to
 * open and a button claiming otherwise would land somewhere empty.
 */

import { ArrowRight, CircleAlert, Folders, Layers, Loader2, Play, Plus, Rocket, Sparkles, Tags, Upload } from "lucide-react";
import { useState, type JSX, type ReactNode } from "react";

import { asApiError } from "../data/errors";
import { refusalProse } from "../data/refusals";
import { formatCount, formatPercent, formatWhen } from "../lib/format";
import { ErrorState } from "../patterns/AsyncStates";
import { StatCard } from "../patterns/DataDisplay";
import { Badge } from "../primitives/badge";
import { Button } from "../primitives/button";
import { Skeleton } from "../primitives/Feedback";
import { CreateProjectDialog } from "./ProjectsScreen";
import { AssetThumbnail } from "./AssetThumbnail";
import {
  useHome,
  type ActivityEntry,
  type AttentionItem,
  type ProjectSummary,
  type ResumeTarget,
} from "./queries";

export interface HomeScreenProps {
  /**
   * Into the annotator, at the frame the card names.
   *
   * `assetId` is null when the batch has no unlabeled frame left, which is also
   * when the control stops saying "Continue annotating" — a host that cannot
   * honour the distinction renders neither.
   */
  readonly onContinue?: (jobId: string, assetId: string | null) => void;
  /** The batch gallery, for the fallback and for a review or pre-labeled row. */
  readonly onOpenBatch?: (projectId: string, batchId: string) => void;
  readonly onOpenProject?: (projectId: string) => void;
  /** The project list, behind the recent-projects header link. */
  readonly onOpenProjects?: () => void;
}

export function HomeScreen({
  onContinue,
  onOpenBatch,
  onOpenProject,
  onOpenProjects,
}: HomeScreenProps): JSX.Element {
  const home = useHome();
  const [creating, setCreating] = useState(false);

  if (home.isPending) return <HomeSkeleton />;
  if (home.isError) {
    return (
      <ErrorState
        message={refusalProse(home.error)}
        code={asApiError(home.error).code}
        onRetry={() => void home.refetch()}
      />
    );
  }

  const page = home.data;
  const dialog = (
    <CreateProjectDialog
      open={creating}
      onClose={() => setCreating(false)}
      onCreated={(projectId) => onOpenProject?.(projectId)}
    />
  );

  // Zero projects is the whole first-run condition, and it needs no flag of its
  // own — a count the page already carries answers it.
  if (page.totals.projects === 0) {
    return (
      <div data-testid="home-first-run">
        <FirstRun onCreate={() => setCreating(true)} />
        {dialog}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6" data-testid="home">
      <header className="flex items-start justify-between gap-4 border-b border-border pb-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Home</h1>
          <p className="text-xs text-muted-foreground">
            What is waiting, across every project in this workspace.
          </p>
        </div>
        {/*
          The page's one filled button when there is nothing to carry on with.
          With a resume card on screen this steps back to `outline`, because
          two filled buttons is the same rule broken from the other side.
        */}
        <Button
          variant={page.resume === null ? "default" : "outline"}
          data-testid="home-new-project"
          onClick={() => setCreating(true)}
        >
          <Plus aria-hidden="true" />
          New project
        </Button>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-6">
          {page.resume !== null && (
            <Resume
              resume={page.resume}
              {...(onContinue === undefined ? {} : { onContinue })}
              {...(onOpenBatch === undefined ? {} : { onOpenBatch })}
            />
          )}
          <Attention
            items={page.attention}
            {...(onOpenBatch === undefined ? {} : { onOpenBatch })}
          />
          <Recent
            projects={page.projects}
            {...(onOpenProject === undefined ? {} : { onOpenProject })}
            {...(onOpenProjects === undefined ? {} : { onOpenProjects })}
          />
        </div>

        <aside className="flex min-w-0 flex-col gap-6">
          <div className="grid grid-cols-2 gap-3" data-testid="home-stats">
            <StatCard label="Projects" value={formatCount(page.totals.projects)} />
            <StatCard label="Images" value={formatCount(page.totals.assets)} />
            <StatCard label="Annotations" value={formatCount(page.totals.annotations)} />
            <StatCard label="Releases" value={formatCount(page.totals.releases)} />
          </div>
          <Activity entries={page.activity} />
        </aside>
      </div>
      {dialog}
    </div>
  );
}

/**
 * The whole page on a workspace nobody has used yet.
 *
 * An invitation rather than an apology, and one invitation rather than three:
 * the retired onboarding checklist showed a project three seconds old two
 * competing next steps, and whichever a person followed the page was also
 * telling them to do something else.
 *
 * The three cards beneath name the cycle and carry no controls at all. They are
 * there so somebody can see what this tool does before committing to it — a
 * button on each would be three more things competing with the one that matters.
 */
function FirstRun({ onCreate }: { readonly onCreate: () => void }): JSX.Element {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center gap-6 py-16 text-center">
      <div className="flex flex-col items-center gap-2">
        <Folders className="size-8 text-muted-foreground" aria-hidden="true" />
        <h1 className="text-2xl font-semibold text-foreground">Start your first project</h1>
        <p className="text-xs text-muted-foreground">
          A project is where a schema, its batches and its dataset live.
        </p>
      </div>
      <Button variant="default" data-testid="home-create-project" onClick={onCreate}>
        <Plus aria-hidden="true" />
        Create project
      </Button>
      <div className="grid w-full gap-3 sm:grid-cols-3">
        <Stage icon={<Upload className="size-4" />} title="Ingest">
          Register images or a video and let it become frames.
        </Stage>
        <Stage icon={<Tags className="size-4" />} title="Annotate">
          Declare the classes you will draw, then label a batch.
        </Stage>
        <Stage icon={<Rocket className="size-4" />} title="Release">
          Freeze what is finished and export it to train on.
        </Stage>
      </div>
    </div>
  );
}

function Stage({
  icon,
  title,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-muted p-4 text-left">
      <span className="flex items-center gap-1.5 text-foreground" aria-hidden="true">
        {icon}
      </span>
      <span className="font-medium text-foreground">{title}</span>
      <span className="text-xs text-muted-foreground">{children}</span>
    </div>
  );
}

/** What the control promises, per kind. Presentation only — the order is the wire's. */
const RESUME_LABEL: Record<ResumeTarget["kind"], string> = {
  annotate: "Continue annotating",
  review: "Review annotations",
  open: "Open batch",
};

/**
 * Where to carry on, and the page's one filled button when it renders.
 *
 * The label is not decoration, and neither is the destination. Under `annotate`
 * and `review` there is a frame, so the control opens the editor at it — the same
 * screen either way, because a frame awaiting review opens read-only with the
 * review actions on it and there is no second screen to send anybody to. Under
 * `open` there is no frame at all, so it goes to the gallery rather than offering
 * a link that would land somewhere empty.
 *
 * Which of the three applies is `resume.kind`, decided by the kernel. This
 * component reads it; it does not work it out from the other fields, because the
 * order between the three is a decision and a second copy of it here would drift.
 */
function Resume({
  resume,
  onContinue,
  onOpenBatch,
}: {
  readonly resume: ResumeTarget;
  readonly onContinue?: (jobId: string, assetId: string | null) => void;
  readonly onOpenBatch?: (projectId: string, batchId: string) => void;
}): JSX.Element {
  const hasFrame = resume.kind !== "open";
  const share = resume.total === 0 ? 0 : (resume.annotated / resume.total) * 100;
  const act = hasFrame
    ? onContinue === undefined
      ? undefined
      : () => onContinue(resume.job_id, resume.next_asset_id)
    : onOpenBatch === undefined
      ? undefined
      : () => onOpenBatch(resume.project_id, resume.batch_id);

  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
      data-testid="home-resume"
      data-kind={resume.kind}
    >
      <h2 className="text-xs font-medium text-muted-foreground">Continue where you left off</h2>
      {/* The resume control keeps its own width and wraps below the thumbnail
          and the counts rather than pushing the page wider. */}
      <div className="flex flex-wrap items-center gap-4">
        {resume.thumbnail_asset_id !== null && (
          <div className="size-16 shrink-0 overflow-hidden rounded-sm">
            <AssetThumbnail
              projectId={resume.project_id}
              assetId={resume.thumbnail_asset_id}
              thumbnailHash={resume.thumbnail_hash}
              alt=""
              className="size-16 object-cover"
            />
          </div>
        )}
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-xs text-muted-foreground">{resume.project_name}</span>
          <span className="truncate font-medium text-foreground">{resume.batch_name}</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {/* Under `review` the labeling is finished, so how much of it is
                labeled is not the number anybody is here for. */}
            {resume.kind === "review"
              ? `${formatCount(resume.review_pending)} waiting on review`
              : `${formatCount(resume.annotated)} / ${formatCount(resume.total)} annotated · ${formatPercent(share)}`}
          </span>
        </div>
        {act !== undefined && (
          <Button variant="default" className="ml-auto" data-testid="home-resume-cta" onClick={act}>
            <Play aria-hidden="true" />
            {RESUME_LABEL[resume.kind]}
          </Button>
        )}
      </div>
    </section>
  );
}

/**
 * What is waiting, and nothing at all when nothing is.
 *
 * A job row carries no project — a background job names an ingest run or a
 * release in its payload, never a project — and there is no background-job
 * screen to link to either, so those rows state what happened and go nowhere.
 * `DESIGN.md`'s rule for a section whose consuming surface does not exist yet.
 */
function Attention({
  items,
  onOpenBatch,
}: {
  readonly items: readonly AttentionItem[];
  readonly onOpenBatch?: (projectId: string, batchId: string) => void;
}): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" data-testid="home-attention">
      <h2 className="text-xs font-medium text-muted-foreground">Needs your attention</h2>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {items.map((item) => (
          <li key={`${item.kind}-${item.subject_id}`}>
            <AttentionRow
              item={item}
              {...(onOpenBatch === undefined ? {} : { onOpenBatch })}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function AttentionRow({
  item,
  onOpenBatch,
}: {
  readonly item: AttentionItem;
  readonly onOpenBatch?: (projectId: string, batchId: string) => void;
}): JSX.Element {
  const body = (
    <>
      <AttentionIcon kind={item.kind} />
      <span className="min-w-0 flex-1 truncate text-foreground">{attentionLine(item)}</span>
      {item.project_name !== null && (
        <span className="shrink-0 text-xs text-muted-foreground">{item.project_name}</span>
      )}
      {item.kind === "job_failed" && <Badge variant="destructive">Failed</Badge>}
    </>
  );
  const shared = "flex w-full items-center gap-2 px-3 py-2 text-left";

  const isBatch = item.kind === "review_pending" || item.kind === "pre_labeled";
  if (isBatch && item.project_id !== null && onOpenBatch !== undefined) {
    return (
      <button
        type="button"
        className={`${shared} hover:bg-muted focus-visible:bg-muted`}
        data-testid="home-attention-row"
        onClick={() => onOpenBatch(item.project_id as string, item.subject_id)}
      >
        {body}
      </button>
    );
  }
  return (
    <div className={shared} data-testid="home-attention-row">
      {body}
    </div>
  );
}

function AttentionIcon({ kind }: { readonly kind: AttentionItem["kind"] }): JSX.Element {
  const shape = "size-4 shrink-0";
  if (kind === "job_failed") {
    return <CircleAlert className={`${shape} text-destructive`} aria-hidden="true" />;
  }
  if (kind === "job_running") {
    return <Loader2 className={`${shape} text-muted-foreground`} aria-hidden="true" />;
  }
  if (kind === "pre_labeled") {
    return <Sparkles className={`${shape} text-muted-foreground`} aria-hidden="true" />;
  }
  return <Layers className={`${shape} text-muted-foreground`} aria-hidden="true" />;
}

/** One sentence per row, in the vocabulary the wire declared. */
function attentionLine(item: AttentionItem): string {
  if (item.kind === "review_pending") {
    const frames = item.count ?? 0;
    return `${item.label} — ${formatCount(frames)} ${frames === 1 ? "frame" : "frames"} waiting on review`;
  }
  if (item.kind === "pre_labeled") {
    const frames = item.count ?? 0;
    return `${item.label} — ${formatCount(frames)} model-labeled ${frames === 1 ? "frame" : "frames"} waiting on an annotator`;
  }
  if (item.kind === "job_failed") {
    // The cause is the useful half, and the API's error contract already
    // separates what happened from what to do; this does not merge them back.
    return item.detail === null ? `${item.label} stopped` : `${item.label} — ${item.detail}`;
  }
  // An unknown total is prose rather than a bar reading 0%, which is what an
  // indeterminate track would say and it would be a lie.
  return item.total === null || item.total === 0
    ? `${item.label} — running, ${formatCount(item.processed ?? 0)} so far`
    : `${item.label} — ${formatPercent(((item.processed ?? 0) / item.total) * 100)}`;
}

/**
 * A shortcut into the project list, capped by the server. Never a copy of it —
 * the header link is what goes to the real thing.
 */
function Recent({
  projects,
  onOpenProject,
  onOpenProjects,
}: {
  readonly projects: readonly ProjectSummary[];
  readonly onOpenProject?: (projectId: string) => void;
  readonly onOpenProjects?: () => void;
}): JSX.Element | null {
  if (projects.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" data-testid="home-recent">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-medium text-muted-foreground">Recent projects</h2>
        {onOpenProjects !== undefined && (
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            data-testid="home-all-projects"
            onClick={onOpenProjects}
          >
            All projects
            <ArrowRight className="size-3" aria-hidden="true" />
          </button>
        )}
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {projects.map((project) => (
          <li key={project.project_id}>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted focus-visible:bg-muted"
              data-testid="home-project-row"
              disabled={onOpenProject === undefined}
              onClick={() => onOpenProject?.(project.project_id)}
            >
              <span className="min-w-0 flex-1 truncate text-foreground">{project.name}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {formatCount(project.asset_count)}{" "}
                {project.asset_count === 1 ? "image" : "images"} ·{" "}
                {formatPercent(project.annotated_fraction * 100)} annotated
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What has happened, newest first. Absent when nothing has. */
function Activity({ entries }: { readonly entries: readonly ActivityEntry[] }): JSX.Element | null {
  if (entries.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" data-testid="home-activity">
      <h2 className="text-xs font-medium text-muted-foreground">Activity</h2>
      <ul className="flex flex-col gap-2">
        {entries.map((entry) => (
          <li
            key={`${entry.kind}-${entry.subject_id}-${entry.occurred_at}`}
            className="flex items-start gap-2"
            data-testid="home-activity-row"
          >
            <ActivityIcon kind={entry.kind} />
            <span className="min-w-0 flex-1 text-xs text-foreground">{activityLine(entry)}</span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {formatWhen(entry.occurred_at)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ActivityIcon({ kind }: { readonly kind: ActivityEntry["kind"] }): JSX.Element {
  const shape = "size-4 shrink-0 text-muted-foreground";
  if (kind === "release_published") return <Rocket className={shape} aria-hidden="true" />;
  if (kind === "batch_promoted") return <Layers className={shape} aria-hidden="true" />;
  if (kind === "schema_version") return <Tags className={shape} aria-hidden="true" />;
  return <Upload className={shape} aria-hidden="true" />;
}

/**
 * One line per entry, and two of them say less than they might.
 *
 * `ingest` reports *the last data that arrived*, not one run finishing, because
 * an ingest run records no time anywhere. `schema_version` reports a version
 * being created rather than activated, because which version is active is
 * derived — it is the highest — so there is no activation to date.
 */
function activityLine(entry: ActivityEntry): string {
  const where = entry.project_name;
  if (entry.kind === "release_published") return `Released ${entry.label ?? "a version"} in ${where}`;
  if (entry.kind === "batch_promoted") {
    const promoted = entry.count ?? 0;
    return `Promoted ${formatCount(promoted)} ${promoted === 1 ? "image" : "images"} from ${entry.label ?? "a batch"} in ${where}`;
  }
  if (entry.kind === "schema_version") return `Schema ${entry.label ?? "version"} in ${where}`;
  const arrived = entry.count ?? 0;
  return `${formatCount(arrived)} ${arrived === 1 ? "image" : "images"} in ${where}`;
}

/**
 * The final layout, drawn at its real size.
 *
 * A card that appears is worse than a card that fills in: the second is a page
 * loading, the first is a page jumping under a cursor already on its way
 * somewhere. `home.test.tsx` counts the grids on both sides of the transition,
 * which is what catches forgetting to reserve a row added later.
 */
function HomeSkeleton(): JSX.Element {
  return (
    <div className="flex flex-col gap-6" data-testid="home-loading" aria-busy="true">
      <span className="sr-only">Loading</span>
      <Skeleton className="h-14 w-full" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-6">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <div className="grid grid-cols-2 gap-3">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-20 w-full" />
            ))}
          </div>
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    </div>
  );
}
