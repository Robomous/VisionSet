/**
 * Where you are inside a project, and what the open section offers. The
 * project's identity is the open-project tab above, not a line here.
 *
 * ## One component, two layouts
 *
 * At `lg` and above it is a **bar** across the top of the project's pane, 48px:
 * one tab per section with its count, one line about the open section after a
 * hairline divider, then the section's actions and the overflow. It is the
 * section's header — sections draw none of their own — and it spans the pane
 * rather than the capped column so it lines up with the open-project tabs. Below
 * `lg` the same data is a **strip**: the actions and the overflow on a row, the
 * tab list under it, the content in the panel beneath. `ProjectShell` picks the
 * layout; this component draws whichever it is handed, so the items, icons and
 * labels are spelled once.
 *
 * ## Nothing in the bar moves when the section changes
 *
 * A tab's label reserves its medium-weight width underneath, so opening it
 * changes its weight and not its size; the counts arrive together, once all
 * have answered (`ProjectFrame`), and are tabular. The line about the section
 * truncates in the space left, and the actions sit at the far end.
 *
 * ## It is navigation, so the items are links
 *
 * `ui-core` imports no router. The host spells every URL through `hrefFor` and
 * turns the click into a route change through `onNavigate`; the `<a>` is what
 * keeps middle-click and "open in new tab" working. A host with no URLs to
 * spell still gets working items, as buttons. The open section is marked with
 * `aria-current="page"` as well as its rule and weight, because a visual cue is
 * never the only signal.
 *
 * ## The actions are the open section's
 *
 * Add images is a button where images are the subject (`ingest: "action"`,
 * Images) and the overflow's first entry on the sections that are about
 * something else (Classes, Dataset), one click from either. The Overview hands
 * the bar none: its Add images and Annotate sit in the batches band, beside the
 * batches they act on (`BatchesActions`). A section's own actions (Add class,
 * Publish release) are rendered by the section, where their dialogs live, into
 * this bar's `SectionActionsOutlet`. Every icon is 14px at the stroke of 12px
 * medium text, and `data-icon` takes 2px off the padding on its side: an icon
 * carries air in its box that equal padding would read as extra.
 *
 * ## The rail it is not
 *
 * The rail is the workspace's top-level destinations on the `sidebar-*` tokens.
 * This bar belongs to one project and reads as part of the page: `background`
 * and a hairline, no `sidebar-*` token anywhere in it.
 */

import { Database, Grid3x3, ImagePlus, Images, MoreHorizontal, Tags, TextCursorInput, Trash2, type LucideIcon } from "lucide-react";
import type { JSX, MouseEvent, ReactNode } from "react";

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@robomous/ui-core";

import { formatCount } from "../lib/format";
import { isProjectSection, type ProjectSection } from "./projectSections";
import { IconAction } from "./IconAction";
import { SectionActionsOutlet } from "./SectionActions";

interface SectionLabel {
  readonly label: string;
  readonly icon: LucideIcon;
}

/**
 * One tab of the bar. 13px, like the open-project tabs above: the bar is
 * chrome, a step below the page's 14px. The open tab is ink, weight and a 2px
 * rule laid on the bar's own hairline; the rest are muted and answer the
 * pointer with ink alone, at once. Focus rings the tab's content, not the
 * bar-tall hit area, so the ring is the size of the thing it names.
 */
const TAB =
  "group/tab relative flex shrink-0 items-center text-[13px] whitespace-nowrap text-muted-foreground outline-none " +
  "hover:text-foreground aria-[current=page]:text-foreground " +
  "after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full aria-[current=page]:after:bg-foreground";

const TAB_FACE =
  "flex items-center gap-2 rounded-md px-1.5 py-1 -mx-1.5 group-focus-visible/tab:ring-2 group-focus-visible/tab:ring-ring";

const SECTION_LABELS: Record<ProjectSection, SectionLabel> = {
  overview: { label: "Overview", icon: Grid3x3 },
  images: { label: "Assets", icon: Images },
  schema: { label: "Classes", icon: Tags },
  dataset: { label: "Dataset", icon: Database },
};

export interface ProjectNavProps {
  readonly layout: "bar" | "strip";
  /**
   * How much each section holds, beside its name. Given whole or not at all:
   * the frame hands it over once every count has answered, so the tabs widen
   * once rather than three times as three queries land.
   */
  readonly counts?: Partial<Record<ProjectSection, number>>;
  /** One line about the open section, after the tabs — the section header, folded into the bar. */
  readonly meta?: ReactNode;
  /**
   * Add images as a button (Images, where images are the subject) or as the
   * first entry of the overflow (Classes, Dataset), so it is reachable without
   * crowding the sections it is not about.
   */
  readonly ingest?: "action" | "menu";
  /** The sections on offer, in display order. */
  readonly sections: readonly ProjectSection[];
  /** The open section, or the one the page belongs to; `null` lights nothing. */
  readonly active: ProjectSection | null;
  /** The URL of a section, spelled by the host. Absent renders the items as buttons. */
  readonly hrefFor?: (section: ProjectSection) => string;
  readonly onNavigate: (section: ProjectSection) => void;
  readonly onIngest?: () => void;
  readonly onRename?: () => void;
  readonly onDelete?: () => void;
  /** The strip layout's content: below `lg` the tab bar owns the panel beneath it. */
  readonly children?: ReactNode;
}

export function ProjectNav(props: ProjectNavProps): JSX.Element {
  return props.layout === "bar" ? <Bar {...props} /> : <Strip {...props} />;
}

