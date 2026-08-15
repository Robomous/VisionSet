/**
 * The Inference section: where model connections are made, set up and removed.
 *
 * A top-level destination rather than a project tab: a connection carries no
 * project id, every project uses the same ones, and navigation maps 1:1 to domain
 * objects — so a project tab would state a scope the object does not have.
 * `DESIGN.md` carries the rail's membership.
 *
 * ## Organised by what a connection enables, not by what it is
 *
 * The screen is a list of sections, one per ability a model can be asked for, and
 * a connection sits under every ability it declares. That is the question
 * somebody arrives with — *what can I do in the app with this?* — and a flat
 * table of names, kinds and model ids answered none of it.
 *
 * Which section a row lands in comes off `capabilities`, which the server derives
 * from the downloaded model's own config. The grouping and the copy live in
 * `inferenceSections.ts`; what a row may be *asked to do* is still
 * `allowed_actions` and nothing else, which is a different field answering a
 * different question.
 *
 * ## Nothing here decides what is legal
 *
 * Every row action is rendered from `allowed_actions` on `ConnectionOut` and from
 * nothing else. `download_weights` is declared for a local connection whose
 * weights are not here yet — including on a machine with no local runtime
 * installed, deliberately, because whether *this* machine has the extra is not a
 * fact about the connection and hiding the control would leave the install
 * command with nowhere to be shown. So the refusal arrives from the request and
 * renders as prose (design principle 9, `ui-capabilities`).
 *
 * ## The status has two values, not three
 *
 * The obvious third is `Unreachable`, and the wire has only two:
 * `setup_state` is deliberately **not** a reachability answer — whether an
 * endpoint responds has a fresh answer every time it is asked, so it belongs to a
 * test call and its result rather than to a stored row that would start lying the
 * moment the network moved. A test action ships with the HTTP endpoint contract;
 * until then there is no third value to render and no control that would produce
 * one.
 *
 * ## What the form offers, and what it refuses to compute
 *
 * The model, the device and the precision are all chosen from lists rather than
 * typed, and every one of those lists lives in `inferenceCatalog.ts` — one
 * module, so extending the curated set is one entry and no other edit. Curation
 * guides without restricting: **Custom model…** reveals the same free model id
 * and revision fields the form had before.
 *
 * The device and precision lists are the kernel's vocabularies, offering-side.
 * The kernel is what refuses a pair outside them — including `cpu` with `fp16`,
 * which both local adapters silently drop — and its refusal renders here as
 * prose like any other. This is not the hand-mirror `ui-capabilities` bans: that
 * rule is about `allowed_actions`, and no field-level shape can carry which
 * precision a device honours.
 *
 * ## Two actions over the same files, and each label says what it proves
 *
 * `download_weights` is declared for a local connection in either state.
 * Below `Ready` it is the row's **Download weights** button; at `Ready` it is
 * **Check for missing files** in the overflow, where it re-runs the fetch and
 * turns up anything absent. The row picks that reading from `setup_state` — a
 * field the wire states — and never from a table of its own.
 *
 * `check_integrity` is the second action, declared only at `Ready` and only for
 * a local connection, and it renders as **Check files are undamaged**.
 * The two labels are written against each other on purpose: a download reads an
 * index and can prove nothing is *missing*, and only a full re-read of every
 * byte can prove nothing is *damaged*. **Verify weights** was the old label for
 * the first and claimed the second, which is the confusion this pair removes;
 * `docs/inference.md` carries the same two sentences, so the page and the
 * product cannot drift apart.
 *
 * A failed integrity check is the one refusal on this screen that has already
 * acted: the damaged files are purged and the connection is back to `Not set up`
 * before the job row says so. The settle-invalidation is what makes the row
 * agree, and the prose describes a state the workspace is already in.
 *
 * ## A run is watched, not owned
 *
 * Everything this screen shows about a download or a check comes off the
 * connection — `download` and `integrity_check` — and nothing from client-held
 * state. That is what makes the screen a viewport rather than the owner: arriving
 * mid-run — a reload, a second tab, a return visit, another machine, or beside a
 * terminal that started it — shows the bar and the prose on the first fetch,
 * because the row it was going to list says so anyway.
 *
 * The list re-reads itself while any row reports a live run of either kind and
 * stops the moment none does (`useConnections`). Nothing the browser does reaches
 * either job: they run in a worker process the server owns, so navigating away or
 * closing the tab neither cancels nor pauses one — only the poll stops.
 *
 * The two runs keep separate vocabularies because they count different things: a
 * transfer reports bytes it measured off the disk, and a check reports files it
 * has re-read. Neither borrows the other's name at any layer, which is why the
 * wire carries two shapes rather than one with a discriminator.
 *
 * ## The size is asked for before the connection exists
 *
 * The local form shows what a download would cost *before*
 * somebody confirms. That is a query the form makes about a published revision,
 * not something the create response could carry — by the time a connection exists
 * the decision has already been taken. The same query is what surfaces a missing
 * local runtime, which is why the form stays usable and shows the install command
 * instead of disabling itself.
 */

