/**
 * The application shell — the workbench: a fixed icon rail on the left, the
 * open-project tabs across the top, the status bar along the bottom, and
 * everything else belongs to the routed page.
 *
 * The rail is **not** inverted. The preset's `menuColor: inverted` reaches
 * dropdown menus, tooltips and the dialog surfaces the popover tokens serve —
 * `ui-core`'s `Menu.tsx`/`Dialog.tsx` wrap those in `dark` — but the sidebar
 * has its own eight-variable family (`sidebar`/`sidebar-foreground`/
 * `sidebar-accent`/`sidebar-border`/…) precisely so a rail can follow the
 * page's theme instead of borrowing the menu treatment. In the light theme
 * that means a **light** rail: `--sidebar` resolves to `oklch(0.985 0 0)`
 * there, a hair off `background`, distinguished by `border-sidebar-border`
 * rather than by inverting. The tabs and the status bar sit on the same tokens,
 * so the chrome reads as one frame around the page.
 *
 * What is on the rail: the mark, Projects, Models, and the account control
 * at the bottom — and nothing else. `Models` is one of them by a settled
 * decision: model connections are workspace infrastructure that every project
 * uses, so they cannot live inside any one project, and the rail is the only
 * workspace-level surface there is. Anything richer growing here is exactly what
 * the **thin-app audit** exists to catch: this file is composition and identity,
 * and a capability that lands in it is one the future enterprise UI cannot reuse.
 *
 * ## The rail collapses, and the change is instant
 *
 * Collapsed (48px, the default) every entry is an icon with its label as the
 * accessible name and the tooltip; expanded (208px) the full logo and the labels
 * show. The choice persists per browser (`railState.ts`, read once in a lazy
 * initializer so the first paint is already the right width) and toggles with
 * ⌘B / Ctrl+B or from the rail's top row: collapsed, the mark itself is the
 * expand button — it turns into the panel icon under the pointer or focus —
 * and expanded, a collapse button sits at the right end of the logo's row.
 *
 * The icons are drawn light — 16px at a 1.5px stroke, the weight of the 13px
 * regular labels beside them — and in the rail's muted ink until hovered or
 * current, so two glyphs on a quiet column do not out-shout the page.
 *
 * The width does **not** animate. A panel somebody flips many times a day is
 * the case where motion is a cost rather than a cue — the keyboard user in
 * particular already knows what the shortcut does — and animating `width`
 * would re-lay out the Images grid and re-fit the annotator on every frame. What
 * keeps the change legible instead is that nothing the eye is holding moves:
 * every icon sits in the same 40px-wide slot in both states and the logo's mark
 * at the same x, so expanding only *adds* labels beside things that stay put.
 *
 * ## The rail is a `<nav>` with real links
 *
 * Not a row of `div onClick`s. A router link is also the thing that makes
 * middle-click and "open in new tab" work — which on a tool people keep two
 * workspaces open in is not a detail.
 *
 * ## The shell renders a bare `<Outlet/>`; a nested layout route decides the pane
 *
 * Most of the product is a list or a form, and a padded, capped column is right
 * for those. A project is that column under its own section toolbar. Both get the
 * workbench frame — tabs above, status bar below. The annotator is neither: it is
 * the one screen somebody sits in front of for an hour, and boxing it costs real
 * pixels — `fitToViewport` derives the zoom from the pane's rect — so it stands
 * outside this shell altogether: the whole viewport, with no rail, no tabs and no
 * status bar. It is left by its own back control.
 *
 * So the choice is a **route**, not a prop and not a `useMatch` here.
 * `PaddedPane`, `ListPane` and `ProjectPane` are the `<main>`s inside the shell
 * and `routes.tsx` puts each screen under the one it wants — which keeps this file
 * composition-only and keeps `ui-core` from fighting the container with negative
 * margins. One `AppShell` sits above all of them in the route tree, so the rail is
 * continuous across panes rather than copies that must be kept identical.
 * `FullBleedPane` is the annotator's own layout route and a *sibling* of
 * `AppShell`, not a child: the rail is the shell's, so a screen without it is a
 * screen outside the shell.
 *
 * ## The document scrolls, and the chrome sticks
 *
 * The page is not boxed into an inner scroller: the document scrolls, the rail
 * and the tabs stick to the top and the status bar to the bottom. A sideways
 * overflow therefore stays a fact about the document — the thing a user drags —
 * which is what the responsive-floor checks measure. The status bar's height is
 * published as `--page-inset-bottom` so a page's own sticky bar (the Classes commit
 * bar) floats above it rather than under it, and the tab strip's as
 * `--page-inset-top`, so a page that fits itself to the window (the Images
 * section) can take exactly the height between them.
 */

