/**
 * The open-project tabs: the workbench's top strip.
 *
 * Visiting a project opens its tab; the tab stays until it is closed, so moving
 * between two projects is one click rather than a trip through the list. Each
 * tab remembers the last address you were at inside its project, so coming back
 * lands where you left — a section, an open batch, the Add images dialog.
 *
 * ## The tabs are links
 *
 * They are navigation, not an ARIA tab widget: each one is a `<Link>` with
 * `aria-current="page"` on the open project, so middle-click and "open in new
 * tab" work, and a screen reader meets them as what they are. The close button
 * is a sibling of the link, never nested inside it.
 *
 * ## A tab whose project is gone closes itself
 *
 * The list is local memory and the project is the server's. When the server
 * answers 404 for a remembered id — deleted here, or from the CLI — the tab is
 * dropped rather than drawn as a dead link. Any other failure keeps the tab and
 * shows the id: a server that is briefly unreachable is not a reason to forget
 * what you had open.
 *
 * This is standalone-shell chrome: a host that mounts VisionSet's screens brings
 * its own global navigation, so nothing here is reusable and it reads only
 * `ui-core`'s public queries.
 */

import { Plus, X } from "lucide-react";
import {
  asApiError,
  classColor,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  useProject,
  useProjects,
} from "@visionset/ui-core";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { Link, useLocation, useMatch, useNavigate } from "react-router";

import { neighbourOf, readOpenProjects, withOpened, writeOpenProjects } from "./openProjects";

interface OpenProjects {
  readonly open: readonly string[];
  readonly current: string | null;
  readonly pathOf: (id: string) => string;
  readonly close: (id: string) => void;
  readonly forget: (id: string) => void;
}

const OpenProjectsContext = createContext<OpenProjects | null>(null);

/**
 * The tabs' state, held by the shell rather than by the strip.
 *
 * The strip is drawn inside each workbench pane, and the panes are sibling layout
 * routes — moving from a project to the project list swaps one for the other and
 * remounts the strip. State kept in the strip would forget where each tab was at
 * every such crossing, so it lives here, above every pane, and follows the URL
 * from there — including through the annotator, which draws no strip at all.
 */
export function OpenProjectsProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const match = useMatch("/projects/:projectId/*");
  const current = match?.params.projectId ?? null;
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(readOpenProjects);
  // Where each tab was last, so returning to it lands there. Session memory only.
  const lastPath = useRef(new Map<string, string>());
  const here = `${location.pathname}${location.search}`;

  // Visiting a project opens its tab. The tab is opened while rendering, the
  // moment the address changes, rather than in an effect that sets state: the
  // effect would draw one frame without the tab and then draw it again. The
  // marker makes the update converge — a tab closed by `forget` stays closed
  // until the address moves again, as it did when this was an effect.
  const place = current === null ? null : `${current}${here}`;
  const [placeSeen, setPlaceSeen] = useState<string | null>(null);
  if (place !== placeSeen) {
    setPlaceSeen(place);
    if (current !== null) setOpen((ids) => withOpened(ids, current));
  }

  useEffect(() => {
    if (current === null) return;
    lastPath.current.set(current, here);
  }, [current, here]);

  useEffect(() => writeOpenProjects(open), [open]);

  // The open tab is where the address is now; the others are where they were left.
  const pathOf = useCallback(
    (id: string): string => (id === current ? here : (lastPath.current.get(id) ?? `/projects/${id}`)),
    [current, here],
  );

  const close = useCallback(
    (id: string): void => {
      const next = neighbourOf(open, id);
      setOpen((ids) => ids.filter((x) => x !== id));
      if (id === current) void navigate(next === null ? "/projects" : pathOf(next));
      lastPath.current.delete(id);
    },
    [open, current, navigate, pathOf],
  );

  const forget = useCallback((id: string): void => {
    setOpen((ids) => ids.filter((x) => x !== id));
    lastPath.current.delete(id);
  }, []);

  const value = useMemo(() => ({ open, current, pathOf, close, forget }), [open, current, pathOf, close, forget]);

  return <OpenProjectsContext.Provider value={value}>{children}</OpenProjectsContext.Provider>;
}

function useOpenProjects(): OpenProjects {
  const value = useContext(OpenProjectsContext);
  if (value === null) throw new Error("ProjectTabs must be rendered inside <OpenProjectsProvider>");
  return value;
}

