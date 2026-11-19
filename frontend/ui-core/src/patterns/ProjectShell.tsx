/**
 * The project's three-column layout, and the breakpoint that collapses it.
 *
 * At `lg` and above: the navigation column, then the content in the same padded,
 * centred column every other page reads in. Below `lg`: the same navigation as
 * a strip above the content. One component is in the DOM at a time — the switch
 * is `matchMedia`, not a hidden duplicate — so a screen reader meets one nav, the
 * column is genuinely absent on a narrow viewport, and a count of filled
 * controls in a browser counts the page rather than the page and its shadow.
 *
 * The two layouts hold the content at different places in the tree, so React
 * would unmount and remount the whole section on every crossing of the
 * breakpoint — closing an open dialog and dropping every form's state. The
 * content is therefore rendered once, through a portal into a node of its own,
 * and the layout only decides which slot that node hangs from.
 */

import { useCallback, useState, type JSX, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useViewportAtLeast } from "../annotator/viewportFloor";
import { PaddedContent } from "./PaddedContent";
import { ProjectNav, type ProjectNavProps } from "./ProjectNav";

/** Tailwind's `lg`, the width at which the column earns its pixels. */
export const PROJECT_NAV_MIN_VIEWPORT_PX = 1024;

export type ProjectNavData = Omit<ProjectNavProps, "layout" | "children">;

export interface ProjectShellProps {
  readonly nav: ProjectNavData;
  /**
   * The project's identity — where you are, above the content and above the
   * strip — drawn by the frame, so the navigation stays as wide as its controls.
   */
  readonly eyebrow?: ReactNode;
  readonly children: ReactNode;
}

export function ProjectShell({ nav, eyebrow, children }: ProjectShellProps): JSX.Element {
  const wide = useViewportAtLeast(PROJECT_NAV_MIN_VIEWPORT_PX);
  const [host] = useState(() => {
    const node = document.createElement("div");
    node.className = "contents";
    return node;
  });
  const slot = useCallback(
    (node: HTMLDivElement | null) => {
      node?.appendChild(host);
    },
    [host],
  );
  const content = <div ref={slot} className="contents" />;
  return (
    <>
      {wide ? (
        <div className="flex min-h-full flex-1" data-testid="project-shell">
          <ProjectNav layout="column" {...nav} />
          <div className="min-w-0 flex-1">
            <PaddedContent>
              <div className="flex flex-col gap-6">
                {eyebrow}
                {content}
              </div>
            </PaddedContent>
          </div>
        </div>
      ) : (
        <PaddedContent>
          <div className="flex flex-col gap-6">
            {eyebrow}
            <ProjectNav layout="strip" {...nav}>
              {content}
            </ProjectNav>
          </div>
        </PaddedContent>
      )}
      {createPortal(children, host)}
    </>
  );
}
