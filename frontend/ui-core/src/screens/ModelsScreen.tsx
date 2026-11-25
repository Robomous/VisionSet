/**
 * The Models page: where model connections are made, set up and removed.
 *
 * A top-level destination rather than a project tab: a connection carries no
 * project id, every project uses the same ones, and navigation maps 1:1 to domain
 * objects — so a project tab would state a scope the object does not have.
 * `docs/content/ui/navigation.md` carries the rail's membership. Named for
 * the noun it catalogues —
 * the models a workspace can run — rather than for one use of them, because the
 * same list serves the suggest tool, pre-labeling and whatever asks next.
 *
 * ## One row per connection, narrowed by dropdowns
 *
 * The screen is a full-bleed table (`ListPage`), one row per connection, and a
 * row says what its model does as quiet labels — *Suggests from clicks*, *Finds
 * what you name*, *writes boxes or polygons* — rather than sitting under a
 * heading per ability. A connection serving two abilities is one row, not two;
 * the per-connection facts the wire already carries — the weights, what it
 * writes, the device, the precision, the endpoint's host — each have a column.
 * Where the weights come from is no column of its own: it is the origin's logo
 * at the start of the weights id (`OriginLogo`), because it is a fact about the
 * weights, and the face in front of `facebook/sam3` is read before the id is.
 *
 * Narrowing is a row of dropdowns in the toolbar, one per dimension the workspace
 * varies on — origin, ability, where it runs, state — combined so a row is shown only
 * while it answers every choice; `modelFilters.ts` derives which dropdowns are
 * on screen and what each offers from the listing itself, and `modelCopy.ts`
 * says how every value reads, in the row and in the filter alike. What a row
 * may be *asked to do* is still `allowed_actions` and nothing else, which is a
 * different field answering a different question.
 *
 * A table, like every workspace list: the facts are the same shape on every
 * connection, so they read best down a column.
 *
 * ## A row is read; its sheet is where it is managed
 *
 * The row is the connection's facts, one per column, and its state: the word,
 * or — while a download or a check runs — the run itself, its name, amounts
 * and bar, at the State column's width, so a run starting or ending moves
 * nothing else in the grid. A run that failed adds a short note beside the
 * word (*Download failed*), and nothing more: the row never grows a line.
 *
 * Pressing a row opens its **sheet** over the page (`ModelSheet.tsx`: from the
 * right, resizable, J/K walking the rows the filter leaves): everything the row
 * truncates, said in full — the weights and revision, where it runs, every
 * ability — and every action the connection declares as an icon button whose
 * tooltip says what it does: Download weights with what it would cost, its
 * progress and its failure with the retry, the two checks over a set-up
 * model's files, Test endpoint and its answer, Edit and Delete. One place to
 * manage a model, rather than a button in the row, a menu beside it and a
 * detail line under it.
 *
 * What the list adds up to — how many of the models shown are ready — is said
 * in the workbench's status bar (`PageStatus`). Which models are on screen, of
 * how many, is said by the footer the list is paged from (`TableFooter`, 25 to
 * a page). Neither is said on the page.
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
 * test call and its result — `test_endpoint`, in the model's sheet — never to a
 * stored row that would start lying the moment the network moved.
 *
 * ## The form is its own module
 *
 * *New model* and *Edit* open one dialog, `ConnectionDialog.tsx`: the catalog
 * the installation serves, the kind, the device and precision, and what a
 * download would cost before anything is fetched. What it offers and what it
 * refuses to compute is said there.
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
 * because the row it was going to show says so anyway.
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
 */

import { Box, ChevronRight, CircleDashed, Cpu, Package, Plus, Sparkles, X } from "lucide-react";
import { useRef, useState, type JSX } from "react";

