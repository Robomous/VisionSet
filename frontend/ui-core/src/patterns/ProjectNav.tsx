/**
 * Where you are inside a project — the sections, the one filled control, and the
 * overflow. Nothing else: the project's identity (its name, its active version,
 * the way out) is an eyebrow above the content, drawn by `ProjectFrame`, so the
 * column is only as wide as its widest control.
 *
 * ## One component, two layouts
 *
 * At `lg` and above the sections are a **column** between the rail and the
 * content: a real `<nav>` with the filled control on top, one link per section,
 * and the overflow at the bottom. Below `lg` the same data is a **strip** — the
 * tab list on the left, the filled control and the overflow on the right, the
 * content in the panel beneath. The breakpoint is not decided here: `ProjectShell`
 * picks the layout, and this component draws whichever it is handed, so there is
 * one place the items, the icons and the labels are spelled.
 *
 * ## It is navigation, so the items are links
 *
 * `ui-core` imports no router. The host spells every URL through `hrefFor` and
 * turns the click into a route change through `onNavigate`; the `<a>` is what
 * keeps middle-click and "open in new tab" working, and the callback is what
 * keeps the app's history rules in the app. A host with no URLs to spell —
 * a component test, a renderer with no router — still gets working items, as
 * buttons, rather than anchors that go nowhere.
 *
 * The open section is marked with `aria-current="page"` as well as its fill,
 * because a fill is colour and colour is never the only signal.
 *
 * ## The one filled control
 *
 * Annotate is the project's forward action, and it opens the batch that is
 * currently `in_annotation` — straight into its one job when it has exactly
 * one, and onto the gallery to pick a job otherwise. With none open there is
 * nowhere to send anybody, so the button is absent rather than grey and
 * **Ingest takes the slot** — the honest next step. With two or more open it
 * reads `Annotate ▾` and asks which, because the batch you pick decides which
 * schema version you annotate under and a silent default would be a choice
 * nobody made. A section whose own content holds the page's filled control
 * says so through `contentOwnsTheAction`, and Ingest steps back to `secondary`
 * for as long as that holds, so the page never shows two.
 *
 * ## The rail it is not
 *
 * The rail is the workspace's top-level destinations on the `sidebar-*` tokens.
 * This column belongs to one project and reads as part of the page: `background`
 * and a hairline, no `sidebar-*` token anywhere in it.
 */

import { ChevronDown, Database, Grid3x3, Layers, MoreHorizontal, Network, Pencil, Trash2, type LucideIcon, Upload } from "lucide-react";
import { cva } from "class-variance-authority";
import type { JSX, MouseEvent, ReactNode } from "react";

import { menuSurface, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Tabs, TabsContent, TabsList, TabsTrigger } from "@robomous/ui-core";

/**
 * The four sections of a project, in the order work happens in: what a project
 * *is*, what it *means*, what is *being done*, what came *out*.
 */
export type ProjectSection = "overview" | "schema" | "batches" | "dataset";

export const PROJECT_SECTIONS: readonly ProjectSection[] = ["overview", "schema", "batches", "dataset"];

export function isProjectSection(value: string | undefined): value is ProjectSection {
  return PROJECT_SECTIONS.includes(value as ProjectSection);
}

/** The section a project opens on, and where anything unrecognised lands. */
export const DEFAULT_PROJECT_SECTION: ProjectSection = "overview";

interface SectionLabel {
  readonly label: string;
  readonly icon: LucideIcon;
}

/**
 * One item of the column, as data: the `Button` convention, so "the open
 * section is the accent fill plus weight" is a lookup rather than a ternary.
 */
const navItemVariants = cva(
  "flex h-8 w-full items-center gap-1.5 rounded-md px-2.5 text-sm outline-none " +
    "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
  {
    variants: {
      current: {
        true: "bg-accent font-medium text-accent-foreground",
        false: "text-muted-foreground",
      },
    },
    defaultVariants: { current: false },
  },
);

const SECTION_LABELS: Record<ProjectSection, SectionLabel> = {
  overview: { label: "Overview", icon: Grid3x3 },
  schema: { label: "Schema", icon: Network },
  batches: { label: "Batches", icon: Layers },
  dataset: { label: "Dataset", icon: Database },
};