function Bar(props: ProjectNavProps): JSX.Element {
  const { sections, active, hrefFor, onNavigate, counts, meta } = props;
  return (
    <nav
      aria-label="Project"
      data-testid="project-nav"
      // `px-6` is the content column's gutter: the first tab's icon, the meta
      // line and the last action sit on the same verticals as the page below.
      className="flex h-12 shrink-0 items-center gap-4 border-b bg-background px-6"
    >
      <ul className="flex h-full shrink-0 items-stretch gap-5">
        {sections.map((section) => {
          const { label: name, icon: Icon } = SECTION_LABELS[section];
          const current = section === active;
          const shared = {
            "data-testid": `nav-${section}`,
            "aria-current": current ? ("page" as const) : undefined,
            className: TAB,
          };
          const face = (
            <span className={TAB_FACE}>
              <Icon className="size-4 shrink-0" strokeWidth={current ? 1.75 : 1.5} aria-hidden="true" />
              <SteadyLabel text={name} />
              <Count value={counts?.[section]} />
            </span>
          );
          return (
            <li key={section} className="flex">
              {hrefFor === undefined ? (
                <button type="button" {...shared} onClick={() => onNavigate(section)}>
                  {face}
                </button>
              ) : (
                <a {...shared} href={hrefFor(section)} onClick={(event) => routed(event, () => onNavigate(section))}>
                  {face}
                </a>
              )}
            </li>
          );
        })}
      </ul>
      {meta !== undefined && meta !== null && meta !== "" ? (
        <>
          <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border" />
          <p
            className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground tabular-nums"
            data-testid="section-meta"
            // The whole line on hover, for the one that truncates.
            {...(typeof meta === "string" ? { title: meta } : {})}
          >
            {meta}
          </p>
        </>
      ) : (
        <span className="flex-1" />
      )}
      <div className="flex shrink-0 items-center gap-2">
        <SectionActionsOutlet />
        <Cta {...props} />
        <Overflow {...props} />
      </div>
    </nav>
  );
}

/**
 * A label that keeps its width when its weight changes: the medium cut is laid
 * invisibly under the regular one, so the open tab is no wider than it was
 * closed and nothing after it moves when the section changes.
 */
function SteadyLabel({ text }: { readonly text: string }): JSX.Element {
  return (
    // The medium copy is a pseudo-element, hidden from sight and from assistive
    // technology alike, so the tab's text and name stay one word.
    <span
      data-text={text}
      className="grid after:invisible after:font-medium after:content-[attr(data-text)] after:[grid-area:1/1]"
    >
      <span className="[grid-area:1/1] group-aria-[current=page]/tab:font-medium">{text}</span>
    </span>
  );
}

/** A section's size: quieter than its name, and digits that do not jostle as it changes. */
function Count({ value }: { readonly value: number | undefined }): JSX.Element | null {
  if (value === undefined) return null;
  return <span className="text-xs text-muted-foreground tabular-nums">{formatCount(value)}</span>;
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
        <SectionActionsOutlet />
        <Cta {...props} />
        <Overflow {...props} />
      </div>
      <div className="min-w-0 overflow-x-auto pb-1.5 -mb-1.5">
        <TabsList variant="line" className="w-full justify-start border-b">
          {sections.map((section) => {
            const { label, icon: Icon } = SECTION_LABELS[section];
            return (
              <TabsTrigger key={section} value={section} data-testid={`nav-${section}`}>
                <Icon className="size-4" strokeWidth={1.5} aria-hidden="true" />
                {label}
                <Count value={props.counts?.[section]} />
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

/**
 * Icons on the bar's actions: 14px beside 12px medium text, at the stroke that
 * matches that weight. `data-icon` takes 2px off the padding on the icon's side
 * — an icon carries air inside its box, and equal padding reads heavier there.
 */

/**
 * Add images, as an icon button named by its tooltip (`IconAction`) — the one
 * filled control in the bar, where it is drawn at all (`ingest: "action"`).
 */
function Cta({ onIngest, ingest = "action" }: ProjectNavProps): JSX.Element | null {
  if (onIngest === undefined || ingest === "menu") return null;
  return <IconAction icon={ImagePlus} label="Add images" variant="default" data-testid="go-ingest" onClick={onIngest} />;
}

function Overflow({ onRename, onDelete, onIngest, ingest = "action" }: ProjectNavProps): JSX.Element | null {
  const addImages = ingest === "menu" ? onIngest : undefined;
  if (onRename === undefined && onDelete === undefined && addImages === undefined) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-lg" aria-label="Project actions" data-testid="project-menu">
          <MoreHorizontal className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {addImages !== undefined && (
          <>
            <DropdownMenuItem data-testid="menu-ingest" onSelect={addImages}>
              <ImagePlus aria-hidden="true" />
              Add images
            </DropdownMenuItem>
            {(onRename !== undefined || onDelete !== undefined) && <DropdownMenuSeparator />}
          </>
        )}
        {onRename !== undefined && (
          <DropdownMenuItem data-testid="rename-project" onSelect={onRename}>
            <TextCursorInput aria-hidden="true" />
            Rename
          </DropdownMenuItem>
        )}
        {onRename !== undefined && onDelete !== undefined && <DropdownMenuSeparator />}
        {onDelete !== undefined && (
          <DropdownMenuItem variant="destructive" data-testid="delete-project" onSelect={onDelete}>
            <Trash2 aria-hidden="true" />
            Delete project
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
