/**
 * The project list — a ledger: one dense row per project, and every number that
 * tells projects apart in its own sortable, right-aligned, tabular column.
 *
 * ## The numbers come from the server, in the same request as the list
 *
 * Each row carries a `digest` the kernel computes for the whole workspace in one
 * pass (`ProjectService.digests`): images, how much of it is annotated, the
 * active schema's class count, open work, what is in the dataset and its latest
 * release, when anything last happened, and the project's `stage`. Nothing here
 * derives a stage from batch states — the stage is the kernel's description of
 * where a project is, and this screen only says it in words and a status colour.
 * It is a description, never a capability: no control on this page is gated on
 * it.
 *
 * ## Why this takes `onOpenProject` instead of importing a router
 *
 * `@visionset/ui-core` must not know how the application navigates. The app owns
 * routing (the enterprise rule, from the other side): a screen that reached for
 * `useNavigate` would only work inside a `react-router` tree, which is a
 * dependency the future enterprise UI has no reason to share. So navigation
 * arrives as a callback and leaves as one.
 *
 * ## Delete asks twice, and the two questions are not the same question
 *
 * The dialog is the *user's* confirmation. `?confirm=true` is the *API's*, and
 * `docs/content/api.md` is explicit that no route pre-checks a gate — a gated retry is the
 * identical request plus one parameter. Collapsing them would mean either a dialog
 * that does not send the gate (the API refuses, the user sees a mystery) or a gate
 * sent without a dialog (a click deletes a project). They are both here, and they
 * are both doing something.
 *
 * The dialog also names what deletion destroys, from the kernel's own list:
 * schema versions, batches, annotations and releases cascade; **blobs never do**,
 * because content is hash-addressed and shared, so deleting metadata frees rows
 * rather than disk.
 */

import { ArrowDown, ArrowUp, ArrowUpRight, CircleCheck, CircleCheckBig, CircleDashed, Clock, FolderOpen, Folders, Images, MoreHorizontal, PackageCheck, Pencil, Plus, Tags, Trash2 } from "lucide-react";
import { useRef, useState, type FormEvent, type JSX } from "react";

import { Async } from "../data/Async";
import { refusalProse } from "../data/refusals";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Textarea,
  Label,
  FieldDescription,
  FieldError,
  SearchInput,
  cn,
} from "@robomous/ui-core";
import { formatCount, formatWhen } from "../lib/format";
import { BODY_ROW, ColumnHeader, ListGrid, ListPage, type ListColumn } from "../patterns/ListPage";
import { PageStatus } from "../patterns/PageStatus";
import { ProgressReadout } from "../patterns/ProgressRing";
import { StateChip, type State } from "../patterns/StateChip";
import { usePagination } from "../patterns/pagination";
import { clickedRowId, walkRowButtons } from "../patterns/rowDelegation";
import { TableFooter } from "../patterns/TablePager";
import { AssetThumbnail, ThumbnailPlaceholder } from "./AssetThumbnail";
import { RenameProjectDialog } from "./ProjectFrame";
import { lastMoved, leftToAnnotate, orderedProjects, type Direction, type ProjectSortKey } from "./projectOrder";
import { useCreateProject, useDeleteProject, useProjects, type Project, type ProjectListItem, type ProjectStage } from "./queries";

export interface ProjectsScreenProps {
  /** The app turns this into a route change. See the note above. */
  readonly onOpenProject: (projectId: string) => void;
}

// ── Ordering ──────────────────────────────────────────────────────────────

/** The first click on a column sorts the way that column is usually read. */
const FIRST_DIRECTION: Record<ProjectSortKey, Direction> = {
  name: "ascending",
  images: "descending",
  annotated: "descending",
  classes: "descending",
  activity: "descending",
};

function matches(project: ProjectListItem, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  if (q === "") return true;
  return project.name.toLocaleLowerCase().includes(q) || (project.description ?? "").toLocaleLowerCase().includes(q);
}

// ── Stage, in words and a status family ───────────────────────────────────