/** One batch the annotator can be opened on: what the `Annotate ▾` menu lists. */
export interface AnnotateTarget {
  readonly id: string;
  /** Already carries the `— correction` suffix where one applies. */
  readonly name: string;
  /** Frames still `unannotated` — the batch table's `N to do`. */
  readonly remaining: number;
  /** The schema version the batch is pinned to; null only for a row the wire left unpinned. */
  readonly schemaVersion: number | null;
  /** The batch's job ids, or undefined while unknown — unknown lands on the gallery. */
  readonly jobIds?: readonly string[] | undefined;
}

/** Exactly one job → straight into it; otherwise the gallery, where a job is chosen. */
export function destinationOf(target: AnnotateTarget): { kind: "job"; id: string } | { kind: "batch"; id: string } {
  const [only] = target.jobIds ?? [];
  return target.jobIds?.length === 1 && only !== undefined ? { kind: "job", id: only } : { kind: "batch", id: target.id };
}

export interface ProjectNavProps {
  readonly layout: "column" | "strip";
  /** The sections on offer, in display order — a host with no batch route omits `batches`. */
  readonly sections: readonly ProjectSection[];
  /** The open section, or the one the page belongs to; `null` lights nothing. */
  readonly active: ProjectSection | null;
  /** The URL of a section, spelled by the host. Absent renders the items as buttons. */
  readonly hrefFor?: (section: ProjectSection) => string;
  readonly onNavigate: (section: ProjectSection) => void;
  /** The batches open for annotation, newest first. Absent or empty: no Annotate. */
  readonly annotate?: {
    readonly targets: readonly AnnotateTarget[];
    readonly onOpen: (batchId: string) => void;
    readonly onOpenJob?: (jobId: string) => void;
  };
  readonly onIngest?: () => void;
  /** The open section's content holds the page's filled control, so Ingest steps back. */
  readonly contentOwnsTheAction?: boolean;
  readonly onRename?: () => void;
  readonly onDelete?: () => void;
  /** The strip layout's content: below `lg` the tab bar owns the panel beneath it. */
  readonly children?: ReactNode;
}

export function ProjectNav(props: ProjectNavProps): JSX.Element {
  return props.layout === "column" ? <Column {...props} /> : <Strip {...props} />;
}