import {
  Cpu,
  Folders,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  type LucideIcon,
} from "lucide-react";
import {
  cn,
  PaddedContent,
  PageStatusProvider,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@visionset/ui-core";
import {
  useCallback,
  useEffect,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { NavLink, Outlet } from "react-router";

import { useOssSession } from "../data/OssSession";
import { BrandIcon, BrandLogo } from "./Brand";
import { OpenProjectsProvider, ProjectTabs } from "./ProjectTabs";
import { readRailCollapsed, writeRailCollapsed } from "./railState";
import { StatusBar } from "./StatusBar";

export function AppShell(): JSX.Element {
  // A **lazy initializer**, never an effect: an effect that corrects the width
  // on mount paints the wrong one first, and a rail that visibly snaps on every
  // page load is worse than one that never collapsed.
  const [collapsed, setCollapsed] = useState(readRailCollapsed);

  const toggle = useCallback((): void => {
    setCollapsed((was) => {
      const next = !was;
      writeRailCollapsed(next);
      return next;
    });
  }, []);

  // ⌘B / Ctrl+B, the editor convention. Not while typing: in a field the chord
  // belongs to the field (and nothing in this product binds B).
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (
        event.key.toLowerCase() !== "b" ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey
      )
        return;
      const target = event.target as HTMLElement | null;
      if (
        target !== null &&
        (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) ||
          target.isContentEditable)
      )
        return;
      event.preventDefault();
      toggle();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toggle]);

  return (
    // The rail's labels are tooltips while it is collapsed. One provider: the
    // first label waits long enough not to fire on a pass across the rail, and
    // its neighbours then open at once rather than re-waiting the delay.
    <TooltipProvider delayDuration={500}>
      <div className="flex min-h-screen bg-background">
        <nav
          id="app-rail"
          aria-label="Main"
          data-testid="app-rail"
          data-collapsed={collapsed ? "true" : "false"}
          className={cn(
            // The edge is an overlay rather than a `border-r`: a border would take 1px
            // from the inside, leaving 39px for a 40px control and centring every
            // icon half a pixel off from where it sits when expanded.
            "sticky top-0 z-30 flex h-screen shrink-0 flex-col gap-1 bg-sidebar px-1 pb-1 text-sidebar-foreground after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-sidebar-border",
            collapsed ? "w-rail items-center" : "w-rail-expanded",
          )}
        >
          <Mark collapsed={collapsed} onToggle={toggle} />
          <RailLink
            to="/projects"
            testId="rail-projects"
            label="Projects"
            icon={Folders}
            collapsed={collapsed}
          />
          <RailLink
            to="/models"
            testId="rail-models"
            label="Models"
            icon={Cpu}
            collapsed={collapsed}
          />

          <div className={cn("mt-auto flex flex-col", !collapsed && "w-full")}>
            <SignOut collapsed={collapsed} />
          </div>
        </nav>

        <OpenProjectsProvider>
          <Outlet />
        </OpenProjectsProvider>
      </div>
    </TooltipProvider>
  );
}

