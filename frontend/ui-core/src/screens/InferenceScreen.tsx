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
 * test call and its result — `test_endpoint`, in the row's menu — never to a
 * stored row that would start lying the moment the network moved.
 *
 * ## What the form offers, and what it refuses to compute
 *
 * The model, the device and the precision are all chosen from lists rather than
 * typed. The model list is the *installation's*: the server names every model an
 * installed driver offers, and the form renders what was served — so a driver
 * this repository never saw reaches the select by being installed. What a form
 * makes of that list, and the two vocabularies below, live in
 * `inferenceCatalog.ts`.
 *
 * A served list is a query, so the field has three states before it has a select:
 * it says it is reading, it renders a refusal as prose, or it says the
 * installation offers nothing by name. Curation guides without restricting:
 * **Custom model…** reveals the same free model id and revision fields the form
 * had before, and those fields are also what the last two states leave in place —
 * a model id typed by hand needs no catalog at all.
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
 * `docs/content/inference.md` carries the same two sentences, so the page and the
 * product cannot drift apart.
 *
 * `test_endpoint` is declared only for an `http` connection, in either state,
 * and is the one action whose answer is the connection itself.
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
 * **A live run of either kind disables every control over that connection's
 * files, and the label names the run rather than going blank.** The three act on
 * one cache: a second request of the same kind is answered by the server with the
 * run already in flight, and one of the other kind would set a transfer and a
 * full re-read against the same files. Because the flag is read off the wire, the
 * withdrawal is visible in a tab that started nothing. What the row must not do
 * is decide from this whether a control *exists* — that stays `allowed_actions`,
 * which no run changes.
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
  IconBroadcast,
  IconDots,
  IconDownload,
  IconFileSearch,
  IconFilter,
  IconPencil,
  IconPlug,
  IconShieldCheck,
  IconTrash,
} from "@tabler/icons-react";
import { useEffect, useRef, useState, type FormEvent, type JSX } from "react";

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
  useProviders,
  useTestEndpoint,
  useUpdateConnection,
  type Connection,
  type ConnectionType,
  type CuratedEntry,
  type IntegrityCheck,
  type WeightDownload,
} from "../data/inferenceQueries";
import { jobFailureProse, refusalProse } from "../data/refusals";
import { EmptyState, ErrorState, LoadingState } from "../patterns/AsyncStates";
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
  CUSTOM_MODEL,
  DEVICES,
  accessFor,
  defaultEntry,
  entriesOf,
  entryFor,
  groupsOf,
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
          <h1 className="text-2xl font-semibold tracking-tight">Inference</h1>
          <p className="text-xs text-muted-foreground">
            Where a model may be asked to predict. Connections are shared by every project
            in this workspace.
          </p>
        </div>
        <Button variant="primary" data-testid="new-connection" onClick={() => setCreating(true)}>
          <IconPlug aria-hidden="true" />
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
                  <IconFilter className="size-4 text-muted-foreground" aria-hidden="true" />
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
                  <span className="text-xs text-muted-foreground" data-testid="filter-count">
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
        <h2 className="text-base font-semibold tracking-tight">{section.title}</h2>
        <p className="max-w-3xl text-xs text-muted-foreground">{section.purpose}</p>
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
        <p className="text-xs text-muted-foreground" data-testid="section-filtered-out">
          Nothing here matches the filter.
        </p>
      ) : section.empty.kind === "invite" ? (
        <EmptyState
          title={section.empty.title}
          description={section.empty.body}
          icon={<IconPlug className="size-8" />}
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
        <p className="text-xs text-muted-foreground" data-testid="section-nothing">
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
  const probe = useTestEndpoint();
  // **One busy state for every control over this connection's files, not one per
  // kind.** All three below act on a single cache, so while either run is in
  // flight the others have nothing to offer: a second request of the same kind
  // is answered with the run already going, and one of the other kind would put
  // a transfer and a full re-read over the same files at once. Disabling all of
  // them is the offer withdrawn where somebody would otherwise press it.
  //
  // Whether a control *exists* is still `allowed_actions` and nothing else —
  // this decides only whether it can be pressed, so no client-side rule is
  // deciding what the connection permits.
  const busy = weights.running || integrity.running;
  // Never a bare disabled control: the label says what is happening, in the
  // vocabulary this row's setup state gives it. At `ready` a download reads an
  // index for files that are missing, which is "Checking…"; before setup it is
  // the transfer itself. Read only while `busy`.
  const busyLabel = weights.running ? (ready ? "Checking…" : "Downloading…") : "Reading every file…";
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
          <span className="break-all text-xs text-muted-foreground">
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
                disabled={busy}
                onClick={weights.start}
              >
                <IconDownload className="size-4" aria-hidden="true" />
                {busy ? busyLabel : "Download weights"}
              </Button>
            )}
            {(can.has("update") ||
              can.has("delete") ||
              can.has("check_integrity") ||
              can.has("test_endpoint") ||
              (can.has("download_weights") && ready)) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Actions for ${connection.name}`}
                    data-testid={`actions-${connection.name}`}
                  >
                    <IconDots aria-hidden="true" />
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
                    `docs/content/inference.md` carries the same two sentences.
                  */}
                  {can.has("download_weights") && ready && (
                    <DropdownMenuItem
                      data-testid="action-verify-weights"
                      disabled={busy}
                      onSelect={weights.start}
                    >
                      <IconFileSearch className="size-4" aria-hidden="true" />
                      {busy ? busyLabel : "Check for missing files"}
                    </DropdownMenuItem>
                  )}
                  {can.has("check_integrity") && (
                    <DropdownMenuItem
                      data-testid="action-check-integrity"
                      disabled={busy}
                      onSelect={integrity.start}
                    >
                      <IconShieldCheck className="size-4" aria-hidden="true" />
                      {busy ? busyLabel : "Check files are undamaged"}
                    </DropdownMenuItem>
                  )}
                  {can.has("test_endpoint") && (
                    <DropdownMenuItem
                      data-testid="action-test-endpoint"
                      disabled={probe.isPending}
                      onSelect={() => probe.mutate(connection.id)}
                    >
                      <IconBroadcast className="size-4" aria-hidden="true" />
                      {probe.isPending ? "Asking the endpoint…" : "Test endpoint"}
                    </DropdownMenuItem>
                  )}
                  {can.has("update") && (
                    <DropdownMenuItem data-testid="action-edit" onSelect={onEdit}>
                      <IconPencil className="size-4" aria-hidden="true" />
                      Edit
                    </DropdownMenuItem>
                  )}
                  {can.has("delete") && (
                    <DropdownMenuItem data-testid="action-delete" onSelect={onDelete}>
                      <IconTrash className="size-4" aria-hidden="true" />
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
          {weights.failure}{" "}
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
          {integrity.failure}{" "}
          {ready
            ? "Nothing was removed and the connection is still Ready — a check that cannot reach the model's source is not an answer about the files here."
            : "The damaged copies have been removed and the connection is back to Not set up. Download weights again: with the bad files gone, it is a real transfer rather than a cache hit."}
        </FieldError>
      )}
      {probe.isPending && (
        <FieldHint data-testid="test-endpoint-pending">Asking the endpoint…</FieldHint>
      )}
      {probe.isError && (
        <FieldError data-testid="test-endpoint-error">{refusalProse(probe.error)}</FieldError>
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
  readonly failure: string | null;
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
      ? refusalProse(mutation.error)
      : download?.state === "failed"
        ? jobFailureProse(download, "The download did not finish.")
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
  readonly failure: string | null;
} {
  const mutation = useCheckIntegrity();
  const check = connection.integrity_check ?? null;
  const live = isLive(check);
  return {
    start: () => mutation.mutate(connection.id),
    running: mutation.isPending || live,
    live: live ? check : null,
    failure: mutation.isError
      ? refusalProse(mutation.error)
      : check?.state === "failed"
        ? jobFailureProse(check, "The check did not finish.")
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
      <span className="text-xs tabular-nums text-muted-foreground" data-testid={`${testId}-prose`}>
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
  // **Known and measurable are two questions, and folding them lost one.**
  // `total > 0` was doing both jobs, so a download of *nothing* — the built-in
  // stand-in has no weights to fetch — rendered "the published size could not be
  // read", which is a sentence about a failure in front of a total that was read
  // and is zero. A bar still needs a positive total to divide by, hence the
  // second name rather than one loosened test.
  const known = total !== null;
  const measurable = known && total > 0;
  const settling = known && done >= total;
  const percent =
    measurable && state !== "queued" ? Math.min(100, Math.round((done / total) * 100)) : null;
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
          : measurable
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
 * The dialog itself, which owns no form state at all.
 *
 * **The form is a child, so Radix mounts it per opening.** `DialogContent`
 * portals its subtree only while the dialog is open and unmounts it on close, so
 * every opening gets a fresh {@link ConnectionForm} and there is nothing to
 * reset.
 *
 * One long-lived component reset by an effect cannot hold that: the reset and
 * the effect that seeds the model run in the same commit over the same render's
 * state, so the second reads the *previous* session's kind and seeds a model
 * into a form that was told to forget one — which is how a local session
 * abandoned mid-load hands its model id to the next connection, an HTTP one
 * included. No guard fixes that, because a guard reads the same stale state.
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
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="connection-dialog">
        <DialogTitle>{editing === undefined ? "Add connection" : `Edit ${editing.name}`}</DialogTitle>
        <ConnectionForm onClose={onClose} {...(editing === undefined ? {} : { editing })} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Two steps on the way in, one on the way back.
 *
 * Creating picks a kind and then fills in that kind's form, because the two
 * kinds share almost no fields and a single form holding both would be mostly
 * disabled whichever was chosen. Editing skips step one: the kind is not
 * editable, so offering it would be offering something the server refuses.
 *
 * Every field starts where the opening puts it, in a `useState` initialiser
 * rather than in an effect — this component exists only while the dialog is
 * open, so there is one opening to initialise for and nothing to reset.
 */
function ConnectionForm({
  onClose,
  editing,
}: {
  readonly onClose: () => void;
  readonly editing?: Connection;
}): JSX.Element {
  const create = useCreateConnection();
  const update = useUpdateConnection();
  // Asked for by the form and not by the screen: the catalog is this form's read,
  // and a screen that merely lists connections has no use for it. Nothing has to
  // say so — this component only exists while the dialog is open.
  const catalog = useProviders();
  const entries = catalog.data === undefined ? [] : entriesOf(catalog.data.items);
  const groups = groupsOf(entries);
  const [kind, setKind] = useState<ConnectionType | null>(editing?.connection_type ?? null);
  const [name, setName] = useState(editing?.name ?? "");
  const [modelId, setModelId] = useState(editing?.model_id ?? "");
  const [revision, setRevision] = useState(editing?.model_revision ?? "");
  // Which entry the model select is showing: an offered model id, the sentinel
  // that reveals the free fields, or `""` for undecided — the catalog is a query,
  // so there is a real moment before the form knows what it may offer, and an
  // edit cannot resolve its stored pair until the list arrives. Kept beside
  // `modelId` rather than derived from it, because a custom connection may name
  // an offered model at another revision and the select must go on showing
  // "Custom" while it does.
  const [choice, setChoice] = useState<string>("");
  // Which driver serves what is selected, carried from the catalog entry rather
  // than derived: a form cannot know which installed driver offers a checkpoint,
  // and the entry it just read says so.
  const [providerId, setProviderId] = useState<string | null>(editing?.provider_id ?? null);
  // A device outside what a form offers — `cuda:1`, or a row from a build before
  // the vocabulary closed — is shown as it is rather than rewritten to the
  // nearest offered member behind somebody's back.
  const [device, setDevice] = useState<string>(editing?.device ?? "cpu");
  const [precision, setPrecision] = useState<Precision>(editing?.precision ?? "fp32");
  const [endpoint, setEndpoint] = useState(editing?.endpoint_url ?? "");
  const [credentialEnv, setCredentialEnv] = useState(editing?.credential_env ?? "");
  /**
   * Whether the sentinel on screen was seeded here rather than chosen.
   *
   * The select cannot tell the two apart by value, and they mean opposite
   * things: a sentinel this effect fell back to is a placeholder for a catalog
   * that had nothing to offer, and one somebody picked is a decision. A ref
   * rather than state because nothing renders differently for it.
   */
  const seededSentinel = useRef(false);

  /**
   * Decide what the select shows, once the catalog can answer.
   *
   * Two things used to happen synchronously and cannot: a new local connection
   * opened on a default read from a constant, and an edit resolved its stored
   * pair against one. Both now wait for a served list.
   *
   * **It seeds only where nobody has decided anything.** That is `choice === ""`,
   * and one more case: the sentinel this effect itself fell back to with no model
   * id typed under it. Without that second case a successful *Try again* left the
   * form on Custom with two empty fields while the select behind it filled up —
   * and with it *unrestricted*, a catalog arriving after somebody typed a model
   * id by hand would throw the id away.
   *
   * **Every dependency is a primitive but one.** A query hands back a fresh array
   * on every rebuild, and an effect depending on that array re-runs on every
   * render — which is how view state dies with nothing unmounting and no error to
   * show for it. `editing` is the exception, and a deliberate one: it is the
   * screen's `useState<Connection | null>`, captured when a row's Edit was
   * pressed, so it changes only when the dialog is opened for a different row and
   * the connection poll cannot churn its identity.
   */
  const fallback = defaultEntry(entries);
  const fallbackId = fallback?.model_id;
  const fallbackRevision = fallback?.model_revision;
  const fallbackProvider = fallback?.provider_id;
  const storedChoice =
    editing === undefined
      ? undefined
      : entryFor(entries, editing.model_id, editing.model_revision)?.model_id;

  useEffect(() => {
    if (catalog.isPending) return;
    const undecided =
      choice === "" || (choice === CUSTOM_MODEL && seededSentinel.current && modelId.trim() === "");
    if (!undecided) return;
    if (editing !== undefined) {
      seededSentinel.current = storedChoice === undefined;
      setChoice(storedChoice ?? CUSTOM_MODEL);
      return;
    }
    if (kind !== "local") return;
    // Nothing is offered, or nothing offered answers a point prompt: the form
    // opens on its free fields rather than on a model nothing here can be asked.
    if (fallbackId === undefined || fallbackRevision === undefined) {
      seededSentinel.current = true;
      setChoice(CUSTOM_MODEL);
      return;
    }
    seededSentinel.current = false;
    setChoice(fallbackId);
    setModelId(fallbackId);
    setRevision(fallbackRevision);
    // The default is seeded here rather than through `pickModel`, so the driver
    // has to be recorded here too — a form that set it only in the handler would
    // send none for the model it opened on, which is the commonest create there
    // is.
    setProviderId(fallbackProvider ?? null);
  }, [
    choice,
    modelId,
    kind,
    editing,
    catalog.isPending,
    storedChoice,
    fallbackId,
    fallbackRevision,
    fallbackProvider,
  ]);

  /** Pick an offered entry — which sets both halves of the pair — or reveal the fields. */
  function pickModel(next: string): void {
    // A decision, so the effect above leaves it alone from here on.
    seededSentinel.current = false;
    setChoice(next);
    const entry = entries.find((one) => one.model_id === next);
    if (entry === undefined) {
      // The sentinel. The pair is left as it is, so a typed id survives opening
      // the select and closing it again — but the driver is cleared, because it
      // named whoever offered the entry being left behind and nothing offers
      // what is about to be typed.
      setProviderId(null);
      return;
    }
    setModelId(entry.model_id);
    setRevision(entry.model_revision);
    setProviderId(entry.provider_id);
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
  /** Whether the model field is a select — the one state of four that has a control. */
  const offering = catalog.isSuccess && groups.length > 0;
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
      credentialEnv: credentialEnv.trim(),
      providerId,
    };
    // Only on success: a refusal leaves the dialog open with what was typed
    // still in it.
    if (editing === undefined) create.mutate(input, { onSuccess: onClose });
    else update.mutate({ ...input, id: editing.id }, { onSuccess: onClose });
  }

  const failure = create.isError ? create.error : update.isError ? update.error : null;

  return (
    <>
      {kind === null ? (
        <>
          <DialogDescription>
            Where does this model run? Creating a connection downloads nothing.
          </DialogDescription>
          <div className="flex flex-col gap-2" data-testid="choose-type">
            <Button
              variant="secondary"
              data-testid="choose-local"
              onClick={() => setKind("local")}
            >
              Local — weights this machine runs
            </Button>
            <Button variant="secondary" data-testid="choose-http" onClick={() => setKind("http")}>
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
              The offered list is the *local* form's, and only its. An offer is
              a checkpoint an installed driver can load on this machine and
              would download; an HTTP connection names whatever the endpoint on
              the other end runs, which this build never loads and cannot vouch
              for. Offering the same list there would be recommending models
              for somebody else's server.
            */}
            {local ? (
              <>
                <div className="flex flex-col gap-1.5">
                  {/*
                    `htmlFor` only where the control it names exists: three of
                    the four states below have no form control at all, and a
                    label pointing at an id nothing carries is worse than a
                    label pointing at nothing.
                  */}
                  <Label htmlFor={offering ? "connection-model" : undefined}>Model</Label>
                  {catalog.isPending ? (
                    // Principle 9: a disabled grey select is a question the
                    // interface refuses to answer. This says what is happening
                    // and leaves the space the list will occupy.
                    <div data-testid="catalog-loading">
                      {/*
                        The skeleton is silent. `LoadingState`'s label is
                        `sr-only`, and the sentence under it is text a screen
                        reader already reads — labelled, the same sentence would
                        be announced twice.
                      */}
                      <LoadingState rows={1} label="" />
                      <FieldHint>Reading which models this installation can run…</FieldHint>
                    </div>
                  ) : catalog.isError ? (
                    <div data-testid="catalog-unavailable">
                      <ErrorState
                        className="mb-1"
                        code={asApiError(catalog.error).code}
                        message={refusalProse(catalog.error)}
                        onRetry={() => void catalog.refetch()}
                      />
                    </div>
                  ) : groups.length === 0 ? (
                    <FieldHint data-testid="catalog-empty">
                      No installed driver offers a model by name. Install a provider
                      distribution to be offered one, or name a model below and pin its
                      revision yourself.
                    </FieldHint>
                  ) : (
                    <>
                      <Select value={choice} onValueChange={pickModel}>
                        <SelectTrigger id="connection-model" data-testid="connection-model">
                          <SelectValue placeholder="Choose a model" />
                        </SelectTrigger>
                        <SelectContent>
                          {groups.map((group) => (
                            <SelectGroup key={group.key}>
                              <SelectLabel>{group.label}</SelectLabel>
                              {/*
                                Two lines: the id is what identifies the
                                checkpoint and the rest is what it is for. On
                                one line it is a sentence long enough to wrap
                                inside the trigger, and a wrapped identifier is
                                harder to read than a stacked one.
                              */}
                              {group.entries.map((entry) => (
                                <SelectItem
                                  key={entry.model_id}
                                  value={entry.model_id}
                                  meta={entry.hint}
                                >
                                  {entry.model_id}
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
                          : "Pinned to the revision the driver that offers it declares."}
                      </FieldHint>
                    </>
                  )}
                </div>
                {/*
                  Whenever there is nothing to offer — the catalog refused, or
                  it answered and named nothing — the seeding effect lands
                  `choice` on the sentinel, so this reads that one decision
                  rather than working the same fact out a second time. A model
                  id needs no catalog, and creating a connection downloads
                  nothing, so a listing that failed is not a reason to prevent
                  one being configured.
                */}
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
                <AccessLine entries={entries} modelId={modelId.trim()} />
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
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="connection-credential-env">Credential variable</Label>
                  <Input
                    id="connection-credential-env"
                    data-testid="connection-credential-env"
                    value={credentialEnv}
                    onChange={(event) => setCredentialEnv(event.target.value)}
                  />
                  <FieldHint>
                    The name of an environment variable, not the secret itself. VisionSet reads
                    it where the server runs, sends it as a bearer token, and never stores the
                    value. Leave empty if the endpoint wants none.
                  </FieldHint>
                </div>
              </>
            )}
            {failure !== null && (
              <FieldError data-testid="connection-error">{refusalProse(failure)}</FieldError>
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
    </>
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
 * **Looked up by model id alone, and deliberately not through
 * {@link entryFor}.** That helper answers "is this row showing exactly this
 * offered entry", which compares the revision too — the right question for the
 * select, and the wrong one here. An access gate belongs to the *repository*:
 * pinning some other commit of the same model does not exempt anybody from its
 * terms, so a line that disappeared when the revision was edited would be hiding
 * a requirement that still applies.
 *
 * A model id no installed driver offers gets nothing here, and that is honest
 * rather than a gap — whether an arbitrary repository is gated is not something
 * this build knows before asking, and the refusal is what answers it.
 */
function AccessLine({
  entries,
  modelId,
}: {
  readonly entries: readonly CuratedEntry[];
  readonly modelId: string;
}): JSX.Element {
  const access = accessFor(entries, modelId);
  if (access === undefined) return <></>;
  return (
    <p className="text-xs text-muted-foreground" data-testid="model-access">
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
 * wrote it** — `LOCAL_INFERENCE_UNAVAILABLE` is one of the seven codes
 * `server/errors.py` marks `expose_message`, opting out of the opaque body
 * precisely so the install command reaches a person, and a sentence written
 * here would throw it away.
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
      <p className="text-xs text-muted-foreground" data-testid="size-checking">
        Reading the download size…
      </p>
    );
  }
  if (size.isError) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="size-unavailable">
        {refusalProse(size.error)}
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground" data-testid="size-known">
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
 * **One helper, and every size on this screen goes through it** — the form's line
 * before a confirm, and both halves of a transfer in flight. `DESIGN.md`'s
 * Numbers rule states the reason: `1.2 GB` and `1,2 GB` on one screen is exactly
 * how a call-site decision goes wrong.
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
            {refusalProse(remove.error)}
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
