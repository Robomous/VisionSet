/**
 * The component harness, proved on the primitives that carry a decision.
 *
 * Not a snapshot of every class string — that would pin the design system to
 * whatever it happened to be on the day. What is asserted here is the handful of behaviours a screen
 * would silently lose: the merge that makes `className` a real override — and the
 * two geometry overrides that ride on it, `inlineLink` and `menuSurface`, whose
 * whole job is to beat a canonical utility — the `asChild` that keeps a link a
 * link, and the role an error is announced with.
 *
 * The button no longer defaults `type`, so nothing here stops a "Cancel"
 * submitting a form; that is a call-site property now, and
 * `tests/scripts/form_buttons.test.mjs` is what holds it.
 *
 * This file is also the reason the jsdom harness exists at all: standing the
 * environment up once here is cheaper than the first screen that needs it doing so
 * under deadline.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JSX } from "react";
import { describe, expect, it } from "vitest";

import { inlineLink } from "../lib/button";
import { menuSurface } from "../lib/menu";
import { progressAria } from "../lib/progress";
import { twoLineTrigger } from "../lib/select";
import { Alert, AlertDescription, AlertTitle } from "./alert";
import { Badge } from "./badge";
import { Button } from "./button";
import { Card, CardTitle } from "./card";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { Progress } from "./progress";
import { FieldError } from "./field";
import { Input } from "./input";
import { Label } from "./label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "./table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

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

    const classes = screen.getByRole("button").className;
    // The underline arrives on hover. A rule that underlined at rest would look
    // like a link in a screenshot and read as one to `toContain("underline")`,
    // which is why the resting state is asserted as an absence and the utility
    // is matched whole — `hover:underline` and `underline-offset-4` both contain
    // the substring.
    expect(classes).toContain("hover:underline");
    expect(classes).not.toMatch(/(^|\s)underline(\s|$)/);
  });

  it("hands back the height and padding a link button in prose cannot keep", () => {
    render(
      <Button variant="link" className={inlineLink}>
        More
      </Button>,
    );

    // `Button` merges `className` over `buttonVariants` with tailwind-merge, so
    // this is the merge itself: canonical's `h-8 px-2.5` is gone from the
    // rendered attribute rather than merely outranked by a later rule.
    const classes = screen.getByRole("button").className.split(" ");
    expect(classes).toContain("h-auto");
    expect(classes).toContain("p-0");
    expect(classes).not.toContain("h-8");
    expect(classes).not.toContain("px-2.5");
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

  it.each(["success", "warning", "info", "quiet"] as const)("%s is a Badge variant keyed on data", (variant) => {
    render(<Badge variant={variant}>x</Badge>);
    const el = screen.getByText("x");
    expect(el.getAttribute("data-variant")).toBe(variant);
    expect(el.className).toContain("border-transparent");
    expect(el.className).not.toMatch(/border-(emerald|amber|sky)/);
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
 * The two-line option — composed at the call site rather than a primitive prop,
 * which is why what is asserted here is the trigger's own behaviour and not a
 * layout this file would otherwise have to keep in step with a call site.
 *
 * The claim worth a test is the one that is easy to lose: the trigger shows the
 * *same* two lines the list does, because Radix renders the selected item's own
 * children into it. A second copy of the layout at the call site would look
 * identical the day it was written and drift the day either half moved.
 */
