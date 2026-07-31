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
 */

import { useApiSession } from "@visionset/ui-core";
import { FolderGit2, Home, LogOut, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useState, type JSX, type ReactNode } from "react";
import { NavLink, Outlet } from "react-router";

export function AppShell(): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);

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
              Robomous <span className="text-primary">VisionSet</span>
            </span>
          )}
          <RailButton
            testId="rail-collapse"
            label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setCollapsed((open) => !open)}
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

      {/* `min-w-0` so a wide table scrolls inside the pane instead of pushing the
          rail off the screen — the one flex rule this layout would be wrong
          without. */}
      <main className="min-w-0 flex-1 px-4 py-6 md:px-6">
        <div className="mx-auto max-w-7xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

/**
 * Sign out — the rail's account slot, and the only *action* on it.
 *
 * `DESIGN.md` draws an avatar here. There is nobody to draw: VisionSet has no
 * accounts, only a workspace token, so the honest control is the one that forgets
 * it. An avatar with no identity behind it would be chrome pretending to be a
 * feature.
 */
function SignOut({ collapsed }: { readonly collapsed: boolean }): JSX.Element {
  const { signOut } = useApiSession();
  return (
    <RailButton testId="rail-sign-out" label="Sign out" onClick={signOut} wide={!collapsed}>
      <LogOut className="size-4 shrink-0" aria-hidden="true" />
      {!collapsed && <span className="truncate">Sign out</span>}
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
      className={({ isActive }) =>
        `flex items-center gap-2 rounded-md px-2 py-2 text-body ${
          isActive ? "bg-primary text-primary-foreground" : "hover:bg-sidebar-accent"
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
      className={`flex items-center gap-2 rounded-md px-2 py-2 text-body hover:bg-sidebar-accent ${
        wide === true ? "w-full" : ""
      }`}
    >
      {children}
    </button>
  );
}