import { Async } from "../data/Async";
import { isLive, useConnections, useDeleteConnection, type Connection } from "../data/inferenceQueries";
import { refusalProse } from "../data/refusals";
import { cn, Badge, Button, SearchInput, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Label, FieldError, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@robomous/ui-core";
import { BODY_ROW, ColumnHeader, ListGrid, ListPage, type ListColumn } from "../patterns/ListPage";
import { PageStatus } from "../patterns/PageStatus";
import { usePagination } from "../patterns/pagination";
import { clickedRowId, walkRowButtons } from "../patterns/rowDelegation";
import { TableFooter } from "../patterns/TablePager";
import { formatCount } from "../lib/format";
import {
  DIMENSION,
  NO_FILTERS,
  activeFilters,
  anyFilter,
  applyFilters,
  filterOptions,
  offeredDimensions,
  type Dimension,
  type FilterOption,
  type ModelFilters,
} from "./modelFilters";
import { abilityLabels, sourceLine } from "./modelCopy";
import { OriginLogo } from "./OriginLogo";
import { ConnectionDialog } from "./ConnectionDialog";
import { ModelSheet } from "./ModelSheet";
import { DownloadProgress, IntegrityProgress, StateBadge } from "./modelRuns";
/** Above this many rows a list carries a filter input (`docs/content/ui/product-principles.md`). */
const FILTER_ABOVE = 20;

/**
 * The grid's columns. The model's name takes what the others leave. State is
 * wide enough for a run's amounts — `1.2 GB of 1.6 GB · 75%` — beside the
 * run's name; the last column is the row's "opens the sheet" chevron. The grid's floor
 * keeps 12rem for the name: on a narrow window the grid scrolls sideways
 * rather than crushing it to a letter. Weights is a little wider than the id
 * alone needs, for the origin's logo in front of it.
 */
const COLUMNS: readonly ListColumn[] = [
  { key: "model" },
  { key: "weights", width: "w-[18rem]" },
  { key: "does", width: "w-[18rem]" },
  { key: "runs", width: "w-40" },
  { key: "state", width: "w-72" },
  { key: "open", width: "w-12" },
];

export function ModelsScreen(): JSX.Element {
  const connections = useConnections();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [doomed, setDoomed] = useState<Connection | null>(null);
  // The connection whose sheet is open, by id — so the sheet reads the live
  // row on every poll. The sheet keeps what it showed while it slides out.
  const [inspected, setInspected] = useState<string | null>(null);
  const [needle, setNeedle] = useState("");
  // One value per dimension, or `null` for All — values rather than indices, so
  // a choice the workspace stops declaring (an endpoint re-asked, a model moved)
  // does not point at its neighbour. What happens to such a choice is decided
  // below, off the options the list actually offers.
  const [chosen, setChosen] = useState<ModelFilters>(NO_FILTERS);

  const items = connections.data?.items ?? [];
  const options = filterOptions(items);
  const dimensions = offeredDimensions(options);
  const active = activeFilters(options, chosen);
  const narrowed = anyFilter(active);
  const shown = matching(applyFilters(items, active), needle);
  // The same pager as every full-page table; a filter starts it over.
  const paging = usePagination(shown, { pageSize: 25, resetKey: `${needle.trim()}|${JSON.stringify(active)}` });
  const frame = useRef<HTMLDivElement>(null);
  const pick = (dimension: Dimension) => (value: string) =>
    setChosen((current) => ({ ...current, [dimension]: value === ALL ? null : value }));
  const current = inspected === null ? undefined : items.find((connection) => connection.id === inspected);
  const filtersShown = connections.isSuccess && (dimensions.length > 0 || items.length > FILTER_ABOVE);
  // J/K walk the models the filter leaves, in the list's order, across its pages.
  const at = current === undefined ? -1 : shown.findIndex((connection) => connection.id === current.id);
  function step(by: 1 | -1): void {
    const next = shown[at + by];
    if (next !== undefined) setInspected(next.id);
  }

  return (
    <ListPage
      testId="models-screen"
      icon={Cpu}
      title="Models"
      toolbar={
        <>
          {filtersShown && (
            // Beside New, at the end of the bar: what shapes the list sits next
            // to what adds to it. Right-aligned, so Clear arriving at the group's
            // start moves nothing the pointer is on.
            <div role="group" aria-label="Show models by" className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2" data-testid="model-filters">
              {narrowed && (
                <Button variant="ghost" size="sm" data-testid="clear-filters" onClick={() => setChosen(NO_FILTERS)}>
                  <X aria-hidden="true" />
                  Clear
                </Button>
              )}
              {items.length > FILTER_ABOVE && (
                <SearchInput
                  value={needle}
                  onValueChange={setNeedle}
                  placeholder="Filter by name"
                  aria-label="Filter connections"
                  data-testid="connection-filter"
                  className="w-56 max-w-full"
                />
              )}
              {dimensions.map((dimension) => (
                <FilterSelect
                  key={dimension}
                  id={`filter-${dimension}`}
                  label={DIMENSION[dimension].label}
                  options={options[dimension]}
                  value={active[dimension]}
                  onChange={pick(dimension)}
                />
              ))}
            </div>
          )}
          {/* The page's one action, at the end of the bar, right after the filters —
              there even before there are models to filter, since it is how the
              first one is made. "New" on the page that names the noun; its full
              name for whoever cannot see the page's title. */}
          <Button size="sm" aria-label="New model" data-testid="new-connection" onClick={() => setCreating(true)} className={cn(!filtersShown && "ml-auto")}>
            <Plus aria-hidden="true" />
            New
          </Button>
        </>
      }
    >
      {/* The list, the whole width: the open model is a sheet over it (`ModelSheet`). */}
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1",
          // Fits the window below the header band and the toolbar's, so the list scrolls inside its frame.
          "lg:h-[calc(100dvh-var(--page-inset-top,0px)-var(--page-inset-bottom,0px)-3rem-49px)]",
          "lg:min-h-[24rem]",
        )}
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {connections.isSuccess && items.length > 0 && <ModelsStatus shown={shown} />}
          <Async
            query={connections}
            loadingRows={3}
            empty={{
              art: "models",
              title: "Connect a model to enable auto-labeling",
              // No button of its own: the header's "New" is on screen and
              // opens the same dialog. One way to add a model.
              description:
                "VisionSet never downloads models on its own — you choose what runs and where. Start with New.",
            }}
          >
            {() => (
              <>
                {/* A wrapper that only catches the rows' bubbled clicks and arrows:
                    the interactive things are the rows' own name buttons, so it
                    carries no semantics of its own. */}
                <div
                  className="flex min-h-0 flex-1 flex-col"
                  role="presentation"
                  onKeyDown={walkRowButtons}
                  onClick={(event) => {
                    const id = clickedRowId(event);
                    if (id !== null) setInspected(id);
                  }}
                >
                  <ListGrid
                    columns={COLUMNS}
                    minWidth="min-w-[1264px]"
                    label="Models"
                    testId="models-grid"
                    frameRef={frame}
                    head={
                      <>
                        <ColumnHeader icon={Box} label="Model" />
                        <ColumnHeader icon={Package} label="Weights" />
                        <ColumnHeader icon={Sparkles} label="What it does" />
                        <ColumnHeader icon={Cpu} label="Runs on" />
                        <ColumnHeader icon={CircleDashed} label="State" />
                        <ColumnHeader label="Details" hidden />
                      </>
                    }
                  >
                    <tbody>
                    {paging.slice.map((connection) => (
                      <ConnectionRow
                        key={connection.id}
                        connection={connection}
                        onOpen={() => setInspected(connection.id)}
                      />
                    ))}
                    {shown.length === 0 && (
                        <tr className={BODY_ROW}>
                          {/* What somebody narrowed to is a fact about the filter and never
                              an occasion to invite anything: every choice on offer is one
                              some row answers, so an empty result is the combination. */}
                          <td colSpan={COLUMNS.length} className="h-24 text-center text-muted-foreground" data-testid="filtered-out">
                            Nothing here matches the filter.
                          </td>
                        </tr>
                    )}
                    </tbody>
                  </ListGrid>
                </div>
                {/* Under the table, outside the rows' delegating wrapper. */}
                <TableFooter pagination={paging} frameRef={frame} noun="model" unfiltered={items.length} />
              </>
            )}
          </Async>

        </div>
      </div>
      <ModelSheet
        connection={current}
        position={{ at: Math.max(0, at), count: shown.length }}
        onStep={step}
        onClose={() => setInspected(null)}
        onEdit={setEditing}
        onDelete={setDoomed}
      />
      <ConnectionDialog open={creating} onClose={() => setCreating(false)} />
      <ConnectionDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        {...(editing === null ? {} : { editing })}
      />
      <DeleteConnectionDialog connection={doomed} onClose={() => setDoomed(null)} />
    </ListPage>
  );
}

