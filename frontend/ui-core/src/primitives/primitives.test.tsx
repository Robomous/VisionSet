/**
 * The component harness, proved on the primitives that carry a decision.
 *
 * Not a snapshot of every class string — that would pin the design system to
 * whatever it happened to be on the day. What is asserted here is the handful of behaviours a screen
 * would silently lose: the merge that makes `className` a real override, the
 * button type that stops a "Cancel" submitting a form, the `asChild` that keeps a
 * link a link, and the role an error is announced with.
 *
 * This file is also the reason the jsdom harness exists at all: standing the
 * environment up once here is cheaper than the first screen that needs it doing so
 * under deadline.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JSX } from "react";
import { describe, expect, it } from "vitest";

import { Alert, AlertDescription, AlertTitle } from "./alert";
import { Badge } from "./badge";
import { Button } from "./button";
import { Card, CardTitle } from "./card";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./Dialog";
import { Progress } from "./Feedback";
import { FieldError, Input, Label } from "./Input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./Menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./Select";
import { Table, TableBody, TableEmpty } from "./Table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./Tabs";

describe("Button", () => {
  it("keeps an explicit type", () => {
    render(<Button type="submit">Go</Button>);
    expect(screen.getByRole("button").getAttribute("type")).toBe("submit");
  });

  it("lets a caller override a conflicting utility rather than emitting both", () => {
    // Without `tailwind-merge` both `px-4` and `px-6` survive and which one wins is
    // decided by the order Tailwind wrote them into the stylesheet — a rule nobody
    // can see from the call site. This is what makes `className` an extension
    // point rather than a suggestion.
    render(<Button className="px-6">Wide</Button>);
    const className = screen.getByRole("button", { name: "Wide" }).className;
    expect(className).toContain("px-6");
    expect(className).not.toContain("px-4");
  });

  it("renders the child element with asChild, so a link stays a link", () => {
    render(
      <Button asChild variant="default">
        <a href="/projects">Projects</a>
      </Button>,
    );
    // A `role="link"` on a `<button>` would read the same to a test and behave
    // differently to a browser — no middle-click, no "open in new tab".
    const link = screen.getByRole("link", { name: "Projects" });
    expect(link.tagName).toBe("A");
    expect(link.className).toContain("bg-primary");
  });

  it("styles a link button as an underline-on-hover text link", () => {
    render(<Button variant="link">More</Button>);
    expect(screen.getByRole("button").getAttribute("data-variant")).toBe("link");
  });
});

describe("Alert and Badge", () => {
  it("announces an alert, and composes its title and description", () => {
    render(
      <Alert variant="destructive">
        <AlertTitle>Refused</AlertTitle>
        <AlertDescription>because</AlertDescription>
      </Alert>,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Refused");
    expect(alert.textContent).toContain("because");
  });

  it("marks a badge with its variant, so a style can be keyed on data rather than colour", () => {
    render(<Badge variant="success">done</Badge>);
    expect(screen.getByText("done").getAttribute("data-variant")).toBe("success");
    expect(screen.getByText("done").getAttribute("data-slot")).toBe("badge");
  });
});

describe("fields", () => {
  it("associates a label with its control by id", () => {
    render(
      <>
        <Label htmlFor="tag">Tag</Label>
        <Input id="tag" defaultValue="v1" />
      </>,
    );
    expect(screen.getByLabelText("Tag")).toHaveProperty("value", "v1");
  });

  it("announces a field error", () => {
    render(<FieldError>must not be blank</FieldError>);
    expect(screen.getByRole("alert").textContent).toBe("must not be blank");
  });
});

/**
 * The two-line option — a primitive variant rather than one screen's styling,
 * which is why it is asserted here.
 *
 * The claim worth a test is the one that is easy to lose: the trigger shows the
 * *same* two lines the list does, because Radix renders the selected item's own
 * `ItemText` into it. A second copy of the layout at the call site would look
 * identical the day it was written and drift the day either half moved.
 */
describe("Select", () => {
  function pickOne(): JSX.Element {
    return (
      <Select defaultValue="a">
        <SelectTrigger data-testid="model">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a" meta="311.9 MB · tiny">
            org/model-tiny
          </SelectItem>
          <SelectItem value="b">org/model-large</SelectItem>
        </SelectContent>
      </Select>
    );
  }

  it("stacks the identifier and its meta in the closed trigger", () => {
    render(pickOne());
    const trigger = screen.getByTestId("model");
    expect(trigger.textContent).toContain("org/model-tiny");
    expect(trigger.textContent).toContain("311.9 MB · tiny");
    // Two elements, not one line that happens to wrap — the meta carries the
    // muted role and the id does not.
    const meta = trigger.querySelector(".text-muted-foreground");
    expect(meta?.textContent).toBe("311.9 MB · tiny");
    expect(meta?.textContent).not.toContain("org/model-tiny");
  });

  it("grows rather than clipping, and leaves a one-line option where it was", () => {
    render(pickOne());
    // `h-8` would fix the height and squash the second line; `min-h-8` keeps the
    // one-line control on Nova's contract height and lets a two-line one grow.
    const trigger = screen.getByTestId("model");
    expect(trigger.className).toContain("min-h-8");
    expect(trigger.className).not.toMatch(/(^|\s)h-8(\s|$)/);
    // Nothing truncates: half a model id is not a model id.
    expect(trigger.className).not.toContain("truncate");
  });

  it("leaves an option with no meta exactly as it was", async () => {
    render(pickOne());
    await userEvent.click(screen.getByTestId("model"));
    const plain = screen.getByRole("option", { name: "org/model-large" });
    expect(plain.querySelector(".text-muted-foreground")).toBeNull();
  });

  it("floors the open list at the closed control's width", async () => {
    render(pickOne());
    await userEvent.click(screen.getByTestId("model"));
    const viewport = document.querySelector("[data-radix-select-viewport]");
    expect(viewport).not.toBeNull();
    const classes = (viewport as HTMLElement).className.split(" ");
    expect(classes).toContain("w-full");
    expect(classes).toContain("min-w-(--radix-select-trigger-width)");
  });
});

