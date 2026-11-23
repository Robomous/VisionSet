/**
 * The Overview's card: a title, one line saying what the card holds, an
 * optional control on the right, then the body.
 *
 * `Card` from the foundation with its header parts, composed once so the three
 * Overview cards agree on where the title sits and how tall the header is. A
 * card's subtitle is a fact about the project ("74,962 images left to
 * annotate"), never a description of the card — the title already names it.
 */

import type { JSX, ReactNode } from "react";

import { Card, CardAction, CardDescription, CardHeader, CardTitle, cn } from "@robomous/ui-core";

export interface ProjectCardProps {
  readonly title: string;
  readonly subtitle?: ReactNode;
  /** A view switch or a pointer — never the page's filled action. */
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly "data-testid"?: string;
}

export function ProjectCard({
  title,
  subtitle,
  action,
  children,
  className,
  "data-testid": testId,
}: ProjectCardProps): JSX.Element {
  return (
    <Card className={cn("min-w-0 gap-3", className)} data-testid={testId}>
      <CardHeader>
        {/* A section of the page, so a heading — the page's h1 is the section header above. */}
        <CardTitle className="text-sm font-semibold">
          <h2>{title}</h2>
        </CardTitle>
        {subtitle !== undefined && (
          <CardDescription className="tabular-nums">{subtitle}</CardDescription>
        )}
        {action !== undefined && <CardAction>{action}</CardAction>}
      </CardHeader>
      {children}
    </Card>
  );
}
