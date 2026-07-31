/**
 * The component harness, proved on the primitives that carry a decision.
 *
 * Not a snapshot of every class string — that would pin the design system to
 * whatever it happened to be on the day, which is the mistake #50 had to undo in
 * `keyboard.spec.ts`. What is asserted here is the handful of behaviours a screen
 * would silently lose: the merge that makes `className` a real override, the
 * button type that stops a "Cancel" submitting a form, the `asChild` that keeps a
 * link a link, and the role an error is announced with.
 *
 * This file is also the reason the jsdom harness exists at all — #53's schema
 * editor asks for component tests, and standing the environment up once here is
 * cheaper than the screen that needs it first doing it under deadline.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Alert, Badge } from "./Badge";
import { Button } from "./Button";
import { Card, CardTitle } from "./Card";
import { Progress } from "./Feedback";
import { FieldError, Input, Label } from "./Input";
import { Table, TableBody, TableEmpty } from "./Table";

describe("Button", () => {
  it("defaults to type=button, so a Cancel does not submit its form", () => {
    render(<Button>Cancel</Button>);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("type", "button");
  });

  it("keeps an explicit type", () => {
    render(<Button type="submit">Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("type", "submit");
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
      <Button asChild variant="primary">
        <a href="/projects">Projects</a>
      </Button>,
    );
    // A `role="link"` on a `<button>` would read the same to a test and behave
    // differently to a browser — no middle-click, no "open in new tab".
    const link = screen.getByRole("link", { name: "Projects" });
    expect(link.tagName).toBe("A");
    expect(link.className).toContain("bg-primary");
  });
});

describe("Alert and Badge", () => {
  it("announces a destructive alert and stays quiet for an informational one", () => {
    const { rerender } = render(<Alert variant="destructive" title="PROJECT_NOT_FOUND" />);
    expect(screen.getByRole("alert")).toHaveProperty("textContent", "PROJECT_NOT_FOUND");

    rerender(<Alert title="Nothing to do yet" />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders a node title, which the native attribute could not hold", () => {
    render(
      <Alert variant="destructive" title={<span data-testid="icon">!</span>}>
        the message
      </Alert>,
    );
    expect(screen.getByTestId("icon")).not.toBeNull();
  });

  it("gives a badge the accent only through the accent variant", () => {
    render(<Badge variant="accent">annotated</Badge>);
    expect(screen.getByText("annotated").className).toContain("border-primary");
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

describe("Card and Table", () => {
  it("gives a card title a heading role, so a screen is navigable", () => {
    render(
      <Card>
        <CardTitle>Classes</CardTitle>
      </Card>,
    );
    expect(screen.getByRole("heading", { name: "Classes" })).not.toBeNull();
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

describe("Progress", () => {
  it("reports its value to assistive technology, not only as a width", () => {
    render(<Progress value={42} aria-label="Ingest" />);
    expect(screen.getByRole("progressbar", { name: "Ingest" }).getAttribute("aria-valuenow")).toBe(
      "42",
    );
  });
});