import {
  Download,
  FileSearch,
  Filter,
  MoreHorizontal,
  Pencil,
  Plug,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useState, type FormEvent, type JSX } from "react";

import { Async } from "../data/Async";
import { asApiError } from "../data/errors";
import {
  isLive,
  useCheckIntegrity,
  useConnections,
  useCreateConnection,
  useDeleteConnection,
  useDownloadSize,
  useDownloadWeights,
  useUpdateConnection,
  type Connection,
  type ConnectionType,
  type IntegrityCheck,
  type WeightDownload,
} from "../data/inferenceQueries";
import { EmptyState } from "../patterns/AsyncStates";
import { Badge } from "../primitives/Badge";
import { Button } from "../primitives/Button";
import { Progress } from "../primitives/Feedback";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../primitives/Dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../primitives/Menu";
import { FieldError, FieldHint, Input, Label } from "../primitives/Input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../primitives/Select";
import {
  CURATED_BY_ID,
  CURATED_MODELS,
  CUSTOM_MODEL,
  DEFAULT_MODEL,
  DEVICES,
  curatedEntry,
  precisionOn,
  precisionsFor,
  type Precision,
} from "./inferenceCatalog";
import { sectionsOf, type ConnectionSection } from "./inferenceSections";
/** Above this many rows a list carries a filter input (`DESIGN.md`). */
const FILTER_ABOVE = 20;

export function InferenceScreen(): JSX.Element {
  const connections = useConnections();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [doomed, setDoomed] = useState<Connection | null>(null);
  const [needle, setNeedle] = useState("");

  return (
    <div className="flex flex-col gap-6" data-testid="inference-screen">
      <header className="flex items-end justify-between gap-4 border-b border-border pb-4">
        <div>
          <h1 className="text-page font-semibold tracking-tight">Inference</h1>
          <p className="text-meta text-muted-foreground">
            Where a model may be asked to predict. Connections are shared by every project
            in this workspace.
          </p>
        </div>
        <Button variant="primary" data-testid="new-connection" onClick={() => setCreating(true)}>
          <Plug className="size-4" aria-hidden="true" />
          Add connection
        </Button>
      </header>

      <Async
        query={connections}
        loadingRows={3}
        empty={{
          title: "Connect a model to enable auto-labeling",
          description:
            "VisionSet never downloads models on its own — you choose what runs and where.",
          // `secondary`, not `primary`: the header's "Add connection" is on screen
          // and is the same label calling the same handler. One filled action per
          // view.
          action: (
            <Button variant="secondary" onClick={() => setCreating(true)}>
              Add connection
            </Button>
          ),
        }}
      >
        {(page) => {
          const filtering = needle.trim() !== "";
          const shown = matching(page.items, needle);
          return (
            <div className="flex flex-col gap-8" data-testid="connection-sections">
              {page.items.length > FILTER_ABOVE && (
                <div className="flex items-center gap-2">
                  <Filter className="size-4 text-muted-foreground" aria-hidden="true" />
                  <Label htmlFor="connection-filter" className="sr-only">
                    Filter connections
                  </Label>
                  <Input
                    id="connection-filter"
                    data-testid="connection-filter"
                    className="max-w-xs"
                    placeholder="Filter by name"
                    value={needle}
                    onChange={(event) => setNeedle(event.target.value)}
                  />
                  {/* Never hides the count of what it filtered out (`DESIGN.md`). */}
                  <span className="text-meta text-muted-foreground" data-testid="filter-count">
                    {shown.length} of {page.items.length}
                  </span>
                </div>
              )}
              {sectionsOf(shown).map((section) => (
                <CapabilitySection
                  key={section.key}
                  section={section}
                  filtering={filtering}
                  onAdd={() => setCreating(true)}
                  onEdit={setEditing}
                  onDelete={setDoomed}
                />
              ))}
            </div>
          );
        }}
      </Async>

      <ConnectionDialog open={creating} onClose={() => setCreating(false)} />
      <ConnectionDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        {...(editing === null ? {} : { editing })}
      />
      <DeleteConnectionDialog connection={doomed} onClose={() => setDoomed(null)} />
    </div>
  );
}

/** Case-insensitive name substring, the shape every filter in this product has. */
function matching(rows: readonly Connection[], needle: string): readonly Connection[] {
  const wanted = needle.trim().toLowerCase();
  if (wanted === "") return rows;
  return rows.filter((row) => row.name.toLowerCase().includes(wanted));
}

