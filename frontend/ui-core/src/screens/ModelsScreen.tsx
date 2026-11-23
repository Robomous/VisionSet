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
 * the per-connection facts the wire already carries — the weights, where they
 * come from, what it writes, the device, the precision, the endpoint's host —
 * each have a column. The row's one colour is the mark beside its origin.
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
 * ## A row is read; its panel is where it is managed
 *
 * The row is the connection's facts, one per column, and its state: the word,
 * or — while a download or a check runs — the run itself, its name, amounts
 * and bar, at the State column's width, so a run starting or ending moves
 * nothing else in the grid. A run that failed adds a short note beside the
 * word (*Download failed*), and nothing more: the row never grows a line.
 *
 * Pressing a row opens its **panel**, at the right of the list (`DetailPane`:
 * resizable, in from the right edge; a sheet only below `lg`): everything the
 * row truncates, said in full — the weights and revision, where it runs, every ability — and every
 * action the connection declares, each with what it does: Download weights
 * with what it would cost, its progress and its failure with the retry,
 * the two checks over a set-up model's files, Test endpoint and its answer,
 * Edit and Delete. One place to manage a model, rather than a button in the
 * row, a menu beside it and a detail line under it.
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

import { Box, ChevronRight, CircleDashed, Cpu, Download, FileSearch, Globe, Package, Pencil, Plus, RadioTower, ShieldCheck, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type JSX, type ReactNode } from "react";

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
import { cn, Badge, Button, Progress, SearchInput, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Input, Label, FieldDescription, FieldError, Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@robomous/ui-core";
import { ErrorState, LoadingState } from "../patterns/AsyncStates";
import { DetailPane } from "../patterns/DetailPane";
import { BODY_ROW, ColumnHeader, ListGrid, ListPage, type ListColumn } from "../patterns/ListPage";
import { PageStatus } from "../patterns/PageStatus";
import { usePagination } from "../patterns/pagination";
import { clickedRowId, walkRowButtons } from "../patterns/rowDelegation";
import { TableFooter } from "../patterns/TablePager";
import { formatCount } from "../lib/format";
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
import { STATE_LABELS, abilityLabels, bytes, kindLabel, originLabel, originMark, sourceLine } from "./modelCopy";
/** Above this many rows a list carries a filter input (`docs/content/ui/product-principles.md`). */
const FILTER_ABOVE = 20;

/**
 * The grid's columns. The model's name takes what the others leave. State is
 * wide enough for a run's amounts — `1.2 GB of 1.6 GB · 75%` — beside the
 * run's name; the last column is the row's "opens the panel" chevron. The grid's floor
 * keeps 12rem for the name: beside an open panel the grid scrolls sideways
 * rather than crushing it to a letter.
 */
const COLUMNS: readonly ListColumn[] = [
  { key: "model" },
  { key: "weights", width: "w-[17rem]" },
  { key: "origin", width: "w-32" },
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
  // The connection whose detail is open, by id — so the panel reads the live
  // row on every poll. The panel keeps what it showed while it slides out.
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

  /** Shuts the panel and gives focus back to the row that opened it. */
  function closeDetail(): void {
    if (inspected !== null) document.getElementById(`model-open-${inspected}`)?.focus();
    setInspected(null);
  }

  // Escape closes the panel from anywhere on the page — a press on a row
  // leaves focus on the page, not in the panel. A dialog or a dropdown opened
  // over it has already taken its own Escape and said so (`defaultPrevented`),
  // so it closes first and the panel stays.
  useEffect(() => {
    if (inspected === null) return;
    function onKey(event: globalThis.KeyboardEvent): void {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      closeDetail();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  return (
    <ListPage
      testId="models-screen"
      icon={Cpu}
      title="Models"
      toolbar={
        <>
          {filtersShown && (
            <div role="group" aria-label="Show models by" className="flex min-w-0 flex-1 flex-wrap items-center gap-2" data-testid="model-filters">
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
              {narrowed && (
                <Button variant="ghost" size="sm" data-testid="clear-filters" onClick={() => setChosen(NO_FILTERS)}>
                  <X aria-hidden="true" />
                  Clear
                </Button>
              )}
            </div>
          )}
          {/* The page's one action, at the end of the bar that shapes the list —
              there even before there are models to filter, since it is how the
              first one is made. "New" on the page that names the noun; its full
              name for whoever cannot see the page's title. */}
          <Button size="sm" aria-label="New model" data-testid="new-connection" onClick={() => setCreating(true)} className="ml-auto">
            <Plus aria-hidden="true" />
            New
          </Button>
        </>
      }
    >
      {/* The list and, at its right, the open model: one row. Below `lg` the
          row is only the list, and the detail is a sheet (`DetailPane`). */}
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1",
          // Fits the window below the header band and the toolbar's, so the list scrolls inside its frame and the panel keeps its height.
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
                    minWidth="min-w-[1380px]"
                    label="Models"
                    testId="models-grid"
                    frameRef={frame}
                    head={
                      <>
                        <ColumnHeader icon={Box} label="Model" />
                        <ColumnHeader icon={Package} label="Weights" />
                        <ColumnHeader icon={Globe} label="Origin" />
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
        <DetailPane id="models" open={current !== undefined} label="Model" defaultWidth={440} testId="model-sheet" onClose={closeDetail}>
          {current !== undefined && (
            <ModelDetail
              key={current.id}
              connection={current}
              onClose={closeDetail}
              onEdit={() => setEditing(current)}
              onDelete={() => setDoomed(current)}
            />
          )}
        </DetailPane>
      </div>
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
 * A failure as a sentence, so the remedy after it starts a new one. A job's
 * error is often the worker's raw message — "Connection reset by peer" — with
 * no full stop of its own.
 */
function sentence(text: string): string {
  return /[.!?…]$/.test(text.trimEnd()) ? text : `${text.trimEnd()}.`;
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
        {/* One line, the way a person reads them — the CLI's listing agrees.
            The revision is the part to give up when the column is short; the
            sheet has both whole. */}
        <span className="block truncate font-mono text-xs" title={`${connection.model_id} @ ${connection.model_revision}`} data-testid="model-reference">
          {connection.model_id}
          <span className="text-muted-foreground">
            {" @ "}
            {connection.model_revision}
          </span>
        </span>
      </td>
      <td>
        <span className="flex min-w-0 items-center gap-2" data-testid="connection-origin">
          {/* The origin's one colour, as a mark beside its name. */}
          <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-[2px]", originMark(connection.origin))} />
          <span className="truncate text-xs">{originLabel(connection.origin)}</span>
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

/**
 * Semantic token **and** text, never colour alone: the word is what a screen
 * reader announces and what somebody who cannot tell the two desaturated chips
 * apart reads.
 */
function StateBadge({ connection }: { readonly connection: Connection }): JSX.Element {
  return (
    <Badge variant={connection.setup_state === "ready" ? "success" : "warning"} data-testid="connection-status" data-state={connection.setup_state}>
      {STATE_LABELS[connection.setup_state]}
    </Badge>
  );
}

/**
 * One model, in full, and everything that can be done to it — the panel at the
 * right of the list (`DetailPane`).
 *
 * Read off the live row — the screen passes the connection as the list last
 * fetched it — so a run started here, or anywhere else, is watched here too.
 * Keyed by the connection, so a request this panel made for one model is never
 * shown on another.
 *
 * A 48px header with the name and, quieter beside it, the weights; the body
 * scrolls — setup first, then the facts the row truncates, in one grid of
 * labels and values; Edit and Delete are pinned in the footer.
 */
function ModelDetail({
  connection,
  onClose,
  onEdit,
  onDelete,
}: {
  readonly connection: Connection;
  readonly onClose: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}): JSX.Element {
  const can = new Set(connection.allowed_actions);
  const ready = connection.setup_state === "ready";
  const local = connection.connection_type === "local";
  const abilities = abilityLabels(connection);
  const runsOn = [kindLabel(connection.connection_type), connection.device, connection.precision].filter((part) => part != null && part !== "").join(" · ");
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="model-detail">
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border/70 px-4 md:px-6">
        <span aria-hidden="true" className={cn("size-2.5 shrink-0 rounded-[3px]", originMark(connection.origin))} />
        <h2 className="min-w-0 shrink truncate text-sm font-semibold tracking-tight">{connection.name}</h2>
        {/* What the connection *is*: its weights, whole. Where they come from
            and where they run are rows below, so not said here as well. */}
        <span className="min-w-0 flex-[2] truncate font-mono text-xs text-muted-foreground" title={connection.model_id} data-testid="sheet-weights">
          {connection.model_id}
        </span>
        <Button variant="ghost" size="icon" className="-mr-2 ml-auto shrink-0" aria-label="Close the model" data-testid="model-close" onClick={onClose}>
          <X aria-hidden="true" className="size-4" strokeWidth={1.75} />
        </Button>
      </header>

      <div className="vs-scroll-fade-y min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
        <div className="flex flex-col gap-5">
          <SetupSection connection={connection} />

          <section aria-labelledby={`model-facts-${connection.id}`} className="flex flex-col gap-3">
            <h3 id={`model-facts-${connection.id}`} className="text-sm font-medium">
              Model
            </h3>
            <dl className="flex flex-col gap-2.5 text-sm">
              <Fact label="Revision" testId="sheet-revision">
                <span className="block font-mono text-xs break-all text-muted-foreground">{connection.model_revision}</span>
              </Fact>
              <Fact label="Origin">
                <span className="flex items-center gap-2">
                  <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-[2px]", originMark(connection.origin))} />
                  {originLabel(connection.origin)}
                </span>
              </Fact>
              {/* The kind, then whichever of device and precision it carries —
                  nothing drawn for one it does not. The endpoint gets its own row,
                  whole, where the grid's column could only hold its host. */}
              <Fact label="Runs on" testId="sheet-runs">
                {runsOn}
              </Fact>
              {connection.endpoint_url != null && connection.endpoint_url !== "" && (
                <Fact label="Endpoint">
                  <span className="block font-mono text-xs break-all">{connection.endpoint_url}</span>
                </Fact>
              )}
              <Fact label="What it does" testId="sheet-abilities">
                {abilities.length > 0 ? (
                  <ul className="flex flex-wrap gap-1.5" aria-label="What it does">
                    {abilities.map((label) => (
                      <li key={label}>
                        <Badge variant="quiet">{label}</Badge>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="block text-muted-foreground text-pretty">
                    {local && !ready ? "Known once the weights are here — a model's abilities are read from its own files." : "Nothing declared."}
                  </span>
                )}
              </Fact>
            </dl>
          </section>
        </div>
      </div>

      {(can.has("delete") || can.has("update")) && (
        <footer className="flex shrink-0 items-center border-t border-border/70 px-4 py-3 md:px-6">
          {can.has("delete") && (
            <Button variant="ghost" size="sm" className="-ml-2 text-destructive hover:text-destructive" data-testid="action-delete" onClick={onDelete}>
              <Trash2 aria-hidden="true" />
              Delete
            </Button>
          )}
          {can.has("update") && (
            <Button variant="outline" size="sm" className="ml-auto" data-testid="action-edit" onClick={onEdit}>
              <Pencil aria-hidden="true" />
              Edit
            </Button>
          )}
        </footer>
      )}
    </div>
  );
}

/**
 * One fact: its label in a fixed left column, its value in the right, so the
 * eye runs down one edge of labels and one of values. The label sits on the
 * value's first line.
 */
function Fact({ label, testId, children }: { readonly label: string; readonly testId?: string; readonly children: ReactNode }): JSX.Element {
  return (
    <div data-testid={testId} className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-x-3 tabular-nums">
      <dt className="truncate text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/**
 * Where a model is set up and kept honest: its state, the run in flight, what
 * went wrong and the retry, and every action the connection declares over its
 * files or its endpoint — each button beside the sentence that says what it
 * does.
 *
 * **Nothing here decides what is legal**: which buttons exist is
 * `allowed_actions` and nothing else; `setup_state` only picks the reading of a
 * declared download (Download weights below `Ready`, Check for missing files at
 * it), and a live run only disables what a second press would collide with.
 */
function SetupSection({ connection }: { readonly connection: Connection }): JSX.Element {
  const can = new Set(connection.allowed_actions);
  const ready = connection.setup_state === "ready";
  const weights = useDownloadRun(connection);
  const integrity = useIntegrityRun(connection);
  const probe = useTestEndpoint();
  // **One busy state for every control over this connection's files, not one per
  // kind.** All three act on a single cache, so while either run is in flight
  // the others have nothing to offer: a second request of the same kind is
  // answered with the run already going, and one of the other kind would put a
  // transfer and a full re-read over the same files at once. Whether a control
  // *exists* is still `allowed_actions`; this decides only whether it can be
  // pressed.
  const busy = weights.running || integrity.running;
  // Never a bare disabled control: the label says what is happening, in the
  // vocabulary this connection's setup state gives it.
  const busyLabel = weights.running ? (ready ? "Checking…" : "Downloading…") : "Reading every file…";
  const downloadable = can.has("download_weights") && !ready;
  const recheck = can.has("download_weights") && ready;
  // What a fetch would cost, asked only while a fetch is on offer — the same
  // read the form makes, keyed by the pair, so a pair already priced is not
  // priced again. Its refusal is where a missing local runtime shows.
  const size = useDownloadSize(connection.model_id, connection.model_revision, downloadable);
  const failed = weights.failure !== null || integrity.failure !== null;
  const any = downloadable || recheck || can.has("check_integrity") || can.has("test_endpoint");

  return (
    <section aria-labelledby={`model-setup-${connection.id}`} className="flex flex-col gap-3 border-b border-border/70 pb-5" data-testid="model-setup">
      <div className="flex items-center justify-between gap-3">
        <h3 id={`model-setup-${connection.id}`} className="text-sm font-medium">
          Setup
        </h3>
        <StateBadge connection={connection} />
      </div>

      {/* The run in flight, read off the wire — so a run started from a terminal
          or another tab shows here too. It runs on the server: closing the
          sheet or leaving the page neither cancels nor pauses it. */}
      {weights.live !== null || integrity.live !== null || busy ? (
        <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3">
          {weights.live !== null ? (
            <DownloadProgress download={weights.live} ready={ready} />
          ) : integrity.live !== null ? (
            <IntegrityProgress check={integrity.live} />
          ) : (
            <RunProgress testId="run-starting" title={busyLabel.replace("…", "")} label={busyLabel} percent={null}>
              Starting…
            </RunProgress>
          )}
          <p className="text-xs text-pretty text-muted-foreground">Runs on the server — closing this or leaving the page does not stop it.</p>
        </div>
      ) : null}

      {weights.failure !== null && (
        <FieldError data-testid="download-error">
          {sentence(weights.failure)}{" "}
          {ready
            ? "The connection is still Ready — nothing was changed. Check again to re-read the cache."
            : "Nothing is half-installed, so the connection is still Not set up. Retry the download to resume from what arrived."}
        </FieldError>
      )}
      {/*
        The one failure on this screen that has already acted. A check that
        found damage purged the bad files and stood the connection down before
        the job row said so, so the sentence describes a state the connection is
        *already* in — and the remedy it names is the button right under it.
      */}
      {integrity.failure !== null && (
        <FieldError data-testid="integrity-error">
          {sentence(integrity.failure)}{" "}
          {ready
            ? "Nothing was removed and the connection is still Ready — a check that cannot reach the model's source is not an answer about the files here."
            : "The damaged copies have been removed and the connection is back to Not set up. Download the weights again: with the bad files gone, it is a real transfer rather than a cache hit."}
        </FieldError>
      )}

      {/* What the actions below do, said before somebody presses one. */}
      {downloadable && !busy && (
        <p className="text-pretty text-muted-foreground" data-testid="connection-size">
          {size.isPending ? (
            <span data-testid="connection-size-checking">Reading the download size…</span>
          ) : size.isError ? (
            <span data-testid="connection-size-unavailable">{refusalProse(size.error)}</span>
          ) : (
            <span data-testid="connection-size-known">
              Downloads <span className="text-foreground tabular-nums">{bytes(size.data.total_bytes)}</span> across{" "}
              {formatCount(size.data.file_count)} files. Nothing is fetched until you ask.
            </span>
          )}
        </p>
      )}
      {ready && local(connection) && !busy && !failed && (
        <p className="text-pretty text-muted-foreground">
          The weights are on this machine. <span className="text-foreground">Check for missing files</span> re-reads the
          file list and fetches anything absent; <span className="text-foreground">Check files are undamaged</span> reads
          every byte and removes a damaged copy.
        </p>
      )}

      {any && (
        <div className="flex flex-wrap items-center gap-2">
          {downloadable && (
            <Button size="sm" data-testid="download-weights" disabled={busy} onClick={weights.start}>
              <Download aria-hidden="true" />
              {busy ? busyLabel : failed ? "Retry download" : "Download weights"}
            </Button>
          )}
          {/*
            Two checks over the same files, and each label says what its own
            check *proves* rather than what it is called. A download against a
            set-up connection reads an index and finds a file that is absent,
            and no amount of it will find a file that is present and wrong.
            `docs/content/inference.md` carries the same two sentences.
          */}
          {recheck && (
            <Button variant="outline" size="sm" data-testid="action-verify-weights" disabled={busy} onClick={weights.start}>
              <FileSearch aria-hidden="true" />
              {busy ? busyLabel : "Check for missing files"}
            </Button>
          )}
          {can.has("check_integrity") && (
            <Button variant="outline" size="sm" data-testid="action-check-integrity" disabled={busy} onClick={integrity.start}>
              <ShieldCheck aria-hidden="true" />
              {busy ? busyLabel : "Check files are undamaged"}
            </Button>
          )}
          {can.has("test_endpoint") && (
            <Button variant="outline" size="sm" data-testid="action-test-endpoint" disabled={probe.isPending} onClick={() => probe.mutate(connection.id)}>
              <RadioTower aria-hidden="true" />
              {probe.isPending ? "Asking the endpoint…" : "Test endpoint"}
            </Button>
          )}
        </div>
      )}

      {/* The endpoint's answer, under the button that asked. A fresh answer
          every time — reachability is never stored on the connection. */}
      {probe.isPending && <p className="text-xs text-muted-foreground" data-testid="test-endpoint-pending">Asking the endpoint…</p>}
      {probe.isSuccess && <p className="text-xs text-muted-foreground" data-testid="test-endpoint-ok">The endpoint answered.</p>}
      {probe.isError && <FieldError data-testid="test-endpoint-error">{refusalProse(probe.error)}</FieldError>}
    </section>
  );
}

function local(connection: Connection): boolean {
  return connection.connection_type === "local";
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
  title,
  label,
  phase,
  percent,
  children,
}: {
  readonly testId: string;
  /** The run's name, short enough to share a line with its amounts. */
  readonly title: string;
  /** The bar's accessible name: the run, said in full. */
  readonly label: string;
  readonly phase?: string;
  readonly percent: number | null;
  readonly children: string;
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid={testId}>
      <span className="flex min-w-0 items-baseline gap-2 text-xs">
        <span className="shrink-0 font-medium">{title}</span>
        {/*
          Tabular figures, `DESIGN.md`'s Numbers rule: the number changes every
          two seconds and the words around it must not move under a reader's eye.
          Right-aligned, so the percentage keeps one place down the column.
        */}
        <span className="ml-auto truncate text-muted-foreground tabular-nums" title={children} data-testid={`${testId}-prose`}>
          {children}
        </span>
      </span>
      {percent !== null ? (
        <Progress value={percent} aria-label={label} className="h-1" data-testid={`${testId}-bar`} data-phase={phase} />
      ) : (
        // The bar's room, kept: the line above stays put when the bar arrives.
        <span aria-hidden="true" className="h-1" />
      )}
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
function DownloadProgress({ download, ready }: { readonly download: WeightDownload; readonly ready: boolean }): JSX.Element {
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
      // At `Ready` a download reads an index for missing files; before setup it
      // is the transfer itself — the same two readings the controls use.
      title={ready ? "Checking" : "Downloading"}
      label={ready ? "Checking for missing files" : "Downloading weights"}
      phase={settling ? "settling" : state}
      percent={percent}
    >
      {state === "queued"
        ? "Queued for a worker"
        : settling
          ? "Checking what arrived…"
          : measurable
            ? `${bytes(done)} of ${bytes(total)} · ${percent}%`
            : `${bytes(done)} so far · size unknown`}
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
    <RunProgress testId="integrity-progress" title="Reading every file" label="Checking files are undamaged" phase={state} percent={percent}>
      {state === "queued"
        ? "Queued for a worker"
        : known
          ? `${read.toLocaleString()} of ${total.toLocaleString()} files · ${percent}%`
          : "Reading the file list…"}
    </RunProgress>
  );
}

/**
 * The model a set-up connection names, as the fact it now is.
 *
 * In the cell the select would occupy, so the form keeps its shape: once the
 * weights are here the connection *is* those weights, and a different model is
 * a new connection — which the hint says, in the place the choice used to be.
 */
function FixedModel({ connection }: { readonly connection: Connection }): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      {/* The primitive's look without a `<label>` pointing at no control. */}
      <Label asChild>
        <span>Model</span>
      </Label>
      <p className="font-mono text-sm break-all" data-testid="connection-model-fixed">
        {connection.model_id} @ {connection.model_revision}
      </p>
      <FieldDescription>
        Set up with these weights, so the model cannot change here. Add a new model to run a
        different one.
      </FieldDescription>
    </div>
  );
}

/**
 * One way a model can run, offered as a tile: an icon, a name and a sentence.
 *
 * A tile rather than a labelled button because the two kinds are a choice to
 * read before it is a choice to press — a `Button` keeps its label on one line,
 * and a sentence long enough to say what the kind means does not fit one. A
 * real `<button>`, with Nova's ring, so the keyboard reaches it like any control.
 */
function KindChoice({
  testId,
  icon,
  title,
  description,
  onChoose,
}: {
  readonly testId: string;
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly onChoose: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onChoose}
      className={cn(
        "flex items-start gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors outline-none",
        "hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
      )}
    >
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
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
      {/*
        Wider than the dialog's default, and wider than it is tall: the form
        below lays its two halves side by side — what the model is, and where
        it runs — so a person reads it as one shape rather than scrolling a
        column of fields.
      */}
      <DialogContent className="sm:max-w-2xl" data-testid="connection-dialog">
        <DialogTitle>{editing === undefined ? "New model" : `Edit ${editing.name}`}</DialogTitle>
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
  // Read off the declaration, never off the state: a set-up connection does
  // not declare `update_model`, so its model is shown as a fact and the fields
  // that would move it are not offered. The reference still travels with the
  // edit, unchanged, because a mention is not a move.
  const modelFixed = editing !== undefined && !editing.allowed_actions.includes("update_model");
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
          <div className="grid gap-3 sm:grid-cols-2" data-testid="choose-type">
            <KindChoice
              testId="choose-local"
              icon={<Cpu className="size-5" aria-hidden="true" />}
              title="Local"
              description="Weights this machine downloads and runs."
              onChoose={() => setKind("local")}
            />
            <KindChoice
              testId="choose-http"
              icon={<Globe className="size-5" aria-hidden="true" />}
              title="HTTP"
              description="An endpoint that answers this project's inference contract."
              onChoose={() => setKind("http")}
            />
          </div>
        </>
      ) : (
        <>
          <DialogDescription>
            {local
              ? "Nothing is fetched until you ask for it, from the row this creates."
              : "The endpoint answers this project's own inference contract."}
          </DialogDescription>
          <form className="flex flex-col gap-4" onSubmit={submit}>
            {/*
              A two-column grid, every field its own cell: name beside model on
              the first row, then the kind's own fields in pairs beneath — a
              custom model's id and revision, then device and precision; or
              revision and endpoint, then the credential across both. Nothing is
              stacked in one column while the other stands empty, and the two
              forms share a shape, so a person's eye lands in the same place
              whichever kind is open.
            */}
            <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="connection-name">Name</Label>
              <Input
                id="connection-name"
                data-testid="connection-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
              <FieldDescription>Unique in this workspace, ignoring case.</FieldDescription>
            </div>
            {/*
              The offered list is the *local* form's, and only its. An offer is
              a checkpoint an installed driver can load on this machine and
              would download; an HTTP connection names whatever the endpoint on
              the other end runs, which this build never loads and cannot vouch
              for. Offering the same list there would be recommending models
              for somebody else's server.
            */}
            {modelFixed ? (
              <FixedModel connection={editing} />
            ) : local ? (
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
                      <FieldDescription>Reading which models this installation can run…</FieldDescription>
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
                    <FieldDescription data-testid="catalog-empty">
                      No installed driver offers a model by name. Install a provider
                      distribution to be offered one, or name a model below and pin its
                      revision yourself.
                    </FieldDescription>
                  ) : (
                    <>
                      <Select value={choice} onValueChange={pickModel}>
                        <SelectTrigger
                          id="connection-model"
                          data-testid="connection-model"
                          multiline
                        >
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
                                <SelectItem key={entry.model_id} value={entry.model_id}>
                                  <span className="flex flex-col items-start">
                                    <span>{entry.model_id}</span>
                                    <span className="flex items-center gap-2">
                                      <span className="text-xs text-muted-foreground">
                                        {entry.hint}
                                      </span>
                                      {entry.access_note != null && (
                                        <Badge variant="quiet" data-testid="gated-badge">
                                          Gated
                                        </Badge>
                                      )}
                                    </span>
                                  </span>
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          ))}
                          <SelectGroup>
                            <SelectItem value={CUSTOM_MODEL}>
                              <span className="flex flex-col items-start">
                                <span>Custom model…</span>
                                <span className="text-xs text-muted-foreground">
                                  Any model id, at a revision you pin yourself
                                </span>
                              </span>
                            </SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <FieldDescription>
                        {custom
                          ? "Any model this build has an adapter for. The list above is a starting point, not a limit."
                          : "Pinned to the revision the driver that offers it declares."}
                      </FieldDescription>
                    </>
                  )}
                  {/* What choosing this model commits to, read where the choice is made. */}
                  <AccessLine entries={entries} modelId={modelId.trim()} />
                  <DownloadSizeLine modelId={modelId.trim()} revision={revision.trim()} />
                </div>
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
              </>
            )}
            {local ? (
              <>
                {/*
                  Whenever there is nothing to offer — the catalog refused, or
                  it answered and named nothing — the seeding effect lands
                  `choice` on the sentinel, so this reads that one decision
                  rather than working the same fact out a second time. A model
                  id needs no catalog, and creating a connection downloads
                  nothing, so a listing that failed is not a reason to prevent
                  one being configured.
                */}
                {custom && !modelFixed && (
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
                      <FieldDescription>Pinned. A moving pointer is not a provenance.</FieldDescription>
                    </div>
                  </>
                )}
                  <div className="flex flex-col gap-1.5">
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
                  <div className="flex flex-col gap-1.5">
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
                    <FieldDescription data-testid="precision-hint">
                      {precisionsFor(device).length === 1
                        ? "Half precision applies on CUDA only — on a CPU it has no effect."
                        : "fp16 halves the memory and runs faster on CUDA."}
                    </FieldDescription>
                  </div>
              </>
            ) : (
              <>
                {!modelFixed && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="connection-revision">Revision</Label>
                  <Input
                    id="connection-revision"
                    data-testid="connection-revision"
                    value={revision}
                    onChange={(event) => setRevision(event.target.value)}
                  />
                  <FieldDescription>Pinned. A moving pointer is not a provenance.</FieldDescription>
                </div>
                )}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="connection-endpoint">Endpoint URL</Label>
                  <Input
                    id="connection-endpoint"
                    data-testid="connection-endpoint"
                    value={endpoint}
                    onChange={(event) => setEndpoint(event.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <Label htmlFor="connection-credential-env">Credential variable</Label>
                  <Input
                    id="connection-credential-env"
                    data-testid="connection-credential-env"
                    value={credentialEnv}
                    onChange={(event) => setCredentialEnv(event.target.value)}
                  />
                  <FieldDescription>
                    The name of an environment variable, not the secret itself. VisionSet reads
                    it where the server runs, sends it as a bearer token, and never stores the
                    value. Leave empty if the endpoint wants none.
                  </FieldDescription>
                </div>
              </>
            )}
            </div>
            {failure !== null && (
              <FieldError data-testid="connection-error">{refusalProse(failure)}</FieldError>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="default"
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
  testId = "size",
}: {
  readonly modelId: string;
  readonly revision: string;
  /** The form's line and a row's line can be on screen together; the ids say which is which. */
  readonly testId?: string;
}): JSX.Element {
  const size = useDownloadSize(modelId, revision);
  if (modelId === "" || revision === "") return <></>;
  if (size.isPending) {
    return (
      <p className="text-xs text-muted-foreground" data-testid={`${testId}-checking`}>
        Reading the download size…
      </p>
    );
  }
  if (size.isError) {
    return (
      <p className="text-xs text-muted-foreground" data-testid={`${testId}-unavailable`}>
        {refusalProse(size.error)}
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground" data-testid={`${testId}-known`}>
      Downloads {bytes(size.data.total_bytes)} across {size.data.file_count} files when you
      ask for it.
    </p>
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
