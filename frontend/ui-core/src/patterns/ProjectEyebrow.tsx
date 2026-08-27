/**
 * Who the project is, in one line above a section's title: the name, and the
 * active schema version. It is identity and not navigation — the sections are in
 * the column beside it and the workspace's destinations on the rail — so it
 * carries no control. The chip is omitted, never placeheld, while there is no
 * schema; nothing at all renders while neither fact has loaded.
 */

import type { JSX } from "react";

import { Badge } from "../primitives/badge";

export interface ProjectEyebrowProps {
  /** The project's name, or the empty string while it is in flight. */
  readonly name: string;
  /** The active schema version, or `null` while there is no schema. */
  readonly version: number | null;
}

export function ProjectEyebrow({ name, version }: ProjectEyebrowProps): JSX.Element | null {
  if (name === "" && version === null) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
      data-testid="project-identity"
    >
      {name !== "" && (
        <span className="font-medium text-foreground" data-testid="project-title">
          {name}
        </span>
      )}
      {version !== null && (
        <Badge variant="outline" data-testid="chip-version">
          v{version} active
        </Badge>
      )}
    </div>
  );
}