/**
 * One label, one status family and one shape per stage, on the product-wide
 * mapping (`docs/content/ui/product-principles.md` → *Status semantics*):
 * `waiting` (warning) only for what waits on a person to judge, `active` (info)
 * for work in flight, `done` (success) for the settled facts, `draft` (neutral)
 * for nothing-yet and for a decision with nothing wrong. The shape is the state
 * grammar's (`DESIGN.md` → *States*): an empty project the dashed ring, a
 * released-since-changed one the dashed check — done, not frozen. The word
 * always rides with the colour.
 */
const STAGE: Record<ProjectStage, Pick<State, "label" | "tone" | "glyph">> = {
  in_review: { label: "In review", tone: "waiting", glyph: "review" },
  annotating: { label: "Annotating", tone: "active", glyph: "partway" },
  to_promote: { label: "Ready to add", tone: "done", glyph: "ready" },
  unreleased: { label: "Not released", tone: "draft", glyph: "drafted" },
  up_to_date: { label: "Up to date", tone: "done", glyph: "done" },
  not_started: { label: "Not started", tone: "draft", glyph: "todo" },
  empty: { label: "No assets", tone: "draft", glyph: "backlog" },
};

/**
 * The stage's detail line: the size of the thing waiting on a reviewer, where
 * there is one. Not for `annotating` — what is left to annotate is the
 * Annotated column's whole job, and saying it twice in one row is noise.
 */
function stageDetail(p: ProjectListItem): string | null {
  const d = p.digest;
  return d.stage === "in_review" ? `${formatCount(d.frames_in_review)} to review` : null;
}

// ── The screen ────────────────────────────────────────────────────────────

const SORT_LABEL: Record<ProjectSortKey, string> = {
  name: "Name",
  images: "Assets",
  annotated: "Annotated",
  classes: "Classes",
  activity: "Activity",
};

/**
 * The grid's columns, on two widths and no others: `FIGURE` for a column that
 * holds a short figure — a count, a tag, a date — and `PHRASE` for one that
 * holds a few words — what is left to annotate, the stage and its detail. Equal
 * columns read as a rhythm; a column a few pixels wider than its neighbour
 * reads as a mistake. The project column takes what the others leave (they take
 * 864px), so the grid needs 1100px before it scrolls inside its frame.
 */
const FIGURE = "w-28";
const PHRASE = "w-44";
const COLUMNS: readonly ListColumn[] = [
  { key: "project" },
  { key: "images", width: FIGURE },
  { key: "annotated", width: PHRASE },
  { key: "classes", width: FIGURE },
  { key: "status", width: PHRASE },
  { key: "release", width: FIGURE },
  { key: "activity", width: FIGURE },
  { key: "actions", width: "w-16" },
];