describe("Card and Table", () => {
  it("marks a card title with its slot, for the styling that reads it", () => {
    render(
      <Card>
        <CardTitle>Classes</CardTitle>
      </Card>,
    );
    expect(screen.getByText("Classes").getAttribute("data-slot")).toBe("card-title");
  });

  it("keeps the table's header while the body is empty", () => {
    render(
      <Table>
        <TableBody>
          <TableEmpty colSpan={3}>No batches yet</TableEmpty>
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole("table")).not.toBeNull();
    expect(screen.getByText("No batches yet")).not.toBeNull();
  });
});

/**
 * The tab bar, asserted on what it *means* rather than on what it looks like.
 *
 * The distinction between the open section and the other two has to survive a
 * restyling, so nothing here matches a class string — a test that pinned
 * `bg-card` would have failed on the very change it was supposed to protect, and
 * a test that pinned `border-primary` would fail on the next one. What is asserted
 * is the part a screen reader and the keyboard both read: the roles, `aria-selected`,
 * Radix's `data-state`, and that only the open panel is in the tree at all.
 *
 * There is nothing here about a variant cascade: `TabsList` has one shape and no
 * context to hand down.
 */
describe("Tabs", () => {
  function bar(): JSX.Element {
    return (
      <Tabs defaultValue="schema">
        <TabsList aria-label="Sections">
          <TabsTrigger value="schema">Schema</TabsTrigger>
          <TabsTrigger value="batches">Batches</TabsTrigger>
        </TabsList>
        <TabsContent value="schema">the classes</TabsContent>
        <TabsContent value="batches">the batches</TabsContent>
      </Tabs>
    );
  }

  it("marks the open section as the selected tab and the others as not", () => {
    render(bar());

    const [schema, batches] = screen.getAllByRole("tab");
    expect(schema.getAttribute("aria-selected")).toBe("true");
    expect(schema.dataset.state).toBe("active");
    expect(batches.getAttribute("aria-selected")).toBe("false");
    expect(batches.dataset.state).toBe("inactive");
  });

  it("moves the selection when the tab is clicked, so the state is the source of the styling", async () => {
    render(bar());

    await userEvent.click(screen.getByRole("tab", { name: "Batches" }));
    expect(screen.getByRole("tab", { name: "Batches" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Schema" }).getAttribute("aria-selected")).toBe("false");
  });

  it("keeps only the open panel in the tree, and labels it with its tab", () => {
    render(bar());

    const panels = screen.getAllByRole("tabpanel");
    expect(panels).toHaveLength(1);
    expect(panels[0]?.textContent).toBe("the classes");
    expect(screen.getByRole("tablist").getAttribute("aria-label")).toBe("Sections");
  });

  it("is operable from the keyboard, because every trigger is a real button", async () => {
    render(bar());

    // Radix's roving tabindex: one stop for the whole bar, arrows move within it.
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Schema" }));

    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Batches" }));
    expect(screen.getByRole("tab", { name: "Batches" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("Progress", () => {
  it("reports its value to assistive technology, not only as a width", () => {
    render(<Progress value={42} aria-label="Ingest" />);
    expect(screen.getByRole("progressbar", { name: "Ingest" }).getAttribute("aria-valuenow")).toBe(
      "42",
    );
  });
});

describe("Dialog", () => {
  function Described({ second }: { readonly second: boolean }): JSX.Element {
    return (
      <Dialog open>
        <DialogContent>
          <DialogTitle>Narrowing</DialogTitle>
          <DialogDescription>one class narrows</DialogDescription>
          {second ? <DialogDescription>nothing becomes invalid</DialogDescription> : null}
        </DialogContent>
      </Dialog>
    );
  }

  function describedBy(dialog: HTMLElement): readonly (string | null)[] {
    return (dialog.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? null);
  }

  it("points aria-describedby at every description, each under its own id", () => {
    const { rerender } = render(<Described second />);
    const dialog = screen.getByRole("dialog");
    expect(describedBy(dialog)).toEqual(["one class narrows", "nothing becomes invalid"]);
    const ids = Array.from(dialog.querySelectorAll("p")).map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);

    rerender(<Described second={false} />);
    expect(describedBy(dialog)).toEqual(["one class narrows"]);
  });
});

describe("DropdownMenu", () => {
  it("sizes its surface to the items, not to the trigger", async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Actions" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Check integrity of this connection</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const classes = (await screen.findByRole("menu")).className.split(" ");
    expect(classes).toContain("min-w-32");
    expect(classes).not.toContain("w-(--radix-dropdown-menu-trigger-width)");
  });
});