describe("Select", () => {
  function pickOne(): JSX.Element {
    return (
      <Select defaultValue="a">
        <SelectTrigger data-testid="model" className={twoLineTrigger}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">
            <span className="flex flex-col items-start">
              <span>org/model-tiny</span>
              <span className="text-xs text-muted-foreground">311.9 MB · tiny</span>
            </span>
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
    // Nothing truncates: half a model id is not a model id.
    expect(trigger.className).not.toContain("truncate");
    // `twoLineTrigger` names canonical's own modifier chains, so `cn`'s merge
    // replaces the fixed height and the value clamp rather than stacking beside
    // them — a real check of the merge at render, not an echo of the constant.
    expect(trigger.className).toContain("data-[size=default]:h-auto");
    expect(trigger.className).toContain("line-clamp-none");
    expect(trigger.className).not.toContain("data-[size=default]:h-8");
    expect(trigger.className).not.toContain("line-clamp-1");
  });

  it("floors the open list at the closed control's width", async () => {
    render(pickOne());
    await userEvent.click(screen.getByTestId("model"));
    const viewport = document.querySelector("[data-radix-select-viewport]");
    expect(viewport).not.toBeNull();
    const className = (viewport as HTMLElement).className;
    expect(className).toContain("w-full");
    expect(className).toContain("min-w-(--radix-select-trigger-width)");
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
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>State</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody />
      </Table>,
    );
    expect(screen.getByRole("columnheader", { name: "Name" })).not.toBeNull();
    expect(screen.getByRole("columnheader", { name: "State" })).not.toBeNull();
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
    // Canonical `Progress` reads `value` only to size the indicator and never
    // forwards it to Radix's `Root`, so `progressAria` says it again — every
    // caller in the product spreads it beside `value` for exactly this reason.
    render(<Progress value={42} {...progressAria(42)} aria-label="Ingest" />);
    expect(screen.getByRole("progressbar", { name: "Ingest" }).getAttribute("aria-valuenow")).toBe(
      "42",
    );
  });

  it("fills with the functional colour by default, and a caller can recolour it for success", () => {
    // Canonical `Progress` has no `variant` prop — the indicator's colour is
    // fixed inside `progress.tsx`, so a caller reaches it through the
    // `data-slot` it renders with, from its own `className` on `Root`. Every
    // "success" progress bar in the product (`BatchProgressBar`, job rows,
    // the styleguide) uses exactly this className.
    const { rerender } = render(<Progress value={42} aria-label="Ingest" />);
    const fill = (): Element => screen.getByRole("progressbar").firstElementChild as Element;
    expect(fill().className).toContain("bg-primary");
    rerender(
      <Progress
        value={42}
        aria-label="Ingest"
        className="[&>[data-slot=progress-indicator]]:bg-success"
      />,
    );
    expect(screen.getByRole("progressbar").className).toContain("bg-success");
  });

  it("hands its ref to the track element", () => {
    let track: HTMLDivElement | null = null;
    render(
      <Progress
        value={7}
        aria-label="Ingest"
        ref={(node) => {
          track = node;
        }}
      />,
    );
    expect(track).toBe(screen.getByRole("progressbar"));
  });
});

describe("Dialog", () => {
  function describedBy(dialog: HTMLElement): readonly (string | null)[] {
    return (dialog.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? null);
  }

  it("points aria-describedby at every description, each under its own id, when the caller names them", () => {
    render(
      <Dialog open>
        <DialogContent aria-describedby="d1 d2">
          <DialogTitle>Narrowing</DialogTitle>
          <DialogDescription id="d1">one class narrows</DialogDescription>
          <DialogDescription id="d2">nothing becomes invalid</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-describedby")).toBe("d1 d2");
    expect(describedBy(dialog)).toEqual(["one class narrows", "nothing becomes invalid"]);
    expect(document.getElementById("d1")?.textContent).toBe("one class narrows");
    expect(document.getElementById("d2")?.textContent).toBe("nothing becomes invalid");
  });

  it("wires a single, unnamed description through Radix's own id by default", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Narrowing</DialogTitle>
          <DialogDescription>one class narrows</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    const describedById = dialog.getAttribute("aria-describedby");
    expect(describedById).toBeTruthy();
    expect(document.getElementById(describedById ?? "")?.textContent).toBe("one class narrows");
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
        <DropdownMenuContent className={menuSurface}>
          <DropdownMenuItem>Check integrity of this connection</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const classes = (await screen.findByRole("menu")).className.split(" ");
    // Canonical pins the surface to the trigger with
    // `w-(--radix-dropdown-menu-trigger-width)`, which behind this icon-sized
    // button is the 128px floor — long items wrap. `menuSurface` is in the same
    // utility group, so tailwind-merge drops canonical's at render and the
    // rendered class list is the assertion: this is the merge, not a hope about
    // cascade order.
    expect(classes).toContain("w-auto");
    expect(classes).not.toContain("w-(--radix-dropdown-menu-trigger-width)");
    // The floor is a different group and survives, which is what keeps a
    // one-word menu from collapsing to its widest item.
    expect(classes).toContain("min-w-32");
  });
});
