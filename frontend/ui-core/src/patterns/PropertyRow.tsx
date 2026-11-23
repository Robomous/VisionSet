/**
 * The inspector's row, shared by the sheets that describe one thing: the class
 * sheet and the model sheet.
 */

import type { JSX, ReactNode } from "react";

import { Label, cn } from "@robomous/ui-core";

/**
 * One property: its label in the inspector's left column, its value in the
 * right. Every row of the class and model sheets is this grid, nested rows included, so
 * the eye runs down one edge of labels and one edge of values. The label sits
 * on the value's first line — centred against a one-line control, at the top
 * against a taller one. The label column is 7rem and a row at least 40px; a
 * surface whose labels are all short narrows the column with
 * `--vs-label-column`, and a dense one tightens every row with `--vs-row-height`
 * and `--vs-row-pad`, for every row at once.
 */
export function PropertyRow({
  label,
  htmlFor,
  labelId,
  nested = false,
  align = "center",
  labelAction,
  children,
  testId,
}: {
  readonly label: ReactNode;
  readonly htmlFor?: string;
  readonly labelId?: string;
  readonly nested?: boolean;
  readonly align?: "center" | "start";
  /**
   * A control beside the label — an info button — kept outside the `<label>`,
   * since a label may hold no interactive content of its own.
   */
  readonly labelAction?: ReactNode;
  readonly children: ReactNode;
  readonly testId?: string;
}): JSX.Element {
  const labelClass = cn(
    "truncate text-muted-foreground",
    // Nested rows indent their label, not their value: the value column is the
    // edge every row shares.
    nested && "pl-5",
    // Against a taller value, the label meets its first line: a 28px control's
    // text sits 6px down.
    align === "start" && "pt-1.5",
  );
  return (
    <div
      data-testid={testId}
      className={cn("vs-property-row grid gap-3 px-4", align === "center" ? "items-center" : "items-start")}
    >
      {labelAction === undefined ? (
        <RowLabel label={label} htmlFor={htmlFor} labelId={labelId} className={labelClass} />
      ) : (
        <div className={cn("flex min-w-0 items-center gap-0.5", align === "start" && "self-start")}>
          <RowLabel label={label} htmlFor={htmlFor} labelId={labelId} className={labelClass} />
          {labelAction}
        </div>
      )}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function RowLabel({ label, htmlFor, labelId, className }: { readonly label: ReactNode; readonly htmlFor: string | undefined; readonly labelId: string | undefined; readonly className: string }): JSX.Element {
  if (htmlFor === undefined) {
    return (
      <span id={labelId} className={className}>
        {label}
      </span>
    );
  }
  return (
    <Label htmlFor={htmlFor} id={labelId} className={cn(className, "text-xs font-normal")}>
      {label}
    </Label>
  );
}
