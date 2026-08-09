/**
 * The Inference section: where model connections are made, set up and removed.
 *
 * A top-level destination rather than a project tab, per the decision recorded on
 * #421 (2026-08-08): a connection carries no project id, every project uses the
 * same ones, and navigation maps 1:1 to domain objects — so a project tab would
 * state a scope the object does not have. That decision supersedes #58's rail
 * rule, and `DESIGN.md` carries the new membership.
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
 * ## The status column has two values, not three
 *
 * `#421`'s journey lists `Ready` / `Not set up` / `Unreachable`. The wire has two:
 * `setup_state` is deliberately **not** a reachability answer — whether an
 * endpoint responds has a fresh answer every time it is asked, so it belongs to a
 * test call and its result rather than to a stored row that would start lying the
 * moment the network moved. The test action ships with the HTTP endpoint contract
 * (`cf. #421`); until then there is no third value to render and no control that
 * would produce one.
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
 * ## One declared action, two things to call it
 *
 * `download_weights` is declared for a local connection in either state (#469).
 * Below `Ready` it is the row's **Download weights** button; at `Ready` it is
 * **Verify weights** in the overflow, where it re-checks that the snapshot is
 * still complete. The row picks the label from `setup_state` — a field the wire
 * states — and never from a table of its own.
 *
 * ## The size is asked for before the connection exists
 *
 * D1 on #424 requires the local form to show what a download would cost *before*
 * somebody confirms. That is a query the form makes about a published revision,
 * not something the create response could carry — by the time a connection exists
 * the decision has already been taken. The same query is what surfaces a missing
 * local runtime, which is why the form stays usable and shows the install command
 * instead of disabling itself.
 */

import { Download, Filter, MoreHorizontal, Pencil, Plug, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent, type JSX } from "react";

import { Async } from "../data/Async";
import { asApiError } from "../data/errors";
import {
  useConnections,
  useCreateConnection,
  useDeleteConnection,
  useDownloadSize,
  useDownloadWeights,
  useRefreshConnections,
  useUpdateConnection,
  type Connection,
  type ConnectionType,
} from "../data/inferenceQueries";
import { Badge } from "../primitives/Badge";
import { Button } from "../primitives/Button";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../primitives/Table";
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
import { useBackgroundJob } from "./queries";

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
          // view (#323).
          action: (
            <Button variant="secondary" onClick={() => setCreating(true)}>
              Add connection
            </Button>
          ),
        }}
      >
        {(page) => {
          const shown = matching(page.items, needle);
          return (
            <div className="flex flex-col gap-3">
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
              <Table data-testid="connections-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead className="w-24">Type</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead className="w-40">Status</TableHead>
                    <TableHead className="w-56" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((row) => (
                    <ConnectionRow
                      key={row.id}
                      connection={row}
                      onEdit={() => setEditing(row)}
                      onDelete={() => setDoomed(row)}
                    />
                  ))}
                </TableBody>
              </Table>
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
  const weights = useWeightsRun(connection);
  return (
    <TableRow data-testid={`connection-${connection.name}`}>
      <TableCell className="font-medium">{connection.name}</TableCell>
      <TableCell>
        <Badge data-testid="connection-type">
          {connection.connection_type === "local" ? "Local" : "HTTP"}
        </Badge>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {/* One column, the way a person reads them — the CLI's listing agrees. */}
        {connection.model_id} @ {connection.model_revision}
      </TableCell>
      <TableCell>
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
      </TableCell>
      <TableCell className="text-right">
        <div className="flex flex-col items-end gap-1">
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
            {(can.has("update") || can.has("delete") || (can.has("download_weights") && ready)) && (
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
                  {can.has("download_weights") && ready && (
                    <DropdownMenuItem
                      data-testid="action-verify-weights"
                      disabled={weights.running}
                      onSelect={weights.start}
                    >
                      <ShieldCheck className="size-4" aria-hidden="true" />
                      {weights.running ? "Checking…" : "Verify weights"}
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
          {weights.running && weights.progress !== null && (
            <span className="text-meta text-muted-foreground" data-testid="download-progress">
              {weights.progress}
            </span>
          )}
          {weights.failure !== null && (
            <FieldError data-testid="download-error">
              <Badge variant="destructive">{weights.failure.code}</Badge> {weights.failure.message}{" "}
              {ready
                ? "The connection is still Ready — nothing was changed. Verify weights again to re-check the cache."
                : "The connection is still Not set up: weights arrive or they do not, so there is nothing half-installed to clear up. Download weights again — an interrupted transfer resumes from what it had."}
            </FieldError>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * The `download_weights` action, wherever the row renders it, and the job it runs.
 *
 * 202 and poll, the contract the export route uses. It lives on the *row* rather
 * than inside a control because one of the two controls is a menu item, and a
 * menu closes when it is chosen — a job whose progress and refusal lived inside
 * the item would take both with it on the way out.
 *
 * **The list is re-read when the job settles, and that is the fix for a bug**
 * (#469). What the `202` changed was the declaration; what the *completion*
 * changes is `setup_state` and, with it, the row's whole meaning. Nothing was
 * re-reading at that moment, so a finished download left `Not set up` on screen
 * until somebody reloaded the page. A settled job is a mutation like any other,
 * so it invalidates what it touched.
 */
function useWeightsRun(connection: Connection): {
  readonly start: () => void;
  readonly running: boolean;
  readonly progress: string | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
} {
  const download = useDownloadWeights();
  const refresh = useRefreshConnections();
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useBackgroundJob(jobId);
  const state = job.data?.state;
  const running = download.isPending || state === "queued" || state === "running";

  useEffect(() => {
    if (state !== "succeeded" && state !== "failed" && state !== "cancelled") return;
    refresh();
    // A failure keeps its job id, because the job is where the reason is; the
    // poll has already stopped on its own — `useBackgroundJob` settles — so this
    // holds a finished row, not an open request.
    if (state !== "failed") setJobId(null);
    // `refresh` is stable per render under the compiler and re-running this on a
    // list re-read would invalidate in a loop; the transition is what it watches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return {
    start: () =>
      download.mutate(connection.id, { onSuccess: (queued) => setJobId(queued.id) }),
    running,
    progress:
      job.data === undefined
        ? null
        : `${job.data.processed}${job.data.total === null ? "" : ` of ${job.data.total}`}`,
    failure: download.isError
      ? asApiError(download.error)
      : state === "failed"
        ? { code: "DOWNLOAD_FAILED", message: job.data?.error ?? "The download did not finish." }
        : null,
  };
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
                            {group.models.map((model) => (
                              <SelectItem key={model.modelId} value={model.modelId}>
                                {model.modelId} · {bytes(model.totalBytes)} · {model.hint}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        ))}
                        <SelectGroup>
                          <SelectItem value={CUSTOM_MODEL}>Custom model…</SelectItem>
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
 * Bytes as somebody reads them.
 *
 * Decimal units, because a download size is what a network moves and what a
 * publisher quotes; binary units would put a different number on screen from the
 * one the model's own page shows.
 */
export function bytes(count: number): string {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let value = count;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
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