export function ProjectTabs(): JSX.Element {
  const { open, current, pathOf, close, forget } = useOpenProjects();
  const navigate = useNavigate();

  return (
    <div
      data-testid="project-tabs-bar"
      // The bottom hairline is drawn as `::after` rather than as a border, so the
      // open tab (a `z-10` sibling on `background`) can sit over it and run
      // straight into the section toolbar below — the tab and its page read as
      // one surface, the way an editor's do.
      className="sticky top-0 z-20 flex h-9 shrink-0 items-stretch bg-sidebar text-sidebar-foreground after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-border"
    >
      <nav aria-label="Open projects" className="flex min-w-0 items-stretch overflow-x-auto">
        <ul className="flex items-stretch">
          {open.map((id) => (
            <Tab key={id} id={id} to={pathOf(id)} current={id === current} onClose={() => close(id)} onGone={() => forget(id)} />
          ))}
        </ul>
      </nav>
      <OpenProjectMenu open={open} onPick={(id) => void navigate(pathOf(id))} />
    </div>
  );
}

function Tab({
  id,
  to,
  current,
  onClose,
  onGone,
}: {
  readonly id: string;
  readonly to: string;
  readonly current: boolean;
  readonly onClose: () => void;
  readonly onGone: () => void;
}): JSX.Element {
  const project = useProject(id);
  const gone = project.isError && asApiError(project.error).status === 404;
  useEffect(() => {
    if (gone) onGone();
  }, [gone, onGone]);

  const name = project.data?.name;
  return (
    <li
      data-testid={`open-tab-${id}`}
      className={cn(
        // Sized to the name, up to a cap, rather than a fixed 192px that left a
        // short name floating in empty tab. 13px, like the rail's labels: the
        // tabs are chrome, and chrome reads a step below the page's 14px.
        "group relative flex max-w-52 shrink-0 items-center border-r border-sidebar-border text-[13px]",
        current
          ? "z-10 bg-background text-foreground"
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      )}
    >
      {current && <span aria-hidden="true" className="absolute inset-x-0 top-0 h-0.5 bg-primary" />}
      <Link
        to={to}
        aria-current={current ? "page" : undefined}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 pr-1 pl-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <ProjectGlyph name={name ?? id} />
        {name === undefined && project.isPending ? (
          <span aria-label="Loading project" className="h-2.5 w-20 animate-pulse rounded-sm bg-muted" />
        ) : (
          <span className="truncate">{name ?? id}</span>
        )}
      </Link>
      <button
        type="button"
        aria-label={`Close ${name ?? "project"}`}
        data-testid={`close-tab-${id}`}
        onClick={onClose}
        className={cn(
          // 20px drawn, a 28×32 hit area: it grows into the tab's own margin on
          // the right and into the link's 4px end padding on the left, never
          // over the name.
          "relative mr-1.5 grid size-5 shrink-0 place-items-center rounded-sm before:absolute before:-inset-x-1 before:-inset-y-1.5",
          "text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
          // The open tab always shows its close; the others show it on hover, the
          // way an editor does, so a row of tabs is not a row of crosses.
          !current && "opacity-0 group-hover:opacity-100",
        )}
      >
        <X className="size-3" strokeWidth={1.75} aria-hidden="true" />
      </button>
    </li>
  );
}

/** A project's initial on a hue hashed from its name with `classColor`, so a project keeps its colour. */
function ProjectGlyph({ name }: { readonly name: string }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="grid size-3.5 shrink-0 place-items-center rounded-[3px] text-[8px] leading-none font-semibold text-white"
      style={{ background: classColor(undefined, name) }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/**
 * The `+`: every project not already open, in the list's order. The list is read
 * only once the menu opens — Radix mounts the content then — so the strip costs
 * no request on pages where nobody reaches for it.
 */
function OpenProjectMenu({ open, onPick }: { readonly open: readonly string[]; readonly onPick: (id: string) => void }): JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Open a project in a new tab"
          data-testid="open-project-tab"
          className="grid w-9 shrink-0 place-items-center text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <Plus className="size-4" strokeWidth={1.5} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Open in a new tab</DropdownMenuLabel>
        <ClosedProjects open={open} onPick={onPick} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ClosedProjects({ open, onPick }: { readonly open: readonly string[]; readonly onPick: (id: string) => void }): JSX.Element {
  const projects = useProjects();
  const openIds = new Set(open);
  const closed = (projects.data?.items ?? []).filter((p) => !openIds.has(p.id));
  return (
    <>
      {projects.isPending && <DropdownMenuItem disabled>Loading projects…</DropdownMenuItem>}
      {projects.isError && <DropdownMenuItem disabled>Couldn’t load projects</DropdownMenuItem>}
      {projects.isSuccess && closed.length === 0 && (
        <DropdownMenuItem disabled>
          {projects.data.items.length === 0 ? "No projects yet" : "Every project is already open"}
        </DropdownMenuItem>
      )}
      {closed.map((p) => (
        <DropdownMenuItem key={p.id} data-testid={`open-tab-pick-${p.name}`} onSelect={() => onPick(p.id)}>
          <ProjectGlyph name={p.name} />
          <span className="truncate">{p.name}</span>
        </DropdownMenuItem>
      ))}
    </>
  );
}