function Column(props: ProjectNavProps): JSX.Element {
  const { sections, active, hrefFor, onNavigate } = props;
  return (
    <nav
      aria-label="Project"
      data-testid="project-nav"
      className="flex w-project-nav shrink-0 flex-col gap-1 border-r bg-background px-2 py-3"
    >
      <Cta {...props} />
      <ul className="mt-2 flex flex-col gap-1">
        {sections.map((section) => {
          const { label, icon: Icon } = SECTION_LABELS[section];
          const current = section === active;
          const shared = {
            "data-testid": `nav-${section}`,
            "aria-current": current ? ("page" as const) : undefined,
            className: navItemVariants({ current }),
          };
          return (
            <li key={section}>
              {hrefFor === undefined ? (
                <button type="button" {...shared} onClick={() => onNavigate(section)}>
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  {label}
                </button>
              ) : (
                <a {...shared} href={hrefFor(section)} onClick={(event) => routed(event, () => onNavigate(section))}>
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  {label}
                </a>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex-1" />
      <Overflow {...props} />
    </nav>
  );
}

/**
 * The strip: the filled control and the overflow on a row, the sections as a
 * full-width tab bar under it, the content in the panel beneath. A Radix `Tabs`
 * rather than a second list of links, so the panel is labelled by its tab; the
 * row gaps are the primitive's own `gap-2`, except the last one, where this
 * pattern (not `tabs.tsx`) adds a second `gap-2` so content under a `line` bar
 * keeps the wider 16px rhythm navigation calls for.
 */
function Strip(props: ProjectNavProps): JSX.Element {
  const { sections, active, onNavigate, children } = props;
  return (
    <Tabs
      // A page that belongs to no section selects no tab; Radix takes the
      // empty string as "none of these" and the panel still holds the content.
      value={active ?? ""}
      // Radix only ever emits a value this file rendered, so the guard is
      // unreachable; it keeps the callback's type honest without a cast.
      onValueChange={(next) => {
        if (isProjectSection(next)) onNavigate(next);
      }}
      data-testid="project-tabs"
      className="min-w-0"
    >
      <div className="flex items-center justify-end gap-2">
        <Cta {...props} />
        <Overflow {...props} />
      </div>
      <div className="min-w-0 overflow-x-auto pb-1.5 -mb-1.5">
        <TabsList variant="line" className="w-full justify-start border-b">
          {sections.map((section) => {
            const { label, icon: Icon } = SECTION_LABELS[section];
            return (
              <TabsTrigger key={section} value={section} data-testid={`nav-${section}`}>
                <Icon className="size-4" aria-hidden="true" />
                {label}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </div>
      <TabsContent value={active ?? ""} className="mt-2">
        {children}
      </TabsContent>
    </Tabs>
  );
}

/** Annotate, or Ingest in its place, or nothing — never a disabled control. */
function Cta({ annotate, onIngest, contentOwnsTheAction = false, layout }: ProjectNavProps): JSX.Element | null {
  const wide = layout === "column" ? "w-full" : undefined;
  if (annotate !== undefined && annotate.targets.length > 0) {
    return (
      <AnnotateAction
        targets={annotate.targets}
        onOpen={annotate.onOpen}
        {...(annotate.onOpenJob === undefined ? {} : { onOpenJob: annotate.onOpenJob })}
        className={wide}
      />
    );
  }
  if (onIngest === undefined) return null;
  return (
    <Button
      variant={contentOwnsTheAction ? "outline" : "default"}
      data-testid="go-ingest"
      className={wide}
      onClick={onIngest}
    >
      <Upload className="size-4" aria-hidden="true" />
      Ingest
    </Button>
  );
}

/**
 * One open batch jumps; two or more ask which, in three data points a row: the
 * name, the remaining count in the batch table's own words, and the pinned
 * schema version — invisible everywhere else on this page, and what the pick
 * actually decides. No split button and no remembered default: a control's
 * destination may not be a function of session history.
 */
function AnnotateAction({
  targets,
  onOpen,
  onOpenJob,
  className,
}: {
  readonly targets: readonly AnnotateTarget[];
  readonly onOpen: (batchId: string) => void;
  readonly onOpenJob?: (jobId: string) => void;
  readonly className?: string | undefined;
}): JSX.Element {
  function go(target: AnnotateTarget): void {
    const to = destinationOf(target);
    if (to.kind === "job" && onOpenJob !== undefined) onOpenJob(to.id);
    else onOpen(target.id);
  }

  const [only] = targets;
  if (targets.length === 1 && only !== undefined) {
    return (
      <Button variant="default" data-testid="go-annotate" className={className} onClick={() => go(only)}>
        <Pencil className="size-4" aria-hidden="true" />
        Annotate
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* Same testid and variant as the jumping form: one control with two
            shapes, and the chevron is what tells them apart. */}
        <Button variant="default" data-testid="go-annotate" className={className}>
          <Pencil className="size-4" aria-hidden="true" />
          Annotate
          <ChevronDown className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={menuSurface}>
        {targets.map((batch) => (
          <DropdownMenuItem
            key={batch.id}
            data-testid={`annotate-batch-${batch.name}`}
            onSelect={() => go(batch)}
          >
            <div className="flex flex-col items-start">
              <span>{batch.name}</span>
              <span className="text-xs text-muted-foreground">
                {batch.remaining} to do · {batch.schemaVersion === null ? "—" : `v${batch.schemaVersion}`}
              </span>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Overflow({ onRename, onDelete }: ProjectNavProps): JSX.Element | null {
  if (onRename === undefined && onDelete === undefined) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="More actions" data-testid="project-menu">
          <MoreHorizontal className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={menuSurface}>
        {onRename !== undefined && (
          <DropdownMenuItem data-testid="rename-project" onSelect={onRename}>
            <Pencil className="size-4" aria-hidden="true" />
            Rename
          </DropdownMenuItem>
        )}
        {onRename !== undefined && onDelete !== undefined && <DropdownMenuSeparator />}
        {onDelete !== undefined && (
          <DropdownMenuItem variant="destructive" data-testid="delete-project" onSelect={onDelete}>
            <Trash2 className="size-4" aria-hidden="true" />
            Delete
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A plain left click is the host's to route; anything else — middle click, a
 * modifier, a right click — is the browser's, and the `href` answers it.
 */
function routed(event: MouseEvent<HTMLAnchorElement>, onNavigate: (() => void) | undefined): void {
  if (onNavigate === undefined) return;
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  onNavigate();
}