export function ProjectsScreen({ onOpenProject }: ProjectsScreenProps): JSX.Element {
  const projects = useProjects();
  const [creating, setCreating] = useState(false);
  const [doomed, setDoomed] = useState<Project | null>(null);
  const [renaming, setRenaming] = useState<Project | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: ProjectSortKey; direction: Direction }>({
    key: "activity",
    direction: "descending",
  });

  function sortBy(key: ProjectSortKey): void {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "descending" ? "ascending" : "descending" }
        : { key, direction: FIRST_DIRECTION[key] },
    );
  }
  const sortOf = (key: ProjectSortKey): "ascending" | "descending" | "none" => (sort.key === key ? sort.direction : "none");

  const items = projects.data?.items ?? [];
  const searching = query.trim() !== "";
  const found = searching ? items.filter((p) => matches(p, query)) : items;
  // In the order the table shows, so a page is a slice of what somebody sees.
  const ordered = orderedProjects(found, sort.key, sort.direction);
  // The same pager as every full-page table; a search or a new order starts it over.
  const paging = usePagination(ordered, { pageSize: 25, resetKey: `${query.trim()}|${sort.key}|${sort.direction}` });
  const frame = useRef<HTMLDivElement>(null);

  return (
    <ListPage
      testId="projects-screen"
      icon={Folders}
      title="Projects"
      toolbar={
        <>
          <SearchInput
            value={query}
            onValueChange={setQuery}
            shortcut
            placeholder="Search projects"
            aria-label="Search projects"
            id="projects-search"
            data-testid="projects-search"
            className="w-64 max-w-full"
          />
          {/* The order, then the page's one action, at the end of the bar that
              shapes the list: "New" on the page that names the noun, its full
              name for whoever cannot see the page's title. */}
          <div className="ml-auto flex items-center gap-2">
            <SortMenu sort={sort} onSort={setSort} />
            <Button size="sm" aria-label="New project" data-testid="new-project" onClick={() => setCreating(true)}>
              <Plus aria-hidden="true" />
              New
            </Button>
          </div>
        </>
      }
    >
      {projects.isSuccess && items.length > 0 && <ProjectsStatus shown={found} />}
      <Async
        query={projects}
        loadingRows={4}
        empty={{
          art: "projects",
          title: "No projects yet",
          // No button of its own: the header's "New" is on screen, the
          // same label calling the same handler. One way to make a project.
          description: "A project holds a schema, its batches and one dataset. Start one with New.",
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
                if (id !== null) onOpenProject(id);
              }}
            >
              <ListGrid
                columns={COLUMNS}
                minWidth="min-w-[1100px]"
                label="Projects"
                testId="projects-table"
                frameRef={frame}
                head={
                  <>
                    <ColumnHeader icon={FolderOpen} label="Project" sort={sortOf("name")} onSort={() => sortBy("name")} testId="sort-name" />
                    <ColumnHeader icon={Images} label="Assets" align="right" sort={sortOf("images")} onSort={() => sortBy("images")} testId="sort-images" />
                    <ColumnHeader icon={CircleCheckBig} label="Annotated" sort={sortOf("annotated")} onSort={() => sortBy("annotated")} testId="sort-annotated" />
                    <ColumnHeader icon={Tags} label="Classes" align="right" sort={sortOf("classes")} onSort={() => sortBy("classes")} testId="sort-classes" />
                    <ColumnHeader icon={CircleDashed} label="Status" />
                    <ColumnHeader icon={PackageCheck} label="Release" />
                    <ColumnHeader icon={Clock} label="Activity" align="right" sort={sortOf("activity")} onSort={() => sortBy("activity")} testId="sort-activity" />
                    <ColumnHeader label="Actions" hidden />
                  </>
                }
              >
                <tbody>
                  {paging.slice.map((project) => (
                    <Row
                      key={project.id}
                      project={project}
                      onOpen={() => onOpenProject(project.id)}
                      onRename={() => setRenaming(project)}
                      onDelete={() => setDoomed(project)}
                    />
                  ))}
                  {ordered.length === 0 && (
                    <tr className={BODY_ROW}>
                      <td colSpan={COLUMNS.length} data-testid="projects-no-match" className="h-24 text-center text-muted-foreground">
                        No project matches <span className="font-medium text-foreground">“{query.trim()}”</span>.{" "}
                        <button
                          type="button"
                          data-testid="projects-clear-search"
                          onClick={() => {
                            setQuery("");
                            // The button leaves with the empty result; focus goes
                            // back to the field it cleared rather than to the page.
                            document.getElementById("projects-search")?.focus();
                          }}
                          className="rounded-sm font-medium text-foreground underline decoration-foreground/30 underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                        >
                          Clear search
                        </button>
                      </td>
                    </tr>
                  )}
                </tbody>
              </ListGrid>
            </div>
            {/* Under the table, outside the rows' delegating wrapper. */}
            <TableFooter pagination={paging} frameRef={frame} noun="project" unfiltered={items.length} />
          </>
        )}
      </Async>

      <CreateProjectDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={onOpenProject}
      />
      <DeleteProjectDialog project={doomed} onClose={() => setDoomed(null)} />
      {renaming !== null && (
        <RenameProjectDialog
          projectId={renaming.id}
          current={renaming.name}
          open
          onClose={() => setRenaming(null)}
        />
      )}
    </ListPage>
  );
}

/**
 * What the list on screen adds up to, in the workbench's status bar — said
 * there and not on the page (`PageStatus`): the images in it and how much is
 * left to annotate, and how many projects are waiting on a person to review,
 * the one stage that asks something of whoever is reading. Every figure is over
 * every project the search leaves, not the page of them on screen. How many
 * projects there are, and of how many while a search narrows them (never hiding
 * what it left out, `product-principles.md`), is the footer's to say
 * (`TableFooter`): said once.
 */
