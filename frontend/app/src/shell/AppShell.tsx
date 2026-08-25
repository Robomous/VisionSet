/**
 * The application shell: a slim rail on the standard sidebar tokens, and
 * everything else belongs to the routed page.
 *
 * The rail is **not** inverted. The preset's `menuColor: inverted` reaches
 * dropdown menus, tooltips and the dialog surfaces the popover tokens serve —
 * `ui-core`'s `Menu.tsx`/`Dialog.tsx` wrap those in `dark` — but the sidebar
 * has its own eight-variable family (`sidebar`/`sidebar-foreground`/
 * `sidebar-accent`/`sidebar-border`/…) precisely so a rail can follow the
 * page's theme instead of borrowing the menu treatment. In the light theme
 * that means a **light** rail, not the near-black one this file used to draw:
 * `--sidebar` resolves to `oklch(0.985 0 0)` there, a hair off `background`,
 * distinguished by `border-sidebar-border` rather than by inverting.
 *
 * `DESIGN.md` is explicit about what is on it — logo, collapse toggle, Home,
 * Projects, Models, and the account control at the bottom — and about what is
 * not. `Models` is one of them by a settled decision:
 * model connections are workspace infrastructure that every
 * project uses, so they cannot live inside any one project, and the rail is the
 * only workspace-level surface there is.
 * Anything richer growing here is exactly what the **thin-app audit** exists to
 * catch: this file is composition and identity, and a capability that lands in it
 * is one the future enterprise UI cannot reuse.
 *
 * ## It starts collapsed, and the answer lives in one place
 *
 * `readRailCollapsed` is the whole decision: collapsed unless a stored
 * preference says otherwise. It is in `ui-core` rather than inline here because a
 * default spelled at a call site is a default that gets spelled twice, and because
 * a module is testable where a `useState` argument is not.
 *
 * The state is read once, in a **lazy initializer**. An effect that corrected the
 * width on mount would paint the wrong one first, and a rail that visibly snaps
 * narrow on every page load is worse than one that never collapsed — which is the
 * shape an effect that measures too late always has.
 *
 * ## Why the collapsed width is a token
 *
 * 240px / 48px are in `ui-core`'s `@theme` rather than here, because three
 * things have to agree on them — the rail, the toggle and the content offset — and
 * `DESIGN.md` calls them "a single source of truth" for that reason. A grid
 * template reading `w-sidebar` cannot drift from a rail that *is* `w-sidebar`.
 * Collapsed, the rail is the preset's icon-sidebar width: `p-2` around one
 * `size-8` control per row, so an icon is centred because nothing else fits.
 *
 * ## The rail is a `<nav>` with a real list, and the links are `<NavLink>`s
 *
 * Not a row of `div onClick`s. `DESIGN.md`'s accessibility principle asks for real
 * elements, and a router link is also the thing that makes middle-click and
 * "open in new tab" work — which on a tool people keep two workspaces open in is
 * not a detail.
 *
 * `end` on the Home link is load-bearing: without it, `NavLink` treats `/` as a
 * prefix of every route and Home is permanently active.
 *
 * ## The shell renders a bare `<Outlet/>`; a nested layout route decides the pane
 *
 * Most of the product is a list or a form, and a padded, capped column is right
 * for those. A project is that column beside its own navigation. The annotator
 * is neither: it is the one screen somebody sits in
 * front of for an hour, and boxing it costs real pixels — `fitToViewport` derives
 * the zoom from the pane's rect, so a shrunken pane opens every asset smaller than
 * it needs to and applies the tolerance constants at a zoom nobody chose.
 *
 * So the choice is a **route**, not a prop and not a `useMatch` here. `PaddedPane`,
 * `ProjectPane` and `FullBleedPane` are the three `<main>`s, and `routes.tsx` puts
 * each screen under the one it wants — which keeps this file composition-only, exactly as
 * the thin-app rule asks, and keeps `ui-core` from fighting the container with
 * negative margins.
 *
 * **The panes are nested inside this one layout route, and the reason is not the
 * one it looks like.** The obvious argument — two sibling shells would each own a
 * `collapsed` state, so opening an asset would re-expand a rail the user had
 * collapsed — was tried and is **false**: React reconciles two sibling
 * `<Route element={<AppShell />}>` branches into the same instance, and the state
 * survives either way. Measured, not assumed.
 *
 * What nesting actually buys is that there is one `AppShell` in the route tree
 * instead of two that must be kept identical, and that the rail's continuity does
 * not quietly depend on a reconciliation nobody wrote down. The behaviour itself
 * is asserted in `e2e/annotate.spec.ts` regardless of the structure, which is the
 * right level for it.
 */