/**
 * One ability: what it is, where the app uses it, and what serves it here.
 *
 * The three ways a section can be empty are three different sentences, and
 * collapsing them is how a screen starts lying. **Nothing matches the filter** is
 * a fact about what somebody typed and never an occasion to invite anything.
 * **Nothing serves this yet** is an invitation, with a CTA naming what to add.
 * **Nothing can use this yet** is prose and no control at all, because the
 * missing half is the consuming surface rather than the connection — offering a
 * button here would be offering the feature it goes to.
 *
 * Exported for the test that renders a capability this build has no copy for: the
 * generated response check refuses an unrecognised member before a connection
 * carrying one reaches the screen, so the generic section cannot be reached
 * through a stubbed listing and is asserted against directly.
 */
export function CapabilitySection({
  section,
  filtering,
  onAdd,
  onEdit,
  onDelete,
}: {
  readonly section: ConnectionSection;
  readonly filtering: boolean;
  readonly onAdd: () => void;
  readonly onEdit: (connection: Connection) => void;
  readonly onDelete: (connection: Connection) => void;
}): JSX.Element {
  return (
    <section
      className="flex flex-col gap-3"
      data-testid={`section-${section.key}`}
      data-known={section.known}
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-section font-semibold tracking-tight">{section.title}</h2>
        <p className="max-w-3xl text-meta text-muted-foreground">{section.purpose}</p>
      </div>
      {section.connections.length > 0 ? (
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {section.connections.map((row) => (
            <ConnectionRow
              key={row.id}
              connection={row}
              onEdit={() => onEdit(row)}
              onDelete={() => onDelete(row)}
            />
          ))}
        </div>
      ) : filtering ? (
        <p className="text-meta text-muted-foreground" data-testid="section-filtered-out">
          Nothing here matches the filter.
        </p>
      ) : section.empty.kind === "invite" ? (
        <EmptyState
          title={section.empty.title}
          description={section.empty.body}
          icon={<Plug className="size-8" />}
          // `secondary`, not `primary`: the header's "Add connection" is on
          // screen and opens the same dialog. One filled action per view, and a
          // section per capability would otherwise put four on one page.
          action={
            <Button variant="secondary" onClick={onAdd}>
              {section.empty.cta}
            </Button>
          }
        />
      ) : (
        <p className="text-meta text-muted-foreground" data-testid="section-nothing">
          {section.empty.line}
        </p>
      )}
    </section>
  );
}