function ProjectsStatus({ shown }: { readonly shown: readonly ProjectListItem[] }): JSX.Element {
  const images = shown.reduce((sum, p) => sum + p.digest.asset_count, 0);
  // The same count the Annotated column says per row, so the bar and the rows
  // never disagree about whether there is work left.
  const left = shown.reduce((sum, p) => sum + leftToAnnotate(p.digest), 0);
  const review = shown.filter((p) => p.digest.stage === "in_review").length;
  return (
    <PageStatus>
      {images > 0 && (
        <span data-testid="projects-images">
          {formatCount(images)} {images === 1 ? "asset" : "assets"} · {left === 0 ? "all annotated" : `${formatCount(left)} to annotate`}
        </span>
      )}
      {review > 0 && (
        <span data-testid="projects-review" className="text-foreground">
          {formatCount(review)} in review
        </span>
      )}
    </PageStatus>
  );
}

/**
 * The order the grid is in, said in the toolbar — "Sorted by Activity" — and
 * changed there too: a key, then which way. The column headers sort the same
 * state, so the two never disagree.
 */
function SortMenu({
  sort,
  onSort,
}: {
  readonly sort: { key: ProjectSortKey; direction: Direction };
  readonly onSort: (next: { key: ProjectSortKey; direction: Direction }) => void;
}): JSX.Element {
  const Arrow = sort.direction === "ascending" ? ArrowUp : ArrowDown;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="font-normal" data-testid="projects-sort">
          <Arrow aria-hidden="true" />
          <span className="text-muted-foreground">Sorted by</span>
          <span className="font-medium">{SORT_LABEL[sort.key]}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuRadioGroup value={sort.key} onValueChange={(key) => onSort({ key: key as ProjectSortKey, direction: FIRST_DIRECTION[key as ProjectSortKey] })}>
          {(Object.keys(SORT_LABEL) as ProjectSortKey[]).map((key) => (
            <DropdownMenuRadioItem key={key} value={key} data-testid={`projects-sort-${key}`}>
              {SORT_LABEL[key]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={sort.direction} onValueChange={(direction) => onSort({ key: sort.key, direction: direction as Direction })}>
          <DropdownMenuRadioItem value="ascending">Ascending</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="descending">Descending</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * How much of a project is left to annotate — the work, not the work done,
 * because the question this list answers is usually "where is there work?".
 *
 * A 14px ring for the glance and the count in words: "248 to annotate". A
 * finished project trades both for a check and "All annotated"; a project with
 * no images gets the dash every other column uses, since its Status already
 * says *No assets*.
 *
 * **Left means left for a person.** Two counts can say it and neither is
 * whole on its own: images with no annotation at all, and `frames_left` —
 * frames in active batches an annotator still has to do, which counts a
 * model's pre-label nobody has judged (and that image already *has* an
 * annotation). The cell says the larger, so a project of pre-labels nobody has
 * read never reads "All annotated" beside a Status of *Annotating*.
 *
 * **Nothing in it moves.** The count is in tabular figures and the ring is the
 * shared `ProgressReadout`'s, a fixed 14px whose arc is clamped: a project with
 * anything left never draws a closed ring (at 97% a true arc would read as
 * done), and one with anything annotated never draws an empty one.
 */
function RemainingCell({ digest }: { readonly digest: ProjectListItem["digest"] }): JSX.Element {
  const total = digest.asset_count;
  if (total === 0) return <span className="text-muted-foreground">—</span>;
  const done = Math.min(digest.annotated_asset_count, total);
  const left = leftToAnnotate(digest);
  if (left === 0) {
    return (
      <span className="flex items-center gap-2 text-muted-foreground" data-testid="remaining-cell">
        <CircleCheck aria-hidden="true" className="size-3.5 shrink-0 text-success" strokeWidth={2} />
        All annotated
      </span>
    );
  }
  // Floored, so a project one image short never says 100%.
  const share = Math.floor((done / total) * 100);
  return (
    // The count, then the ring — the shared readout; the ring is the assets' share, and stays open while any asset waits.
    <span className="flex min-w-0" data-testid="remaining-cell" title={`${share}% of assets annotated`}>
      {/* `complete={false}`: assets are left, so the ring stays open whatever the assets' share says. */}
      <ProgressReadout
        value={done}
        total={total}
        complete={false}
        ringTestId="remaining-ring"
        detail={{
          title: "Annotated",
          caption: `${formatCount(done)} of ${formatCount(total)} assets · ${share}%`,
          note: `${formatCount(left)} ${left === 1 ? "asset" : "assets"} still to annotate.`,
        }}
      >
        <span className="text-foreground">{formatCount(left)}</span> to annotate
      </ProgressReadout>
    </span>
  );
}

function Row({
  project,
  onOpen,
  onRename,
  onDelete,
}: {
  readonly project: ProjectListItem;
  readonly onOpen: () => void;
  readonly onRename: () => void;
  readonly onDelete: () => void;
}): JSX.Element {
  const d = project.digest;
  const stage = STAGE[d.stage];
  const detail = stageDetail(project);
  const moved = lastMoved(project);

  // The whole row opens the project for a pointer — the table body takes that
  // click (`clickedRowId`) — and the name is the row's one real control for the
  // keyboard and a screen reader, so each project is heard once. The menu's cell
  // says it is its own (`data-row-action`).
  return (
    <tr
      data-testid={`project-${project.name}`}
      data-row-id={project.id}
      // No transition on the hover fill: the pointer sweeps this list.
      className={cn(BODY_ROW, "group cursor-pointer hover:bg-muted/40")}
    >
      <td>
        <div className="flex min-w-0 items-center gap-2.5">
          {project.thumbnail_asset_id === null ? (
            <ThumbnailPlaceholder
              title="No assets in this project yet."
              alt=""
              className="size-6 shrink-0 rounded-[5px] outline-1 -outline-offset-1 outline-foreground/10"
            />
          ) : (
            <AssetThumbnail
              projectId={project.id}
              assetId={project.thumbnail_asset_id}
              thumbnailHash={project.thumbnail_hash}
              alt=""
              className="size-6 shrink-0 rounded-[5px] object-cover outline-1 -outline-offset-1 outline-foreground/10"
            />
          )}
          <button
            type="button"
            data-testid={`open-${project.name}`}
            data-row-open={project.id}
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
            // A link's hairline under the name — it goes somewhere — and the
            // arrow says where, once the row is pointed at.
            className="flex min-w-0 shrink items-center gap-1 rounded-sm text-left font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="truncate underline decoration-foreground/20 underline-offset-[5px] group-hover:decoration-foreground/50">{project.name}</span>
            <ArrowUpRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" />
          </button>
          {/* One line: the row's height is fixed so the columns stay a grid, and
              the project's own page carries the whole of it. Absent rather than
              "No description": the same placeholder on every row is noise. */}
          {project.description !== null && project.description !== "" && (
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={project.description}>
              {project.description}
            </span>
          )}
        </div>
      </td>
      <td className="text-right tabular-nums">{d.asset_count === 0 ? "—" : formatCount(d.asset_count)}</td>
      <td>
        <RemainingCell digest={d} />
      </td>
      <td className="text-right tabular-nums">{d.class_count === 0 ? "—" : formatCount(d.class_count)}</td>
      <td>
        <div className="flex min-w-0 items-center gap-2">
          <StateChip
            state={d.stage === "annotating" && d.asset_count > 0 ? { ...stage, fraction: Math.min(d.annotated_asset_count, d.asset_count) / d.asset_count } : stage}
            testId="project-stage"
          />
          {detail !== null && <span className="truncate text-xs text-muted-foreground tabular-nums">{detail}</span>}
        </div>
      </td>
      {/* The tag and nothing else. Its asset count was the Assets column's
          number again on most rows, and "no release" was the Status column's
          word again — the status already says Not released or Ready to add. */}
      <td className="text-xs tabular-nums">
        {d.latest_release !== null ? (
          <span
            className="block truncate font-mono font-medium"
            title={`${formatCount(d.latest_release.asset_count)} ${d.latest_release.asset_count === 1 ? "asset" : "assets"} · published ${formatWhen(d.latest_release.published_at)}`}
          >
            {d.latest_release.tag}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="text-right text-xs text-muted-foreground tabular-nums">
        {moved === null ? "—" : <time dateTime={moved}>{formatWhen(moved)}</time>}
      </td>
      <td className="text-right" data-row-action="">
        <RowMenu project={project} onRename={onRename} onDelete={onDelete} />
      </td>
    </tr>
  );
}

function RowMenu({
  project,
  onRename,
  onDelete,
}: {
  readonly project: ProjectListItem;
  readonly onRename: () => void;
  readonly onDelete: () => void;
}): JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`More actions for ${project.name}`}
          data-testid={`menu-${project.name}`}
        >
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem data-testid={`rename-${project.name}`} onSelect={onRename}>
          <Pencil aria-hidden="true" />
          Rename
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" data-testid={`delete-${project.name}`} onSelect={onDelete}>
          <Trash2 aria-hidden="true" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Exported so the workspace's Home can offer the same dialog.
 *
 * A first-run Home invites somebody to create their first project, and a filled
 * button that only *navigates* to the screen carrying the real one would be a
 * label promising an action it does not perform. One dialog, two callers, and
 * this screen's behaviour is unchanged.
 */
export function CreateProjectDialog({
  open,
  onClose,
  onCreated,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  /**
   * Where a successful create lands.
   *
   * `onOpenProject`, handed straight through — the same callback a table row
   * uses, so the routing stays in the app and this file still imports no router.
   * A project is made in order to do something with it, so the list it was made
   * from is never the destination.
   */
  readonly onCreated: (projectId: string) => void;
}): JSX.Element {
  const create = useCreateProject();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  function submit(event: FormEvent): void {
    event.preventDefault();
    create.mutate(
      // An empty description is `null`, not `""`: the field is nullable on the wire
      // and a blank string would be a description that renders as nothing.
      { name: name.trim(), description: description.trim() === "" ? null : description.trim() },
      {
        // `POST /projects` answers with the created `ProjectOut`, so the id is
        // already here and nothing is fetched to find it. Only on success: a
        // refusal leaves the dialog open with what was typed still in it.
        onSuccess: (created) => {
          setName("");
          setDescription("");
          onClose();
          onCreated(created.id);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="create-project-dialog">
        <DialogTitle>New project</DialogTitle>
        <DialogDescription>
          Names are unique per workspace, case-insensitively.
        </DialogDescription>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              data-testid="project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-description">Description</Label>
            <Textarea
              id="project-description"
              data-testid="project-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
            <FieldDescription>Optional.</FieldDescription>
          </div>
          {create.isError && (
            <FieldError data-testid="create-error">{refusal(create.error)}</FieldError>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="default"
              data-testid="create-submit"
              disabled={name.trim() === "" || create.isPending}
            >
              {create.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteProjectDialog({
  project,
  onClose,
}: {
  readonly project: Project | null;
  readonly onClose: () => void;
}): JSX.Element {
  const remove = useDeleteProject();

  return (
    <Dialog open={project !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="delete-project-dialog">
        <DialogTitle>Delete {project?.name}?</DialogTitle>
        <DialogDescription>
          This removes the project, its schema versions, batches, annotations and releases.
          Stored image and video content is <strong>not</strong> deleted — blobs are shared by
          content hash, so removing metadata frees rows rather than disk.
        </DialogDescription>
        {remove.isError && (
          <FieldError data-testid="delete-error">{refusal(remove.error)}</FieldError>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            data-testid="delete-submit"
            disabled={remove.isPending}
            onClick={() =>
              project !== null && remove.mutate(project.id, { onSuccess: onClose })
            }
          >
            {remove.isPending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One refusal, as the sentence the field's alert announces.
 *
 * The field error is what a screen reader announces. The identifier does not
 * lead: a client branches on a code, a person cannot.
 */
function refusal(cause: unknown): string {
  return refusalProse(cause);
}