/** Case-insensitive name substring, the shape every filter in this product has. */
function matching(rows: readonly Connection[], needle: string): readonly Connection[] {
  const wanted = needle.trim().toLowerCase();
  if (wanted === "") return rows;
  return rows.filter((row) => row.name.toLowerCase().includes(wanted));
}

/** The value a dropdown shows for All — never a value the wire could carry. */
const ALL = "__all__";

/**
 * One filter dropdown, as a pill in the toolbar: its dimension's name, then the
 * value it is set to — `Ability  All` — so what each is set to is read without
 * opening it. A real labelled `Select` rather than a row of toggles, because
 * four dimensions combine; a value this build cannot name is offered raw,
 * marked `data-known`.
 */
function FilterSelect({
  id,
  label,
  options,
  value,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly options: readonly FilterOption[];
  readonly value: string | null;
  readonly onChange: (value: string) => void;
}): JSX.Element {
  return (
    <>
      <Label htmlFor={id} className="sr-only">
        {label}
      </Label>
      <Select value={value ?? ALL} onValueChange={onChange}>
        <SelectTrigger
          id={id}
          size="sm"
          data-testid={id}
          data-chosen={value !== null || undefined}
          className="w-auto gap-1.5 font-normal data-[chosen]:border-foreground/30"
        >
          <span aria-hidden="true" className="text-muted-foreground">
            {label}
          </span>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL} data-testid={`${id}-all`}>
            All
          </SelectItem>
          {options.map((option) => (
            <SelectItem
              key={option.key}
              value={option.key}
              data-testid={`${id}-${option.key}`}
              data-known={option.known}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}


/**
 * What the list on screen adds up to, in the workbench's status bar — said
 * there and not on the page (`PageStatus`): how many of the models the filter
 * leaves are ready, and how many still need setting up. Every figure is over
 * every model the filter leaves, not the page of them on screen. How many
 * models there are, and of how many while a filter narrows them (never hiding
 * what it left out, `docs/content/ui/product-principles.md`), is the footer's
 * to say (`TableFooter`): said once.
 */
function ModelsStatus({ shown }: { readonly shown: readonly Connection[] }): JSX.Element {
  const ready = shown.filter((connection) => connection.setup_state === "ready").length;
  const waiting = shown.length - ready;
  return (
    <PageStatus>
      {shown.length > 0 && <span data-testid="models-ready">{formatCount(ready)} ready</span>}
      {waiting > 0 && (
        <span data-testid="models-waiting" className="text-foreground">
          {formatCount(waiting)} not set up
        </span>
      )}
    </PageStatus>
  );
}

/**
 * The note a failed run leaves beside the state's word, until a retry replaces
 * the record. The sheet carries the sentence and the retry; the row only says
 * there is something to read there. At `Ready` a failed download was the
 * missing-files check, so both kinds read as a check.
 */
function failureNote(connection: Connection): string | null {
  if (connection.download?.state === "failed") return connection.setup_state === "ready" ? "Check failed" : "Download failed";
  if (connection.integrity_check?.state === "failed") return "Check failed";
  return null;
}

/**
 * One connection, as a row of the grid: the facts in the order a person scans
 * them — name, weights, origin, what it does, where it runs — then its state,
 * and a chevron that says the row opens.
 *
 * The State cell is the word, or the run in flight in its place, read off the
 * wire — so a page that arrived mid-transfer shows it on its first fetch, the
 * whole point of the download living on the connection. Same width either
 * way, so nothing beside it moves.
 *
 * The whole row opens the sheet for a pointer — the table body takes that click
 * (`clickedRowId`) — and the name is the row's one real control for a keyboard and a
 * screen reader, so each model is heard once.
 *
 * Exported for the row tests, which render one inside a `<table>`.
 */
export function ConnectionRow({
  connection,
  onOpen,
}: {
  readonly connection: Connection;
  readonly onOpen: () => void;
}): JSX.Element {
  const ready = connection.setup_state === "ready";
  const download = connection.download ?? null;
  const check = connection.integrity_check ?? null;
  const abilities = abilityLabels(connection);
  const note = failureNote(connection);
  return (
    <tr
      data-testid={`connection-${connection.name}`}
      data-origin={connection.origin}
      data-row-id={connection.id}
      // No transition on the hover fill: the pointer sweeps this list.
      className={cn(BODY_ROW, "group cursor-pointer hover:bg-muted/40")}
    >
      <td>
        <button
          type="button"
          id={`model-open-${connection.id}`}
          data-testid={`open-${connection.name}`}
          title={connection.name}
          data-row-open={connection.id}
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
          className="block max-w-full truncate rounded-sm text-left font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {connection.name}
        </button>
      </td>
      <td>
        {/* Where the weights come from, then the weights — one line, the way
            a person reads them; the CLI's listing agrees. The logo never
            shrinks; the revision is the part to give up when the column is
            short, and the sheet has both whole. */}
        <span className="flex min-w-0 items-center gap-2">
          <OriginLogo origin={connection.origin} className="size-3.5" testId="connection-origin" />
          <span className="min-w-0 truncate font-mono text-xs" title={`${connection.model_id} @ ${connection.model_revision}`} data-testid="model-reference">
            {connection.model_id}
            <span className="text-muted-foreground">
              {" @ "}
              {connection.model_revision}
            </span>
          </span>
        </span>
      </td>
      <td>
        {abilities.length > 0 ? (
          // What it does and what it writes, as quiet labels: boxed so the eye
          // finds them, colourless so nothing competes with the state. One
          // line, clipped by a fade rather than a hard edge, so a label cut
          // short reads as "more this way" — the sheet lists them all.
          <ul className="flex min-w-0 gap-1.5 overflow-hidden [mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)]" aria-label="What it does" title={abilities.join(" · ")} data-testid="connection-abilities">
            {abilities.map((label) => (
              <li key={label} className="shrink-0">
                <Badge variant="quiet" data-testid="ability-label">
                  {label}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td>
        <span className="block truncate text-xs text-muted-foreground" data-testid="connection-source">
          {sourceLine(connection)}
        </span>
      </td>
      <td data-testid="connection-setup">
        {isLive(download) && download !== null ? (
          <DownloadProgress download={download} ready={ready} />
        ) : isLive(check) && check !== null ? (
          <IntegrityProgress check={check} />
        ) : (
          <span className="flex min-w-0 items-center gap-2">
            <StateBadge connection={connection} />
            {note !== null && (
              <span className="truncate text-xs text-destructive" data-testid="connection-failed-note">
                {note}
              </span>
            )}
          </span>
        )}
      </td>
      <td className="text-right">
        <ChevronRight aria-hidden="true" className="ml-auto size-4 text-muted-foreground/60 group-hover:text-foreground" />
      </td>
    </tr>
  );
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
          <Button variant="outline" onClick={onClose}>
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