function ConnectionRow({
  connection,
  onEdit,
  onDelete,
}: {
  readonly connection: Connection;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}): JSX.Element {
  const can = new Set(connection.allowed_actions);
  const ready = connection.setup_state === "ready";
  const weights = useDownloadRun(connection);
  const integrity = useIntegrityRun(connection);
  return (
    <div className="flex flex-col gap-2 p-4" data-testid={`connection-${connection.name}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{connection.name}</span>
            <Badge data-testid="connection-type">
              {connection.connection_type === "local" ? "Local" : "HTTP"}
            </Badge>
            {/*
              Semantic token **and** text, never colour alone: the word is what a
              screen reader announces and what somebody who cannot tell the two
              desaturated chips apart reads.
            */}
            <Badge
              variant={ready ? "success" : "warning"}
              data-testid="connection-status"
              data-state={connection.setup_state}
            >
              {ready ? "Ready" : "Not set up"}
            </Badge>
          </div>
          {/* One line, the way a person reads them — the CLI's listing agrees. */}
          <span className="break-all text-meta text-muted-foreground">
            {connection.model_id} @ {connection.model_revision}
          </span>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <div className="flex items-center justify-end gap-2">
            {/*
              One declared action, two readings of it, and the row picks the
              reading from `setup_state` — a field the wire states. Whether the
              control may exist is still `allowed_actions` and nothing else.
            */}
            {can.has("download_weights") && !ready && (
              <Button
                variant="secondary"
                size="sm"
                data-testid="download-weights"
                disabled={weights.running}
                onClick={weights.start}
              >
                <Download className="size-4" aria-hidden="true" />
                {weights.running ? "Downloading…" : "Download weights"}
              </Button>
            )}
            {(can.has("update") ||
              can.has("delete") ||
              can.has("check_integrity") ||
              (can.has("download_weights") && ready)) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Actions for ${connection.name}`}
                    data-testid={`actions-${connection.name}`}
                  >
                    <MoreHorizontal className="size-4" aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {/*
                    Two checks over the same files, and each label says what its
                    own check *proves* rather than what it is called.
                    "Verify weights" covered both readings and could only be
                    honest about one: a download against a set-up connection
                    reads an index and finds a file that is absent, and no
                    amount of it will find a file that is present and wrong.
                    `docs/inference.md` carries the same two sentences.
                  */}
                  {can.has("download_weights") && ready && (
                    <DropdownMenuItem
                      data-testid="action-verify-weights"
                      disabled={weights.running}
                      onSelect={weights.start}
                    >
                      <FileSearch className="size-4" aria-hidden="true" />
                      {weights.running ? "Checking…" : "Check for missing files"}
                    </DropdownMenuItem>
                  )}
                  {can.has("check_integrity") && (
                    <DropdownMenuItem
                      data-testid="action-check-integrity"
                      disabled={integrity.running}
                      onSelect={integrity.start}
                    >
                      <ShieldCheck className="size-4" aria-hidden="true" />
                      {integrity.running ? "Reading every file…" : "Check files are undamaged"}
                    </DropdownMenuItem>
                  )}
                  {can.has("update") && (
                    <DropdownMenuItem data-testid="action-edit" onSelect={onEdit}>
                      <Pencil className="size-4" aria-hidden="true" />
                      Edit
                    </DropdownMenuItem>
                  )}
                  {can.has("delete") && (
                    <DropdownMenuItem data-testid="action-delete" onSelect={onDelete}>
                      <Trash2 className="size-4" aria-hidden="true" />
                      Delete
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          {/*
            Rendered off the wire and not off `weights.running`, so a page that
            arrived mid-transfer shows it on its first fetch — the whole point of
            the download living on the connection. It disappears when the job
            settles, at which point the row's own status says what happened.
          */}
          {weights.live !== null && <DownloadProgress download={weights.live} />}
          {integrity.live !== null && <IntegrityProgress check={integrity.live} />}
        </div>
      </div>
      {/*
        The prose runs the width of the row rather than the action column's, so
        an install command and a file name stay on one or two lines instead of
        wrapping down the right-hand edge.
      */}
      {weights.failure !== null && (
        <FieldError data-testid="download-error">
          <Badge variant="destructive">{weights.failure.code}</Badge> {weights.failure.message}{" "}
          {ready
            ? "The connection is still Ready — nothing was changed. Check again to re-read the cache."
            : "The connection is still Not set up: weights arrive or they do not, so there is nothing half-installed to clear up. Download weights again — an interrupted transfer resumes from what it had."}
        </FieldError>
      )}
      {/*
        The one failure on this screen that has already acted. A check that
        found damage purged the bad files and stood the connection down
        before the job row said so, so the sentence describes a state the
        row is *already* in — and the remedy it names is the action the
        connection now declares, in this row's own menu.
      */}
      {integrity.failure !== null && (
        <FieldError data-testid="integrity-error">
          <Badge variant="destructive">{integrity.failure.code}</Badge> {integrity.failure.message}{" "}
          {ready
            ? "Nothing was removed and the connection is still Ready — a check that cannot reach the model's source is not an answer about the files here."
            : "The damaged copies have been removed and the connection is back to Not set up. Download weights again: with the bad files gone, it is a real transfer rather than a cache hit."}
        </FieldError>
      )}
    </div>
  );
}

/**
 * The connection's weight transfer, read off the row rather than followed.
 *
 * **Nothing here remembers that a download was started**, and that is the whole
 * of why leaving the screen no longer loses one. The wire says which job, what
 * state and how many bytes; this reads it. A version of this that held the job id
 * from the `202` — which is what shipped — could only show a transfer the *same
 * mount* had launched, so a reload, a second tab, or walking to another screen
 * and back all produced `Not set up` beside a download that was still running.
 *
 * The mutation is still here because starting one is still an event, and its own
 * refusal (a 409, a missing runtime) is answered to the request rather than to a
 * job that was never created.
 *
 * A settled transfer stays readable, which is what makes a failure survivable: the
 * row goes on carrying the sentence until a retry replaces the record.
 */
function useDownloadRun(connection: Connection): {
  readonly start: () => void;
  readonly running: boolean;
  readonly live: WeightDownload | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
} {
  const mutation = useDownloadWeights();
  const download = connection.download ?? null;
  const live = isLive(download);
  return {
    start: () => mutation.mutate(connection.id),
    // `isPending` covers the gap between the click and the re-read that brings
    // the queued job back, which is the one moment the wire has not caught up.
    running: mutation.isPending || live,
    live: live ? download : null,
    failure: mutation.isError
      ? asApiError(mutation.error)
      : download?.state === "failed"
        ? { code: "DOWNLOAD_FAILED", message: download.error ?? "The download did not finish." }
        : null,
  };
}

/**
 * The connection's integrity check, read off the row rather than followed.
 *
 * `useDownloadRun`'s twin over the same files, and it holds no job id for the
 * same reason: a check outlives the request that started it, so the only way a
 * screen can show one it did not itself launch — a reload, a second tab, a
 * terminal — is for the connection it lists to say so. Holding the id meant only
 * the mount that pressed the menu item could see a run reading gigabytes.
 *
 * A settled check stays readable, which is what makes a failure survivable: the
 * verdict is on `setup_state` and the sentence is here, and both outlive the tab
 * that was watching.
 */
function useIntegrityRun(connection: Connection): {
  readonly start: () => void;
  readonly running: boolean;
  readonly live: IntegrityCheck | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
} {
  const mutation = useCheckIntegrity();
  const check = connection.integrity_check ?? null;
  const live = isLive(check);
  return {
    start: () => mutation.mutate(connection.id),
    running: mutation.isPending || live,
    live: live ? check : null,
    failure: mutation.isError
      ? asApiError(mutation.error)
      : check?.state === "failed"
        ? { code: "WEIGHTS_DAMAGED", message: check.error ?? "The check did not finish." }
        : null,
  };
}

/**
 * A run in flight: a bar somebody watches, and a sentence they can read.
 *
 * Both, never one — a bar alone cannot say *queued*, and prose alone makes
 * somebody read a number every two seconds to find out whether anything is
 * moving. Amounts rather than a bare percentage, because "38%" of an unstated
 * quantity answers neither *how much longer* nor *how much of what*.
 *
 * **One layout, two vocabularies.** The geometry, the tabular figures and the
 * bar are shared; what each run *counts* is not, and the callers below supply the
 * sentence. A component that branched on a `kind` would be the place the two
 * vocabularies met, which is exactly what the wire is shaped to avoid.
 *
 * A run whose total is not known gets the sentence and **no bar at all**.
 * `Progress` renders an indeterminate value as an empty track, which reads as
 * *0%* — a lie in the one case where the truth is *this is going, and nobody can
 * say how far*. Giving the primitive an indeterminate animation is a
 * design-system change and not this screen's to make.
 */
function RunProgress({
  testId,
  phase,
  percent,
  children,
}: {
  readonly testId: string;
  readonly phase: string;
  readonly percent: number | null;
  readonly children: string;
}): JSX.Element {
  return (
    <div className="flex w-56 flex-col gap-1" data-testid={testId}>
      {percent !== null && (
        <Progress value={percent} data-testid={`${testId}-bar`} data-phase={phase} />
      )}
      {/*
        Tabular figures, `DESIGN.md`'s Numbers rule: the number changes every two
        seconds and the words after it must not move under a reader's eye.
      */}
      <span className="text-meta tabular-nums text-muted-foreground" data-testid={`${testId}-prose`}>
        {children}
      </span>
    </div>
  );
}

/**
 * What a transfer is doing, in bytes.
 *
 * **Three renderings, and the middle one is why this is not one line.**
 *
 * - *Queued* — no bytes yet, and the honest bar is absent rather than empty.
 * - *Transferring* — determinate, and it is the whole point of the feature.
 * - *Settling* — every byte is here and the job has not finished, because a
 *   download ends by reading what arrived and recording the connection ready.
 *   The bar is full and the sentence names that phase, so a bar sitting at 100%
 *   for a second reads as a step rather than as a stall.
 */
function DownloadProgress({ download }: { readonly download: WeightDownload }): JSX.Element {
  const { state, bytes_done: done, bytes_total: total } = download;
  const known = total !== null && total > 0;
  const settling = known && done >= total;
  const percent = known && state !== "queued" ? Math.min(100, Math.round((done / total) * 100)) : null;
  return (
    <RunProgress
      testId="download-progress"
      phase={settling ? "settling" : state}
      percent={percent}
    >
      {state === "queued"
        ? "Queued — starts as soon as a worker is free."
        : settling
          ? "Checking what arrived…"
          : known
            ? `${bytes(done)} of ${bytes(total)} · ${percent}%`
            : `${bytes(done)} so far — the published size could not be read.`}
    </RunProgress>
  );
}

/**
 * What a check is doing, in files.
 *
 * Files because that is what it counts: a check owns its loop and knows how many
 * the revision names before it opens the first one. It borrows no part of the
 * download's vocabulary, which is the whole reason the wire carries two shapes.
 *
 * The null-total window is short and real — a check reads the hub's listing
 * before its first file — so it gets the same no-bar treatment a download with no
 * published size does, and for the same reason.
 */
function IntegrityProgress({ check }: { readonly check: IntegrityCheck }): JSX.Element {
  const { state, files_read: read, files_total: total } = check;
  const known = total !== null && total > 0;
  const percent = known && state !== "queued" ? Math.min(100, Math.round((read / total) * 100)) : null;
  return (
    <RunProgress testId="integrity-progress" phase={state} percent={percent}>
      {state === "queued"
        ? "Queued — starts as soon as a worker is free."
        : known
          ? `${read.toLocaleString()} of ${total.toLocaleString()} files · ${percent}%`
          : "Reading what the model's source publishes…"}
    </RunProgress>
  );
}

/**
 * Two steps on the way in, one on the way back.
 *
 * Creating picks a kind and then fills in that kind's form, because the two
 * kinds share almost no fields and a single form holding both would be mostly
 * disabled whichever was chosen. Editing skips step one: the kind is not
 * editable, so offering it would be offering something the server refuses.
 */
function ConnectionDialog({
  open,
  onClose,
  editing,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly editing?: Connection;
}): JSX.Element {
  const create = useCreateConnection();
  const update = useUpdateConnection();
  const [kind, setKind] = useState<ConnectionType | null>(null);
  const [name, setName] = useState("");
  const [modelId, setModelId] = useState("");
  const [revision, setRevision] = useState("");
  // Which entry the model select is showing: a curated model id, or the sentinel
  // that reveals the free fields. Kept beside `modelId` rather than derived from
  // it, because a custom connection may name a curated model at another revision
  // and the select must go on showing "Custom" while it does.
  const [choice, setChoice] = useState<string>(CUSTOM_MODEL);
  const [device, setDevice] = useState<string>("cpu");
  const [precision, setPrecision] = useState<Precision>("fp32");
  const [endpoint, setEndpoint] = useState("");

  // Fill the form from whatever the dialog was opened for. An edit arrives with a
  // row; a create arrives with nothing and, once a local kind is chosen, with the
  // default curated model already in it.
  useEffect(() => {
    if (!open) return;
    if (editing !== undefined) {
      setKind(editing.connection_type);
      setName(editing.name);
      setModelId(editing.model_id);
      setRevision(editing.model_revision);
      setChoice(
        curatedEntry(editing.model_id, editing.model_revision)?.modelId ?? CUSTOM_MODEL,
      );
      // A device outside what a form offers — `cuda:1`, or a row from a build
      // before the vocabulary closed — is shown as it is rather than rewritten
      // to the nearest offered member behind somebody's back.
      setDevice(editing.device ?? "cpu");
      setPrecision(editing.precision ?? "fp32");
      setEndpoint(editing.endpoint_url ?? "");
      return;
    }
    setKind(null);
    setName("");
    setModelId("");
    setRevision("");
    setChoice(CUSTOM_MODEL);
    setDevice("cpu");
    setPrecision("fp32");
    setEndpoint("");
  }, [open, editing]);

  function choose(next: ConnectionType): void {
    setKind(next);
    if (next === "local") pickModel(DEFAULT_MODEL.modelId);
  }

  /** Pick a curated entry — which sets both halves of the pair — or reveal the fields. */
  function pickModel(next: string): void {
    setChoice(next);
    const entry = next === CUSTOM_MODEL ? undefined : CURATED_BY_ID.get(next);
    if (entry === undefined) return;
    setModelId(entry.modelId);
    setRevision(entry.revision);
  }

  /**
   * Moving the device can strand the precision, so the precision moves with it.
   *
   * The kernel refuses `cpu` + `fp16`, so a form that left `fp16` selected while
   * the device went to `cpu` would be offering a pair it knows will be refused —
   * which is worse than either offering it and rendering the refusal or not
   * offering it at all.
   */
  function pickDevice(next: string): void {
    setDevice(next);
    setPrecision(precisionOn(next, precision));
  }

  const local = kind === "local";
  const custom = choice === CUSTOM_MODEL;
  const pending = create.isPending || update.isPending;
  const complete =
    name.trim() !== "" &&
    modelId.trim() !== "" &&
    revision.trim() !== "" &&
    (local ? device.trim() !== "" : endpoint.trim() !== "");

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (kind === null) return;
    const input = {
      name: name.trim(),
      connectionType: kind,
      modelId: modelId.trim(),
      modelRevision: revision.trim(),
      device: device.trim(),
      precision,
      endpointUrl: endpoint.trim(),
    };
    // Only on success: a refusal leaves the dialog open with what was typed
    // still in it.
    if (editing === undefined) create.mutate(input, { onSuccess: onClose });
    else update.mutate({ ...input, id: editing.id }, { onSuccess: onClose });
  }

  const failure = create.isError ? create.error : update.isError ? update.error : null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="connection-dialog">
        <DialogTitle>{editing === undefined ? "Add connection" : `Edit ${editing.name}`}</DialogTitle>
        {kind === null ? (
          <>
            <DialogDescription>
              Where does this model run? Creating a connection downloads nothing.
            </DialogDescription>
            <div className="flex flex-col gap-2" data-testid="choose-type">
              <Button variant="secondary" data-testid="choose-local" onClick={() => choose("local")}>
                Local — weights this machine runs
              </Button>
              <Button variant="secondary" data-testid="choose-http" onClick={() => choose("http")}>
                HTTP — an endpoint that answers this project&rsquo;s contract
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogDescription>
              {local
                ? "Nothing is fetched until you ask for it, from the row this creates."
                : "The endpoint answers this project's own inference contract."}
            </DialogDescription>
            <form className="flex flex-col gap-3" onSubmit={submit}>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="connection-name">Name</Label>
                <Input
                  id="connection-name"
                  data-testid="connection-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoFocus
                />
                <FieldHint>Unique in this workspace, ignoring case.</FieldHint>
              </div>
              {/*
                The curated list is the *local* form's, and only its. A curated
                entry is a checkpoint this build has an adapter for and would
                download; an HTTP connection names whatever the endpoint on the
                other end runs, which this build never loads and cannot vouch
                for. Offering the same list there would be recommending models
                for somebody else's server.
              */}
              {local ? (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="connection-model">Model</Label>
                    <Select value={choice} onValueChange={pickModel}>
                      <SelectTrigger id="connection-model" data-testid="connection-model">
                        <SelectValue placeholder="Choose a model" />
                      </SelectTrigger>
                      <SelectContent>
                        {CURATED_MODELS.map((group) => (
                          <SelectGroup key={group.label}>
                            <SelectLabel>{group.label}</SelectLabel>
                            {/*
                              Two lines: the id is what identifies the checkpoint
                              and the rest is what it costs and what it is for
                              On one line it is a sentence long enough to wrap
                              inside the trigger, and a wrapped identifier is
                              harder to read than a stacked one.
                            */}
                            {group.models.map((model) => (
                              <SelectItem
                                key={model.modelId}
                                value={model.modelId}
                                meta={`${bytes(model.totalBytes)} · ${model.hint}`}
                              >
                                {model.modelId}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        ))}
                        <SelectGroup>
                          <SelectItem
                            value={CUSTOM_MODEL}
                            meta="Any model id, at a revision you pin yourself"
                          >
                            Custom model…
                          </SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FieldHint>
                      {custom
                        ? "Any model this build has an adapter for. The list above is a starting point, not a limit."
                        : "Pinned to the revision this list was checked against."}
                    </FieldHint>
                  </div>
                  {custom && (
                    <>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="connection-custom-model">Model id</Label>
                        <Input
                          id="connection-custom-model"
                          data-testid="connection-custom-model"
                          value={modelId}
                          onChange={(event) => setModelId(event.target.value)}
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="connection-revision">Revision</Label>
                        <Input
                          id="connection-revision"
                          data-testid="connection-revision"
                          value={revision}
                          onChange={(event) => setRevision(event.target.value)}
                        />
                        <FieldHint>Pinned. A moving pointer is not a provenance.</FieldHint>
                      </div>
                    </>
                  )}
                  <div className="flex gap-3">
                    <div className="flex flex-1 flex-col gap-1.5">
                      <Label htmlFor="connection-device">Device</Label>
                      <Select value={device} onValueChange={pickDevice}>
                        <SelectTrigger id="connection-device" data-testid="connection-device">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {/*
                            A row already holding something else — `cuda:1` for a
                            second GPU — keeps its own value as an option, so
                            opening the edit form does not silently reassign it.
                          */}
                          {(DEVICES.includes(device as (typeof DEVICES)[number])
                            ? DEVICES
                            : [...DEVICES, device]
                          ).map((one) => (
                            <SelectItem key={one} value={one}>
                              {one}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex flex-1 flex-col gap-1.5">
                      <Label htmlFor="connection-precision">Precision</Label>
                      <Select
                        value={precision}
                        onValueChange={(next) => setPrecision(next as Precision)}
                      >
                        <SelectTrigger
                          id="connection-precision"
                          data-testid="connection-precision"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {precisionsFor(device).map((one) => (
                            <SelectItem key={one} value={one}>
                              {one}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FieldHint data-testid="precision-hint">
                        {precisionsFor(device).length === 1
                          ? "Half precision applies on CUDA only — on a CPU it has no effect."
                          : "fp16 halves the memory and runs faster on CUDA."}
                      </FieldHint>
                    </div>
                  </div>
                  <AccessLine modelId={modelId.trim()} revision={revision.trim()} />
                  <DownloadSizeLine modelId={modelId.trim()} revision={revision.trim()} />
                </>
              ) : (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="connection-custom-model">Model</Label>
                    <Input
                      id="connection-custom-model"
                      data-testid="connection-custom-model"
                      value={modelId}
                      onChange={(event) => setModelId(event.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="connection-revision">Revision</Label>
                    <Input
                      id="connection-revision"
                      data-testid="connection-revision"
                      value={revision}
                      onChange={(event) => setRevision(event.target.value)}
                    />
                    <FieldHint>Pinned. A moving pointer is not a provenance.</FieldHint>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="connection-endpoint">Endpoint URL</Label>
                    <Input
                      id="connection-endpoint"
                      data-testid="connection-endpoint"
                      value={endpoint}
                      onChange={(event) => setEndpoint(event.target.value)}
                    />
                  </div>
                </>
              )}
              {failure !== null && (
                <FieldError data-testid="connection-error">
                  <Badge variant="destructive">{asApiError(failure).code}</Badge>{" "}
                  {asApiError(failure).message}
                </FieldError>
              )}
              <DialogFooter>
                <Button variant="secondary" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  data-testid="connection-submit"
                  disabled={!complete || pending}
                >
                  {pending ? "Saving…" : editing === undefined ? "Create" : "Save"}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * What has to be cleared before this model can be fetched, said before it is.
 *
 * Principle 9: no requirement is discovered by crashing into it. A gated model
 * refuses its download with a sentence naming the remedy, which is the right
 * refusal and still the wrong place to learn it — by then somebody has chosen a
 * model, created a connection and pressed a button. This is the same fact, one
 * step earlier, while the choice is still being made.
 *
 * Read through {@link curatedEntry} rather than off the select's own value, so it
 * survives reopening a stored connection: the entry matches on the revision as
 * well as the id, which means a connection pinned to some other commit of the
 * same model is correctly *not* described by this line.
 *
 * A custom model id gets nothing here, and that is honest rather than a gap —
 * whether an arbitrary repository is gated is not something this build knows
 * before asking, and the refusal is what answers it.
 */
function AccessLine({
  modelId,
  revision,
}: {
  readonly modelId: string;
  readonly revision: string;
}): JSX.Element {
  const access = curatedEntry(modelId, revision)?.access;
  if (access === undefined) return <></>;
  return (
    <p className="text-meta text-muted-foreground" data-testid="model-access">
      {access.note}{" "}
      <a
        className="underline underline-offset-2"
        href={access.href}
        target="_blank"
        rel="noreferrer"
      >
        Request access
      </a>
      .
    </p>
  );
}

/**
 * What this revision would cost to fetch, beside the control that confirms it.
 *
 * D1's "download size shown before confirming", and the one place a missing local
 * runtime becomes visible in this form. The refusal is rendered **as the server
 * wrote it** — `LOCAL_INFERENCE_UNAVAILABLE` is one of the four codes that opt
 * out of the opaque body precisely so the install command reaches a person, and a
 * sentence written here would throw it away.
 *
 * The form stays usable throughout (principle 9): not knowing the size does not
 * stop somebody configuring a connection, because creating one downloads nothing.
 */
function DownloadSizeLine({
  modelId,
  revision,
}: {
  readonly modelId: string;
  readonly revision: string;
}): JSX.Element {
  const size = useDownloadSize(modelId, revision);
  if (modelId === "" || revision === "") return <></>;
  if (size.isPending) {
    return (
      <p className="text-meta text-muted-foreground" data-testid="size-checking">
        Reading the download size…
      </p>
    );
  }
  if (size.isError) {
    const failure = asApiError(size.error);
    return (
      <p className="text-meta text-muted-foreground" data-testid="size-unavailable">
        <Badge variant="warning">{failure.code}</Badge> {failure.message}
      </p>
    );
  }
  return (
    <p className="text-meta text-muted-foreground" data-testid="size-known">
      Downloads {bytes(size.data.total_bytes)} across {size.data.file_count} files when you
      ask for it.
    </p>
  );
}

/**
 * One decimal place, in the reader's own locale. See {@link bytes}.
 *
 * Built once at module scope rather than per call: constructing an
 * `Intl.NumberFormat` is the expensive half of formatting, and this one is called
 * on every row of a list that re-reads itself twice a second while a download
 * runs.
 */
const SCALED = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/**
 * Bytes as somebody reads them.
 *
 * Decimal units, because a download size is what a network moves and what a
 * publisher quotes; binary units would put a different number on screen from the
 * one the model's own page shows.
 *
 * **One helper, and every size on this screen goes through it** — the curated
 * list's entries, the form's line before a confirm, and both halves of a transfer
 * in flight. `DESIGN.md`'s Numbers rule states the reason: `1.2 GB` and `1,2 GB`
 * on one screen is exactly how a call-site decision goes wrong.
 *
 * Locale-aware for the same rule's sake, and a whole number of bytes stays whole:
 * `512 B` rather than `512.0 B`, because a unit small enough to count exactly is
 * one nobody wants rounded.
 */
export function bytes(count: number): string {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let value = count;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 ? value.toLocaleString() : SCALED.format(value)} ${units[unit]}`;
}

function DeleteConnectionDialog({
  connection,
  onClose,
}: {
  readonly connection: Connection | null;
  readonly onClose: () => void;
}): JSX.Element {
  const remove = useDeleteConnection();
  return (
    <Dialog open={connection !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="delete-connection-dialog">
        <DialogTitle>Delete {connection?.name}?</DialogTitle>
        <DialogDescription>
          Annotations keep their model provenance; only this configuration is removed.
        </DialogDescription>
        {remove.isError && (
          <FieldError data-testid="delete-connection-error">
            <Badge variant="destructive">{asApiError(remove.error).code}</Badge>{" "}
            {asApiError(remove.error).message}
          </FieldError>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            data-testid="delete-connection-submit"
            disabled={remove.isPending}
            onClick={() => connection !== null && remove.mutate(connection.id, { onSuccess: onClose })}
          >
            {remove.isPending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
