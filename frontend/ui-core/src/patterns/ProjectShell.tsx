/**
 * The project's three-column layout, and the breakpoint that collapses it.
 *
 * At `lg` and above: the navigation column, then the content in the same padded,
 * centred column every other page reads in. Below `lg`: the same navigation as
 * a strip above the content. One component is in the DOM at a time — the switch
 * is `matchMedia`, not a hidden duplicate — so a screen reader meets one nav, the
 * column is genuinely absent on a narrow viewport, and a count of filled
 * controls in a browser counts the page rather than the page and its shadow.
 */

import type { JSX, ReactNode } from "react";

import { useViewportAtLeast } from "../annotator/viewportFloor";
import { PaddedContent } from "./PaddedContent";
import { ProjectNav, type ProjectNavProps } from "./ProjectNav";

/** Tailwind's `lg`, the width at which the column earns its pixels. */
export const PROJECT_NAV_MIN_VIEWPORT_PX = 1024;

export type ProjectNavData = Omit<ProjectNavProps, "layout" | "children">;

export interface ProjectShellProps {
  readonly nav: ProjectNavData;
  readonly children: ReactNode;
}

export function ProjectShell({ nav, children }: ProjectShellProps): JSX.Element {
  const wide = useViewportAtLeast(PROJECT_NAV_MIN_VIEWPORT_PX);
  if (!wide) {
    return (
      <PaddedContent>
        <ProjectNav layout="strip" {...nav}>
          {children}
        </ProjectNav>
      </PaddedContent>
    );
  }
  return (
    <div className="flex min-h-full flex-1" data-testid="project-shell">
      <ProjectNav layout="column" {...nav} />
      <div className="min-w-0 flex-1">
        <PaddedContent>{children}</PaddedContent>
      </div>
    </div>
  );
}