/**
 * The workbench frame every pane but the annotator's sits in: the open-project
 * tabs, the page, the status bar — and the slot through which the page writes
 * its own facts into that bar (`PageStatus`). `min-w-0` so a wide table scrolls inside the
 * page instead of pushing the rail off the screen.
 */
function Workbench({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    // 1.75rem is the status bar's `h-7` and 2.25rem the tab strip's `h-9`: the
    // chrome pinned above and below the page, which a page that fits itself to
    // the window (the Images section) reads; see "The document scrolls" above.
    <div className="flex min-w-0 flex-1 flex-col [--page-inset-bottom:1.75rem] [--page-inset-top:2.25rem]">
      {/* The page under the tabs can say its own facts in the status bar. */}
      <PageStatusProvider>
        <ProjectTabs />
        {children}
        <StatusBar />
      </PageStatusProvider>
    </div>
  );
}

/**
 * The pane every list and form gets: padded, and centred in a capped column.
 *
 * The column itself is `ui-core`'s `PaddedContent`, because the project shell
 * draws the same column under its toolbar and the two must not disagree on how
 * wide a page is.
 */
export function PaddedPane(): JSX.Element {
  return (
    <Workbench>
      <main className="min-w-0 flex-1">
        <PaddedContent>
          <Outlet />
        </PaddedContent>
      </main>
    </Workbench>
  );
}

/**
 * The pane a project gets: the whole width under the tabs, with no padding of its
 * own, because the project screen lays out its section toolbar and its content
 * itself (`ProjectShell`) — the toolbar spans the pane, and a padded pane would
 * hold it off by a gutter.
 */
export function ProjectPane(): JSX.Element {
  return (
    <Workbench>
      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
    </Workbench>
  );
}

/**
 * The pane a workspace list gets — Projects, Models: the whole width under the
 * tabs, unpadded and uncapped, because a list is a full-bleed table
 * (`ui-core`'s `ListPage`) whose header, toolbar and grid run edge to edge and
 * set their own inset. A capped, padded column would put a gutter and a frame
 * around a grid that is meant to be the page.
 */
export function ListPane(): JSX.Element {
  return (
    <Workbench>
      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
    </Workbench>
  );
}

/**
 * The layout the editing surface gets: the whole viewport, and nothing else.
 *
 * It is a sibling of `AppShell` in the route tree, so there is no rail, no tabs
 * and no status bar — and no `⌘B` chord, since that belongs to the rail. Nothing
 * the annotator renders reads a context only the shell provides (the tooltip
 * provider is the app root's), so there is nothing to re-provide here.
 *
 * `h-screen` rather than `min-h-screen` or `flex-1`: pinning the height is what
 * makes "nothing scrolls the document" structural — the only thing with
 * `overflow` is the canvas pane inside.
 */
export function FullBleedPane(): JSX.Element {
  return (
    <main className="h-screen w-full min-w-0 overflow-hidden bg-background">
      <Outlet />
    </main>
  );
}

/**
 * The rail's top row: the product's identity and the collapse toggle.
 *
 * Collapsed, the mark *is* the toggle — one 48px column has no room for a
 * second control, and a toggle parked at the bottom was a long way from the
 * edge it changes. Under the pointer or focus the mark cross-fades into the
 * panel icon, so the button says what it does at the moment it can be pressed.
 * Expanded, the full logo leads and the collapse button sits at the row's right
 * end, beside the edge that moves. Drawn by `Brand.tsx`, the one place the brand
 * colour is read; the full name is the mark's accessible name either way.
 *
 * The row is the tab strip's height and carries its hairline across the rail,
 * so the frame's top edge is one line and the mark sits on the tabs' centre
 * line. `-mb-1` cancels the rail's gap once, so the first entry lands on the
 * section toolbar's row, centre for centre. `pl-4` puts the logo's mark at the
 * same x the centred icon has in 48px, so it does not move.
 */
