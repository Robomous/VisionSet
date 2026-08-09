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
 * ## The size is asked for before the connection exists
 *
 * D1 on #424 requires the local form to show what a download would cost *before*
 * somebody confirms. That is a query the form makes about a published revision,
 * not something the create response could carry — by the time a connection exists
 * the decision has already been taken. The same query is what surfaces a missing
 * local runtime, which is why the form stays usable and shows the install command
 * instead of disabling itself.
 */

import { Download, Filter, MoreHorizontal, Pencil, Plug, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent, type JSX } from "react";

import { Async } from "../data/Async";
import { asApiError } from "../data/errors";
import {
  useConnections,
  useCreateConnection,
  useDeleteConnection,
  useDownloadSize,
  useDownloadWeights,
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../primitives/Table";
import { useBackgroundJob } from "./queries";

/**
 * The model D1 suggests, and the revision it is pinned at.
 *
 * "Suggested default" means exactly that: it fills the form in, and anybody may
 * type over it. Nothing is bundled and nothing is fetched until somebody presses
 * the action that fetches it.
 */
export const SUGGESTED_MODEL = "facebook/sam2-hiera-base-plus";
export const SUGGESTED_REVISION = "main";

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
        <div className="flex items-center justify-end gap-2">
          {can.has("download_weights") && <DownloadWeights connection={connection} />}
          {(can.has("update") || can.has("delete")) && (
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
      </TableCell>
    </TableRow>
  );
}

/**
 * The `download_weights` action, and the job it launches.
 *
 * 202 and poll, the contract the export route uses: the button hands off to
 * `useBackgroundJob` and reports the phase the job is in. A failed run leaves the
 * connection exactly as it was — the state flip is the download's last statement
 * — so there is nothing to undo and the button simply comes back.
 */
function DownloadWeights({ connection }: { readonly connection: Connection }): JSX.Element {
  const download = useDownloadWeights();
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useBackgroundJob(jobId);
  const state = job.data?.state;
  const running = download.isPending || state === "queued" || state === "running";

  // Stop polling once the work settles, and let the invalidated list carry the
  // outcome — the row itself is what says `Ready`, so a second announcement here
  // would be the same fact twice.
  useEffect(() => {
    if (state === "succeeded" || state === "cancelled") setJobId(null);
  }, [state]);

  const failure = download.isError
    ? asApiError(download.error)
    : state === "failed"
      ? { code: "DOWNLOAD_FAILED", message: job.data?.error ?? "The download did not finish." }
      : null;

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="secondary"
        size="sm"
        data-testid="download-weights"
        disabled={running}
        onClick={() => download.mutate(connection.id, { onSuccess: (queued) => setJobId(queued.id) })}
      >
        <Download className="size-4" aria-hidden="true" />
        {running ? "Downloading…" : "Download weights"}
      </Button>
      {running && job.data !== undefined && (
        <span className="text-meta text-muted-foreground" data-testid="download-progress">
          {job.data.processed}
          {job.data.total === null ? "" : ` of ${job.data.total}`}
        </span>
      )}
      {failure !== null && (
        <FieldError data-testid="download-error">
          <Badge variant="destructive">{failure.code}</Badge> {failure.message}
        </FieldError>
      )}
    </div>
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
  const [device, setDevice] = useState("");
  const [precision, setPrecision] = useState("");
  const [endpoint, setEndpoint] = useState("");

  // Fill the form from whatever the dialog was opened for. An edit arrives with a
  // row; a create arrives with nothing and, once a local kind is chosen, with
  // D1's suggestion already in it.
  useEffect(() => {
    if (!open) return;
    if (editing !== undefined) {
      setKind(editing.connection_type);
      setName(editing.name);
      setModelId(editing.model_id);
      setRevision(editing.model_revision);
      setDevice(editing.device ?? "");
      setPrecision(editing.precision ?? "");
      setEndpoint(editing.endpoint_url ?? "");
      return;
    }
    setKind(null);
    setName("");
    setModelId("");
    setRevision("");
    setDevice("cpu");
    setPrecision("fp16");
    setEndpoint("");
  }, [open, editing]);

  function choose(next: ConnectionType): void {
    setKind(next);
    if (next === "local") {
      setModelId(SUGGESTED_MODEL);
      setRevision(SUGGESTED_REVISION);
    }
  }

  const local = kind === "local";
  const pending = create.isPending || update.isPending;
  const complete =
    name.trim() !== "" &&
    modelId.trim() !== "" &&
    revision.trim() !== "" &&
    (local ? device.trim() !== "" && precision.trim() !== "" : endpoint.trim() !== "");

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (kind === null) return;
    const input = {
      name: name.trim(),
      connectionType: kind,
      modelId: modelId.trim(),
      modelRevision: revision.trim(),
      device: device.trim(),
      precision: precision.trim(),
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
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="connection-model">Model</Label>
                <Input
                  id="connection-model"
                  data-testid="connection-model"
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
              {local ? (
                <>
                  <div className="flex gap-3">
                    <div className="flex flex-1 flex-col gap-1.5">
                      <Label htmlFor="connection-device">Device</Label>
                      <Input
                        id="connection-device"
                        data-testid="connection-device"
                        value={device}
                        onChange={(event) => setDevice(event.target.value)}
                      />
                    </div>
                    <div className="flex flex-1 flex-col gap-1.5">
                      <Label htmlFor="connection-precision">Precision</Label>
                      <Input
                        id="connection-precision"
                        data-testid="connection-precision"
                        value={precision}
                        onChange={(event) => setPrecision(event.target.value)}
                      />
                    </div>
                  </div>
                  <DownloadSizeLine modelId={modelId.trim()} revision={revision.trim()} />
                </>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="connection-endpoint">Endpoint URL</Label>
                  <Input
                    id="connection-endpoint"
                    data-testid="connection-endpoint"
                    value={endpoint}
                    onChange={(event) => setEndpoint(event.target.value)}
                  />
                </div>
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
