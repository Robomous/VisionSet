/**
 * The application shell: a slim dark rail, and everything else belongs to the
 * routed page.
 *
 * `DESIGN.md` is explicit about what is on it — logo, collapse toggle, Home,
 * Projects, and the account control at the bottom — and about what is not.
 * Anything richer growing here is exactly what the **thin-app audit** exists to
 * catch: this file is composition and identity, and a capability that lands in it
 * is one the future enterprise UI cannot reuse.
 *
 * ## It starts collapsed, and the answer lives in one place
 *
 * `readRailCollapsed` (#200) is the whole decision: collapsed unless a stored
 * preference says otherwise. It is in `ui-core` rather than inline here because a
 * default spelled at a call site is a default that gets spelled twice, and because
 * a module is testable where a `useState` argument is not.
 *
 * The state is read once, in a **lazy initializer**. An effect that corrected the
 * width on mount would paint the wrong one first, and a rail that visibly snaps
 * narrow on every page load is worse than one that never collapsed — which is the
 * shape #159's defect had, one screen over.
 *
 * ## Why the collapsed width is a token
 *
 * 240px / 60px / 280px are in `ui-core`'s `@theme` rather than here, because three
 * things have to agree on them — the rail, the toggle and the content offset — and
 * `DESIGN.md` calls them "a single source of truth" for that reason. A grid
 * template reading `w-sidebar` cannot drift from a rail that *is* `w-sidebar`.
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
 * Most of the product is a list or a form, and a padded `max-w-7xl` column is
 * right for those. The annotator is not: it is the one screen somebody sits in
 * front of for an hour, and boxing it costs real pixels — `fitToViewport` derives
 * the zoom from the pane's rect, so a shrunken pane opens every asset smaller than
 * it needs to and applies the tolerance constants at a zoom nobody chose (#183).
 *
 * So the choice is a **route**, not a prop and not a `useMatch` here. `PaddedPane`
 * and `FullBleedPane` are the two `<main>`s, and `routes.tsx` puts each screen
 * under the one it wants — which keeps this file composition-only, exactly as
 * #58's thin-app rule asks, and keeps `ui-core` from fighting the container with
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

import { readRailCollapsed, useApiSession, writeRailCollapsed } from "@visionset/ui-core";
import { FolderGit2, Home, LogOut, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useState, type JSX, type ReactNode } from "react";
import { NavLink, Outlet } from "react-router";

export function AppShell(): JSX.Element {
  // A **lazy initializer**, never an effect (#200): an effect that corrects the
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
        className={`flex shrink-0 flex-col gap-1 bg-sidebar p-2 text-sidebar-foreground ${
          collapsed ? "w-sidebar-collapsed" : "w-sidebar"
        }`}
      >
        <div className="flex items-center justify-between gap-2 px-1 py-2">
          {!collapsed && (
            <span className="truncate text-section font-semibold">
              {/* The wordmark, and one of only two places `brand` is allowed (#323). */}
              Robomous <span className="text-brand">VisionSet</span>
            </span>
          )}
          <RailButton
            testId="rail-collapse"
            label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={toggle}
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4" aria-hidden="true" />
            ) : (
              <PanelLeftClose className="size-4" aria-hidden="true" />
            )}
          </RailButton>
        </div>

        <RailLink to="/" end collapsed={collapsed} testId="rail-home" label="Home">
          <Home className="size-4 shrink-0" aria-hidden="true" />
        </RailLink>
        <RailLink to="/projects" collapsed={collapsed} testId="rail-projects" label="Projects">
          <FolderGit2 className="size-4 shrink-0" aria-hidden="true" />
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
 * The pane every list and form gets: padded, and capped at `max-w-7xl`.
 *
 * `min-w-0` so a wide table scrolls inside the pane instead of pushing the rail
 * off the screen — the one flex rule this layout would be wrong without.
 */
export function PaddedPane(): JSX.Element {
  return (
    <main className="min-w-0 flex-1 px-4 py-6 md:px-6">
      <div className="mx-auto max-w-7xl">
        <Outlet />
      </div>
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
      <LogOut className="size-4 shrink-0" aria-hidden="true" />
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
      // The active item was `bg-primary`, which #323 made the *same near-black as
      // the rail itself* — an active item that vanishes into its own background.
      // The rail carries its own contrast now: a lifted fill and white ink for
      // active, `sidebar-muted` for the rest, so the distinction survives inside
      // a dark surface instead of borrowing a colour meant for a bright one.
      className={({ isActive }) =>
        `flex items-center gap-2 rounded-md px-2 py-2 text-body ${
          isActive
            ? "bg-sidebar-accent font-medium text-sidebar-foreground"
            : "text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground"
        }`
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
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      onClick={onClick}
      // `sidebar-muted` like an inactive link: the collapse toggle and sign-out
      // are chrome, and nothing on the rail is permanently at full contrast
      // except the item you are on.
      className={`flex items-center gap-2 rounded-md px-2 py-2 text-body text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground ${
        wide === true ? "w-full" : ""
      }`}
    >
      {children}
    </button>
  );
}