function Mark({
  collapsed,
  onToggle,
}: {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}): JSX.Element {
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  const keys = shortcutLabel();
  const toggle = {
    type: "button" as const,
    "data-testid": "rail-collapse",
    "aria-label": label,
    "aria-expanded": !collapsed,
    "aria-controls": "app-rail",
    "aria-keyshortcuts": "Meta+B Control+B",
    onClick: onToggle,
  };
  return (
    <div
      className={cn(
        "-mx-1 -mb-1 flex h-9 w-[calc(100%+0.5rem)] shrink-0 items-center border-b border-sidebar-border",
        collapsed ? "justify-center" : "pr-1.5 pl-4",
      )}
    >
      {collapsed ? (
        <ToggleTip label={label} keys={keys}>
          <button {...toggle} className={cn(TOGGLE, "group size-8")}>
            {/* Both glyphs stay mounted on one grid cell and cross-fade, so the
                swap can reverse mid-way when the pointer leaves early. */}
            <BrandIcon
              testId="rail-mark"
              className={cn(
                SWAP,
                "h-5 w-auto group-hover:scale-25 group-hover:opacity-0 group-hover:blur-[4px]",
                "group-focus-visible:scale-25 group-focus-visible:opacity-0 group-focus-visible:blur-[4px]",
              )}
            />
            <PanelLeftOpen
              aria-hidden="true"
              strokeWidth={1.5}
              className={cn(
                SWAP,
                "size-4 scale-25 opacity-0 blur-[4px] group-hover:scale-100 group-hover:opacity-100 group-hover:blur-[0px]",
                "group-focus-visible:scale-100 group-focus-visible:opacity-100 group-focus-visible:blur-[0px]",
              )}
            />
          </button>
        </ToggleTip>
      ) : (
        <>
          <BrandLogo
            testId="rail-mark"
            className="h-5 w-auto shrink-0 text-sidebar-foreground"
          />
          <ToggleTip label={label} keys={keys}>
            <button {...toggle} className={cn(TOGGLE, "ml-auto size-7")}>
              <PanelLeftClose
                aria-hidden="true"
                strokeWidth={1.5}
                className="size-4"
              />
            </button>
          </ToggleTip>
        </>
      )}
    </div>
  );
}

/**
 * The toggle's look in both states: quiet ink, the rail's hover fill, and a
 * hit area grown to the row's full 36px height and a 40px width by a
 * pseudo-element, so a 28–32px glyph button is not a small target — and stops
 * at the row's hairline, short of the first entry's own hit area.
 */
const TOGGLE = cn(
  "relative grid shrink-0 place-items-center rounded-md text-sidebar-foreground/60 outline-none",
  "before:absolute before:top-1/2 before:left-1/2 before:h-9 before:w-10 before:-translate-x-1/2 before:-translate-y-1/2",
  "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
);

/**
 * One glyph of the collapsed mark's swap: the shared cell and the transition.
 * Exactly the three properties that change, on the house curve; reduced motion
 * keeps the swap and drops the movement.
 */
const SWAP = cn(
  "[grid-area:1/1] shrink-0 blur-[0px]",
  "transition-[opacity,scale,filter] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none",
);