import { Cpu, Folders, House, LogOut, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import {
  Button,
  buttonVariants,
  cn,
  PaddedContent,
  readRailCollapsed,
  useApiSession,
  writeRailCollapsed,
} from "@visionset/ui-core";
import { useState, type JSX, type ReactNode } from "react";
import { NavLink, Outlet } from "react-router";

export function AppShell(): JSX.Element {
  // A **lazy initializer**, never an effect: an effect that corrects the
  // width on mount paints the wrong one first, and a rail that visibly snaps
  // narrow on every page load is worse than one that never collapsed.
  const [collapsed, setCollapsed] = useState(readRailCollapsed);

  function toggle(): void {
    setCollapsed((open) => {
      const next = !open;
      writeRailCollapsed(next);
      return next;
    });
  }

  return (
    <div className="flex min-h-screen bg-background">
      <nav
        aria-label="Main"
        data-testid="app-rail"
        data-collapsed={collapsed ? "true" : "false"}
        className={cn(
          "flex shrink-0 flex-col gap-1 border-r border-sidebar-border bg-sidebar p-2 text-sidebar-foreground",
          collapsed ? "w-sidebar-collapsed" : "w-sidebar",
        )}
      >
        <div
          className={cn(
            "flex items-center py-2",
            collapsed ? "justify-center" : "justify-between gap-2 px-1",
          )}
        >
          {!collapsed && (
            <span className="truncate text-base font-semibold">
              {/* The wordmark, and one of only two places `brand` is allowed. */}
              Robomous <span className="text-brand">VisionSet</span>
            </span>
          )}
          <RailButton
            testId="rail-collapse"
            label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={toggle}
          >
            {collapsed ? (
              <PanelLeftOpen aria-hidden="true" />
            ) : (
              <PanelLeftClose aria-hidden="true" />
            )}
          </RailButton>
        </div>

        <RailLink to="/" end collapsed={collapsed} testId="rail-home" label="Home">
          <House aria-hidden="true" />
        </RailLink>
        <RailLink to="/projects" collapsed={collapsed} testId="rail-projects" label="Projects">
          <Folders aria-hidden="true" />
        </RailLink>
        <RailLink to="/models" collapsed={collapsed} testId="rail-models" label="Models">
          <Cpu aria-hidden="true" />
        </RailLink>

        <div className="mt-auto">
          <SignOut collapsed={collapsed} />
        </div>
      </nav>

      <Outlet />
    </div>
  );
}

/**
 * The pane every list and form gets: padded, and centred in a capped column.
 *
 * The column itself is `ui-core`'s `PaddedContent`, because the project shell
 * draws the same column beside its navigation and the two must not disagree on
 * how wide a page is. `min-w-0` so a wide table scrolls inside the pane instead
 * of pushing the rail off the screen — the one flex rule this layout would be
 * wrong without.
 */
export function PaddedPane(): JSX.Element {
  return (
    <main className="min-w-0 flex-1">
      <PaddedContent>
        <Outlet />
      </PaddedContent>
    </main>
  );
}

/**
 * The pane a project gets: the whole width beside the rail, with no padding of
 * its own, because the project screen lays out its navigation column and its
 * content itself (`ProjectShell`) — the column has to start at the rail's edge,
 * and a padded pane would hold it off by a gutter.
 */
export function ProjectPane(): JSX.Element {
  return (
    <main className="flex min-w-0 flex-1">
      <Outlet />
    </main>
  );
}

/**
 * The pane the editing surface gets: the whole viewport beside the rail.
 *
 * No cap, no padding, and `h-screen` rather than `flex-1` — a flex item stretches
 * to its *row*, and the row is `min-h-screen`, so a page taller than the window
 * would drag the rail down with it. Pinning the height here is what makes
 * "nothing scrolls the document" structural: the only thing with `overflow` is
 * the canvas pane inside.
 */
export function FullBleedPane(): JSX.Element {
  return (
    <main className="h-screen min-w-0 flex-1 overflow-hidden">
      <Outlet />
    </main>
  );
}

/**
 * Sign out — the rail's account slot, and the only *action* on it.
 *
 * `DESIGN.md` draws an avatar here. There is nobody to draw: VisionSet has no
 * accounts, only a workspace credential, so the honest control is the one that
 * forgets it. An avatar with no identity behind it would be chrome pretending to
 * be a feature.
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
  const { access, signOut } = useApiSession();
  const label = access === "session" ? "Use a token" : "Sign out";
  return (
    <RailButton testId="rail-sign-out" label={label} onClick={signOut} wide={!collapsed}>
      <LogOut aria-hidden="true" />
      {!collapsed && <span className="truncate">{label}</span>}
    </RailButton>
  );
}

function RailLink({
  to,
  end,
  collapsed,
  testId,
  label,
  children,
}: {
  readonly to: string;
  readonly end?: boolean;
  readonly collapsed: boolean;
  readonly testId: string;
  readonly label: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <NavLink
      to={to}
      end={end ?? false}
      data-testid={testId}
      title={collapsed ? label : undefined}
      // The rail follows the standard sidebar tokens now, the same ones a
      // consuming app's own theme would resolve: an active item is
      // `sidebar-accent`/`sidebar-accent-foreground` — a pairing chosen to
      // stay legible against `sidebar` in *either* theme, rather than a fixed
      // light-on-dark contrast — and an inactive one is the rail's own
      // foreground at reduced opacity, `sidebar-foreground/70`. `NavLink`
      // keeps its function `className` here — `Button asChild` cannot merge
      // one — so the geometry comes from `buttonVariants` directly.
      className={({ isActive }) =>
        cn(
          buttonVariants({ variant: "ghost", size: "md" }),
          "w-full justify-start gap-2 px-2 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground dark:hover:bg-sidebar-accent",
          collapsed && "justify-center",
          isActive &&
            "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
        )
      }
    >
      {children}
      {!collapsed && <span className="truncate">{label}</span>}
    </NavLink>
  );
}

function RailButton({
  testId,
  label,
  onClick,
  wide,
  children,
}: {
  readonly testId: string;
  readonly label: string;
  readonly onClick: () => void;
  readonly wide?: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <Button
      variant="ghost"
      size={wide === true ? "md" : "icon"}
      data-testid={testId}
      aria-label={label}
      title={label}
      onClick={onClick}
      // The rail keeps its own palette — sidebar tokens, not the pane's —
      // and `/70` for chrome, exactly as before; geometry now comes from
      // the primitive, which also brings the focus ring these controls
      // never had.
      className={cn(
        "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground dark:hover:bg-sidebar-accent",
        wide === true && "w-full justify-start gap-2 px-2",
      )}
    >
      {children}
    </Button>
  );
}