/** The toggle's tooltip: its name and the chord, in both states — it is an icon either way. */
function ToggleTip({
  label,
  keys,
  children,
}: {
  readonly label: string;
  readonly keys: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">
        {label} <span className="ml-1 opacity-60">{keys}</span>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * One rail control's geometry and states, shared by every entry.
 *
 * 36px tall, and 40px wide when collapsed, with the hit area grown to a 40px
 * pitch by a `::before` that reaches into the rail's 4px gap — the dense-desktop
 * floor without rows that sprawl. The icon always sits in its own 40px-wide slot
 * (`RailItem`), so it is at the same x in both states. A plain string rather
 * than `buttonVariants`: Nova's sizes key off `data-size`, which only `Button`
 * sets, and the active state reads `aria-current`, which `NavLink` sets, so no
 * function `className` is needed — a function `className` is what
 * `TooltipTrigger asChild` silently drops when it merges its own. No colour
 * transition: the rail is crossed constantly, and hover feedback that lags a
 * moving pointer reads as lag.
 */
function railControl(collapsed: boolean): string {
  return cn(
    "relative flex h-9 shrink-0 items-center rounded-md text-[13px] text-sidebar-foreground/60 outline-none",
    "before:absolute before:inset-x-0 before:-inset-y-0.5",
    "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
    "aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-sidebar-accent-foreground",
    // A square button shrinks a touch on press, so the click registers; a
    // 200px row does not — at the same scale its edges would travel 3–4px.
    collapsed
      ? "w-10 transition-transform duration-100 ease-out active:scale-[0.96] motion-reduce:transition-none"
      : "w-full pr-2",
  );
}

/** The icon slot and, expanded, the label beside it. */
function RailItem({
  icon: Icon,
  label,
  collapsed,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly collapsed: boolean;
}): JSX.Element {
  return (
    <>
      <span className="grid h-9 w-10 shrink-0 place-items-center">
        <Icon className="size-4" strokeWidth={1.5} aria-hidden="true" />
      </span>
      {!collapsed && (
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      )}
    </>
  );
}

/**
 * The label a collapsed rail icon carries, beside it on hover and focus. When
 * expanded the label is already on screen, and a tooltip repeating it is noise.
 */
function RailTip({
  label,
  collapsed,
  children,
}: {
  readonly label: ReactNode;
  readonly collapsed: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  if (!collapsed) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function RailLink({
  to,
  testId,
  label,
  icon,
  collapsed,
}: {
  readonly to: string;
  readonly testId: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly collapsed: boolean;
}): JSX.Element {
  return (
    <RailTip label={label} collapsed={collapsed}>
      {/* An active item is `sidebar-accent`/`sidebar-accent-foreground` — a
          pairing chosen to stay legible against `sidebar` in *either* theme —
          and an inactive one is the rail's own foreground at reduced opacity. */}
      <NavLink
        to={to}
        data-testid={testId}
        aria-label={label}
        className={railControl(collapsed)}
      >
        <RailItem icon={icon} label={label} collapsed={collapsed} />
      </NavLink>
    </RailTip>
  );
}

/** "⌘B" on Apple platforms, "Ctrl+B" elsewhere — the chord as the keyboard spells it. */
function shortcutLabel(): string {
  const platform = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return /Mac|iPhone|iPad/.test(platform) ? "⌘B" : "Ctrl+B";
}

/**
 * Sign out — the rail's account slot, and the only *action* on it.
 *
 * There is nobody to draw an avatar for: VisionSet has no accounts, only a
 * workspace credential, so the honest control is the one that forgets it.
 *
 * **The label follows which credential is in use, because "sign out" is a lie
 * about one of them.** A browser session is issued by the server to the page it
 * served, and this button cannot delete a cookie it cannot read: what it does is
 * stop using it *here*, and a reload signs you back in — which is correct on the
 * machine serving your own files, and would be a broken sign-out button anywhere
 * else. So on a session it says what it actually does, and it is the way to the
 * token form for somebody who wants to reach a different workspace.
 */
function SignOut({ collapsed }: { readonly collapsed: boolean }): JSX.Element {
  const { access, signOut } = useOssSession();
  const label = access === "session" ? "Use a token" : "Sign out";
  return (
    <RailTip label={label} collapsed={collapsed}>
      <button
        type="button"
        data-testid="rail-sign-out"
        aria-label={label}
        onClick={signOut}
        className={railControl(collapsed)}
      >
        <RailItem icon={LogOut} label={label} collapsed={collapsed} />
      </button>
    </RailTip>
  );
}
